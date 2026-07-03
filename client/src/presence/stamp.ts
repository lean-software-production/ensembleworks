/**
 * Client-computed spatial stamp: where am I on the canvas (page space) and
 * which frame am I at? Each browser computes this for itself from the CRDT
 * replica it already holds and publishes it via presence.meta.stamp; the
 * server reads the field instead of walking the document (transcript
 * stamping, proximity-ordered agent reads).
 *
 * Semantics (ported verbatim from the server's former frameAtPoint /
 * viewportCenter): the mouse cursor wins when it is inside a frame (they're
 * pointing at something); otherwise the viewport centre (what they're
 * looking at), falling back to the cursor when camera/screenBounds are
 * unavailable. `at` and `frame` always agree — `frame` was matched against
 * exactly the point recorded in `at`.
 *
 * Pure and dependency-free so it is unit-testable and safe inside the
 * reactive getUserPresence derivation.
 *
 * Keep in sync with the server-side consumer: SpatialStamp / parseStamp in
 * server/src/app.ts. (Early extraction candidate for @ensembleworks/contracts.)
 */

// The minimal structural slice of a tldraw store record the stamp needs.
export interface StampRecord {
	id: string
	typeName?: string
	type?: string
	parentId?: string
	x?: number
	y?: number
	props?: Record<string, unknown>
}

export interface StampInputs {
	currentPageId: string
	cursor: { x: number; y: number }
	camera: { x: number; y: number; z: number } | null
	screenBounds: { w: number; h: number } | null
}

// The wire shape carried in presence.meta.stamp. A `type` (not interface) so
// it structurally satisfies tldraw's JsonObject for the meta field.
export type SpatialStamp = {
	at: { x: number; y: number }
	frame: { name: string; dist: number } | null
}

// The page id a shape ultimately lives on (walks up nested parents).
function pageIdOf(shape: StampRecord, byId: Map<string, StampRecord>): string | null {
	let pid: string | undefined = shape.parentId
	let guard = 0
	while (pid && pid.startsWith('shape:') && guard++ < 50) {
		pid = byId.get(pid)?.parentId
	}
	return pid ?? null
}

// A shape's top-left in page coordinates (child x/y are parent-relative).
function pagePoint(shape: StampRecord, byId: Map<string, StampRecord>): { x: number; y: number } {
	let x = shape.x ?? 0
	let y = shape.y ?? 0
	let parent = shape.parentId ? byId.get(shape.parentId) : undefined
	let guard = 0
	while (parent && parent.typeName === 'shape' && guard++ < 50) {
		x += parent.x ?? 0
		y += parent.y ?? 0
		parent = parent.parentId ? byId.get(parent.parentId) : undefined
	}
	return { x, y }
}

// The frame a point is inside of (dist 0), or the nearest one on the same
// page (distance to the frame's edge). First-best-wins on ties.
function frameAtPoint(
	shapes: StampRecord[],
	byId: Map<string, StampRecord>,
	pageId: string,
	point: { x: number; y: number }
): { name: string; dist: number } | null {
	let best: { name: string; dist: number } | null = null
	for (const f of shapes) {
		if (f.type !== 'frame' || pageIdOf(f, byId) !== pageId) continue
		const pt = pagePoint(f, byId)
		const w = typeof f.props?.w === 'number' ? f.props.w : 0
		const h = typeof f.props?.h === 'number' ? f.props.h : 0
		// Distance from the point to the frame rect (0 when inside).
		const dx = Math.max(pt.x - point.x, 0, point.x - (pt.x + w))
		const dy = Math.max(pt.y - point.y, 0, point.y - (pt.y + h))
		const d = Math.hypot(dx, dy)
		if (!best || d < best.dist) {
			best = { name: typeof f.props?.name === 'string' ? f.props.name : '', dist: Math.round(d) }
		}
	}
	return best
}

// The page point at the centre of my viewport — what I'm looking at.
// tldraw screen→page is page = screen/z − camera, evaluated at the centre.
function viewportCenter(
	camera: { x: number; y: number; z: number } | null,
	screenBounds: { w: number; h: number } | null
): { x: number; y: number } | null {
	if (!camera || !screenBounds) return null
	const z = camera.z || 1
	return { x: screenBounds.w / 2 / z - camera.x, y: screenBounds.h / 2 / z - camera.y }
}

export function computeStamp(records: readonly StampRecord[], inputs: StampInputs): SpatialStamp {
	const byId = new Map(records.map((r) => [r.id, r]))
	const shapes = records.filter((r) => r.typeName === 'shape')
	const atCursor = frameAtPoint(shapes, byId, inputs.currentPageId, inputs.cursor)
	let at = inputs.cursor
	let frame = atCursor
	if (!(atCursor && atCursor.dist === 0)) {
		at = viewportCenter(inputs.camera, inputs.screenBounds) ?? inputs.cursor
		frame = frameAtPoint(shapes, byId, inputs.currentPageId, at)
	}
	return { at: { x: Math.round(at.x), y: Math.round(at.y) }, frame }
}
