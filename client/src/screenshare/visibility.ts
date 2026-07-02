/**
 * Pure viewport-vs-tile geometry for screen-share subscription: decides which
 * LiveKit screen tracks a viewer should receive (the spec's "deterministic"
 * path — the stream stops at the SFU, not merely hidden client-side).
 *
 * Hysteresis: we subscribe a little BEFORE a tile enters the viewport and
 * drop it only when it is WELL outside, so panning along a tile's edge never
 * flaps the subscription. Pure + dependency-free → unit-tests in node, like
 * av/spatial.ts.
 */
export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface VisibilitySettings {
	subscribeMargin: number
	unsubscribeMargin: number
}

// Margins are in page units (canvas coordinates), sized against a typical
// ~1280-wide tile: subscribe when within a fifth of a tile of the viewport,
// keep the stream until it is most of a tile away.
export const DEFAULT_VISIBILITY_SETTINGS: VisibilitySettings = {
	subscribeMargin: 200,
	unsubscribeMargin: 800,
}

function intersectsWithMargin(shape: Rect, viewport: Rect, margin: number): boolean {
	return (
		shape.x < viewport.x + viewport.w + margin &&
		shape.x + shape.w > viewport.x - margin &&
		shape.y < viewport.y + viewport.h + margin &&
		shape.y + shape.h > viewport.y - margin
	)
}

/**
 * shape is null when the track has no tile on the viewer's current page
 * (deleted, or on another tldraw page) → never subscribe.
 */
export function shouldBeSubscribed(
	shape: Rect | null,
	viewport: Rect,
	subscribed: boolean,
	settings: VisibilitySettings = DEFAULT_VISIBILITY_SETTINGS
): boolean {
	if (!shape) return false
	const margin = subscribed ? settings.unsubscribeMargin : settings.subscribeMargin
	return intersectsWithMargin(shape, viewport, margin)
}
