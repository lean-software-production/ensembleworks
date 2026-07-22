// Auth-rejected dial is FATAL (SP5 §2): a 403/401/302-to-Access upgrade
// response makes runTransport throw AuthRejectedError (so the process exits
// and the SP2 supervisor re-execs with a fresh token) instead of backing off
// forever on a dead credential. A plain 500 keeps the retry behavior.
// Run with: bun src/connector/auth-reject.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { ConnectorSessionManager } from './session.ts'
import { AuthRejectedError, runTransport } from './relay-client.ts'

const timers = {
	now: () => Date.now(),
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
	setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
	clearInterval: (h: ReturnType<typeof setInterval>) => clearInterval(h),
}
const mgr = new ConnectorSessionManager(() => {
	throw new Error('no sessions in this test')
})

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> =>
	new Promise((resolve) => {
		const server = http.createServer(handler)
		server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
	})

// 403 on upgrade → AuthRejectedError (fatal).
{
	const { server, port } = await listen((_req, res) => {
		res.writeHead(403, { 'content-type': 'text/plain' })
		res.end('forbidden')
	})
	const ac = new AbortController()
	await assert.rejects(
		() => runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0.5, WebSocketCtor: WebSocket }, ac.signal),
		(e: unknown) => e instanceof AuthRejectedError && /403/.test((e as Error).message),
		'403 upgrade → fatal AuthRejectedError',
	)
	server.close()
}

// 302 to the Access login page → AuthRejectedError (the edge's rejection shape).
{
	const { server, port } = await listen((_req, res) => {
		res.writeHead(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/app?kid=x' })
		res.end()
	})
	const ac = new AbortController()
	await assert.rejects(
		() => runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0.5, WebSocketCtor: WebSocket }, ac.signal),
		(e: unknown) => e instanceof AuthRejectedError,
		'302→Access login on upgrade → fatal AuthRejectedError',
	)
	server.close()
}

// A 500 is NOT auth — runTransport keeps retrying (we abort it after the
// first backoff window to prove it did not throw).
{
	let dials = 0
	const { server, port } = await listen((_req, res) => {
		dials++
		res.writeHead(500)
		res.end('boom')
	})
	// Deviation (Task 14 round-1, see execution notes): Bun's http.createServer
	// never fires a response/close for a WS-upgrade request unless something
	// handles the 'upgrade' event — under Node the same fixture properly
	// completes with a hang-free rejection, but Bun leaves the socket open
	// forever (verified empirically). A generic non-auth dial failure (this
	// block's whole point) is exactly a hard socket-level failure, so make it
	// one: destroy the upgrade socket immediately, which every runtime (and a
	// real strange proxy) treats as a normal dial-error to retry from.
	server.on('upgrade', (_req, socket) => socket.destroy())
	const ac = new AbortController()
	const run = runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0, WebSocketCtor: WebSocket }, ac.signal)
	// rng=0 → minimal jitter; give it time for ≥2 dials, then abort.
	await new Promise((r) => setTimeout(r, 2_500))
	ac.abort()
	await run // resolves (no throw) — retry semantics preserved
	assert.ok(dials >= 2, `non-auth failures keep retrying (saw ${dials} dials)`)
	server.close()
}

console.log('ok: auth-reject — 403/302-to-Access fatal, 500 retries as before')
