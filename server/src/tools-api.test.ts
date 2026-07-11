// Bidirectional completeness: the /api/tools manifest and the booted app must
// agree. Direction A — every declared verb is reachable (status !== 404).
// Direction B — every mounted non-exempt /api route is declared. Boots the app
// in-process on an ephemeral port (canvas-api.test.ts pattern).
// Run with: bun src/tools-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { allTools } from '@ensembleworks/contracts'
import { createSyncApp } from './app.ts'

// Exempt predicate — the kernel meta-routes plus the write-only telemetry beacon
// (see spec "Exempt"): none are agent-facing tools, so none belong in the
// manifest. Every other exempt thing (static, uploads, WS) is not an express
// `route` layer.
const isExempt = (p: string) =>
	p === '/api/health' || p === '/api/tools' || p === '/api/telemetry/connection'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tools-api-test-'))
	const { server, app } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`

	// --- Envelope --------------------------------------------------------------
	const res = await fetch(`${base}/api/tools`)
	assert.equal(res.status, 200, 'GET /api/tools should be 200')
	const manifest = (await res.json()) as {
		version: number
		server: string
		tools: Array<{ plugin: string; id: string; method: string; path: string }>
	}
	assert.equal(manifest.version, 1, 'manifest.version === 1')
	assert.equal(manifest.tools.length, 22, 'manifest declares 22 tools')
	assert.equal(typeof manifest.server, 'string', 'manifest.server is a string')

	// --- Direction A: declared ⊆ mounted (every verb is reachable) -------------
	for (const t of allTools) {
		const r = await fetch(`${base}${t.http.path}`, {
			method: t.http.method,
			headers: t.http.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
			body: t.http.method === 'POST' ? '{}' : undefined,
		})
		assert.notEqual(r.status, 404, `declared verb ${t.plugin}.${t.id} (${t.http.method} ${t.http.path}) must be mounted (got 404)`)
	}

	// --- Direction B: mounted ⊆ declared (no undeclared /api route) ------------
	// Walk the express router stack, collecting every `route` layer's {method,path}.
	const mounted = new Set<string>()
	const walk = (stack: any[]) => {
		for (const layer of stack) {
			if (layer.route) {
				const rp: string = layer.route.path
				if (typeof rp === 'string' && rp.startsWith('/api') && !isExempt(rp)) {
					for (const m of Object.keys(layer.route.methods ?? {})) {
						if (layer.route.methods[m]) mounted.add(`${m.toUpperCase()} ${rp}`)
					}
				}
			} else if (layer.handle?.stack) {
				walk(layer.handle.stack)
			}
		}
	}
	walk((app as any).router?.stack ?? (app as any)._router?.stack ?? [])

	const declared = new Set(allTools.map((t) => `${t.http.method} ${t.http.path}`))
	// Every mounted non-exempt /api route is declared…
	for (const m of mounted) assert.ok(declared.has(m), `mounted route not declared: ${m}`)
	// …and every declared route is actually mounted (belt-and-braces with Dir A).
	for (const d of declared) assert.ok(mounted.has(d), `declared route not mounted: ${d}`)
	assert.equal(mounted.size, declared.size, 'mounted and declared /api route sets must match exactly')

	server.close()
	console.log(`ok: /api/tools manifest — envelope v1, 22 tools, ${mounted.size} routes match both directions`)
	process.exit(0) // createSyncApp's intervals keep the loop alive (house pattern: whoami-api, canvas-api)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
