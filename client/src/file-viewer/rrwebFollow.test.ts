// client/src/file-viewer/rrwebFollow.test.ts
// Run with: bun src/file-viewer/rrwebFollow.test.ts
import assert from 'node:assert/strict'
import { rrwebFollowStore, type RrwebEntry } from './rrwebFollow'

function collect(shapeId: string) {
	const got: RrwebEntry[] = []
	const unsub = rrwebFollowStore.subscribe(shapeId, (entries) => got.push(...entries))
	return { got, unsub }
}

function main() {
	// Backlog then live: delivered in order, deduped.
	const a = collect('shape:a')
	rrwebFollowStore.seedBacklog('shape:a', {
		presentId: 'p1',
		truncated: false,
		entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }],
	})
	rrwebFollowStore.ingest({ shapeId: 'shape:a', presentId: 'p1', entries: [{ seq: 1, event: 'snap' }, { seq: 2, event: 'mut' }] })
	assert.deepEqual(a.got.map((e) => e.seq), [0, 1, 2])

	// Live BEFORE backlog: buffered, then spliced without dupes or gaps.
	const b = collect('shape:b')
	rrwebFollowStore.ingest({ shapeId: 'shape:b', presentId: 'p1', entries: [{ seq: 2, event: 'mut' }] })
	assert.equal(b.got.length, 0, 'live-before-backlog is buffered')
	rrwebFollowStore.seedBacklog('shape:b', {
		presentId: 'p1',
		truncated: false,
		entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }, { seq: 2, event: 'mut' }],
	})
	assert.deepEqual(b.got.map((e) => e.seq), [0, 1, 2])

	// New presentId resets the stream.
	rrwebFollowStore.ingest({ shapeId: 'shape:b', presentId: 'p2', entries: [{ seq: 0, event: 'meta2' }] })
	rrwebFollowStore.seedBacklog('shape:b', { presentId: 'p2', truncated: false, entries: [{ seq: 0, event: 'meta2' }] })
	assert.equal(b.got.filter((e) => e.event === 'meta2').length, 1)

	// Unsubscribe stops delivery; clear() drops state.
	a.unsub()
	rrwebFollowStore.ingest({ shapeId: 'shape:a', presentId: 'p1', entries: [{ seq: 3, event: 'x' }] })
	assert.deepEqual(a.got.map((e) => e.seq), [0, 1, 2])
	rrwebFollowStore.clear('shape:a')

	// Auto-seed on seq 0: ingest batch containing seq 0 with no prior seed → subscriber receives immediately.
	const c = collect('shape:c')
	rrwebFollowStore.ingest({ shapeId: 'shape:c', presentId: 'p1', entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }] })
	assert.deepEqual(c.got.map((e) => e.seq), [0, 1], 'seq 0 should auto-seed and deliver immediately')
	// Later seedBacklog for the same presentId must not re-deliver duplicates.
	rrwebFollowStore.seedBacklog('shape:c', {
		presentId: 'p1',
		truncated: false,
		entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }, { seq: 2, event: 'mut' }],
	})
	assert.deepEqual(c.got.map((e) => e.seq), [0, 1, 2], 'backlog should only deliver new seq 2, not re-deliver 0,1')

	// Regression: live-at-seq>0 before seed still buffers.
	const d = collect('shape:d')
	rrwebFollowStore.ingest({ shapeId: 'shape:d', presentId: 'p1', entries: [{ seq: 5, event: 'late' }] })
	assert.equal(d.got.length, 0, 'seq>0 without backlog should still buffer')
	rrwebFollowStore.seedBacklog('shape:d', {
		presentId: 'p1',
		truncated: false,
		entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }, { seq: 5, event: 'late' }],
	})
	assert.deepEqual(d.got.map((e) => e.seq), [0, 1, 5], 'buffered entry delivered after backlog')

	// Truncation notification: the server's final message carries no entries
	// (overflow degrade) — subscribers must still be told, once, so a live
	// mirror can fall back instead of stalling silently forever.
	const e = collect('shape:e')
	rrwebFollowStore.seedBacklog('shape:e', {
		presentId: 'p1',
		truncated: false,
		entries: [{ seq: 0, event: 'meta' }, { seq: 1, event: 'snap' }],
	})
	const metas: { presentId: string; truncated: boolean }[] = []
	const unsub2 = rrwebFollowStore.subscribe('shape:e', (_entries, meta) => metas.push(meta))
	rrwebFollowStore.ingest({ shapeId: 'shape:e', presentId: 'p1', truncated: true, entries: [] })
	assert.equal(e.got.length, 2, 'no new entries delivered by the truncation message')
	assert.ok(
		metas.some((m) => m.truncated === true),
		'subscriber notified of truncation despite empty entries'
	)
	// Repeat truncated messages after the first must not re-notify.
	const notifyCountBefore = metas.length
	rrwebFollowStore.ingest({ shapeId: 'shape:e', presentId: 'p1', truncated: true, entries: [] })
	assert.equal(metas.length, notifyCountBefore, 'truncation notified once, not on every subsequent message')
	unsub2()
	e.unsub()

	console.log('rrwebFollow tests passed')
}

main()
