// Run: bun src/tools/select.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createSelectTool } from './select.js'
import { createToolContext } from './tool-context.js'

const FIXED_RANDOM = () => 0.5

const geoShape = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): Shape => ({
  id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation,
  isLocked: false, opacity: 1, meta: {}, props: { w, h },
} as Shape)

// Two side-by-side 100x100 boxes: shape:a at [0,100]x[0,100], shape:b at
// [200,300]x[0,100] (a gap between them so (150,50) is a guaranteed miss),
// plus the exact diamond fixture from canvas-model/spatial-index.test.ts
// (100x100 box at origin rotated pi/4 -- reused so the AABB-corner-miss
// numbers are pinned to an already-reviewed source, not invented here).
function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape(geoShape('shape:a', 0, 0))
  doc.putShape(geoShape('shape:b', 200, 0))
  doc.putShape(geoShape('shape:diamond', 500, 500, 100, 100, Math.PI / 4))
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createSelectTool(ctx)
  return { doc, editor, ctx, tool }
}

// ============================================================================
// 1. Click-select: pointerdown+up inside shape:a, no drag -> SetSelection([a]).
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(50, 50).up().events()
  run(editor, tool, events)
  assert.deepEqual([...editor.get().selection], ['shape:a'], 'click inside shape:a selects it')
  console.log('ok: click-select')
}

// ============================================================================
// 2. Click-empty deselects: select shape:a, then click empty space.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script()
    .down(50, 50).up() // select shape:a
    .down(150, 50).up() // empty gap between shape:a and shape:b
    .events()
  run(editor, tool, events)
  assert.deepEqual([...editor.get().selection], [], 'click on empty canvas clears the selection')
  console.log('ok: click-empty deselects')
}

// ============================================================================
// 3. Shift-click add + toggle: click shape:a, shift-click shape:b (adds),
//    shift-click shape:b again (toggles it back off).
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script()
    .down(50, 50).up() // select shape:a
    .down(250, 50, { modifiers: { shift: true } }).up({ modifiers: { shift: true } }) // shift-click shape:b: add
    .events()
  let state = run(editor, tool, events)
  assert.deepEqual(new Set(editor.get().selection), new Set(['shape:a', 'shape:b']), 'shift-click adds shape:b to the selection')

  const toggleOff = script()
    .down(250, 50, { modifiers: { shift: true } }).up({ modifiers: { shift: true } }) // shift-click shape:b again: toggle off
    .events()
  run(editor, tool, toggleOff)
  assert.deepEqual([...editor.get().selection], ['shape:a'], 'shift-clicking an already-selected shape toggles it off')
  void state
  console.log('ok: shift-click add + toggle')
}

// ============================================================================
// 4. Sub-threshold move does not count as a drag: down inside shape:a, move
//    2px (< DRAG_THRESHOLD's 4px), up -- must resolve as a click-select, not
//    a translate (shape:a's position is untouched).
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(50, 50).move(52, 50).up().events()
  run(editor, tool, events)
  assert.deepEqual([...editor.get().selection], ['shape:a'], 'sub-threshold move still resolves as a click-select')
  const a = editor.doc.getShape('shape:a')!
  assert.equal(a.x, 0, 'shape:a did not move')
  assert.equal(a.y, 0)
  console.log('ok: sub-threshold move is a click, not a drag')
}

// ============================================================================
// 5. Drag-translate at z=1: moves the shape by EXACTLY the world delta
//    (== screen delta at z=1).
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(50, 50).move(60, 60).up().events()
  run(editor, tool, events)
  const a = editor.doc.getShape('shape:a')!
  assert.equal(a.x, 10, 'shape:a moved by the exact world dx at z=1 (screen delta 10 == world delta 10)')
  assert.equal(a.y, 10)
  assert.deepEqual([...editor.get().selection], ['shape:a'], 'the dragged shape ends up selected')
  console.log('ok: drag-translate at z=1 moves by the exact world delta')
}

// ============================================================================
// 6. Drag-translate at z=2 (zoom-compensation): a 10px SCREEN delta must
//    move the shape by exactly 5 WORLD units -- proves TranslateShapes'
//    delta is computed in world space (screen delta / camera.z), not screen
//    space.
// ============================================================================
{
  const { editor, tool } = setup()
  editor.apply({ type: 'SetCamera', x: 0, y: 0, z: 2 })
  // World (50,50) (inside shape:a) is screen (100,100) at z=2 (camera.xy=0):
  // screen = (world + camera.xy) * z.
  const events = script().down(100, 100).move(110, 100).up().events()
  run(editor, tool, events)
  const a = editor.doc.getShape('shape:a')!
  assert.equal(a.x, 5, 'a 10px screen delta at z=2 moves the shape by exactly 5 world units')
  assert.equal(a.y, 0)
  console.log('ok: drag-translate at z=2 is zoom-compensated (screen delta / z)')
}

// ============================================================================
// 7. Marquee (intersect mode): the AABB-corner-miss and true-hit cases from
//    canvas-model/spatial-index.test.ts, driven end to end through the tool.
// ============================================================================
{
  // Miss: marquee sits in the diamond's AABB corner but outside its true quad.
  const { editor, tool } = setup()
  const missEvents = script().down(430, 630).move(440, 640).up().events() // world (-70,130)-(-60,140) relative to (500,500) offset
  run(editor, tool, missEvents)
  assert.deepEqual([...editor.get().selection], [], 'marquee in the AABB corner misses the true (rotated) diamond')
  console.log('ok: marquee AABB-corner case correctly misses the rotated shape')
}
{
  // Hit: marquee actually touches the diamond's true quad.
  const { editor, tool } = setup()
  const hitEvents = script().down(495, 635).move(505, 645).up().events() // world (-5,135)-(5,145) relative to (500,500) offset
  run(editor, tool, hitEvents)
  assert.deepEqual([...editor.get().selection], ['shape:diamond'], 'marquee that actually touches the rotated quad selects it')
  console.log('ok: marquee correctly selects when it touches the true rotated quad')
}

// ============================================================================
// 8. Drag of an unselected target selects it first: shape:a is selected,
//    then the user drags shape:b (not in the selection) -- the selection
//    must become [shape:b] alone (not [a, b]), and shape:b must move.
// ============================================================================
{
  const { editor, tool } = setup()
  const selectA = script().down(50, 50).up().events()
  run(editor, tool, selectA)
  assert.deepEqual([...editor.get().selection], ['shape:a'])

  const dragB = script().down(250, 50).move(260, 60).up().events()
  run(editor, tool, dragB)
  assert.deepEqual([...editor.get().selection], ['shape:b'], 'dragging an unselected shape replaces the selection with just that shape')
  const b = editor.doc.getShape('shape:b')!
  assert.equal(b.x, 210, 'shape:b moved by the drag delta')
  assert.equal(b.y, 10)
  const a = editor.doc.getShape('shape:a')!
  assert.equal(a.x, 0, 'shape:a (no longer selected) did not move')
  console.log('ok: drag of an unselected target selects it first, replacing the old selection')
}

// ============================================================================
// 9. Mid-drag remote deletion of the target: tolerance contract means no
//    throw -- the drag continues as a no-op once the target vanishes.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(50, 50).move(60, 60)
  const midEvents = events.events()
  let state = tool.initialState
  for (const event of midEvents) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
  }
  assert.equal(editor.doc.getShape('shape:a')!.x, 10, 'shape:a moved during the drag before the remote delete')

  // Remote peer deletes shape:a mid-gesture.
  editor.apply({ type: 'DeleteShapes', ids: ['shape:a'] })
  assert.equal(editor.doc.getShape('shape:a'), undefined)

  // Drag continues: further pointermove + pointerup must not throw. Built as
  // raw InputEvents (not via script(), which has no cross-call position
  // memory of its own) continuing from the drag's last screen point (60,60).
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  assert.doesNotThrow(() => {
    const moreEvents = [
      { type: 'pointermove' as const, x: 70, y: 70, buttons: 1, modifiers: NEUTRAL, t: 1000 },
      { type: 'pointerup' as const, x: 70, y: 70, buttons: 0, modifiers: NEUTRAL, t: 1010 },
    ]
    for (const event of moreEvents) {
      const result = tool.onEvent(state, event)
      state = result.state
      if (result.intents.length > 0) editor.applyAll(result.intents)
    }
  }, 'mid-drag remote delete of the target must not throw; the drag continues as a no-op')
  assert.equal(editor.doc.getShape('shape:a'), undefined, 'shape:a stays deleted -- no resurrection from the tolerant skip')
  console.log('ok: mid-drag remote deletion of the target is tolerated (no throw, no-op continuation)')
}

console.log('ok: select tool FSM (select/marquee/translate)')
