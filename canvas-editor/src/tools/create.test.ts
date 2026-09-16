// Run: bun src/tools/create.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { indexBetween, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createCreateTool, type CreateKind } from './create.js'
import { createToolContext } from './tool-context.js'

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  return { doc, editor, ctx }
}

// Default local sizes, pinned to canvas-model/geometry.ts's DEFAULTS map and
// its note special-case — the same numbers hit-test.test.ts's "kind-default
// sizes" case (case 5) already asserts directly against localBounds, so
// these are an established fact, not invented here.
const DEFAULT_SIZE: Record<CreateKind, { w: number; h: number }> = {
  note: { w: 200, h: 200 },
  text: { w: 200, h: 40 },
  geo: { w: 220, h: 120 },
  frame: { w: 800, h: 600 },
  bbthread: { w: 960, h: 600 },
}

// ============================================================================
// 1. Click-create each kind: envelope correctness (kind, parentId=pageId, id
//    from the factory), default size, CENTERED placement, and the created
//    shape becomes the selection.
// ============================================================================
for (const kind of ['note', 'text', 'geo', 'frame', 'bbthread'] as const) {
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, kind)
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1, `${kind}: click-create produces exactly one shape`)
  const created = shapes[0]!
  assert.equal(created.kind, kind)
  assert.equal(created.parentId, 'page:p', `${kind}: parentId defaults to the editor's pageId`)
  assert.ok(created.id.startsWith('shape:'), `${kind}: id comes from the branded shape id factory`)

  const { w, h } = DEFAULT_SIZE[kind]
  assert.equal(created.x, 300 - w / 2, `${kind}: CENTERED on the click point (x)`)
  assert.equal(created.y, 300 - h / 2, `${kind}: CENTERED on the click point (y)`)
  if (kind === 'note') {
    assert.deepEqual(created.props, {}, 'note never stores w/h — geometry hardcodes its 200x200 size regardless')
  } else {
    assert.equal((created.props as { w: number }).w, w, `${kind}: explicit props.w matches the geometry default`)
    assert.equal((created.props as { h: number }).h, h, `${kind}: explicit props.h matches the geometry default`)
  }

  assert.deepEqual([...editor.get().selection], [created.id], `${kind}: the created shape becomes the selection`)
  console.log(`ok: click-create ${kind} (envelope, centered default size, selection)`)
}

// ============================================================================
// 2. Drag-create size math at z=1: a geo dragged from world (0,0) to world
//    (100,50) lands at TOP-LEFT (0,0) with size 100x50 (not centered).
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  const events = script().down(0, 0).move(100, 50).up().events()
  run(editor, tool, events)
  const shapes = editor.doc.listShapes()
  assert.equal(shapes.length, 1)
  const s = shapes[0]!
  assert.equal(s.x, 0, 'drag-create top-left x is the drag origin, not centered')
  assert.equal(s.y, 0)
  assert.equal((s.props as { w: number }).w, 100, 'drag-create width is the world-space drag extent')
  assert.equal((s.props as { h: number }).h, 50)
  console.log('ok: drag-create size math at z=1')
}

// ============================================================================
// 3. Drag-create size math at z != 1: the SAME world-space drag rect (0,0)
//    to (100,50), but driven via a camera at z=2 -- screen deltas must be
//    divided by z to land on the identical world-space rect.
// ============================================================================
{
  const { editor, ctx } = setup()
  editor.apply({ type: 'SetCamera', x: 0, y: 0, z: 2 })
  const tool = createCreateTool(ctx, 'geo')
  // world (0,0) -> screen (0,0); world (100,50) -> screen (200,100) at z=2.
  const events = script().down(0, 0).move(200, 100).up().events()
  run(editor, tool, events)
  const s = editor.doc.listShapes()[0]!
  assert.equal(s.x, 0, 'z=2 drag-create still lands at world x=0 once screen deltas are divided by z')
  assert.equal(s.y, 0)
  assert.equal((s.props as { w: number }).w, 100, 'z=2 drag-create width is the same world-space 100, not the raw 200 screen px')
  assert.equal((s.props as { h: number }).h, 50)
  console.log('ok: drag-create size math is zoom-compensated at z=2')
}

// ============================================================================
// 4. Frame capture: dragging a frame over (0,0)-(60,60) must reparent a
//    root-level shape fully inside it, must NOT steal a shape that's
//    geometrically coincident but parented under a DIFFERENT existing
//    frame, and must NOT capture a root-level shape that only overlaps
//    (not fully contained).
// ============================================================================
{
  const { doc, editor, ctx } = setup()

  // shape:root: root-level, world bounds (10,10)-(30,30) -- fully inside the
  // frame we're about to drag-create.
  doc.putShape({
    id: 'shape:root', kind: 'geo', parentId: 'page:p', index: 'a1', x: 10, y: 10, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 20, h: 20 },
  } as Shape)

  // shape:other-frame: an UNRELATED existing frame, positioned far away so
  // it never itself becomes a capture candidate.
  doc.putShape({
    id: 'shape:other-frame', kind: 'frame', parentId: 'page:p', index: 'a1', x: -190, y: -190, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  // shape:child-of-other: a CHILD of shape:other-frame whose WORLD position
  // (parent xy + local xy = (-190+200, -190+200) = (10,10)) deliberately
  // coincides with shape:root's exact world bounds -- geometrically
  // contained by the new frame too, but must NOT be captured: it already
  // has a (different) parent.
  doc.putShape({
    id: 'shape:child-of-other', kind: 'geo', parentId: 'shape:other-frame', index: 'a1', x: 200, y: 200, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 20, h: 20 },
  } as Shape)

  // shape:overlap: root-level, world bounds (50,50)-(150,150) -- only its
  // (50,50)-(60,60) corner overlaps the new frame's (0,0)-(60,60) bounds;
  // NOT fully contained.
  doc.putShape({
    id: 'shape:overlap', kind: 'geo', parentId: 'page:p', index: 'a1', x: 50, y: 50, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
  } as Shape)
  doc.commit()

  // Build a second ToolContext for the tool under test and DISPOSE the
  // setup() one first (ToolContext.dispose's contract: an undisposed
  // context keeps its doc listener registered forever — this test was the
  // in-repo reproducer of exactly that leak). Note the second context is no
  // longer strictly NEEDED for freshness — the lazy rebuild means the
  // setup() context would see the fixture commits on its next query anyway
  // — but two-contexts-one-editor is a real Seam-D shape (remount), so keep
  // the pattern and dispose correctly.
  ctx.dispose()
  const freshCtx = createToolContext(editor)
  const tool = createCreateTool(freshCtx, 'frame')
  const events = script().down(0, 0).move(60, 60).up().events()
  run(editor, tool, events)

  const frame = editor.doc.listShapes().find((s) => s.kind === 'frame' && s.id !== 'shape:other-frame')!
  assert.ok(frame, 'the drag-created frame exists')
  assert.equal(editor.doc.getShape('shape:root')!.parentId, frame.id, 'a fully-contained ROOT-LEVEL shape is captured into the new frame')
  assert.equal(editor.doc.getShape('shape:child-of-other')!.parentId, 'shape:other-frame', 'a shape already parented elsewhere is NEVER stolen, even if geometrically contained')
  assert.equal(editor.doc.getShape('shape:overlap')!.parentId, 'page:p', 'a root-level shape that only OVERLAPS (not fully contained) is not captured')
  // Self-exclusion: the drag-created frame is in the snapshot at pointerup
  // (its per-move upserts committed), but must never be captured by itself.
  assert.equal(frame.parentId, 'page:p', 'the new frame never reparents (or self-parents) via its own capture query')

  freshCtx.dispose()
  console.log('ok: frame capture reparents only fully-contained root-level shapes')
}

// ============================================================================
// 4b. bb-thread-frame task — the SAME creation-time capture applies to
//    'bbthread' (canvas-model's isFrameLike), not just 'frame': a
//    fully-contained root-level shape is reparented into a newly-created
//    bbthread exactly like a frame.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putShape({
    id: 'shape:bbroot', kind: 'geo', parentId: 'page:p', index: 'a1', x: 10, y: 10, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 20, h: 20 },
  } as Shape)
  doc.commit()
  ctx.dispose()
  const freshCtx = createToolContext(editor)
  const tool = createCreateTool(freshCtx, 'bbthread')
  const events = script().down(0, 0).move(60, 60).up().events()
  run(editor, tool, events)

  const bbthread = editor.doc.listShapes().find((s) => s.kind === 'bbthread')!
  assert.ok(bbthread, 'the drag-created bbthread exists')
  assert.equal(editor.doc.getShape('shape:bbroot')!.parentId, bbthread.id, 'a fully-contained root-level shape is captured into the new bbthread, same as a frame')

  freshCtx.dispose()
  console.log('ok: bbthread capture reparents a fully-contained root-level shape (isFrameLike)')
}

// ============================================================================
// 5. Task AS2 — armed `nextShapeStyle` (Task AS1's `SetNextStyle`) is read
//    LIVE by the create tool and stamped onto the newly-created shape's
//    props (and envelope opacity, when armed). Must never clobber the
//    tool's own geometry (w/h) or envelope fields (id/parentId/index).
// ============================================================================
{
  // Click-create path. Arm AFTER the tool is constructed, immediately before
  // the gesture -- proves a LIVE read of editor.get().nextShapeStyle (like
  // worldOf's live camera read), not a value captured at tool-construction
  // time (mutant: "read a stale/captured style instead of live editor.get()").
  const { doc, editor, ctx } = setup()
  // Task C1 (D-5): seed ONE existing root sibling at index 'a1' so the
  // index assertion below exercises the real "sorts after the max sibling"
  // behavior, not just the degenerate empty-page case.
  doc.putShape({
    id: 'shape:existing', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.commit()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({ type: 'SetNextStyle', props: { color: 'blue', size: 'l' } })
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo' && s.id !== 'shape:existing')!
  assert.equal(created.props.color, 'blue', 'armed color lands on the created shape')
  assert.equal(created.props.size, 'l', 'armed size lands on the created shape')
  // Geometry survives the armed-style merge (mutant: "armed props overwrite
  // the whole props map").
  const { w, h } = DEFAULT_SIZE.geo
  assert.equal((created.props as { w: number }).w, w, 'armed style never clobbers the tool-computed w')
  assert.equal((created.props as { h: number }).h, h, 'armed style never clobbers the tool-computed h')
  // Envelope fields untouched by the armed style patch.
  assert.equal(created.parentId, 'page:p', 'armed style never touches parentId')
  // Task C1 (D-5): the armed style must never influence the index (it isn't
  // a style axis at all -- see whitelistStyleProps), and the tool-computed
  // index must sort strictly ABOVE the seeded 'a1' sibling (top-of-stack).
  assert.ok('a1' < created.index, `armed style never touches index; created index (${created.index}) must sort after the existing 'a1' sibling`)
  assert.equal(created.index, indexBetween('a1', null), 'created index is exactly indexBetween(maxSibling, null)')
  assert.equal(created.rotation, 0, 'armed style never touches rotation')
  assert.equal(created.isLocked, false, 'armed style never touches isLocked')
  assert.equal(created.opacity, 1, 'no opacity armed -> default envelope opacity of 1')
  console.log('ok: armed nextShapeStyle stamps color/size onto a click-created geo; geometry+envelope untouched')
}

{
  // `opacity` is special: StylePanel arms it under the SAME flat
  // `nextShapeStyle` record (Task AS1's SetNextStyle has no separate
  // opacity field), but it is an ENVELOPE field on Shape, never a props key
  // (style-axes.ts's `currentValue` reads shape.opacity directly and
  // explicitly treats a props.opacity key as a decoy to ignore). The merge
  // must split it out onto shape.opacity, not leave it sitting in props.
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({ type: 'SetNextStyle', props: { opacity: 0.5 } })
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo')!
  assert.equal(created.opacity, 0.5, 'armed opacity lands on the envelope opacity field')
  assert.equal((created.props as Record<string, unknown>).opacity, undefined, 'opacity must never leak into props -- it is envelope-only')
  console.log('ok: armed opacity maps to the envelope opacity field, never props.opacity')
}

{
  // Drag-create path reads the same live nextShapeStyle as click-create.
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({ type: 'SetNextStyle', props: { color: 'green' } })
  const events = script().down(0, 0).move(100, 50).up().events()
  run(editor, tool, events)

  const s = editor.doc.listShapes()[0]!
  assert.equal(s.props.color, 'green', 'drag-create also reads armed nextShapeStyle')
  assert.equal((s.props as { w: number }).w, 100, 'drag-create geometry still wins over any armed props for the same key')
  console.log('ok: drag-create also stamps armed nextShapeStyle onto the created shape')
}

{
  // A stray geometry-shaped key smuggled into nextShapeStyle (should never
  // happen from the real panel, but the merge order must be defensive) can
  // never override the tool-computed w/h (mutant: "geometry overwrites
  // armed props in the wrong order").
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({ type: 'SetNextStyle', props: { w: 999, h: 999, color: 'red' } })
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo')!
  const { w, h } = DEFAULT_SIZE.geo
  assert.equal((created.props as { w: number }).w, w, 'a stray w key in nextShapeStyle can never override tool-computed geometry')
  assert.equal((created.props as { h: number }).h, h, 'a stray h key in nextShapeStyle can never override tool-computed geometry')
  assert.equal(created.props.color, 'red', 'the real armed style key still lands')
  console.log('ok: tool-computed geometry always wins over any armed props for the same key')
}

{
  // Defensive: even if nextShapeStyle somehow carried a non-style,
  // envelope-shaped key (should never happen through the real panel, whose
  // armed axes are a fixed set -- see style-axes.ts), it must never corrupt
  // the shape's envelope. Confined strictly to props (and opacity).
  const { doc, editor, ctx } = setup()
  // Task C1 (D-5): seed a sibling so "the computed index" has a real,
  // checkable target distinct from both the legacy 'a1' and the smuggled
  // 'zzzz' -- proving the envelope index comes from topIndex, not from
  // props, and not left untouched at some other stale value either.
  doc.putShape({
    id: 'shape:existing', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.commit()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({
    type: 'SetNextStyle',
    props: {
      parentId: 'shape:evil', id: 'shape:evil', index: 'zzzz', rotation: 99, isLocked: true,
      bogusKey: 'x', color: 'blue',
    },
  })
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo' && s.id !== 'shape:existing')!
  assert.equal(created.parentId, 'page:p', 'a stray parentId in nextShapeStyle can never corrupt the envelope parentId')
  assert.notEqual(created.id, 'shape:evil', 'a stray id in nextShapeStyle can never corrupt the envelope id')
  assert.notEqual(created.index, 'zzzz', 'a stray index in nextShapeStyle can never corrupt the envelope index')
  assert.equal(created.index, indexBetween('a1', null), 'the envelope index is the tool-computed top-of-stack key, not the smuggled prop')
  assert.equal(created.rotation, 0, 'a stray rotation in nextShapeStyle can never corrupt the envelope rotation')
  assert.equal(created.isLocked, false, 'a stray isLocked in nextShapeStyle can never corrupt the envelope isLocked')
  assert.equal(created.props.color, 'blue', 'the real armed style key still lands')
  // Hardening (post-review): non-style keys must be DROPPED, not merely
  // inert -- they must never land in props at all, since nextShapeStyle is
  // reachable from a public view intent (SetNextStyle), not just the panel.
  const propsKeys = Object.keys(created.props)
  assert.ok(!propsKeys.includes('parentId'), 'a stray parentId must be dropped from props entirely, not just inert')
  assert.ok(!propsKeys.includes('id'), 'a stray id must be dropped from props entirely, not just inert')
  assert.ok(!propsKeys.includes('index'), 'a stray index must be dropped from props entirely, not just inert')
  assert.ok(!propsKeys.includes('rotation'), 'a stray rotation must be dropped from props entirely, not just inert')
  assert.ok(!propsKeys.includes('isLocked'), 'a stray isLocked must be dropped from props entirely, not just inert')
  assert.ok(!propsKeys.includes('bogusKey'), 'an arbitrary unknown key (on no style-axis whitelist) must be dropped from props entirely')
  console.log('ok: a non-style key smuggled into nextShapeStyle never corrupts the envelope, and is whitelisted out of props entirely')
}

// ============================================================================
// 6. Task C1 (D-5) — top-of-stack index at creation.
// ============================================================================

// 6a. First shape on an empty page: no siblings -> indexBetween(null, null),
//     a valid starting key. Mutant killed: "crashes/throws on an empty page."
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  const events = script().down(300, 300).up().events()
  assert.doesNotThrow(() => run(editor, tool, events), 'creating the first shape on an empty page must not throw')
  const created = editor.doc.listShapes()[0]!
  assert.equal(created.index, indexBetween(null, null), 'first shape on an empty page gets indexBetween(null, null)')
  assert.equal(created.index, 'a0', "indexBetween(null, null) is the algorithm's published starting key")
  console.log('ok: first shape on an empty page gets a valid starting index, no crash')
}

// 6b. "Reads wrong parent's siblings" mutant: a sibling exists under a
//     DIFFERENT parent (a frame) with an index that lexically sorts ABOVE
//     any key indexBetween('a1', null) could produce, and a page:p sibling
//     sits at 'a1'. The correct implementation filters siblings by parentId
//     BEFORE taking the max, so the new (page:p) shape's index must be
//     EXACTLY indexBetween('a1', null) -- not influenced by the frame
//     child's higher, wrong-parent index. A mutant that takes the max
//     across ALL shapes regardless of parentId would instead compute
//     indexBetween(<the frame child's index>, null), a DIFFERENT string,
//     which this exact-value assertion catches.
{
  const { doc, editor, ctx } = setup()
  // A genuinely valid key (via indexBetween, not a hand-picked string --
  // A1's key format encodes length in the header char, so an arbitrary
  // single letter like 'z' is NOT a valid key on its own) that lexically
  // sorts ABOVE indexBetween('a1', null), the value the CORRECT
  // implementation must produce for the page:p create below.
  const HIGH_WRONG_PARENT_KEY = indexBetween(indexBetween('a1', null), null)
  doc.putShape({
    id: 'shape:frame1', kind: 'frame', parentId: 'page:p', index: 'a1', x: 1000, y: 1000, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putShape({
    id: 'shape:frame-child', kind: 'geo', parentId: 'shape:frame1', index: HIGH_WRONG_PARENT_KEY, x: 1001, y: 1001, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 5, h: 5 },
  } as Shape)
  doc.putShape({
    id: 'shape:page-sibling', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.commit()

  const tool = createCreateTool(ctx, 'geo')
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)
  const created = editor.doc.listShapes().find((s) => s.id !== 'shape:frame1' && s.id !== 'shape:frame-child' && s.id !== 'shape:page-sibling')!
  assert.equal(created.index, indexBetween('a1', null), "top-of-stack index reads ONLY the target parent's (page:p) siblings, ignoring the frame child's unrelated, higher index")
  console.log("ok: topIndex reads only the target parent's siblings, not a shape parented elsewhere")
}

// 6c. "Lands on top": two shapes created in sequence (same tool, two
//     separate click-creates) -- the second's index sorts strictly AFTER
//     the first's, so A2's orderForPaint paints it on top.
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  run(editor, tool, script().down(100, 100).up().events())
  const first = editor.doc.listShapes()[0]!
  run(editor, tool, script().down(200, 200).up().events())
  const shapesAfter = editor.doc.listShapes()
  assert.equal(shapesAfter.length, 2, 'two shapes now exist')
  const second = shapesAfter.find((s) => s.id !== first.id)!
  assert.ok(first.index < second.index, `second-created shape's index (${second.index}) must sort after the first's (${first.index}) -- lands on top`)
  console.log('ok: the second of two sequentially-created shapes sorts strictly after the first (lands on top)')
}

// 6d. Replay determinism: a multi-move drag-create threads ONE computed
//     index through every per-pointermove re-emission of the SAME shape.
//     Mutant killed: "recomputes topIndex each pointermove including self"
//     -- once the first move's CreateShape has committed, that mutant would
//     see the shape's OWN prior index as the new max sibling and mint a
//     strictly-increasing index on every subsequent move; this test asserts
//     the index observed after move 1 equals the index observed after
//     move 2.
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  let state = tool.initialState
  const dispatch = (events: readonly import('../input.js').InputEvent[]) => {
    for (const event of events) {
      const result = tool.onEvent(state, event)
      state = result.state
      if (result.intents.length > 0) editor.applyAll(result.intents)
    }
  }

  dispatch(script().down(0, 0).move(50, 50).events()) // crosses threshold -> dragging, first commit
  const afterMove1 = editor.doc.listShapes()[0]!
  const indexAfterMove1 = afterMove1.index

  dispatch([{ type: 'pointermove', x: 80, y: 80, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 200 }]) // second move, re-emits CreateShape for the same id
  const afterMove2 = editor.doc.listShapes().find((s) => s.id === afterMove1.id)!
  assert.equal(afterMove2.index, indexAfterMove1, 'the SAME index is threaded through every pointermove re-emission during one drag-create gesture -- not recomputed per move')

  dispatch([{ type: 'pointerup', x: 80, y: 80, buttons: 0, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 210 }])
  const final = editor.doc.listShapes().find((s) => s.id === afterMove1.id)!
  assert.equal(final.index, indexAfterMove1, 'the threaded index also survives to the final pointerup emission')
  console.log('ok: drag-create threads ONE computed index across every pointermove + pointerup re-emission (replay-deterministic)')
}

// ============================================================================
// 7. E2 — current-page parenting (the currentPageId ripple). The tool is
//    CONSTRUCTED FIRST (like a real tool-selection instance that outlives a
//    page switch), THEN SetCurrentPage fires, THEN the gesture runs — this
//    is what actually distinguishes a LIVE per-event read from a read
//    captured ONCE at factory-construction time (both would pass if the
//    switch happened before construction). Mutant killed: "reads
//    editor.pageId (factory const)" AND "reads currentPageId but only ONCE
//    at factory scope" — both would keep parenting to 'page:p' here.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createCreateTool(ctx, 'geo') // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  run(editor, tool, script().down(50, 50).up().events())

  const created = editor.doc.listShapes()[0]!
  assert.equal(created.parentId, 'page:q', 'click-create after SetCurrentPage parents onto the CURRENT page, not editor.pageId or a factory-scope snapshot of it')
  console.log('ok: E2 — click-create (constructed before the switch) parents onto the current page after SetCurrentPage')
}

// ============================================================================
// 7b. E2 — topIndex must scan the CURRENT page's siblings, not
//     editor.pageId's. Escaping-mutant catch: a mutant that fixes parentId
//     to read currentPageId live but leaves `topIndex(ctx, pageId)` reading
//     `editor.pageId` PASSES every parentId-only assertion above (both pages
//     are empty in those tests, so the starting index is the same either
//     way) -- it only shows up when the BOOTSTRAP page has a high-indexed
//     sibling and the CURRENT (new) page does not.
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putShape({
    id: 'shape:page-p-high', kind: 'geo', parentId: 'page:p', index: indexBetween('a5', null), x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createCreateTool(ctx, 'geo') // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  run(editor, tool, script().down(50, 50).up().events())

  const created = editor.doc.listShapes().find((s) => s.id !== 'shape:page-p-high')!
  assert.equal(created.parentId, 'page:q', 'sanity: still parents onto page:q')
  assert.equal(created.index, indexBetween(null, null), "topIndex reads page:q's (empty) siblings, not page:p's unrelated high-indexed shape")
  console.log("ok: E2 — topIndex scans the CURRENT page's siblings, not editor.pageId's")
}

// ============================================================================
// 8. E2 — migration safety: with currentPageId at its boot default
//    ('page:p', never switched), creation is UNCHANGED — parents to page:p
//    exactly as before the ripple.
// ============================================================================
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  run(editor, tool, script().down(50, 50).up().events())
  const created = editor.doc.listShapes()[0]!
  assert.equal(created.parentId, 'page:p', 'with currentPageId at its boot default, creation still parents to page:p (single-page/migration safety)')
  console.log('ok: E2 — single-page default (no SetCurrentPage) still parents to page:p')
}

// ============================================================================
// 9. E2 — drag-create threads the CURRENT page consistently across every
//    pointermove re-emission of the same shape (not just at the transition).
// ============================================================================
{
  const { doc, editor, ctx } = setup()
  doc.putPage({ id: 'page:q', name: 'Q' })
  doc.commit()

  const tool = createCreateTool(ctx, 'geo') // constructed BEFORE the switch
  editor.apply({ type: 'SetCurrentPage', pageId: 'page:q' })
  let state = tool.initialState
  const dispatch = (events: readonly import('../input.js').InputEvent[]) => {
    for (const event of events) {
      const result = tool.onEvent(state, event)
      state = result.state
      if (result.intents.length > 0) editor.applyAll(result.intents)
    }
  }
  dispatch(script().down(0, 0).move(50, 50).events()) // crosses threshold -> dragging, first commit
  const afterMove1 = editor.doc.listShapes()[0]!
  assert.equal(afterMove1.parentId, 'page:q', 'drag-create first commit parents onto the current page')

  dispatch([{ type: 'pointermove', x: 80, y: 80, buttons: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 200 }])
  const afterMove2 = editor.doc.listShapes().find((s) => s.id === afterMove1.id)!
  assert.equal(afterMove2.parentId, 'page:q', 'the re-emitted shape keeps parentId on the current page across pointermoves')

  dispatch([{ type: 'pointerup', x: 80, y: 80, buttons: 0, modifiers: { shift: false, alt: false, ctrl: false, meta: false }, t: 210 }])
  const final = editor.doc.listShapes().find((s) => s.id === afterMove1.id)!
  assert.equal(final.parentId, 'page:q', 'the final pointerup emission also lands on the current page')
  console.log('ok: E2 — drag-create threads the current page consistently across every pointermove + pointerup')
}

// ============================================================================
// 10. create-edit-flow task — tldraw parity: click-creating a note or text
//    shape immediately begins editing it (BeginEdit, editor.get().editingId
//    === the new shape's id), matching node_modules/tldraw/src/lib/shapes/
//    {note,text}/toolStates/Pointing.ts's `complete()` ->
//    startEditingShapeWithRichText. geo and frame do NOT auto-edit (geo's
//    own Pointing.ts `complete()` only ever calls
//    `editor.setCurrentTool('select')`, never begins editing) — confirmed
//    per-kind here so a future regression that over-applies BeginEdit to
//    every kind is caught.
// ============================================================================
for (const kind of ['note', 'text'] as const) {
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, kind)
  run(editor, tool, script().down(300, 300).up().events())
  const created = editor.doc.listShapes()[0]!
  assert.equal(editor.get().editingId, created.id, `${kind}: click-create begins editing the new shape immediately`)
  console.log(`ok: click-create ${kind} begins editing immediately (tldraw parity)`)
}

for (const kind of ['geo', 'frame', 'bbthread'] as const) {
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, kind)
  run(editor, tool, script().down(300, 300).up().events())
  assert.equal(editor.get().editingId, null, `${kind}: click-create does NOT begin editing (tldraw parity: only note/text auto-edit)`)
  console.log(`ok: click-create ${kind} does not begin editing`)
}

// Drag-create note/text also begins editing at the finalizing pointerup —
// the SAME finalizeIntents path both the click and drag legs funnel through
// (this file's own header names finalizeIntents as the one seam both share).
{
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'text')
  run(editor, tool, script().down(0, 0).move(80, 80).up().events())
  const created = editor.doc.listShapes()[0]!
  assert.equal(editor.get().editingId, created.id, 'drag-create text also begins editing at pointerup')
  console.log('ok: drag-create text begins editing immediately (tldraw parity)')
}

// ============================================================================
// MEMBERSHIP AT CREATION (frame-membership task, second half). The contract
// `shape-created-inside-a-frame-joins-it` pins the headline rule; these pin
// the cases around it: the shape is born WHERE IT WAS DRAWN (no offset by the
// frame's transform), its z-index is computed among the frame's children, a
// bbthread's pane does not capture, frames nest, and a nested frame still
// adopts the shapes it is drawn around.
// ============================================================================

function frameSetup(kind: string, w: number, h: number) {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({
    id: 'shape:home', kind, parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w, h },
  } as Shape)
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
  return { doc, editor, ctx: createToolContext(editor) }
}

// ============================================================================
// 9. A geo drawn inside a frame is born as its CHILD, positioned so it lands
//    exactly where it was drawn (local coords, not the world ones).
// ============================================================================
{
  const { doc, editor, ctx } = frameSetup('frame', 400, 400)
  // Give the frame a non-zero origin so a missing conversion is visible.
  doc.putShape({ ...doc.getShape('shape:home')!, x: 100, y: 50 } as Shape)
  doc.commit()
  run(editor, createCreateTool(ctx, 'geo'), script().down(200, 150).move(300, 250).up().events())
  const created = doc.listShapes().find((sh) => sh.id !== 'shape:home')!
  assert.equal(created.parentId, 'shape:home', 'a geo drawn inside the frame is born as its child')
  // Drawn from world (200,150) to (300,250); the frame sits at world (100,50),
  // so the LOCAL origin must be (100,100) — not the world (200,150).
  assert.equal(created.x, 100, 'born at the frame-LOCAL x, so it lands where it was drawn')
  assert.equal(created.y, 100, 'born at the frame-LOCAL y')
  console.log('ok: a shape drawn inside a frame is born as its child, in the frame\'s local coordinates')
}

// ============================================================================
// 10. Its z-index is computed among the FRAME's children, not the page's — a
//    shape drawn on top of an existing sibling must not be born underneath it.
// ============================================================================
{
  const { doc, editor, ctx } = frameSetup('frame', 400, 400)
  doc.putShape({
    id: 'shape:sibling', kind: 'geo', parentId: 'shape:home', index: 'a5', x: 10, y: 10,
    rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 50, h: 50 },
  } as Shape)
  doc.commit()
  run(editor, createCreateTool(ctx, 'geo'), script().down(100, 100).move(300, 300).up().events())
  const created = doc.listShapes().find((sh) => sh.id !== 'shape:home' && sh.id !== 'shape:sibling')!
  assert.equal(created.parentId, 'shape:home')
  assert.ok(created.index > 'a5', `the new child must sort ABOVE its existing sibling 'a5', got ${JSON.stringify(created.index)}`)
  console.log('ok: a shape created inside a frame is indexed above the frame\'s existing children')
}

// ============================================================================
// 11. A bbthread's THREAD PANE does not capture on creation either — the same
//    workspace-only rule the drop path uses (frame-membership.ts is shared).
// ============================================================================
{
  const { doc, editor, ctx } = frameSetup('bbthread', 900, 600)
  // Centre lands at (750,300): inside the pane (x >= 600), not the workspace.
  run(editor, createCreateTool(ctx, 'geo'), script().down(700, 250).move(800, 350).up().events())
  const created = doc.listShapes().find((sh) => sh.id !== 'shape:home')!
  assert.equal(created.parentId, 'page:p', 'a shape drawn over the bbthread PANE stays on the page')

  // ...while the same gesture in the workspace DOES join it.
  const { doc: doc2, editor: e2, ctx: c2 } = frameSetup('bbthread', 900, 600)
  run(e2, createCreateTool(c2, 'geo'), script().down(200, 250).move(300, 350).up().events())
  const created2 = doc2.listShapes().find((sh) => sh.id !== 'shape:home')!
  assert.equal(created2.parentId, 'shape:home', 'the same gesture in the WORKSPACE joins the bbthread')
  console.log('ok: creation membership uses the bbthread workspace, never the thread pane')
}

// ============================================================================
// 12. Frames NEST, and a nested frame still adopts what it is drawn around —
//    capture is restricted to the siblings the new frame will actually have
//    (its enclosing frame's children), not hardcoded to the page's.
// ============================================================================
{
  const { doc, editor, ctx } = frameSetup('frame', 600, 600)
  doc.putShape({
    id: 'shape:inhabitant', kind: 'geo', parentId: 'shape:home', index: 'a2', x: 150, y: 150,
    rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
  } as Shape)
  doc.commit()
  // Draw an inner frame from (100,100) to (400,400) — inside shape:home, and
  // fully enclosing shape:inhabitant's world box [150,250]x[150,250].
  run(editor, createCreateTool(ctx, 'frame'), script().down(100, 100).move(400, 400).up().events())
  const inner = doc.listShapes().find((sh) => sh.id !== 'shape:home' && sh.id !== 'shape:inhabitant')!
  assert.equal(inner.parentId, 'shape:home', 'a frame drawn inside another frame nests under it')
  assert.equal(doc.getShape('shape:inhabitant')!.parentId, inner.id,
    'and it still adopts the shape it was drawn around, even though that shape was the OUTER frame\'s child')
  console.log('ok: a frame drawn inside a frame nests, and still captures its enclosing frame\'s children')
}

console.log('ok: create tools (note/text/geo/frame/bbthread) + frame capture')
