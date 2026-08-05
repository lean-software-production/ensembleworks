/** /dev/{port} injecting proxy: HTML injected, other types streamed, headers preserved. Run: bun server/src/features/dev-proxy.test.ts */
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { createDevProxyRouter } from './dev-proxy.ts'

// Fake dev server.
const dev = http.createServer((req, res) => {
	if (req.url === '/') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end('<!doctype html><html><body><h1>hi</h1></body></html>')
	} else if (req.url === '/app.js') {
		res.writeHead(200, { 'content-type': 'application/javascript' })
		res.end('console.log("</body> not html")')
	} else {
		res.writeHead(404); res.end('nope')
	}
})
await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r))
const devPort = (dev.address() as { port: number }).port

const app = express()
app.use(createDevProxyRouter())
const proxy = http.createServer(app)
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`

{
	const res = await fetch(`${base}/dev/${devPort}/`)
	const body = await res.text()
	assert.equal(res.status, 200)
	assert.ok(body.includes('<h1>hi</h1>'), 'original HTML present')
	assert.ok(body.includes('ew-dev-error'), 'dev injection applied to HTML')
	assert.ok(body.includes(`/dev/${devPort}`), 'URL patch is per-port')
}
{
	const res = await fetch(`${base}/dev/${devPort}/app.js`)
	const body = await res.text()
	assert.equal(res.headers.get('content-type'), 'application/javascript')
	assert.ok(!body.includes('ew-dev-error'), 'non-HTML untouched')
	assert.ok(body.includes('</body> not html'), 'byte-identical passthrough')
}
{
	const res = await fetch(`${base}/dev/${devPort}/missing`)
	assert.equal(res.status, 404, 'upstream status preserved')
}
{
	// Dev server down → 502-style error page, not a hang.
	const res = await fetch(`${base}/dev/1/`)
	assert.equal(res.status, 502)
}
dev.close(); proxy.close()
console.log('dev-proxy.test.ts OK')
