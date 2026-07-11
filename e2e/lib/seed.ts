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
export const sticky = (room: string, body: Json) => post('/api/canvas/sticky', { room, ...body })

/** Deterministic board exercising every seedable shape kind. Returns created ids. */
export async function seedGoldenBoard(room: string): Promise<string[]> {
	const ids: string[] = []
	const keep = async (p: Promise<Json>) => ids.push(String((await p).id))

	await keep(shape(room, { type: 'text', x: 100, y: 40, text: 'Golden Board' }))
	await keep(shape(room, { type: 'frame', x: 100, y: 120, w: 640, h: 480, name: 'Planning' }))
	// A sticky cluster inside the frame (frame-local coords), plus one outlier.
	for (const [i, txt] of ['alpha', 'beta', 'gamma'].entries())
		await keep(shape(room, { type: 'note', frame: 'Planning', x: 40, y: 40 + i * 110, text: txt, color: 'yellow' }))
	await keep(shape(room, { type: 'note', frame: 'Planning', x: 420, y: 320, text: 'outlier', color: 'blue' }))
	// Two geos joined by a bound arrow (page coords).
	await keep(shape(room, { type: 'geo', geo: 'rectangle', x: 820, y: 160, w: 160, h: 100, text: 'A' }))
	await keep(shape(room, { type: 'geo', geo: 'ellipse', x: 820, y: 420, w: 160, h: 100, text: 'B' }))
	await keep(shape(room, { type: 'arrow', fromId: ids[6], toId: ids[7] }))
	// A deterministic ink stroke.
	await keep(
		shape(room, {
			type: 'draw',
			points: [[1040, 200], [1080, 240], [1060, 300], [1120, 340], [1100, 400]],
		}),
	)
	return ids
}
export const GOLDEN_BOARD_SHAPE_COUNT = 10
