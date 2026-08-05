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
 */
import express from 'express'
import http from 'node:http'
import net from 'node:net'
import type { Socket } from 'node:net'
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

/** WS upgrade passthrough for /dev/{port}: raw TCP splice. Returns true if handled. */
export function handleDevUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): boolean {
	const m = DEV_PATH.exec(req.url ?? '')
	if (!m) return false
	const port = Number(m[1])
	const upstream = net.connect(port, '127.0.0.1', () => {
		const path = m[2] || '/'
		const lines = [`${req.method} ${path} HTTP/1.1`]
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const k = req.rawHeaders[i] ?? ''
			if (k.toLowerCase() === 'host') lines.push(`Host: localhost:${port}`)
			else lines.push(`${k}: ${req.rawHeaders[i + 1]}`)
		}
		upstream.write(lines.join('\r\n') + '\r\n\r\n')
		if (head.length) upstream.write(head)
		socket.pipe(upstream)
		upstream.pipe(socket)
	})
	const kill = () => { socket.destroy(); upstream.destroy() }
	upstream.on('error', kill)
	socket.on('error', kill)
	return true
}
