// /files/* route: md render+inject, html inject, asset passthrough, gateway 501,
// styled 404/502, unsupported type page.
// Run with: bun src/files-route.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveFile } from './file-server-core.ts'

async function main() {
	// fake agent home + real file-server core on an ephemeral port
	const home = await mkdtemp(path.join(os.tmpdir(), 'files-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<html><body><h1>R</h1></body></html>')
	await writeFile(path.join(home, 'docs', 'n.md'), '# Notes')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{color:red}')
	await writeFile(path.join(home, 'docs', 'x.bin'), 'xx')
	const fs = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://i')
		const served = await serveFile(home, u.pathname.replace(/^\/+/, ''))
		res.writeHead(served.status, served.headers)
		res.end(served.body ?? undefined)
	})
	await new Promise<void>((r) => fs.listen(0, '127.0.0.1', () => r()))
	const fsPort = (fs.address() as { port: number }).port
	process.env.ENSEMBLEWORKS_FILES_PORT = String(fsPort)

	const { createSyncApp } = await import('./app.ts')
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'files-app-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, () => r()))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

	// html: passes through WITH the bridge injected, no-store
	const rHtml = await fetch(`${base}/files/docs/r.html`)
	assert.equal(rHtml.status, 200)
	assert.equal(rHtml.headers.get('cache-control'), 'no-store')
	assert.equal(rHtml.headers.get('access-control-allow-origin'), '*', 'ACAO for opaque-origin sibling fetch')
	const htmlText = await rHtml.text()
	assert.ok(htmlText.includes('<h1>R</h1>') && htmlText.includes('ew-file-viewer-ready'), 'html + bridge')

	// markdown: rendered to styled html with bridge
	const rMd = await fetch(`${base}/files/docs/n.md`)
	const mdText = await rMd.text()
	assert.ok(mdText.includes('<h1>Notes</h1>') && mdText.includes('ew-scroll'), 'md rendered + bridge')

	// asset: raw passthrough, upstream content-type
	const rCss = await fetch(`${base}/files/docs/s.css`)
	assert.equal(await rCss.text(), 'body{color:red}')
	assert.ok((rCss.headers.get('content-type') ?? '').includes('text/css'))
	assert.equal(rCss.headers.get('access-control-allow-origin'), '*', 'assets carry ACAO too')

	// unsupported top-level type → styled page (200 with explanation; assert content)
	const rBin = await fetch(`${base}/files/docs/x.bin`)
	assert.ok((await rBin.text()).toLowerCase().includes('unsupported'), 'unsupported page')

	// missing file → styled 404 page
	const r404 = await fetch(`${base}/files/docs/nope.html`)
	assert.equal(r404.status, 404)
	assert.ok((await r404.text()).includes('<h1>'), 'styled, not bare')

	// gateway param → 501
	const rGw = await fetch(`${base}/files/docs/r.html?gateway=vm-1`)
	assert.equal(rGw.status, 501)

	// file-server down → styled 502
	fs.close()
	await new Promise((r) => setTimeout(r, 50))
	const r502 = await fetch(`${base}/files/docs/r.html`)
	assert.equal(r502.status, 502)

	console.log('ok: files-route')
	server.close()
	process.exit(0)
}

main()
