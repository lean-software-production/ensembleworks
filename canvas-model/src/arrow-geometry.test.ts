// Run: bun src/arrow-geometry.test.ts
// Task arrow-body (gap 2 — "Arrow bounds / hit-testing follow the drawn
// path"): before this file's fix, an arrow shape carries no props.w/h, so
// geometry.ts's `size()` DEFAULTS fallback made every arrow's worldBounds a
// 100x100 box hanging off its START point regardless of where its END point
// (or bound target) actually is — a long/leftward/upward arrow could not be
// clicked anywhere near its real line, and clicking EMPTY canvas near the
// start (but off the line) wrongly selected it. This file pins the fixed
// behavior: worldBounds/hitTestPoint follow the actual start->end path
// (straight or curved, bound or unbound), not a fixed box.
import assert from 'node:assert/strict'
import { makeDocument, type Binding, type CanvasDocument } from './document.js'
import { worldBounds, hitTestPoint } from './geometry.js'
import { buildSpatialIndex, hitTestTopmost, queryMarquee } from './spatial-index.js'
import type { Shape } from './shape.js'

const base = () => ({ index: 'a1', isLocked: false, opacity: 1, meta: {} })

const geoShape = (id: string, x: number, y: number, w = 100, h = 100): Shape =>
  ({ id, kind: 'geo', parentId: 'page:p', x, y, rotation: 0, props: { w, h }, ...base() }) as any

const arrowShape = (id: string, x: number, y: number, props: Record<string, unknown> = {}): Shape =>
  ({ id, kind: 'arrow', parentId: 'page:p', x, y, rotation: 0, props, ...base() }) as any

const endBinding = (arrowId: string, targetId: string, nx: number, ny: number): Binding => ({
  id: `binding:${arrowId}-end` as any, fromId: arrowId as any, toId: targetId as any,
  props: { terminal: 'end', anchor: { nx, ny } }, meta: {},
})

function doc(shapes: Shape[], bindings: Binding[] = []): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings })
}

// ============================================================================
// 1. Unbound straight arrow, 400 units long, horizontal: worldBounds must
//    span the whole start->end chord, NOT the old 100x100-at-start default.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 200, 300, { end: { x: 400, y: 0 } })
  const d = doc([arrow])
  const bounds = worldBounds(d, arrow)
  assert.deepEqual(bounds, { minX: 200, minY: 300, maxX: 600, maxY: 300 }, 'worldBounds spans the full start->end chord')
  console.log('ok: unbound straight arrow worldBounds follows start->end, not a 100x100 default box')
}

// ============================================================================
// 2. hitTestPoint on that same long arrow: a point ON the line far from the
//    start (well outside the old 100x100 box) hits; a point INSIDE the old
//    fake box but OFF the actual line (the documented bug: "clicking empty
//    space 50px right of its start selects it") misses.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 200, 300, { end: { x: 400, y: 0 } })
  const d = doc([arrow])
  assert.equal(hitTestPoint(d, arrow, { x: 500, y: 300 }), true, 'a point on the line, 300 units from start, hits')
  assert.equal(hitTestPoint(d, arrow, { x: 250, y: 380 }), false, 'a point inside the OLD 100x100-at-start box but off the real line misses')
  assert.equal(hitTestPoint(d, arrow, { x: 500, y: 340 }), false, '40 units perpendicular off the line, past the click-precision margin, misses')
  console.log('ok: hitTestPoint follows the real line, not a box hanging off the start point')
}

// ============================================================================
// 3. Bound end: worldBounds/hitTestPoint follow the CURRENT resolved anchor
//    point on the live target, not the arrow's own (stale) unbound offset.
// ============================================================================
{
  const target = geoShape('shape:target', 700, 300, 100, 100) // [700,800]x[300,400]
  const arrow = arrowShape('shape:arrow', 200, 300, { end: { x: 10, y: 0 } }) // stale unbound end, ignored once bound
  const bindings = [endBinding('shape:arrow', 'shape:target', 0.5, 0.5)] // target's center: (750, 350)
  const d = doc([target, arrow], bindings)
  const bounds = worldBounds(d, arrow)
  assert.ok(bounds.maxX >= 750, `worldBounds must reach toward the bound target's anchor (750,350): got ${JSON.stringify(bounds)}`)
  // The resolved line runs (200,300) -> (750,350) (NOT (200,300) -> (210,300),
  // the arrow's stale unbound offset). (475,325) is that line's own
  // midpoint, so it hits regardless of exact margin; (600,300) sits ~36
  // units off this line (past the click-precision margin) and would only
  // wrongly hit if the binding were ignored in favor of the stale
  // horizontal offset.
  assert.equal(hitTestPoint(d, arrow, { x: 475, y: 325 }), true, 'a point on the resolved (bound) line hits')
  assert.equal(hitTestPoint(d, arrow, { x: 600, y: 300 }), false, 'a point off the resolved line (but near the stale unbound direction) misses')
  console.log('ok: bound arrow follows the live target anchor, not its own stale stored end offset')
}

// ============================================================================
// 4. Curved arrow (bend != 0): worldBounds is inflated toward the bulge, and
//    a point near the curve's midpoint bulge hits even though it is off the
//    STRAIGHT chord.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 200, y: 0 }, bend: 40 })
  const d = doc([arrow])
  const bounds = worldBounds(d, arrow)
  assert.ok(bounds.maxY >= 40 || bounds.minY <= -40, `curved arrow's worldBounds must be inflated by bend: got ${JSON.stringify(bounds)}`)
  console.log('ok: curved arrow worldBounds is inflated toward the curve\'s bulge')
}

// ============================================================================
// 5. End-to-end through the spatial index (hitTestTopmost): a long arrow is
//    selectable by clicking near its actual line, and NOT selectable by
//    clicking empty canvas near its start point (off the line).
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 500, y: 0 } })
  const d = doc([arrow])
  const index = buildSpatialIndex(d)
  assert.equal(hitTestTopmost(index, d, { x: 400, y: 0 }), 'shape:arrow', 'clicking near the line, far from the start, selects the arrow')
  assert.equal(hitTestTopmost(index, d, { x: 60, y: 60 }), null, 'clicking empty space near (but off) the start misses — the old fake-box bug')
  console.log('ok: hitTestTopmost follows the arrow\'s real path through the spatial index')
}

// ============================================================================
// 6. Marquee 'intersect' narrow phase (validator regression, item 4): a
//    rubber-band dragged squarely over an arrow's line, far from its start,
//    must select it. Before the fix, queryMarquee's narrow phase tested the
//    marquee rect against `worldCorners` — still the stale 100x100-at-start
//    box for an arrow — even though the broad phase (worldBounds-driven) had
//    already become path-aware.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 500, y: 0 } })
  const d = doc([arrow])
  const index = buildSpatialIndex(d)
  const marquee = { minX: 400, minY: -10, maxX: 480, maxY: 10 }
  assert.deepEqual(
    queryMarquee(index, d, marquee, 'intersect'),
    ['shape:arrow'],
    'a marquee over the line 400 units from the start selects the arrow, not just near its start',
  )
  console.log('ok: queryMarquee(\'intersect\') follows the arrow\'s real path, not the stale box quad')
}

console.log('ok: arrow-geometry (worldBounds/hitTestPoint/hitTestTopmost follow the drawn path, straight/curved/bound/unbound)')
