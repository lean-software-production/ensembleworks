// client/src/file-viewer/rrwebFollow.test.ts
// Run with: bun src/file-viewer/rrwebFollow.test.ts
import assert from 'node:assert/strict'
import { rrwebFollowStore, type RrwebEntry } from './rrwebFollow.ts'

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

	console.log('rrwebFollow tests passed')
}

main()
