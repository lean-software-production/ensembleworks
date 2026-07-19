// Run: bun src/tools/hand.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createHandTool } from './hand.js'
import { createToolContext } from './tool-context.js'
import { DRAG_THRESHOLD } from '../input.js'

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createHandTool(ctx)
  return { editor, tool }
}

// ============================================================================
// 1. Drag pans: at z=1, a screen delta pans the camera by exactly that delta
//    (camera.xy += screenDelta / z).
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(100, 100).move(150, 130).up().events()
  run(editor, tool, events)
  assert.deepEqual(editor.get().camera, { x: 50, y: 30, z: 1 }, 'pan at z=1 moves camera by exactly the screen delta')
  console.log('ok: hand-tool drag pans by the screen delta at z=1')
}

// ============================================================================
// 2. Zoom-compensated pan at z=2: the SAME 50/30 screen delta must move the
//    camera by half that in world units (screenDelta / z).
// ============================================================================
{
  const { editor, tool } = setup()
  editor.apply({ type: 'SetCamera', x: 0, y: 0, z: 2 })
  const events = script().down(100, 100).move(150, 130).up().events()
  run(editor, tool, events)
  assert.deepEqual(editor.get().camera, { x: 25, y: 15, z: 2 }, 'pan at z=2 divides the screen delta by z; z itself is unchanged by a plain drag')
  console.log('ok: hand-tool drag pan is zoom-compensated (screen delta / z) at z=2')
}

// ============================================================================
// 3. Sub-threshold move does not pan at all (still "pointing", no SetCamera).
// ============================================================================
{
  const { editor, tool } = setup()
  const small = DRAG_THRESHOLD - 1
  const events = script().down(0, 0).move(small, 0).up().events()
  run(editor, tool, events)
  assert.deepEqual(editor.get().camera, { x: 0, y: 0, z: 1 }, 'a sub-threshold move never pans the camera')
  console.log('ok: sub-threshold pointer move does not pan')
}

// ============================================================================
// 4. Recompute-from-origin: panning is computed from the drag's ORIGIN and
//    the camera AT DRAG START each event, not incrementally — multiple
//    intermediate pointermoves land on the exact same final camera as one
//    big jump covering the same net screen delta.
// ============================================================================
{
  const { editor: editorA, tool: toolA } = setup()
  run(editorA, toolA, script().down(0, 0).move(80, 40).up().events())

  const { editor: editorB, tool: toolB } = setup()
  run(editorB, toolB, script().down(0, 0).move(80, 40, { steps: 7 }).up().events())

  assert.deepEqual(editorA.get().camera, editorB.get().camera, 'a multi-step drag lands on the identical final camera as a single jump covering the same net delta')
  console.log('ok: panning recomputes from the drag origin, so intermediate steps do not accumulate drift')
}

// ============================================================================
// 5. Wheel is handled uniformly regardless of the tool's own drag state:
//    plain wheel pans even while idle; ctrl+wheel zooms even while pointing.
// ============================================================================
{
  const { editor, tool } = setup()
  const planeWheel = script().wheel(10, 20, { at: [0, 0] }).events()
  run(editor, tool, planeWheel)
  assert.deepEqual(editor.get().camera, { x: -10, y: -20, z: 1 }, 'plain wheel pans while idle (subtracted — wheel-down reveals content below)')

  const { editor: editor2, tool: tool2 } = setup()
  const events = script().down(500, 500).wheel(0, 50, { at: [500, 500], modifiers: { ctrl: true } }).events()
  run(editor2, tool2, events)
  assert.ok(editor2.get().camera.z !== 1, 'ctrl+wheel zooms even mid-gesture (while pointing, before any drag threshold is crossed)')
  console.log('ok: wheel handling is uniform across the hand tool\'s FSM modes')
}

console.log('ok: hand tool + camera pan/zoom')
