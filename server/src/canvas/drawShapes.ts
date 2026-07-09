/**
 * Pure geometry helpers for the CLI drawing-shape branches (line / draw /
 * highlight / reparent). Fiddly, unit-testable logic lives here — behind a
 * `node:assert` script (drawShapes.test.ts) — so shape.ts stays a thin
 * store.put() shell. See docs/design/cli-frames-draw-api.md §7 (test seams).
 */
import { compressLegacySegments } from '@tldraw/tlschema'
import { getIndicesAbove } from '@tldraw/utils'
import { pagePoint } from './geometry.ts'

/** Max absolute page-coordinate a caller may supply (draw/highlight bypass T.number). */
const MAX_COORD = 1e6
/** Float16 max finite value — a larger consecutive delta encodes to Infinity. */
const FLOAT16_MAX = 65504

/** A tldraw VecModel: page-or-local point with optional pen pressure `z`. */
export interface Vec {
	x: number
	y: number
	z?: number
}

/** One draw/highlight segment: `path` is delta-encoded base64 (never hand-written). */
export interface DrawSegment {
	type: string
	path: string
}

/** One line vertex, keyed by a valid fractional IndexKey (key === id === index). */
export interface LinePoint {
	id: string
	index: string
	x: number
	y: number
}

/**
 * Validate + parse the caller's raw `--points` JSON into VecModels. Throws (→ 400)
 * when `raw` isn't an array, any point isn't `[num,num]`/`[num,num,num]` of finite
 * numbers, `|x|` or `|y| > 1e6`, `raw.length < min`, or fewer than 2 distinct points.
 * This is the ONLY guard on draw/highlight geometry (the base64 `path` bypasses the
 * schema). Returns the parsed `{x,y,z?}[]`.
 */
export function parsePoints(raw: unknown, min: number): Vec[] {
	if (!Array.isArray(raw)) throw new Error('points must be an array')
	if (raw.length < min) throw new Error(`points must have at least ${min} point(s)`)
	const out: Vec[] = []
	for (const row of raw) {
		if (!Array.isArray(row) || row.length < 2 || row.length > 3) {
			throw new Error('each point must be [x,y] or [x,y,pressure]')
		}
		for (const c of row) {
			if (typeof c !== 'number' || !Number.isFinite(c)) {
				throw new Error('point coordinates must be finite numbers')
			}
		}
		const [x, y, z] = row as number[]
		if (Math.abs(x!) > MAX_COORD || Math.abs(y!) > MAX_COORD) {
			throw new Error(`point coordinates must have |value| ≤ ${MAX_COORD}`)
		}
		out.push(z === undefined ? { x: x!, y: y! } : { x: x!, y: y!, z })
	}
	const distinct = new Set(out.map((p) => `${p.x},${p.y}`))
	if (distinct.size < 2) throw new Error('need at least 2 distinct points')
	return out
}

/** Bounding-box minimum (top-left) of a point set. */
export function originOf(points: Vec[]): { x: number; y: number } {
	return {
		x: Math.min(...points.map((p) => p.x)),
		y: Math.min(...points.map((p) => p.y)),
	}
}

/** Re-anchor points so the bbox top-left sits at (0,0): `p - origin`. */
export function toLocal(points: Vec[], origin: { x: number; y: number }): Vec[] {
	return points.map((p) =>
		p.z === undefined
			? { x: p.x - origin.x, y: p.y - origin.y }
			: { x: p.x - origin.x, y: p.y - origin.y, z: p.z }
	)
}

/**
 * Build draw/highlight `segments` via `compressLegacySegments`. FIRST rejects any
 * consecutive-point x/y delta `> 65504` (the Float16 delta ceiling — above it a
 * coordinate encodes to Infinity while `put` still returns 200) by throwing (→ 400),
 * THEN encodes. Lives here (not parsePoints) so `line` stays immune.
 */
export function buildSegments(localPoints: Vec[]): DrawSegment[] {
	for (let i = 1; i < localPoints.length; i++) {
		const dx = Math.abs(localPoints[i]!.x - localPoints[i - 1]!.x)
		const dy = Math.abs(localPoints[i]!.y - localPoints[i - 1]!.y)
		if (dx > FLOAT16_MAX || dy > FLOAT16_MAX) {
			throw new Error(`consecutive point delta exceeds the Float16 ceiling (${FLOAT16_MAX})`)
		}
	}
	return compressLegacySegments([
		{ type: 'free', points: localPoints.map((p) => ({ x: p.x, y: p.y, z: 0.5 })) },
	] as any) as DrawSegment[]
}

/**
 * Build the line `points` keyed dict via `getIndicesAbove(null, n)`, following
 * tldraw's key === id === index convention. No handles, no scaleX/scaleY.
 */
export function buildLinePoints(localPoints: Vec[]): Record<string, LinePoint> {
	const keys = getIndicesAbove(null as any, localPoints.length)
	const dict: Record<string, LinePoint> = {}
	localPoints.forEach((p, i) => {
		const key = keys[i]!
		dict[key] = { id: key, index: key, x: p.x, y: p.y }
	})
	return dict
}

/**
 * New local {x,y} for `shape` under `newParentId`, preserving its page position:
 * `P - NP` where P = pagePoint(shape, byId) and NP = pagePoint(newParent) when the
 * new parent is a shape, else {0,0} (reparent to a page). Correct for UNROTATED
 * parents only (see AC22).
 */
export function translateForReparent(
	shape: any,
	newParentId: string,
	byId: Map<string, any>,
): { x: number; y: number } {
	const P = pagePoint(shape, byId)
	const newParent = byId.get(newParentId)
	const NP =
		newParent && newParent.typeName === 'shape' ? pagePoint(newParent, byId) : { x: 0, y: 0 }
	return { x: P.x - NP.x, y: P.y - NP.y }
}
