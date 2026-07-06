/**
 * Kernel participants route: GET /api/participants — live presence joined with
 * captured Cloudflare Access identities. Kernel-reserved (unprefixed): it reads
 * presence, not any plugin's state. Moved off the av router in sub-project 3a.
 */
import { kernelParticipants } from '@ensembleworks/contracts'
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { buildParticipants, getCursorRefs } from '../kernel/presence.ts'

export function createParticipantsRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()
	router.get(kernelParticipants.http.path, (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const page = req.query.page ? String(req.query.page) : null
		const room = ctx.rooms.rooms.get(roomId)
		const refs = room && !room.isClosed() ? getCursorRefs(room) : []
		res.json({
			room: roomId,
			page,
			participants: buildParticipants(refs, ctx.sessions.identitiesByUser.get(roomId), page),
		})
	})
	return router
}
