// Run: bun src/tools/transform.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { centroid, worldBounds, worldTransform, type Bounds, type Shape } from '@ensembleworks/canvas-model'
import { Editor } from '../editor.js'
import { run, script } from '../script.js'
import { createTransformTool, hitHandle, selectionHandles } from './transform.js'
import { createToolContext } from './tool-context.js'

const FIXED_RANDOM = () => 0.5

const geoShape = (id: string, x: number, y: number, w: number, h: number, over: Partial<Shape> = {}): Shape => ({
  id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w, h }, ...over,
} as Shape)

function setup() {
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.commit()
  const editor = new Editor({ doc, now: () => 0, random: FIXED_RANDOM, pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createTransformTool(ctx)
  return { doc, editor, ctx, tool }
}

const EPS = 1e-6

// ============================================================================
// 1. selectionHandles layout: exact 9-handle layout for a known Bounds --
//    pins the documented layout (4 corners, 4 edge midpoints, 1 rotate
//    handle 32 units above the top edge) as the single source of truth D4
//    will render from.
// ============================================================================
{
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 }
  const handles = selectionHandles(bounds)
  const byId = new Map(handles.map((h) => [h.id, h]))
  assert.deepEqual(byId.get('nw')!.point, { x: 0, y: 0 })
  assert.deepEqual(byId.get('ne')!.point, { x: 100, y: 0 })
  assert.deepEqual(byId.get('se')!.point, { x: 100, y: 50 })
  assert.deepEqual(byId.get('sw')!.point, { x: 0, y: 50 })
  assert.deepEqual(byId.get('n')!.point, { x: 50, y: 0 })
  assert.deepEqual(byId.get('s')!.point, { x: 50, y: 50 })
  assert.deepEqual(byId.get('e')!.point, { x: 100, y: 25 })
  assert.deepEqual(byId.get('w')!.point, { x: 0, y: 25 })
  assert.deepEqual(byId.get('rotate')!.point, { x: 50, y: -32 }, 'rotate handle sits 32 units above the top edge midpoint')
  assert.equal(byId.get('nw')!.kind, 'corner')
  assert.equal(byId.get('n')!.kind, 'edge')
  assert.equal(byId.get('rotate')!.kind, 'rotate')
  console.log('ok: selectionHandles lays out the documented 4 corners + 4 edges + 1 rotate handle')
}

// ============================================================================
// 2. hitHandle: closest-handle-wins within tolerance; a point farther than
//    tolerancePx from every handle misses (null), at a non-1 zoom.
// ============================================================================
{
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const handles = selectionHandles(bounds)
  const camera = { x: 0, y: 0, z: 2 } // se handle (100,100) world -> screen (200,200)
  const hit = hitHandle(handles, { x: 203, y: 197 }, camera, 8)
  assert.equal(hit?.id, 'se', 'closest handle within tolerance at a non-1 zoom')
  const miss = hitHandle(handles, { x: 220, y: 220 }, camera, 8)
  assert.equal(miss, null, 'a point farther than tolerancePx from every handle misses')
  console.log('ok: hitHandle picks the closest handle within a zoom-correct screen tolerance')
}

// ============================================================================
// 3. Corner resize math (z=1, hand-computed): shape:box at [0,100]x[0,100].
//    Selected, then dragged from its SE corner (100,100) to (200,150) --
//    scaleX = 200/100 = 2, scaleY = 150/100 = 1.5, about the fixed NW
//    anchor (0,0).
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:box', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:box'] })

  const events = script().down(100, 100).move(200, 150).up().events()
  run(editor, tool, events)

  const box = editor.doc.getShape('shape:box')!
  assert.equal(box.x, 0, 'anchor (NW, opposite of the dragged SE corner) is fixed')
  assert.equal(box.y, 0)
  assert.equal((box.props as any).w, 200, '100 * scaleX(2)')
  assert.equal((box.props as any).h, 150, '100 * scaleY(1.5)')
  console.log('ok: corner resize at z=1 matches hand-computed scale about the opposite corner')
}

// ============================================================================
// 4. Corner resize math (z != 1): the IDENTICAL world-space drag as test 3,
//    driven entirely in SCREEN coordinates at camera z=2 -- proves the
//    result is zoom-compensated, not a screen-pixel-count artifact.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:box2', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetCamera', x: 0, y: 0, z: 2 })
  editor.apply({ type: 'SetSelection', ids: ['shape:box2'] })

  // World (100,100) -> screen (200,200); world (200,150) -> screen (400,300).
  const events = script().down(200, 200).move(400, 300).up().events()
  run(editor, tool, events)

  const box2 = editor.doc.getShape('shape:box2')!
  assert.equal(box2.x, 0)
  assert.equal(box2.y, 0)
  assert.equal((box2.props as any).w, 200)
  assert.equal((box2.props as any).h, 150)
  console.log('ok: corner resize at z=2 is zoom-compensated -- identical result to the z=1 case')
}

// ============================================================================
// 5. Edge resize: dragging the 'e' (right-edge midpoint) handle scales ONLY
//    the x axis, about the fixed 'w' (left-edge midpoint) anchor.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:box3', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:box3'] })

  const events = script().down(100, 50).move(150, 999).up().events() // e handle at (100,50); y-drag must NOT affect scaleY
  run(editor, tool, events)

  const box3 = editor.doc.getShape('shape:box3')!
  assert.equal(box3.x, 0)
  assert.equal(box3.y, 0, 'y untouched -- edge handle scales one axis only')
  assert.equal((box3.props as any).w, 150, '100 * scaleX(1.5)')
  assert.equal((box3.props as any).h, 100, 'h unchanged -- scaleY forced to 1 for an e/w edge handle')
  console.log('ok: edge resize scales exactly one axis about the opposite edge\'s anchor')
}

// ============================================================================
// 6. Shift = uniform scale (corner handle only): dragging a corner with
//    shift held forces scaleY to follow scaleX's ratio, even though the
//    drag's own y-delta implies a different factor.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:box4', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:box4'] })

  const events = script()
    .down(100, 100, { modifiers: { shift: true } })
    .move(200, 999, { modifiers: { shift: true } }) // y alone would imply a huge scaleY -- shift overrides it to scaleX's ratio
    .up({ modifiers: { shift: true } })
    .events()
  run(editor, tool, events)

  const box4 = editor.doc.getShape('shape:box4')!
  assert.equal((box4.props as any).w, 200, '100 * scaleX(2)')
  assert.equal((box4.props as any).h, 200, 'shift forces scaleY to equal scaleX(2), ignoring the y-drag\'s own implied ratio')
  console.log('ok: shift-held corner resize forces uniform scale (scaleX drives scaleY)')
}

// ============================================================================
// 7. Rotate about center: a single shape at [0,100]x[0,100] (center (50,50))
//    is selected; the rotate handle (50, -32) is dragged to (150,50) -- an
//    angle of exactly 0 relative to the center, i.e. a total rotation of
//    +90 degrees from the handle's own starting angle (-90 degrees, straight
//    up). Final rotation and position are asserted against the SAME
//    orbit-and-spin math editor.test.ts's deferral-closure tests hand-verify
//    (this is the identical RotateShapes composition, now driven by the
//    tool's own angle bookkeeping instead of a direct intent).
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:r', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:r'] })

  const events = script().down(50, -32).move(150, 50).up().events()
  run(editor, tool, events)

  const r = editor.doc.getShape('shape:r')!
  assert.ok(Math.abs(r.rotation - Math.PI / 2) < EPS, `rotation ~= pi/2, got ${r.rotation}`)
  // Orbit shape origin (0,0) around center (50,50) by pi/2: dx=-50,dy=-50 ->
  // x' = 50 + (-50*cos90 - -50*sin90) = 50 + 50 = 100; y' = 50 + (-50*sin90 + -50*cos90) = 50-50 = 0.
  assert.ok(Math.abs(r.x - 100) < EPS, `x ~= 100, got ${r.x}`)
  assert.ok(Math.abs(r.y - 0) < EPS, `y ~= 0, got ${r.y}`)
  console.log('ok: rotate-handle drag orbits the shape about the selection center and spins its rotation')
}

// ============================================================================
// 8. Rotated-parent selection through the TOOL, end to end (RESIZE): a
//    child nested under a parent rotated 90 degrees is selected and
//    resized via a corner-handle drag, with a UNIFORM scale factor
//    (scaleX === scaleY). UNIFORM scale is chosen deliberately: resize
//    operates along the shape's own PARENT-local axes (this tool's
//    documented design -- see computeTargetScale's doc comment), which are
//    themselves rotated 90 degrees from world here, so a NON-uniform scale
//    would show up on the SWAPPED world axis (local-x maps to world-y under
//    a 90-degree parent) -- correct, but a needlessly confusing invariant
//    to assert directly. Uniform scale sidesteps that: scaling a box
//    uniformly by k and then rotating it is identical to rotating first and
//    then scaling uniformly by k (scale-rotate commute when isotropic), so
//    "the WORLD bounds scale by k about the WORLD anchor" holds regardless
//    of the parent's rotation -- exactly the coordinate-frame-agnostic
//    invariant the C8 deferral closure exists to guarantee (see editor.ts's
//    worldToParentFrame).
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape({
    id: 'shape:parent5', kind: 'geo', parentId: 'page:p', index: 'a1', x: 100, y: 100, rotation: Math.PI / 2,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putShape(geoShape('shape:child5', 10, 0, 20, 10, { parentId: 'shape:parent5' } as Partial<Shape>))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:child5'] })

  const snapBefore = dumpModel(doc)
  const boundsBefore = worldBounds(snapBefore, snapBefore.byId.get('shape:child5')!)
  const handles = selectionHandles(boundsBefore)
  const se = handles.find((h) => h.id === 'se')!.point
  const nw = handles.find((h) => h.id === 'nw')!.point // the anchor: opposite of 'se'

  const scaleX = 2, scaleY = 2 // uniform -- see the block comment above for why
  const target = { x: nw.x + (se.x - nw.x) * scaleX, y: nw.y + (se.y - nw.y) * scaleY }
  const events = script().down(se.x, se.y).move(target.x, target.y).up().events()
  run(editor, tool, events)

  const snapAfter = dumpModel(doc)
  const boundsAfter = worldBounds(snapAfter, snapAfter.byId.get('shape:child5')!)
  const expected: Bounds = {
    minX: nw.x + (boundsBefore.minX - nw.x) * scaleX, minY: nw.y + (boundsBefore.minY - nw.y) * scaleY,
    maxX: nw.x + (boundsBefore.maxX - nw.x) * scaleX, maxY: nw.y + (boundsBefore.maxY - nw.y) * scaleY,
  }
  assert.ok(Math.abs(boundsAfter.minX - expected.minX) < EPS, `minX ~= ${expected.minX}, got ${boundsAfter.minX}`)
  assert.ok(Math.abs(boundsAfter.minY - expected.minY) < EPS, `minY ~= ${expected.minY}, got ${boundsAfter.minY}`)
  assert.ok(Math.abs(boundsAfter.maxX - expected.maxX) < EPS, `maxX ~= ${expected.maxX}, got ${boundsAfter.maxX}`)
  assert.ok(Math.abs(boundsAfter.maxY - expected.maxY) < EPS, `maxY ~= ${expected.maxY}, got ${boundsAfter.maxY}`)
  console.log('ok: resize through the tool is world-correct for a shape nested under a rotated parent')
}

// ============================================================================
// 9. Rotated-parent selection through the TOOL, end to end (ROTATE): same
//    nested setup, dragging the rotate handle. Asserted via worldTransform
//    (the same oracle editor.test.ts's deferral-closure tests use): the
//    child's WORLD origin must orbit the selection's world center by the
//    exact angle traversed, and its WORLD rotation must increase by that
//    same angle -- both facts independent of the parent's own rotation.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape({
    id: 'shape:parent6', kind: 'geo', parentId: 'page:p', index: 'a1', x: 100, y: 100, rotation: Math.PI / 2,
    isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
  } as Shape)
  doc.putShape(geoShape('shape:child6', 10, 0, 20, 10, { parentId: 'shape:parent6' } as Partial<Shape>))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:child6'] })

  const snapBefore = dumpModel(doc)
  const childBefore = snapBefore.byId.get('shape:child6')!
  const boundsBefore = worldBounds(snapBefore, childBefore)
  const worldBefore = worldTransform(snapBefore, childBefore)
  const center = centroid(boundsBefore)
  const handles = selectionHandles(boundsBefore)
  const rotateHandle = handles.find((h) => h.id === 'rotate')!.point

  const angleAtDown = Math.atan2(rotateHandle.y - center.y, rotateHandle.x - center.x)
  const delta = Math.PI / 3 // an arbitrary, non-special total rotation
  const radius = 50
  const target = { x: center.x + radius * Math.cos(angleAtDown + delta), y: center.y + radius * Math.sin(angleAtDown + delta) }

  const events = script().down(rotateHandle.x, rotateHandle.y).move(target.x, target.y).up().events()
  run(editor, tool, events)

  const snapAfter = dumpModel(doc)
  const worldAfter = worldTransform(snapAfter, snapAfter.byId.get('shape:child6')!)

  // Expected world origin: orbit worldBefore.{x,y} around `center` by `delta`.
  const dx = worldBefore.x - center.x, dy = worldBefore.y - center.y
  const cos = Math.cos(delta), sin = Math.sin(delta)
  const expectedX = center.x + (dx * cos - dy * sin)
  const expectedY = center.y + (dx * sin + dy * cos)
  assert.ok(Math.abs(worldAfter.x - expectedX) < 1e-4, `child6 world x ~= ${expectedX}, got ${worldAfter.x}`)
  assert.ok(Math.abs(worldAfter.y - expectedY) < 1e-4, `child6 world y ~= ${expectedY}, got ${worldAfter.y}`)
  assert.ok(Math.abs(worldAfter.rotation - (worldBefore.rotation + delta)) < 1e-4, 'world rotation increased by exactly the traversed angle')

  // The rotated PARENT itself must be untouched.
  const parentAfter = editor.doc.getShape('shape:parent6')!
  assert.equal(parentAfter.x, 100)
  assert.equal(parentAfter.y, 100)
  assert.equal(parentAfter.rotation, Math.PI / 2)
  console.log('ok: rotate through the tool is world-correct for a shape nested under a rotated parent')
}

// ============================================================================
// 10. Through-anchor drag, end to end through the TOOL: dragging the SE
//     corner of a 100x100 box THROUGH the NW anchor to (-50,-50) implies a
//     -0.5 scale on both axes -- the editor's minimum-size clamp
//     (editor.ts's clampScale; red-first pinned at the intent level by
//     editor.test.ts's test 20) must floor the STORED w/h at 1 world unit,
//     never persisting negative geometry. tldraw flips instead -- a
//     documented Phase-4 parity item (intents.ts's ResizeShapes doc).
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:thru', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:thru'] })

  const events = script().down(100, 100).move(-50, -50).up().events()
  run(editor, tool, events)

  const thru = editor.doc.getShape('shape:thru')!
  const w = (thru.props as any).w as number, h = (thru.props as any).h as number
  assert.ok(w > 0, `stored w never negative after a through-anchor drag, got ${w}`)
  assert.ok(h > 0, `stored h never negative, got ${h}`)
  assert.ok(Math.abs(w - 1) < 1e-9, `w floors at 1 world unit, got ${w}`)
  assert.ok(Math.abs(h - 1) < 1e-9, `h floors at 1 world unit, got ${h}`)
  assert.ok(Math.abs(thru.x - 0) < 1e-9, 'origin stays at the NW anchor (clamped scale drives position too)')
  assert.ok(Math.abs(thru.y - 0) < 1e-9)
  console.log('ok: through-anchor corner drag clamps stored w/h at the floor, never negative')
}

// ============================================================================
// 11. Cancel-revert (Task B5) — RESIZE: transform.ts captures a verbatim
//     gesture-start snapshot (`startShapes`) on its Resizing/Rotating state
//     the moment the gesture begins mutating the doc (onPointing's first
//     threshold-crossing move), so a caller who abandons the gesture
//     (client/src/canvas-v2/tool-loop.ts's cancelActiveTool) can restore
//     every affected shape verbatim regardless of how many incremental
//     ResizeShapes commits happened. Drive TWO pointermoves (two separate
//     incremental commits, no pointerup — still mid-gesture) and prove
//     replaying `startShapes` back via CreateShape undoes BOTH at once.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:revert', 10, 20, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:revert'] })
  const before = editor.doc.getShape('shape:revert')!

  // SE corner at (110,120); two incremental moves, no pointerup.
  const events = script().down(110, 120).move(200, 150).move(300, 500).events()
  const finalState = run(editor, tool, events)
  assert.equal(finalState.mode, 'resizing', 'precondition: still mid-resize (no pointerup)')

  const midGesture = editor.doc.getShape('shape:revert')!
  assert.notEqual((midGesture.props as { w: number }).w, (before.props as { w: number }).w, 'precondition: two incremental resize commits actually mutated the shape')

  const startShapes = (finalState as { startShapes: readonly Shape[] }).startShapes
  assert.deepEqual(startShapes, [before], 'startShapes carries the EXACT pre-gesture shape, captured before the first commit')
  editor.applyAll(startShapes.map((shape) => ({ type: 'CreateShape' as const, shape })))

  const reverted = editor.doc.getShape('shape:revert')!
  assert.equal(reverted.x, before.x)
  assert.equal(reverted.y, before.y)
  assert.equal((reverted.props as { w: number }).w, (before.props as { w: number }).w)
  assert.equal((reverted.props as { h: number }).h, (before.props as { h: number }).h)
  console.log('ok: cancel-revert — resizing state carries a gesture-start snapshot that restores x/y/w/h verbatim across multiple incremental commits')
}

// ============================================================================
// 12. Cancel-revert (Task B5) — ROTATE: same mechanism, driven via the
//     rotate handle — proves the snapshot/restore covers `rotation` (and the
//     orbited x/y), not just resize's w/h.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:rrevert', 0, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:rrevert'] })
  const before = editor.doc.getShape('shape:rrevert')!
  assert.equal(before.rotation, 0)

  // Rotate handle at (50, -32); two incremental moves, no pointerup.
  const events = script().down(50, -32).move(150, 50).move(50, 150).events()
  const finalState = run(editor, tool, events)
  assert.equal(finalState.mode, 'rotating', 'precondition: still mid-rotate (no pointerup)')

  const midGesture = editor.doc.getShape('shape:rrevert')!
  assert.notEqual(midGesture.rotation, 0, 'precondition: the rotate actually mutated the shape mid-gesture')

  const startShapes = (finalState as { startShapes: readonly Shape[] }).startShapes
  assert.deepEqual(startShapes, [before], 'startShapes carries the EXACT pre-gesture shape')
  editor.applyAll(startShapes.map((shape) => ({ type: 'CreateShape' as const, shape })))

  const reverted = editor.doc.getShape('shape:rrevert')!
  assert.equal(reverted.rotation, before.rotation)
  assert.equal(reverted.x, before.x)
  assert.equal(reverted.y, before.y)
  console.log('ok: cancel-revert — rotating state carries a gesture-start snapshot that restores rotation (and orbited x/y) verbatim')
}

// ============================================================================
// 13. Cancel-revert (Task B5) — MULTI-SELECT: startShapes covers EVERY
//     affected shape, not just the one the handle happens to belong to.
// ============================================================================
{
  const { doc, editor, tool } = setup()
  doc.putShape(geoShape('shape:mm1', 0, 0, 100, 100))
  doc.putShape(geoShape('shape:mm2', 200, 0, 100, 100))
  doc.commit()
  editor.apply({ type: 'SetSelection', ids: ['shape:mm1', 'shape:mm2'] })
  const before1 = editor.doc.getShape('shape:mm1')!
  const before2 = editor.doc.getShape('shape:mm2')!

  // Combined world bounds [0,0]x[300,100] -> SE handle at (300,100).
  const events = script().down(300, 100).move(600, 200).events()
  const finalState = run(editor, tool, events)
  assert.equal(finalState.mode, 'resizing')

  const startShapes = (finalState as { startShapes: readonly Shape[] }).startShapes
  assert.deepEqual(new Set(startShapes.map((s) => s.id)), new Set(['shape:mm1', 'shape:mm2']), 'startShapes covers BOTH affected shapes')
  editor.applyAll(startShapes.map((shape) => ({ type: 'CreateShape' as const, shape })))

  const reverted1 = editor.doc.getShape('shape:mm1')!
  const reverted2 = editor.doc.getShape('shape:mm2')!
  assert.equal((reverted1.props as { w: number }).w, (before1.props as { w: number }).w)
  assert.equal(reverted1.x, before1.x)
  assert.equal((reverted2.props as { w: number }).w, (before2.props as { w: number }).w)
  assert.equal(reverted2.x, before2.x)
  console.log('ok: cancel-revert — a multi-select resize gesture\'s startShapes covers every affected shape')
}

console.log('ok: transform tool (resize/rotate handles) + world-correct frame conversion')
