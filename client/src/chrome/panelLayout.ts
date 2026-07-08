/**
 * Side panel layout store (canvas-controls spec §3 "Panel states"): the
 * resizable panel's width + collapsed flag, localStorage-persisted per user.
 * Same useSyncExternalStore module-store pattern as settings.ts / av/bridge.ts.
 *
 * MUST NOT import 'tldraw' — must stay importable under bare bun test
 * scripts (see av/bridge.ts's header comment for why that matters).
 *
 * Width clamping is exposed as the pure `clampPanelWidth` so the resize grip
 * (SidePanel.tsx) can share it: the store itself never reads `window` —
 * callers pass a window-derived maxWidth (e.g. a fraction of innerWidth for
 * the spec's "wide = face-to-face past ~40%" ceiling) so this file stays
 * testable headless.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'ensembleworks.panelLayout.v1'

export interface PanelLayout {
	width: number
	collapsed: boolean
}

const DEFAULT_LAYOUT: PanelLayout = {
	width: 280,
	collapsed: false,
}

const MIN_WIDTH = 180
// Hard ceiling on the stored width. Raised well past the old 720 so the panel
// can be dragged to take over the majority of the page for a "video-chat"
// layout (spec §3 "wide = face-to-face", extended): the participant tiles keep
// growing into it (PanelPages' responsive grid). The window-fraction clamp the
// resize grip passes (SidePanel's MAX_WIDTH_FRACTION) is what actually bites on
// normal screens; this cap only guards absurd widths on very large monitors.
const MAX_WIDTH_CAP = 1600

// Collapsed-rail width — consumed by SidePanel's own rail render AND by
// CommandBar's right-dock offset (`panelRightOffset`), so the two stay in
// lockstep instead of two hand-copied `32`s drifting apart.
export const RAIL_WIDTH = 32

// Below this dragged width the grip collapses the panel to the rail (spec §3
// "Panel states": "drag below ~140px (snaps)").
const COLLAPSE_THRESHOLD = 140

/**
 * Clamp a candidate panel width to [180, min(720, maxWidth)]. Pure — no
 * window/localStorage access — so it can be shared by the setter, the
 * defensive parse below, and the resize grip's live drag math.
 */
export function clampPanelWidth(width: number, maxWidth: number = MAX_WIDTH_CAP): number {
	const max = Math.min(MAX_WIDTH_CAP, maxWidth)
	return Math.min(Math.max(width, MIN_WIDTH), max)
}

/**
 * What a single pointermove of the resize grip should do for a dragged width:
 *
 * - `< 140`     → 'collapse' — snap to the rail (setPanelCollapsed(true) only)
 * - `140 – 179` → 'ignore'   — dead band; deliberately NO store write, because
 *                  a setPanelWidth here would let clampPanelWidth's 180 floor
 *                  overwrite the remembered width on the way into a collapse
 *                  (drag from 400px into the rail must re-expand to 400, not 180)
 * - `≥ 180`     → 'resize'   — write the width (and re-expand if collapsed)
 *
 * Pure, so the collapse/dead-band/resize hysteresis is pinned by bare-bun
 * tests instead of living implicitly in the grip's event handler.
 */
export function panelDragAction(width: number): 'collapse' | 'resize' | 'ignore' {
	if (width < COLLAPSE_THRESHOLD) return 'collapse'
	if (width < MIN_WIDTH) return 'ignore'
	return 'resize'
}

/**
 * Parse a raw localStorage value into a PanelLayout, defensively: malformed
 * JSON, a missing/wrong-typed field, or a `null` (nothing stored yet) all
 * fall back to defaults rather than throwing. Exported so the test can
 * exercise every shape directly, without needing to reload the module
 * between cases.
 */
export function parsePanelLayout(raw: string | null): PanelLayout {
	if (!raw) return { ...DEFAULT_LAYOUT }
	try {
		const parsed = JSON.parse(raw) as { width?: unknown; collapsed?: unknown }
		const width =
			typeof parsed.width === 'number' && Number.isFinite(parsed.width)
				? clampPanelWidth(parsed.width)
				: DEFAULT_LAYOUT.width
		const collapsed = typeof parsed.collapsed === 'boolean' ? parsed.collapsed : DEFAULT_LAYOUT.collapsed
		return { width, collapsed }
	} catch {
		return { ...DEFAULT_LAYOUT }
	}
}

function readFromStorage(): PanelLayout {
	try {
		return parsePanelLayout(localStorage.getItem(STORAGE_KEY))
	} catch {
		// localStorage can throw (private mode, disabled storage) — fall back
		// to in-memory defaults; updates below will just not persist either.
		return { ...DEFAULT_LAYOUT }
	}
}

let layout: PanelLayout = readFromStorage()
const listeners = new Set<() => void>()

function persist(next: PanelLayout): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
	} catch {
		// Same defensive stance as readFromStorage — layout just stays
		// in-memory for this session.
	}
}

/** The current layout, non-reactively. */
export function getPanelLayout(): PanelLayout {
	return layout
}

function update(patch: Partial<PanelLayout>): void {
	layout = { ...layout, ...patch }
	persist(layout)
	for (const listener of listeners) listener()
}

/** Set the panel width, clamped to [180, min(720, maxWidth)] if given. */
export function setPanelWidth(width: number, maxWidth?: number): void {
	update({ width: clampPanelWidth(width, maxWidth) })
}

/** Set the collapsed (rail) flag directly. */
export function setPanelCollapsed(collapsed: boolean): void {
	update({ collapsed })
}

/** Flip the collapsed flag. */
export function togglePanelCollapsed(): void {
	update({ collapsed: !layout.collapsed })
}

/** Plain (non-React) subscribe seam — the base usePanelLayout builds on. */
export function subscribePanelLayout(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Reactive read of the current panel layout for panel components. */
export function usePanelLayout(): PanelLayout {
	return useSyncExternalStore(subscribePanelLayout, getPanelLayout)
}
