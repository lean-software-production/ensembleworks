// Discord bot bindings — connect a Discord channel to a route inside a room.
// See docs/discord-bot-design.md and docs/plans/2026-07-08-discord-bot.md.
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
