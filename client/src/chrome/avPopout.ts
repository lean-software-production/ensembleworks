/**
 * Pop-out-the-A/V lifecycle (product ask: run the canvas full-screen on one
 * monitor, the camera/video tiles in a separate window on the laptop, so you
 * look toward the laptop camera while talking).
 *
 * The hard constraint is ONE meeting on ONE connection — you must not show up
 * to peers as a duplicate person. So the pop-out is NOT a second page load:
 * AvPopoutHost.tsx opens a same-origin child window and React-portals the same
 * tiles into it, all running in this one tab's JS context. That means the
 * single LiveKit Room (av/useLiveKitRoom.ts) and the single tldraw presence
 * connection are untouched — the child window is purely a second VIEW of the
 * same session's video, never a second participant.
 *
 * This file is the pure lifecycle + the module store the panel, the host and
 * the pop-out view all read. It deliberately holds only 'docked' | 'popped':
 * the feature is pop-out and bring-back, nothing more (no resize memory, no
 * persistence across reload, no multi-monitor placement — see
 * popoutWindowFeatures). Same useSyncExternalStore module-store pattern as
 * panelLayout.ts / av/bridge.ts, and — like them — it MUST NOT import 'tldraw'
 * so it stays importable under bare-bun test scripts.
 */
import { useSyncExternalStore } from 'react'

/** Where the video tiles currently live: in the side panel, or in the
 * popped-out child window. */
export type PopoutState = 'docked' | 'popped'

/**
 * The lifecycle's three inputs:
 *   pop-out       — the user asked to pop the A/V out.
 *   bring-back    — the user asked to dock it again (panel placeholder or the
 *                   child window's own button).
 *   window-closed — the child window went away on its own (OS close button, or
 *                   the browser blocking window.open); we self-heal to docked
 *                   so the tiles reappear in the panel with no orphan state.
 */
export type PopoutEvent = 'pop-out' | 'bring-back' | 'window-closed'

// Fixed pop-out window size. A portrait-ish panel suits a stack of 4:3 camera
// tiles on the side of a laptop screen. Intentionally the whole story on
// geometry: no left/top (the browser places it; multi-monitor placement is out
// of scope) and no persisted size (no resize memory).
export const POPOUT_WIDTH = 360
export const POPOUT_HEIGHT = 640

/** The pure lifecycle transition. Every event is idempotent from its terminal
 * state, so a redundant pop-out / bring-back and a stale window-closed are all
 * safe no-ops rather than surprises. */
export function nextPopoutState(state: PopoutState, event: PopoutEvent): PopoutState {
	switch (event) {
		case 'pop-out':
			return 'popped'
		case 'bring-back':
		case 'window-closed':
			return 'docked'
	}
}

/** The window.open feature string: size and the minimal-chrome `popup` hint,
 * and deliberately nothing else — no placement to keep the tight scope (no
 * multi-monitor logic), no persisted geometry (no resize memory). */
export function popoutWindowFeatures(width: number = POPOUT_WIDTH, height: number = POPOUT_HEIGHT): string {
	return `popup=yes,width=${width},height=${height}`
}

// --- module store ------------------------------------------------------

let state: PopoutState = 'docked'
const listeners = new Set<() => void>()

/** The current pop-out state, non-reactively. */
export function getPopoutState(): PopoutState {
	return state
}

/** Run the pure transition and notify ONLY on a genuine change, so redundant
 * verbs (e.g. pop-out while already popped) don't wake subscribers. */
function dispatch(event: PopoutEvent): void {
	const next = nextPopoutState(state, event)
	if (next === state) return
	state = next
	for (const listener of listeners) listener()
}

/** Pop the video tiles out into the child window. */
export function popOutAv(): void {
	dispatch('pop-out')
}

/** Bring the video tiles back into the side panel. */
export function dockAv(): void {
	dispatch('bring-back')
}

/** The child window closed on its own — self-heal to docked. */
export function notifyPopoutClosed(): void {
	dispatch('window-closed')
}

/** Plain (non-React) subscribe seam — the base usePopoutState builds on. */
export function subscribePopoutState(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Reactive read of the current pop-out state for panel / host components. */
export function usePopoutState(): PopoutState {
	return useSyncExternalStore(subscribePopoutState, getPopoutState)
}
