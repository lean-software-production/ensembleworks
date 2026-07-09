/**
 * Frames-drawer store (frame navigation): whether the current page's Frames
 * drawer is pinned open — localStorage-persisted per user — plus a transient
 * hover-peek flag. Same useSyncExternalStore module-store pattern as
 * panelLayout.ts / settings.ts.
 *
 * MUST NOT import 'tldraw' — must stay importable under bare bun test scripts
 * (see panelLayout.ts's header for why that matters).
 *
 * Only `pinned` is persisted (a durable per-user preference). `peeking` is a
 * transient hover flag that must NEVER hit localStorage — it flips on every
 * mouse-over, and persisting it would both thrash storage and wrongly restore a
 * "hovered" drawer on reload.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'ensembleworks.framesDrawer.v1'

export interface FramesDrawerState {
	/** Drawer locked open — the persisted preference. */
	pinned: boolean
	/** Drawer shown because the caret or drawer is hovered — transient. */
	peeking: boolean
}

const DEFAULT_STATE: FramesDrawerState = { pinned: false, peeking: false }

/**
 * Parse the persisted `pinned` flag defensively: malformed JSON, a missing or
 * wrong-typed field, or a `null` (nothing stored yet) all fall back to false
 * rather than throwing. Exported so the test can exercise every raw shape.
 */
export function parseFramesDrawerPinned(raw: string | null): boolean {
	if (!raw) return false
	try {
		const parsed = JSON.parse(raw) as { pinned?: unknown }
		return typeof parsed.pinned === 'boolean' ? parsed.pinned : false
	} catch {
		return false
	}
}

function readPinnedFromStorage(): boolean {
	try {
		return parseFramesDrawerPinned(localStorage.getItem(STORAGE_KEY))
	} catch {
		// localStorage can throw (private mode, disabled storage) — start unpinned.
		return false
	}
}

// peeking always starts at its default (false): hover state is a live pointer
// property, never something to restore from a previous session.
let state: FramesDrawerState = { pinned: readPinnedFromStorage(), peeking: DEFAULT_STATE.peeking }
const listeners = new Set<() => void>()

function persistPinned(pinned: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ pinned }))
	} catch {
		// Same defensive stance as readPinnedFromStorage — stay in-memory.
	}
}

function commit(patch: Partial<FramesDrawerState>, persist: boolean): void {
	state = { ...state, ...patch }
	if (persist) persistPinned(state.pinned)
	for (const listener of listeners) listener()
}

/** The current drawer state, non-reactively. */
export function getFramesDrawer(): FramesDrawerState {
	return state
}

/** Lock/unlock the drawer open (persisted). */
export function setPinned(pinned: boolean): void {
	commit({ pinned }, true)
}

/** Flip the pinned flag (persisted) — the caret click and the keyboard toggle. */
export function togglePinned(): void {
	commit({ pinned: !state.pinned }, true)
}

/** Set the transient hover-peek flag (never persisted). */
export function setPeeking(peeking: boolean): void {
	commit({ peeking }, false)
}

// Hover-peek coordination shared by the caret (PanelPages) and the drawer
// (FramesDrawer): they sit flush edge-to-edge, so moving the pointer from the
// caret into the drawer briefly touches neither. A short close grace bridges
// that gap — peekOpen() cancels any pending close so the drawer never flickers
// shut mid-crossing.
const PEEK_CLOSE_GRACE_MS = 140
let closeTimer: ReturnType<typeof setTimeout> | null = null

/** Open the peek immediately and cancel any pending close. */
export function peekOpen(): void {
	if (closeTimer !== null) {
		clearTimeout(closeTimer)
		closeTimer = null
	}
	if (!state.peeking) setPeeking(true)
}

/** Close the peek after a short grace, so crossing the caret→drawer gap doesn't flicker. */
export function peekCloseSoon(): void {
	if (closeTimer !== null) clearTimeout(closeTimer)
	closeTimer = setTimeout(() => {
		closeTimer = null
		setPeeking(false)
	}, PEEK_CLOSE_GRACE_MS)
}

/** Plain (non-React) subscribe seam — the base usePanelLayout analogue. */
export function subscribeFramesDrawer(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Reactive read of the drawer state for panel components. */
export function useFramesDrawer(): FramesDrawerState {
	return useSyncExternalStore(subscribeFramesDrawer, getFramesDrawer)
}
