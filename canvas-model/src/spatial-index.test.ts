// Run: bun src/spatial-index.test.ts
import assert from 'node:assert/strict'
import { makeDocument, type CanvasDocument } from './document.js'
import { worldBounds, worldTransform, localBounds, hitTestPoint } from './geometry.js'
import { buildSpatialIndex, queryViewport, queryMarquee, hitTestTopmost } from './spatial-index.js'

const base = () => ({ index: 'a1', isLocked: false, opacity: 1, meta: {} })
const geo = (id: string, parentId: string, x: number, y: number, rotation: number, w: number, h: number) =>
  ({ id, kind: 'geo', parentId, x, y, rotation, props: { w, h }, ...base() }) as any

// ---- exact fixed-value cases ----

// queryViewport: culling by any-intersection.
const cullDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    geo('shape:in', 'page:p', 0, 0, 0, 50, 50),       // fully inside a [0,100]^2 viewport
    geo('shape:edge', 'page:p', 90, 90, 0, 50, 50),   // straddles the viewport edge
    geo('shape:out', 'page:p', 1000, 1000, 0, 50, 50), // far outside
  ],
  bindings: [],
})
const cullIndex = buildSpatialIndex(cullDoc)
assert.deepEqual(
  new Set(queryViewport(cullIndex, { minX: 0, minY: 0, maxX: 100, maxY: 100 })),
  new Set(['shape:in', 'shape:edge']),
  'viewport culling: any-intersection includes the straddling shape, excludes the far one',
)

// queryMarquee 'contain': only fully-inside shapes qualify.
const marqueeDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    geo('shape:inside', 'page:p', 10, 10, 0, 20, 20),   // [10,30]x[10,30] -- fully inside [0,100]^2
    geo('shape:straddle', 'page:p', 90, 90, 0, 50, 50), // straddles the boundary -- NOT contained
  ],
  bindings: [],
})
const marqueeIndex = buildSpatialIndex(marqueeDoc)
assert.deepEqual(
  queryMarquee(marqueeIndex, marqueeDoc, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 'contain'),
  ['shape:inside'],
  'contain mode: only the fully-inside shape qualifies',
)

// queryMarquee 'intersect': rotated-quad-accurate -- a marquee touching only
// the empty AABB corner of a rotated shape must NOT select it.
// 100x100 box at (0,0) rotated pi/4: AABB is [-70.71,70.71] x [0,141.42], but
// the quad itself has NO area near its AABB's bottom-left corner
// (approx x in [-70.71,0], y in [100,141.42]) -- that corner of the AABB is
// empty (the actual diamond corners there are (0,141.42) and (-70.71,70.71),
// the diamond edge cuts across, leaving the extreme corner outside the shape).
const rotDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [geo('shape:diamond', 'page:p', 0, 0, Math.PI / 4, 100, 100)],
  bindings: [],
})
const rotIndex = buildSpatialIndex(rotDoc)
// A small marquee sitting in the AABB's empty bottom-left corner: touches the
// AABB (so a naive AABB-vs-AABB 'intersect' would wrongly select it) but
// misses the actual diamond.
const emptyCornerMarquee = { minX: -70, minY: 130, maxX: -60, maxY: 140 }
assert.deepEqual(
  queryMarquee(rotIndex, rotDoc, emptyCornerMarquee, 'intersect'),
  [],
  'intersect mode is quad-accurate: a marquee in the AABB corner but outside the true diamond selects nothing',
)
// A marquee actually overlapping the diamond (near its bottom tip, (0,141.42)) DOES select it.
const trueHitMarquee = { minX: -5, minY: 135, maxX: 5, maxY: 145 }
assert.deepEqual(
  queryMarquee(rotIndex, rotDoc, trueHitMarquee, 'intersect'),
  ['shape:diamond'],
  'intersect mode selects when the marquee actually touches the rotated quad',
)

// hitTestTopmost: document order = tree order; later/deeper wins; children over ancestors.
const zDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    geo('shape:back', 'page:p', 0, 0, 0, 100, 100),   // earlier in array, root
    geo('shape:front', 'page:p', 0, 0, 0, 100, 100),  // later in array, root, same bounds -- wins by array order
    geo('shape:child', 'shape:back', 10, 10, 0, 20, 20), // nested INSIDE shape:back, EARLIER in array than shape:front -- children over ancestors: must still win over shape:back specifically, but must lose to shape:front by array order (unrelated shapes)
  ],
  bindings: [],
})
const zIndex = buildSpatialIndex(zDoc)
// Point only inside shape:back and shape:front (not the small child): later array wins.
assert.equal(hitTestTopmost(zIndex, zDoc, { x: 90, y: 90 }), 'shape:front', 'unrelated overlapping shapes: last in doc.shapes wins')
// Point inside shape:back AND its child shape:child (nested, child drawn on top): child wins over its ancestor
// regardless of array position (shape:child is EARLIER in the array than shape:front, which does not overlap this point).
assert.equal(hitTestTopmost(zIndex, zDoc, { x: 15, y: 15 }), 'shape:child', 'children win over their ancestor regardless of array order')
// A point with no shapes: null.
assert.equal(hitTestTopmost(zIndex, zDoc, { x: 99999, y: 99999 }), null, 'no hits: null')

// ---- property test (seeded, ~1000 cases) ----
// mulberry32 copied verbatim from canvas-sync/src/rig/prng.ts: canvas-model
// cannot import canvas-sync (dependency direction — canvas-model is the pure
// foundation canvas-sync builds on, not the reverse).
type Rng = () => number
function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function int(rng: Rng, n: number): number { return Math.floor(rng() * n) }
function pick<T>(rng: Rng, arr: readonly T[]): T { return arr[int(rng, arr.length)] as T }
// Independent trig reference (see hit-test.test.ts) -- not the implementation's.
function rotate(x: number, y: number, theta: number) {
  const c = Math.cos(theta), s = Math.sin(theta)
  return { x: x * c - y * s, y: x * s + y * c }
}

// Random doc: 1..8 'geo' shapes, each parented to the page or (50/50) to a
// PRIOR shape id -- prior-only parenting makes the tree acyclic by
// construction, so this generator never needs cycle handling itself (that's
// separately covered by hit-test.test.ts's dedicated cycle case).
function buildRandomDoc(rng: Rng): CanvasDocument {
  const shapeCount = 1 + int(rng, 8)
  const shapes: any[] = []
  const ids: string[] = []
  for (let i = 0; i < shapeCount; i++) {
    const id = `shape:s${i}`
    const parentId = i > 0 && rng() < 0.5 ? pick(rng, ids) : 'page:p'
    const w = 10 + rng() * 190
    const h = 10 + rng() * 190
    const x = (rng() - 0.5) * 1000
    const y = (rng() - 0.5) * 1000
    const rotation = rng() * Math.PI * 2
    shapes.push(geo(id, parentId, x, y, rotation, w, h))
    ids.push(id)
  }
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings: [] })
}

// A point guaranteed to lie inside `shape`'s true (rotated) quad: pick a
// fractional point strictly inside its local box and map it to world using
// the PUBLIC worldTransform/localBounds plus the independent `rotate` above
// (not the implementation's own rotate helper).
function guaranteedInteriorPoint(doc: CanvasDocument, shape: ReturnType<typeof geo>, fx: number, fy: number) {
  const t = worldTransform(doc, shape)
  const lb = localBounds(shape)
  const lx = lb.minX + fx * (lb.maxX - lb.minX)
  const ly = lb.minY + fy * (lb.maxY - lb.minY)
  const r = rotate(lx, ly, t.rotation)
  return { x: r.x + t.x, y: r.y + t.y }
}

function runTrial(seed: number): void {
  const rng = mulberry32(seed)
  const doc = buildRandomDoc(rng)
  const index = buildSpatialIndex(doc)

  // (c) queryViewport over a huge viewport returns every shape.
  const huge = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }
  assert.deepEqual(
    new Set(queryViewport(index, huge)),
    new Set(doc.shapes.map((s) => s.id)),
    'huge viewport must return every shape',
  )

  // (b) every shape returned by queryMarquee(contain) has worldBounds inside the marquee.
  const cx = (rng() - 0.5) * 1200, cy = (rng() - 0.5) * 1200
  const halfW = 20 + rng() * 400, halfH = 20 + rng() * 400
  const marquee = { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH }
  for (const id of queryMarquee(index, doc, marquee, 'contain')) {
    const b = worldBounds(doc, doc.byId.get(id)!)
    assert.ok(
      b.minX >= marquee.minX && b.maxX <= marquee.maxX && b.minY >= marquee.minY && b.maxY <= marquee.maxY,
      `contain-mode result ${id} must have worldBounds inside the marquee`,
    )
  }

  // (a)+(d) hitTestTopmost, on a random point: when non-null, the result
  // must satisfy hitTestPoint; when there ARE true hits, the result must be
  // non-null (i.e. it's actually found, "unless a higher-z shape also
  // contains it" -- which is exactly what makes it the returned one).
  const px = (rng() - 0.5) * 1600, py = (rng() - 0.5) * 1600
  const point = { x: px, y: py }
  const trueHits = doc.shapes.filter((s) => hitTestPoint(doc, s, point))
  const topmost = hitTestTopmost(index, doc, point)
  if (topmost !== null) {
    assert.ok(hitTestPoint(doc, doc.byId.get(topmost)!, point), `hitTestTopmost(${topmost}) must satisfy hitTestPoint`)
  }
  assert.equal(topmost !== null, trueHits.length > 0, 'hitTestTopmost is non-null iff some shape truly contains the point')

  // (d), reinforced: a point deliberately placed inside a specific shape's
  // true quad is always found by hitTestTopmost (some shape wins -- it may
  // not be THIS shape if a higher-z shape also contains the point, but null
  // is never acceptable here).
  const target = pick(rng, doc.shapes)
  const interior = guaranteedInteriorPoint(doc, target, 0.1 + rng() * 0.8, 0.1 + rng() * 0.8)
  const guaranteedTopmost = hitTestTopmost(index, doc, interior)
  assert.notEqual(guaranteedTopmost, null, 'a point inside a known shape\'s true quad must never yield null')
  assert.ok(hitTestPoint(doc, doc.byId.get(guaranteedTopmost!)!, interior), 'the guaranteed-hit result must itself satisfy hitTestPoint')
}

const TRIALS = Number(process.env.EW_RIG_SEEDS) || 1000
for (let seed = 1; seed <= TRIALS; seed++) {
  try {
    runTrial(seed)
  } catch (err) {
    throw new Error(`spatial-index property test FAILED at seed=${seed} (replay with runTrial(${seed})): ${(err as Error).message}`)
  }
}

console.log(`ok: spatial-index (${TRIALS} property-test seeds)`)
