/**
 * RoomHost — owns the TLSocketRoom registry and SQLite-backed room loading.
 * The one place that constructs rooms; every feature router reaches rooms
 * through this. (Moved from app.ts's closure: rooms map + getOrCreateRoom.)
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { schema } from '../schema.ts'

export interface RoomHost {
	rooms: ReadonlyMap<string, TLSocketRoom>
	getOrCreateRoom(roomId: string): TLSocketRoom
}

export function createRoomHost(dataDir: string): RoomHost {
	const roomsDir = path.join(dataDir, 'rooms')
	mkdirSync(roomsDir, { recursive: true })

	// -------------------------------------------------------------------------
	// Rooms: one TLSocketRoom per room ID, persisted via SQLite. Storage commits
	// transactionally on every change, so there is no debounced-save dance and
	// the room survives process restarts (M0 exit criterion).
	// -------------------------------------------------------------------------

	const rooms = new Map<string, TLSocketRoom>()

	function getOrCreateRoom(roomId: string): TLSocketRoom {
		let room = rooms.get(roomId)
		if (room && !room.isClosed()) return room
		const db = new DatabaseSync(path.join(roomsDir, `${roomId}.sqlite`))
		const storage = new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db) })
		room = new TLSocketRoom({
			storage,
			schema,
			log: {
				warn: (...args) => console.warn(`[room ${roomId}]`, ...args),
				error: (...args) => console.error(`[room ${roomId}]`, ...args),
			},
		})
		rooms.set(roomId, room)
		console.log(`[room ${roomId}] opened`)
		return room
	}

	return { rooms, getOrCreateRoom }
}
