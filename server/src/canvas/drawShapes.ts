/**
 * Pure geometry helpers for the CLI drawing-shape branches (line / draw /
 * highlight / reparent). Fiddly, unit-testable logic lives here — behind a
 * `node:assert` script (drawShapes.test.ts) — so shape.ts stays a thin
 * store.put() shell. See docs/design/cli-frames-draw-api.md §7 (test seams).
 *
 * NAVIGATOR STUB (EW-CLI-DRAW-0001): signatures only; every body throws
 * `not implemented`. The Driver fills them so drawShapes.test.ts goes green.
 * Do NOT implement here as the Navigator.
 */

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
	void raw
	void min
	throw new Error('not implemented')
}

/** Bounding-box minimum (top-left) of a point set. */
export function originOf(points: Vec[]): { x: number; y: number } {
	void points
	throw new Error('not implemented')
}

/** Re-anchor points so the bbox top-left sits at (0,0): `p - origin`. */
export function toLocal(points: Vec[], origin: { x: number; y: number }): Vec[] {
	void points
	void origin
	throw new Error('not implemented')
}

/**
 * Build draw/highlight `segments` via `compressLegacySegments`. FIRST rejects any
 * consecutive-point x/y delta `> 65504` (the Float16 delta ceiling — above it a
 * coordinate encodes to Infinity while `put` still returns 200) by throwing (→ 400),
 * THEN encodes. Lives here (not parsePoints) so `line` stays immune.
 */
export function buildSegments(localPoints: Vec[]): DrawSegment[] {
	void localPoints
	throw new Error('not implemented')
}

/**
 * Build the line `points` keyed dict via `getIndicesAbove(null, n)`, following
 * tldraw's key === id === index convention. No handles, no scaleX/scaleY.
 */
export function buildLinePoints(localPoints: Vec[]): Record<string, LinePoint> {
	void localPoints
	throw new Error('not implemented')
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
	void shape
	void newParentId
	void byId
	throw new Error('not implemented')
}
