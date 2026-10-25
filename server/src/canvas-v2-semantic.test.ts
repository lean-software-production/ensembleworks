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
import { createShapeId, toRichText } from '@tldraw/tlschema'
import { createSyncApp } from './app.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'v2s-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
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

	// Whole-page scope (no frame param) must see frame-NESTED content — the
	// common case. Direct page children alone would yield zero clusters here.
	const semPage = await get('/api/v2/canvas/semantic?room=r')
	assert.equal(semPage.status, 200)
	assert.ok((semPage.body as any).clusters.length >= 1, 'whole-page semantics sees frame-nested notes')

	// neighbors: pass a real note id from the document read.
	const doc = await get('/api/v2/canvas/document?room=r')
	const aNote = (doc.body as any).shapes.find((s: any) => s.kind === 'note')
	const near = await get(`/api/v2/canvas/neighbors?room=r&id=${encodeURIComponent(aNote.id)}&radius=300`)
	assert.equal(near.status, 200)
	assert.ok(Array.isArray((near.body as any).neighbors))
	assert.equal((near.body as any).radius, 300, 'echoes the requested radius')

	// Garbage radius: the response must echo the EFFECTIVE radius (the 400
	// default actually queried), not NaN→null.
	const nanRadius = await get(`/api/v2/canvas/neighbors?room=r&id=${encodeURIComponent(aNote.id)}&radius=abc`)
	assert.equal(nanRadius.status, 200)
	assert.equal((nanRadius.body as any).radius, 400, 'garbage radius falls back to 400 and says so')

	// 404s: unknown frame; unknown shape id.
	assert.equal((await get('/api/v2/canvas/semantic?room=r&frame=zzz')).status, 404)
	assert.equal((await get('/api/v2/canvas/neighbors?room=r&id=shape:none')).status, 404)

	// Native tldraw group nested in the frame (the v1 write API can't create
	// groups, so put the records directly — the roundtrip.test.ts pattern): a
	// note inside a group inside the frame must still be seen by frame-scoped
	// semantics (descendant scope, not direct children).
	const frameShape = (doc.body as any).shapes.find((s: any) => s.kind === 'frame')
	const groupId = createShapeId()
	const nestedNoteId = createShapeId()
	await getOrCreateRoom('r').updateStore((store: any) => {
		store.put({
			typeName: 'shape', id: groupId, type: 'group', parentId: frameShape.id, index: 'a9',
			x: 500, y: 500, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
		} as any)
		store.put({
			typeName: 'shape', id: nestedNoteId, type: 'note', parentId: groupId, index: 'a1',
			x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
			props: {
				richText: toRichText('nested'), color: 'green', labelColor: 'black', size: 'm', font: 'draw',
				fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1,
				textFirstEditedBy: null,
			},
		} as any)
	})
	const semNested = await get('/api/v2/canvas/semantic?room=r&frame=plan')
	assert.equal(semNested.status, 200)
	const seenIds = new Set<string>([
		...(semNested.body as any).outliers,
		...(semNested.body as any).clusters.flatMap((c: any) => c.members),
	])
	assert.ok(seenIds.has(nestedNoteId), 'group-nested note is visible to frame-scoped semantics')

	console.log('ok: canvas-v2 semantic + neighbors')

	server.close()
	process.exit(0)
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
