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
import http from 'node:http'
import https from 'node:https'
import WebSocket from 'ws'
import {
	computeBackoff,
	RELAY_HEALTHY_RESET_MS,
	RELAY_PING_INTERVAL_MS,
	RELAY_READ_LIMIT_BYTES,
} from '@ensembleworks/contracts/relay-parity'
import { RelayMux } from './mux.ts'
import type { ConnectorSessionManager } from './session.ts'

/** The server (or the Access edge) explicitly rejected our credentials on the
 *  upgrade. FATAL: retrying with the same token cannot succeed — exit so a
 *  supervisor (SP2 codespace up) re-execs with a freshly minted one (SP5 §2). */
export class AuthRejectedError extends Error {}

function classifyAuthRejection(status: number, location: string): AuthRejectedError | undefined {
	const rejected = status === 401 || status === 403 || ((status === 301 || status === 302) && location.includes('/cdn-cgi/access/login'))
	return rejected
		? new AuthRejectedError(`relay dial rejected: HTTP ${status}${location ? ` → ${location}` : ''} — credentials refused`)
		: undefined
}

/** Pre-flight probe (deviation from the plan's `ws` `unexpected-response`-only
 *  design — see Task 14 round-1 execution notes): under Bun, `ws`'s
 *  `unexpected-response` event is not implemented ([bun] warns and the promise
 *  never settles — verified empirically, no upstream flag to enable it as of
 *  bun 1.3.14), so relying on it alone leaves `serveOnce` hung forever on a
 *  403/302 upgrade rejection instead of surfacing `AuthRejectedError`. Cloudflare
 *  Access rejects on cookie/header inspection for ANY request to the path, not
 *  just the upgrade, so a plain GET with the same headers gets the identical
 *  401/403/302 classification ahead of the real dial. A network-level failure
 *  here (not a rejection) falls through silently — the real dial attempt below
 *  reports it exactly as before. */
function probeAuthRejection(wsUrl: string, headers: Record<string, string>, signal: AbortSignal): Promise<AuthRejectedError | undefined> {
	return new Promise((resolve) => {
		let settled = false
		const finish = (v: AuthRejectedError | undefined) => {
			if (settled) return
			settled = true
			signal.removeEventListener('abort', onAbort)
			resolve(v)
		}
		let httpUrl: URL
		try {
			httpUrl = new URL(wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'))
		} catch {
			finish(undefined)
			return
		}
		const mod = httpUrl.protocol === 'https:' ? https : http
		const req = mod.request(httpUrl, { method: 'GET', headers }, (res) => {
			const status = res.statusCode ?? 0
			const location = String(res.headers.location ?? '')
			res.resume() // drain — we only need status/headers
			finish(classifyAuthRejection(status, location))
		})
		req.on('error', () => finish(undefined)) // network failure: let the real dial report it
		const onAbort = () => {
			req.destroy()
			finish(undefined)
		}
		signal.addEventListener('abort', onAbort)
		req.end()
	})
}

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
	// Only probe ahead of a REAL 'ws' dial (referential match on the module's
	// own import — this is exactly how production wires deps.WebSocketCtor;
	// fakes injected by unit tests, e.g. reconnect.test.ts's FakeWs, are a
	// different reference and skip it). Unit tests drive fakes purely through
	// injected event emission and must stay network-free; only the real 'ws'
	// package actually needs the Bun workaround (see probeAuthRejection's doc).
	if (deps.WebSocketCtor !== WebSocket) return serveOnceDialed(wsUrl, headers, mgr, deps, signal)
	return probeAuthRejection(wsUrl, headers, signal).then((rejection) => {
		if (rejection) throw rejection
		return serveOnceDialed(wsUrl, headers, mgr, deps, signal)
	})
}

function serveOnceDialed(
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
		// Not implemented under Bun as of 1.3.14 (see probeAuthRejection's doc) —
		// the pre-flight probe above is the mechanism that actually fires there.
		// Kept for parity if this ever runs under plain Node's `ws`.
		ws.on('unexpected-response', (_req, res) => {
			const status = res.statusCode ?? 0
			const location = String(res.headers.location ?? '')
			done(classifyAuthRejection(status, location) ?? new Error(`relay dial failed: HTTP ${status}`))
		})
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
		} catch (err) {
			if (err instanceof AuthRejectedError) throw err // fatal — see class doc
			/* anything else: reconnect with backoff, as before */
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
