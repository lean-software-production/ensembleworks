/**
 * A teammate's shared window/screen as a canvas tile (spec:
 * docs/superpowers/specs/2026-07-02-screenshare-tiles-design.md).
 *
 * Position + size are shared via tldraw sync; the PIXELS are per-viewer —
 * each client attaches the LiveKit track named in the props (store.ts). The
 * sharer attaches their own local track as a self-preview; everyone else
 * receives the remote track only while the tile is in or near their viewport
 * (the loop in AvOverlay). The tile is aspect-locked to the captured surface,
 * and the sharer's client updates `aspect` when the shared window is resized,
 * so the tile always has the window's true proportions.
 */

// ── Constants + pure helpers (unit-tested via screenshare.test.ts) ──────────

// Fixed header band on top of the video area, same height as the neko shape's.
export const SCREENSHARE_HEADER_HEIGHT = 28
// Default tile width in page units — readable text without dwarfing the canvas.
export const SCREENSHARE_DEFAULT_W = 1280

// Toolbar icon: a monitor with an outgoing arrow ("share out"). Single-colour
// silhouette rendered by tldraw as a CSS mask; registered via <Tldraw
// assetUrls> in App.tsx (same mechanism as the neko icon).
export const SCREENSHARE_ICON_NAME = 'screenshare'
const SCREENSHARE_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">' +
	'<rect x="2" y="4" width="20" height="13" rx="2"/>' +
	'<path d="M12 17v3M8 20h8" stroke-linecap="round"/>' +
	'<path d="M8.5 12 12 8.5 15.5 12M12 8.5V14" stroke-linecap="round"/></svg>'
export const SCREENSHARE_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(SCREENSHARE_ICON_SVG)}`

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
