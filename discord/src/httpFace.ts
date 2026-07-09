// The bot's internal control-plane HTTP endpoint. The room (via the sync
// server) POSTs here to make the bot deliver an embed to Discord. It binds to
// loopback only and requires a shared secret — it is never public.
import { timingSafeEqual } from 'node:crypto'
import type { Gateway } from './adapter.ts'
import { formatPayload, type OutboundPayload } from './formatters.ts'

export interface HttpFaceOpts {
	gateway: Gateway
	secret: string
	port: number // 0 → ephemeral (tests read the chosen port back)
	hostname?: string // defaults to '127.0.0.1' (loopback only, never public)
}

export interface HttpFace {
	port: number
	stop: () => void
}

// Constant-time secret compare that is safe on length mismatch.
function secretMatches(provided: string | null, expected: string): boolean {
	if (!provided) return false
	const a = Buffer.from(provided)
	const b = Buffer.from(expected)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

export function startHttpFace(opts: HttpFaceOpts): HttpFace {
	const hostname = opts.hostname ?? '127.0.0.1'
	const server = Bun.serve({
		port: opts.port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url)
			if (req.method !== 'POST' || url.pathname !== '/post') {
				return new Response('not found', { status: 404 })
			}
			if (!secretMatches(req.headers.get('x-internal-secret'), opts.secret)) {
				return new Response('unauthorized', { status: 401 })
			}
			let body: { channelId?: unknown; payload?: unknown }
			try {
				body = (await req.json()) as { channelId?: unknown; payload?: unknown }
			} catch {
				return new Response('bad json', { status: 400 })
			}
			const channelId = typeof body.channelId === 'string' ? body.channelId : ''
			if (!channelId || !body.payload || typeof body.payload !== 'object') {
				return new Response('bad request', { status: 400 })
			}
			try {
				await opts.gateway.send(channelId, formatPayload(body.payload as OutboundPayload))
			} catch (err) {
				return new Response(`send failed: ${String(err)}`, { status: 502 })
			}
			return Response.json({ ok: true })
		},
	})
	return { port: server.port ?? 0, stop: () => server.stop(true) }
}
