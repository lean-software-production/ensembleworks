import assert from 'node:assert/strict'
import { SyncServerClient } from './syncClient.ts'

const received: { path: string; body: any; contentType: string | null }[] = []
const srv = Bun.serve({
	port: 0,
	async fetch(req) {
		received.push({
			path: new URL(req.url).pathname,
			body: await req.json(),
			contentType: req.headers.get('content-type'),
		})
		return Response.json({ ok: true, id: 'shape:new' })
	},
})
const base = `http://127.0.0.1:${srv.port}`
const client = new SyncServerClient(base)

const id = await client.createSticky({ room: 'planning', frame: 'Ideas', text: 'hi', author: 'alice (Discord)' })
assert.equal(id, 'shape:new')
const first = received[0]
assert.ok(first, 'request was received')
assert.equal(first.path, '/api/canvas/sticky')
assert.equal(first.body.room, 'planning')
assert.equal(first.body.frame, 'Ideas')
assert.equal(first.body.text, 'hi')
assert.equal(first.body.author, 'alice (Discord)')
assert.ok((first.contentType ?? '').includes('application/json'))

// non-ok response → throws
const bad = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) })
const badClient = new SyncServerClient(`http://127.0.0.1:${bad.port}`)
let threw = false
try { await badClient.createSticky({ room: 'r', text: 'x' }) } catch { threw = true }
assert.equal(threw, true, 'non-ok status throws')

srv.stop()
bad.stop()
console.log('ok: syncClient')
