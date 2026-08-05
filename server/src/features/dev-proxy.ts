/**
 * Injecting /dev/{port} proxy (spec: web-viewer unification). Caddy now sends
 * /dev/* to the sync server instead of straight to the target port; this
 * router strips the prefix, proxies to localhost:{port}, and injects the
 * recorder bridge + URL patch + error reporter into top-level HTML. Non-HTML
 * responses stream through untouched. WebSocket upgrades (HMR) are handled by
 * handleDevUpgrade, wired into app.ts's existing server 'upgrade' listener.
 * Compression: the upstream request advertises identity-only so HTML arrives
 * un-gzipped and injectable; asset responses keep whatever bytes upstream
 * sends (we simply never re-negotiate encoding for them either — acceptable:
 * LAN/loopback hop, and Caddy/Cloudflare re-compress toward the browser).
 *
 * WS passthrough deliberately goes through the `ws` package rather than a raw
 * net.Socket splice: the server runs on Bun, and a socket handed to
 * `server.on('upgrade')` is not usable for raw I/O there (writes never reach
 * the client, client bytes never surface) — Bun implements `ws`'s
 * WebSocketServer.handleUpgrade natively (the existing /sync upgrades already
 * rely on this), so that's the only upgrade path proven to work under this
 * runtime.
 */
import express from 'express'
import http from 'node:http'
import type { Socket } from 'node:net'
import WebSocketImpl, { WebSocketServer } from 'ws'
import { errorPage } from '../files-render.ts'
import { injectDevPage } from '../dev-inject.ts'

const DEV_PATH = /^\/dev\/(\d{1,5})(\/.*)?$/

export function createDevProxyRouter(): express.Router {
	const router = express.Router()
	router.all(/^\/dev\/\d+(\/.*)?$/, (req, res) => {
		const m = DEV_PATH.exec(req.originalUrl)
		if (!m) return void res.status(400).send('bad dev path')
		const port = Number(m[1])
		const upstreamPath = m[2] || '/'
		const headers: http.OutgoingHttpHeaders = {
			...req.headers,
			host: `localhost:${port}`,
			'accept-encoding': 'identity',
		}
		delete headers.connection
		const upstream = http.request(
			{ host: '127.0.0.1', port, method: req.method, path: upstreamPath, headers },
			(ur) => {
				const type = String(ur.headers['content-type'] ?? '')
				if (type.includes('text/html')) {
					const chunks: Buffer[] = []
					ur.on('data', (c) => chunks.push(c))
					ur.on('end', () => {
						const html = injectDevPage(Buffer.concat(chunks).toString('utf8'), port)
						const out = { ...ur.headers }
						delete out['content-length']
						delete out['content-encoding']
						// The injected body is written in one un-chunked res.end() call —
						// an upstream `transfer-encoding: chunked` (or a stale
						// `connection` header) surviving onto our own response would
						// mismatch what's actually written, producing a malformed
						// response (Bun's fetch rejects it outright; other clients hang).
						delete out['transfer-encoding']
						delete out['connection']
						res.writeHead(ur.statusCode ?? 200, out)
						res.end(html)
					})
				} else {
					res.writeHead(ur.statusCode ?? 200, ur.headers)
					ur.pipe(res)
				}
			}
		)
		upstream.on('error', () => {
			if (!res.headersSent) {
				res.status(502).type('html').send(errorPage('dev server unreachable', `Nothing is listening on localhost:${port}.`))
			} else res.end()
		})
		req.pipe(upstream)
	})
	return router
}

// ws.close() throws for codes outside 1000 or 3000-4999 — 1005/1006 are
// synthetic ("no status"/"abnormal") and can never be sent on the wire, so a
// close in either direction that carries one of those gets relayed as a
// plain, code-less close instead of propagating the raw number.
function relayableCloseCode(code: number): number | undefined {
	if (code === 1000 || (code >= 3000 && code < 5000)) return code
	return undefined
}

/**
 * WS upgrade passthrough for /dev/{port} (HMR etc.), via the `ws` package —
 * see the module comment for why a raw socket splice doesn't work under Bun.
 * Dials the upstream dev server first so its own subprotocol choice (e.g.
 * vite-hmr) can be echoed back to the client; only then accepts the client's
 * upgrade and wires a bidirectional message/close relay. Returns true if the
 * path matched (the upgrade is claimed asynchronously either way).
 */
export function handleDevUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): boolean {
	const m = DEV_PATH.exec(req.url ?? '')
	if (!m) return false
	const port = Number(m[1])
	const path = m[2] || '/'

	const protoHeader = req.headers['sec-websocket-protocol']
	const protocols = protoHeader ? protoHeader.split(',').map((p) => p.trim()) : undefined

	// Forward the original request headers so the upstream sees the same
	// cookies/origin/etc a direct connection would — minus the handshake
	// fields `ws`'s client constructs itself, and Host (repointed at the
	// upstream port, matching the HTTP proxy path above).
	const forwardHeaders: Record<string, string> = {}
	for (const [k, v] of Object.entries(req.headers)) {
		if (typeof v === 'string') forwardHeaders[k] = v
	}
	delete forwardHeaders.connection
	delete forwardHeaders.upgrade
	delete forwardHeaders['sec-websocket-key']
	delete forwardHeaders['sec-websocket-version']
	delete forwardHeaders['sec-websocket-extensions']
	delete forwardHeaders['sec-websocket-protocol']
	forwardHeaders.host = `localhost:${port}`

	const upstream = new WebSocketImpl(`ws://127.0.0.1:${port}${path}`, protocols, {
		headers: forwardHeaders,
	})

	// 'unexpected-response' (upstream completes the TCP handshake but declines
	// the WS upgrade) is deliberately not handled here — Bun doesn't implement
	// that event on the ws client, so a listener would be silently inert and
	// falsely imply coverage. 'error' (e.g. nothing listening on the port) is
	// the case that matters and works the same as the HTTP path's handler.
	//
	// Registered with .on (not .once): a connection that fails to establish
	// can emit 'error' more than once, and an EventEmitter's 'error' event
	// with no listener left to catch a second emission crashes the whole
	// process — the `failed` guard keeps the actual 502-and-cleanup logic
	// idempotent while the listener itself stays put to absorb any repeat.
	let failed = false
	const failUpgrade = () => {
		if (failed) return
		failed = true
		upstream.removeAllListeners()
		upstream.on('error', () => {})
		if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
	}
	upstream.on('error', failUpgrade)

	upstream.once('open', () => {
		upstream.removeListener('error', failUpgrade)

		// Ephemeral, single-connection server: its only job is to complete
		// THIS client handshake, echoing whatever subprotocol the upstream
		// just negotiated (handleProtocols is only invoked when the client
		// actually requested one — see ws's websocket-server.js).
		const wss = new WebSocketServer({ noServer: true, handleProtocols: () => upstream.protocol || false })
		wss.handleUpgrade(req, socket, head, (client) => {
			const kill = () => {
				client.close()
				upstream.close()
			}
			client.on('message', (data, isBinary) => upstream.send(data, { binary: isBinary }))
			upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }))
			client.on('close', (code, reason) => upstream.close(relayableCloseCode(code), reason))
			upstream.on('close', (code, reason) => client.close(relayableCloseCode(code), reason))
			client.on('error', kill)
			upstream.on('error', kill)
		})
	})

	return true
}
