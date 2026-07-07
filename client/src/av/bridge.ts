/**
 * Bridge between AvOverlay (inside tldraw, owns the LiveKit connection,
 * spatial loop and leashes) and the side panel (an App-level flex sibling
 * outside tldraw context). Same module-store pattern as screenshare/store.ts.
 *
 * MUST NOT import 'tldraw' or runtime 'livekit-client' — the tldraw module
 * graph hangs bun on exit (verified Phase 1), so bare-bun test scripts need
 * this module importable standalone. Type-only livekit imports are fine.
 */
import { useSyncExternalStore } from 'react'
import type { LocalTrack, RemoteTrack } from 'livekit-client'
import type { LatencySample, VmStats } from './useSessionPulse'

export interface AvPanelPeer {
	id: string // raw user id
	name: string
	videoTrack: RemoteTrack | null
	isSpeaking: boolean
}

export interface AvPanelSnapshot {
	status: string
	micEnabled: boolean
	camEnabled: boolean
	standupMode: boolean
	localVideoTrack: LocalTrack | null
	localSpeaking: boolean
	peers: AvPanelPeer[]
	scribes: { id: string; name: string }[]
	vm: VmStats | null
	latencies: Record<string, LatencySample>
	latencyHistory: Record<string, number[]>
	kickingId: string | null
	kickError: string | null
	actions: {
		onMic: () => void
		onCam: () => void
		onStandup: () => void
		kick: (id: string, name: string) => void
	}
}

// --- A/V snapshot store ------------------------------------------------

let snapshot: AvPanelSnapshot | null = null
const snapshotListeners = new Set<() => void>()

/** Published by AvOverlay on every relevant state change; null while it's unmounted. */
export function publishAvSnapshot(snap: AvPanelSnapshot | null): void {
	snapshot = snap
	for (const listener of snapshotListeners) listener()
}

/** The last published snapshot, non-reactively (null before first publish). */
export function getAvSnapshot(): AvPanelSnapshot | null {
	return snapshot
}

/** Plain (non-React) subscribe seam — the base useAvSnapshot builds on. */
export function subscribeAvSnapshot(listener: () => void): () => void {
	snapshotListeners.add(listener)
	return () => snapshotListeners.delete(listener)
}

/** Reactive read of the current A/V snapshot for panel components. */
export function useAvSnapshot(): AvPanelSnapshot | null {
	return useSyncExternalStore(subscribeAvSnapshot, getAvSnapshot)
}

// --- Face-element registry ---------------------------------------------
// DOM reads are pull-based (leash geometry is recomputed on every animation
// tick), so registration is a plain Map with no notify.

const faceEls = new Map<string, HTMLElement>()

/** Registered by a panel tile on mount/unmount (pass null on unmount/cleanup). */
export function registerFaceEl(id: string, el: HTMLElement | null): void {
	if (el) faceEls.set(id, el)
	else faceEls.delete(id)
}

/** The tile's live DOM element for a raw user id, or null if unregistered. */
export function getFaceEl(id: string): HTMLElement | null {
	return faceEls.get(id) ?? null
}

// --- Hovered face -------------------------------------------------------

let hoveredFace: string | null = null
const hoveredListeners = new Set<() => void>()

export function setHoveredFace(id: string | null): void {
	hoveredFace = id
	for (const listener of hoveredListeners) listener()
}

export function getHoveredFace(): string | null {
	return hoveredFace
}

/** Plain (non-React) subscribe seam — the base useHoveredFace builds on. */
export function subscribeHoveredFace(listener: () => void): () => void {
	hoveredListeners.add(listener)
	return () => hoveredListeners.delete(listener)
}

/** Reactive read of the currently hovered face's raw user id. */
export function useHoveredFace(): string | null {
	return useSyncExternalStore(subscribeHoveredFace, getHoveredFace)
}
