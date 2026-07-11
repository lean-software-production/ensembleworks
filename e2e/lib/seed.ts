// Seeds rooms through the real agent HTTP API — the same surface the Discord
// bot and skills use — so the rig doubles as an API smoke suite.
import { API } from './fixtures'

type Json = Record<string, unknown>

async function post(path: string, body: Json): Promise<Json> {
	const res = await fetch(`${API}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`)
	return (await res.json()) as Json
}

export const shape = (room: string, body: Json) => post('/api/canvas/shape', { room, ...body })
// Kept for future sticky-endpoint coverage; currently unused by the golden board.
export const sticky = (room: string, body: Json) => post('/api/canvas/sticky', { room, ...body })

/** Deterministic board exercising every seedable shape kind. Returns created ids. */
export async function seedGoldenBoard(room: string): Promise<string[]> {
	const ids: string[] = []
	// Creations must stay sequential (not Promise.all'd) — z-order comes from creation order.
	const create = async (body: Json) => {
		const id = String((await shape(room, body)).id)
		ids.push(id)
		return id
	}

	await create({ type: 'text', x: 100, y: 40, text: 'Golden Board' })
	await create({ type: 'frame', x: 100, y: 120, w: 640, h: 720, name: 'Planning' })
	// A sticky cluster inside the frame (frame-local coords), plus one outlier.
	// tldraw notes are a fixed 200×200 (the server ignores w/h for notes), so
	// spacing must be ≥ ~210 to keep them from overlapping.
	for (const [i, txt] of ['alpha', 'beta', 'gamma'].entries())
		await create({ type: 'note', frame: 'Planning', x: 40, y: 40 + i * 220, text: txt, color: 'yellow' })
	await create({ type: 'note', frame: 'Planning', x: 420, y: 320, text: 'outlier', color: 'blue' })
	// Two geos joined by a bound arrow (page coords).
	const rectId = await create({ type: 'geo', geo: 'rectangle', x: 820, y: 160, w: 160, h: 100, text: 'A' })
	const ellipseId = await create({ type: 'geo', geo: 'ellipse', x: 820, y: 420, w: 160, h: 100, text: 'B' })
	await create({ type: 'arrow', fromId: rectId, toId: ellipseId })
	// A deterministic ink stroke.
	await create({
		type: 'draw',
		points: [[1040, 200], [1080, 240], [1060, 300], [1120, 340], [1100, 400]],
	})
	return ids
}
export const GOLDEN_BOARD_SHAPE_COUNT = 10
