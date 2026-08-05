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

	// Retention: a log survives with no stop() call and no TTL — backlog after
	// arbitrary idle time still returns the last presentation.
	{
		let t = 1000
		const relay = createPresentRelay({ now: () => t })
		relay.append('r', 's', 'p1', [{ seq: 0, event: { a: 1 } }])
		t += 24 * 60 * 60 * 1000 // a day later
		const b = relay.backlog('r', 's')
		assert.equal(b.presentId, 'p1', 'log retained indefinitely (replace-or-restart)')
		assert.equal(b.entries.length, 1)
	}

	// Replacement: a new presentId on the same shape supersedes the old log.
	{
		const relay = createPresentRelay()
		relay.append('r', 's', 'p1', [{ seq: 0, event: { a: 1 } }])
		relay.append('r', 's', 'p2', [{ seq: 0, event: { b: 2 } }])
		const b = relay.backlog('r', 's')
		assert.equal(b.presentId, 'p2', 'new presentation replaced the old log')
		assert.equal(b.entries.length, 1)
	}

	// LRU eviction: total-bytes pressure evicts the least-recently-appended
	// OTHER log instead of truncating the live one.
	{
		let t = 1000
		// Each entry stringifies to ~60 bytes; cap total at ~2 batches.
		const big = () => [{ seq: 0, event: { pad: 'x'.repeat(400) } }]
		const relay = createPresentRelay({ maxTotalBytes: 1000, now: () => t })
		relay.append('r', 'shapeA', 'pA', big())
		t += 1
		relay.append('r', 'shapeB', 'pB', big())
		t += 1
		// Third log pushes past maxTotalBytes → shapeA (oldest) evicted, shapeC accepted.
		const res = relay.append('r', 'shapeC', 'pC', big())
		assert.equal(res.truncated, false, 'live append accepted under pressure')
		assert.equal(relay.backlog('r', 'shapeA').presentId, null, 'oldest log evicted')
		assert.equal(relay.backlog('r', 'shapeB').presentId, 'pB', 'newer log kept')
		assert.equal(relay.backlog('r', 'shapeC').presentId, 'pC', 'new log stored')
	}

	// Per-log caps still truncate the active log itself.
	{
		const relay = createPresentRelay({ maxBytes: 100 })
		const res = relay.append('r', 's', 'p1', [{ seq: 0, event: { pad: 'x'.repeat(400) } }])
		assert.equal(res.truncated, true, 'own-log cap still truncates')
	}

	// A rejected (truncated) append must NOT refresh LRU freshness: a dead log
	// that keeps getting appended to (and keeps getting rejected) must still
	// look stale to eviction, or it would out-survive a healthy log that was
	// genuinely touched more recently.
	{
		let t = 1000
		const small = () => [{ seq: 0, event: { pad: 'x'.repeat(400) } }] // ~430 bytes
		const large = () => [{ seq: 0, event: { pad: 'x'.repeat(1150) } }] // ~1180 bytes
		// maxTotalBytes chosen so the two initial small appends (~860 total)
		// leave headroom for the rejected re-append below to NOT itself trigger
		// eviction — only the final large append does.
		const relay = createPresentRelay({ maxEvents: 1, maxTotalBytes: 2000, now: () => t })

		relay.append('r', 'shapeA', 'pA', small()) // accepted, lastAppendAt = 1000
		t += 1
		relay.append('r', 'shapeB', 'pB', small()) // accepted, lastAppendAt = 1001
		t += 1
		// Exceeds shapeA's maxEvents cap → truncated. Without the fix this would
		// stamp lastAppendAt = 1002, making shapeA look newer than shapeB.
		const rejected = relay.append('r', 'shapeA', 'pA', small())
		assert.equal(rejected.truncated, true, 'second append trips the per-log event cap')
		t += 1
		// A third log pushes total bytes over the cap: eviction must pick the
		// least-recently-appended OTHER log — shapeA (still stamped 1000), not
		// shapeB (stamped 1001) — even though shapeA's rejected append happened
		// more recently in wall-clock terms.
		relay.append('r', 'shapeC', 'pC', large())
		assert.equal(
			relay.backlog('r', 'shapeA').presentId,
			null,
			'dead truncated log evicted first despite its later rejected append'
		)
		assert.equal(relay.backlog('r', 'shapeB').presentId, 'pB', 'healthy log survives eviction')
	}


	console.log('present-relay tests passed')
}

main()
