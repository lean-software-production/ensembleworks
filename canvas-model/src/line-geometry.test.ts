// Run: bun src/line-geometry.test.ts
import assert from 'node:assert/strict'
import { linePathData } from './line-geometry.js'
import type { Point } from './geometry.js'

const finite = (n: number) => Number.isFinite(n)

// Extract every numeric token in an SVG path `d` string (works for both `M x y`
// and `M x,y` separators, which this implementation does not use but a wrong
// one might).
function numbersIn(d: string): number[] {
  const matches = d.match(/-?\d+(\.\d+)?(e-?\d+)?/gi) ?? []
  return matches.map(Number)
}

// ============================================================================
// Degenerate inputs — never throw, empty for < 2 points
// ============================================================================

assert.equal(linePathData([], 'line'), '', 'zero points -> empty path (straight)')
assert.equal(linePathData([], 'cubic'), '', 'zero points -> empty path (cubic)')
assert.equal(linePathData([{ x: 1, y: 2 }], 'line'), '', 'one point -> empty path (straight)')
assert.equal(linePathData([{ x: 1, y: 2 }], 'cubic'), '', 'one point -> empty path (cubic)')

// ============================================================================
// Straight (`spline: 'line'`) — a polyline, M...L...L..., no C
// ============================================================================

{
  const pts: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  const d = linePathData(pts, 'line')
  assert.ok(d.startsWith('M'), 'straight path starts with M')
  assert.ok(d.includes('L'), 'straight path contains L segments')
  assert.ok(!d.includes('C'), 'straight path contains no C (no curve command)')
}

// ============================================================================
// Cubic (`spline: 'cubic'`) — a smooth curve, M...C..., contains C (the key
// straight-vs-cubic discriminator)
// ============================================================================

{
  const pts: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  const d = linePathData(pts, 'cubic')
  assert.ok(d.startsWith('M'), 'cubic path starts with M')
  assert.ok(d.includes('C'), 'cubic path contains C (smooth-curve marker)')
}

// Cubic path must actually DIFFER from the straight path for the same points
// (a mutant that ignores `spline` and always emits the straight polyline, or
// that emits `L` segments for cubic too, must be caught here).
{
  const pts: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }]
  const straight = linePathData(pts, 'line')
  const cubic = linePathData(pts, 'cubic')
  assert.notEqual(cubic, straight, 'cubic path must differ from the straight path for the same non-collinear points')
}

// STRUCTURAL command-count check — count actual SVG command LETTERS (space-
// separated single-uppercase-letter tokens), not just substring presence.
// This catches a mutant that emits the real straight polyline and merely
// APPENDS a decorative bare "C" token to satisfy a naive `.includes('C')`
// check without emitting any real curve segments (found escaping on the
// first pass of this exact test — see the mutant table).
function commandCounts(d: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const tok of d.split(' ')) if (/^[A-Z]$/.test(tok)) counts[tok] = (counts[tok] ?? 0) + 1
  return counts
}

{
  const pts: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 }]
  const straightCounts = commandCounts(linePathData(pts, 'line'))
  assert.equal(straightCounts['L'], pts.length - 1, 'straight path emits exactly one L command per segment')
  assert.equal(straightCounts['C'] ?? 0, 0, 'straight path emits no C commands at all')

  const cubicCounts = commandCounts(linePathData(pts, 'cubic'))
  assert.equal(cubicCounts['C'], pts.length - 1, 'cubic path emits exactly one C command per segment (not zero, not a decorative extra)')
  assert.equal(cubicCounts['L'] ?? 0, 0, 'cubic path emits no L commands at all')
}

// ============================================================================
// Endpoints-through — both splines pass THROUGH the first and last handle
// ============================================================================

for (const spline of ['line', 'cubic'] as const) {
  const pts: Point[] = [{ x: 3, y: 7 }, { x: 40, y: -12 }, { x: 100, y: 50 }]
  const d = linePathData(pts, spline)
  const nums = numbersIn(d)
  assert.equal(nums[0], pts[0].x, `${spline}: first coordinate is the first point's x`)
  assert.equal(nums[1], pts[0].y, `${spline}: second coordinate is the first point's y`)
  assert.equal(nums[nums.length - 2], pts[pts.length - 1].x, `${spline}: second-to-last coordinate is the last point's x`)
  assert.equal(nums[nums.length - 1], pts[pts.length - 1].y, `${spline}: last coordinate is the last point's y`)
}

// ============================================================================
// Determinism — same input, same output, byte-identical
// ============================================================================

for (const spline of ['line', 'cubic'] as const) {
  const pts: Point[] = [{ x: 1, y: 2 }, { x: 5, y: 9 }, { x: 12, y: 3 }, { x: -4, y: 8 }]
  const a = linePathData(pts, spline)
  const b = linePathData(pts, spline)
  assert.equal(a, b, `${spline}: two calls with identical input produce the identical string`)
}

// ============================================================================
// No NaN / Infinity across degenerate-but-valid inputs
// ============================================================================

function assertNoNanOrInfinity(d: string, label: string) {
  assert.ok(!d.includes('NaN'), `${label}: no NaN in emitted path`)
  assert.ok(!d.includes('Infinity'), `${label}: no Infinity in emitted path`)
  for (const n of numbersIn(d)) assert.ok(finite(n), `${label}: every numeric token is finite (${n})`)
}

for (const spline of ['line', 'cubic'] as const) {
  // Two coincident points.
  assertNoNanOrInfinity(linePathData([{ x: 5, y: 5 }, { x: 5, y: 5 }], spline), `${spline} two coincident points`)
  // Three collinear points.
  assertNoNanOrInfinity(
    linePathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], spline),
    `${spline} three collinear points`,
  )
  // A bare 2-point input (cubic's endpoint-duplication path: p[-1]=p[0], p[n]=p[n-1]).
  assertNoNanOrInfinity(linePathData([{ x: 0, y: 0 }, { x: 10, y: 10 }], spline), `${spline} 2-point input`)
  // All-identical points (3x), including a run long enough to require both
  // duplicated endpoints AND an interior identical neighbor simultaneously.
  assertNoNanOrInfinity(
    linePathData([{ x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }], spline),
    `${spline} three coincident points`,
  )
}

// ============================================================================
// Order preservation — linePathData renders points in the EXACT array order
// given; it performs no internal reordering of its own. (The keyed-map ->
// ordered-array flattening, sorted by the handle's `index` with the map's
// insertion/key order explicitly NOT trusted, is Task R1's `flattenLinePoints`
// helper in canvas-react, out of this task's scope — see the plan's D-2/D-3
// split. This property test pins the complementary half: linePathData itself
// must not silently re-sort by coordinate or anything else, so R1's ordering
// guarantee is not undone one layer down.)
{
  const outOfCoordinateOrder: Point[] = [{ x: 50, y: 50 }, { x: 0, y: 0 }, { x: 100, y: 0 }]
  const d = linePathData(outOfCoordinateOrder, 'line')
  const nums = numbersIn(d)
  assert.deepEqual(
    nums,
    outOfCoordinateOrder.flatMap(p => [p.x, p.y]),
    'linePathData walks points in the given array order, not sorted by coordinate',
  )
}

console.log('ok: linePathData (G1, line sub-cycle)')
