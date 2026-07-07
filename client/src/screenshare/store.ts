/**
 * Module-level registry connecting the LiveKit Room to screen-share consumers
 * that can't receive it through React context: the toolbar tool (a closure in
 * uiOverrides, outside any component) and shape components (rendered deep in
 * tldraw's tree, far from AvOverlay where useLiveKitRoom lives). AvOverlay's
 * useLiveKitRoom registers the room here on connect and clears it on cleanup.
 */
import { Room, RoomEvent } from 'livekit-client'
import { useMemo, useSyncExternalStore } from 'react'
import { type RoomLike, type ScreenTrackState, resolveScreenTrack } from './resolve'

let room: Room | null = null
let version = 0
const listeners = new Set<() => void>()

const bump = () => {
	version += 1
	for (const listener of listeners) listener()
}

// Every event that can change what resolveScreenTrack returns for some shape.
const ROOM_EVENTS = [
	RoomEvent.TrackPublished,
	RoomEvent.TrackUnpublished,
	RoomEvent.TrackSubscribed,
	RoomEvent.TrackUnsubscribed,
	RoomEvent.LocalTrackPublished,
	RoomEvent.LocalTrackUnpublished,
	RoomEvent.ParticipantConnected,
	RoomEvent.ParticipantDisconnected,
] as const

export function setScreenShareRoom(next: Room | null): void {
	if (room === next) return
	if (room) for (const ev of ROOM_EVENTS) room.off(ev, bump)
	room = next
	if (room) for (const ev of ROOM_EVENTS) room.on(ev, bump)
	// Debug/e2e hook: lets a headless probe (and a human console) inspect
	// per-publication subscription state. Harmless in production.
	;(window as { __ewScreenShareRoom?: Room | null }).__ewScreenShareRoom = next
	bump()
}

export function getScreenShareRoom(): Room | null {
	return room
}

function subscribeStore(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function getVersion(): number {
	return version
}

/**
 * The track (or placeholder state) a shape component should render for its
 * synced (participantId, trackName) props. The returned `track` object is
 * stable across re-renders while the underlying publication doesn't change,
 * so components can key attach/detach effects on it directly.
 */
export function useScreenShareTrack(participantId: string, trackName: string): ScreenTrackState {
	const v = useSyncExternalStore(subscribeStore, getVersion)
	return useMemo(
		// Room structurally satisfies RoomLike (identity, getTrackPublications,
		// remoteParticipants map); the cast keeps resolve.ts livekit-free.
		() => resolveScreenTrack(room as unknown as RoomLike | null, participantId, trackName),
		[v, participantId, trackName]
	)
}

/** Sharing is offered only when A/V is up and this participant may publish
 * (the scribe role is subscribe-only). */
export function useScreenShareAvailable(): boolean {
	// Subscribed purely for the re-render on room events; the value is unused.
	useSyncExternalStore(subscribeStore, getVersion)
	return room != null && room.localParticipant.permissions?.canPublish !== false
}

/** Non-reactive twin of useScreenShareAvailable, for keyboard handlers. */
export function isScreenShareAvailable(): boolean {
	return room != null && room.localParticipant.permissions?.canPublish !== false
}

/** The registered LiveKit room, reactively (null while A/V is down). */
export function useScreenShareRoom(): Room | null {
	useSyncExternalStore(subscribeStore, getVersion)
	return room
}
