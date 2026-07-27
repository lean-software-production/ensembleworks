// Unit tests for the in-memory rrweb present-event relay log.
// Run with: bun src/present-relay.test.ts
import assert from 'node:assert/strict'
import { createPresentRelay } from './present-relay.ts'

function main() {
	// append + backlog round-trip
	const relay = createPresentRelay()
	const r1 = relay.append('room1', 'shape:a', 'p1', [
		{ seq: 0, event: { type: 4 } },
		{ seq: 1, event: { type: 2 } },
	])
	assert.deepEqual(r1, { accepted: true, truncated: false })
	assert.deepEqual(relay.backlog('room1', 'shape:a'), {
		presentId: 'p1',
		truncated: false,
		entries: [
			{ seq: 0, event: { type: 4 } },
			{ seq: 1, event: { type: 2 } },
		],
	})

	// unknown (room, shape) → empty backlog
	assert.deepEqual(relay.backlog('room1', 'shape:zzz'), { presentId: null, truncated: false, entries: [] })

	// a NEW presentId resets the log (fresh presentation on the same shape)
	relay.append('room1', 'shape:a', 'p2', [{ seq: 0, event: { type: 4 } }])
	const afterReset = relay.backlog('room1', 'shape:a')
	assert.equal(afterReset.presentId, 'p2')
	assert.equal(afterReset.entries.length, 1)

	// stop with the CURRENT presentId clears; stale presentId is a no-op
	relay.stop('room1', 'shape:a', 'p-stale')
	assert.equal(relay.backlog('room1', 'shape:a').presentId, 'p2')
	relay.stop('room1', 'shape:a', 'p2')
	assert.deepEqual(relay.backlog('room1', 'shape:a'), { presentId: null, truncated: false, entries: [] })

	// event cap: overflow flips truncated, further appends rejected
	const tiny = createPresentRelay({ maxEvents: 2 })
	tiny.append('r', 's', 'p', [{ seq: 0, event: 'a' }, { seq: 1, event: 'b' }])
	const over = tiny.append('r', 's', 'p', [{ seq: 2, event: 'c' }])
	assert.deepEqual(over, { accepted: false, truncated: true })
	const b = tiny.backlog('r', 's')
	assert.equal(b.truncated, true)
	assert.equal(b.entries.length, 2)

	// byte cap works the same way
	const small = createPresentRelay({ maxBytes: 10 })
	const overBytes = small.append('r', 's', 'p', [{ seq: 0, event: 'x'.repeat(100) }])
	assert.deepEqual(overBytes, { accepted: false, truncated: true })

	console.log('present-relay tests passed')
}

main()
