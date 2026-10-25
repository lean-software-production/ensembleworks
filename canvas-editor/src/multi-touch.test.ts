// Run: bun src/multi-touch.test.ts
//
// The two-finger recognizer + the pinch camera policy. Every assertion here is
// about a decision no browser is needed to reach: which events reach a tool,
// when an in-flight gesture is cancelled, and what camera a pair of finger
// positions produces. (There is no browser in this environment at all — see
// the PR body's unverified list for what that leaves untested.)
import assert from 'node:assert/strict'
import { applyPinch, MIN_ZOOM } from './camera.js'
import { screenToWorld, type PointerInputEvent } from './input.js'
import { IDLE_MULTI_TOUCH, reduceMultiTouch, resetMultiTouch, type MultiTouchState } from './multi-touch.js'

const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
let clock = 0
function touch(type: PointerInputEvent['type'], pointerId: number, x: number, y: number): PointerInputEvent {
  return { type, x, y, buttons: type === 'pointerup' ? 0 : 1, modifiers: NEUTRAL, t: (clock += 16), pointerId, pointerType: 'touch' }
}
function mouse(type: PointerInputEvent['type'], x: number, y: number): PointerInputEvent {
  return { type, x, y, buttons: type === 'pointerup' ? 0 : 1, modifiers: NEUTRAL, t: (clock += 16), pointerId: 1, pointerType: 'mouse' }
}
/** Feed a whole sequence, collecting every result in order. */
function play(events: readonly PointerInputEvent[], from: MultiTouchState = IDLE_MULTI_TOUCH) {
  let state = from
  const results = []
  for (const e of events) {
    const r = reduceMultiTouch(state, e)
    state = r.state
    results.push(r)
  }
  return { state, results }
}

// ============================================================================
// 1. A mouse, a pen, and an id-less event pass straight through: this module
//    is additive, and every pre-existing single-pointer path must be untouched.
// ============================================================================
{
  const { results, state } = play([mouse('pointerdown', 10, 10), mouse('pointermove', 60, 10), mouse('pointerup', 60, 10)])
  assert.ok(results.every((r) => r.forward && !r.cancelGesture && r.pinch === null), 'a mouse gesture must forward untouched')
  assert.equal(state.pointers.size, 0, 'a mouse pointer is never tracked')

  const idless: PointerInputEvent = { type: 'pointerdown', x: 5, y: 5, buttons: 1, modifiers: NEUTRAL, t: 0 }
  const r = reduceMultiTouch(IDLE_MULTI_TOUCH, idless)
  assert.ok(r.forward && r.state === IDLE_MULTI_TOUCH, 'an id-less event forwards and leaves state identical')

  const pen: PointerInputEvent = { ...touch('pointerdown', 7, 1, 1), pointerType: 'pen' }
  assert.ok(reduceMultiTouch(IDLE_MULTI_TOUCH, pen).forward, 'a pen is not a pinch participant')
}

// ============================================================================
// 2. ONE finger behaves exactly like a mouse — down/move/up all forwarded.
//    (If this regressed, every touch drag on a phone would stop working.)
// ============================================================================
{
  const { results } = play([touch('pointerdown', 1, 10, 10), touch('pointermove', 1, 40, 10), touch('pointerup', 1, 40, 10)])
  assert.ok(results.every((r) => r.forward), 'a single finger is an ordinary pointer gesture')
  assert.ok(results.every((r) => r.pinch === null), 'one finger never produces a pinch sample')
}

// ============================================================================
// 3. The SECOND finger arms the pinch: its own pointerdown is swallowed, the
//    in-flight single-finger gesture is cancelled exactly once, and no further
//    pointer event of the gesture reaches a tool.
// ============================================================================
{
  const { results } = play([
    touch('pointerdown', 1, 100, 100),
    touch('pointermove', 1, 120, 100),
    touch('pointerdown', 2, 300, 100), // second finger
    touch('pointermove', 2, 340, 100),
    touch('pointermove', 1, 90, 100),
  ])
  assert.deepEqual(results.map((r) => r.forward), [true, true, false, false, false], 'the pinch swallows the pointer stream from the second finger down')
  assert.deepEqual(results.map((r) => r.cancelGesture), [false, false, true, false, false], 'exactly one cancel, on the arming event')
  assert.equal(results[2]!.pinch, null, 'the arming pointerdown is not itself a camera sample')
  assert.ok(results[3]!.pinch !== null && results[4]!.pinch !== null, 'each move of a pinch pointer produces one sample')
}

// ============================================================================
// 4. The geometry of a sample: spreading zooms in, the anchor is the PREVIOUS
//    midpoint, and midpoint travel is reported as the pan.
// ============================================================================
{
  const { results } = play([
    touch('pointerdown', 1, 100, 200),
    touch('pointerdown', 2, 200, 200), // distance 100, midpoint (150, 200)
    touch('pointermove', 2, 300, 200), // distance 200, midpoint (200, 200)
  ])
  const sample = results[2]!.pinch!
  assert.equal(sample.factor, 2, 'doubling the spread is a factor of 2')
  assert.deepEqual({ x: sample.x, y: sample.y }, { x: 150, y: 200 }, 'anchored at the PREVIOUS midpoint')
  assert.deepEqual({ dx: sample.dx, dy: sample.dy }, { dx: 50, dy: 0 }, 'the midpoint travelled 50px right')
}
{
  // Two fingers held a fixed distance apart and dragged together: pure pan.
  const { results } = play([
    touch('pointerdown', 1, 100, 100),
    touch('pointerdown', 2, 200, 100),
    touch('pointermove', 1, 130, 160),
    touch('pointermove', 2, 230, 160),
  ])
  const total = results.slice(2).reduce((acc, r) => ({ dx: acc.dx + (r.pinch?.dx ?? 0), dy: acc.dy + (r.pinch?.dy ?? 0) }), { dx: 0, dy: 0 })
  assert.deepEqual(total, { dx: 30, dy: 60 }, 'a rigid two-finger drag pans by the finger travel and nothing else')
  // The PRODUCT of the samples' factors, not each one: the browser delivers
  // the two fingers' moves as separate events, so mid-sequence the pair IS
  // momentarily at a different spread (one finger has moved, the other has
  // not) and each such sample legitimately zooms a little. That is the real
  // gesture, not an artefact — what must come out neutral is the whole drag.
  const zoom = results.slice(2).reduce((acc, r) => acc * (r.pinch?.factor ?? 1), 1)
  assert.ok(Math.abs(zoom - 1) < 1e-9, `a rigid drag nets no zoom (got ${zoom})`)
}

// ============================================================================
// 5. SUPPRESSION OUTLIVES THE PINCH. Lifting one finger must not hand the
//    other one to the select tool as a drag that began nowhere.
// ============================================================================
{
  const { results, state } = play([
    touch('pointerdown', 1, 100, 100),
    touch('pointerdown', 2, 200, 100),
    touch('pointerup', 2, 200, 100),   // one finger lifts; finger 1 is still down
    touch('pointermove', 1, 400, 400), // a big travel that MUST NOT reach a tool
    touch('pointerup', 1, 400, 400),
  ])
  assert.deepEqual(results.map((r) => r.forward), [true, false, false, false, false], 'the leftover finger stays suppressed until it lifts')
  assert.equal(state.suppressing, false, 'the last finger lifting clears the suppression')
  assert.equal(state.pointers.size, 0, 'no pointer is left tracked')
  // ...and the very next gesture is ordinary again.
  assert.equal(reduceMultiTouch(state, touch('pointerdown', 3, 10, 10)).forward, true, 'the next gesture is not eaten')
}

// ============================================================================
// 6. A finger lifted and put back down RE-forms the pinch (and does not
//    re-cancel a tool gesture there was no opportunity to start).
// ============================================================================
{
  const { results } = play([
    touch('pointerdown', 1, 100, 100),
    touch('pointerdown', 2, 200, 100),
    touch('pointerup', 2, 200, 100),
    touch('pointerdown', 2, 260, 100),
    touch('pointermove', 2, 300, 100),
  ])
  assert.equal(results[3]!.cancelGesture, false, 're-forming a pinch has no tool gesture to cancel')
  assert.ok(results[4]!.pinch !== null, 'the re-formed pair produces samples again')
}

// ============================================================================
// 7. A THIRD finger is tracked but never steers the pair.
// ============================================================================
{
  const { results } = play([
    touch('pointerdown', 1, 100, 100),
    touch('pointerdown', 2, 200, 100),
    touch('pointerdown', 3, 500, 500),
    touch('pointermove', 3, 700, 700),
  ])
  assert.equal(results[3]!.pinch, null, 'a non-pair pointer produces no camera sample')
  assert.equal(results[3]!.forward, false, 'and is still kept away from the tools')
}

// ============================================================================
// 8. Poison guard: a non-finite coordinate produces no sample and leaves the
//    anchor intact, so the next good move still measures from a good sample.
// ============================================================================
{
  const { results } = play([
    touch('pointerdown', 1, 100, 200),
    touch('pointerdown', 2, 200, 200),
    touch('pointermove', 2, Number.NaN, 200),
    touch('pointermove', 2, 300, 200),
  ])
  assert.equal(results[2]!.pinch, null, 'a NaN move emits nothing')
  assert.equal(results[3]!.pinch!.factor, 2, 'the following good move still measures against the last good anchor')
}

// ============================================================================
// 9. resetMultiTouch drops everything — the pointercancel/blur path, where the
//    pointerups this reducer waits for are never delivered.
// ============================================================================
{
  const { state } = play([touch('pointerdown', 1, 0, 0), touch('pointerdown', 2, 50, 0)])
  assert.equal(state.suppressing, true)
  const after = resetMultiTouch()
  assert.equal(after.suppressing, false)
  assert.equal(reduceMultiTouch(after, touch('pointerdown', 9, 1, 1)).forward, true, 'a cancelled pinch does not eat the next gesture')
}

// ============================================================================
// 10. applyPinch: the world point under the anchor stays put across the zoom
//     half, and the pan half moves content WITH the fingers.
// ============================================================================
{
  const camera = { x: 12, y: -34, z: 1.5 }
  const anchor = { x: 400, y: 260 }
  const before = screenToWorld(camera, anchor)
  const zoomOnly = applyPinch(camera, { type: 'pinch', x: anchor.x, y: anchor.y, factor: 1.7, dx: 0, dy: 0, t: 0 })
  const after = screenToWorld(zoomOnly, anchor)
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, 'a pure pinch keeps the world point under the midpoint fixed')
  assert.ok(Math.abs(zoomOnly.z - camera.z * 1.7) < 1e-9, 'the zoom factor is applied multiplicatively')
}
{
  // The pan half, at a zoom OTHER than 1 — the case where a `/z` omission or a
  // pre-zoom `z` would still pass at 100% and be wrong everywhere else.
  const camera = { x: 0, y: 0, z: 2 }
  const panned = applyPinch(camera, { type: 'pinch', x: 100, y: 100, factor: 1, dx: 40, dy: -20, t: 0 })
  // Content follows the fingers: the world point that WAS at screen (100,100)
  // is now at screen (140, 80).
  const wasUnder = screenToWorld(camera, { x: 100, y: 100 })
  const nowAt = screenToWorld(panned, { x: 140, y: 80 })
  assert.ok(Math.abs(wasUnder.x - nowAt.x) < 1e-9 && Math.abs(wasUnder.y - nowAt.y) < 1e-9, 'content pans WITH the fingers, at the post-zoom scale')
}
{
  // Zoom and pan in the SAME sample, which is every real sample: the world
  // point under the OLD midpoint must end up under the NEW one.
  const camera = { x: -20, y: 60, z: 0.8 }
  const event = { type: 'pinch' as const, x: 300, y: 200, factor: 1.4, dx: 25, dy: -15, t: 0 }
  const wasUnder = screenToWorld(camera, { x: event.x, y: event.y })
  const next = applyPinch(camera, event)
  const nowAt = screenToWorld(next, { x: event.x + event.dx, y: event.y + event.dy })
  assert.ok(Math.abs(wasUnder.x - nowAt.x) < 1e-9 && Math.abs(wasUnder.y - nowAt.y) < 1e-9, 'the grabbed world point travels with the midpoint')
}
{
  // Clamp + poison guards.
  const camera = { x: 1, y: 2, z: 1 }
  assert.equal(applyPinch(camera, { type: 'pinch', x: 0, y: 0, factor: 0.0001, dx: 0, dy: 0, t: 0 }).z, MIN_ZOOM, 'zoom clamps at the floor')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.deepEqual(applyPinch(camera, { type: 'pinch', x: 0, y: 0, factor: bad, dx: 0, dy: 0, t: 0 }), camera, `factor ${bad} is a no-op`)
  }
  assert.deepEqual(applyPinch(camera, { type: 'pinch', x: 0, y: 0, factor: 2, dx: Number.NaN, dy: 0, t: 0 }), camera, 'a NaN pan is a no-op')
}

console.log('multi-touch.test.ts OK')
