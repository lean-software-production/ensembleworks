import type { Gateway } from './adapter.ts'
import { Router } from './router.ts'
import type { Registry } from './registry.ts'
import { makeFrameStickyHandler } from './handlers/frameSticky.ts'
import { SyncServerClient } from './syncClient.ts'
import { makeBindingResolver } from './bindingResolver.ts'
import { startHttpFace, type HttpFace } from './httpFace.ts'

export interface BotConfig {
	syncBase: string // e.g. http://127.0.0.1:8788
	secret: string // DISCORD_INTERNAL_SECRET (guards POST /post)
	port: number // internal /post port (e.g. 8790)
	hostname?: string
	ttlMs?: number
}

// Compose the inbound + outbound wiring around a Gateway. Returns the httpFace
// handle (for shutdown). Does NOT connect the gateway — the caller does that.
export function wireBot(gateway: Gateway, cfg: BotConfig): { httpFace: HttpFace } {
	const client = new SyncServerClient(cfg.syncBase)
	const registry: Registry = { 'frame-sticky': makeFrameStickyHandler(client) }
	const resolveBinding = makeBindingResolver({ syncBase: cfg.syncBase, ttlMs: cfg.ttlMs })
	const router = new Router({ registry, resolveBinding })

	// Per-message error isolation: a handler failure (e.g. the sync server is
	// down) must never crash the gateway message loop or become an unhandled
	// rejection — log and move on.
	gateway.onMessage((m) => {
		router.handle(m).catch((err) => console.error('[discord] inbound handler error', err))
	})

	const httpFace = startHttpFace({ gateway, secret: cfg.secret, port: cfg.port, hostname: cfg.hostname })
	return { httpFace }
}
