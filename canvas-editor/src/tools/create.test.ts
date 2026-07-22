// Run: bun src/tools/create.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
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
}

// ============================================================================
// 1. Click-create each kind: envelope correctness (kind, parentId=pageId, id
//    from the factory), default size, CENTERED placement, and the created
//    shape becomes the selection.
// ============================================================================
for (const kind of ['note', 'text', 'geo', 'frame'] as const) {
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
  const { editor, ctx } = setup()
  const tool = createCreateTool(ctx, 'geo')
  editor.apply({ type: 'SetNextStyle', props: { color: 'blue', size: 'l' } })
  const events = script().down(300, 300).up().events()
  run(editor, tool, events)

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo')!
  assert.equal(created.props.color, 'blue', 'armed color lands on the created shape')
  assert.equal(created.props.size, 'l', 'armed size lands on the created shape')
  // Geometry survives the armed-style merge (mutant: "armed props overwrite
  // the whole props map").
  const { w, h } = DEFAULT_SIZE.geo
  assert.equal((created.props as { w: number }).w, w, 'armed style never clobbers the tool-computed w')
  assert.equal((created.props as { h: number }).h, h, 'armed style never clobbers the tool-computed h')
  // Envelope fields untouched by the armed style patch.
  assert.equal(created.parentId, 'page:p', 'armed style never touches parentId')
  assert.equal(created.index, 'a1', 'armed style never touches index')
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
  const { editor, ctx } = setup()
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

  const created = editor.doc.listShapes().find((s) => s.kind === 'geo')!
  assert.equal(created.parentId, 'page:p', 'a stray parentId in nextShapeStyle can never corrupt the envelope parentId')
  assert.notEqual(created.id, 'shape:evil', 'a stray id in nextShapeStyle can never corrupt the envelope id')
  assert.equal(created.index, 'a1', 'a stray index in nextShapeStyle can never corrupt the envelope index')
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

console.log('ok: create tools (note/text/geo/frame) + frame capture')
