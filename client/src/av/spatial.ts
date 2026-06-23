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
