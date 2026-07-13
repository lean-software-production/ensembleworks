// Run: bun src/canvas-v2/presence.test.ts
import assert from 'node:assert/strict'
import { PresenceStore } from '@ensembleworks/canvas-sync'
import { adaptPresence, createPresencePublisher, leadingEdgeThrottle, PRESENCE_THROTTLE_MS } from './presence.js'

// ============================================================================
// 1. leadingEdgeThrottle: a burst of N calls inside one interval collapses to
//    exactly 1 publish (the leading edge); a call AFTER the interval elapses
//    fires again immediately.
// ============================================================================
{
	let clock = 0
	const now = () => clock
	const published: number[] = []
	const throttled = leadingEdgeThrottle<number>(60, now, (v) => published.push(v))

	// A burst of 10 calls, all within the same 60ms window.
	for (let i = 0; i < 10; i++) {
		clock = i // 0..9ms, all < 60ms apart from the first
		throttled(i)
	}
	assert.deepEqual(published, [0], 'a burst inside one interval collapses to exactly the FIRST (leading-edge) value')

	// Still inside the window (t=59): dropped.
	clock = 59
	throttled(59)
	assert.deepEqual(published, [0], 'a call still inside the interval is dropped')

	// Exactly at the boundary (t=60, i.e. 60ms since the last publish at t=0): fires.
	clock = 60
	throttled(60)
	assert.deepEqual(published, [0, 60], 'a call exactly at the interval boundary fires again')

	// A big gap, then another burst: only the burst's leading value publishes.
	clock = 500
	throttled(500)
	clock = 510
	throttled(510)
	clock = 520
	throttled(520)
	assert.deepEqual(published, [0, 60, 500], 'a burst after a long gap collapses to its own leading value')
	console.log('ok: leadingEdgeThrottle — bounds a burst of N calls to <= a small K')
}

// ============================================================================
// 2. adaptPresence: cursor passes through verbatim; name/color are NEVER
//    populated (the documented wire-contract gap — canvas-sync's Presence
//    carries no identity fields).
// ============================================================================
{
	const wire = {
		'peer-a': { cursor: { x: 10, y: 20 }, viewport: null, stamp: null, presenting: [] },
		'peer-b': { cursor: null, viewport: { x: 0, y: 0, w: 100, h: 100, z: 1 }, stamp: null, presenting: [] },
	}
	const adapted = adaptPresence(wire)
	assert.deepEqual(adapted, {
		'peer-a': { cursor: { x: 10, y: 20 } },
		'peer-b': { cursor: null },
	})
	// name/color keys are genuinely absent, not merely undefined-valued —
	// Cursors.tsx's `peer.color ?? colorForKey(key)` fallback only matters if
	// they're absent/undefined either way, but pin the honest shape anyway.
	assert.ok(!('name' in adapted['peer-a']!))
	assert.ok(!('color' in adapted['peer-a']!))
	console.log('ok: adaptPresence — cursor-only mapping, no fabricated name/color')
}

// ============================================================================
// 3. createPresencePublisher: setCursor/setViewport each publish the FULL
//    current Presence object (not a partial patch) -- a setViewport call
//    must NOT clobber a cursor set moments earlier, and vice versa.
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')

	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })
	publisher.setCursor({ x: 1, y: 2 })
	assert.deepEqual(store.all()['self-key'], { cursor: { x: 1, y: 2 }, viewport: null, stamp: null, presenting: [] })

	// A DIFFERENT throttle instance (setViewport) — its own leading edge fires
	// immediately regardless of setCursor's window, and carries the cursor
	// value forward (full-object semantics, not a partial patch).
	publisher.setViewport({ x: 5, y: 5, w: 800, h: 600, z: 1 })
	assert.deepEqual(store.all()['self-key'], { cursor: { x: 1, y: 2 }, viewport: { x: 5, y: 5, w: 800, h: 600, z: 1 }, stamp: null, presenting: [] })

	// A SECOND setCursor call still inside setCursor's own 60ms window is
	// dropped (the wire value stays exactly what it was).
	clock = 10
	publisher.setCursor({ x: 999, y: 999 })
	assert.deepEqual(store.all()['self-key']!.cursor, { x: 1, y: 2 }, 'a cursor update inside the throttle window never reaches the store')

	store.destroy()
	console.log('ok: createPresencePublisher — full-object republish, cursor and viewport independently throttled')
}

console.log(`ok: presence (PRESENCE_THROTTLE_MS=${PRESENCE_THROTTLE_MS})`)
