// Run: bun src/canvas-v2/shapes/TerminalShape.test.ts
//
// TEST-HARNESS LIMITATION (stated once, applies to this whole file): xterm.js
// mounts a real Terminal against a DOM container and TerminalShape.tsx
// imports '@xterm/xterm/css/xterm.css' at module scope — neither survives a
// plain `bun run` (no DOM emulator in this house rig; see canvas-react's
// embed/EmbedHost.tsx TEST-HARNESS LIMITATION note for the project's general
// posture on this). So this file tests ONLY the pure half: `terminalContentFrom`,
// the props->render-input adapter. Real mounting (xterm opens, the WS
// connects, the deterministic grid resizes it, focus swallows keys) is
// unproven by ANY test in this repo yet — proving it is G2-golden/H2 E2E
// territory, exactly as this unit's plan anticipated ("terminal/screenshare
// shells may render placeholder frames statically — verify" — verified here:
// they do NOT, because of the xterm import above, and that's an honest,
// stated limitation rather than a forced/fragile static render).
import assert from 'node:assert/strict'
import type { Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '@ensembleworks/canvas-editor'
import { terminalContentFrom, terminalRenameIntent, terminalTitleDragIntent } from './TerminalShape.js'

function shapeWithProps(props: Record<string, unknown>): Shape {
  return { id: 'shape:t1', kind: 'terminal', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as Shape
}

// Full props round-trip.
{
  const shape = shapeWithProps({ w: 900, h: 500, sessionId: 'canvas-abc', title: 'my term', gateway: 'gw-1', fontSize: 20 })
  const content = terminalContentFrom(shape)
  assert.deepEqual(content, { w: 900, h: 500, sessionId: 'canvas-abc', title: 'my term', gateway: 'gw-1', fontSize: 20 })
}

// Missing/malformed props fall back to the same defaults as the legacy
// ShapeUtil's getDefaultProps (minus the min-size clamp, which only applies
// server/creation-side).
{
  const content = terminalContentFrom(shapeWithProps({}))
  assert.equal(content.sessionId, 'default')
  assert.equal(content.title, 'terminal')
  assert.equal(content.gateway, undefined)
  assert.equal(content.fontSize, 16)
  assert.ok(content.w > 0 && content.h > 0)
}

// Malformed types (wrong runtime type in the untyped props bag) fall back
// rather than propagating garbage into the render.
{
  const content = terminalContentFrom(shapeWithProps({ w: 'nope', sessionId: 42, fontSize: null }))
  assert.equal(typeof content.w, 'number')
  assert.equal(content.sessionId, 'default')
  assert.equal(content.fontSize, 16)
}

console.log('ok: TerminalShape — terminalContentFrom adapter (pure half only; see header for the static-render limitation)')

// Task D3: terminal title rename + title-drag-to-move, restored via the D2
// dispatch channel. TerminalShape.tsx itself cannot be exercised end-to-end
// here (see the TEST-HARNESS LIMITATION header above — xterm/DOM), so these
// prove the PURE half: the exact Intent(s) the rename-commit handler and the
// title-bar pointermove handler compute, using a fake dispatch spy exactly
// like shape-layer.test.ts/embed.test.ts's dispatchCalls pattern (the
// component itself only ever calls `dispatch?.(...)` with what these
// functions return).

// terminalRenameIntent — commit-once + no-op guard: a rename handler is
// expected to call this ONCE, on commit (blur/Enter), never per keystroke,
// and to skip dispatching entirely when the title didn't actually change.
{
  const dispatchCalls: Intent[][] = []
  const dispatch = (intents: Intent[]) => dispatchCalls.push(intents)

  // Simulates typing "web-server" one keystroke at a time WITHOUT ever
  // calling terminalRenameIntent per keystroke (that's the component's job
  // to avoid) — only the FINAL commit computes/dispatches an intent.
  const keystrokes = ['w', 'we', 'web', 'web-', 'web-s', 'web-se', 'web-ser', 'web-serv', 'web-serve', 'web-server']
  let draft = 'terminal'
  for (const k of keystrokes) draft = k // local state updates only, no dispatch
  const commitIntent = terminalRenameIntent('shape:t1', 'terminal', draft)
  assert.ok(commitIntent, 'a changed title produces an intent to dispatch on commit')
  if (commitIntent) dispatch([commitIntent])
  assert.equal(dispatchCalls.length, 1, 'exactly ONE dispatch call for the whole rename gesture — not one per keystroke')
  assert.deepEqual(
    dispatchCalls[0],
    [{ type: 'UpdateProps', id: 'shape:t1', props: { title: 'web-server' } }],
    'rename commit dispatches UpdateProps with the final title'
  )

  // No-op guard: committing back to the SAME title (e.g. focus/blur with no
  // edit) must not dispatch at all.
  const noopIntent = terminalRenameIntent('shape:t1', 'terminal', 'terminal')
  assert.equal(noopIntent, null, 'an unchanged title is a no-op — no UpdateProps intent')
  assert.equal(dispatchCalls.length, 1, 'the no-op guard means no additional dispatch call')

  console.log('ok: terminalRenameIntent — commits once with the final title, no-ops when unchanged')
}

// terminalTitleDragIntent — WORLD-unit conversion: a title-bar drag's
// pointermove delta arrives in SCREEN pixels; the intent's dx/dy must be the
// SCREEN delta divided by camera.z (screen = (world + camera.xy) * z, so a
// DELTA divides by z alone — camera.xy cancels between two points at the
// same z; see camera.ts's NORMATIVE convention).
{
  // camera.z === 1: screen delta and world delta coincide.
  assert.deepEqual(
    terminalTitleDragIntent(['shape:t1'], 12, -4, 1),
    { type: 'TranslateShapes', ids: ['shape:t1'], dx: 12, dy: -4 },
    'at z=1, world delta equals the screen delta'
  )

  // camera.z === 2 (zoomed in 2x): a 20px screen delta is a 10-world-unit
  // move — dividing, not multiplying, by z.
  assert.deepEqual(
    terminalTitleDragIntent(['shape:t1'], 20, 40, 2),
    { type: 'TranslateShapes', ids: ['shape:t1'], dx: 10, dy: 20 },
    'at z=2, world delta is HALF the screen delta'
  )

  // camera.z === 0.5 (zoomed out 2x): the same screen delta is a LARGER
  // world-unit move.
  assert.deepEqual(
    terminalTitleDragIntent(['shape:t1'], 10, 10, 0.5),
    { type: 'TranslateShapes', ids: ['shape:t1'], dx: 20, dy: 20 },
    'at z=0.5, world delta is DOUBLE the screen delta'
  )

  // Fake dispatch spy: a per-pointermove drag dispatches ONE incremental
  // TranslateShapes per move (the accepted drag cadence — matches
  // canvas-editor/src/tools/select.ts's onDragging).
  const dispatchCalls: Intent[][] = []
  const dispatch = (intents: Intent[]) => dispatchCalls.push(intents)
  const cameraZ = 2
  const moves = [
    { dx: 10, dy: 0 },
    { dx: 6, dy: 8 },
  ]
  for (const move of moves) dispatch([terminalTitleDragIntent(['shape:t1'], move.dx, move.dy, cameraZ)])
  assert.deepEqual(
    dispatchCalls,
    [
      [{ type: 'TranslateShapes', ids: ['shape:t1'], dx: 5, dy: 0 }],
      [{ type: 'TranslateShapes', ids: ['shape:t1'], dx: 3, dy: 4 }],
    ],
    'each pointermove during a title-bar drag dispatches its own incremental world-delta TranslateShapes'
  )

  console.log('ok: terminalTitleDragIntent — screen delta / camera.z, incremental per-pointermove dispatch')
}
// House rule (see canvas-react/src/embed/embed-reconciler.test.ts): explicit
// exit — TerminalShape's import graph pulls in @xterm/xterm (+ its css) at
// module scope, which can hold the event loop open after the last assertion.
process.exit(0)
