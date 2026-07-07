import { DisconnectReason } from 'livekit-client'

/**
 * Whether a LiveKit `Disconnected` end should trigger a from-scratch re-join.
 *
 * Fatal ends are the ones where re-joining would fight the server: a duplicate
 * identity (another tab took the slot), an explicit kick (`/api/av/kick` →
 * PARTICIPANT_REMOVED), or the room being deleted. Everything else — network
 * loss, signal timeout, server restart/shutdown, token rejection, or no reason
 * at all — is transient and retried (see spec §1).
 */
export function classifyDisconnect(reason: DisconnectReason | undefined): 'retry' | 'fatal' {
	switch (reason) {
		case DisconnectReason.DUPLICATE_IDENTITY:
		case DisconnectReason.PARTICIPANT_REMOVED:
		case DisconnectReason.ROOM_DELETED:
			return 'fatal'
		default:
			return 'retry'
	}
}
