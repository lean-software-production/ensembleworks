/**
 * Attach a /sync WebSocket to its room, guarding the synchronous room load.
 *
 * getOrCreateRoom opens the room's SQLite; a corrupt or schema-incompatible file
 * throws here. Without this guard that throw is uncaught inside the WS upgrade
 * callback and takes down the whole sync process — and since clients auto-
 * reconnect, it crash-loops for everyone. Instead: log and close just the one
 * socket (1011 = internal error), leaving every other room untouched.
 */
import type { WebSocket } from 'ws'
import type { RoomHost } from './kernel/rooms.ts'

export function attachSyncSocket(
	roomHost: Pick<RoomHost, 'getOrCreateRoom'>,
	ws: Pick<WebSocket, 'close' | 'terminate'>,
	roomId: string,
	sessionId: string
): boolean {
	try {
		roomHost.getOrCreateRoom(roomId).handleSocketConnect({ sessionId, socket: ws as WebSocket })
		return true
	} catch (err) {
		console.error(`[sync] room ${roomId} failed to attach — closing socket:`, err)
		try {
			ws.close(1011, 'room load failed')
		} catch {
			ws.terminate()
		}
		return false
	}
}
