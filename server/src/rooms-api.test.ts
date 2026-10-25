// Contract test for GET /api/rooms (room-switcher plan, Task 3).
// Boots the express app in-process via createSyncApp over a throwaway
// databaseDir, then asserts the endpoint's room set, sorting, id filtering,
// participant counts, and that the response parses against the ToolDef's
// zodOutput (the drift anchor between contract and route).
// Run with: bun src/rooms-api.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { kernelRooms } from '@ensembleworks/contracts'
import { createSyncApp } from './app.ts'
import { makeTestClient } from './test-helpers.ts'

async function boot() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rooms-api-data-'))
	const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'rooms-api-db-'))
	const app = createSyncApp({ dataDir, databaseDir })
	await new Promise<void>((resolve) => app.server.listen(0, resolve))
	const address = app.server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const client = makeTestClient(`http://127.0.0.1:${address.port}`)
	return { app, client, roomsDir: path.join(databaseDir, 'rooms') }
}

async function main() {
	// 1. A fresh server with no rooms reports an empty list.
	{
		const { app, client } = await boot()
		const res = await client.getJson(kernelRooms.http.path)
		assert.equal(res.status, 200, 'GET /api/rooms should be mounted')
		assert.deepEqual(res.body, { rooms: [] }, 'fresh server: no rooms')
		app.server.close()
		console.log('ok: fresh server -> { rooms: [] }')
	}

	// 2. Rooms created out of alphabetical order come back sorted, each with
	//    participants: 0 (nobody has published a cursor).
	{
		const { app, client } = await boot()
		app.getOrCreateRoom('beta')
		app.getOrCreateRoom('alpha')
		const res = await client.getJson(kernelRooms.http.path)
		assert.deepEqual(
			res.body,
			{
				rooms: [
					{ id: 'alpha', participants: 0 },
					{ id: 'beta', participants: 0 },
				],
			},
			'two rooms: sorted ascending, zero participants each'
		)
		app.server.close()
		console.log('ok: two rooms -> sorted ids, participants: 0')
	}

	// 3. A stray non-.sqlite file in the rooms dir is not a room.
	{
		const { app, client, roomsDir } = await boot()
		app.getOrCreateRoom('alpha')
		writeFileSync(path.join(roomsDir, 'README.md'), 'not a room\n')
		writeFileSync(path.join(roomsDir, 'alpha.sqlite-wal'), '')
		const res = await client.getJson(kernelRooms.http.path)
		assert.deepEqual(
			res.body.rooms.map((r: { id: string }) => r.id),
			['alpha'],
			'stray non-.sqlite entries must not appear as rooms'
		)
		app.server.close()
		console.log('ok: stray files ignored')
	}

	// 4. Drift anchor: the response parses against the ToolDef's zodOutput.
	{
		const { app, client } = await boot()
		app.getOrCreateRoom('alpha')
		const res = await client.getJson(kernelRooms.http.path)
		const parsed = kernelRooms.zodOutput.safeParse(res.body)
		assert.ok(parsed.success, `response must match kernelRooms.zodOutput: ${JSON.stringify(res.body)}`)
		app.server.close()
		console.log('ok: response parses against kernelRooms.zodOutput')
	}

	// 5. The count is people, not connections: two presence records carrying the
	//    same raw user id (one teammate with two tabs open) count once. This is
	//    what forces buildParticipants(...).length over refs.length — the latter
	//    would report 2 here.
	{
		const { app, client } = await boot()
		const room = app.getOrCreateRoom('alpha') as any
		const rec = {
			userId: 'user:u1',
			userName: 'Ada',
			currentPageId: 'page:1',
			cursor: { x: 0, y: 0 },
			lastActivityTimestamp: 1,
		}
		room.getPresenceRecords = () => ({ a: rec, b: rec })
		const res = await client.getJson(kernelRooms.http.path)
		assert.deepEqual(
			res.body,
			{ rooms: [{ id: 'alpha', participants: 1 }] },
			'two tabs of one teammate must count as one participant'
		)
		app.server.close()
		console.log('ok: two presence records, one user -> participants: 1')
	}
}

main().then(
	() => {
		console.log('ok: rooms-api.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
