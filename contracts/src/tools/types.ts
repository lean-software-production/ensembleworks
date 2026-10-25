import { z } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** One agent-callable verb. Declared once; projected to HTTP (source of truth),
 *  the /api/tools manifest (→ CLI), and — Phase 4 — MCP. */
export interface ToolDef {
	/** Bare verb id, unique within its plugin (e.g. 'sticky', 'read'). */
	id: string
	/** Plugin group this verb belongs to (design §3 ids + 'kernel'). */
	plugin: 'kernel' | 'av' | 'canvas' | 'canvas-v2' | 'scribe' | 'roadmap' | 'terminal' | 'file' | 'discord'
	/** The one HTTP route that backs this verb — the drift anchor. */
	http: { method: HttpMethod; path: string }
	/** One-line help, rendered by `ensembleworks <plugin> <id> --help`. */
	help: string
	/** Request schema. GET/DELETE ⇒ query string; POST/PUT ⇒ JSON body
	 *  (the method fixes the location). */
	zodInput: z.ZodType
	/** Success (2xx) response body. The error envelope `{ error: string }` is a
	 *  kernel-wide convention, documented once, not repeated per tool. */
	zodOutput: z.ZodType
}

export interface ManifestEntry {
	plugin: string
	id: string
	method: HttpMethod
	path: string
	help: string
	input: unknown   // JSON Schema (draft 2020-12)
	output: unknown
}

export interface ManifestEnvelope {
	version: number
	server: string
	tools: ManifestEntry[]
}

export const MANIFEST_VERSION = 1

export function toManifestEntry(t: ToolDef): ManifestEntry {
	return {
		plugin: t.plugin,
		id: t.id,
		method: t.http.method,
		path: t.http.path,
		help: t.help,
		input: z.toJSONSchema(t.zodInput),
		output: z.toJSONSchema(t.zodOutput),
	}
}

export function buildManifest(tools: ToolDef[], server: string): ManifestEnvelope {
	return { version: MANIFEST_VERSION, server, tools: tools.map(toManifestEntry) }
}
