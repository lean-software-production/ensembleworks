// Run: bun src/canvas-v2/presence.test.ts
import assert from 'node:assert/strict'
import { PresenceStore, type Presence } from '@ensembleworks/canvas-sync'
import {
	adaptPresence,
	createPresencePublisher,
	decodePresenting,
	encodePresenting,
	leadingEdgeThrottle,
	presenterFor,
	PRESENCE_THROTTLE_MS,
} from './presence.js'

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
// 3. createPresencePublisher: ONE shared throttle channel, full-object
//    publishes. A dropped call still UPDATES the pending `current` object,
//    so the next fired publish carries it — nothing is lost forever, only
//    deferred to the next fire (see presence.ts's ONE SHARED THROTTLE
//    CHANNEL section for why a single channel is load-bearing, not a
//    simplification: two channels could legally write the store twice in
//    one millisecond, and a remote EphemeralStore DROPS the second same-ms
//    same-key write on the LWW tie — probed against loro-crdt 1.13.6).
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')

	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })
	publisher.setCursor({ x: 1, y: 2 })
	assert.deepEqual(store.all()['self-key'], { cursor: { x: 1, y: 2 }, viewport: null, stamp: null, presenting: [], editing: null })

	// A camera publish in the SAME instant shares the one channel: the WRITE
	// is dropped (no second same-ms store write can ever leave this
	// publisher) but the viewport update is RECORDED on `current`.
	publisher.setViewportAndRefreshCursor({ x: 5, y: 5, w: 800, h: 600, z: 1 }, { x: 5, y: 5, z: 1 }, null)
	assert.equal(store.all()['self-key']!.viewport, null, 'a same-instant second write is dropped at the shared channel (never reaches the store)')

	// The NEXT fired publish (past the window) carries the recorded viewport
	// — deferred, not lost.
	clock = 100
	publisher.setCursor({ x: 3, y: 4 })
	assert.deepEqual(store.all()['self-key'], { cursor: { x: 3, y: 4 }, viewport: { x: 5, y: 5, w: 800, h: 600, z: 1 }, stamp: null, presenting: [], editing: null }, 'the next fire carries every update recorded during the dropped window (full-object publish)')

	store.destroy()
	console.log('ok: createPresencePublisher — one shared channel, dropped writes deferred to the next fire')
}

// ============================================================================
// 4. Camera-only changes republish the cursor (quality-review fix round):
//    setCursorFromScreen records the SCREEN point; setViewportAndRefreshCursor
//    re-derives the world cursor from that recorded screen point + the NEW
//    camera and publishes it (with the viewport) as ONE store write -- so a
//    wheel pan/zoom with a stationary mouse doesn't leave peers seeing the
//    cursor frozen at the pre-pan world spot.
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })

	// Screen (100,100) at the identity camera -> world (100,100)
	// (world = screen/z - camera.xy -- input.ts's screenToWorld convention).
	publisher.setCursorFromScreen({ x: 100, y: 100 }, { x: 0, y: 0, z: 1 })
	assert.deepEqual(store.all()['self-key']!.cursor, { x: 100, y: 100 }, 'setCursorFromScreen publishes the screen->world conversion')

	// Camera pans/zooms with NO pointermove: same screen point, new camera ->
	// world (100/2 - (-50), 100/2 - 0) = (100, 50), published together with
	// the new viewport in ONE write.
	clock = 100 // past the 60ms throttle window
	publisher.setViewportAndRefreshCursor({ x: -50, y: 0, w: 800, h: 600, z: 2 }, { x: -50, y: 0, z: 2 }, null)
	assert.deepEqual(store.all()['self-key']!.cursor, { x: 100, y: 50 }, 'a camera-only change republishes the cursor at the RECOMPUTED world position')
	assert.deepEqual(store.all()['self-key']!.viewport, { x: -50, y: 0, w: 800, h: 600, z: 2 }, 'the same single write carries the new viewport')

	// Inside the shared window: the write is dropped (leading edge), exactly
	// like a too-soon pointermove would be.
	clock = 110
	publisher.setViewportAndRefreshCursor({ x: 0, y: 0, w: 800, h: 600, z: 1 }, { x: 0, y: 0, z: 1 }, null)
	assert.deepEqual(store.all()['self-key']!.cursor, { x: 100, y: 50 }, 'a refresh inside the throttle window is dropped (shared channel)')

	store.destroy()
	console.log('ok: setViewportAndRefreshCursor — camera-only change republishes the recomputed world cursor in one write')
}

// ============================================================================
// 5. setViewportAndRefreshCursor before ANY screen point is recorded: the
//    viewport publishes, the cursor stays null (nothing to recompute from) —
//    never a throw, never a fabricated cursor.
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })
	publisher.setViewportAndRefreshCursor({ x: 10, y: 10, w: 800, h: 600, z: 2 }, { x: 10, y: 10, z: 2 }, null)
	assert.deepEqual(store.all()['self-key'], { cursor: null, viewport: { x: 10, y: 10, w: 800, h: 600, z: 2 }, stamp: null, presenting: [], editing: null }, 'no screen point recorded yet -> viewport publishes, cursor stays null')

	// A raw setCursor SUPERSEDES the screen-point derivation: a later camera
	// change must not resurrect a stale screen point over it.
	clock = 100
	publisher.setCursorFromScreen({ x: 50, y: 50 }, { x: 0, y: 0, z: 1 })
	clock = 200
	publisher.setCursor(null) // e.g. the pointer left the viewport
	clock = 300
	publisher.setViewportAndRefreshCursor({ x: 0, y: 0, w: 800, h: 600, z: 1 }, { x: 0, y: 0, z: 1 }, null)
	assert.equal(store.all()['self-key']!.cursor, null, 'a raw setCursor(null) forgets the recorded screen point — no stale-cursor resurrection on the next camera change')
	store.destroy()
	console.log('ok: setViewportAndRefreshCursor — null-cursor cases (no screen point; superseded screen point)')
}

// ============================================================================
// 6. Task D5: setPresenting folds into the SAME combined write as
//    cursor/viewport — never a second independent store write. A caller
//    that published presenting via its own separate PresenceStore.publish()
//    would reopen the exact same-millisecond LWW hazard tests 3/4 guard
//    against; this test proves setPresenting shares the one channel instead.
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')
	let publishCalls = 0
	const realPublish = store.publish.bind(store)
	;(store as unknown as { publish: (p: Presence) => void }).publish = (p: Presence) => {
		publishCalls++
		realPublish(p)
	}
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })

	publisher.setCursor({ x: 1, y: 2 })
	assert.equal(publishCalls, 1, 'the leading cursor publish fires immediately')

	// A presenting toggle in the SAME instant shares the one channel: dropped
	// at the publisher (no second store write), but recorded on `current`.
	publisher.setPresenting({ shapeId: 'shape:f1', fraction: 0.4, ts: 999 })
	assert.equal(publishCalls, 1, 'a same-instant presenting publish is dropped at the shared channel (never a second store write)')
	assert.deepEqual(store.all()['self-key']!.presenting, [], 'the dropped write never reached the store — presenting is still the pre-call value')

	// Past the throttle window: ONE combined write carries BOTH the cursor
	// (unchanged) and the presenting token together.
	clock = 100
	publisher.setCursor({ x: 3, y: 4 })
	assert.equal(publishCalls, 2, 'exactly one more store write for the whole recorded window')
	assert.deepEqual(
		store.all()['self-key'],
		{ cursor: { x: 3, y: 4 }, viewport: null, stamp: null, presenting: [JSON.stringify({ shapeId: 'shape:f1', fraction: 0.4, ts: 999 })], editing: null },
		'ONE combined write carries cursor AND presenting together — never two separate set() calls',
	)

	// Stopping presenting (null) is also folded into the one channel.
	clock = 200
	publisher.setPresenting(null)
	assert.equal(publishCalls, 3)
	assert.deepEqual(store.all()['self-key']!.presenting, [], 'null clears presenting back to the empty-array default')

	store.destroy()
	console.log('ok: setPresenting — folds into the single combined presence write, never a second set()')
}

// ============================================================================
// 7. Task H6: block 6 above proves the single-write guarantee for the
//    presenting+cursor pairing, with presenting always the SECOND (dropped)
//    call. This block completes the coverage the plan's D5-follow-up asks
//    for — the SAME guarantee holds for presenting's OTHER co-published
//    field (viewport, exactly the field setViewportAndRefreshCursor's own
//    doc comment names as the original two-writes flake), and holds
//    regardless of WHICH of the pair fires the shared channel's leading
//    edge. A physical-write counter (like block 6's) is asserted at every
//    step so a regression that splits setPresenting into its own set() —
//    whether a direct extra store.publish() or its own independent throttle
//    channel — trips assert.equal(publishCalls, 1) immediately, before the
//    payload assertions even run (verified directly: temporarily routing
//    setPresenting through store.publish() directly, and separately through
//    its own leadingEdgeThrottle channel, both make this block's first
//    publishCalls-after-the-second-call assertion fail with 2 !== 1).
// ============================================================================
{
	// 7a. Viewport leads the interval; presenting is the same-instant SECOND
	// call — dropped at the shared channel, then folded into the next fire.
	let clock = 0
	const store = new PresenceStore('self-key')
	let publishCalls = 0
	const realPublish = store.publish.bind(store)
	;(store as unknown as { publish: (p: Presence) => void }).publish = (p: Presence) => {
		publishCalls++
		realPublish(p)
	}
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })

	publisher.setViewportAndRefreshCursor({ x: 1, y: 1, w: 800, h: 600, z: 1 }, { x: 1, y: 1, z: 1 }, null)
	assert.equal(publishCalls, 1, 'the leading viewport publish fires immediately')

	publisher.setPresenting({ shapeId: 'shape:f2', fraction: 0.1, ts: 1 })
	assert.equal(publishCalls, 1, 'a same-instant presenting call after a VIEWPORT lead is dropped at the shared channel too (never a second store write)')
	assert.deepEqual(store.all()['self-key']!.presenting, [], 'the dropped write never reached the store — presenting is still the pre-call value')

	clock = 100
	publisher.setPresenting({ shapeId: 'shape:f2', fraction: 0.2, ts: 2 })
	assert.equal(publishCalls, 2, 'exactly one more physical write for the whole recorded window')
	assert.deepEqual(
		store.all()['self-key'],
		{ cursor: null, viewport: { x: 1, y: 1, w: 800, h: 600, z: 1 }, stamp: null, presenting: [JSON.stringify({ shapeId: 'shape:f2', fraction: 0.2, ts: 2 })], editing: null },
		'ONE combined write carries the viewport AND presenting together — never two separate set() calls',
	)
	store.destroy()

	// 7b. Reverse order: presenting itself leads the interval; a viewport
	// change (and later, a cursor change) is the same-instant SECOND call —
	// dropped, then folded into the next fire alongside presenting.
	let clock2 = 0
	const store2 = new PresenceStore('self-key')
	let publishCalls2 = 0
	const realPublish2 = store2.publish.bind(store2)
	;(store2 as unknown as { publish: (p: Presence) => void }).publish = (p: Presence) => {
		publishCalls2++
		realPublish2(p)
	}
	const publisher2 = createPresencePublisher(store2, { intervalMs: 60, now: () => clock2 })

	publisher2.setPresenting({ shapeId: 'shape:f3', fraction: 0.5, ts: 10 })
	assert.equal(publishCalls2, 1, 'the leading presenting publish fires immediately')

	publisher2.setViewportAndRefreshCursor({ x: 9, y: 9, w: 800, h: 600, z: 1 }, { x: 9, y: 9, z: 1 }, null)
	assert.equal(publishCalls2, 1, 'a same-instant viewport call after a PRESENTING lead is dropped at the shared channel')
	assert.equal(store2.all()['self-key']!.viewport, null, 'the dropped write never reached the store — viewport is still the pre-call value')

	clock2 = 100
	publisher2.setCursor({ x: 7, y: 7 })
	assert.equal(publishCalls2, 2, 'exactly one more physical write for the whole recorded window')
	assert.deepEqual(
		store2.all()['self-key'],
		{ cursor: { x: 7, y: 7 }, viewport: { x: 9, y: 9, w: 800, h: 600, z: 1 }, stamp: null, presenting: [JSON.stringify({ shapeId: 'shape:f3', fraction: 0.5, ts: 10 })], editing: null },
		'ONE combined write carries presenting, viewport, AND cursor together when presenting leads the interval',
	)
	store2.destroy()

	console.log('ok: setPresenting + setViewportAndRefreshCursor — single combined write holds for the viewport pairing too, either field leading')
}

// ============================================================================
// 9. Task F4 (pilot 5): `editingId` is the THIRD argument to
//    setViewportAndRefreshCursor, not a separate setter — proves it folds
//    into the SAME single write as viewport/cursor (never its own store
//    write), and that a same-instant repeat call still records the latest
//    editingId for the next fire (the exact "deferred, not lost" guarantee
//    block 3 established for viewport, now covering editingId).
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')
	let publishCalls = 0
	const realPublish = store.publish.bind(store)
	;(store as unknown as { publish: (p: Presence) => void }).publish = (p: Presence) => {
		publishCalls++
		realPublish(p)
	}
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })

	// BeginEdit: editingId becomes 'shape:lock', published together with the
	// viewport/cursor in ONE write.
	publisher.setViewportAndRefreshCursor({ x: 0, y: 0, w: 800, h: 600, z: 1 }, { x: 0, y: 0, z: 1 }, 'shape:lock')
	assert.equal(publishCalls, 1, 'the leading write fires immediately')
	assert.equal(store.all()['self-key']!.editing, 'shape:lock', 'editingId is published as part of the ONE combined write, not a separate set()')

	// A same-instant repeat (e.g. a stray extra EditorState notification) is
	// dropped at the shared channel like everything else, but recorded.
	publisher.setViewportAndRefreshCursor({ x: 1, y: 1, w: 800, h: 600, z: 1 }, { x: 1, y: 1, z: 1 }, 'shape:lock')
	assert.equal(publishCalls, 1, 'a same-instant repeat call is dropped at the shared channel')

	// EndEdit past the throttle window: editingId goes back to null, in the
	// SAME single write as the (unchanged) viewport/cursor.
	clock = 100
	publisher.setViewportAndRefreshCursor({ x: 1, y: 1, w: 800, h: 600, z: 1 }, { x: 1, y: 1, z: 1 }, null)
	assert.equal(publishCalls, 2, 'exactly one more physical write for the EndEdit transition')
	assert.equal(store.all()['self-key']!.editing, null, 'editingId round-trips back to null on EndEdit — never left stuck at the prior shape id')

	store.destroy()
	console.log('ok: setViewportAndRefreshCursor — editingId folds into the single combined write (Task F4)')
}

// ============================================================================
// 10. Task F4's ACTUAL regression pin (spec-review finding: block 9 above
//     does NOT pin it — every one of its transitions lands either on the
//     first-ever call, where the leading edge is free, or at clock=100, past
//     the window, so neutralizing the flushNow bypass — routing an editing
//     transition through throttledFlush like every other field, i.e. the
//     pre-fix behavior — left block 9 green). This block constructs the real
//     bug shape: the leading edge is ALREADY CONSUMED by a prior cursor
//     flush, the editing transition arrives INSIDE the still-open throttle
//     window, and NO further event ever follows (typing never touches
//     EditorState — SetText goes straight to the CRDT doc — so there is
//     nothing to piggyback a deferred flush on). Pre-fix, the transition was
//     silently dropped for the WHOLE edit; the fix's transition bypass must
//     flush it to the wire immediately. Teeth verified directly (2026-07-16):
//     re-neutralizing the bypass exactly the way the reviewer did makes this
//     block fail at its first assertion ('shape:lock' !== null — the editing
//     value never published), and restoring the bypass turns it green again.
// ============================================================================
{
	let clock = 0
	const store = new PresenceStore('self-key')
	let publishCalls = 0
	const realPublish = store.publish.bind(store)
	;(store as unknown as { publish: (p: Presence) => void }).publish = (p: Presence) => {
		publishCalls++
		realPublish(p)
	}
	const publisher = createPresencePublisher(store, { intervalMs: 60, now: () => clock })

	// (1) t=0: an ordinary cursor publish CONSUMES the leading edge — the
	// shared channel's next throttled fire can now only happen at t>=60.
	publisher.setCursor({ x: 1, y: 2 })
	assert.equal(publishCalls, 1, 'the cursor publish consumes the leading edge')
	assert.equal(store.all()['self-key']!.editing, null, 'not editing yet')

	// (2) t=30: BeginEdit lands INSIDE the still-open window. Pre-fix
	// (editing routed through throttledFlush like every other field), this
	// write is dropped — and (3) NO later event ever arrives to heal it.
	// (4) The transition bypass must flush it immediately regardless.
	clock = 30
	publisher.setViewportAndRefreshCursor({ x: 0, y: 0, w: 800, h: 600, z: 1 }, { x: 0, y: 0, z: 1 }, 'shape:lock')
	assert.equal(store.all()['self-key']!.editing, 'shape:lock', 'an editing TRANSITION mid-window flushes to the wire immediately — the throttle-drop regression this block pins (pre-fix: dropped, and never healed)')
	assert.equal(publishCalls, 2, 'the transition bypass made exactly one immediate extra write')

	// The bypass write updated the shared channel timing too (flushNow sets
	// lastFlushAt): a NON-transition call in the same instant is still
	// throttled — the bypass is scoped to transitions, not a general
	// throttle escape hatch.
	publisher.setCursor({ x: 5, y: 6 })
	assert.equal(publishCalls, 2, 'a same-instant non-transition call right after the bypass is still throttled (bypass counts as the channel firing)')

	// Symmetric coverage for the OTHER direction: EndEdit (editing -> null)
	// also arriving mid-window (t=59 < 30+60), also with no event after it —
	// a stuck 'peer is editing' badge would be the user-visible symptom.
	clock = 59
	publisher.setViewportAndRefreshCursor({ x: 0, y: 0, w: 800, h: 600, z: 1 }, { x: 0, y: 0, z: 1 }, null)
	assert.equal(store.all()['self-key']!.editing, null, 'an EndEdit transition mid-window also flushes immediately — no stuck badge on the remote side')
	assert.equal(publishCalls, 3)

	store.destroy()
	console.log('ok: editing-transition mid-window bypass — the F4 throttle-drop regression is pinned (teeth-proven)')
}

// ============================================================================
// 8. encodePresenting/decodePresenting round-trip, and presenterFor resolves
//    the FRESHEST ts among competing peers, excluding selfKey and other
//    shapes — the canvas-sync-wire port of the legacy `presenterFor`
//    (git history: client/src/file-viewer/followLogic.ts).
// ============================================================================
{
	assert.deepEqual(encodePresenting(null), [], "not presenting -> empty array, the field's existing default")
	const p = { shapeId: 'shape:f1', fraction: 0.25, ts: 111 }
	assert.deepEqual(encodePresenting(p), [JSON.stringify(p)])
	assert.deepEqual(decodePresenting(encodePresenting(p)), [p], 'round-trips exactly')
	assert.deepEqual(decodePresenting(['not json', '{"shapeId":1}', '{}']), [], 'malformed/incomplete entries are skipped, never thrown')

	const all: Record<string, Presence> = {
		'self-key': { cursor: null, viewport: null, stamp: null, presenting: encodePresenting({ shapeId: 'shape:f1', fraction: 0.9, ts: 999_999 }) },
		'peer-a': { cursor: null, viewport: null, stamp: null, presenting: encodePresenting({ shapeId: 'shape:f1', fraction: 0.1, ts: 100 }) },
		'peer-b': { cursor: null, viewport: null, stamp: null, presenting: encodePresenting({ shapeId: 'shape:f1', fraction: 0.5, ts: 200 }) },
		'peer-c': { cursor: null, viewport: null, stamp: null, presenting: encodePresenting({ shapeId: 'shape:other', fraction: 0.7, ts: 500 }) },
		'peer-d': { cursor: null, viewport: null, stamp: null, presenting: [] },
	}
	const resolved = presenterFor(all, 'self-key', 'shape:f1')
	assert.deepEqual(resolved, { peerKey: 'peer-b', fraction: 0.5, ts: 200 }, 'the FRESHEST peer wins — self and other-shape entries excluded')
	assert.equal(presenterFor(all, 'self-key', 'shape:none'), null, 'no peer presenting this shape id -> null')
	assert.equal(presenterFor({}, 'self-key', 'shape:f1'), null, 'no peers at all -> null, never a throw')
	console.log('ok: encodePresenting/decodePresenting/presenterFor — wire round-trip + freshest-ts-wins resolution, self excluded')
}

console.log(`ok: presence (PRESENCE_THROTTLE_MS=${PRESENCE_THROTTLE_MS})`)
