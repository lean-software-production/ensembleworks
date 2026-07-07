/**
 * The connector transport — a port of gateway-go/relay/relay.go's Run/serveOnce.
 * Dial the single outbound WS to /api/terminal/connect with the CF-Access header
 * pair (service-token instances) + the 1 MiB maxPayload read limit; serve one
 * connection; reconnect with the parity backoff (computeBackoff + the >30s
 * healthy-duration reset); a 20s ping heartbeat forces a redial on a half-open
 * link. Timers + rng are injected so tests drive the whole loop on a fake clock.
 *
 * Half-open detection (spec §6.3): relay.go used conn.Ping returning an error;
 * the connector uses the server's own alive/pong idiom (gateway-registry.ts
 * lines 193–204) at the same 20s cadence — both send a WS ping every 20s and
 * force a redial when the peer stops answering, identical effect in the ws idiom.
 */
import WebSocket from 'ws'
import {
	computeBackoff,
	RELAY_HEALTHY_RESET_MS,
	RELAY_PING_INTERVAL_MS,
	RELAY_READ_LIMIT_BYTES,
} from '@ensembleworks/contracts/relay-parity'
import { RelayMux } from './mux.ts'
import type { ConnectorSessionManager } from './session.ts'

export interface Timers {
	now(): number
	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
	clearTimeout(h: ReturnType<typeof setTimeout>): void
	setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>
	clearInterval(h: ReturnType<typeof setInterval>): void
}
export interface TransportDeps {
	timers: Timers
	rng: () => number
	WebSocketCtor: typeof WebSocket
}

/** Dial once and serve until the socket closes/errors or the ping heartbeat
 *  forces a redial. Resolves when the connection ends; rejects only on dial
 *  failure (the reconnect loop treats both the same). */
export function serveOnce(
	wsUrl: string,
	headers: Record<string, string>,
	mgr: ConnectorSessionManager,
	deps: TransportDeps,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new deps.WebSocketCtor(wsUrl, { headers, maxPayload: RELAY_READ_LIMIT_BYTES })
		const mux = new RelayMux(ws, mgr)
		let alive = true
		let heartbeat: ReturnType<typeof setInterval> | undefined
		let settled = false
		const onAbort = () => done()
		const done = (err?: Error) => {
			if (settled) return
			settled = true
			if (heartbeat) deps.timers.clearInterval(heartbeat)
			signal.removeEventListener('abort', onAbort)
			try {
				ws.terminate()
			} catch {
				/* already closed */
			}
			err ? reject(err) : resolve()
		}
		signal.addEventListener('abort', onAbort)
		ws.on('open', () => {
			heartbeat = deps.timers.setInterval(() => {
				if (!alive) {
					done() // missed pong → half-open → redial
					return
				}
				alive = false
				ws.ping()
			}, RELAY_PING_INTERVAL_MS)
		})
		ws.on('pong', () => {
			alive = true
		})
		ws.on('message', (data: Buffer, isBinary: boolean) => mux.handle(data, isBinary))
		ws.on('error', (err: Error) => done(err))
		ws.on('close', () => done())
	})
}

/** The reconnect loop: serve, drop viewers, back off (with the healthy-duration
 *  reset), redial — until aborted. tmux sessions survive every reconnect. */
export async function runTransport(
	wsUrl: string,
	headers: Record<string, string>,
	mgr: ConnectorSessionManager,
	deps: TransportDeps,
	signal: AbortSignal,
): Promise<void> {
	let attempt = 0
	while (!signal.aborted) {
		const start = deps.timers.now()
		try {
			await serveOnce(wsUrl, headers, mgr, deps, signal)
		} catch {
			/* logged; reconnect */
		}
		mgr.detachAll()
		if (signal.aborted) break
		if (deps.timers.now() - start > RELAY_HEALTHY_RESET_MS) attempt = 0
		attempt++
		await new Promise<void>((r) => {
			const settle = () => {
				deps.timers.clearTimeout(h)
				signal.removeEventListener('abort', onAbort)
				r()
			}
			const onAbort = () => settle()
			const h = deps.timers.setTimeout(settle, computeBackoff(attempt, deps.rng))
			signal.addEventListener('abort', onAbort)
		})
	}
}
