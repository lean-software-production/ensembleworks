// Registry unit test (no server boot): asserts the SHAPE of the tool registry
// — counts, uniqueness, and that every schema serialises to JSON Schema.
// Run with: bun src/tools/tools.test.ts
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
	allTools,
	buildManifest,
	MANIFEST_VERSION,
	type HttpMethod,
} from './index.js'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE']
const PLUGINS = ['kernel', 'av', 'canvas', 'canvas-v2', 'scribe', 'roadmap', 'terminal', 'file', 'discord']

// 1. Exactly 27 declared verbs (17 base + 5 canvas-v2 + 5 discord).
assert.equal(allTools.length, 27, 'expected 27 tool defs (17 base + 5 canvas-v2 + 5 discord)')

// 2. Every def is well-formed.
for (const t of allTools) {
	assert.ok(t.id.length > 0, `empty id on ${t.plugin}.${t.id}`)
	assert.ok(PLUGINS.includes(t.plugin), `bad plugin '${t.plugin}'`)
	assert.ok(typeof t.help === 'string' && t.help.length > 0, `no help on ${t.plugin}.${t.id}`)
	assert.ok(METHODS.includes(t.http.method), `bad method on ${t.plugin}.${t.id}`)
	assert.ok(t.http.path.startsWith('/api/'), `path must start /api/ on ${t.plugin}.${t.id}`)
	// No `:param` path segments: the CLI's generic renderer (cli/src/render/args.ts)
	// emits entry.path verbatim and never substitutes them, so a path-param tool
	// would silently ship a literal `:id` to the server. Keep key fields in
	// query/body — this keeps every declared tool CLI-renderable.
	assert.ok(!/\/:/.test(t.http.path), `path param not renderable by the CLI on ${t.plugin}.${t.id}: ${t.http.path}`)
}

// 3. (plugin, id) pairs unique; (method, path) pairs unique (GET+POST may share
//    a path across methods — scribe/roadmap overloads — but never collide),
//    EXCEPT deliberately op-discriminated same-method routes (file open/refresh
//    both POST /api/canvas/file-viewer, disambiguated by body `op`).
const pluginIds = new Set(allTools.map((t) => `${t.plugin}.${t.id}`))
assert.equal(pluginIds.size, allTools.length, 'duplicate (plugin, id)')
const OP_DISCRIMINATED = new Set(['POST /api/canvas/file-viewer'])
const methodPathList = allTools.map((t) => `${t.http.method} ${t.http.path}`)
const nonExemptMethodPaths = methodPathList.filter((mp) => !OP_DISCRIMINATED.has(mp))
assert.equal(
	new Set(nonExemptMethodPaths).size, nonExemptMethodPaths.length,
	'duplicate (method, path) outside op-discriminated routes',
)

// 4. Every schema projects to JSON Schema without throwing (guards against an
//    un-serialisable Zod construct reaching the wire / 500-ing /api/tools).
for (const t of allTools) {
	assert.doesNotThrow(() => z.toJSONSchema(t.zodInput), `zodInput unserialisable: ${t.plugin}.${t.id}`)
	assert.doesNotThrow(() => z.toJSONSchema(t.zodOutput), `zodOutput unserialisable: ${t.plugin}.${t.id}`)
}

// 5. buildManifest wraps them in the envelope.
const manifest = buildManifest(allTools, '0.0.0')
assert.equal(manifest.version, MANIFEST_VERSION, 'manifest.version')
assert.equal(manifest.tools.length, 27, 'manifest.tools length')

console.log('ok: tool registry — 27 defs, unique ids/paths, all schemas serialise')
