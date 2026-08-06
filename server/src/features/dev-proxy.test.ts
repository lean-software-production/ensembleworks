/** /dev/{port} injecting proxy: HTML injected, other types streamed, headers preserved, WS passthrough works. Run: bun server/src/features/dev-proxy.test.ts */
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import type { Socket } from 'node:net'
import WebSocketImpl, { WebSocketServer } from 'ws'
import { createDevProxyRouter, handleDevUpgrade } from './dev-proxy.ts'

// Fake dev server.
const dev = http.createServer((req, res) => {
	if (req.url === '/') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end('<!doctype html><html><body><h1>hi</h1></body></html>')
	} else if (req.url === '/chunked') {
		// No content-length set, multiple writes -> node sends this
		// transfer-encoding: chunked. The proxy must still reassemble it
		// correctly AND must not forward that header onto its own
		// (un-chunked, single res.end()) response.
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.write('<!doctype html><html><body><h1>chunked')
		res.write('-hi</h1></body></html>')
		res.end()
	} else if (req.url === '/app.js') {
		res.writeHead(200, { 'content-type': 'application/javascript' })
		res.end('console.log("</body> not html")')
	} else {
		res.writeHead(404); res.end('nope')
	}
})
// Fake dev server's own WS endpoint (e.g. HMR) — echoes messages back and
// tracks whether the client's close propagated to it.
const devWss = new WebSocketServer({ noServer: true })
let devSocketClosed = false
// A second endpoint whose handshake completes ~300ms late — reproduces the
// fix-round-2 CRITICAL race: a client that aborts while our proxy is still
// mid-dial to this upstream.
let slowConnOpened = false
let slowConnClosed = false
dev.on('upgrade', (req, socket, head) => {
	if (req.url === '/ws-echo') {
		devWss.handleUpgrade(req, socket, head, (ws) => {
			ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
			ws.on('close', () => { devSocketClosed = true })
		})
	} else if (req.url === '/ws-slow') {
		// Tracks the raw TCP connection, independent of whether the delayed
		// handshake below ever completes — when our proxy aborts its
		// still-connecting upstream dial (the race under test), it tears
		// this socket down well before the 300ms timer fires, so the
		// handshake normally never completes at all. That IS the proof the
		// abandoned connection got closed rather than leaked.
		socket.once('close', () => { slowConnClosed = true })
		setTimeout(() => {
			// A real dev server's own upgrade path would see the same dead
			// socket in this situation; guard it here rather than let a
			// fake-server artifact crash the test itself.
			if (socket.destroyed || !socket.writable) return
			devWss.handleUpgrade(req, socket, head, () => { slowConnOpened = true })
		}, 300)
	} else {
		socket.destroy()
	}
})
await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r))
const devPort = (dev.address() as { port: number }).port

const app = express()
app.use(createDevProxyRouter())
const proxy = http.createServer(app)
proxy.on('upgrade', (req, socket, head) => handleDevUpgrade(req, socket as Socket, head))
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
const wsBase = `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`

{
	const res = await fetch(`${base}/dev/${devPort}/`)
	const body = await res.text()
	assert.equal(res.status, 200)
	assert.ok(body.includes('<h1>hi</h1>'), 'original HTML present')
	assert.ok(body.includes('ew-dev-error'), 'dev injection applied to HTML')
	assert.ok(body.includes(`/dev/${devPort}`), 'URL patch is per-port')
}
{
	const res = await fetch(`${base}/dev/${devPort}/chunked`)
	const body = await res.text()
	assert.equal(res.status, 200)
	assert.ok(body.includes('<h1>chunked-hi</h1>'), 'chunked upstream body reassembled correctly')
	assert.ok(body.includes('ew-dev-error'), 'chunked HTML still gets injected')
	assert.equal(
		res.headers.get('transfer-encoding'),
		null,
		'upstream transfer-encoding is not forwarded onto our un-chunked response'
	)
}
{
	const res = await fetch(`${base}/dev/${devPort}/app.js`)
	const body = await res.text()
	assert.equal(res.headers.get('content-type'), 'application/javascript')
	assert.ok(!body.includes('ew-dev-error'), 'non-HTML untouched')
	assert.ok(body.includes('</body> not html'), 'byte-identical passthrough')
	// Proxied dev responses must never be browser-cacheable: the same
	// root-absolute URL (/@vite/client, /src/*) can be served by different
	// backends depending on Referer, and the HTTP cache keys only on URL —
	// a cached body from one backend replayed for another kills HMR.
	assert.equal(res.headers.get('cache-control'), 'no-store', 'passthrough responses are no-store')
	assert.equal(res.headers.get('etag'), null, 'no etag survives (no conditional revalidation)')
	assert.equal(res.headers.get('vary'), 'Referer', 'vary marks the Referer-dependence')
}
{
	const res = await fetch(`${base}/dev/${devPort}/`)
	assert.equal(res.headers.get('cache-control'), 'no-store', 'injected HTML is no-store too')
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
{
	// WS passthrough: a real round-trip through the proxy's HTTP server (the
	// original raw-socket splice never worked under Bun — see Critical 1 —
	// so this is the regression guard for that).
	const client = new WebSocketImpl(`${wsBase}/dev/${devPort}/ws-echo`)
	await new Promise<void>((resolve, reject) => {
		client.once('open', () => resolve())
		client.once('error', reject)
	})
	const echoed = await new Promise<string>((resolve, reject) => {
		client.once('message', (data) => resolve(data.toString()))
		client.once('error', reject)
		client.send('ping')
	})
	assert.equal(echoed, 'ping', 'message round-trips through the proxy to the upstream dev server and back')

	client.close()
	await new Promise<void>((resolve) => client.once('close', resolve))
	// Give the upstream a tick to observe the propagated close.
	await new Promise((r) => setTimeout(r, 100))
	assert.ok(devSocketClosed, "closing the client's connection propagates to the upstream dev server")
}
{
	// CRITICAL (fix round 2): client aborts the WS upgrade while the upstream
	// dial is still in flight. Previously this crashed the whole process —
	// wss.handleUpgrade threw synchronously into a dead socket once the
	// delayed upstream 'open' finally fired (Bun-specific), and in the
	// meantime the upstream lost its only 'error' listener, so a later
	// ECONNRESET was itself unhandled and fatal too. If this test file
	// reaches its final console.log below, the process survived.
	const client = new WebSocketImpl(`${wsBase}/dev/${devPort}/ws-slow`)
	client.on('error', () => {})
	await new Promise((r) => setTimeout(r, 100))
	client.terminate()

	// The upstream's handshake is deliberately delayed ~300ms; wait past that
	// plus slack for our close-propagation to land.
	await new Promise((r) => setTimeout(r, 500))

	// Aborting well before the 300ms delayed handshake normally tears the
	// connection down before it can ever complete, so slowConnOpened is not
	// asserted here — it exists only so a future timing change that lets the
	// handshake occasionally win the race is visible, not treated as a bug.
	assert.ok(slowConnClosed, 'the abandoned upstream connection was closed rather than leaked')
	void slowConnOpened

	// The process (and this test file) is still alive to prove the crash is
	// fixed; confirm a completely unrelated, normal round-trip still works
	// too — nothing about handling the aborted upgrade left the proxy in a
	// bad state for the next one.
	const sane = new WebSocketImpl(`${wsBase}/dev/${devPort}/ws-echo`)
	await new Promise<void>((resolve, reject) => {
		sane.once('open', () => resolve())
		sane.once('error', reject)
	})
	const echoed = await new Promise<string>((resolve, reject) => {
		sane.once('message', (data) => resolve(data.toString()))
		sane.once('error', reject)
		sane.send('still alive')
	})
	assert.equal(echoed, 'still alive', 'a subsequent normal WS round-trip still works after the aborted one')
	sane.close()
}
{
	// Upstream dev server down for a WS upgrade → the socket is closed with a
	// 502, not left hanging.
	const client = new WebSocketImpl(`${wsBase}/dev/1/ws-echo`)
	// A refused connection can emit more than one 'error' — the assertion
	// below only needs the first; swallow the rest so an unconsumed second
	// emission doesn't crash the process (node/bun throw on an error event
	// with no listener).
	client.on('error', () => {})
	const failure = await new Promise<{ code: number }>((resolve) => {
		client.once('unexpected-response', (_req, res) => resolve({ code: res.statusCode ?? 0 }))
		client.once('error', () => resolve({ code: -1 }))
		client.once('close', (code) => resolve({ code }))
	})
	assert.ok(failure.code !== 101, 'refused WS upstream does not silently succeed the upgrade')
}
dev.close(); proxy.close()
console.log('dev-proxy.test.ts OK')
