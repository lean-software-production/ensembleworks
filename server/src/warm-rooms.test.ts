// Guards the EW_WARM_ROOMS eager room-load path (see kernel/rooms.ts / app.ts):
// the cutover data-load check boots a FRESH server against a copied DATA_DIR
// and expects /api/health to list every rooms/<name>.sqlite it carries — but
// rooms normally open LAZILY (only on a WS connect or a mutating call), so a
// freshly-booted server reports rooms: [] even though the sqlite files are
// sitting right there, unloaded and unproven against the @tldraw schema.
//
// This test: (1) opens a room so a rooms/<name>.sqlite exists on disk, then
// closes everything; (2) boots a fresh app with EW_WARM_ROOMS unset and
// asserts /api/health lists NO rooms (lazy default preserved); (3) boots
// another fresh app with EW_WARM_ROOMS=1 and asserts /api/health lists the
// room WITHOUT any WS connect or mutating call — proving the warm-load ran.
// Run with: bun src/warm-rooms.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { makeTestClient } from './test-helpers.ts'

const ROOM_ID = 'warmroom'

async function bootApp(dataDir: string) {
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const base = `http://127.0.0.1:${address.port}`
	return { server, getOrCreateRoom, base }
}

async function closeApp(server: import('node:http').Server) {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => (err ? reject(err) : resolve()))
	)
}

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'warm-rooms-test-'))

	// 1. Boot once, open a room (no schema-eager-load involved yet), close down.
	{
		const { server, getOrCreateRoom } = await bootApp(dataDir)
		const room = getOrCreateRoom(ROOM_ID)
		room.close()
		await closeApp(server)
		console.log('ok: room opened once, rooms/<name>.sqlite now on disk')
	}

	// 2. Fresh boot, EW_WARM_ROOMS unset — lazy default preserved: no rooms open.
	{
		delete process.env.EW_WARM_ROOMS
		const { server, base } = await bootApp(dataDir)
		const { getJson } = makeTestClient(base)
		const { status, body } = await getJson('/api/health')
		assert.equal(status, 200, '/api/health should be 200')
		assert.deepEqual(body.rooms, [], 'lazy default: no room should be open without EW_WARM_ROOMS')
		await closeApp(server)
		console.log('ok: EW_WARM_ROOMS unset -> lazy default preserved (rooms: [])')
	}

	// 3. Fresh boot, EW_WARM_ROOMS=1 — the room must be listed WITHOUT any WS
	// connect or mutating call, proving the eager warm-load ran the sqlite
	// through the @tldraw schema at boot.
	{
		process.env.EW_WARM_ROOMS = '1'
		const { server, base } = await bootApp(dataDir)
		const { getJson } = makeTestClient(base)
		const { status, body } = await getJson('/api/health')
		assert.equal(status, 200, '/api/health should be 200')
		assert.deepEqual(body.rooms, [ROOM_ID], 'EW_WARM_ROOMS=1 should eagerly load every rooms/*.sqlite')
		await closeApp(server)
		delete process.env.EW_WARM_ROOMS
		console.log('ok: EW_WARM_ROOMS=1 -> room warm-loaded with no WS connect / mutating call')
	}
}

main().then(
	() => {
		console.log('ok: warm-rooms.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
