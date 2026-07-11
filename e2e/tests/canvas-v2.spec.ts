// Drives every Agent API v2 read endpoint against the real server (:8788). Pure
// HTTP — the read side needs no browser. This is the "untyped consumers" watchdog.
import { test, expect, API } from '../lib/fixtures'
import { shape } from '../lib/seed'

const get = (p: string) => fetch(`${API}${p}`).then(async (r) => ({ status: r.status, body: (await r.json()) as any }))

test('canvas-v2 read endpoints serve the new model', async () => {
	const room = 'v2-smoke'
	await shape(room, { type: 'frame', name: 'Planning', x: 0, y: 0, w: 1000, h: 800 })
	for (const [i, t] of ['alpha', 'beta', 'gamma'].entries())
		await shape(room, { type: 'note', frame: 'Planning', x: 20, y: 20 + i * 120, text: t, color: 'yellow' })
	await shape(room, { type: 'note', frame: 'Planning', x: 800, y: 700, text: 'lonely', color: 'blue' })

	const doc = await get(`/api/v2/canvas/document?room=${room}`)
	expect(doc.status).toBe(200)
	expect(doc.body.model).toBe(2)
	expect(doc.body.shapes.length).toBe(5)

	const frames = await get(`/api/v2/canvas/frames?room=${room}`)
	expect(frames.body.frames[0].name).toBe('Planning')
	expect(frames.body.frames[0].notes).toBe(4)

	const frame = await get(`/api/v2/canvas/frame?room=${room}&name=plan`)
	expect(frame.status).toBe(200)
	expect(frame.body.members.length).toBe(4)

	const sem = await get(`/api/v2/canvas/semantic?room=${room}&frame=plan`)
	expect(sem.status).toBe(200)
	expect(sem.body.clusters.length).toBeGreaterThanOrEqual(1)
	expect(sem.body.outliers.length).toBeGreaterThanOrEqual(1)

	const aNote = doc.body.shapes.find((s: any) => s.kind === 'note')
	const near = await get(`/api/v2/canvas/neighbors?room=${room}&id=${encodeURIComponent(aNote.id)}&radius=300`)
	expect(near.status).toBe(200)
	expect(Array.isArray(near.body.neighbors)).toBe(true)
})
