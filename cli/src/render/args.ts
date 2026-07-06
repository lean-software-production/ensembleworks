/**
 * argv → typed request (spec §6.2). One ManifestEntry → one subcommand:
 *   - Flags: every property is --<kebab> (camelCase also accepted); booleans
 *     bare; object/array props take a JSON string or --<field> @file.
 *   - Positionals: required non-room scalars first (declaration order), then
 *     optional non-room scalars (the reconciliation that makes `scribe say
 *     <identity> <text>` and `roadmap read <name>` both work — see the plan's
 *     positional-slot note). An array/object required field (roadmap.write.ops)
 *     never takes a slot.
 *   - Raw-body spread: a lone JSON-object positional with no flags is spread as
 *     the body (carries `canvas shape '<json>'`, `roadmap write '<json>'`).
 *   - room is injected from the resolved connection unless the body set it.
 *   - Method fixes location: GET/DELETE → query, POST/PUT → json.
 */
import { readFileSync } from 'node:fs'
import type { ManifestEntry } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import type { Conn } from '../resolve.ts'
import { isScalar, type JsonSchema, type JsonSchemaProp, propType, validate } from './validate.ts'

export interface Req {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE'
	path: string
	query?: Record<string, unknown>
	json?: Record<string, unknown>
}

function kebabToCamel(s: string): string {
	return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function isJsonObject(s: string): boolean {
	const t = s.trim()
	if (!t.startsWith('{')) return false
	try {
		const v = JSON.parse(t)
		return v !== null && typeof v === 'object' && !Array.isArray(v)
	} catch {
		return false
	}
}

/** Reconciled positional order: required scalars first, then optional scalars,
 *  each in declaration order; `room` never takes a slot. */
function positionalSlots(schema: JsonSchema): string[] {
	const props = schema.properties ?? {}
	const required = new Set(schema.required ?? [])
	const scalars = Object.keys(props).filter((k) => k !== 'room' && isScalar(props[k]))
	return [...scalars.filter((k) => required.has(k)), ...scalars.filter((k) => !required.has(k))]
}

interface Parsed {
	positionals: string[]
	flags: Record<string, string>
}

function parseArgv(argv: string[], props: Record<string, JsonSchemaProp>): Parsed {
	// Accept both kebab and camel spellings; map each to the canonical prop key.
	const byFlag = new Map<string, string>()
	for (const key of Object.keys(props)) {
		byFlag.set(key, key)
		byFlag.set(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), key)
	}
	const positionals: string[] = []
	const flags: Record<string, string> = {}
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i] as string
		if (tok.startsWith('--')) {
			const raw = tok.slice(2)
			const key = byFlag.get(raw) ?? byFlag.get(kebabToCamel(raw))
			if (!key) throw new CliError(`unknown flag: --${raw}`, 2)
			if (propType(props[key]) === 'boolean') {
				flags[key] = 'true'
				continue
			}
			const next = argv[i + 1]
			if (next === undefined) throw new CliError(`--${raw} requires a value`, 2)
			flags[key] = next.startsWith('@') ? readFileSync(next.slice(1), 'utf8') : next
			i++
		} else {
			positionals.push(tok)
		}
	}
	return { positionals, flags }
}

function coerce(p: JsonSchemaProp | undefined, raw: string): unknown {
	const t = propType(p)
	if (t === 'boolean') return raw === 'false' ? false : true
	if (t === 'number' || t === 'integer') {
		const n = Number(raw)
		return Number.isNaN(n) ? raw : n // NaN-as-raw lets validate() block on the type mismatch
	}
	if (t === 'object' || t === 'array') {
		try {
			return JSON.parse(raw)
		} catch {
			return raw // a non-JSON string lets validate() block on the type mismatch
		}
	}
	return raw
}

export function buildRequest(entry: ManifestEntry, argv: string[], conn: Conn): Req {
	const schema = (entry.input ?? {}) as JsonSchema
	const props = schema.properties ?? {}
	const slots = positionalSlots(schema)
	const { positionals, flags } = parseArgv(argv, props)

	let body: Record<string, unknown>
	if (positionals.length === 1 && Object.keys(flags).length === 0 && isJsonObject(positionals[0] as string)) {
		body = JSON.parse(positionals[0] as string) as Record<string, unknown>
	} else {
		if (positionals.length > slots.length) {
			throw new CliError(`too many positional arguments for ${entry.plugin} ${entry.id}`, 2)
		}
		body = {}
		slots.forEach((k, i) => {
			const v = positionals[i]
			if (v !== undefined) body[k] = coerce(props[k], v)
		})
		for (const [k, v] of Object.entries(flags)) body[k] = coerce(props[k], v)
	}

	if ('room' in props && body.room === undefined) body.room = conn.room

	validate(schema, body)

	return entry.method === 'GET' || entry.method === 'DELETE'
		? { method: entry.method, path: entry.path, query: body }
		: { method: entry.method, path: entry.path, json: body }
}
