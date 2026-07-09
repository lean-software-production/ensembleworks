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
		if (typeof guildId !== 'string' || !guildId) return void res.status(400).json({ error: 'guildId' })

		const channelId = body.channelId
		if (typeof channelId !== 'string' || !channelId) return void res.status(400).json({ error: 'channelId' })

		const direction = body.direction
		if (direction !== 'in' && direction !== 'out') return void res.status(400).json({ error: 'direction' })

		const route = body.route
		if (typeof route !== 'object' || route === null) return void res.status(400).json({ error: 'route' })
		const handler = (route as Record<string, unknown>).handler
		if (typeof handler !== 'string' || !handler) return void res.status(400).json({ error: 'route.handler' })
		const rawParams = (route as Record<string, unknown>).params ?? {}
		if (typeof rawParams !== 'object' || rawParams === null) return void res.status(400).json({ error: 'route.params' })
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

	// DELETE /api/discord/bindings/:id — idempotent removal.
	router.delete('/api/discord/bindings/:id', async (req, res) => {
		await ctx.storage.discord.remove(req.params.id)
		res.json({ ok: true })
	})

	return router
}
