// Contract tests for the Agent API v2 read endpoints (Unit 9, Task E2).
// Boots the express app in-process via createSyncApp, seeds a room through the
// EXISTING v1 write API (POST /api/canvas/shape), then exercises the new v2
// reads (document/frames/frame), which convert the same tldraw store live via
// @ensembleworks/canvas-model.
// Run with: bun src/canvas-v2-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'v2-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, r))
	const { port } = server.address() as any
	const base = `http://127.0.0.1:${port}`
	const post = (p: string, b: any): Promise<any> =>
		fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
	const get = async (p: string): Promise<{ status: number; body: any }> => {
		const r = await fetch(`${base}${p}`)
		return { status: r.status, body: await r.json() }
	}

	// Seed via the v1 write API: a frame + two notes inside it.
	const frame = await post('/api/canvas/shape', { room: 'r', type: 'frame', name: 'Planning', x: 0, y: 0, w: 600, h: 400 })
	await post('/api/canvas/shape', { room: 'r', type: 'note', frame: 'Planning', x: 20, y: 20, text: 'alpha' })
	await post('/api/canvas/shape', { room: 'r', type: 'note', frame: 'Planning', x: 20, y: 140, text: 'beta' })
	assert.ok(frame.ok)

	// document
	const doc = await get('/api/v2/canvas/document?room=r')
	assert.equal(doc.status, 200)
	assert.equal(doc.body.shapes.length, 3)
	assert.equal(doc.body.model, 2) // model marker

	// frames
	const frames = await get('/api/v2/canvas/frames?room=r')
	assert.equal(frames.status, 200)
	assert.equal(frames.body.frames.length, 1)
	assert.equal(frames.body.frames[0].name, 'Planning')
	assert.equal(frames.body.frames[0].notes, 2)

	// frame contents
	const one = await get('/api/v2/canvas/frame?room=r&name=plan')
	assert.equal(one.status, 200)
	assert.deepEqual(one.body.members.map((m: any) => m.text).sort(), ['alpha', 'beta'])
	// v1 parity: the frame object carries its page (same field /frames reports).
	assert.equal(one.body.frame.page, frames.body.frames[0].page)
	assert.ok(String(one.body.frame.page).startsWith('page:'), 'frame.page is a real page id')

	// 404 on unknown frame
	const miss = await get('/api/v2/canvas/frame?room=r&name=zzz')
	assert.equal(miss.status, 404)

	// Bad room id (sanitizeId rejects dots) → 400 on every route.
	const badDoc = await get('/api/v2/canvas/document?room=..bad..')
	assert.equal(badDoc.status, 400, 'bad room id is 400 on /document')
	const badFrames = await get('/api/v2/canvas/frames?room=..bad..')
	assert.equal(badFrames.status, 400, 'bad room id is 400 on /frames')
	const badFrame = await get('/api/v2/canvas/frame?room=..bad..&name=x')
	assert.equal(badFrame.status, 400, 'bad room id is 400 on /frame')

	// A never-seeded room converts to an empty model (a fresh room holds only
	// document:document + page:page): 200 with empty shapes/frames arrays.
	const emptyDoc = await get('/api/v2/canvas/document?room=fresh')
	assert.equal(emptyDoc.status, 200)
	assert.deepEqual(emptyDoc.body.shapes, [])
	const emptyFrames = await get('/api/v2/canvas/frames?room=fresh')
	assert.equal(emptyFrames.status, 200)
	assert.deepEqual(emptyFrames.body.frames, [])

	// NOTE: guard()'s 500 path is not exercised end-to-end — provoking a genuine
	// throw inside the live conversion would need in-process monkeypatching that
	// doesn't cross the HTTP boundary cleanly (controller-accepted gap; the
	// wrapper awaits the handler, so sync AND async throws are covered by
	// construction, and it typechecks against both signatures).

	console.log('ok: canvas-v2 api (document/frames/frame + edge cases)')

	server.close()
	process.exit(0)
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
