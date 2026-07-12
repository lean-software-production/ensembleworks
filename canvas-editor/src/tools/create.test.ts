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

  // Rebuild the ToolContext AFTER the fixture is committed (the one built in
  // setup() predates these putShape calls).
  const freshCtx = createToolContext(editor)
  const tool = createCreateTool(freshCtx, 'frame')
  const events = script().down(0, 0).move(60, 60).up().events()
  run(editor, tool, events)

  const frame = editor.doc.listShapes().find((s) => s.kind === 'frame' && s.id !== 'shape:other-frame')!
  assert.ok(frame, 'the drag-created frame exists')
  assert.equal(editor.doc.getShape('shape:root')!.parentId, frame.id, 'a fully-contained ROOT-LEVEL shape is captured into the new frame')
  assert.equal(editor.doc.getShape('shape:child-of-other')!.parentId, 'shape:other-frame', 'a shape already parented elsewhere is NEVER stolen, even if geometrically contained')
  assert.equal(editor.doc.getShape('shape:overlap')!.parentId, 'page:p', 'a root-level shape that only OVERLAPS (not fully contained) is not captured')

  console.log('ok: frame capture reparents only fully-contained root-level shapes')
}

console.log('ok: create tools (note/text/geo/frame) + frame capture')
