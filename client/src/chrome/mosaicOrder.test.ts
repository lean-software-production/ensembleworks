/**
 * Mosaic ordering: viewport-distance sort (missing cursors last, stable),
 * spoke-recency tracking + sort, and the viewport settle debounce.
 * Run: bun client/src/chrome/mosaicOrder.test.ts
 */
import assert from 'node:assert/strict'
import {
	VIEWPORT_SETTLE_MS,
	createSettler,
	orderByRecency,
	orderByViewportDistance,
	updateSpokeRecency,
} from './mosaicOrder'

// --- orderByViewportDistance ---
{
	const ids = ['a', 'b', 'c', 'd']
	const cursors = {
		a: { x: 100, y: 100 }, // dist 100√2 from centre
		b: { x: 10, y: 0 },    // dist 10 — closest
		c: { x: 0, y: 50 },    // dist 50
		// d: no cursor (never moved) — sorts last
	}
	const centre = { x: 0, y: 0 }
	assert.deepEqual(orderByViewportDistance(ids, cursors, centre), ['b', 'c', 'a', 'd'])
}
{
	// Stability: equal distances keep input order (join order).
	const ids = ['x', 'y', 'z']
	const cursors = { x: { x: 5, y: 0 }, y: { x: 0, y: 5 }, z: { x: 3, y: 4 } } // all dist 5
	assert.deepEqual(orderByViewportDistance(ids, cursors, { x: 0, y: 0 }), ['x', 'y', 'z'])
}
{
	// All cursors missing: input order preserved.
	assert.deepEqual(orderByViewportDistance(['p', 'q'], {}, { x: 0, y: 0 }), ['p', 'q'])
}

// --- updateSpokeRecency ---
{
	const r1 = updateSpokeRecency({}, ['a'], 1000)
	assert.deepEqual(r1, { a: 1000 })
	// No speakers, nothing stale to write → same reference back (no churn).
	const r2 = updateSpokeRecency(r1, [], 2000)
	assert.equal(r2, r1)
	// New speaker joins the record; old entry kept.
	const r3 = updateSpokeRecency(r2, ['b'], 3000)
	assert.deepEqual(r3, { a: 1000, b: 3000 })
	// Same speaker again at same timestamp → same reference (dedupe).
	assert.equal(updateSpokeRecency(r3, ['b'], 3000), r3)
}

// --- orderByRecency ---
{
	const recency = { a: 1000, c: 5000 } // b never spoke
	// c spoke most recently → first; never-spoke keeps input order, last.
	assert.deepEqual(orderByRecency(['a', 'b', 'c'], recency), ['c', 'a', 'b'])
	// Nobody spoke: input (join) order.
	assert.deepEqual(orderByRecency(['a', 'b'], {}), ['a', 'b'])
}

// --- createSettler: debounce with injectable scheduler ---
{
	assert.equal(VIEWPORT_SETTLE_MS, 1000)
	let pending: { fn: () => void; ms: number } | null = null
	let cancelled = 0
	const schedule = (fn: () => void, ms: number) => {
		pending = { fn, ms }
		return 7 as unknown as ReturnType<typeof setTimeout>
	}
	const cancel = () => {
		cancelled++
		pending = null
	}
	const settled: number[] = []
	const settler = createSettler<number>(1000, (v) => settled.push(v), schedule, cancel)

	settler.feed(1)
	assert.equal(pending!.ms, 1000)
	settler.feed(2) // re-feed before fire: cancels + reschedules, latest wins
	assert.equal(cancelled, 1)
	pending!.fn() // timer fires
	assert.deepEqual(settled, [2])

	settler.feed(3)
	settler.dispose() // dispose cancels the pending timer
	assert.equal(cancelled, 2)
	assert.deepEqual(settled, [2]) // nothing more fires
}

console.log('mosaicOrder tests passed')
