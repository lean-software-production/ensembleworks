// Run: bun src/tools/draw.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { indexBetween, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createDrawTool } from './draw.js'
import { createToolContext } from './tool-context.js'

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  return { doc, editor, ctx }
}

type DrawProps = {
  readonly segments: ReadonlyArray<{ readonly type: string; readonly points: ReadonlyArray<{ readonly x: number; readonly y: number; readonly z?: number }> }>
  readonly isPen?: boolean
  readonly w?: number
  readonly h?: number
}

// ============================================================================
// 1. A drag (down -> move -> move -> up) emits ONE draw-kind shape whose
//    segment accumulates every captured point (down + 2 moves + up = 4).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0).move(10, 10).up().events()
  run(editor, tool, events)

  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1, 'exactly one shape created')
  const created = shapes[0]!
  assert.equal(created.kind, 'draw', 'created shape has kind draw')
  assert.equal(created.parentId, 'page:p', 'created shape is parented to the editor\'s pageId')
  assert.ok(created.id.startsWith('shape:'), 'id comes from the branded shape id factory')
  const props = created.props as unknown as DrawProps
  assert.equal(props.segments.length, 1, 'one segment')
  assert.equal(props.segments[0]!.type, 'free', 'segment type is free')
  assert.equal(props.segments[0]!.points.length, 4, 'accumulates down + 2 moves + up = 4 points')
  console.log('ok: drag emits one draw shape accumulating every point')
}

// ============================================================================
// 2. Pressure is recorded from the injected event, not hardcoded.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0, { pressure: 0.9 }).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as DrawProps
  const pts = props.segments[0]!.points
  assert.equal(pts[1]!.z, 0.9, 'a move with injected pressure 0.9 records z=0.9 on that point')
  console.log('ok: pressure is recorded from the injected event')
}

{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as DrawProps
  const pts = props.segments[0]!.points
  assert.equal(pts[1]!.z, 0.5, 'a mouse move with no pressure records the neutral z=0.5')
  console.log('ok: no-pressure move records neutral z=0.5')
}

{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0, { pressure: 0.4 }).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as DrawProps
  assert.equal(props.isPen, true, 'a down event carrying pressure marks the stroke isPen=true')
  console.log('ok: isPen=true when the down event carries pressure')
}

{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as DrawProps
  assert.equal(props.isPen, false, 'a down event with no pressure marks the stroke isPen=false')
  console.log('ok: isPen=false when the down event carries no pressure')
}

// ============================================================================
// 3. Normalization/determinism: local points are bbox-relative (>= 0),
//    props.w/h match the point-cloud bbox, and replaying the same script
//    twice produces deep-equal shapes.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(10, 20).move(40, 20).move(40, 60).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  const props = created.props as unknown as DrawProps
  assert.equal(created.x, 10, 'shape.x is the point-cloud min corner x')
  assert.equal(created.y, 20, 'shape.y is the point-cloud min corner y')
  assert.equal(props.w, 30, 'props.w is the point bbox width')
  assert.equal(props.h, 40, 'props.h is the point bbox height')
  for (const pt of props.segments[0]!.points) {
    assert.ok(pt.x >= 0 && pt.y >= 0, `local point (${pt.x},${pt.y}) is bbox-relative (>= 0)`)
  }
  // EXACT local coordinates (not just >=0, which an all-positive-world-coord
  // gesture would satisfy even for un-normalized raw world points — a real
  // discriminator needs the precise expected values): world (10,20) ->
  // local (0,0); world (40,20) -> local (30,0); world (40,60) [move, then
  // the coincident pointerup landing] -> local (30,40) twice.
  const pts = props.segments[0]!.points
  assert.deepEqual([pts[0]!.x, pts[0]!.y], [0, 0], 'first point (world 10,20) normalizes to local (0,0)')
  assert.deepEqual([pts[1]!.x, pts[1]!.y], [30, 0], 'second point (world 40,20) normalizes to local (30,0)')
  assert.deepEqual([pts[2]!.x, pts[2]!.y], [30, 40], 'third point (world 40,60) normalizes to local (30,40)')
  assert.deepEqual([pts[3]!.x, pts[3]!.y], [30, 40], 'pointerup\'s appended final point (world 40,60) normalizes to local (30,40)')
  console.log('ok: points normalized to a local, bbox-relative frame; w/h match bbox')
}

{
  const { editor: e1, ctx: c1 } = setup()
  const { editor: e2, ctx: c2 } = setup()
  const events = script().down(10, 20).move(40, 20).move(40, 60).up().events()
  run(e1, createDrawTool(c1), events)
  run(e2, createDrawTool(c2), events)
  const s1 = e1.doc.listShapes()[0]!
  const s2 = e2.doc.listShapes()[0]!
  assert.deepEqual(s1, s2, 'replaying the identical script through a fresh editor produces a deep-equal shape')
  console.log('ok: replay determinism (fixed random + fixed gesture -> stable output)')
}

// ============================================================================
// 3b. IMMUTABLE point capture: a `drawing`-state value captured mid-gesture
//    (e.g. for rewind/branch replay) must NOT be corrupted by continuing the
//    FSM down a DIFFERENT branch from that same captured state. An in-place
//    `worldPoints.push` would silently mutate the shared array underneath
//    the earlier-captured reference; a correct FSM only ever produces NEW
//    arrays (`[...prev, next]`), so the captured state's own point count
//    stays frozen at whatever it was when captured, no matter what happens
//    to states derived from it afterward.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const down = { type: 'pointerdown' as const, x: 0, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 0 }
  const move1 = { type: 'pointermove' as const, x: 10, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 16 }
  const r1 = tool.onEvent(tool.initialState, down)
  const r2 = tool.onEvent(r1.state, move1)
  const captured = r2.state
  assert.equal(captured.mode, 'drawing', 'captured mid-gesture state is drawing')
  const capturedLength = captured.mode === 'drawing' ? captured.worldPoints.length : -1
  assert.equal(capturedLength, 2, 'captured state has 2 points (down + one move)')
  // Continue down a DIFFERENT branch from the SAME captured state.
  const move2 = { type: 'pointermove' as const, x: 20, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 32 }
  tool.onEvent(captured, move2)
  const stillCapturedLength = captured.mode === 'drawing' ? captured.worldPoints.length : -1
  assert.equal(stillCapturedLength, capturedLength, 'the earlier-captured state\'s worldPoints array is unmutated by continuing the FSM from it')
  console.log('ok: point capture is immutable — a captured mid-gesture state survives branching untouched')
}

// ============================================================================
// 4. z-order: reuses topIndex — a new stroke lands above every existing
//    sibling.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  const sibling: Shape = {
    id: 'shape:sibling', kind: 'geo', parentId: 'page:p', index: 'a5', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  } as Shape
  doc.putShape(sibling)
  doc.commit()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes().find((s) => s.kind === 'draw')!
  assert.ok(created.index > 'a5', `draw shape index (${created.index}) is above the pre-existing sibling's a5`)
  console.log('ok: z-order — new stroke lands above existing siblings (topIndex)')
}

// ============================================================================
// 4b. Index STABILITY: topIndex is computed ONCE at pointerdown and reused
//    for every subsequent pointermove/pointerup, never recomputed per event
//    (create.ts's Dragging-state note: recomputing mid-gesture against a doc
//    that already contains this same shape's own prior commit as a sibling
//    would mint a strictly-increasing index every move — non-deterministic
//    churn). Driven event-by-event (not via run()) so the shape's index can
//    be observed after each step.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  let state = tool.initialState
  const events = script().down(0, 0).move(10, 0).move(20, 0).up().events()
  const indicesSeen: string[] = []
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
    const shape = editor.doc.listShapes().find((s) => s.kind === 'draw')
    if (shape) indicesSeen.push(shape.index)
  }
  assert.ok(indicesSeen.length >= 3, 'index observed after at least 3 commits (down + 2 moves)')
  const distinct = new Set(indicesSeen)
  assert.equal(distinct.size, 1, `index stays IDENTICAL across the whole gesture, never recomputed per move (saw: ${indicesSeen.join(', ')})`)
  console.log('ok: index computed once at pointerdown, stable across every subsequent move/up')
}

// ============================================================================
// 5. Click = dot: a bare down->up with no move still creates a valid draw
//    shape (deliberate divergence from create/arrow's threshold gate — no
//    pointing state, pointerdown commits immediately). Per the FSM spec,
//    pointerdown records the first point AND pointerup always appends the
//    final point, so a no-move click yields TWO coincident points (both at
//    the click location) — a degenerate zero-length stroke that renders as
//    a round dot once G1's downstream streamline/dedup collapses them; this
//    tool layer does not itself dedupe (that is G1's job, not T1's).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(5, 5).up().events()
  run(editor, tool, events)
  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1, 'a bare click still creates exactly one shape')
  const created = shapes[0]!
  assert.equal(created.kind, 'draw', 'the click-created shape is a draw shape')
  const props = created.props as unknown as DrawProps
  const pts = props.segments[0]!.points
  assert.equal(pts.length, 2, 'a click with no drag captures the down point plus pointerup\'s appended final point')
  assert.deepEqual([pts[0]!.x, pts[0]!.y], [pts[1]!.x, pts[1]!.y], 'both captured points coincide at the click location (a degenerate dot stroke)')
  assert.equal(props.w, 0, 'a dot stroke has zero-size bbox width')
  assert.equal(props.h, 0, 'a dot stroke has zero-size bbox height')
  console.log('ok: click with no drag creates a degenerate (coincident-point) dot draw shape')
}

// ============================================================================
// 6. Selection: the finalized stroke becomes the selection (pointerup).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  const events = script().down(0, 0).move(10, 0).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes()[0]!
  assert.deepEqual([...editor.get().selection], [created.id], 'the finalized stroke becomes the selection')
  console.log('ok: finalized stroke becomes the selection')
}

// ============================================================================
// 7. E2 — current-page parenting. The tool is CONSTRUCTED FIRST (like a real
//    tool-selection instance that outlives a page switch), THEN
//    SetCurrentPage fires, THEN the gesture runs -- this is what actually
//    distinguishes a LIVE per-event read from a read captured ONCE at
//    factory-construction time (both would pass if the switch happened
//    before construction). Mutant killed: "reads editor.pageId (factory
//    const)" AND "reads currentPageId but only ONCE at factory scope" --
//    both would keep parenting to 'page:p' here.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createDrawTool(ctx) // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  run(editor, tool, script().down(0, 0).move(10, 0).up().events())
  const created = editor.doc.listShapes()[0]!
  assert.equal(created.parentId, 'page:q', 'stroke drawn after SetCurrentPage parents onto the CURRENT page, not editor.pageId')
  console.log('ok: E2 — draw parents onto the current page after SetCurrentPage')
}

// ============================================================================
// 7b. E2 — topIndex must scan the CURRENT page's siblings, not
//     editor.pageId's. Escaping-mutant catch: a mutant that fixes parentId
//     to read currentPageId live but leaves `topIndex(ctx, pageId)` reading
//     `editor.pageId` PASSES the parentId-only assertion above (both pages
//     are empty there, so the starting index ties either way) -- it only
//     shows up when the BOOTSTRAP page has a high-indexed sibling and the
//     CURRENT (new) page does not.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putShape({
    id: 'shape:page-p-high', kind: 'geo', parentId: 'page:p', index: indexBetween('a5', null), x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createDrawTool(ctx) // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  run(editor, tool, script().down(0, 0).move(10, 0).up().events())
  const created = editor.doc.listShapes().find((s) => s.kind === 'draw')!
  assert.equal(created.parentId, 'page:q', 'sanity: still parents onto page:q')
  assert.equal(created.index, indexBetween(null, null), "topIndex reads page:q's (empty) siblings, not page:p's unrelated high-indexed shape")
  console.log("ok: E2 — draw topIndex scans the CURRENT page's siblings, not editor.pageId's")
}

// ============================================================================
// 8. E2 — migration safety: with currentPageId at its boot default
//    ('page:p', never switched), draw creation is UNCHANGED.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createDrawTool(ctx)
  run(editor, tool, script().down(0, 0).move(10, 0).up().events())
  const created = editor.doc.listShapes()[0]!
  assert.equal(created.parentId, 'page:p', 'with currentPageId at its boot default, draw creation still parents to page:p')
  console.log('ok: E2 — single-page default (no SetCurrentPage) still parents a stroke to page:p')
}

// ============================================================================
// 9. E2 — a multi-move stroke threads the CURRENT page consistently across
//    every pointermove re-emission of the same shape (not just at
//    pointerdown).
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createDrawTool(ctx) // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  let state = tool.initialState
  const dispatch = (events: readonly import('../input.js').InputEvent[]) => {
    for (const event of events) {
      const result = tool.onEvent(state, event)
      state = result.state
      if (result.intents.length > 0) editor.applyAll(result.intents)
    }
  }
  dispatch([{ type: 'pointerdown', x: 0, y: 0, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 0 }])
  const afterDown = editor.doc.listShapes()[0]!
  assert.equal(afterDown.parentId, 'page:q', 'pointerdown commit parents onto the current page')

  dispatch([{ type: 'pointermove', x: 10, y: 10, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 16 }])
  const afterMove = editor.doc.listShapes().find((s) => s.id === afterDown.id)!
  assert.equal(afterMove.parentId, 'page:q', 'the re-emitted stroke keeps parentId on the current page across pointermoves')

  dispatch([{ type: 'pointerup', x: 20, y: 20, buttons: 0, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 32 }])
  const final = editor.doc.listShapes().find((s) => s.id === afterDown.id)!
  assert.equal(final.parentId, 'page:q', 'the final pointerup emission also lands on the current page')
  console.log('ok: E2 — draw threads the current page consistently across every pointermove + pointerup')
}
