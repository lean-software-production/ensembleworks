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
	assert.equal(created.body.binding.createdBy !== undefined, true)

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

	// delete
	const del = await fetch(`${base}/api/discord/bindings/${created.body.id}`, { method: 'DELETE' })
	assert.equal(del.status, 200)
	const empty = await getJson('/api/discord/bindings?room=test')
	assert.equal(empty.body.bindings.length, 0)

	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve()))
	)
	console.log('ok: discord-api')
	process.exit(0)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
