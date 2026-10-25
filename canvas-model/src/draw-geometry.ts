// Pure, deterministic freehand-ink geometry: a clean-room reimplementation of
// the outline-generation algorithm used by variable-width pen tools (raw
// input points with pressure -> a smoothed centerline -> a pressure-tapered
// outline polygon -> an SVG path). This package is clean-room and never
// imports the tldraw org's packages; the algorithm's SHAPE (three staged
// functions: streamline -> outline -> path) was read from a public reference
// implementation of the same well-known technique to get the math right, but
// every line below is written fresh against that shape, not copied.
//
// PURITY (load-bearing — canvas-model has no boundary-scan test, so this is
// enforced by construction, not tooling): no DOM, no wall clock, no PRNG, no
// I/O. Every function here is a total, deterministic function of its inputs
// — same points + same options ALWAYS produce byte-identical output. This
// matters twice: (1) canvas-sync replays intents across peers and expects
// convergence, so any hidden entropy here would desync strokes; (2) a NaN
// anywhere in the outline/path silently breaks SVG rendering. Both are
// guarded explicitly in draw-geometry.test.ts's property tests.

import type { Point } from './geometry.js'

// ============================================================================
// Types (Task G1)
// ============================================================================

/** A raw input sample: world x/y plus optional pressure (z, 0..1; v1 VecModel shape). */
export interface DrawInputPoint {
  readonly x: number
  readonly y: number
  readonly z?: number
}

/** Options controlling the outline algorithm — see strokeOptionsForSize (G3) for our own mapping. */
export interface StrokeOptions {
  readonly size: number
  readonly thinning: number
  readonly smoothing: number
  readonly streamline: number
  readonly simulatePressure: boolean
  readonly capStart: boolean
  readonly capEnd: boolean
  readonly taperStart: number
  readonly taperEnd: number
}

/** A streamlined/resampled point with the derived fields the outline stage needs. */
export interface StrokePoint {
  readonly point: Point
  readonly pressure: number
  /** Unit vector from this point toward the PREVIOUS point (backward-facing). */
  readonly vector: Point
  /** Distance to the previous point (0 for the first point). */
  readonly distance: number
  /** Cumulative distance travelled up to and including this point. */
  readonly runningLength: number
}

// ============================================================================
// Stage 1 — G1
// ============================================================================

interface RawPoint {
  x: number
  y: number
  pressure: number
}

export function getStrokePoints(points: readonly DrawInputPoint[], options: StrokeOptions): StrokePoint[] {
  if (points.length === 0) return []

  // 1. Map to {x,y,pressure}; z defaults to the neutral pressure 0.5 (v1
  //    simulated-pressure points and any point missing z).
  const mapped: RawPoint[] = points.map(p => ({ x: p.x, y: p.y, pressure: p.z ?? 0.5 }))

  // 2. Drop consecutive EXACT duplicates. This also collapses an
  //    all-identical-points input down to a single point, which is what
  //    routes the "two identical points" degenerate case into getStrokeOutline's
  //    single-point dot branch instead of a zero-length-vector edge case here.
  const deduped: RawPoint[] = [mapped[0]!]
  for (let i = 1; i < mapped.length; i++) {
    const prev = deduped[deduped.length - 1]!
    const cur = mapped[i]!
    if (cur.x !== prev.x || cur.y !== prev.y) deduped.push(cur)
  }

  // 3. Streamline: pull each point toward the (already-smoothed) previous
  //    point by t. streamline:0 -> t:1.0 (no smoothing); streamline:1 -> t:0.15
  //    (heavy smoothing). t is always in (0,1], so this never fully collapses
  //    a point onto its predecessor unless streamline saturates numerically.
  const t = 0.15 + (1 - options.streamline) * 0.85
  const smoothed: RawPoint[] = [deduped[0]!]
  for (let i = 1; i < deduped.length; i++) {
    const prev = smoothed[i - 1]!
    const cur = deduped[i]!
    smoothed.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t, pressure: cur.pressure })
  }

  // 4. Derive vector (unit, pointing from this point BACK toward the previous
  //    point — perfect-freehand's convention), distance, and cumulative
  //    runningLength. Guard the divide-by-zero when two smoothed points
  //    coincide (distance 0): emit the zero vector rather than NaN.
  const n = smoothed.length
  const distances: number[] = new Array(n).fill(0)
  const vectors: Point[] = new Array(n)
  const runningLengths: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const cur = smoothed[i]!
    const prev = smoothed[i - 1]!
    const dx = prev.x - cur.x
    const dy = prev.y - cur.y
    const dist = Math.hypot(dx, dy)
    distances[i] = dist
    vectors[i] = dist === 0 ? { x: 0, y: 0 } : { x: dx / dist, y: dy / dist }
    runningLengths[i] = runningLengths[i - 1]! + dist
  }
  // The first point has no "previous" of its own; perfect-freehand duplicates
  // the second point's vector onto it (or {1,0} when there is no second point).
  vectors[0] = n > 1 ? vectors[1]! : { x: 1, y: 0 }

  return smoothed.map((p, i) => ({
    point: { x: p.x, y: p.y },
    pressure: p.pressure,
    vector: vectors[i]!,
    distance: distances[i]!,
    runningLength: runningLengths[i]!,
  }))
}

// ============================================================================
// Stage 2 — G2
// ============================================================================

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Radius for a single point's pressure. Linear easing (perfect-freehand's
 * default easing is effectively linear here) — deterministic, no lookup
 * table needed. thinning:0 disables pressure entirely (constant width). */
function radiusForPressure(pressure: number, options: StrokeOptions): number {
  if (options.thinning === 0) return options.size / 2
  const p = clamp(pressure, 0, 1)
  const eased = 0.5 - options.thinning * (0.5 - p)
  return (options.size / 2) * clamp(eased, 0.01, 1)
}

/** Derive per-point pressure from local speed when the device gave none
 * (mouse): a running blend of the instantaneous "distance covered per point,
 * relative to size" against the previous simulated pressure — approximates
 * perfect-freehand's velocity-based simulation without needing a reference
 * to diff against (this is a "parity in behavior" reconstruction, not a
 * byte-identical port — see the plan's judgment call). Pure function of the
 * (already-deterministic) StrokePoint array; no entropy. */
function simulatedPressures(strokePoints: readonly StrokePoint[], size: number): number[] {
  const pressures: number[] = new Array(strokePoints.length)
  let prev = 0.5
  const denom = size > 0 ? size : 1
  for (let i = 0; i < strokePoints.length; i++) {
    const instantaneous = clamp(strokePoints[i]!.distance / denom, 0, 1)
    const blended = prev + (instantaneous - prev) * 0.2
    pressures[i] = blended
    prev = blended
  }
  return pressures
}

/** `steps` interior points along the semicircular arc from `center +
 * radius*basisA` to `center - radius*basisA`, bulging out through `basisB`
 * (both unit-length and orthogonal — callers pass `perp`/`forward` or
 * `-perp`/`backward` pairs). Used for the round start/end caps. */
function capArc(center: Point, radius: number, basisA: Point, basisB: Point, steps: number): Point[] {
  const out: Point[] = []
  for (let k = 1; k <= steps; k++) {
    const theta = (Math.PI * k) / (steps + 1)
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    out.push({ x: center.x + radius * (cos * basisA.x + sin * basisB.x), y: center.y + radius * (cos * basisA.y + sin * basisB.y) })
  }
  return out
}

const CAP_STEPS = 8
const DOT_STEPS = 16

export function getStrokeOutline(strokePoints: readonly StrokePoint[], options: StrokeOptions): Point[] {
  const n = strokePoints.length
  if (n === 0) return []

  const radius0 = radiusForPressure(strokePoints[0]!.pressure, options)

  if (n === 1) {
    // A single point only gets width from its caps (there is no ribbon to
    // draw a dot from) — with both caps off there is nothing to ink, so
    // collapse to the bare point (finite, still a valid degenerate path).
    const center = strokePoints[0]!.point
    if (!options.capStart && !options.capEnd) return [center, { x: center.x, y: center.y }]
    const out: Point[] = []
    for (let k = 0; k <= DOT_STEPS; k++) {
      const theta = (2 * Math.PI * k) / DOT_STEPS
      out.push({ x: center.x + radius0 * Math.cos(theta), y: center.y + radius0 * Math.sin(theta) })
    }
    return out
  }

  const pressures = options.simulatePressure
    ? simulatedPressures(strokePoints, options.size)
    : strokePoints.map(sp => sp.pressure)

  const totalLength = strokePoints[n - 1]!.runningLength
  const radii = strokePoints.map((sp, i) => {
    let r = radiusForPressure(pressures[i]!, options)
    if (options.taperStart > 0) r *= clamp(sp.runningLength / options.taperStart, 0, 1)
    if (options.taperEnd > 0) r *= clamp((totalLength - sp.runningLength) / options.taperEnd, 0, 1)
    return r
  })

  const left: Point[] = []
  const right: Point[] = []
  for (let i = 0; i < n; i++) {
    const sp = strokePoints[i]!
    const v = sp.vector
    const perp: Point = { x: -v.y, y: v.x } // rotate `vector` 90deg -> perpendicular to the stroke direction
    const r = radii[i]!
    left.push({ x: sp.point.x + perp.x * r, y: sp.point.y + perp.y * r })
    right.push({ x: sp.point.x - perp.x * r, y: sp.point.y - perp.y * r })
  }

  const outline: Point[] = [...left]

  if (options.capEnd) {
    const last = strokePoints[n - 1]!
    const v = last.vector
    const perp: Point = { x: -v.y, y: v.x }
    const forward: Point = { x: -v.x, y: -v.y } // travel direction is opposite `vector` (which points backward)
    // Sweep from left[n-1] (basisA=perp) through the forward direction (basisB=forward) to right[n-1].
    outline.push(...capArc(last.point, radii[n - 1]!, perp, forward, CAP_STEPS))
  }

  outline.push(...[...right].reverse())

  if (options.capStart) {
    const first = strokePoints[0]!
    const v = first.vector
    const perp: Point = { x: -v.y, y: v.x }
    const backward: Point = { x: v.x, y: v.y } // behind the stroke's start is `vector`'s own direction
    // Sweep from right[0] (basisA=-perp) through the backward direction (basisB=backward) to left[0].
    outline.push(...capArc(first.point, radii[0]!, { x: -perp.x, y: -perp.y }, backward, CAP_STEPS))
  }

  // Explicitly close the polygon back onto its own start.
  outline.push({ x: left[0]!.x, y: left[0]!.y })

  return outline
}

// ============================================================================
// Stage 3 — G3
// ============================================================================

export function getSvgPathFromOutline(outline: readonly Point[]): string {
  if (outline.length === 0) return ''
  if (outline.length === 1) {
    const p = outline[0]!
    return `M ${p.x},${p.y} Z`
  }
  // M to the first point, then walk the polygon emitting a quadratic curve
  // per edge whose control point is the current vertex and whose endpoint is
  // the midpoint to the NEXT vertex (perfect-freehand's smoothing walk) —
  // this rounds every polygon corner instead of drawing it as a hard `L`
  // segment. Wrapping `next` with modulo closes the loop back to point 0.
  const first = outline[0]!
  let d = `M ${first.x},${first.y}`
  for (let i = 1; i < outline.length; i++) {
    const cur = outline[i]!
    const next = outline[(i + 1) % outline.length]!
    const mid = { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2 }
    d += ` Q ${cur.x},${cur.y} ${mid.x},${mid.y}`
  }
  d += ' Z'
  return d
}

export function getStrokePath(points: readonly DrawInputPoint[], options: StrokeOptions): string {
  return getSvgPathFromOutline(getStrokeOutline(getStrokePoints(points, options), options))
}

// Base stroke width per our `size` style axis, tuned larger than
// GeoShape's STROKE_WIDTH_PX (a stroked border) since this is a filled ink
// body meant to read as a pen mark. Values are ours to pick (no v1 reference
// — tldraw's own DrawShapeUtil scales similarly by its size axis); documented
// here as the deliberate choice.
const SIZE_TO_BASE_PX: Record<string, number> = { s: 4, m: 8, l: 12, xl: 20 }

export function strokeOptionsForSize(size: string, isPen: boolean): StrokeOptions {
  const base = SIZE_TO_BASE_PX[size] ?? SIZE_TO_BASE_PX['m']!
  return {
    size: base,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !isPen,
    capStart: true,
    capEnd: true,
    taperStart: 0,
    taperEnd: 0,
  }
}
