import type { Gateway, InboundMessage, Embed } from './adapter.ts'

export class FakeGateway implements Gateway {
	private handlers: ((m: InboundMessage) => void)[] = []
	sent: { channelId: string; embed: Embed }[] = []
	onMessage(h: (m: InboundMessage) => void) {
		this.handlers.push(h)
	}
	emit(m: InboundMessage) {
		for (const h of this.handlers) h(m)
	}
	async send(channelId: string, embed: Embed) {
		this.sent.push({ channelId, embed })
	}
}
