// Manifest cache lifecycle (§6.3): on-miss fetch+write; on-hit no refetch;
// --refresh forces; version mismatch ignores cache; offline → embedded snapshot;
// per-instance keying; and the poisoned-path guard (toRequestUrl throws for the
// three bad path forms BEFORE any fetch). Network is a stubbed globalThis.fetch.
// Run with: bun src/render/manifest.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MANIFEST_VERSION } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import { toRequestUrl } from '../http.ts'
import type { Conn } from '../resolve.ts'
import { cachePath, embeddedManifest, loadManifest } from './manifest.ts'

const cacheHome = mkdtempSync(path.join(os.tmpdir(), 'ew-cache-'))
const env = { XDG_CACHE_HOME: cacheHome } as unknown as NodeJS.ProcessEnv
const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }

const envelope = (version: number) => ({
	version,
	server: 'test-1.2.3',
	tools: [{ plugin: 'canvas', id: 'sticky', method: 'POST', path: '/api/canvas/sticky', help: 'h', input: {}, output: {} }],
})

let fetchCount = 0
const realFetch = globalThis.fetch
const stub = (ok: boolean, version = MANIFEST_VERSION) =>
	((async () => {
		fetchCount++
		if (!ok) throw new Error('offline')
		return new Response(JSON.stringify(envelope(version)), { status: 200 })
	}) as unknown as typeof fetch)

try {
	// 1. on-miss → fetch + write cache.
	globalThis.fetch = stub(true)
	let r = await loadManifest(conn, { env })
	assert.equal(r.source, 'network')
	assert.equal(fetchCount, 1)
	assert.ok(existsSync(cachePath(conn.url, env)), 'cache written on miss')
	assert.equal(r.envelope.server, 'test-1.2.3')

	// 2. on-hit → no refetch.
	r = await loadManifest(conn, { env })
	assert.equal(r.source, 'cache')
	assert.equal(fetchCount, 1, 'a cache hit never refetches')

	// 3. --refresh → forces a fetch.
	r = await loadManifest(conn, { env, refresh: true })
	assert.equal(r.source, 'network')
	assert.equal(fetchCount, 2)

	// 4. version mismatch on the cached file → ignore cache, fetch; if the fetch
	//    also mismatches → embedded. (The cache from steps 1–3 is a valid hit, so
	//    we overwrite it here with a stale-version entry to actually exercise the
	//    mismatch-on-read path — a hit is otherwise never re-fetched, by design.)
	writeFileSync(cachePath(conn.url, env), JSON.stringify({ version: 0, server: 'stale', tools: [] }))
	globalThis.fetch = stub(true, 999)
	r = await loadManifest(conn, { env })
	assert.equal(r.source, 'embedded', 'a version the CLI does not understand falls back to embedded')

	// 5. offline (fetch throws) with no usable cache → embedded snapshot.
	const offlineConn: Conn = { url: 'http://offline:9999', room: 'team', auth: { method: 'none' } }
	globalThis.fetch = stub(false)
	r = await loadManifest(offlineConn, { env })
	assert.equal(r.source, 'embedded')
	assert.equal(r.envelope.version, MANIFEST_VERSION)
	assert.equal(r.envelope.tools.length, 15, 'embedded snapshot is the 15-def allTools')

	// 6. per-instance keying: different urls → different cache files.
	assert.notEqual(cachePath('http://a:1', env), cachePath('http://b:2', env))

	// 7. poisoned-path guard: three bad forms all throw BEFORE any request builds.
	const before = fetchCount
	for (const bad of ['https://evil.example/x', '//evil.example/x', 'api/x', '/\\evil.example/x']) {
		assert.throws(() => toRequestUrl(conn.url, bad, cachePath(conn.url, env)), (e) => e instanceof CliError)
	}
	assert.ok(toRequestUrl(conn.url, '/api/tools').href.startsWith('http://localhost:8788/api/tools'), 'a /-rooted path is accepted')
	assert.equal(fetchCount, before, 'the guard fired with no fetch')

	// embeddedManifest is the compiled-in allTools (server field = CLI_BUILD).
	assert.equal(embeddedManifest().tools.length, 15)

	console.log('ok: manifest — on-miss fetch, on-hit no-refetch, --refresh, version-mismatch→embedded, offline→embedded, per-instance key, poisoned-path guard')
} finally {
	globalThis.fetch = realFetch
}
