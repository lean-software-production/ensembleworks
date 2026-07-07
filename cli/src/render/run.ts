/** Render one manifest verb: build the request, call it, print the server
 *  response verbatim to stdout (data-verb contract). A non-2xx body still prints
 *  to stdout (roadmap 409 carries the current rev) and the exit code is 1. */
import type { ManifestEntry } from '@ensembleworks/contracts'
import { request } from '../http.ts'
import { emitData, emitLine } from '../output.ts'
import type { Conn } from '../resolve.ts'
import { buildRequest } from './args.ts'
import type { JsonSchema, JsonSchemaProp } from './validate.ts'

export async function runVerb(entry: ManifestEntry, argv: string[], conn: Conn, cacheHint = ''): Promise<number> {
	const req = buildRequest(entry, argv, conn)
	const res = await request(conn, req, cacheHint)
	emitData(res.body)
	return res.status >= 200 && res.status < 300 ? 0 : 1
}

/** Verb help (`ensembleworks <plugin> <id> --help`) — the requested content, so
 *  it goes to stdout. Lists each non-room field as its --kebab flag. */
export function renderVerbHelp(entry: ManifestEntry): void {
	const schema = (entry.input ?? {}) as JsonSchema
	const props = schema.properties ?? {}
	const required = new Set(schema.required ?? [])
	emitLine(`ensembleworks ${entry.plugin} ${entry.id} — ${entry.help}`)
	emitLine(`  ${entry.method} ${entry.path}`)
	for (const [k, p] of Object.entries(props)) {
		if (k === 'room') continue
		const flag = `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`
		const req = required.has(k) ? ' (required)' : ''
		const desc = descriptionOf(p)
		emitLine(`  ${flag}${req}${desc ? ` — ${desc}` : ''}`)
	}
}

function descriptionOf(p: JsonSchemaProp): string {
	return typeof p.description === 'string' ? p.description : ''
}
