/**
 * file-server — read-only portal onto the invoking user's $HOME (:8791).
 * In prod this runs AS the agent sandbox user (systemd unit; the sync server's
 * app user cannot read that home). Localhost-only; the sync server's /files/*
 * route is the sole consumer. Raw bytes only — markdown rendering and script
 * injection happen at the route, so this stays a dumb byte reader that a future
 * remote connector can reimplement.
 */
import http from 'node:http'
import os from 'node:os'
import { serveFile } from './file-server-core.ts'

const PORT = Number(process.env.PORT ?? 8791)
const ROOT = process.env.ENSEMBLEWORKS_FILES_ROOT ?? os.homedir()

const server = http.createServer(async (req, res) => {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405).end()
		return
	}
	const url = new URL(req.url ?? '/', 'http://internal')
	const served = await serveFile(ROOT, url.pathname.replace(/^\/+/, ''))
	res.writeHead(served.status, served.headers)
	res.end(req.method === 'HEAD' ? undefined : (served.body ?? undefined))
})

server.listen(PORT, '127.0.0.1', () => {
	console.log(`ensembleworks file-server on 127.0.0.1:${PORT} serving ${ROOT} (read-only)`)
})
