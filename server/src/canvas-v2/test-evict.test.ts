// Run: bun server/src/canvas-v2/test-evict.test.ts
// The test-only cold-actor hook: POST /api/canvas-v2/test/evict/:roomId forces
// an immediate idle sweep, so a perf harness can measure a genuinely COLD room
// (snapshot + oplog reload from SQLite) rather than the warm actor its own
// seeding just created. Gated behind EW_CANVAS_TEST_EVICT=1 and 404s otherwise
// — a production deployment must not be able to evict a room over HTTP.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from '../app.ts'

async function boot(env: Record<string, string | undefined>) {
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-evict-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	return { server, dataDir, url: `http://127.0.0.1:${port}` }
}

{
	// Flag OFF: the route must not exist.
	const { server, dataDir, url } = await boot({ EW_CANVAS_SYNC: '1', EW_CANVAS_TEST_EVICT: undefined })
	const res = await fetch(`${url}/api/canvas-v2/test/evict/some-room`, { method: 'POST' })
	assert.equal(res.status, 404, 'the evict hook must 404 when EW_CANVAS_TEST_EVICT is unset')
	server.close()
	rmSync(dataDir, { recursive: true, force: true })
	console.log('ok: evict hook is absent without EW_CANVAS_TEST_EVICT')
}
{
	// Flag ON: the route exists and reports the sweep.
	const { server, dataDir, url } = await boot({ EW_CANVAS_SYNC: '1', EW_CANVAS_TEST_EVICT: '1' })
	const res = await fetch(`${url}/api/canvas-v2/test/evict/some-room`, { method: 'POST' })
	assert.equal(res.status, 200, 'the evict hook responds 200 when enabled')
	assert.deepEqual(await res.json(), { ok: true })
	server.close()
	rmSync(dataDir, { recursive: true, force: true })
	console.log('ok: evict hook responds when EW_CANVAS_TEST_EVICT=1')
}

console.log('ok: test-evict — all cases')
process.exit(0)
