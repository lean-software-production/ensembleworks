// Run: bun src/draw-geometry.test.ts
import assert from 'node:assert/strict'
import {
  getStrokePoints, getStrokeOutline, getSvgPathFromOutline, getStrokePath, strokeOptionsForSize,
  type DrawInputPoint, type StrokeOptions, type StrokePoint,
} from './draw-geometry.js'

const opts = (over: Partial<StrokeOptions> = {}): StrokeOptions => ({
  size: 8, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false,
  capStart: true, capEnd: true, taperStart: 0, taperEnd: 0, ...over,
})

const hypot = (v: { x: number; y: number }) => Math.hypot(v.x, v.y)
const finite = (n: number) => Number.isFinite(n)
const allFinite = (pts: readonly { x: number; y: number }[]) => pts.every(p => finite(p.x) && finite(p.y))

// ============================================================================
// G1 — getStrokePoints
// ============================================================================

// Empty input -> empty output.
assert.deepEqual(getStrokePoints([], opts()), [])

// Three collinear points: runningLength strictly increases; vectors are unit
// length except the degenerate zero-distance case (none here — all distinct).
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]
  const sp = getStrokePoints(pts, opts({ streamline: 0 })) // streamline:0 -> t=1.0, no smoothing, exact spacing
  assert.equal(sp.length, 3, 'no dedupe expected for distinct collinear points')
  for (let i = 1; i < sp.length; i++) {
    assert.ok(sp[i].runningLength > sp[i - 1].runningLength, `runningLength must strictly increase at ${i}`)
  }
  for (const p of sp) {
    if (p.distance > 0) assert.ok(Math.abs(hypot(p.vector) - 1) < 1e-9, 'non-degenerate vector must be unit length')
  }
}

// A point immediately repeated is deduped (output shorter than input).
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }]
  const sp = getStrokePoints(pts, opts())
  assert.ok(sp.length < pts.length, 'consecutive exact duplicate must be dropped')
}

// Streamline pulls an interior point toward its predecessor: the smoothed
// point must land strictly closer to the (smoothed) previous point than the
// raw point was.
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const sp = getStrokePoints(pts, opts({ streamline: 0.8 })) // t = 0.15 + 0.2*0.85 = 0.32, strong pull
  const rawDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  const smoothedDist = Math.hypot(sp[1].point.x - sp[0].point.x, sp[1].point.y - sp[0].point.y)
  assert.ok(smoothedDist < rawDist, 'streamlined point must be pulled closer to prev than the raw point was')
}

// Determinism: two calls with identical input are deep-equal.
{
  const pts: DrawInputPoint[] = [{ x: 1, y: 2, z: 0.4 }, { x: 5, y: 9, z: 0.9 }, { x: 12, y: 3 }]
  const a = getStrokePoints(pts, opts())
  const b = getStrokePoints(pts, opts())
  assert.deepEqual(a, b, 'getStrokePoints must be deterministic')
}

// Single input point -> one StrokePoint, vector {1,0}, distance 0, runningLength 0.
{
  const sp = getStrokePoints([{ x: 5, y: 5 }], opts())
  assert.equal(sp.length, 1)
  assert.deepEqual(sp[0].vector, { x: 1, y: 0 })
  assert.equal(sp[0].distance, 0)
  assert.equal(sp[0].runningLength, 0)
}

console.log('G1 getStrokePoints: OK')

// ============================================================================
// G2 — getStrokeOutline
// ============================================================================

const bbox = (pts: readonly { x: number; y: number }[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  return { minX, minY, maxX, maxY }
}
const localWidthNear = (outline: readonly { x: number; y: number }[], x: number, tolerance: number) => {
  const near = outline.filter(p => Math.abs(p.x - x) < tolerance)
  let max = 0
  for (const a of near) for (const b of near) max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y))
  return max
}

// Pressure widens the stroke — THE parity assertion. Two 3-point strokes,
// identical except the middle point's pressure (z): 0.2 vs 0.9. With
// thinning:0.5 and simulatePressure:false (so the stored z is used verbatim,
// not overridden by velocity simulation), the high-pressure stroke's local
// outline width near the middle point must be strictly wider.
{
  const lowP: DrawInputPoint[] = [{ x: 0, y: 0, z: 0.5 }, { x: 50, y: 0, z: 0.2 }, { x: 100, y: 0, z: 0.5 }]
  const hiP: DrawInputPoint[] = [{ x: 0, y: 0, z: 0.5 }, { x: 50, y: 0, z: 0.9 }, { x: 100, y: 0, z: 0.5 }]
  const o = opts({ thinning: 0.5, simulatePressure: false, streamline: 0 })
  const lowOutline = getStrokeOutline(getStrokePoints(lowP, o), o)
  const hiOutline = getStrokeOutline(getStrokePoints(hiP, o), o)
  const lowWidth = localWidthNear(lowOutline, 50, 5)
  const hiWidth = localWidthNear(hiOutline, 50, 5)
  assert.ok(hiWidth > lowWidth, `higher pressure must widen the local outline (low=${lowWidth}, hi=${hiWidth})`)
}

// Offset is PERPENDICULAR to the stroke direction, not along it. For a
// straight HORIZONTAL stroke, the local width must show up as Y-spread near
// the middle (away from the end caps) — an "offset along vector instead of
// its perpendicular" mutant would shift points along X only, leaving Y ~= 0
// at the middle even though bbox/closed-loop assertions elsewhere stay
// green (the end caps alone still bulge correctly, since they recompute
// their own perpendicular locally). This test isolates exactly that gap.
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 50, y: 0 }, { x: 75, y: 0 }, { x: 100, y: 0 }]
  const o = opts({ size: 10, thinning: 0, streamline: 0 })
  const outline = getStrokeOutline(getStrokePoints(pts, o), o)
  const nearMiddle = outline.filter(p => Math.abs(p.x - 50) < 8)
  const ys = nearMiddle.map(p => p.y)
  const ySpread = Math.max(...ys) - Math.min(...ys)
  assert.ok(ySpread > o.size * 0.5, `expected perpendicular (Y) width near the middle of a horizontal stroke to be >= ~size/2, got ySpread=${ySpread}`)
}

// No caps on a MULTI-point stroke: the end cap is what lets the outline
// bulge PAST the last centerline point in the direction of travel (a round
// cap). Without it, the outline's forward-most extent is bounded by the
// last point itself (offsets are purely perpendicular, adding no forward
// reach) — so removing the capEnd arc must shrink the outline's max X for a
// rightward horizontal stroke.
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]
  const capped = opts({ size: 10, thinning: 0, streamline: 0, capStart: true, capEnd: true })
  const uncapped = opts({ size: 10, thinning: 0, streamline: 0, capStart: false, capEnd: false })
  const cappedOutline = getStrokeOutline(getStrokePoints(pts, capped), capped)
  const uncappedOutline = getStrokeOutline(getStrokePoints(pts, uncapped), uncapped)
  const maxX = (o: readonly { x: number }[]) => Math.max(...o.map(p => p.x))
  assert.ok(maxX(cappedOutline) > maxX(uncappedOutline) + 1, `capped end must bulge forward past the last point (capped maxX=${maxX(cappedOutline)}, uncapped maxX=${maxX(uncappedOutline)})`)
  assert.ok(allFinite(cappedOutline) && allFinite(uncappedOutline), 'both capped and uncapped outlines must be finite')
}

// No caps (capStart:false, capEnd:false) on a single point collapses to a
// degenerate (near-zero-area) result, not a real dot — proves caps are what
// actually produce the dot's roundness, not some cap-independent fallback.
{
  const o = opts({ size: 10, capStart: false, capEnd: false })
  const outline = getStrokeOutline(getStrokePoints([{ x: 3, y: 3 }], o), o)
  assert.ok(allFinite(outline), 'no-caps single point must still be finite')
  let maxPairwise = 0
  for (const a of outline) for (const b of outline) maxPairwise = Math.max(maxPairwise, Math.hypot(a.x - b.x, a.y - b.y))
  assert.ok(maxPairwise < o.size * 0.1, `with no caps, a single point must NOT render a full dot (got diameter ${maxPairwise}, size=${o.size})`)
}

// Closed & non-degenerate: a real multi-point stroke yields >= 6 outline
// points, and the polygon closes (first ~= last).
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }, { x: 60, y: 10 }]
  const o = opts()
  const outline = getStrokeOutline(getStrokePoints(pts, o), o)
  assert.ok(outline.length >= 6, `expected a closed polygon with >= 6 points, got ${outline.length}`)
  const first = outline[0]!, last = outline[outline.length - 1]!
  assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-6, 'outline must close (first ~= last)')
}

// Bbox contains inputs (inflated by size/2). streamline:0 isolates the
// property under test (the radius offset covers the drawn path) from the
// orthogonal streamline-smoothing behavior (which, by design, pulls points
// toward each other and is proven separately by G1's own streamline test —
// heavy smoothing across a few widely-spaced points can legitimately move
// the *centerline* further than size/2 from the raw input).
{
  const pts: DrawInputPoint[] = [{ x: 10, y: 10 }, { x: 30, y: 40 }, { x: 5, y: 60 }]
  const o = opts({ size: 8, streamline: 0 })
  const outline = getStrokeOutline(getStrokePoints(pts, o), o)
  const b = bbox(outline)
  const pad = o.size / 2 + 1e-6
  for (const p of pts) {
    assert.ok(p.x >= b.minX - pad && p.x <= b.maxX + pad, `x out of inflated bbox: ${p.x} not in [${b.minX - pad},${b.maxX + pad}]`)
    assert.ok(p.y >= b.minY - pad && p.y <= b.maxY + pad, `y out of inflated bbox: ${p.y} not in [${b.minY - pad},${b.maxY + pad}]`)
  }
}

// Single point -> a roughly circular closed outline of radius ~= size/2
// (min/max pairwise distance ~= size). thinning:0 isolates the dot-shape
// property (closure/roundness) from pressure-radius modulation — with the
// neutral default pressure (0.5) and thinning:0.5, radius is deliberately
// LESS than size/2 (that's the pressure-widens property, proven above);
// "radius ~= size/2" per the plan holds when thinning doesn't shrink it.
{
  const o = opts({ size: 10, thinning: 0 })
  const outline = getStrokeOutline(getStrokePoints([{ x: 3, y: 3 }], o), o)
  assert.ok(outline.length >= 6, 'single-point dot must be a real polygon, not a degenerate 1-2 point shape')
  let maxPairwise = 0
  for (const a of outline) for (const b of outline) maxPairwise = Math.max(maxPairwise, Math.hypot(a.x - b.x, a.y - b.y))
  assert.ok(Math.abs(maxPairwise - o.size) < o.size * 0.25, `single-point dot diameter should be ~= size (${o.size}), got ${maxPairwise}`)
  assert.ok(allFinite(outline), 'single-point dot must be finite')
}

// No NaN/Infinity: two identical points, all-collinear points, a single point.
{
  const o = opts()
  const cases: DrawInputPoint[][] = [
    [{ x: 5, y: 5 }, { x: 5, y: 5 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }],
    [{ x: 7, y: 7 }],
  ]
  for (const pts of cases) {
    const outline = getStrokeOutline(getStrokePoints(pts, o), o)
    assert.ok(allFinite(outline), `outline must be finite for degenerate input ${JSON.stringify(pts)}`)
  }
}

console.log('G2 getStrokeOutline: OK')

// ============================================================================
// G3 — getSvgPathFromOutline + getStrokePath + strokeOptionsForSize
// ============================================================================

// getStrokePath([], opts) -> '' (no throw).
assert.equal(getStrokePath([], opts()), '')

// getStrokePath(oneStroke, opts) twice -> identical string (determinism).
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0, z: 0.3 }, { x: 20, y: 5, z: 0.8 }, { x: 40, y: 0, z: 0.5 }]
  const a = getStrokePath(pts, opts())
  const b = getStrokePath(pts, opts())
  assert.equal(a, b, 'getStrokePath must be deterministic')
}

// The returned string starts with M and contains Q for a multi-point stroke.
{
  const pts: DrawInputPoint[] = [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }, { x: 60, y: 10 }]
  const d = getStrokePath(pts, opts())
  assert.ok(d.startsWith('M'), `expected path to start with M, got: ${d.slice(0, 20)}`)
  assert.ok(d.includes('Q'), 'expected quadratic-curve segments (Q) for a multi-point stroke')
}

// getSvgPathFromOutline([]) -> '' directly (not just through getStrokePath).
assert.equal(getSvgPathFromOutline([]), '')

// strokeOptionsForSize: simulatePressure flips with isPen; unknown size falls back to 'm'.
{
  assert.equal(strokeOptionsForSize('l', false).simulatePressure, true, 'mouse (isPen:false) simulates pressure')
  assert.equal(strokeOptionsForSize('l', true).simulatePressure, false, 'a real pen never simulates pressure')
  assert.equal(strokeOptionsForSize('bogus', false).size, strokeOptionsForSize('m', false).size, 'unknown size falls back to the m base')
}

// strokeOptionsForSize: s < m < l < xl base width (mutant: constant width caught here).
{
  const sizes = ['s', 'm', 'l', 'xl'].map(s => strokeOptionsForSize(s, false).size)
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i]! > sizes[i - 1]!, `size must strictly increase: ${sizes}`)
}

console.log('G3 getSvgPathFromOutline/getStrokePath/strokeOptionsForSize: OK')

// ============================================================================
// Cross-cutting: determinism + no-NaN across ALL degenerate inputs, at the
// getStrokePath level (the full pipeline end users actually call).
// ============================================================================

const degenerateCases: { name: string; points: DrawInputPoint[] }[] = [
  { name: 'empty', points: [] },
  { name: 'single point', points: [{ x: 4, y: 4 }] },
  { name: 'two coincident points', points: [{ x: 4, y: 4 }, { x: 4, y: 4 }] },
  { name: 'two distinct points', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
  { name: 'many collinear points', points: [0, 1, 2, 3, 4, 5].map(i => ({ x: i * 10, y: 0 })) },
  { name: 'all points identical (5x)', points: [1, 2, 3, 4, 5].map(() => ({ x: 9, y: 9 })) },
]

for (const { name, points } of degenerateCases) {
  const path = getStrokePath(points, opts())
  assert.ok(typeof path === 'string', `${name}: must return a string`)
  assert.ok(!path.includes('NaN'), `${name}: path must not contain NaN, got: ${path}`)
  assert.ok(!path.includes('Infinity'), `${name}: path must not contain Infinity, got: ${path}`)
  const a = getStrokePath(points, opts())
  const b = getStrokePath(points, opts())
  assert.equal(a, b, `${name}: must be deterministic`)

  // Also check the intermediate stages directly for finite numbers (not just
  // "the string doesn't say NaN" — NaN.toString() is genuinely "NaN" so the
  // string check above IS a real check, but this doubles it structurally).
  const sp = getStrokePoints(points, opts())
  for (const p of sp) {
    assert.ok(finite(p.point.x) && finite(p.point.y) && finite(p.pressure) && finite(p.distance) && finite(p.runningLength), `${name}: StrokePoint must be finite`)
    assert.ok(finite(p.vector.x) && finite(p.vector.y), `${name}: vector must be finite`)
  }
  const outline = getStrokeOutline(sp, opts())
  assert.ok(allFinite(outline), `${name}: outline must be finite`)
}

console.log('degenerate-input determinism + no-NaN sweep: OK')
