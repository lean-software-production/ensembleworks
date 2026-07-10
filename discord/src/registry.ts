import type { InboundMessage } from './adapter.ts'

export interface HandlerContext {
	room: string
	message: InboundMessage
}
export interface InboundHandler {
	handle(ctx: HandlerContext, params: Record<string, unknown>): Promise<void>
}
export type Registry = Record<string, InboundHandler>
