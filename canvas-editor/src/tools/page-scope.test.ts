// Run: bun src/tools/page-scope.test.ts
// Tools see only the CURRENT page. The room's doc holds every page's shapes
// in one spatial index; a shape on page:q sitting at the same world
// coordinates as empty space on page:p must never be hit, marquee-selected,
// captured by a new frame, or offered as a snap target while page:p is the
// current page (the owner's report: clicking empty space selected an
// invisible shape from another page).
import assert from 'node:assert/strict'
import { dumpModel, LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { buildSpatialIndex, hitTestTopmost, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createCreateTool } from './create.js'
import { createSelectTool } from './select.js'
import { createToolContext } from './tool-context.js'

const geo = (id: string, parentId: string, x: number, y: number): Shape => ({
  id, kind: 'geo', parentId, index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
} as Shape)

function setup(seed: Shape[]) {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P', index: 'a1' })
  doc.putPage({ id: 'page:q', name: 'Q', index: 'a2' })
  for (const s of seed) doc.putShape(s)
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  return { doc, editor, ctx }
}

// 1. ToolContext.hitTestTopmost: an off-page shape at the point is not hit.
{
  const { ctx } = setup([geo('shape:q', 'page:q', 0, 0)])
  assert.equal(ctx.hitTestTopmost({ x: 50, y: 50 }), null, 'a page:q shape is never hit while page:p is current')
  ctx.dispose()
  console.log('ok: hitTestTopmost ignores a shape on another page')
}

// 2. ToolContext.hitTestTopmost: an off-page shape stacked ABOVE an on-page
//    one must not shadow it — off-page shapes are dropped before the
//    topmost pick, not after.
{
  // Seeded q-first so the page:q shape comes LATER in doc.shapes (the
  // z-order hitTestTopmost picks by); the precondition pins that the
  // unfiltered room-wide pick really is the off-page shape.
  const { editor, ctx } = setup([geo('shape:q', 'page:q', 0, 0), geo('shape:p', 'page:p', 0, 0)])
  const model = dumpModel(editor.doc)
  assert.equal(hitTestTopmost(buildSpatialIndex(model), model, { x: 50, y: 50 }), 'shape:q', 'precondition: unfiltered, the page:q shape is topmost')
  assert.equal(ctx.hitTestTopmost({ x: 50, y: 50 }), 'shape:p', 'the on-page shape under an off-page one is still hit')
  ctx.dispose()
  console.log('ok: hitTestTopmost — an off-page shape above never shadows the on-page one')
}

// 3. ToolContext.queryMarquee (both modes) returns only on-page shapes.
{
  const { ctx } = setup([geo('shape:p', 'page:p', 0, 0), geo('shape:q', 'page:q', 200, 0)])
  const bounds = { minX: -10, minY: -10, maxX: 400, maxY: 200 }
  assert.deepEqual(ctx.queryMarquee(bounds, 'intersect'), ['shape:p'], 'intersect marquee returns only the on-page shape')
  assert.deepEqual(ctx.queryMarquee(bounds, 'contain'), ['shape:p'], 'contain marquee returns only the on-page shape')
  ctx.dispose()
  console.log('ok: queryMarquee returns only current-page shapes')
}

// 4. The page filter reads currentPageId LIVE: after switching to page:q the
//    page:q shape is hittable and the page:p one is not.
{
  const { editor, ctx } = setup([geo('shape:p', 'page:p', 0, 0), geo('shape:q', 'page:q', 0, 0)])
  assert.equal(ctx.hitTestTopmost({ x: 50, y: 50 }), 'shape:p')
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  assert.equal(ctx.hitTestTopmost({ x: 50, y: 50 }), 'shape:q', 'after SetCurrentPage(page:q), the page:q shape is the hit')
  ctx.dispose()
  console.log('ok: page filter follows currentPageId live')
}

// 5. Select tool: clicking empty page:p space over a page:q shape leaves the
//    selection empty.
{
  const { editor, ctx } = setup([geo('shape:q', 'page:q', 0, 0)])
  const tool = createSelectTool(ctx)
  run(editor, tool, script().down(50, 50).up().events())
  assert.deepEqual([...editor.get().selection], [], 'clicking over an off-page shape selects nothing')
  ctx.dispose()
  console.log('ok: select click over an off-page shape selects nothing')
}

// 6. Select tool marquee: a marquee over an on-page and an off-page shape
//    selects only the on-page one.
{
  const { editor, ctx } = setup([geo('shape:p', 'page:p', 0, 0), geo('shape:q', 'page:q', 200, 0)])
  const tool = createSelectTool(ctx)
  run(editor, tool, script().down(-20, -20).move(400, 200, { steps: 4 }).up().events())
  assert.deepEqual([...editor.get().selection], ['shape:p'], 'the marquee selects only the on-page shape')
  ctx.dispose()
  console.log('ok: select marquee ignores off-page shapes')
}

// 7. Create tool: a frame drawn on page:p never captures a page:q shape.
//    (Regression guard: create.ts's own root-level filter — parentId ===
//    the frame's page — already excluded off-page shapes before the
//    ToolContext became page-scoped, so this case was green pre-fix.)
{
  const { editor, ctx } = setup([geo('shape:q', 'page:q', 50, 50)])
  const tool = createCreateTool(ctx, 'frame')
  run(editor, tool, script().down(0, 0).move(400, 400, { steps: 4 }).up().events())
  assert.equal(editor.doc.getShape('shape:q')!.parentId, 'page:q', 'the page:q shape stays on page:q — not captured by the page:p frame')
  ctx.dispose()
  console.log('ok: frame capture ignores off-page shapes')
}

// 8. Snapping: dragging shape:a on page:p near a page:q shape's edge does
//    NOT snap to it. Same numbers as select.test.ts case 14: grab (50,50),
//    move to (60,60) then (147,50) → raw right edge 197, 3 short of the
//    page:q shape's left edge at 200. On-page that would snap to x=100; with
//    the target on another page there is no snap, so shape:a lands at x=97.
{
  const { editor, ctx } = setup([geo('shape:a', 'page:p', 0, 0), geo('shape:q', 'page:q', 200, 0)])
  const tool = createSelectTool(ctx)
  const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }
  const events = [
    { type: 'pointerdown' as const, x: 50, y: 50, buttons: 1, modifiers: NEUTRAL, t: 0 },
    { type: 'pointermove' as const, x: 60, y: 60, buttons: 1, modifiers: NEUTRAL, t: 16 },
    { type: 'pointermove' as const, x: 147, y: 50, buttons: 1, modifiers: NEUTRAL, t: 32 },
  ]
  let state = tool.initialState
  for (const event of events) {
    const r = tool.onEvent(state, event)
    state = r.state
    if (r.intents.length > 0) editor.applyAll(r.intents)
  }
  assert.equal(editor.doc.getShape('shape:a')!.x, 97, 'no snap onto the off-page shape: shape:a lands at the raw x=97, not the snapped x=100')
  ctx.dispose()
  console.log('ok: drag snapping ignores off-page shapes')
}

console.log('ok: tools are scoped to the current page')
