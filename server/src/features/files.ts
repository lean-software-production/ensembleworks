/**
 * /files/* — the single routing layer the file-viewer iframe talks to.
 * Proxies the local file-server (:8791), rendering markdown to styled HTML and
 * injecting the scroll bridge into every top-level document HERE, so the
 * file-server (and the future remote connector) stay dumb byte readers.
 * `gateway` is the remote seam: v1 rejects it with 501; later a relay arm
 * forwards to the named gateway instead of localhost.
 */
/// <reference path="../rrweb-umd.d.ts" />
import express from 'express'
import path from 'node:path'
import { Readable } from 'node:stream'
import { errorPage, injectBridge, renderMarkdown } from '../files-render.ts'
// rrweb's UMD build exposes window.rrweb. Embedded as text at build time (the
// relative path dodges the package's `exports` block on dist subpaths) so the
// `bun build --compile` binary carries it — a runtime require.resolve has no
// node_modules to find on a deployed box and would fail the boot check.
import rrwebSource from '../../../node_modules/rrweb/dist/rrweb.umd.min.cjs' with { type: 'text' }

const DOC_HTML = new Set(['.html', '.htm'])
const DOC_MD = new Set(['.md', '.markdown'])
// Subresources documents legitimately request; anything else asked for as the
// top-level document gets the unsupported page.
const ASSETS = new Set([
	'.css', '.js', '.mjs', '.json', '.map', '.txt', '.csv',
	'.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
	'.woff', '.woff2', '.ttf', '.otf', '.pdf',
	'.mp4', '.webm', '.m4a', '.mp3',
])

const filesPort = () => Number(process.env.ENSEMBLEWORKS_FILES_PORT ?? 8791)

export function createFilesRouter(): express.Router {
	const router = express.Router()

	router.get('/files-assets/rrweb.js', (_req, res) => {
		res.type('text/javascript').send(rrwebSource)
	})

	router.get(/^\/files\/(.+)/, async (req, res) => {
		// Express 5 decodes regex capture groups, so re-encode each path segment
		// before forwarding — the file-server's own decodeURIComponent stays the
		// single decode point (avoids mangling spaces/percent-encoded bytes).
		const decodedRel = (req.params as unknown as Record<string, string>)[0] ?? ''
		const rel = decodedRel.split('/').map(encodeURIComponent).join('/')
		const gateway = String(req.query.gateway ?? '')
		const sendPage = (status: number, title: string, msg: string) =>
			res
				.status(status)
				.set('cache-control', 'no-store')
				.set('access-control-allow-origin', '*')
				.type('html')
				.send(errorPage(title, msg))

		if (gateway) {
			return void sendPage(501, 'Remote files not yet supported', `gateway "${gateway}" — the remote file transport lands with the connector engine.`)
		}

		const ext = path.extname(decodedRel).toLowerCase()
		// Range only makes sense for bytes we pass through untouched: a partial
		// body would be rendered/bridge-injected into nonsense for md/html docs,
		// so those hops always ask upstream for the whole file.
		const rangeable = ASSETS.has(ext) && !DOC_HTML.has(ext) && !DOC_MD.has(ext)
		const inboundRange = rangeable ? req.header('range') : undefined
		// `fetch()` keeps reading its response after the browser has abandoned the
		// downstream response unless we explicitly cancel it. For media scrubbing,
		// that turns every discarded range into an orphaned file-server transfer
		// (and, depending on the fetch implementation, a buffered response body).
		// Tie the outbound request to the client socket rather than `res.close`:
		// Bun does not reliably emit the latter for a mid-stream disconnect. Remove
		// the socket listener on a normal finish because keep-alive sockets live on
		// to serve unrelated requests.
		const abort = new AbortController()
		let responseFinished = false
		const clientSocket = req.socket
		const onClientGone = () => {
			if (!responseFinished) abort.abort()
		}
		const cleanUpClientGone = () => {
			clientSocket?.removeListener('close', onClientGone)
			req.removeListener('aborted', onClientGone)
		}
		clientSocket?.once('close', onClientGone)
		req.once('aborted', onClientGone)
		res.once('finish', () => {
			responseFinished = true
			cleanUpClientGone()
		})

		let upstream: Response
		try {
			// v1: no timeout — a hung file-server hangs the request (localhost, single user).
			upstream = await fetch(`http://127.0.0.1:${filesPort()}/${rel}`, {
				headers: inboundRange ? { range: inboundRange } : undefined,
				signal: abort.signal,
			})
		} catch {
			if (abort.signal.aborted) return
			return void sendPage(502, 'File server unavailable', 'The file-server (:8791) is not responding. Is the stack service running?')
		}
		if (upstream.status === 403) return void sendPage(403, 'Forbidden', 'That path escapes the served home directory.')
		if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
			return void sendPage(404, 'Not found', `${decodedRel} does not exist (or is a directory).`)
		}
		res.set('cache-control', 'no-store')
		// The document iframe is an opaque origin; fetch()/module subresources need
		// CORS on every /files response (the file-server sets this too, but the
		// route is the layer the iframe actually talks to). Spec §1/§2.
		res.set('access-control-allow-origin', '*')
		if (DOC_MD.has(ext)) {
			const md = await upstream.text()
			return void res.type('html').send(renderMarkdown(md, path.basename(decodedRel)))
		}
		if (DOC_HTML.has(ext)) {
			const html = await upstream.text()
			return void res.type('html').send(injectBridge(html))
		}
		if (ASSETS.has(ext)) {
			// Pass the upstream range answer straight through — status (200/206/416)
			// plus the headers a <video> element needs to seek. Buffering here would
			// re-create the memory problem the streaming file-server just solved, so
			// the upstream body is piped, not collected.
			for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
				const v = upstream.headers.get(h)
				if (v) res.set(h, v)
			}
			res.status(upstream.status)
			if (!upstream.body) return void res.end()
			// Double cast: the workspace's DOM lib and node:stream/web each declare
			// their own ReadableStream and TS won't bridge them directly.
			const web = upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]
			const body = Readable.fromWeb(web)
			// Aborting the fetch makes the node wrapper error; consume that error so
			// a client navigating away cannot become an uncaught process error.
			body.on('error', () => {
				if (!res.writableEnded) res.destroy()
			})
			return void body.pipe(res)
		}
		return void sendPage(200, 'Unsupported type', `"${ext || '(no extension)'}" cannot be shown as a document. v1 renders HTML and Markdown.`)
	})

	return router
}
