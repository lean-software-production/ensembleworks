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
const kindShape = (kind: string, id: string, x: number, y: number, w = 100, h = 100): Shape => ({
  id, kind, parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w, h },
} as Shape)

// Two side-by-side 100x100 boxes: shape:a at [0,100]x[0,100], shape:b at
// [200,300]x[0,100] (a gap between them so (150,50) is a guaranteed miss),
// plus the exact diamond fixture from canvas-model/spatial-index.test.ts
// (100x100 box at origin rotated pi/4 -- reused so the AABB-corner-miss
// numbers are pinned to an already-reviewed source, not invented here), plus
// a text-capable 'note' shape and a non-text-capable 'terminal' shape (both
// 100x100, so medianSize -- and hence the snap threshold -- stays 100/5 no
// matter how many of these fixture shapes a given test exercises).
function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape(geoShape('shape:a', 0, 0))
  doc.putShape(geoShape('shape:b', 200, 0))
  doc.putShape(geoShape('shape:diamond', 500, 500, 100, 100, Math.PI / 4))
  doc.putShape(kindShape('note', 'shape:note', 400, 0))
  doc.putShape(kindShape('terminal', 'shape:terminal', 600, 0))
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

// ============================================================================
// 10. Double-click-to-edit: dbl-click a text-capable shape ('note') begins
//    editing (BeginEdit) and selects it.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script()
    .down(450, 50).up()   // first click on shape:note
    .down(450, 50).up()   // second click: same target, same point, 16ms later (default dt)
    .events()
  run(editor, tool, events)
  assert.equal(editor.get().editingId, 'shape:note', 'double-click on a text-capable shape begins editing')
  assert.deepEqual([...editor.get().selection], ['shape:note'], 'the double-clicked shape is also selected')
  console.log('ok: double-click on a text-capable shape (note) emits BeginEdit')
}

// ============================================================================
// 11. Double-click on a NON-text-capable kind ('terminal') never begins
//    editing -- falls through to ordinary single-click selection instead.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script()
    .down(650, 50).up()
    .down(650, 50).up()
    .events()
  run(editor, tool, events)
  assert.equal(editor.get().editingId, null, 'double-click on a non-text-capable (embed) shape kind never begins editing')
  assert.deepEqual([...editor.get().selection], ['shape:terminal'], 'the second click still resolves as an ordinary single-click select')
  console.log('ok: double-click on a non-text-capable shape kind does not begin editing')
}

// ============================================================================
// 12. Slow second click (gap exceeds DOUBLE_CLICK_MS) is NOT a double-click.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script({ dt: 500 }).down(450, 50).up().down(450, 50).up().events() // 500ms between every event > 450ms window
  run(editor, tool, events)
  assert.equal(editor.get().editingId, null, 'a slow second click (exceeding DOUBLE_CLICK_MS) is not a double-click')
  assert.deepEqual([...editor.get().selection], ['shape:note'], 'the slow second click still resolves as its own ordinary click')
  console.log('ok: slow second click does not trigger edit')
}

// ============================================================================
// 13. Second click on a DIFFERENT shape is NOT a double-click.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(450, 50).up().down(50, 50).up().events() // first click on shape:note, second on shape:a
  run(editor, tool, events)
  assert.equal(editor.get().editingId, null, 'a second click on a DIFFERENT target is not a double-click')
  assert.deepEqual([...editor.get().selection], ['shape:a'], 'the second click still resolves as its own normal single-click select')
  console.log('ok: second click on a different shape does not trigger edit')
}

// ============================================================================
// 14. Snap-during-drag: dragging shape:a near shape:b's left edge snaps the
//    translate exactly onto that edge, and the SnapResult (with a guide) is
//    carried in the FSM's Dragging state.
//
//    Hand-computed (absolute-anchor model): pointerdown(50,50) [inside
//    shape:a] sets grabWorld=(50,50); startBounds = shape:a's world bounds
//    [0,100]x[0,100], frozen at drag start. move(60,60) crosses the drag
//    threshold: raw TOTAL delta from the grab = (10,10) -> candidate bounds
//    [10,110]x[10,110] -- right edge (110) is 90 units from shape:b's edge
//    at 200, past the 5-unit threshold, no snap -> total (10,10) applied,
//    shape:a lands at (10,10). A SECOND move to (147,50), while already
//    'dragging': raw TOTAL delta from the grab = (97,0) -> candidate bounds
//    startBounds+(97,0) = [97,197]x[0,100] -- shape:a's right edge (197) is
//    3 units short of shape:b's left edge (200), within the 5-unit
//    threshold -> snap dx=+3 (y already aligned at 0, snap dy=0). Snapped
//    TOTAL = (100,0); the STEP committed this move is total - applied =
//    (100-10, 0-10) = (90,-10) -> shape:a's final position: (10+90, 10-10)
//    = (100, 0), landing EXACTLY on shape:b's left edge.
// ============================================================================
{
  const { editor, tool, doc } = setup()
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  const down = { type: 'pointerdown' as const, x: 50, y: 50, buttons: 1, modifiers: NEUTRAL, t: 0 }
  const move1 = { type: 'pointermove' as const, x: 60, y: 60, buttons: 1, modifiers: NEUTRAL, t: 16 }
  const move2 = { type: 'pointermove' as const, x: 147, y: 50, buttons: 1, modifiers: NEUTRAL, t: 32 }

  let state = tool.initialState
  for (const event of [down, move1]) {
    const r = tool.onEvent(state, event)
    state = r.state
    if (r.intents.length > 0) editor.applyAll(r.intents)
  }
  assert.equal((state as any).mode, 'dragging', 'precondition: past the drag threshold after move1')
  const excludedIdsAfterMove1 = (state as any).excludedIds
  assert.deepEqual([...excludedIdsAfterMove1], ['shape:a'], 'excludedIds is movingIds (shape:a has no descendants)')
  {
    const a = doc.getShape('shape:a')!
    assert.equal(a.x, 10, 'move1 (unsnapped -- shape:b is 90 units away, past threshold) applies the raw delta verbatim')
    assert.equal(a.y, 10)
  }

  const r2 = tool.onEvent(state, move2)
  state = r2.state
  if (r2.intents.length > 0) editor.applyAll(r2.intents)

  assert.equal((state as any).mode, 'dragging')
  assert.equal((state as any).excludedIds, excludedIdsAfterMove1, 'excludedIds is the SAME Set reference across moves -- computed ONCE at drag start, never recomputed per pointermove')
  const snapResult = (state as any).snapResult
  assert.ok(snapResult, 'a SnapResult is carried on the Dragging state after a move')
  assert.ok(
    snapResult.guides.some((g: any) => g.axis === 'x' && g.at === 200 && g.kind === 'edge'),
    `expected an x-edge guide at 200, got ${JSON.stringify(snapResult.guides)}`,
  )
  const a = doc.getShape('shape:a')!
  assert.equal(a.x, 100, 'the snap delta (+3) is added on top of the raw drag delta (87), landing shape:a exactly on the aligned edge')
  assert.equal(a.y, 0, 'y was already aligned (snap dy=0)')
  console.log('ok: snap-during-drag aligns the translate onto a nearby edge, carrying the SnapResult in FSM state')
}

// ============================================================================
// 15. Snap-during-drag: no candidates within range -> snapResult is empty
//    (dx=0, dy=0, no guides) and the translate applies the raw delta only.
// ============================================================================
{
  const { editor, tool, doc } = setup()
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  // Drag shape:a far from every other fixture shape (down into negative
  // territory, away from shape:b/note/terminal/diamond).
  const down = { type: 'pointerdown' as const, x: 50, y: 50, buttons: 1, modifiers: NEUTRAL, t: 0 }
  const move1 = { type: 'pointermove' as const, x: 60, y: 60, buttons: 1, modifiers: NEUTRAL, t: 16 }
  const move2 = { type: 'pointermove' as const, x: -5000, y: -5000, buttons: 1, modifiers: NEUTRAL, t: 32 }

  let state = tool.initialState
  for (const event of [down, move1, move2]) {
    const r = tool.onEvent(state, event)
    state = r.state
    if (r.intents.length > 0) editor.applyAll(r.intents)
  }
  const snapResult = (state as any).snapResult
  assert.deepEqual(snapResult, { dx: 0, dy: 0, guides: [] }, 'no candidates within range -> an empty SnapResult')
  // move1 lands shape:a at (10,10) [raw, unsnapped]. move2's raw TOTAL delta
  // from the grab point (50,50) to (-5000,-5000) is (-5050,-5050) (world ==
  // screen at z=1); no snap adjustment on top, so the committed STEP is
  // total - applied = (-5050-10, -5050-10) = (-5060,-5060), landing shape:a
  // at startBounds' origin + total = (0-5050, 0-5050) = (-5050,-5050).
  const a = doc.getShape('shape:a')!
  assert.equal(a.x, -5050, 'no snap applied: final position is exactly the raw (unsnapped) drag target')
  assert.equal(a.y, -5050)
  console.log('ok: snap-during-drag finds no candidates far from every other shape -- empty SnapResult, unsnapped translate')
}

// ============================================================================
// 16. Arrow-key nudge (Task keyboard/K1): with a shape selected and the tool
//    idle, a bare ArrowRight keydown moves the selection by NUDGE_PX (1)
//    world unit; ArrowLeft/Up/Down move in the expected direction. One
//    keydown -> exactly one TranslateShapes intent (one undo step per
//    keypress, matching e2e/goldens/feel.json's nudgePx).
// ============================================================================
{
  const { editor, tool } = setup()
  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  const key = (k: string, mods = NEUTRAL) => ({ type: 'keydown' as const, key: k, modifiers: mods, t: 0 })

  const right = tool.onEvent(tool.initialState, key('ArrowRight'))
  assert.deepEqual(right.intents, [{ type: 'TranslateShapes', ids: ['shape:a'], dx: 1, dy: 0 }], 'ArrowRight nudges +1 world unit in x')

  const left = tool.onEvent(tool.initialState, key('ArrowLeft'))
  assert.deepEqual(left.intents, [{ type: 'TranslateShapes', ids: ['shape:a'], dx: -1, dy: 0 }], 'ArrowLeft nudges -1 world unit in x')

  const down = tool.onEvent(tool.initialState, key('ArrowDown'))
  assert.deepEqual(down.intents, [{ type: 'TranslateShapes', ids: ['shape:a'], dx: 0, dy: 1 }], 'ArrowDown nudges +1 world unit in y')

  const up = tool.onEvent(tool.initialState, key('ArrowUp'))
  assert.deepEqual(up.intents, [{ type: 'TranslateShapes', ids: ['shape:a'], dx: 0, dy: -1 }], 'ArrowUp nudges -1 world unit in y')

  console.log('ok: arrow-key nudge moves the selection by 1 world unit per direction')
}

// 16b. Arrow keys while a shape is being TEXT-EDITED must NOT nudge it: the
//    textarea owns arrow keys for caret movement (tldraw parity — arrows in
//    the rich-text editor never move the shape). Mutant killed: a select tool
//    that reads only `selection` and ignores `editingId` emits a
//    TranslateShapes here (the round-2 validator's real-browser repro: shape
//    drifted 200,120 -> 198,119 while arrowing back to fix a typo).
// ============================================================================
{
  const { editor, tool } = setup()
  editor.apply({ type: 'SetSelection', ids: ['shape:note'] })
  editor.apply({ type: 'BeginEdit', id: 'shape:note' })
  assert.equal(editor.get().editingId, 'shape:note', 'precondition: the note is being edited')
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  const left = tool.onEvent(tool.initialState, { type: 'keydown' as const, key: 'ArrowLeft', modifiers: NEUTRAL, t: 0 })
  assert.deepEqual(left.intents, [], 'ArrowLeft while text-editing emits NO TranslateShapes (caret movement only)')
  console.log('ok: arrow keys never nudge a shape that is being text-edited')
}

// ============================================================================
// 17. Shift+arrow nudges by SHIFT_NUDGE_PX (10), matching feel.json's
//    shiftNudgePx.
// ============================================================================
{
  const { editor, tool } = setup()
  editor.apply({ type: 'SetSelection', ids: ['shape:a'] })
  const SHIFT = { shift: true, alt: false, ctrl: false, meta: false }
  const key = (k: string) => ({ type: 'keydown' as const, key: k, modifiers: SHIFT, t: 0 })

  const right = tool.onEvent(tool.initialState, key('ArrowRight'))
  assert.deepEqual(right.intents, [{ type: 'TranslateShapes', ids: ['shape:a'], dx: 10, dy: 0 }], 'Shift+ArrowRight nudges +10 world units')

  console.log('ok: shift+arrow nudges by 10 world units')
}

// ============================================================================
// 18. Nudge no-ops: an empty selection emits no intent, and an unrelated key
//    (falling through onIdle's existing branches) emits no intent either.
// ============================================================================
{
  const { tool } = setup()
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  const key = (k: string) => ({ type: 'keydown' as const, key: k, modifiers: NEUTRAL, t: 0 })

  const noSelection = tool.onEvent(tool.initialState, key('ArrowRight'))
  assert.deepEqual(noSelection.intents, [], 'ArrowRight with an empty selection is a no-op')

  const unrelated = tool.onEvent(tool.initialState, key('q'))
  assert.deepEqual(unrelated.intents, [], 'an unrelated key is a no-op')

  console.log('ok: nudge no-ops on an empty selection or an unrelated key')
}

// ============================================================================
// 19. Shift-constrained drag (Task keyboard/K2): holding Shift while
//    dragging flattens the move to whichever axis has the larger raw
//    displacement from the grab point (tldraw's Translating.ts parity) --
//    the OTHER axis is held at zero for the whole gesture.
// ============================================================================
{
  const { editor, tool, doc } = setup()
  const SHIFT = { shift: true, alt: false, ctrl: false, meta: false }
  // shape:a spans world [0,100]x[0,100]; grab at its center (50,50). Move to
  // (54, 70): raw dx=4, dy=20 -- |dy|>|dx|, so shift must flatten dx to 0 and
  // keep the full dy.
  const events = script().down(50, 50).move(54, 70, { modifiers: SHIFT }).up().events()
  run(editor, tool, events)
  const a = doc.getShape('shape:a')!
  assert.equal(a.x, 0, 'shift-constrained drag holds the non-dominant (x) axis at zero')
  assert.equal(a.y, 20, 'shift-constrained drag applies the full delta on the dominant (y) axis')
  console.log('ok: shift held during a drag constrains movement to the dominant axis')
}

// ============================================================================
// 20. Shift-constrained drag must not leak snap onto the LOCKED axis
//    (validator repro, Task keyboard/K2 fix-round): a snap target that sits
//    a few px off the locked axis must never pull the drag off that axis --
//    flattenForShift zeroes the suppressed axis BEFORE computeSnappedDelta,
//    but snapCandidates finds each axis's best guide independently, so a
//    target close to the (already-zeroed) suppressed axis can re-add
//    movement there. shape:a spans [0,100]x[0,100]; shape:snap-c sits at
//    (400,3) -- 3 world units off shape:a's y=0, well inside the 5-unit
//    snap threshold (5% of the 100-unit medianSize). Dragging shape:a from
//    its center (50,50) to (350,53) with Shift held: raw dx=300, dy=3 --
//    |dx|>|dy| so Shift must flatten dy to 0 and hold it there for the
//    WHOLE gesture, snap target notwithstanding.
// ============================================================================
{
  // A MINIMAL two-shape doc (not `setup()`'s fixture, which seeds several
  // OTHER shapes sharing shape:a's exact y=[0,100] range -- those would tie
  // shape:snap-c's delta=3 with their own delta=0 and mask the leak this
  // case exists to catch). Just shape:a and shape:c, matching the
  // validator's exact repro numbers.
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape(geoShape('shape:a', 0, 0))
  doc.putShape(geoShape('shape:c', 400, 3))
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createSelectTool(ctx)
  const SHIFT = { shift: true, alt: false, ctrl: false, meta: false }
  const events = script().down(50, 50).move(350, 53, { modifiers: SHIFT }).up().events()
  run(editor, tool, events)
  const a = doc.getShape('shape:a')!
  assert.equal(a.x, 300, 'shift-constrained drag still applies the full delta on the dominant (x) axis')
  assert.equal(a.y, 0, 'a snap target close to the LOCKED axis must never reintroduce movement there')
  console.log('ok: shift-constrained drag holds the locked axis at zero even next to a snap target')
}

console.log('ok: select tool FSM (select/marquee/translate)')
