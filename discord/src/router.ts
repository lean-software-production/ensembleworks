import type { InboundMessage } from './adapter.ts'
import type { Registry } from './registry.ts'

export interface ResolvedBinding {
	room: string
	route: { handler: string; params: Record<string, unknown> }
}
export interface RouterOpts {
	registry: Registry
	resolveBinding: (channelId: string) => Promise<ResolvedBinding[]>
}

export class Router {
	constructor(private opts: RouterOpts) {}
	async handle(m: InboundMessage): Promise<void> {
		if (m.isBot) return // echo/loop guard — never re-ingest our own posts
		const bindings = await this.opts.resolveBinding(m.channelId)
		for (const b of bindings) {
			const handler = this.opts.registry[b.route.handler]
			if (!handler) continue // unknown handler ignored safely
			await handler.handle({ room: b.room, message: m }, b.route.params)
		}
	}
}
