// Contract test for the Agent API v2 spatial-semantics endpoints (Unit 10, Task E3).
// Boots the express app in-process via createSyncApp, seeds a room through the
// EXISTING v1 write API (POST /api/canvas/shape), then exercises the new
// semantic + neighbors reads, which convert the same tldraw store live via
// @ensembleworks/canvas-model.
// Run with: bun src/canvas-v2-semantic.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'v2s-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const { port } = server.address() as any
	const base = `http://127.0.0.1:${port}`
	const post = (b: any) =>
		fetch(`${base}/api/canvas/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'r', ...b }) }).then((r) => r.json())
	const get = (p: string) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }))

	await post({ type: 'frame', name: 'Planning', x: 0, y: 0, w: 1200, h: 800 })
	// A tight column of 3 notes near the top-left, one outlier far away.
	for (const [i, t] of ['alpha', 'beta', 'gamma'].entries())
		await post({ type: 'note', frame: 'Planning', x: 20, y: 20 + i * 120, text: t, color: 'yellow' })
	await post({ type: 'note', frame: 'Planning', x: 900, y: 700, text: 'lonely', color: 'blue' })

	const sem = await get('/api/v2/canvas/semantic?room=r&frame=plan')
	assert.equal(sem.status, 200)
	assert.equal((sem.body as any).model, 2)
	assert.ok((sem.body as any).clusters.length >= 1, 'at least one cluster')
	assert.ok((sem.body as any).outliers.length >= 1, 'the lonely note is an outlier')

	// neighbors: pass a real note id from the document read.
	const doc = await get('/api/v2/canvas/document?room=r')
	const aNote = (doc.body as any).shapes.find((s: any) => s.kind === 'note')
	const near = await get(`/api/v2/canvas/neighbors?room=r&id=${encodeURIComponent(aNote.id)}&radius=300`)
	assert.equal(near.status, 200)
	assert.ok(Array.isArray((near.body as any).neighbors))

	// 404s: unknown frame; unknown shape id.
	assert.equal((await get('/api/v2/canvas/semantic?room=r&frame=zzz')).status, 404)
	assert.equal((await get('/api/v2/canvas/neighbors?room=r&id=shape:none')).status, 404)

	console.log('ok: canvas-v2 semantic + neighbors')

	server.close()
	process.exit(0)
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
