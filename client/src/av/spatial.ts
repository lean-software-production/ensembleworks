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
 * Viewport-relative (screen-space) settings: the same falloff curve, but the
 * radii are FRACTIONS of the viewport's half-diagonal in screen pixels, so
 * the model is resolution-independent and zoom becomes reach — zooming in
 * stretches page distances in screen pixels (peers outside your focus fade);
 * zooming out shrinks them (at full zoom-out the whole page is a huddle).
 */
export interface ScreenSpatialSettings {
	/** Fraction of the viewport half-diagonal within which a voice is full volume. */
	huddleFraction: number
	/** Fraction of the half-diagonal at which the falloff bottoms out. >1 so
	 * drifting just off-screen makes a peer quieter, never a hard cliff. */
	falloffFraction: number
	/** Minimum gain — teammates never fully disappear. */
	floor: number
}

export const DEFAULT_SCREEN_SPATIAL_SETTINGS: ScreenSpatialSettings = {
	huddleFraction: 0.45,
	falloffFraction: 1.6,
	floor: 0.04,
}

/**
 * The screen-space gain: convert a page-space distance to screen pixels
 * (× zoom), derive pixel radii from the viewport half-diagonal, and reuse the
 * existing curve. Non-finite inputs or a degenerate viewport → floor,
 * mirroring gainForDistance's own finite guard.
 */
export function gainForScreenDistance(
	pageDistance: number,
	zoom: number,
	viewportHalfDiagonalPx: number,
	settings: ScreenSpatialSettings
): number {
	const { huddleFraction, falloffFraction, floor } = settings
	if (
		!Number.isFinite(pageDistance) ||
		!Number.isFinite(zoom) ||
		!Number.isFinite(viewportHalfDiagonalPx) ||
		viewportHalfDiagonalPx <= 0
	) {
		return floor
	}
	return gainForDistance(pageDistance * zoom, {
		huddleRadius: huddleFraction * viewportHalfDiagonalPx,
		falloffEnd: falloffFraction * viewportHalfDiagonalPx,
		floor,
	})
}
