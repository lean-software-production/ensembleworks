// Run: bun src/canvas-v2/store.test.ts
// Locks CanvasV2Store's on-disk contract: append-only update log + a single
// compactable snapshot row, one SQLite file per room, crash-safe across
// process restarts (a fresh instance on the same file sees identical state).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CanvasV2Store } from './store.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'canvas-v2-store-'))

// --- REQUIRED PROBE: does bun:sqlite copy a Uint8Array blob at run() time, or
// alias the caller's buffer? The DocumentActor (Task C2) will hand
// appendUpdate a payload that ALIASES a reused frame buffer (see
// server-peer.ts's onUpdatePayload JSDoc: decode() is zero-copy). If
// bun:sqlite does NOT copy at bind time, mutating that shared buffer after
// the "persisted" call returns would silently corrupt an already-durable row.
// This assertion is the proof either way — see the actor's persist() comment
// for how the result is used.
{
	const probe = new CanvasV2Store(dir, 'probe')
	const buf = new Uint8Array([1, 2, 3, 4])
	probe.appendUpdate(buf)
	buf[0] = 99 // mutate the source AFTER the insert claims to have completed
	const { updates } = probe.load()
	assert.deepEqual(
		Array.from(updates[0]!),
		[1, 2, 3, 4],
		'bun:sqlite copies the blob at bind/run() time — post-insert mutation of the source buffer does not corrupt the stored row',
	)
}

const roomId = 'room-1'
const store = new CanvasV2Store(dir, roomId)

// append 3 -> load = null snapshot + 3 updates, in seq order
store.appendUpdate(new Uint8Array([1]))
store.appendUpdate(new Uint8Array([2]))
store.appendUpdate(new Uint8Array([3]))
{
	const { snapshot, updates } = store.load()
	assert.equal(snapshot, null)
	assert.deepEqual(
		updates.map((u) => Array.from(u)),
		[[1], [2], [3]],
	)
}

// compact -> load = snapshot + 0 updates (folded-in rows pruned)
store.compact(new Uint8Array([9, 9]))
{
	const { snapshot, updates } = store.load()
	assert.deepEqual(Array.from(snapshot!), [9, 9])
	assert.deepEqual(updates, [])
}

// append 1 more -> snapshot + 1 update (only the post-compaction row)
store.appendUpdate(new Uint8Array([4]))
{
	const { snapshot, updates } = store.load()
	assert.deepEqual(Array.from(snapshot!), [9, 9])
	assert.deepEqual(
		updates.map((u) => Array.from(u)),
		[[4]],
	)
}

// reopen on the same file (a fresh instance = a fresh process after restart)
// -> identical load (persistence)
{
	const reopened = new CanvasV2Store(dir, roomId)
	const { snapshot, updates } = reopened.load()
	assert.deepEqual(Array.from(snapshot!), [9, 9])
	assert.deepEqual(
		updates.map((u) => Array.from(u)),
		[[4]],
	)
}

// --- close(): releases the SQLite handle so a registry can evict rooms
// without leaking fds. Closed-handle behavior pinned to what bun:sqlite
// actually does: this store re-prepares on every call, so any post-close use
// hits prepare()'s RangeError "Cannot use a closed database" (a statement
// prepared BEFORE close would refuse run() with "Database has closed" but
// still serve reads — pinned in kernel/sqlite.test.ts). Reopening a fresh
// store on the same file works — close corrupts nothing.
{
	const closable = new CanvasV2Store(dir, 'closable')
	closable.appendUpdate(new Uint8Array([7]))
	closable.close()
	assert.throws(
		() => closable.appendUpdate(new Uint8Array([8])),
		/Cannot use a closed database/,
		'appendUpdate on a closed store errors loudly',
	)
	assert.throws(() => closable.load(), /Cannot use a closed database/, 'load on a closed store errors loudly')
	const reopenedClosable = new CanvasV2Store(dir, 'closable')
	assert.deepEqual(
		reopenedClosable.load().updates.map((u) => Array.from(u)),
		[[7]],
		'a fresh store on the same file sees the pre-close rows',
	)
	reopenedClosable.close()
}

// --- diskBytes(): live on-disk SQLite file size (Task H4, S6 dogfood
// visibility). A high-water mark read by the D3 metrics endpoint. Two
// branches: (1) a real file reports a positive numeric size, non-decreasing
// after a write; (2) the graceful ENOENT branch returns 0 without throwing,
// so a scrape racing a missing/not-yet-created file never crashes the
// metrics endpoint.
{
	const diskProbe = new CanvasV2Store(dir, 'disk-probe')
	const empty = diskProbe.diskBytes()
	assert.equal(typeof empty, 'number', 'diskBytes() is numeric')
	assert.ok(empty > 0, 'a just-created store reports a positive size (SQLite allocates at least one page)')
	diskProbe.appendUpdate(new Uint8Array(256))
	const afterWrite = diskProbe.diskBytes()
	assert.ok(afterWrite >= empty, 'diskBytes() is non-decreasing after a write (high-water mark)')

	// Error branch: with the file removed out from under it, statSync throws
	// ENOENT — diskBytes() must swallow it and return 0, never throw.
	diskProbe.close()
	rmSync(path.join(dir, 'disk-probe.sqlite'), { force: true })
	assert.doesNotThrow(() => diskProbe.diskBytes(), 'diskBytes() never throws even when the file is gone')
	assert.equal(diskProbe.diskBytes(), 0, 'diskBytes() returns 0 (not a throw) when the sqlite file is absent')
}

rmSync(dir, { recursive: true, force: true })
console.log('ok: canvas-v2 store')
