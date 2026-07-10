import assert from 'node:assert/strict'
import { makeBindingResolver } from './bindingResolver.ts'

let hits = 0
const srv = Bun.serve({
	port: 0,
	fetch(req) {
		hits++
		const channelId = new URL(req.url).searchParams.get('channelId')
		if (channelId === 'c1') {
			return Response.json({ ok: true, bindings: [{ room: 'planning', guildId: 'g', channelId: 'c1', direction: 'in', route: { handler: 'frame-sticky', params: { frame: 'Ideas' } }, createdBy: 'u', createdAt: 1 }] })
		}
		return Response.json({ ok: true, bindings: [] })
	},
})
const base = `http://127.0.0.1:${srv.port}`

const resolve = makeBindingResolver({ syncBase: base, ttlMs: 10_000 })

// maps server bindings → ResolvedBinding { room, route }
const r1 = await resolve('c1')
assert.equal(r1.length, 1)
assert.equal(r1[0]!.room, 'planning')
assert.equal(r1[0]!.route.handler, 'frame-sticky')
assert.equal(r1[0]!.route.params.frame, 'Ideas')
assert.equal(hits, 1)

// cached within TTL — no second server hit
const r2 = await resolve('c1')
assert.equal(r2.length, 1)
assert.equal(hits, 1, 'second call within TTL is served from cache')

// unbound channel → []
const r3 = await resolve('nope')
assert.equal(r3.length, 0)

srv.stop()

// fail-safe: server down → [] (no throw)
const resolveDown = makeBindingResolver({ syncBase: 'http://127.0.0.1:1', ttlMs: 10_000 })
const r4 = await resolveDown('whatever')
assert.deepEqual(r4, [])

console.log('ok: bindingResolver')
