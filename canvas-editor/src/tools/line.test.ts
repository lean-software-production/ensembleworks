// Run: bun src/tools/line.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createLineTool } from './line.js'
import { createToolContext } from './tool-context.js'

const FIXED_RANDOM = () => 0.5

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  return { doc, editor, ctx }
}

type LinePoint = { readonly id?: string; readonly index?: string; readonly x: number; readonly y: number }
type LineProps = {
  readonly points?: Record<string, LinePoint>
  readonly spline?: string
  readonly w?: number
  readonly h?: number
}

// ============================================================================
// 1. A drag (down -> move(cross threshold) -> move -> up) emits ONE shape of
//    kind 'line' with exactly TWO handles in props.points, a KEYED MAP (not
//    an array) — start (the down point) and the current end (the final
//    move/up point; the intermediate move upserts the SAME id/shape rather
//    than creating a second one).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  const events = script().down(10, 20).move(90, 20).move(90, 120).up().events()
  run(editor, tool, events)

  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1, 'exactly one shape created (moves upsert the same id, not new shapes)')
  const created = shapes[0]!
  assert.equal(created.kind, 'line', 'created shape has kind line')
  assert.equal(created.parentId, 'page:p', 'created shape is parented to the editor\'s pageId')
  assert.ok(created.id.startsWith('shape:'), 'id comes from the branded shape id factory')

  const props = created.props as unknown as LineProps
  assert.equal(props.spline, 'line', 'MVP tool writes spline:\'line\' (straight), never cubic')
  assert.ok(props.points && typeof props.points === 'object' && !Array.isArray(props.points), 'props.points is a keyed MAP, not an array')
  const keys = Object.keys(props.points!)
  assert.equal(keys.length, 2, 'exactly two handles in the keyed map')
  for (const k of keys) {
    const handle: LinePoint = props.points![k]!
    assert.equal(typeof handle.x, 'number', `handle ${k}.x is a number`)
    assert.equal(typeof handle.y, 'number', `handle ${k}.y is a number`)
  }
  console.log('ok: drag emits one line shape with a two-handle keyed-map points')
}

// ============================================================================
// 2. Handle ordering: the two handles get ORDERED index values (A < B) with
//    A = the start (down) point and B = the end (current/up) point, so R1's
//    flattenLinePoints (sorts by index) always renders start->end.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  const events = script().down(0, 0).move(100, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as LineProps
  const entries = Object.values(props.points!)
  assert.equal(entries.length, 2, 'two handles')
  const sorted = [...entries].sort((a, b) => (a.index! < b.index! ? -1 : a.index! > b.index! ? 1 : 0))
  assert.ok(sorted[0]!.index! < sorted[1]!.index!, 'the two handles have distinct, ordered index values (A < B)')
  // The lower-indexed handle is the START (world (0,0) -> local (0,0)); the
  // higher-indexed handle is the END (world (100,0) -> local (100,0)).
  assert.deepEqual([sorted[0]!.x, sorted[0]!.y], [0, 0], 'the lower-index handle is the start point, normalized to local (0,0)')
  assert.deepEqual([sorted[1]!.x, sorted[1]!.y], [100, 0], 'the higher-index handle is the end point, normalized to local (100,0)')
  console.log('ok: handles carry ordered index values, start precedes end')
}

// ============================================================================
// 3. Auto-select (the plan's ground-truth correction, DIVERGES FROM ARROW):
//    the drawing shape's id appears in a SetSelection intent BOTH on the
//    pointing->drawing transition and at pointerup.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  let state = tool.initialState
  const down = { type: 'pointerdown' as const, x: 0, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 0 }
  const move = { type: 'pointermove' as const, x: 50, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 16 }
  const up = { type: 'pointerup' as const, x: 60, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 32 }

  let r = tool.onEvent(state, down)
  state = r.state
  assert.equal(r.intents.length, 0, 'pointerdown alone emits nothing (threshold gate)')

  r = tool.onEvent(state, move)
  state = r.state
  assert.equal(state.mode, 'drawing', 'threshold-crossing move transitions to drawing')
  const createdId = state.mode === 'drawing' ? state.id : ''
  const selOnStart = r.intents.find((i) => i.type === 'SetSelection')
  assert.ok(selOnStart, 'a SetSelection intent is emitted on the pointing->drawing transition')
  assert.deepEqual((selOnStart as { ids: readonly string[] }).ids, [createdId], 'SetSelection on transition selects exactly the new line')

  r = tool.onEvent(state, up)
  const selOnFinalize = r.intents.find((i) => i.type === 'SetSelection')
  assert.ok(selOnFinalize, 'a SetSelection intent is emitted at pointerup (finalize)')
  assert.deepEqual((selOnFinalize as { ids: readonly string[] }).ids, [createdId], 'SetSelection at finalize selects exactly the new line')
  console.log('ok: auto-select fires on both the drawing transition and finalize')
}

// Full-gesture corroboration via run(): the editor's live selection ends up
// exactly the created line (the same observable K's contract depends on via
// selectedShapeIds()).
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  const events = script().down(0, 0).move(50, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  assert.deepEqual([...editor.get().selection], [created.id], 'the finalized line becomes the editor\'s selection')
  console.log('ok: finalized line becomes the selection (full gesture via run())')
}

// ============================================================================
// 4. Threshold gate: a bare down->up (no move) creates NO shape and emits
//    ZERO doc-write intents (a sub-threshold click is not a line — pins the
//    arrow-style gate; kills a draw-style "commit on pointerdown" mutant).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  run(editor, tool, script().down(50, 50).up().events()) // bare click, empty canvas
  assert.equal(editor.doc.listShapes().length, 0, 'a bare click creates NO line shape')

  const { editor: editor2, ctx: ctx2 } = setup()
  const tool2 = createLineTool(ctx2)
  run(editor2, tool2, script().down(50, 50).move(52, 51).up().events()) // sub-threshold wiggle (< 4px)
  assert.equal(editor2.doc.listShapes().length, 0, 'a sub-threshold wiggle creates NO line shape either')
  console.log('ok: bare click / sub-threshold gesture commits nothing (no abandoned-draw orphan)')
}

// ============================================================================
// 5. Normalization/determinism: handles are stored >= 0 relative to the min
//    corner, props.w/h match the 2-point bbox, shape.x/y is the min corner,
//    and replaying the identical script twice produces deep-equal shapes.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  const events = script().down(50, 80).move(10, 20).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as LineProps
  assert.equal(created.x, 10, 'shape.x is the two-point bbox min corner x')
  assert.equal(created.y, 20, 'shape.y is the two-point bbox min corner y')
  assert.equal(props.w, 40, 'props.w is the two-point bbox width')
  assert.equal(props.h, 60, 'props.h is the two-point bbox height')
  for (const h of Object.values(props.points!)) {
    assert.ok(h.x >= 0 && h.y >= 0, `handle (${h.x},${h.y}) is bbox-relative (>= 0)`)
  }
  console.log('ok: handles normalized to a local, bbox-relative frame; w/h match the 2-point bbox; x/y = min corner')
}

{
  const { editor: e1, ctx: c1 } = setup()
  const { editor: e2, ctx: c2 } = setup()
  const events = script().down(10, 20).move(90, 20).move(90, 120).up().events()
  run(e1, createLineTool(c1), events)
  run(e2, createLineTool(c2), events)
  const s1 = e1.doc.listShapes()[0]!
  const s2 = e2.doc.listShapes()[0]!
  assert.deepEqual(s1, s2, 'replaying the identical script through a fresh editor produces a deep-equal shape')
  console.log('ok: replay determinism (fixed random + fixed gesture -> stable output)')
}

// ============================================================================
// 6. Exactly-two-handles across the WHOLE gesture: driven event-by-event, the
//    handle count never grows past 2 no matter how many pointermoves occur
//    (kills a "mint a fresh handle per move" mutant, distinct from the
//    single-handle mutant below).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  let state = tool.initialState
  const events = script().down(0, 0).move(10, 0).move(20, 0).move(30, 0).up().events()
  const counts: number[] = []
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
    const shape = editor.doc.listShapes().find((s) => s.kind === 'line')
    if (shape) counts.push(Object.keys((shape.props as unknown as LineProps).points!).length)
  }
  assert.ok(counts.length >= 3, 'handle count observed after at least 3 commits')
  assert.ok(counts.every((c) => c === 2), `handle count stays exactly 2 across every move (saw: ${counts.join(', ')})`)
  console.log('ok: exactly two handles maintained across the whole gesture, never growing or shrinking')
}

// ============================================================================
// 7. z-order: reuses topIndex — a new line lands above every existing
//    sibling, and the index is computed ONCE (stable across the gesture).
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  const sibling: Shape = {
    id: 'shape:sibling', kind: 'geo', parentId: 'page:p', index: 'a5', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  } as Shape
  doc.putShape(sibling)
  doc.commit()
  const tool = createLineTool(ctx)
  const events = script().down(0, 0).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes().find((s) => s.kind === 'line')!
  assert.ok(created.index > 'a5', `line shape index (${created.index}) is above the pre-existing sibling's a5`)
  console.log('ok: z-order — new line lands above existing siblings (topIndex)')
}

{
  const { editor, ctx } = setup()
  const tool = createLineTool(ctx)
  let state = tool.initialState
  const events = script().down(0, 0).move(10, 0).move(20, 0).up().events()
  const indicesSeen: string[] = []
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
    const shape = editor.doc.listShapes().find((s) => s.kind === 'line')
    if (shape) indicesSeen.push(shape.index)
  }
  assert.ok(indicesSeen.length >= 2, 'index observed after at least 2 commits')
  const distinct = new Set(indicesSeen)
  assert.equal(distinct.size, 1, `index stays IDENTICAL across the whole gesture, never recomputed per move (saw: ${indicesSeen.join(', ')})`)
  console.log('ok: index computed once at threshold-crossing, stable across every subsequent move/up')
}
