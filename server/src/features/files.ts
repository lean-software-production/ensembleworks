/**
 * /files/* — the single routing layer the file-viewer iframe talks to.
 * Proxies the local file-server (:8791), rendering markdown to styled HTML and
 * injecting the scroll bridge into every top-level document HERE, so the
 * file-server (and the future remote connector) stay dumb byte readers.
 * `gateway` is the remote seam: v1 rejects it with 501; later a relay arm
 * forwards to the named gateway instead of localhost.
 */
import express from 'express'
import path from 'node:path'
import { errorPage, injectBridge, renderMarkdown } from '../files-render.ts'

const DOC_HTML = new Set(['.html', '.htm'])
const DOC_MD = new Set(['.md', '.markdown'])
// Subresources documents legitimately request; anything else asked for as the
// top-level document gets the unsupported page.
const ASSETS = new Set([
	'.css', '.js', '.mjs', '.json', '.map', '.txt', '.csv',
	'.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
	'.woff', '.woff2', '.ttf', '.otf', '.pdf',
])

const filesPort = () => Number(process.env.ENSEMBLEWORKS_FILES_PORT ?? 8791)

export function createFilesRouter(): express.Router {
	const router = express.Router()

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

		let upstream: Response
		try {
			// v1: no timeout — a hung file-server hangs the request (localhost, single user).
			upstream = await fetch(`http://127.0.0.1:${filesPort()}/${rel}`)
		} catch {
			return void sendPage(502, 'File server unavailable', 'The file-server (:8791) is not responding. Is the stack service running?')
		}
		if (upstream.status === 403) return void sendPage(403, 'Forbidden', 'That path escapes the served home directory.')
		if (upstream.status !== 200) return void sendPage(404, 'Not found', `${decodedRel} does not exist (or is a directory).`)

		const ext = path.extname(decodedRel).toLowerCase()
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
			const type = upstream.headers.get('content-type')
			if (type) res.set('content-type', type)
			return void res.send(Buffer.from(await upstream.arrayBuffer()))
		}
		return void sendPage(200, 'Unsupported type', `"${ext || '(no extension)'}" cannot be shown as a document. v1 renders HTML and Markdown.`)
	})

	return router
}
