/**
 * A/V feature — LiveKit token minting, kick, participants roster, client pulse.
 */
import express from 'express'
import { AccessToken } from 'livekit-server-sdk'
import { PULSE_STALE_MS } from '../canvas/constants.ts'
import { sanitizeId } from '../canvas/ids.ts'
import { buildParticipants, getCursorRefs, rawUserId } from '../kernel/presence.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { readVmStats } from '../vm-stats.ts'

export function createAvRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	router.get('/api/livekit-token', async (req, res) => {
		if (!ctx.media.apiKey || !ctx.media.apiSecret || !ctx.media.url) {
			res.json({ enabled: false })
			return
		}
		const room = sanitizeId(String(req.query.room ?? ''))
		const identity = String(req.query.identity ?? '').slice(0, 128)
		const name = String(req.query.name ?? 'teammate').slice(0, 64)
		// role=scribe mints a subscribe-only token for the transcriber bot: it
		// hears every track but can never publish audio/video into the room.
		const role = String(req.query.role ?? 'member')
		if (!room || !identity) {
			res.status(400).json({ error: 'room and identity are required' })
			return
		}
		if (role !== 'member' && role !== 'scribe') {
			res.status(400).json({ error: 'role must be member or scribe' })
			return
		}
		const token = new AccessToken(ctx.media.apiKey, ctx.media.apiSecret, {
			identity,
			name,
			ttl: '12h',
		})
		token.addGrant({
			room: `canvas-${room}`,
			roomJoin: true,
			canPublish: role === 'member',
			canSubscribe: true,
		})
		res.json({ enabled: true, token: await token.toJwt(), url: ctx.media.url })
	})

	router.post('/api/kick', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? ''))
		const userId = typeof body.userId === 'string' ? body.userId.slice(0, 128) : ''
		if (!roomId || !userId) {
			return void res.status(400).json({ error: 'room and userId are required' })
		}

		const room = ctx.rooms.rooms.get(roomId)
		const sessionIds = [...(ctx.sessions.sessionsByUser.get(roomId)?.get(userId) ?? [])]
		for (const sessionId of sessionIds) {
			room?.sendCustomMessage(sessionId, { type: 'kicked' })
			room?.closeSession(sessionId, 'PERMISSION_DENIED')
		}

		if (ctx.media.roomService) {
			try {
				await ctx.media.roomService.removeParticipant(`canvas-${roomId}`, userId)
			} catch (error) {
				if (!(error instanceof Error && 'status' in error && error.status === 404)) {
					console.warn(`[room ${roomId}] LiveKit kick failed for ${userId}`, error)
				}
			}
		}

		res.json({ ok: true, disconnected: sessionIds.length })
	})

	// Who is currently in a room — live presence joined with each person's
	// verified Cloudflare Access identity. With ?page= it's filtered to one
	// tldraw page, which is the git co-author rule (same room AND page). The
	// commit tool reads this to build `Co-authored-by` trailers.
	router.get('/api/participants', (req, res) => {
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

	// Session pulse: one heartbeat that carries both features in the "In session"
	// panel. The client measures the round-trip of its *previous* pulse and
	// reports it here (rttMs); the server records it, prunes stale samples, and
	// returns the live per-user latency map plus a single shared VM-pressure
	// reading. One client timer, one endpoint, no extra storage or schema.
	router.post('/api/pulse', (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const userId = typeof body.userId === 'string' ? rawUserId(body.userId.slice(0, 128)) : ''
		const rtt =
			typeof body.rttMs === 'number' && Number.isFinite(body.rttMs) && body.rttMs >= 0
				? Math.min(60_000, Math.round(body.rttMs))
				: null
		const now = Date.now()

		let room = ctx.sessions.latencyByUser.get(roomId)
		if (!room) ctx.sessions.latencyByUser.set(roomId, (room = new Map()))
		if (userId && rtt !== null) room.set(userId, { rtt, t: now })

		const latencies: Record<string, { rtt: number; t: number }> = {}
		for (const [uid, sample] of room) {
			if (now - sample.t > PULSE_STALE_MS) room.delete(uid)
			else latencies[uid] = sample
		}
		if (room.size === 0) ctx.sessions.latencyByUser.delete(roomId)

		res.json({ ok: true, now, vm: readVmStats(now), latencies })
	})

	return router
}
