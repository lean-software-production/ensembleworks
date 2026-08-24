// /files/* route: md render+inject, html inject, asset passthrough, video with
// byte ranges surviving the proxy hop, gateway 501, styled 404/502,
// unsupported type page.
// Run with: bun src/files-route.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sendServedFile, serveFile } from './file-server-core.ts'

async function main() {
	// fake agent home + real file-server core on an ephemeral port
	const home = await mkdtemp(path.join(os.tmpdir(), 'files-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<html><body><h1>R</h1></body></html>')
	await writeFile(path.join(home, 'docs', 'n.md'), '# Notes')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{color:red}')
	await writeFile(path.join(home, 'docs', 'x.bin'), 'xx')
	await writeFile(path.join(home, 'docs', 'clip.mp4'), 'ABCDEFGHIJ') // 10 bytes
	const fs = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://i')
		const served = await serveFile(home, u.pathname.replace(/^\/+/, ''), { range: req.headers.range })
		sendServedFile(res, served, req.method)
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

	// video: allowlisted asset, real video/mp4 type, range-capable
	const rMp4 = await fetch(`${base}/files/docs/clip.mp4`)
	assert.equal(rMp4.status, 200)
	assert.equal(rMp4.headers.get('content-type'), 'video/mp4')
	assert.equal(rMp4.headers.get('accept-ranges'), 'bytes', 'video must advertise ranges')
	assert.equal(await rMp4.text(), 'ABCDEFGHIJ')

	// Range survives the proxy hop: the route must forward it upstream and pass
	// 206 + content-range back down, or <video> can never seek.
	const rPart = await fetch(`${base}/files/docs/clip.mp4`, { headers: { range: 'bytes=2-4' } })
	assert.equal(rPart.status, 206, 'proxy must pass the upstream 206 through')
	assert.equal(rPart.headers.get('content-range'), 'bytes 2-4/10')
	assert.equal(rPart.headers.get('content-length'), '3')
	assert.equal(await rPart.text(), 'CDE')

	// unsatisfiable range → 416 with the size, not a 404 page
	const r416 = await fetch(`${base}/files/docs/clip.mp4`, { headers: { range: 'bytes=99-200' } })
	assert.equal(r416.status, 416)
	assert.equal(r416.headers.get('content-range'), 'bytes */10')

	// a Range on a rendered document is ignored — the bridge needs the whole file
	const rHtmlRange = await fetch(`${base}/files/docs/r.html`, { headers: { range: 'bytes=0-3' } })
	assert.equal(rHtmlRange.status, 200)
	assert.ok((await rHtmlRange.text()).includes('ew-file-viewer-ready'), 'html still whole + bridged')

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
