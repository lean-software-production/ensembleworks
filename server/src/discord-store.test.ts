import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDiscordStore } from './discord-store.ts'

async function main() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-store-'))
	const store = createDiscordStore(dir)

	const b = await store.create({
		room: 'planning', guildId: 'g1', channelId: 'c1', direction: 'in',
		route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } },
		createdBy: 'alice',
	})
	assert.ok(b.id, 'create returns an id')
	assert.ok(typeof b.createdAt === 'number', 'create stamps createdAt')
	assert.equal((await store.listByRoom('planning')).length, 1)
	assert.equal((await store.listByRoom('other')).length, 0, 'scoped by room')

	const hits = await store.listInboundByChannel('c1')
	assert.equal(hits.length, 1)
	assert.equal(hits[0]!.route.handler, 'frame-sticky')
	assert.equal((await store.listInboundByChannel('nope')).length, 0)

	const out = await store.create({ room: 'r', guildId: 'g', channelId: 'c2', direction: 'out',
		route: { handler: 'summary', params: {} }, createdBy: 'bob' })
	assert.equal((await store.listOutbound('r')).length, 1, 'lists outbound by room')
	assert.equal((await store.listInboundByChannel('c2')).length, 0, 'outbound not matched as inbound')

	await store.remove(b.id)
	assert.equal((await store.listByRoom('planning')).length, 0, 'remove works')

	const reopened = createDiscordStore(dir)
	assert.equal((await reopened.listOutbound('r')).length, 1, 'persists to disk across instances')

	console.log('ok: discord-store')
	process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
