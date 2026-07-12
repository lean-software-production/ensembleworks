// Run: bun src/arrow-route.test.ts
import assert from 'node:assert/strict'
import { routeArrow } from './arrow-route.js'
import { makeDocument, type Binding, type CanvasDocument } from './document.js'
import type { Shape } from './shape.js'

const geoShape = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): Shape => ({
  id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation,
  isLocked: false, opacity: 1, meta: {}, props: { w, h },
} as Shape)

const arrowShape = (id: string, x: number, y: number, props: Record<string, unknown> = {}): Shape => ({
  id, kind: 'arrow', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props,
} as Shape)

const startBinding = (arrowId: string, targetId: string, nx: number, ny: number): Binding => ({
  id: `binding:${arrowId}-start` as any, fromId: arrowId as any, toId: targetId as any,
  props: { terminal: 'start', anchor: { nx, ny } }, meta: {},
})
const endBinding = (arrowId: string, targetId: string, nx: number, ny: number): Binding => ({
  id: `binding:${arrowId}-end` as any, fromId: arrowId as any, toId: targetId as any,
  props: { terminal: 'end', anchor: { nx, ny } }, meta: {},
})

function doc(shapes: Shape[], bindings: Binding[] = []): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings })
}

// ============================================================================
// 1. Unbound straight arrow: world start/end read straight off the shape's
//    own x/y + props.end offset, no clipping (no bindings to clip against).
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 } })
  const path = routeArrow(doc([arrow]), arrow, [])
  assert.deepEqual(path.start, { x: 0, y: 0 })
  assert.deepEqual(path.end, { x: 100, y: 0 })
  assert.equal(path.kind, 'straight')
  assert.equal(path.mid, undefined, 'straight path carries no mid control point')
  console.log('ok: unbound straight arrow reads its own stored points')
}

// ============================================================================
// 2. Bound both ends, anchored at each target's CENTER (an interior point,
//    not already on the boundary) -- the visible segment must clip to each
//    target's edge, not terminate at the (interior) anchor itself. Two
//    100x100 boxes, A at [0,100]x[0,100], B at [300,400]x[0,100] -- the
//    horizontal line between their centers (50,50)->(350,50) crosses A's
//    right edge at x=100 and B's left edge at x=300, both at y=50.
// ============================================================================
{
  const a = geoShape('shape:a', 0, 0, 100, 100)
  const b = geoShape('shape:b', 300, 0, 100, 100)
  const arrow = arrowShape('shape:arrow', 50, 50)
  const bindings = [startBinding('shape:arrow', 'shape:a', 0.5, 0.5), endBinding('shape:arrow', 'shape:b', 0.5, 0.5)]
  const path = routeArrow(doc([a, b, arrow], bindings), arrow, bindings)
  assert.deepEqual(path.start, { x: 100, y: 50 }, 'clipped to A\'s right edge, not A\'s interior center')
  assert.deepEqual(path.end, { x: 300, y: 50 }, 'clipped to B\'s left edge, not B\'s interior center')
  assert.equal(path.kind, 'straight')
  console.log('ok: bound-both-ends clips to each target\'s boundary from its interior anchor')
}

// ============================================================================
// 3. Arrow follows when the bound target MOVES: re-routing against an
//    updated snapshot (the target translated +200 on x) must reflect the
//    new position -- bindings resolve against the CURRENT doc, not a value
//    cached at bind time.
// ============================================================================
{
  const a0 = geoShape('shape:a', 0, 0, 100, 100)
  // props.end is a LOCAL OFFSET from the arrow's own x/y (50,50), not an
  // absolute world point -- {x:500, y:0} puts the unbound end's world
  // point at (550, 50), keeping the start<->end chord perfectly horizontal
  // so the clip math below has a single unambiguous expected answer.
  const arrow = arrowShape('shape:arrow', 50, 50, { end: { x: 500, y: 0 } })
  const bindings = [startBinding('shape:arrow', 'shape:a', 0.5, 0.5)]
  const before = routeArrow(doc([a0, arrow], bindings), arrow, bindings)
  assert.deepEqual(before.start, { x: 100, y: 50 }, 'initial clip against A at its original position')

  const a1 = geoShape('shape:a', 200, 0, 100, 100) // moved +200 on x
  const after = routeArrow(doc([a1, arrow], bindings), arrow, bindings)
  assert.deepEqual(after.start, { x: 300, y: 50 }, 'clip point tracks A\'s NEW position after the move')
  console.log('ok: routeArrow reflects the bound target\'s current position, not a bind-time snapshot')
}

// ============================================================================
// 4. Vanished bound target: a binding row survives (dangling, pre-repair)
//    but its toId no longer resolves -- fall back to the arrow's own stored
//    point for that terminal, NOT anchorToWorld's {x:0,y:0} default.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 10, 20, { end: { x: 40, y: 20 } }) // props.end is a LOCAL OFFSET -> world end = (10+40, 20+20)
  const bindings = [startBinding('shape:arrow', 'shape:gone', 0.5, 0.5)]
  const path = routeArrow(doc([arrow], bindings), arrow, bindings)
  assert.deepEqual(path.start, { x: 10, y: 20 }, 'vanished start target falls back to the arrow\'s own stored x/y')
  assert.deepEqual(path.end, { x: 50, y: 40 }, 'end was never bound -- reads props.end (a local offset) as usual')
  console.log('ok: vanished bound target falls back to the arrow\'s own stored point')
}

// ============================================================================
// 5. Zero-size target: a bound endpoint against a w=0/h=0 shape must not
//    throw -- worldCorners degenerates to a single point, no edge
//    intersection is possible, clipToBoundary falls back to the unclipped
//    (itself-degenerate) anchor point.
// ============================================================================
{
  const flat = geoShape('shape:flat', 70, 30, 0, 0)
  const arrow = arrowShape('shape:arrow', 0, 0)
  const bindings = [endBinding('shape:arrow', 'shape:flat', 0.5, 0.5)]
  let path: ReturnType<typeof routeArrow> | undefined
  assert.doesNotThrow(() => { path = routeArrow(doc([flat, arrow], bindings), arrow, bindings) })
  assert.deepEqual(path!.end, { x: 70, y: 30 }, 'zero-size target collapses to its own position, unclipped')
  console.log('ok: zero-size bound target is total (no throw, degenerate-point fallback)')
}

// ============================================================================
// 6. Curved: bend != 0 produces kind 'curved' with a mid control point at
//    the chord midpoint offset perpendicular by `bend` -- hand-computed for
//    a horizontal chord (0,0)->(100,0): unit direction (1,0), perpendicular
//    (0,1), so mid = (50, 0) + bend*(0,1) = (50, 10) for bend=10.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 }, bend: 10 })
  const path = routeArrow(doc([arrow]), arrow, [])
  assert.equal(path.kind, 'curved')
  assert.deepEqual(path.start, { x: 0, y: 0 })
  assert.deepEqual(path.end, { x: 100, y: 0 })
  assert.deepEqual(path.mid, { x: 50, y: 10 }, 'mid control point: chord midpoint + bend along the perpendicular')
  console.log('ok: curved arrow computes its mid control point from bend + the chord\'s perpendicular')
}

// ============================================================================
// 7. Self-binding (start target === end target), both anchored at the SAME
//    target's center: both endpoints resolve to the identical world point
//    (a degenerate zero-length arrow) -- must not throw, and curveMid's
//    zero-length guard must return a finite point, not NaN, even under a
//    nonzero bend.
// ============================================================================
{
  const a = geoShape('shape:a', 0, 0, 100, 100)
  const arrow = arrowShape('shape:arrow', 50, 50, { bend: 5 })
  const bindings = [startBinding('shape:arrow', 'shape:a', 0.5, 0.5), endBinding('shape:arrow', 'shape:a', 0.5, 0.5)]
  let path: ReturnType<typeof routeArrow> | undefined
  assert.doesNotThrow(() => { path = routeArrow(doc([a, arrow], bindings), arrow, bindings) })
  assert.deepEqual(path!.start, { x: 50, y: 50 })
  assert.deepEqual(path!.end, { x: 50, y: 50 })
  assert.deepEqual(path!.mid, { x: 50, y: 50 }, 'zero-length chord: mid falls back to the shared point, no NaN')
  console.log('ok: self-binding (same target both ends) is tolerated -- degenerate but total')
}

// ============================================================================
// 8. ROTATED-target clipping (the reviewer's probe): a 100x100 target
//    rotated 45 degrees, positioned so its CENTER sits at world (200,200)
//    -- i.e. a diamond with vertices at (200 +/- 100/sqrt(2), 200) and
//    (200, 200 +/- 100/sqrt(2)). An arrow anchored at that center with its
//    unbound start far to the LEFT at y=200 rides a horizontal ray that
//    enters the diamond at its LEFT VERTEX: (200 - 100*sin(pi/4), 200) =
//    (129.28932188134524, 200).
//
//    The expectation below is constructed INDEPENDENTLY of the
//    implementation: the four corners are hand-rotated with explicit
//    cos/sin arithmetic (the package's NORMATIVE rotation convention,
//    geometry.ts: world = rotate(local, theta) + position -- x' = x cos -
//    y sin, y' = x sin + y cos), NOT read back from worldCorners, so a sign
//    or pivot error in the geometry pipeline cannot cancel itself out of
//    this test.
// ============================================================================
{
  const theta = Math.PI / 4
  const cos = Math.cos(theta), sin = Math.sin(theta)
  // Choose the shape's position so the box CENTER lands at (200,200):
  // center = position + rotate((50,50), theta); rotate((50,50), pi/4) =
  // (50cos - 50sin, 50sin + 50cos) = (0, 100*sin(pi/4)) since cos==sin.
  const posX = 200, posY = 200 - 100 * sin // = 200 - (50sin + 50cos)
  // Hand-rotated corners (local (0,0), (100,0), (100,100), (0,100)):
  const corner = (lx: number, ly: number) => ({ x: posX + lx * cos - ly * sin, y: posY + lx * sin + ly * cos })
  const c0 = corner(0, 0), c1 = corner(100, 0), c2 = corner(100, 100), c3 = corner(0, 100)
  // Sanity on the independent construction itself: c3 IS the diamond's left
  // vertex at exactly (200 - 100 sin(pi/4), 200) -- the reviewer's number.
  assert.ok(Math.abs(c3.x - 129.28932188134524) < 1e-12, `left vertex x, got ${c3.x}`)
  assert.ok(Math.abs(c3.y - 200) < 1e-12, `left vertex y, got ${c3.y}`)
  // And the two edges meeting at c3 (c2->c3 and c3->c0) straddle y=200:
  // both other corners on the left half (c2 below at y>200, c0 above at
  // y<200), so a horizontal ray at y=200 entering from the left crosses
  // the boundary exactly at the c3 vertex.
  assert.ok(c0.y < 200 && c2.y > 200, 'edge construction sanity: c0 above, c2 below the ray')

  const target: Shape = ({
    id: 'shape:diamond', kind: 'geo', parentId: 'page:p', index: 'a1', x: posX, y: posY, rotation: theta,
    isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
  } as Shape)
  // Arrow: unbound start far to the left at y=200; end bound to the
  // diamond's center anchor (0.5, 0.5) -> world (200,200).
  const arrow = arrowShape('shape:arrow', 0, 200)
  const bindings = [endBinding('shape:arrow', 'shape:diamond', 0.5, 0.5)]
  const path = routeArrow(doc([target, arrow], bindings), arrow, bindings)

  assert.deepEqual(path.start, { x: 0, y: 200 })
  assert.ok(Math.abs(path.end.x - 129.28932188134524) < 1e-9, `clipped end x = 200 - 100 sin(pi/4) (independently hand-rotated edge), got ${path.end.x}`)
  assert.ok(Math.abs(path.end.y - 200) < 1e-9, `clipped end y = 200, got ${path.end.y}`)
  console.log('ok: clipping against a ROTATED target quad matches the independently hand-rotated edge')
}

console.log('ok: arrow routing (bound anchors, boundary clipping, straight+curve)')
