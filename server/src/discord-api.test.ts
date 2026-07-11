// Contract tests for the Discord bindings HTTP API (B2).
// Boots the express app in-process via createSyncApp against a throwaway data
// dir, then exercises POST/GET/DELETE /api/discord/bindings plus validation.
// Run with: bun src/discord-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { makeTestClient } from './test-helpers.ts'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'discord-api-test-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`

	const { postJson, getJson } = makeTestClient(base)

	// create
	const created = await postJson('/api/discord/bindings', {
		room: 'test', guildId: 'g1', channelId: 'c1', direction: 'in',
		route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } },
	})
	assert.equal(created.status, 200)
	assert.ok(created.body.id, 'returns id')
	assert.equal(created.body.binding.createdBy, 'anonymous')

	// list
	const list = await getJson('/api/discord/bindings?room=test')
	assert.equal(list.status, 200)
	assert.equal(list.body.bindings.length, 1)
	assert.equal(list.body.bindings[0].channelId, 'c1')

	// validation: bad direction → 400
	const bad = await postJson('/api/discord/bindings', { room: 'test', guildId: 'g', channelId: 'c', direction: 'sideways', route: { handler: 'x' } })
	assert.equal(bad.status, 400)

	// validation: missing handler → 400
	const bad2 = await postJson('/api/discord/bindings', { room: 'test', guildId: 'g', channelId: 'c', direction: 'in', route: {} })
	assert.equal(bad2.status, 400)

	// array params rejected
	const badParams = await postJson('/api/discord/bindings', { room: 'test', guildId: 'g', channelId: 'c', direction: 'in', route: { handler: 'frame-sticky', params: [] } })
	assert.equal(badParams.status, 400)
	// over-long channelId rejected
	const longId = await postJson('/api/discord/bindings', { room: 'test', guildId: 'g', channelId: 'c'.repeat(100), direction: 'in', route: { handler: 'frame-sticky' } })
	assert.equal(longId.status, 400)

	// delete
	const del = await fetch(`${base}/api/discord/bindings?id=${encodeURIComponent(created.body.id)}`, { method: 'DELETE' })
	assert.equal(del.status, 200)
	const empty = await getJson('/api/discord/bindings?room=test')
	assert.equal(empty.body.bindings.length, 0)

	// delete without id → 400
	const delMissing = await fetch(`${base}/api/discord/bindings`, { method: 'DELETE' })
	assert.equal(delMissing.status, 400)

	// POST /api/discord/post — server → bot mediator (E3).
	{
		const priorPort = process.env.DISCORD_PORT
		const priorSecret = process.env.DISCORD_INTERNAL_SECRET
		// Stub bot: records the loopback /post it receives, returns 2xx.
		const received: { secret: string | null; body: any }[] = []
		const stub = Bun.serve({
			port: 0,
			async fetch(req) {
				if (new URL(req.url).pathname === '/post' && req.method === 'POST') {
					received.push({ secret: req.headers.get('x-internal-secret'), body: await req.json() })
					return Response.json({ ok: true })
				}
				return new Response('not found', { status: 404 })
			},
		})
		try {
			process.env.DISCORD_PORT = String(stub.port)
			process.env.DISCORD_INTERNAL_SECRET = 'testsecret'

			// Outbound binding for room 'test'.
			const outCreated = await postJson('/api/discord/bindings', {
				room: 'test', guildId: 'g', channelId: 'chan-out', direction: 'out',
				route: { handler: 'summary', params: {} },
			})
			assert.equal(outCreated.status, 200)

			// Trigger the post — should forward to the stub bot once.
			const posted = await postJson('/api/discord/post', { room: 'test', kind: 'summary', data: { text: 'we shipped' } })
			assert.equal(posted.status, 200)
			assert.equal(posted.body.delivered, 1)
			assert.equal(received.length, 1)
			const forwarded = received[0]
			assert.ok(forwarded, 'stub bot received a forward')
			assert.equal(forwarded.secret, 'testsecret')
			assert.equal(forwarded.body.channelId, 'chan-out')
			assert.equal(forwarded.body.payload.kind, 'summary')
			assert.equal(forwarded.body.payload.room, 'test')
			assert.equal(forwarded.body.payload.data.text, 'we shipped')

			// Room with no outbound binding → delivered 0, still ok.
			const none = await postJson('/api/discord/post', { room: 'unbound', kind: 'summary', data: { text: 'x' } })
			assert.equal(none.status, 200)
			assert.equal(none.body.ok, true)
			assert.equal(none.body.delivered, 0)

			// Bot down (closed port) → fail-soft: 200, delivered 0, no hang/500.
			// Port 1 is privileged and unbound in test env → connection refused fast.
			process.env.DISCORD_PORT = '1'
			const down = await postJson('/api/discord/post', { room: 'test', kind: 'summary', data: { text: 'lost' } })
			assert.equal(down.status, 200)
			assert.equal(down.body.ok, true)
			assert.equal(down.body.delivered, 0)
			process.env.DISCORD_PORT = String(stub.port)

			// Validation: bad kind → 400.
			const badKind = await postJson('/api/discord/post', { room: 'test', kind: 'nope', data: {} })
			assert.equal(badKind.status, 400)
		} finally {
			stub.stop()
			if (priorPort === undefined) delete process.env.DISCORD_PORT
			else process.env.DISCORD_PORT = priorPort
			if (priorSecret === undefined) delete process.env.DISCORD_INTERNAL_SECRET
			else process.env.DISCORD_INTERNAL_SECRET = priorSecret
		}
	}

	// GET /api/discord/resolve — channel → inbound binding reverse lookup (F1).
	{
		// Inbound binding on chan-in.
		const inCreated = await postJson('/api/discord/bindings', {
			room: 'test', guildId: 'g', channelId: 'chan-in', direction: 'in',
			route: { handler: 'frame-sticky', params: { frame: 'Ideas' } },
		})
		assert.equal(inCreated.status, 200)

		// Resolve chan-in → the inbound binding.
		const resolved = await getJson('/api/discord/resolve?channelId=chan-in')
		assert.equal(resolved.status, 200)
		assert.equal(resolved.body.bindings.length, 1)
		const binding = resolved.body.bindings[0]
		assert.ok(binding, 'resolve returns a binding')
		assert.equal(binding.room, 'test')
		assert.equal(binding.route.handler, 'frame-sticky')
		assert.equal(binding.route.params.frame, 'Ideas')

		// Unbound channel → no bindings.
		const nope = await getJson('/api/discord/resolve?channelId=nope')
		assert.equal(nope.status, 200)
		assert.equal(nope.body.bindings.length, 0)

		// Outbound binding: resolve (inbound-only) must not match it.
		const outCreated = await postJson('/api/discord/bindings', {
			room: 'test', guildId: 'g', channelId: 'chan-out-only', direction: 'out',
			route: { handler: 'summary', params: {} },
		})
		assert.equal(outCreated.status, 200)
		const outResolved = await getJson('/api/discord/resolve?channelId=chan-out-only')
		assert.equal(outResolved.status, 200)
		assert.equal(outResolved.body.bindings.length, 0)

		// Missing channelId → 400.
		const missing = await getJson('/api/discord/resolve')
		assert.equal(missing.status, 400)
	}

	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve()))
	)
	console.log('ok: discord-api')
	console.log('ok: discord-post')
	console.log('ok: discord-resolve')
	process.exit(0)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
