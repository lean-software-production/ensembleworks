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
		// Strip conditional headers: a 304 would tell the browser to keep its
		// cached body, but cached bodies at this origin may belong to a
		// different backend (see the no-store rationale below) — force full
		// responses so poisoned entries get replaced, never revalidated.
		delete headers['if-none-match']
		delete headers['if-modified-since']
		const upstream = http.request(
			{ host: '127.0.0.1', port, method: req.method, path: upstreamPath, headers },
			(ur) => {
				const type = String(ur.headers['content-type'] ?? '')
				// Never let the browser cache proxied dev responses. Root-absolute
				// paths (/@vite/client, /src/*) are AMBIGUOUS at this origin: the
				// same URL can be served by different backends depending on the
				// request's Referer (the @devref fallback), and in the dev stack the
				// canvas app's own Vite shares these exact paths. The HTTP cache
				// keys only on URL, so a cached body from one backend gets replayed
				// for the other — wrong HMR token, stale modules, dead HMR.
				const uncache = (h: http.OutgoingHttpHeaders) => {
					h['cache-control'] = 'no-store'
					delete h['etag']
					delete h['last-modified']
					h['vary'] = 'Referer'
					return h
				}
				if (type.includes('text/html')) {
					const chunks: Buffer[] = []
					ur.on('data', (c) => chunks.push(c))
					ur.on('end', () => {
						const html = injectDevPage(Buffer.concat(chunks).toString('utf8'), port)
						const out = uncache({ ...ur.headers })
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
					res.writeHead(ur.statusCode ?? 200, uncache({ ...ur.headers }))
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

	// The client can abort (close, or error out) the pending upgrade while
	// the upstream dial is still in flight — `socket` is only good for the
	// duration of THIS upgrade, so once it's gone the upstream connection (if
	// it ever opens) has to be torn down rather than handed to
	// wss.handleUpgrade: that throws synchronously on a dead socket under Bun
	// (`TypeError: upgrade requires a Request object`), and with no
	// uncaughtException handler anywhere in server/src, an uncaught throw
	// here takes the entire sync server down with it.
	let aborted = false
	const onClientAbort = () => {
		aborted = true
		upstream.close()
	}
	socket.once('close', onClientAbort)
	socket.once('error', onClientAbort)

	// The upstream WebSocket must NEVER be left without an 'error' listener —
	// an unconsumed 'error' event is fatal (crashes the whole process) under
	// both Node and Bun, and a connection that fails to establish can emit
	// more than one. Register exactly one real listener for upstream's whole
	// lifetime and just retarget what it delegates to as we move through
	// phases (dialling -> relaying), so there's never a gap.
	let onUpstreamError: (err: unknown) => void = () => {}
	upstream.on('error', (err) => onUpstreamError(err))

	// 'unexpected-response' (upstream completes the TCP handshake but declines
	// the WS upgrade) is deliberately not handled here — Bun doesn't implement
	// that event on the ws client, so a listener would be silently inert and
	// falsely imply coverage. 'error' (e.g. nothing listening on the port) is
	// the case that matters and works the same as the HTTP path's handler.
	const failUpgrade = () => {
		socket.removeListener('close', onClientAbort)
		socket.removeListener('error', onClientAbort)
		onUpstreamError = () => {}
		if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
	}
	onUpstreamError = failUpgrade

	upstream.once('open', () => {
		socket.removeListener('close', onClientAbort)
		socket.removeListener('error', onClientAbort)

		// The client (or its socket) died while we were still dialling
		// upstream — nothing left to hand the now-useless upstream
		// connection to; drop it and stop.
		if (aborted || socket.destroyed || !socket.writable) {
			upstream.close()
			return
		}

		// Ephemeral, single-connection server: its only job is to complete
		// THIS client handshake, echoing whatever subprotocol the upstream
		// just negotiated (handleProtocols is only invoked when the client
		// actually requested one — see ws's websocket-server.js).
		const wss = new WebSocketServer({ noServer: true, handleProtocols: () => upstream.protocol || false })
		try {
			wss.handleUpgrade(req, socket, head, (client) => {
				const kill = () => {
					client.close()
					upstream.close()
				}
				onUpstreamError = kill
				client.on('message', (data, isBinary) => upstream.send(data, { binary: isBinary }))
				upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }))
				client.on('close', (code, reason) => upstream.close(relayableCloseCode(code), reason))
				upstream.on('close', (code, reason) => client.close(relayableCloseCode(code), reason))
				client.on('error', kill)
			})
		} catch {
			// Belt-and-braces for the same dead-socket race the checks above
			// guard against — ws's handleUpgrade can still throw synchronously
			// if the socket died in the narrow gap between them and this call.
			// The client is already gone either way; just drop the upstream.
			upstream.close()
		}
	})

	return true
}
