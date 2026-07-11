// Discord bot bindings — connect a Discord channel to a route inside a room.
// See docs/discord-bot-design.md and docs/plans/2026-07-08-discord-bot.md.
import { z } from 'zod'
import type { ToolDef } from './types.js'

export interface DiscordBinding {
	id: string
	room: string
	guildId: string
	channelId: string
	direction: 'in' | 'out'
	route: { handler: string; params: Record<string, unknown> }
	createdBy: string
	createdAt: number
}

const room = z.string().default('team')

// Mirrors the DiscordBinding interface above (the store validates structure; the
// manifest only describes the wire shape). Kept in lock-step by hand.
const bindingRoute = z.object({
	handler: z.string(),
	params: z.record(z.string(), z.unknown()),
})
const binding = z.object({
	id: z.string(),
	room: z.string(),
	guildId: z.string(),
	channelId: z.string(),
	direction: z.enum(['in', 'out']),
	route: bindingRoute,
	createdBy: z.string(),
	createdAt: z.number(),
})

export const discordBindingsRead: ToolDef = {
	plugin: 'discord',
	id: 'bindings',
	http: { method: 'GET', path: '/api/discord/bindings' },
	help: 'List every Discord channel binding for a room.',
	zodInput: z.object({ room }),
	zodOutput: z.object({ ok: z.literal(true), bindings: z.array(binding) }),
}

export const discordResolve: ToolDef = {
	plugin: 'discord',
	id: 'resolve',
	http: { method: 'GET', path: '/api/discord/resolve' },
	help: 'Reverse-lookup the inbound bindings for a Discord channel id.',
	zodInput: z.object({
		channelId: z.string().describe('the Discord channel id to resolve'),
	}),
	zodOutput: z.object({ ok: z.literal(true), bindings: z.array(binding) }),
}

export const discordBindingsCreate: ToolDef = {
	plugin: 'discord',
	id: 'bind',
	http: { method: 'POST', path: '/api/discord/bindings' },
	help: 'Bind a Discord channel to a room route (inbound or outbound).',
	zodInput: z.object({
		room,
		guildId: z.string().min(1).max(64),
		channelId: z.string().min(1).max(64),
		direction: z.enum(['in', 'out']),
		route: z.object({
			handler: z.string().min(1).max(64),
			params: z.record(z.string(), z.unknown()).optional(),
		}),
	}),
	zodOutput: z.object({ ok: z.literal(true), id: z.string(), binding }),
}

export const discordPost: ToolDef = {
	plugin: 'discord',
	id: 'post',
	http: { method: 'POST', path: '/api/discord/post' },
	help: 'Post an outbound summary/decision to a room’s bound channels.',
	zodInput: z.object({
		room,
		kind: z.enum(['summary', 'action-items', 'decision', 'frame-link']),
		data: z.record(z.string(), z.unknown()),
	}),
	zodOutput: z.object({ ok: z.literal(true), delivered: z.number() }),
}

export const discordBindingsDelete: ToolDef = {
	plugin: 'discord',
	id: 'unbind',
	// id is a query param (?id=), never a `:id` path segment — the CLI renderer
	// emits DELETE input as query and does not substitute path params, so a
	// path-param route would silently no-op. See cli/src/render/args.ts.
	http: { method: 'DELETE', path: '/api/discord/bindings' },
	help: 'Remove a Discord channel binding by id (idempotent).',
	zodInput: z.object({ id: z.string().describe('the binding id to remove') }),
	zodOutput: z.object({ ok: z.literal(true) }),
}

export const discordTools: ToolDef[] = [
	discordBindingsRead,
	discordResolve,
	discordBindingsCreate,
	discordPost,
	discordBindingsDelete,
]
