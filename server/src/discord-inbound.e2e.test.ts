// Inbound end-to-end: a Discord message travels the full bot pipeline
// (FakeGateway → Router → frame-sticky handler → SyncServerClient → the real
// in-process sync server's POST /api/canvas/sticky) and lands as a note shape
// in the bound frame. No real Discord, no network beyond loopback.
// Run with: bun src/discord-inbound.e2e.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { FakeGateway } from '../../discord/src/adapter.fake.ts'
import { Router } from '../../discord/src/router.ts'
import { SyncServerClient } from '../../discord/src/syncClient.ts'
import { makeFrameStickyHandler } from '../../discord/src/handlers/frameSticky.ts'

const FRAME_ID = 'shape:frame-inbound'

async function main() {
	// 1. Boot the real app against a throwaway data dir on an ephemeral port.
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'discord-e2e-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${(address as any).port}`

	// 2. Seed a named frame in room 'test'. A fresh room already contains
	// document:document and page:page. (Frame record copied from canvas-api.test.ts.)
	const room = getOrCreateRoom('test')
	await room.updateStore((store) => {
		store.put({
			id: FRAME_ID,
			typeName: 'shape',
			type: 'frame',
			x: 1000,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 800, h: 600, name: 'Ideas — inbound', color: 'black' },
			parentId: 'page:page',
			index: 'a2',
		} as any)
	})

	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)

	// 3. Wire the bot inbound pipeline against the real server.
	const client = new SyncServerClient(base)
	const registry = { 'frame-sticky': makeFrameStickyHandler(client) }
	// resolveBinding: channel 'c1' → the seeded frame by NAME (fuzzy 'ideas'
	// matches 'Ideas — inbound'); any other channel is unbound.
	const resolveBinding = async (channelId: string) =>
		channelId === 'c1'
			? [{ room: 'test', route: { handler: 'frame-sticky', params: { frame: 'ideas' } } }]
			: []
	const router = new Router({ registry, resolveBinding })

	// 4. FakeGateway.emit is SYNCHRONOUS and does NOT await handlers, so capture
	// the dispatch promise and await it before asserting.
	const gw = new FakeGateway()
	let pending: Promise<void> = Promise.resolve()
	gw.onMessage((m) => {
		pending = router.handle(m)
	})

	// 5. A Discord message from a human arrives on the bound channel.
	gw.emit({
		channelId: 'c1',
		guildId: 'g1',
		authorId: 'u1',
		authorName: 'alice',
		isBot: false,
		content: 'from discord',
	})
	await pending

	// 6. Assert a note landed in the frame, attributed to the Discord author.
	const note = documents().find(
		(r) =>
			r.typeName === 'shape' &&
			r.type === 'note' &&
			JSON.stringify(r.props?.richText ?? '').includes('from discord')
	)
	assert.ok(note, 'a note with the message text was created')
	assert.equal(note.parentId, FRAME_ID, 'note is parented to the bound frame')
	assert.ok(
		JSON.stringify(note.props.richText).match(/alice.*Discord/i),
		'note carries the Discord author badge'
	)
	console.log('ok: discord message became a sticky in the bound frame')

	// 7. A bot message on the same channel is ignored (echo guard) — no second note.
	const before = documents().filter((r) => r.type === 'note').length
	gw.emit({
		channelId: 'c1',
		guildId: 'g1',
		authorId: 'b',
		authorName: 'bot',
		isBot: true,
		content: 'echo',
	})
	await pending
	const after = documents().filter((r) => r.type === 'note').length
	assert.equal(after, before, 'bot message did not create a note (echo guard)')
	console.log('ok: bot message ignored by the echo guard')

	server.close()
	console.log('ok: discord inbound e2e (message → sticky in frame)')
	process.exit(0)
}
main().catch((e) => {
	console.error(e)
	process.exit(1)
})
