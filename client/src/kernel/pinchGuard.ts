/**
 * App-wide browser-zoom guard (spec: docs/superpowers/specs/
 * 2026-07-15-pinch-zoom-guard-design.md). A trackpad pinch arrives as a
 * `wheel` event with ctrlKey:true; only the canvas containers preventDefault
 * it, so a pinch over fixed chrome (side panel, control bar) page-zooms the
 * whole app. This capture-phase, NON-PASSIVE window listener preventDefaults
 * every ctrl/meta+wheel — preventDefault does not stop propagation, so the
 * engines' own canvas-zoom listeners still run unchanged. Safari's
 * proprietary gesture* pinch path gets the same treatment. Keyboard zoom
 * (Cmd/Ctrl-+/−/0) is deliberately untouched (accessibility escape hatch).
 */

/** The slice of Window the guard needs — lets tests pass a stub. */
export interface GuardWindow {
	addEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void
	removeEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void
}

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const

export function installPinchGuard(win: GuardWindow): () => void {
	const onWheel = (e: { ctrlKey: boolean; metaKey: boolean; preventDefault(): void }) => {
		if (e.ctrlKey || e.metaKey) e.preventDefault()
	}
	const onGesture = (e: { preventDefault(): void }) => e.preventDefault()
	const wheelOpts: AddEventListenerOptions = { passive: false, capture: true }
	const gestureOpts: AddEventListenerOptions = { passive: false, capture: true }
	win.addEventListener('wheel', onWheel, wheelOpts)
	for (const t of GESTURE_EVENTS) win.addEventListener(t, onGesture, gestureOpts)
	return () => {
		win.removeEventListener('wheel', onWheel, wheelOpts)
		for (const t of GESTURE_EVENTS) win.removeEventListener(t, onGesture, gestureOpts)
	}
}
