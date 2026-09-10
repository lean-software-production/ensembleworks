/**
 * Kernel rooms route: GET /api/rooms — every room that exists (RoomHost owns
 * the on-disk enumeration), joined against live presence. Kernel-reserved
 * (unprefixed): it reads the room registry and presence, not any plugin's
 * state. See docs/superpowers/specs/2026-09-10-room-switcher-design.md §3.1.
 */
import { kernelRooms } from '@ensembleworks/contracts'
import express from 'express'
import type { PluginServerContext } from '../kernel/context.ts'
import { buildParticipants, getCursorRefs } from '../kernel/presence.ts'

export function createRoomsRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()
	router.get(kernelRooms.http.path, (_req, res) => {
		const rooms = ctx.rooms.listRoomIds().map((id) => {
			const room = ctx.rooms.rooms.get(id)
			const refs = room && !room.isClosed() ? getCursorRefs(room) : []
			// buildParticipants(...).length, not refs.length: it de-duplicates by
			// raw user id, so a teammate with two tabs open counts once.
			return {
				id,
				participants: buildParticipants(refs, ctx.sessions.identitiesByUser.get(id)).length,
			}
		})
		res.json({ rooms })
	})
	return router
}
