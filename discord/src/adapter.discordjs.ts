// The real Gateway: discord.js v14 behind the adapter seam (adapter.ts). This
// is the network boundary — it is typecheck + smoke tested only, not unit
// tested (the router/handlers are exercised against FakeGateway instead).
import { Client, GatewayIntentBits, Events } from 'discord.js'
import type { Gateway, InboundMessage, Embed } from './adapter.ts'

export class DiscordJsGateway implements Gateway {
	private readonly client: Client

	constructor(private readonly token: string) {
		this.client = new Client({
			// MessageContent is a PRIVILEGED intent — required to read message text.
			// It must also be enabled in the Discord developer portal for the app.
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		})
	}

	onMessage(handler: (m: InboundMessage) => void): void {
		this.client.on(Events.MessageCreate, (msg) => {
			handler({
				channelId: msg.channelId,
				guildId: msg.guildId ?? '', // DMs have no guild
				authorId: msg.author.id,
				authorName: msg.author.username,
				isBot: msg.author.bot,
				content: msg.content,
			})
		})
	}

	async send(channelId: string, embed: Embed): Promise<void> {
		const ch = await this.client.channels.fetch(channelId)
		// isSendable() narrows to SendableChannels (channels with .send) in v14 —
		// covers text/DM/thread/voice-text while excluding forum/category channels.
		if (ch && ch.isSendable()) {
			// discord.js accepts a plain { title?, description?, url? } as an embed.
			await ch.send({ embeds: [embed] })
		}
	}

	async connect(): Promise<void> {
		await this.client.login(this.token)
	}

	async destroy(): Promise<void> {
		await this.client.destroy()
	}
}
