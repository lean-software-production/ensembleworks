// The gateway adapter seam. discord.js lives behind this interface so the
// router and handlers are testable without a network (see adapter.fake.ts).
export interface InboundMessage {
	channelId: string
	guildId: string
	authorId: string
	authorName: string
	isBot: boolean
	content: string
}
export interface Embed {
	title?: string
	description?: string
	url?: string
}
export interface Gateway {
	onMessage(handler: (m: InboundMessage) => void): void
	send(channelId: string, embed: Embed): Promise<void>
}
