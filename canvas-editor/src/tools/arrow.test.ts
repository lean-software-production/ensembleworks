// Run: bun src/tools/arrow.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { indexBetween, routeArrow, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createArrowTool } from './arrow.js'
import { createToolContext } from './tool-context.js'

const FIXED_RANDOM = () => 0.5

const geoShape = (id: string, x: number, y: number, w = 100, h = 100): Shape => ({
  id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w, h },
} as Shape)

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createArrowTool(ctx)
  return { doc, editor, ctx, tool }
}

// ============================================================================
// 1. Unbound draw: pointerdown/move/up over empty canvas -- an arrow shape
//    is created at the down point, with props.end as the LOCAL offset to
//    the up point, and no bindings at all.
// ============================================================================
{
  const { editor, tool } = setup()
  const events = script().down(500, 500).move(600, 520).up().events()
  run(editor, tool, events)

  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1, 'exactly one arrow shape was created')
  const arrow = shapes[0]!
  assert.equal(arrow.kind, 'arrow')
  assert.equal(arrow.x, 500)
  assert.equal(arrow.y, 500)
  assert.deepEqual((arrow.props as any).end, { x: 100, y: 20 }, 'end is the LOCAL offset from the down point')
  assert.equal(editor.doc.listBindings().length, 0, 'no target under the cursor -- no bindings written')
  // Task C1 (D-5): first shape (of any kind) on an empty page gets
  // indexBetween(null, null), a valid starting key -- no crash on empty.
  assert.equal(arrow.index, indexBetween(null, null), 'first arrow on an empty page gets indexBetween(null, null)')
  console.log('ok: unbound draw creates an arrow with the right local end offset and no bindings')
}

// ============================================================================
// 2. Bound both ends: draw from inside target A's exact center to inside
//    target B's exact center -- both endpoint bindings are written with the
//    binding:<arrowId>-start/-end id convention, correct toId, and the
//    EXACT anchor (0.5, 0.5) resolveArrowAnchor computes for a center hit.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:a', 0, 0, 100, 100)) // center (50,50)
  doc.putShape(geoShape('shape:b', 300, 0, 100, 100)) // center (350,50)
  doc.commit()

  const events = script().down(50, 50).move(200, 50).move(350, 50).up().events()
  run(editor, tool, events)

  const arrows = editor.doc.listShapes().filter((s) => s.kind === 'arrow')
  assert.equal(arrows.length, 1)
  const arrowId = arrows[0]!.id

  const bindings = editor.doc.listBindings()
  const startB = bindings.find((b) => b.id === `binding:${arrowId}-start`)
  const endB = bindings.find((b) => b.id === `binding:${arrowId}-end`)
  assert.ok(startB, 'start binding written with the documented id convention')
  assert.equal(startB!.toId, 'shape:a')
  assert.deepEqual((startB!.props as any).anchor, { nx: 0.5, ny: 0.5 }, 'start anchor is A\'s exact center')
  assert.ok(endB, 'end binding written with the documented id convention')
  assert.equal(endB!.toId, 'shape:b')
  assert.deepEqual((endB!.props as any).anchor, { nx: 0.5, ny: 0.5 }, 'end anchor is B\'s exact center')
  console.log('ok: bound-both-ends draw writes both endpoint bindings with correct anchors')
}

// ============================================================================
// 3. Arrow follows when the bound target moves AFTERWARD: complete a bound
//    arrow, then translate the bound target via a separate, unrelated
//    editor.apply -- routeArrow (canvas-model) against a FRESH snapshot must
//    reflect the target's new position. This is the integration point
//    proving the tool's bindings and canvas-model's routing agree.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:a', 0, 0, 100, 100)) // center (50,50)
  doc.commit()

  const events = script().down(50, 50).move(600, 50).up().events() // unbound end far to the right, clear of A's post-move position
  run(editor, tool, events)
  const arrowShapeBefore = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  const bindings = editor.doc.listBindings()

  const modelBefore = dumpModel(doc)
  const pathBefore = routeArrow(modelBefore, modelBefore.byId.get(arrowShapeBefore.id)!, bindings)
  assert.deepEqual(pathBefore.start, { x: 100, y: 50 }, 'clipped to A\'s right edge at its original position')

  editor.apply({ type: 'TranslateShapes', ids: ['shape:a'], dx: 200, dy: 0 }) // A moves to [200,300]x[0,100]
  const modelAfter = dumpModel(doc)
  const pathAfter = routeArrow(modelAfter, modelAfter.byId.get(arrowShapeBefore.id)!, editor.doc.listBindings())
  assert.deepEqual(pathAfter.start, { x: 300, y: 50 }, 'clip point tracks A\'s NEW position -- the arrow follows')
  console.log('ok: arrow follows its bound target after the target moves')
}

// ============================================================================
// 4. Vanished-target fallback: bind the end to a target, then delete that
//    target -- routeArrow must fall back to the arrow's own stored point,
//    not throw and not snap to the origin.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:b', 300, 0, 100, 100)) // center (350,50)
  doc.commit()

  const events = script().down(500, 500).move(350, 50).up().events()
  run(editor, tool, events)
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  const bindingsBefore = editor.doc.listBindings()
  assert.ok(bindingsBefore.find((b) => b.toId === 'shape:b'), 'end bound to shape:b before the delete')

  editor.apply({ type: 'DeleteShapes', ids: ['shape:b'] })

  const model = dumpModel(doc)
  const arrowNode = model.byId.get(arrow.id)!
  let path: ReturnType<typeof routeArrow> | undefined
  assert.doesNotThrow(() => { path = routeArrow(model, arrowNode, editor.doc.listBindings()) })
  assert.deepEqual(path!.end, { x: arrowNode.x + (arrowNode.props as any).end.x, y: arrowNode.y + (arrowNode.props as any).end.y }, 'falls back to the arrow\'s own stored end point')
  console.log('ok: vanished bound target falls back cleanly, no throw')
}

// ============================================================================
// 5. Mid-draw remote delete of the START target: the tool must not throw
//    when continuing a gesture whose bound start shape vanished under it --
//    the TOLERANCE CONTRACT applies to a multi-event gesture same as
//    select.ts's drag-translate.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:a', 0, 0, 100, 100)) // center (50,50)
  doc.commit()

  const downMove = script().down(50, 50).move(60, 60)
  let state = tool.initialState
  for (const event of downMove.events()) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
  }
  assert.ok(editor.doc.listBindings().find((b) => b.toId === 'shape:a'), 'start bound to shape:a before the remote delete')

  editor.apply({ type: 'DeleteShapes', ids: ['shape:a'] }) // remote peer deletes the start target mid-gesture
  assert.equal(editor.doc.getShape('shape:a'), undefined)

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
  }, 'mid-draw remote delete of the start target must not throw')
  console.log('ok: mid-draw remote delete of the start target is tolerated')
}

// ============================================================================
// 6. Self-binding: start and end both land on the SAME target shape -- the
//    tool allows it (OURS, matching tldraw parity), writing two independent
//    bindings that both name the same toId.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  // A generously large target (300x300): an 'arrow' kind has no props.w/h of
  // its own, so geometry.ts's size() falls back to its 100x100 unknown-kind
  // default for the arrow's OWN (rough, line-shapes-have-no-real-hitbox)
  // bounding box -- a small target would let the in-progress arrow's own
  // default bbox swallow the end-point hit test before it ever reaches the
  // target underneath (create.ts's frame-capture SELF-EXCLUSION note names
  // the same hazard). Sizing the target well past the arrow's 100x100
  // default keeps the end point's hit test resolving to shape:a, not the
  // arrow-in-progress.
  doc.putShape(geoShape('shape:a', 0, 0, 300, 300))
  doc.commit()

  const events = script().down(10, 10).move(250, 250).up().events() // both points inside shape:a
  run(editor, tool, events)

  const arrowId = editor.doc.listShapes().find((s) => s.kind === 'arrow')!.id
  const bindings = editor.doc.listBindings()
  const startB = bindings.find((b) => b.id === `binding:${arrowId}-start`)
  const endB = bindings.find((b) => b.id === `binding:${arrowId}-end`)
  assert.ok(startB && endB, 'both endpoint bindings were written')
  assert.equal(startB!.toId, 'shape:a')
  assert.equal(endB!.toId, 'shape:a', 'end binds to the SAME target as start -- self-binding is allowed')
  console.log('ok: self-binding (same target both ends) is allowed')
}

// ============================================================================
// 7. Threshold gate -- no abandoned-draw orphan: a bare click (down+up, no
//    movement) and a sub-threshold wiggle both leave ZERO shapes and ZERO
//    bindings in the doc. The exposure this pins (red-first): an ungated
//    StartArrow on pointerdown commits immediately, so a click with no
//    completing gesture would permanently orphan a zero-length arrow
//    visible to all peers -- create.ts by contrast commits nothing until
//    threshold-crossing/click-complete, and this tool must match.
// ============================================================================
{
  const { editor, tool } = setup()
  run(editor, tool, script().down(50, 50).up().events()) // bare click, empty canvas
  assert.equal(editor.doc.listShapes().length, 0, 'a bare click creates NO arrow shape')
  assert.equal(editor.doc.listBindings().length, 0, 'and no binding')

  run(editor, tool, script().down(50, 50).move(52, 51).up().events()) // sub-threshold wiggle (< 4px)
  assert.equal(editor.doc.listShapes().length, 0, 'a sub-threshold wiggle creates NO arrow shape either')
  console.log('ok: bare click / sub-threshold gesture commits nothing (no abandoned-draw orphan)')
}

// ============================================================================
// 8. No bindings mid-draw: start unbound on empty canvas, drag the preview
//    OVER shape:b and then OVER shape:a before releasing on shape:a --
//    listBindings() must be EMPTY at every intermediate move (a speculative
//    mid-draw binding could never be retracted when the pointer drags off
//    the shape again -- see arrow.ts's module header), and pointerup writes
//    EXACTLY ONE binding, to the shape under the final release point.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:b', 200, 0, 100, 100)) // spans x [200,300]
  doc.putShape(geoShape('shape:a', 600, 0, 100, 100)) // spans x [600,700]
  doc.commit()

  let state = tool.initialState
  const dispatch = (events: readonly import('../input.js').InputEvent[]) => {
    for (const event of events) {
      const result = tool.onEvent(state, event)
      state = result.state
      if (result.intents.length > 0) editor.applyAll(result.intents)
    }
  }

  dispatch(script().down(400, 300).events()) // empty canvas -- unbound start
  assert.equal(editor.doc.listBindings().length, 0, 'no binding at pointerdown')

  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  dispatch([{ type: 'pointermove', x: 250, y: 50, buttons: 1, modifiers: NEUTRAL, t: 100 }]) // over shape:b
  assert.equal(editor.doc.listBindings().length, 0, 'no binding while the preview hovers shape:b mid-draw')

  dispatch([{ type: 'pointermove', x: 650, y: 50, buttons: 1, modifiers: NEUTRAL, t: 116 }]) // over shape:a
  assert.equal(editor.doc.listBindings().length, 0, 'no binding while the preview hovers shape:a mid-draw')

  dispatch([{ type: 'pointerup', x: 650, y: 50, buttons: 0, modifiers: NEUTRAL, t: 132 }]) // release on shape:a
  const bindings = editor.doc.listBindings()
  assert.equal(bindings.length, 1, 'exactly ONE binding after pointerup')
  assert.equal(bindings[0]!.toId, 'shape:a', 'bound to the shape under the RELEASE point, not any hovered-over shape')
  assert.ok(bindings[0]!.id.endsWith('-end'), 'and it is the END binding')
  console.log('ok: no bindings are written mid-draw; exactly one end-binding at pointerup')
}

// ============================================================================
// 9. Task C1 (D-5) — top-of-stack index at creation, arrow analogue.
// ============================================================================

// 9a. A sibling exists (index 'a1') -- the new arrow's index sorts strictly
//     above it (exact value: indexBetween('a1', null)). Mutant killed:
//     "still hardcodes 'a1'" (would equal 'a1', not sort after it) and
//     "indexBetween(null, max)" (below, not above -- would sort BEFORE 'a1').
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:existing', 0, 0, 10, 10))
  doc.commit()

  const events = script().down(500, 500).move(600, 520).up().events()
  run(editor, tool, events)
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  assert.ok('a1' < arrow.index, `new arrow's index (${arrow.index}) must sort after the existing 'a1' sibling`)
  assert.equal(arrow.index, indexBetween('a1', null), 'arrow index is exactly indexBetween(maxSibling, null)')
  console.log("ok: a new arrow's index sorts strictly after an existing sibling's")
}

// 9b. "Reads wrong parent's siblings" mutant: a page:p sibling at 'a1' and a
//     shape parented under a DIFFERENT frame at a lexically higher index
//     'z' -- the arrow (parented at page:p) must compute its index from
//     ONLY the page:p sibling, not the frame child's unrelated index.
{
  const { doc, editor, tool } = setup()
  // A genuinely valid key (via indexBetween -- A1's key format encodes
  // length in the header char, so a hand-picked single letter like 'z' is
  // NOT a valid key on its own) that lexically sorts ABOVE
  // indexBetween('a1', null), the value the CORRECT implementation must
  // produce for the page:p arrow below.
  const HIGH_WRONG_PARENT_KEY = indexBetween(indexBetween('a1', null), null)
  doc.putShape({
    id: 'shape:frame1', kind: 'frame', parentId: 'page:p', index: 'a1', x: 1000, y: 1000, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putShape({
    id: 'shape:frame-child', kind: 'geo', parentId: 'shape:frame1', index: HIGH_WRONG_PARENT_KEY, x: 1001, y: 1001, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 5, h: 5 },
  } as Shape)
  doc.putShape(geoShape('shape:page-sibling', 0, 0, 10, 10)) // parentId: page:p, index 'a1'
  doc.commit()

  const events = script().down(500, 500).move(600, 520).up().events()
  run(editor, tool, events)
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  assert.equal(arrow.index, indexBetween('a1', null), "arrow's top-of-stack index reads only page:p's siblings, ignoring the frame child's unrelated, higher index")
  console.log("ok: arrow topIndex reads only the target parent's siblings, not a shape parented elsewhere")
}

// 9c. "Lands on top": two arrows drawn in sequence -- the second's index
//     sorts strictly after the first's.
{
  const { editor, tool } = setup()
  run(editor, tool, script().down(0, 0).move(50, 50).up().events())
  const first = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  run(editor, tool, script().down(200, 200).move(250, 250).up().events())
  const arrows = editor.doc.listShapes().filter((s) => s.kind === 'arrow')
  assert.equal(arrows.length, 2, 'two arrows now exist')
  const second = arrows.find((s) => s.id !== first.id)!
  assert.ok(first.index < second.index, `second-drawn arrow's index (${second.index}) must sort after the first's (${first.index}) -- lands on top`)
  console.log('ok: the second of two sequentially-drawn arrows sorts strictly after the first (lands on top)')
}

// ============================================================================
// 10. E2 — current-page parenting. StartArrow AFTER SetCurrentPage lands on
//     the NEW current page, not the bootstrap editor.pageId. Mutant killed:
//     "reads editor.pageId (factory const)" -- that mutant would keep
//     parenting to 'page:p' regardless of the switch.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })

  run(editor, tool, script().down(500, 500).move(600, 520).up().events())
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  assert.equal(arrow.parentId, 'page:q', 'arrow drawn after SetCurrentPage parents onto the CURRENT page, not editor.pageId')
  console.log('ok: E2 — arrow parents onto the current page after SetCurrentPage')
}

// ============================================================================
// 10b. E2 — topIndex must scan the CURRENT page's siblings, not
//      editor.pageId's. Escaping-mutant catch: a mutant that fixes parentId
//      to read currentPageId live but leaves `topIndex(ctx, pageId)` reading
//      `editor.pageId` PASSES the parentId-only assertion above (both pages
//      are empty there, so the starting index ties either way) -- it only
//      shows up when the BOOTSTRAP page has a high-indexed sibling and the
//      CURRENT (new) page does not.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape({
    id: 'shape:page-p-high', kind: 'geo', parentId: 'page:p', index: indexBetween('a5', null), x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })

  run(editor, tool, script().down(500, 500).move(600, 520).up().events())
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  assert.equal(arrow.parentId, 'page:q', 'sanity: still parents onto page:q')
  assert.equal(arrow.index, indexBetween(null, null), "topIndex reads page:q's (empty) siblings, not page:p's unrelated high-indexed shape")
  console.log("ok: E2 — arrow topIndex scans the CURRENT page's siblings, not editor.pageId's")
}

// ============================================================================
// 11. E2 — migration safety: with currentPageId at its boot default
//     ('page:p', never switched), arrow creation is UNCHANGED.
// ============================================================================
{
  const { editor, tool } = setup()
  run(editor, tool, script().down(500, 500).move(600, 520).up().events())
  const arrow = editor.doc.listShapes().find((s) => s.kind === 'arrow')!
  assert.equal(arrow.parentId, 'page:p', 'with currentPageId at its boot default, arrow creation still parents to page:p')
  console.log('ok: E2 — single-page default (no SetCurrentPage) still parents an arrow to page:p')
}

console.log('ok: arrow tool FSM + bindings')
