/**
 * JSON-Schema helpers shared with args.ts, and the D4 validation posture:
 * validate() BLOCKS on a missing required field or a value whose runtime type
 * does not match the schema type (structural — the request could not be
 * well-formed); it WARNS (still sends) on value-constraint failures
 * (enum/min/max/pattern) because the server handler is the authority and is
 * frequently looser than zodInput. Unknown-flag blocking happens earlier, in
 * args.parseArgv. See spec §7.2.
 */
import { CliError } from '../errors.ts'
import { narrate } from '../output.ts'

export interface JsonSchema {
	type?: string
	properties?: Record<string, JsonSchemaProp>
	required?: string[]
}

export interface JsonSchemaProp {
	type?: string | string[]
	anyOf?: Array<{ type?: string }>
	enum?: unknown[]
	description?: string
	minLength?: number
	maxLength?: number
	minimum?: number
	maximum?: number
	pattern?: string
	/** zod's `.default()` — present here means the SERVER backfills the value
	 *  via zodInput.parse() when the client omits it, so it is not truly
	 *  required from the CLI's side even though zod v4's toJSONSchema lists it
	 *  in `required` (e.g. canvas.shape's `op`, defaulted to 'create'). */
	default?: unknown
}

/** The primary scalar/complex type of a prop, tolerating unions and nullable. */
export function propType(p: JsonSchemaProp | undefined): string | undefined {
	if (!p) return undefined
	if (typeof p.type === 'string') return p.type
	if (Array.isArray(p.type)) return p.type.find((t) => t !== 'null')
	if (Array.isArray(p.anyOf)) return p.anyOf.map((m) => m.type).find((t): t is string => typeof t === 'string')
	return undefined
}

export function isScalar(p: JsonSchemaProp | undefined): boolean {
	const t = propType(p)
	return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean'
}

export function validate(schema: JsonSchema, body: Record<string, unknown>): void {
	const props = schema.properties ?? {}
	for (const key of schema.required ?? []) {
		if (props[key] && 'default' in (props[key] as JsonSchemaProp)) continue // server backfills defaulted fields
		if (body[key] === undefined) throw new CliError(`missing required field: ${key}`, 2)
	}
	for (const [key, value] of Object.entries(body)) {
		const p = props[key]
		if (!p) continue // only known keys reach the body; unknown flags blocked in parseArgv
		if (!typeMatches(p, value)) {
			throw new CliError(`field ${key} must be ${propType(p) ?? 'the declared type'} (got ${JSON.stringify(value)})`, 2)
		}
		warnConstraints(key, p, value)
	}
}

function typeMatches(p: JsonSchemaProp, value: unknown): boolean {
	const t = propType(p)
	if (!t) return true // untyped / complex union — let the server decide
	switch (t) {
		case 'string':
			return typeof value === 'string'
		case 'number':
		case 'integer':
			return typeof value === 'number' && Number.isFinite(value)
		case 'boolean':
			return typeof value === 'boolean'
		case 'object':
			return value !== null && typeof value === 'object' && !Array.isArray(value)
		case 'array':
			return Array.isArray(value)
		default:
			return true
	}
}

function warnConstraints(key: string, p: JsonSchemaProp, value: unknown): void {
	const warn = (why: string) => narrate(`warning: ${key} ${why} — sending anyway; server will validate`)
	if (Array.isArray(p.enum) && !p.enum.includes(value)) warn(`not one of ${p.enum.join(' | ')}`)
	if (typeof value === 'string') {
		if (typeof p.minLength === 'number' && value.length < p.minLength) warn(`shorter than ${p.minLength}`)
		if (typeof p.maxLength === 'number' && value.length > p.maxLength) warn(`longer than ${p.maxLength}`)
		if (typeof p.pattern === 'string' && !new RegExp(p.pattern).test(value)) warn(`does not match /${p.pattern}/`)
	}
	if (typeof value === 'number') {
		if (typeof p.minimum === 'number' && value < p.minimum) warn(`below ${p.minimum}`)
		if (typeof p.maximum === 'number' && value > p.maximum) warn(`above ${p.maximum}`)
	}
}
