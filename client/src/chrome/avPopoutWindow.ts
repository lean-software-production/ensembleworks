/**
 * The effectful half of pop-out A/V: acquiring, styling and tracking the child
 * window that chrome/avPopout.ts's PURE lifecycle drives. Split out so
 * avPopout.ts stays DOM-free and bun-testable; this file owns the DOM/window
 * side and is never imported by a test.
 *
 * Acquisition prefers Document Picture-in-Picture — the browser API built for
 * exactly this (a companion window for call video) and, decisively, the one
 * livekit-client's adaptiveStream explicitly keeps streaming into (see its
 * isElementInPiP): a plain window.open child-window <video> is judged
 * off-screen by LiveKit's opener-rooted IntersectionObserver and gets paused to
 * a black frame, whereas a PiP window's tiles keep their live video. window.open
 * is the universal fallback where Document PiP isn't available (Firefox/Safari);
 * the tiles still show there, video quality permitting.
 *
 * Both must be acquired inside the click's user gesture (Document PiP requires
 * transient activation), so the panel button calls openAvPopout() DIRECTLY —
 * this is imperative, not an effect. The window itself is exposed through a tiny
 * useSyncExternalStore so AvPopoutHost can portal into it reactively.
 */
import { useSyncExternalStore } from 'react'
import { wm } from '../theme'
import {
	dockAv,
	getPopoutState,
	notifyPopoutClosed,
	POPOUT_HEIGHT,
	POPOUT_WIDTH,
	popOutAv,
	popoutWindowFeatures,
} from './avPopout'

// Minimal local typing for the experimental Document Picture-in-Picture API —
// not in TypeScript's DOM lib yet. Only the members we touch.
declare global {
	interface Window {
		documentPictureInPicture?: {
			requestWindow(options?: { width?: number; height?: number }): Promise<Window>
			readonly window: Window | null
		}
	}
}

const POPOUT_NAME = 'ew-av-popout'
const POPOUT_TITLE = 'EnsembleWorks — A/V'

// --- live-window store: the portal target AvPopoutHost renders into ---
let popoutWindow: Window | null = null
const listeners = new Set<() => void>()
function emit(): void {
	for (const listener of listeners) listener()
}

/** The live child window, or null when docked. */
export function getPopoutWindow(): Window | null {
	return popoutWindow
}
/** Plain (non-React) subscribe seam — the base usePopoutWindow builds on. */
export function subscribePopoutWindow(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
/** Reactive read of the live child window for the host. */
export function usePopoutWindow(): Window | null {
	return useSyncExternalStore(subscribePopoutWindow, getPopoutWindow)
}

async function acquireWindow(): Promise<Window | null> {
	const dpip = window.documentPictureInPicture
	if (dpip) {
		try {
			return await dpip.requestWindow({ width: POPOUT_WIDTH, height: POPOUT_HEIGHT })
		} catch {
			// Gesture consumed / blocked / user-disabled — fall through to window.open.
		}
	}
	return window.open('', POPOUT_NAME, popoutWindowFeatures())
}

// Turn the blank child window into a paper-styled shell matching the panel. The
// tiles are fully inline-styled, so the opener's stylesheets only add the brand
// typeface — nice-to-have, hence the try/catch.
function prepareChildDocument(child: Window): void {
	const doc = child.document
	doc.title = POPOUT_TITLE
	try {
		for (const el of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
			if (el instanceof HTMLLinkElement) {
				const link = doc.createElement('link')
				link.rel = 'stylesheet'
				link.href = el.href // the DOM property is absolute — safe against the child's about:blank base
				doc.head.appendChild(link)
			} else {
				const style = doc.createElement('style')
				style.textContent = el.textContent
				doc.head.appendChild(style)
			}
		}
	} catch {
		// Fidelity-only; the inline-styled tiles render fine on the fallback font.
	}
	const body = doc.body
	body.style.margin = '0'
	body.style.background = wm.panel
	body.style.color = wm.ink
	body.style.fontFamily = wm.sans
	body.style.setProperty('color-scheme', 'light')
}

// Re-entrancy guard: openAvPopout awaits window acquisition, during which the
// pure state is still 'docked', so a second click could otherwise open a second
// window before popOutAv() lands.
let opening = false

/**
 * Pop the video tiles out into the child window. MUST be called inside a user
 * gesture (Document PiP requires transient activation). No-op if already popped
 * or mid-open; if the browser blocks the window we simply stay docked.
 */
export async function openAvPopout(): Promise<void> {
	if (opening || getPopoutState() === 'popped') return
	opening = true
	try {
		const win = await acquireWindow()
		if (!win) return
		prepareChildDocument(win)
		popoutWindow = win
		emit()
		popOutAv()
	} finally {
		opening = false
	}
}

/**
 * Bring the tiles back (panel placeholder or the child window's own button).
 * Clears the window ref and docks; AvPopoutHost's effect cleanup does the
 * actual window.close() AFTER React has unmounted the portal, so the tiles
 * detach from a live document rather than a torn-down one.
 */
export function closeAvPopout(): void {
	if (!popoutWindow) return
	popoutWindow = null
	emit()
	dockAv()
}

/**
 * The child window went away on its own (OS close button). Same as
 * closeAvPopout but via the self-heal event — clear the ref and dock.
 */
export function handlePopoutWindowClosed(): void {
	if (!popoutWindow) return
	popoutWindow = null
	emit()
	notifyPopoutClosed()
}
