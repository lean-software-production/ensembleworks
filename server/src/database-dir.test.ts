// Proves DATABASE_DIR routing in createSyncApp/createRoomHost:
//   - DATABASE_DIR unset  -> rooms resolve under DATA_DIR/rooms/     (today's behavior)
//   - DATABASE_DIR set     -> rooms resolve under DATABASE_DIR/rooms/ (and NOT DATA_DIR/rooms/)
// Run with: bun src/database-dir.test.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

const ROOM_ID = 'dbdirroom'

async function main() {
	// 1. DATABASE_DIR unset: opening a room writes DATA_DIR/rooms/<id>.sqlite.
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-data-'))
		const { server, getOrCreateRoom } = createSyncApp({ dataDir })
		getOrCreateRoom(ROOM_ID).close()
		assert.ok(
			existsSync(path.join(dataDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'unset DATABASE_DIR: room sqlite should live under DATA_DIR/rooms/'
		)
		server.close()
		console.log('ok: DATABASE_DIR unset -> DATA_DIR/rooms/')
	}

	// 2. DATABASE_DIR set: room sqlite lands under DATABASE_DIR/rooms/, NOT DATA_DIR/rooms/.
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-data-'))
		const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-db-'))
		const { server, getOrCreateRoom } = createSyncApp({ dataDir, databaseDir })
		getOrCreateRoom(ROOM_ID).close()
		assert.ok(
			existsSync(path.join(databaseDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'set DATABASE_DIR: room sqlite should live under DATABASE_DIR/rooms/'
		)
		assert.ok(
			!existsSync(path.join(dataDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'set DATABASE_DIR: room sqlite must NOT be written under DATA_DIR/rooms/'
		)
		server.close()
		console.log('ok: DATABASE_DIR set -> DATABASE_DIR/rooms/ (not DATA_DIR/rooms/)')
	}
}

main().then(
	() => {
		console.log('ok: database-dir.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
