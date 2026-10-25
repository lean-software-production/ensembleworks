// Run: bun src/kernel/rooms.test.ts
// Locks RoomHost.listRoomIds(): the rooms directory's *.sqlite basenames unioned
// with the rooms currently open in memory, filtered through sanitizeId, sorted
// ascending, each id exactly once.
import assert from 'node:assert/strict'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRoomHost } from './rooms.ts'

async function roomsDir(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), 'roomhost-'))
}

async function main() {
	// 1. Empty dir -> [].
	{
		const dir = await roomsDir()
		const host = createRoomHost(dir)
		assert.deepEqual(host.listRoomIds(), [], 'empty rooms dir should list no rooms')
		console.log('ok: empty dir -> []')
	}

	// 2. Files on disk -> sorted ascending, extension stripped.
	// The five names below are chosen so that readdirSync's *raw* order is
	// demonstrably unsorted (measured: beta, mid, alpha, yank, zeta), which is
	// what makes the sort load-bearing — a two-file dir comes back in insertion
	// order and would pass even with the sort deleted.
	{
		const dir = await roomsDir()
		for (const name of ['zeta', 'yank', 'alpha', 'mid', 'beta']) {
			writeFileSync(path.join(dir, `${name}.sqlite`), '')
		}
		const host = createRoomHost(dir)
		assert.deepEqual(
			host.listRoomIds(),
			['alpha', 'beta', 'mid', 'yank', 'zeta'],
			'disk rooms should sort ascending'
		)
		console.log('ok: disk rooms -> sorted')
	}

	// 3. Non-.sqlite entries are ignored.
	{
		const dir = await roomsDir()
		writeFileSync(path.join(dir, 'alpha.sqlite'), '')
		writeFileSync(path.join(dir, 'README.md'), '')
		writeFileSync(path.join(dir, 'alpha.sqlite-wal'), '')
		const host = createRoomHost(dir)
		assert.deepEqual(host.listRoomIds(), ['alpha'], 'only *.sqlite entries are rooms')
		console.log('ok: non-.sqlite entries ignored')
	}

	// 4. Ids failing sanitizeId are dropped, never surfaced.
	{
		const dir = await roomsDir()
		writeFileSync(path.join(dir, 'good.sqlite'), '')
		writeFileSync(path.join(dir, 'bad room.sqlite'), '')
		writeFileSync(path.join(dir, `${'x'.repeat(65)}.sqlite`), '')
		const host = createRoomHost(dir)
		assert.deepEqual(host.listRoomIds(), ['good'], 'sanitizeId rejects should be dropped')
		console.log('ok: sanitizeId-failing ids dropped')
	}

	// 5. A room open in memory whose file also exists appears exactly once.
	{
		const dir = await roomsDir()
		const host = createRoomHost(dir)
		const room = host.getOrCreateRoom('live')
		try {
			assert.deepEqual(host.listRoomIds(), ['live'], 'disk ∪ memory must de-duplicate')
		} finally {
			room.close()
		}
		console.log('ok: disk ∪ memory de-duplicated')
	}

	// 6. A room open in memory with NO file on disk is still listed — the
	// documented "opened this process, may not have flushed yet" case. Removing
	// the sqlite files after opening reproduces it without the disk scan being
	// able to supply the id.
	{
		const dir = await roomsDir()
		const host = createRoomHost(dir)
		const room = host.getOrCreateRoom('mem')
		try {
			for (const suffix of ['', '-wal', '-shm']) {
				rmSync(path.join(dir, `mem.sqlite${suffix}`), { force: true })
			}
			assert.deepEqual(readdirSync(dir), [], 'precondition: no room file left on disk')
			assert.deepEqual(host.listRoomIds(), ['mem'], 'in-memory-only rooms must be listed')
		} finally {
			room.close()
		}
		console.log('ok: memory-only room listed')
	}
}

main().then(
	() => {
		console.log('ok: kernel/rooms.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
