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

	// GET /api/discord/resolve?channelId=<id> — channel → inbound binding reverse
	// lookup for the bot. It receives a message on a channel and needs the room +
	// route it's bound to. Read-only; the bot authenticates via CF Access in prod.
	router.get('/api/discord/resolve', async (req, res) => {
		const channelId = String(req.query.channelId ?? '').trim()
		if (!channelId) return void res.status(400).json({ error: 'channelId' })
		res.json({ ok: true, bindings: await ctx.storage.discord.listInboundByChannel(channelId) })
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
		if (!secret) console.warn('[discord] DISCORD_INTERNAL_SECRET unset — outbound posts will be rejected by the bot')

		// Forward all bindings in parallel: one stalled bot can't serialize behind
		// the others, and AbortSignal.timeout caps a single forward (accept-then-
		// stall) so the whole handler resolves in ~one timeout worst case.
		const results = await Promise.allSettled(
			bindings.map((binding) =>
				fetch(`http://127.0.0.1:${botPort}/post`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
					body: JSON.stringify({ channelId: binding.channelId, payload: { kind, room: roomId, data } }),
					signal: AbortSignal.timeout(5000),
				}).then((forward) => {
					if (!forward.ok) console.error('[discord] forward failed', { channelId: binding.channelId, status: forward.status })
					return forward.ok
				}, (err) => {
					console.error('[discord] forward failed', { channelId: binding.channelId, err })
					return false
				}),
			),
		)
		const delivered = results.filter((r) => r.status === 'fulfilled' && r.value === true).length
		res.json({ ok: true, delivered })
	})

	// DELETE /api/discord/bindings?id=<id> — idempotent removal. The id is a query
	// param, NOT a path segment: the CLI's generic renderer emits GET/DELETE input
	// as query and never substitutes a `:id`, so a path-param route would silently
	// no-op (delete nothing, report ok). Missing id is a 400 rather than a no-op.
	router.delete('/api/discord/bindings', async (req, res) => {
		const id = String(req.query.id ?? '').trim()
		if (!id) return void res.status(400).json({ error: 'id' })
		await ctx.storage.discord.remove(id)
		res.json({ ok: true })
	})

	return router
}
