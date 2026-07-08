/**
 * User-configurable panel settings (canvas-controls spec §3: the footer's
 * settings section, Task 4). Tiny localStorage-backed module store, same
 * useSyncExternalStore pattern as av/bridge.ts and screenshare/store.ts.
 *
 * MUST NOT import 'tldraw' — must stay importable under bare bun test
 * scripts (see av/bridge.ts's header comment for why that matters).
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'ensembleworks.settings.v1'

/** Which screen edge the command bar docks to (canvas-controls spec §4
 * "Docking"). 'bottom' is the v1 default — everything else is a right-click
 * (or panel-footer) opt-in that renders the bar as a vertical, icon-only
 * strip (chrome/CommandBar.tsx). */
export type DockEdge = 'bottom' | 'left' | 'right' | 'top'

const DOCK_EDGES: readonly DockEdge[] = ['bottom', 'left', 'right', 'top']

export interface EnsembleSettings {
	githubHandle: string
	dockEdge: DockEdge
}

const DEFAULT_SETTINGS: EnsembleSettings = {
	githubHandle: '',
	dockEdge: 'bottom',
}

/**
 * Parse a raw localStorage value into settings, defensively: malformed JSON,
 * a missing/non-string field, an unrecognised `dockEdge` string, or a `null`
 * (nothing stored yet) all fall back to defaults rather than throwing.
 * Exported so the test can exercise every shape directly, without needing to
 * reload the module between cases.
 */
export function parseSettings(raw: string | null): EnsembleSettings {
	if (!raw) return { ...DEFAULT_SETTINGS }
	try {
		const parsed = JSON.parse(raw) as { githubHandle?: unknown; dockEdge?: unknown }
		const githubHandle = typeof parsed.githubHandle === 'string' ? parsed.githubHandle.trim() : ''
		const dockEdge =
			typeof parsed.dockEdge === 'string' && (DOCK_EDGES as readonly string[]).includes(parsed.dockEdge)
				? (parsed.dockEdge as DockEdge)
				: DEFAULT_SETTINGS.dockEdge
		return { githubHandle, dockEdge }
	} catch {
		return { ...DEFAULT_SETTINGS }
	}
}

function readFromStorage(): EnsembleSettings {
	try {
		return parseSettings(localStorage.getItem(STORAGE_KEY))
	} catch {
		// localStorage can throw (private mode, disabled storage) — fall back
		// to in-memory defaults; updates below will just not persist either.
		return { ...DEFAULT_SETTINGS }
	}
}

let settings: EnsembleSettings = readFromStorage()
const listeners = new Set<() => void>()

function persist(next: EnsembleSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
	} catch {
		// Same defensive stance as readFromStorage — settings just stay
		// in-memory for this session.
	}
}

/** The current settings, non-reactively. */
export function getSettings(): EnsembleSettings {
	return settings
}

/** Merge `patch` into the settings, persist, and notify subscribers. */
export function updateSettings(patch: Partial<EnsembleSettings>): void {
	settings = { ...settings, ...patch }
	persist(settings)
	for (const listener of listeners) listener()
}

/** Plain (non-React) subscribe seam — the base useSettings builds on. */
export function subscribeSettings(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Reactive read of the current settings for panel components. */
export function useSettings(): EnsembleSettings {
	return useSyncExternalStore(subscribeSettings, getSettings)
}
