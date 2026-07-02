/**
 * Pure constants + helpers for the screenshare shape — no React, tldraw or
 * livekit imports, so screenshare.test.ts runs (and exits) in plain node.
 * The shape class itself lives in ScreenShareShapeUtil.tsx.
 */

// Fixed header band on top of the video area, same height as the neko shape's.
export const SCREENSHARE_HEADER_HEIGHT = 28
// Default tile width in page units — readable text without dwarfing the canvas.
export const SCREENSHARE_DEFAULT_W = 1280

const FALLBACK_ASPECT = 16 / 9

// getDisplayMedia settings can be empty on some platforms; never let a bad
// aspect produce an Infinity/NaN-sized shape.
function safeAspect(aspect: number): number {
	return Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT
}

/**
 * Lock a freely-resized box to the stream's aspect (no letterbox at rest).
 * Drives off whichever dimension the drag changed more, so corner and side
 * handles all feel responsive (same behaviour as lockNekoAspect, but the
 * ratio comes from the shape's props instead of a constant).
 */
export function lockScreenShareAspect(
	w: number,
	h: number,
	prevW: number,
	prevH: number,
	aspect: number
): { w: number; h: number } {
	const a = safeAspect(aspect)
	if (Math.abs(h - prevH) > Math.abs(w - prevW)) {
		return { w: (h - SCREENSHARE_HEADER_HEIGHT) * a, h }
	}
	return { w, h: w / a + SCREENSHARE_HEADER_HEIGHT }
}

/**
 * Height + aspect props for a tile of width `w` showing a surface with the
 * given aspect. Used at share time and again whenever the sharer's window is
 * resized (width is kept, height follows — the tile never drifts sideways).
 */
export function propsForAspect(w: number, aspect: number): { h: number; aspect: number } {
	const a = safeAspect(aspect)
	return { h: Math.round(w / a) + SCREENSHARE_HEADER_HEIGHT, aspect: a }
}

/**
 * Chrome labels capture tracks with opaque ids like "screen:0:0" or
 * "window:12345:0"; real window titles (some platforms provide them) pass
 * through as the tile title.
 */
export function titleFromTrackLabel(label: string): string {
	if (!label || /^(screen|window|web-contents-media-stream):/i.test(label)) return 'screen share'
	return label
}

/**
 * Tile title: who is sharing + what they're sharing. Baked into the synced
 * props at share time (not resolved from the room at render time) so a
 * tombstone tile still says whose window it was after the sharer leaves.
 */
export function shareTitle(sharerName: string, trackLabel: string): string {
	const who = sharerName.trim() || 'someone'
	return `${who} · ${titleFromTrackLabel(trackLabel)}`
}
