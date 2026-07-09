import type { InboundHandler } from '../registry.ts'
import type { SyncServerClient } from '../syncClient.ts'

// Inbound handler: a Discord message becomes a note in the bound frame.
// params.frame is a fuzzy frame NAME (matches the sync server's /api/canvas/sticky
// `frame` param). Text-only: attachment-only messages (empty content) are skipped.
export function makeFrameStickyHandler(client: SyncServerClient): InboundHandler {
	return {
		async handle(ctx, params) {
			const text = ctx.message.content.trim()
			if (!text) return // nothing to post (e.g. an attachment-only message)
			const frame = typeof params.frame === 'string' ? params.frame : undefined
			await client.createSticky({
				room: ctx.room,
				frame,
				text,
				author: `${ctx.message.authorName} (Discord)`,
			})
		},
	}
}
