/**
 * ew-pinch → synthetic canvas wheel (spec: docs/superpowers/specs/
 * 2026-07-15-pinch-zoom-guard-design.md). The /files/* bridge swallows a
 * pinch inside the iframe and posts {type:'ew-pinch', deltaX, deltaY, x, y}
 * (x/y in iframe-content CSS px). This module maps that point through the
 * iframe's on-screen rect (the iframe lives inside a CSS-scaled world
 * layer, so rect and clientWidth differ by the zoom factor) and re-dispatches
 * a synthetic ctrl-wheel ON the iframe element. It bubbles to whichever
 * engine container encloses it (tldraw's, or canvas-react's Viewport), which
 * handles it exactly like a real pinch — no engine-specific camera code.
 * Shared by both file-viewer components (legacy tldraw + canvas-v2).
 */

export interface PinchPayload {
	readonly deltaX: number
	readonly deltaY: number
	readonly x: number
	readonly y: number
}

/** Validate an untrusted postMessage payload; null unless a complete ew-pinch. */
export function parsePinchMessage(d: unknown): PinchPayload | null {
	if (!d || typeof d !== 'object') return null
	const p = d as Record<string, unknown>
	if (p.type !== 'ew-pinch') return null
	if (typeof p.deltaX !== 'number' || typeof p.deltaY !== 'number' || typeof p.x !== 'number' || typeof p.y !== 'number') return null
	return { deltaX: p.deltaX, deltaY: p.deltaY, x: p.x, y: p.y }
}

export interface RectLike {
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
}

/** Iframe-content point → parent client coordinates; null if the iframe has no layout size. */
export function mapIframePointToClient(
	rect: RectLike,
	layoutW: number,
	layoutH: number,
	x: number,
	y: number,
): { clientX: number; clientY: number } | null {
	if (layoutW <= 0 || layoutH <= 0) return null
	return {
		clientX: rect.left + (x / layoutW) * rect.width,
		clientY: rect.top + (y / layoutH) * rect.height,
	}
}

/** The thin DOM half: replay a validated pinch as a bubbling ctrl-wheel on the iframe. */
export function forwardPinchToCanvas(iframe: HTMLIFrameElement, pinch: PinchPayload): void {
	const pt = mapIframePointToClient(iframe.getBoundingClientRect(), iframe.clientWidth, iframe.clientHeight, pinch.x, pinch.y)
	if (!pt) return
	iframe.dispatchEvent(
		new WheelEvent('wheel', {
			bubbles: true,
			cancelable: true,
			ctrlKey: true,
			deltaX: pinch.deltaX,
			deltaY: pinch.deltaY,
			deltaMode: 0,
			clientX: pt.clientX,
			clientY: pt.clientY,
		}),
	)
}
