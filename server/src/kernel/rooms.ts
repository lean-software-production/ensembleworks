/**
 * RoomHost — owns the TLSocketRoom registry and SQLite-backed room loading.
 * The one place that constructs rooms; every feature router reaches rooms
 * through this. (Moved from app.ts's closure: rooms map + getOrCreateRoom.)
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { sanitizeId } from '../canvas/ids.ts'
import { schema } from '../schema.ts'

export interface RoomHost {
	rooms: ReadonlyMap<string, TLSocketRoom>
	getOrCreateRoom(roomId: string): TLSocketRoom
	/**
	 * Every room that exists: the `*.sqlite` basenames in the rooms directory
	 * unioned with the rooms currently open in memory (a room opened this
	 * process may not have flushed yet; a room on disk may never have been
	 * opened this boot). Ids are filtered through sanitizeId — a stray or
	 * hostile filename can never reach a caller — de-duplicated, sorted.
	 */
	listRoomIds(): string[]
}

export function createRoomHost(roomsDir: string): RoomHost {
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

	function listRoomIds(): string[] {
		const ids = new Set<string>()
		if (existsSync(roomsDir)) {
			for (const entry of readdirSync(roomsDir)) {
				if (!entry.endsWith('.sqlite')) continue
				ids.add(entry.slice(0, -'.sqlite'.length))
			}
		}
		for (const roomId of rooms.keys()) ids.add(roomId)
		const valid: string[] = []
		for (const id of ids) {
			if (sanitizeId(id)) valid.push(id)
		}
		return valid.sort()
	}

	return { rooms, getOrCreateRoom, listRoomIds }
}
