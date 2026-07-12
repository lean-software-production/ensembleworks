// Run: bun src/script.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Editor } from './editor.js'
import type { Intent } from './intents.js'
import { DRAG_THRESHOLD, exceedsDragThreshold, screenToWorld, worldToScreen, type InputEvent, type Tool } from './input.js'
import { run, script } from './script.js'

const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }

// ============================================================================
// 1. Exact expected InputEvent[] — pinned by hand from the DSL's documented
//    semantics (steps intermediate points at fraction i/(steps+1), landing
//    point always last, one tick per emitted event), NOT by re-deriving the
//    formula and comparing to itself — this is the actual contract a
//    replayed session depends on staying stable.
// ============================================================================
{
  const events = script({ startT: 100, dt: 10 })
    .down(10, 10)
    .move(50, 50, { steps: 3 })
    .up()
    .key('Escape')
    .wheel(0, -120, { at: [5, 5] })
    .events()

  const expected: InputEvent[] = [
    { type: 'pointerdown', x: 10, y: 10, buttons: 1, modifiers: NEUTRAL, t: 100 },
    { type: 'pointermove', x: 20, y: 20, buttons: 1, modifiers: NEUTRAL, t: 110 }, // frac 1/4
    { type: 'pointermove', x: 30, y: 30, buttons: 1, modifiers: NEUTRAL, t: 120 }, // frac 2/4
    { type: 'pointermove', x: 40, y: 40, buttons: 1, modifiers: NEUTRAL, t: 130 }, // frac 3/4
    { type: 'pointermove', x: 50, y: 50, buttons: 1, modifiers: NEUTRAL, t: 140 }, // exact landing point
    { type: 'pointerup', x: 50, y: 50, buttons: 0, modifiers: NEUTRAL, t: 150 },
    { type: 'keydown', key: 'Escape', modifiers: NEUTRAL, t: 160 },
    { type: 'wheel', x: 5, y: 5, dx: 0, dy: -120, modifiers: NEUTRAL, t: 170 },
  ]
  assert.deepEqual(events, expected)
  console.log('ok: script() produces the exact documented InputEvent[] (interpolation, timestamps, modifiers)')
}

// ============================================================================
// 2. Determinism: two builds from the same opts and the same call sequence
//    produce isDeepStrictEqual arrays — no hidden state, no real clock.
// ============================================================================
{
  const build = () => script({ startT: 0, dt: 16 }).down(0, 0, { modifiers: { shift: true } }).move(100, 0, { steps: 5 }).up().events()
  assert.deepEqual(build(), build())
  console.log('ok: two identical scripts produce identical event arrays')
}

// ============================================================================
// 3. Monotonic timestamps hold even at steps: 0 and steps: 1 — every emitted
//    event still consumes exactly one tick, interpolation step count aside.
// ============================================================================
{
  const isStrictlyIncreasing = (events: readonly InputEvent[]) =>
    events.every((e, i) => i === 0 || e.t > events[i - 1]!.t)

  const zeroSteps = script({ startT: 0, dt: 5 }).down(0, 0).move(10, 10, { steps: 0 }).up().events()
  assert.equal(zeroSteps.length, 3, 'steps:0 emits just the landing pointermove — no intermediate points')
  assert.ok(isStrictlyIncreasing(zeroSteps))
  assert.deepEqual(zeroSteps.map((e) => e.t), [0, 5, 10])

  const oneStep = script({ startT: 0, dt: 5 }).down(0, 0).move(10, 10, { steps: 1 }).up().events()
  assert.equal(oneStep.length, 4, 'steps:1 emits one intermediate point + the landing point')
  assert.ok(isStrictlyIncreasing(oneStep))
  assert.deepEqual(oneStep.map((e) => e.t), [0, 5, 10, 15])

  console.log('ok: timestamps are strictly monotone regardless of interpolation step count')
}

// ============================================================================
// 4. DRAG_THRESHOLD / exceedsDragThreshold: below, exactly at (not
//    exceeding — the comparison is strict >, matching tldraw's own
//    dragDistanceSquared check), and above the threshold.
// ============================================================================
{
  assert.equal(DRAG_THRESHOLD, 4, 'pinned to tldraw dragDistanceSquared:16 (4 squared) — node_modules, @tldraw editor package, dist-cjs/lib/options.js:36')
  assert.equal(exceedsDragThreshold({ x: 0, y: 0 }, { x: 3, y: 0 }), false, '3px < 4px threshold')
  assert.equal(exceedsDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 }), false, 'exactly at threshold does not exceed it (strict >)')
  assert.equal(exceedsDragThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }), true, '5px > 4px threshold')
  assert.equal(exceedsDragThreshold({ x: 0, y: 0 }, { x: 3, y: 3 }), true, 'diagonal sqrt(18) ~= 4.24 > 4')

  // A script's down/move pair crossing vs. not crossing the threshold is
  // distinguishable by this helper, end to end:
  const notDragging = script().down(0, 0).move(3, 0).events()
  const dragging = script().down(0, 0).move(5, 0).events()
  const start = (events: readonly InputEvent[]) => events[0] as { x: number; y: number }
  const last = (events: readonly InputEvent[]) => events[events.length - 1] as { x: number; y: number }
  assert.equal(exceedsDragThreshold(start(notDragging), last(notDragging)), false)
  assert.equal(exceedsDragThreshold(start(dragging), last(dragging)), true)

  console.log('ok: exceedsDragThreshold distinguishes a click-sized move from a drag-sized one')
}

// ============================================================================
// 5. run(): the minimal dispatch loop. A trivial recording stub tool proves
//    events are fed in exact order, its returned intents are applied to the
//    editor (advancing EditorState), and the final FSM state is returned.
// ============================================================================
{
  interface StubState { readonly log: readonly string[] }
  const stubTool: Tool<StubState> = {
    initialState: { log: [] },
    onEvent(state, event) {
      const intents: Intent[] = []
      // Only pointer events drive the camera here — proves run() applies
      // PER-EVENT intents (keydown/wheel below emit none) rather than
      // batching the whole script into one call.
      if (event.type === 'pointerdown' || event.type === 'pointermove' || event.type === 'pointerup') {
        intents.push({ type: 'SetCamera', x: event.x, y: event.y, z: 1 })
      }
      return { state: { log: [...state.log, event.type] }, intents }
    },
  }

  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0, pageId: 'page:p' })
  let notifications = 0
  editor.subscribe(() => { notifications += 1 })

  const events = script({ startT: 0, dt: 10 }).down(1, 2).move(3, 4).up().key('a').wheel(0, 1).events()
  const finalState = run(editor, stubTool, events)

  assert.deepEqual(finalState.log, ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'wheel'], 'events fed to the tool in exact order')
  assert.deepEqual(editor.get().camera, { x: 3, y: 4, z: 1 }, 'the last pointer event\'s intent was applied — editor state advanced')
  assert.equal(notifications, 3, 'one notification per event that produced an intent (pointerdown/move/up) — keydown/wheel produced none')

  console.log('ok: run() dispatches events in order, applies intents, advances editor state')
}

// ============================================================================
// 6. Camera convention (NORMATIVE — see input.ts's CAMERA CONVENTION block):
//    screen = (world + camera.xy) · z; world = screen/z − camera.xy. One
//    hand-computed case at z ≠ 1 (derived on paper, not by calling the
//    helpers) plus an exact round-trip both directions.
// ============================================================================
{
  const camera = { x: 10, y: 20, z: 2 }
  // Hand-computed: world (5, 5) -> screen ((5+10)*2, (5+20)*2) = (30, 50).
  assert.deepEqual(worldToScreen(camera, { x: 5, y: 5 }), { x: 30, y: 50 })
  // And back: screen (30, 50) -> world (30/2 - 10, 50/2 - 20) = (5, 5).
  assert.deepEqual(screenToWorld(camera, { x: 30, y: 50 }), { x: 5, y: 5 })
  // Round-trips are exact for these values (all arithmetic exact in floats).
  const world = { x: -7.5, y: 123 }
  assert.deepEqual(screenToWorld(camera, worldToScreen(camera, world)), world)
  const screen = { x: 99, y: -3 }
  assert.deepEqual(worldToScreen(camera, screenToWorld(camera, screen)), screen)
  // Identity camera: screen space IS world space.
  const identity = { x: 0, y: 0, z: 1 }
  assert.deepEqual(worldToScreen(identity, { x: 42, y: 17 }), { x: 42, y: 17 })
  console.log('ok: camera convention — screen = (world + camera.xy) * z, exact round-trip')
}

// ============================================================================
// 7. Wheel sign convention pin: dx/dy mirror DOM WheelEvent.deltaX/deltaY
//    verbatim — positive dy = scroll down/away = conventional zoom-OUT when
//    a camera consumer interprets it. The DSL must never re-sign.
// ============================================================================
{
  const [e] = script().wheel(3, 120).events()
  assert.deepEqual(
    { dx: (e as { dx: number }).dx, dy: (e as { dy: number }).dy },
    { dx: 3, dy: 120 },
    'wheel dx/dy pass through with DOM WheelEvent sign — positive dy is scroll-down/zoom-out, unre-signed',
  )
  console.log('ok: wheel dx/dy carry the DOM deltaX/deltaY sign convention verbatim')
}

console.log('ok: canvas-editor input + interaction-script DSL')
