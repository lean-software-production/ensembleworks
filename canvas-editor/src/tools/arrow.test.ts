// Run: bun src/tools/arrow.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { routeArrow, type Shape } from '@ensembleworks/canvas-model'
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

console.log('ok: arrow tool FSM + bindings')
