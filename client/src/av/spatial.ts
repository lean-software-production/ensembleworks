/**
 * The spatial audio model: a remote teammate's volume is a function of
 * canvas-space distance between your viewport centre and their cursor.
 *
 * Full volume inside the huddle radius, then a linear falloff down to a
 * floor — so two people pairing at one terminal talk at full volume while
 * the retro huddle across the canvas is a murmur. "Standup mode" overrides
 * everyone to full volume.
 */

export interface SpatialSettings {
	/** Distance (page units) within which a voice is at full volume. */
	huddleRadius: number
	/** Distance at which the falloff bottoms out at the floor. */
	falloffEnd: number
	/** Minimum gain — teammates never fully disappear. */
	floor: number
}

export const DEFAULT_SPATIAL_SETTINGS: SpatialSettings = {
	huddleRadius: 600,
	falloffEnd: 3500,
	floor: 0.04,
}

export function gainForDistance(distance: number, settings: SpatialSettings): number {
	const { huddleRadius, falloffEnd, floor } = settings
	if (!Number.isFinite(distance)) return floor
	if (distance <= huddleRadius) return 1
	if (distance >= falloffEnd) return floor
	const t = (distance - huddleRadius) / (falloffEnd - huddleRadius)
	return 1 - (1 - floor) * t
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
	return Math.hypot(ax - bx, ay - by)
}

/**
 * Viewport-relative settings: a teammate whose cursor is anywhere INSIDE my
 * viewport rectangle is at full volume — if I can see their cursor, I can
 * hear them. Outside it, volume fades with how far beyond the nearest
 * viewport edge their cursor sits (in screen pixels), bottoming out at the
 * floor once they're falloffFraction × my viewport half-diagonal past the
 * edge. Zoom is reach: zooming out grows the rectangle in page space, so
 * fully zoomed out the whole page is in view — and audible.
 */
export interface ViewportSpatialSettings {
	/** Fraction of the viewport half-diagonal BEYOND the viewport edge at
	 * which the falloff bottoms out at the floor. */
	falloffFraction: number
	/** Minimum gain — teammates never fully disappear. */
	floor: number
}

export const DEFAULT_VIEWPORT_SPATIAL_SETTINGS: ViewportSpatialSettings = {
	falloffFraction: 1,
	floor: 0.04,
}

/**
 * Screen-pixel distance from a page-space point to a page-space rectangle —
 * 0 inside or on the boundary, else the euclidean shortfall to the nearest
 * edge/corner. The rect is my viewport in page space; multiplying the
 * page-space shortfall by zoom yields screen pixels, so the fade rate is
 * relative to what I SEE, independent of zoom level.
 */
export function screenDistanceOutsideRect(
	x: number,
	y: number,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
	zoom: number
): number {
	const dx = Math.max(rect.minX - x, 0, x - rect.maxX)
	const dy = Math.max(rect.minY - y, 0, y - rect.maxY)
	return Math.hypot(dx, dy) * zoom
}

/**
 * The viewport-rect gain: full volume at outsidePx 0 (cursor in view — the
 * rect IS the huddle), linear fade to the floor at falloffFraction × the
 * half-diagonal past the edge. Non-finite input or a degenerate viewport →
 * floor, mirroring gainForDistance's own finite guard.
 */
export function gainForViewportDistance(
	outsidePx: number,
	viewportHalfDiagonalPx: number,
	settings: ViewportSpatialSettings
): number {
	const { falloffFraction, floor } = settings
	if (
		!Number.isFinite(outsidePx) ||
		!Number.isFinite(viewportHalfDiagonalPx) ||
		viewportHalfDiagonalPx <= 0
	) {
		return floor
	}
	return gainForDistance(outsidePx, {
		huddleRadius: 0,
		falloffEnd: falloffFraction * viewportHalfDiagonalPx,
		floor,
	})
}
