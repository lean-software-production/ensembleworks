/**
 * Pure resolution from a screenshare shape's synced props (participantId +
 * trackName) to the track a viewer should attach — or a placeholder state.
 * Duck-typed against the LiveKit Room (no livekit-client import) so it
 * unit-tests in plain node; store.ts adapts the real Room to RoomLike.
 *
 * Tracks are matched by NAME across a participant's full publication list —
 * never LiveKit's source-keyed getter, which assumes a single screen share
 * per participant (a rule the design spec is explicit about).
 */
export interface AttachableTrack {
	attach(): HTMLMediaElement
	detach(element: HTMLMediaElement): HTMLMediaElement
}

export interface PublicationLike {
	trackName: string
	track?: AttachableTrack
}

export interface ParticipantLike {
	identity: string
	getTrackPublications(): PublicationLike[]
}

export interface RoomLike {
	localParticipant: ParticipantLike
	remoteParticipants: Map<string, ParticipantLike>
}

export type ScreenTrackState =
	| { kind: 'connecting' }
	| { kind: 'ended' }
	| { kind: 'live'; track: AttachableTrack }

export function resolveScreenTrack(
	room: RoomLike | null,
	participantId: string,
	trackName: string
): ScreenTrackState {
	// No room: A/V is still connecting (or disabled) — show the placeholder
	// rather than a tombstone, since the share may be perfectly alive.
	if (!room) return { kind: 'connecting' }
	const findByName = (p: ParticipantLike) =>
		p.getTrackPublications().find((pub) => pub.trackName === trackName)
	if (room.localParticipant.identity === participantId) {
		// My own share: the local track is the self-preview. No publication
		// under this name means I unpublished it → the tile is a tombstone.
		const pub = findByName(room.localParticipant)
		return pub?.track ? { kind: 'live', track: pub.track } : { kind: 'ended' }
	}
	const participant = room.remoteParticipants.get(participantId)
	if (!participant) return { kind: 'ended' }
	const pub = findByName(participant)
	if (!pub) return { kind: 'ended' }
	// Published but not subscribed yet (out of viewport, or in flight).
	return pub.track ? { kind: 'live', track: pub.track } : { kind: 'connecting' }
}
