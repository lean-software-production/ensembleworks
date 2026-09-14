// Run: bun src/tools/arrow-handles.test.ts
import assert from 'node:assert/strict'
import { makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import { arrowHandles, bendFromPoint, hitArrowHandle } from './arrow-handles.js'

const arrowShape = (id: string, x: number, y: number, props: Record<string, unknown> = {}): Shape => ({
  id, kind: 'arrow', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props,
} as Shape)

function doc(shapes: Shape[]): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings: [] })
}

// ============================================================================
// 1. arrowHandles: a straight (bend: 0) arrow's handles sit at start/end
//    exactly, and `mid` at the plain chord midpoint (routeArrow sets no
//    `mid` for a straight path, so this function must fall back to the
//    midpoint itself).
// ============================================================================
{
  const arrow = arrowShape('shape:a', 0, 0, { end: { x: 100, y: 0 } })
  const d = doc([arrow])
  const handles = arrowHandles(d, arrow)
  const byId = new Map(handles.map((h) => [h.id, h]))
  assert.deepEqual(byId.get('start')!.point, { x: 0, y: 0 })
  assert.deepEqual(byId.get('end')!.point, { x: 100, y: 0 })
  assert.deepEqual(byId.get('mid')!.point, { x: 50, y: 0 })
  console.log('ok: straight arrow handles sit at start/end/chord-midpoint')
}

// ============================================================================
// 2. arrowHandles: a bent arrow's `mid` handle sits at routeArrow's actual
//    curve control point, not the plain chord midpoint.
// ============================================================================
{
  const arrow = arrowShape('shape:a', 0, 0, { end: { x: 100, y: 0 }, bend: 20 })
  const d = doc([arrow])
  const handles = arrowHandles(d, arrow)
  const mid = handles.find((h) => h.id === 'mid')!.point
  assert.equal(mid.x, 50)
  assert.equal(mid.y, 20, 'bend 20 on a horizontal chord offsets mid by +20 on y (curveMid\'s perpendicular convention)')
  console.log('ok: bent arrow\'s mid handle matches routeArrow\'s curve control point')
}

// ============================================================================
// 3. hitArrowHandle: closest-within-tolerance, same contract as
//    transform.ts's hitHandle -- a point far from every handle misses.
// ============================================================================
{
  const arrow = arrowShape('shape:a', 0, 0, { end: { x: 100, y: 0 } })
  const d = doc([arrow])
  const handles = arrowHandles(d, arrow)
  const camera = { x: 0, y: 0, z: 1 }
  assert.equal(hitArrowHandle(handles, { x: 0, y: 0 }, camera, 8), 'start')
  assert.equal(hitArrowHandle(handles, { x: 100, y: 0 }, camera, 8), 'end')
  assert.equal(hitArrowHandle(handles, { x: 50, y: 0 }, camera, 8), 'mid')
  assert.equal(hitArrowHandle(handles, { x: 50, y: 50 }, camera, 8), null, 'far from every handle: miss')
  console.log('ok: hitArrowHandle picks the closest handle within tolerance, else null')
}

// ============================================================================
// 4. bendFromPoint inverts curveMid: projecting the dragged point onto the
//    chord's perpendicular axis reproduces the exact bend that would place
//    the curve's control point there.
// ============================================================================
{
  const start = { x: 0, y: 0 }, end = { x: 100, y: 0 }
  assert.equal(bendFromPoint(start, end, { x: 50, y: 30 }), 30)
  assert.equal(bendFromPoint(start, end, { x: 50, y: -15 }), -15)
  // A point off the perpendicular axis (nonzero x-offset from mid) still
  // projects cleanly -- only the perpendicular component contributes.
  assert.equal(bendFromPoint(start, end, { x: 80, y: 10 }), 10)
  console.log('ok: bendFromPoint projects the dragged point onto the chord\'s perpendicular axis')
}

// ============================================================================
// 5. bendFromPoint: degenerate zero-length chord returns 0, never NaN.
// ============================================================================
{
  assert.equal(bendFromPoint({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 9 }), 0)
  console.log('ok: bendFromPoint on a zero-length chord returns 0, not NaN')
}

console.log('All arrow-handles tests passed.')
