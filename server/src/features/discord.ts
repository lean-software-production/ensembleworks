/**
 * Discord bindings feature — CRUD over /api/discord/bindings. A binding maps a
 * Discord channel to a canvas room + route (inbound: Discord → canvas, or
 * outbound: canvas → Discord). Bindings live in the global discord store; this
 * router just validates input, stamps the caller, and hands off to the store.
 */
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { resolveCaller } from '../whoami.ts'

export function createDiscordRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// GET /api/discord/bindings?room=<room> — every binding for a room.
	router.get('/api/discord/bindings', async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		res.json({ ok: true, bindings: await ctx.storage.discord.listByRoom(roomId) })
	})

	// POST /api/discord/bindings — create a binding. All-or-nothing validation of
	// room/guildId/channelId/direction/route before it reaches the store.
	router.post('/api/discord/bindings', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>

		const roomId = sanitizeId(String(body.room ?? ''))
		if (!roomId) return void res.status(400).json({ error: 'room' })

		const guildId = body.guildId
		if (typeof guildId !== 'string' || !guildId || guildId.length > 64) return void res.status(400).json({ error: 'guildId' })

		const channelId = body.channelId
		if (typeof channelId !== 'string' || !channelId || channelId.length > 64) return void res.status(400).json({ error: 'channelId' })

		const direction = body.direction
		if (direction !== 'in' && direction !== 'out') return void res.status(400).json({ error: 'direction' })

		const route = body.route
		if (typeof route !== 'object' || route === null || Array.isArray(route)) return void res.status(400).json({ error: 'route' })
		const handler = (route as Record<string, unknown>).handler
		if (typeof handler !== 'string' || !handler || handler.length > 64) return void res.status(400).json({ error: 'route.handler' })
		const rawParams = (route as Record<string, unknown>).params ?? {}
		if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) return void res.status(400).json({ error: 'route.params' })
		const params = rawParams as Record<string, unknown>

		// Attribution: stamp the caller's identity (null/anonymous callers → 'anonymous').
		const caller = await resolveCaller(req.headers)
		const createdBy = caller.identity || 'anonymous'

		const binding = await ctx.storage.discord.create({
			room: roomId,
			guildId,
			channelId,
			direction,
			route: { handler, params },
			createdBy,
		})
		res.json({ ok: true, id: binding.id, binding })
	})

	// POST /api/discord/post — the server → bot mediator. The client triggers an
	// outbound post; we resolve the room's outbound bindings and forward each to
	// the bot's loopback /post (the only process holding the Discord token). Best
	// effort: a bot outage never 500s the caller — we log and report delivered:0.
	router.post('/api/discord/post', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>

		const roomId = sanitizeId(String(body.room ?? ''))
		if (!roomId) return void res.status(400).json({ error: 'room' })

		const kind = body.kind
		if (kind !== 'summary' && kind !== 'action-items' && kind !== 'decision' && kind !== 'frame-link') return void res.status(400).json({ error: 'kind' })

		const data = body.data
		if (typeof data !== 'object' || data === null || Array.isArray(data)) return void res.status(400).json({ error: 'data' })

		const bindings = await ctx.storage.discord.listOutbound(roomId)
		if (bindings.length === 0) return void res.json({ ok: true, delivered: 0 })

		// Env read inside the handler so config can change per-request (and tests).
		const botPort = process.env.DISCORD_PORT ?? '8790'
		const secret = process.env.DISCORD_INTERNAL_SECRET ?? ''

		let delivered = 0
		for (const binding of bindings) {
			try {
				const forward = await fetch(`http://127.0.0.1:${botPort}/post`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
					body: JSON.stringify({ channelId: binding.channelId, payload: { kind, room: roomId, data } }),
				})
				if (forward.ok) delivered++
				else console.error('[discord] forward failed', { channelId: binding.channelId, status: forward.status })
			} catch (err) {
				console.error('[discord] forward failed', { channelId: binding.channelId, err })
			}
		}
		res.json({ ok: true, delivered })
	})

	// DELETE /api/discord/bindings/:id — idempotent removal.
	router.delete('/api/discord/bindings/:id', async (req, res) => {
		await ctx.storage.discord.remove(req.params.id)
		res.json({ ok: true })
	})

	return router
}
