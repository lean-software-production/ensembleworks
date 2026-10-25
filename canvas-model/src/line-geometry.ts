// Pure, deterministic geometry for the `line` shape (Task G1, 2026-07-22 line
// sub-cycle): turns an ORDERED array of handle points + a spline mode into an
// SVG path `d` string. Sits with the other pure geometry modules
// (geometry.ts, arrow-route.ts, draw-geometry.ts) — canvas-model imports
// nothing but zod and its own types.
//
// PURITY (load-bearing — canvas-model has no boundary-scan test, so this is
// enforced by construction, not tooling): no DOM, no wall clock, no PRNG, no
// I/O. `linePathData` is a total, deterministic function of its point/spline
// inputs — same points + same spline ALWAYS produce byte-identical output.
//
// ORDERING NOTE: this function takes an already-ordered `{x,y}[]` — it has no
// notion of a keyed map, `id`, or `index` at all, and performs no reordering
// of its own. Flattening the line shape's KEYED-MAP `props.points` into this
// ordered array (`Object.values` sorted by the handle's `index`, NOT map
// insertion/key order) is `flattenLinePoints`, a canvas-react concern (Task
// R1, out of this task's scope — see the plan's D-2/D-3 split).
import type { Point } from './geometry.js'

/** Build an SVG path `d` string through `points`, in the given order.
 *  `spline: 'line'`  -> a straight polyline: `M x0 y0 L x1 y1 L x2 y2 …` (open, no `Z`).
 *  `spline: 'cubic'` -> a smooth curve THROUGH every point via Catmull-Rom ->
 *  cubic-bezier conversion (see cubicPathData below).
 *  Fewer than 2 points -> `''` (a single handle has no visible segment).
 *  Never throws; every emitted coordinate is a finite number (no NaN/Infinity),
 *  even for coincident/collinear inputs. */
export function linePathData(points: readonly Point[], spline: 'line' | 'cubic'): string {
  if (points.length < 2) return ''
  return spline === 'cubic' ? cubicPathData(points) : straightPathData(points)
}

function straightPathData(points: readonly Point[]): string {
  const first = points[0]!
  let d = `M ${first.x} ${first.y}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    d += ` L ${p.x} ${p.y}`
  }
  return d
}

// Catmull-Rom -> cubic-bezier: for each segment p[i]->p[i+1], the control
// points reach toward the segment's NEIGHBORS (p[i-1] and p[i+2]) so the
// curve bends smoothly through every interior point, not just its two
// endpoints. Endpoints are duplicated (p[-1]=p[0], p[n]=p[n-1]) so the first
// and last real handles get a well-defined tangent instead of an
// out-of-bounds neighbor, and so the curve still passes exactly through the
// first and last point. Every control point is built from PLAIN
// addition/subtraction of existing finite coordinates -- no division by a
// distance or any other quantity that could be zero, so coincident or
// collinear points can never produce NaN/Infinity.
function cubicPathData(points: readonly Point[]): string {
  const n = points.length
  const at = (i: number): Point => points[Math.max(0, Math.min(n - 1, i))]!

  const first = points[0]!
  let d = `M ${first.x} ${first.y}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${p2.x} ${p2.y}`
  }
  return d
}
