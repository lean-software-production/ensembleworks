// End-to-end file-viewer smoke: scratch file-server + createSyncApp, open a
// shape, serve+render both html and markdown with the bridge injected, raw
// asset passthrough, then refresh bumps rev. One flow, one file.
// Run with: bun src/file-viewer-smoke.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveFile } from './file-server-core.ts'

async function main() {
	// Temp agent home with the three fixture files, served by a scratch
	// file-server core on an ephemeral port (files-route.test.ts scaffold).
	const home = await mkdtemp(path.join(os.tmpdir(), 'file-viewer-smoke-home-'))
	await writeFile(path.join(home, 'report.html'), '<html><body><h1>Smoke</h1></body></html>')
	await writeFile(path.join(home, 'report.md'), '# Smoke MD')
	await writeFile(path.join(home, 'style.css'), 'body{}')

	const fs = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://i')
		const served = await serveFile(home, u.pathname.replace(/^\/+/, ''))
		res.writeHead(served.status, served.headers)
		res.end(served.body ?? undefined)
	})
	await new Promise<void>((r) => fs.listen(0, '127.0.0.1', () => r()))
	const fsPort = (fs.address() as { port: number }).port

	// Env vars must be set before app.ts is imported (files-route.test.ts /
	// file-viewer-api.test.ts pattern).
	process.env.ENSEMBLEWORKS_FILES_PORT = String(fsPort)
	process.env.ENSEMBLEWORKS_AGENT_HOME = home

	const { createSyncApp } = await import('./app.ts')
	const { makeTestClient } = await import('./test-helpers.ts')

	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'file-viewer-smoke-app-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, () => r()))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson } = makeTestClient(base)
	const room = getOrCreateRoom('team')
	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)
	const fileViewers = () => documents().filter((r) => r.typeName === 'shape' && r.type === 'file-viewer')

	// 1. open creates a file-viewer shape with the expected defaults.
	const openRes = await postJson('/api/canvas/file-viewer', {
		room: 'team',
		op: 'open',
		path: 'report.html',
	})
	assert.equal(openRes.status, 200, `open should be 200, got ${JSON.stringify(openRes.body)}`)
	assert.equal(openRes.body.ok, true)
	assert.equal(typeof openRes.body.id, 'string')
	const createdId = openRes.body.id

	let shape = fileViewers().find((r) => r.id === createdId)
	assert.ok(shape, 'a file-viewer shape exists in the room')
	assert.equal(shape.props.path, 'report.html')
	assert.equal(shape.props.rev, 0)
	assert.equal(shape.props.title, 'report.html')
	console.log('ok: open creates a file-viewer shape')

	// 2. GET /files/report.html: passthrough with the bridge injected.
	const rHtml = await fetch(`${base}/files/report.html`)
	assert.equal(rHtml.status, 200)
	const htmlText = await rHtml.text()
	assert.ok(htmlText.includes('<h1>Smoke</h1>'), 'html body preserved')
	assert.ok(htmlText.includes('ew-file-viewer-ready'), 'bridge injected')
	console.log('ok: html served with bridge injected')

	// 3. GET /files/report.md: rendered to styled html with the scroll bridge.
	const rMd = await fetch(`${base}/files/report.md`)
	assert.equal(rMd.status, 200)
	const mdText = await rMd.text()
	assert.ok(mdText.includes('<h1>Smoke MD</h1>'), 'markdown rendered')
	assert.ok(mdText.includes('ew-scroll'), 'scroll bridge injected')
	console.log('ok: markdown rendered with scroll bridge')

	// 4. GET /files/style.css: raw passthrough, no rendering.
	const rCss = await fetch(`${base}/files/style.css`)
	assert.equal(rCss.status, 200)
	assert.equal(await rCss.text(), 'body{}')
	console.log('ok: css served as raw passthrough')

	// 5. refresh bumps rev on the matching shape.
	const refreshRes = await postJson('/api/canvas/file-viewer', {
		room: 'team',
		op: 'refresh',
		path: 'report.html',
	})
	assert.equal(refreshRes.status, 200)
	assert.equal(refreshRes.body.ok, true)
	assert.equal(refreshRes.body.updated, 1)
	shape = fileViewers().find((r) => r.id === createdId)
	assert.equal(shape.props.rev, 1, 'rev bumped to 1')
	console.log('ok: refresh bumps rev')

	room.close()
	console.log('ok: file-viewer smoke')
	server.close()
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
