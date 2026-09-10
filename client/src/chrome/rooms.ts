/**
 * Room-switcher shaping: a `GET /api/rooms` payload turned into render rows.
 *
 * Every decision the popover makes lives here — defensive narrowing of the
 * fetch result, current-room marking, and the zero-count omission — so that
 * RoomSwitcher.tsx stays a renderer with no logic of its own.
 *
 * MUST NOT import React, tldraw, or touch the DOM: this module has a
 * `.test.ts` beside it and the harness (`scripts/run-tests.ts`) spawns it
 * under bare `bun` — no DOM, no bundler, no JSX transform.
 */

export interface RoomSummary {
	id: string
	participants: number
}

export interface RoomRow {
	id: string
	participants: number
	isCurrent: boolean
	/** Right-hand count, or null when the room is empty — a zero renders nothing. */
	countLabel: string | null
}

/**
 * The server sorts alphabetically so every client agrees; we deliberately
 * preserve that order rather than re-sorting here.
 */
export function toRoomRows(rooms: readonly RoomSummary[], currentRoomId: string): RoomRow[] {
	return rooms.map((room) => ({
		id: room.id,
		participants: room.participants,
		isCurrent: room.id === currentRoomId,
		countLabel: room.participants > 0 ? String(room.participants) : null,
	}))
}

/** Narrow an unknown fetch body to room summaries, dropping anything malformed. */
export function parseRoomsPayload(raw: unknown): RoomSummary[] {
	if (typeof raw !== 'object' || raw === null) return []
	const rooms = (raw as { rooms?: unknown }).rooms
	if (!Array.isArray(rooms)) return []
	const out: RoomSummary[] = []
	for (const entry of rooms) {
		if (typeof entry !== 'object' || entry === null) continue
		const { id, participants } = entry as { id?: unknown; participants?: unknown }
		if (typeof id !== 'string') continue
		if (typeof participants !== 'number' || !Number.isFinite(participants)) continue
		out.push({ id, participants })
	}
	return out
}
