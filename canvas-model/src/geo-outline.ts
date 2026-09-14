// Pure, deterministic outline math for every GeoShapeGeoStyle variant (the
// `geo` prop's 20-value enum — shape.ts's GEO). Clean-room: the SHAPE of
// each variant's geometry (which vertices/curves it needs, in what order)
// was read from tldraw's own reference implementation
// (node_modules/tldraw/src/lib/shapes/geo/getGeoShapePath.ts's
// `defaultGeoTypeDefinitions`) to match its proportions, but every formula
// below is written fresh, not copied — this package never imports tldraw.
//
// PURITY: no DOM, no wall clock, no PRNG (canvas-model has no boundary-scan
// test, but this package's own convention — see draw-geometry.ts's header —
// is enforced by construction: total, deterministic functions of (variant,
// w, h) only). This is also WHY the cloud variant below is a deliberate,
// documented simplification: v1's cloud bump path is seeded by
// `rng(shape.id)` (a per-shape PRNG) to "wiggle" each bump so the outline
// reads as organic rather than mechanically uniform — that entropy source
// has no place in a pure function of (w, h) alone, so this port keeps v1's
// bump-count/protrusion math but drops the wiggle, producing evenly-spaced
// bumps instead of organic ones. Same overall proportions, less texture.
//
// SHAPE OF THE OUTPUT: `vertices` is the closed straight-edge polygon for
// every "polygon snapType" variant (tldraw's own snapType axis — see
// getGeoShapePath.ts's GeoTypeDefinition — separates "polygon" outlines,
// which straight-line snapping/hit-testing can walk as vertices, from
// "blobby" ones, which can't); `path` is always present (an SVG path `d`
// string — see draw-geometry.ts's getSvgPathFromOutline for the established
// precedent of a pure function emitting SVG path syntax with no DOM
// involved) so canvas-react's renderer never needs its own duplicate
// geometry math. `internalPaths` carries the two variants (x-box,
// check-box) whose v1 path has un-filled internal strokes on top of the
// outer outline.
import type { Point } from './geometry.js'

const PI = Math.PI
const PI2 = PI * 2
const HALF_PI = PI / 2

export type GeoVariant =
  | 'cloud'
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'star'
  | 'rhombus'
  | 'rhombus-2'
  | 'oval'
  | 'trapezoid'
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-up'
  | 'arrow-down'
  | 'x-box'
  | 'check-box'
  | 'heart'

export const GEO_VARIANTS: readonly GeoVariant[] = [
  'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon',
  'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
  'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box',
  'heart',
]
const GEO_VARIANT_SET = new Set<string>(GEO_VARIANTS)

export interface GeoOutline {
  /** Closed polygon vertices, for hit-testing/snapping — present for every
   * straight-edge ("polygon" snapType) variant; `null` for the curved
   * ("blobby") variants (ellipse/oval/cloud/heart), whose outline is not a
   * straight-edge polygon. */
  readonly vertices: readonly Point[] | null
  /** The outer outline as an SVG path `d` string, always present (usable
   * even when `vertices` is null). */
  readonly path: string
  /** Un-filled internal strokes drawn on top of the outer outline (x-box's
   * diagonals, check-box's check mark) as their own path `d` strings; empty
   * for every other variant. */
  readonly internalPaths: readonly string[]
}

function polygonPath(points: readonly Point[]): string {
  if (points.length === 0) return ''
  const first = points[0]!
  const rest = points.slice(1)
  return `M ${first.x},${first.y} ${rest.map(p => `L ${p.x},${p.y}`).join(' ')} Z`
}

function polygonOutline(points: readonly Point[]): GeoOutline {
  return { vertices: points, path: polygonPath(points), internalPaths: [] }
}

/** Fresh reimplementation of the well-known "regular polygon inscribed in a
 * w×h box, first vertex at the top, then re-scaled to exactly fill w×h"
 * construction (matches tldraw's getPolygonVertices in SHAPE, not by
 * import). */
export function getPolygonVertices(width: number, height: number, sides: number): Point[] {
  const cx = width / 2
  const cy = height / 2
  const points: Point[] = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const step = PI2 / sides
  for (let i = 0; i < sides; i++) {
    const t = -HALF_PI + i * step
    const x = cx + cx * Math.cos(t)
    const y = cy + cy * Math.sin(t)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    points.push({ x, y })
  }
  const w = maxX - minX
  const h = maxY - minY
  const dx = width - w
  const dy = height - h
  if ((dx !== 0 || dy !== 0) && w > 0 && h > 0) {
    for (const p of points) {
      p.x = ((p.x - minX) / w) * width
      p.y = ((p.y - minY) / h) * height
    }
  }
  return points
}

function starVertices(w: number, h: number): Point[] {
  const sides = 5
  const step = PI2 / sides / 2
  const rightMostIndex = Math.floor(sides / 4) * 2
  const leftMostIndex = sides * 2 - rightMostIndex
  const topMostIndex = 0
  const bottomMostIndex = Math.floor(sides / 2) * 2
  const maxX = (Math.cos(-HALF_PI + rightMostIndex * step) * w) / 2
  const minX = (Math.cos(-HALF_PI + leftMostIndex * step) * w) / 2
  const minY = (Math.sin(-HALF_PI + topMostIndex * step) * h) / 2
  const maxY = (Math.sin(-HALF_PI + bottomMostIndex * step) * h) / 2
  const diffX = w - Math.abs(maxX - minX)
  const diffY = h - Math.abs(maxY - minY)
  const offsetX = w / 2 + minX - (w / 2 - maxX)
  const offsetY = h / 2 + minY - (h / 2 - maxY)
  const cx = (w - offsetX) / 2
  const cy = (h - offsetY) / 2
  const ox = (w + diffX) / 2
  const oy = (h + diffY) / 2
  const ix = ox / 2
  const iy = oy / 2
  return Array.from({ length: sides * 2 }, (_, i) => {
    const theta = -HALF_PI + i * step
    return { x: cx + (i % 2 ? ix : ox) * Math.cos(theta), y: cy + (i % 2 ? iy : oy) * Math.sin(theta) }
  })
}

function ellipsePath(w: number, h: number): string {
  const cx = w / 2
  const cy = h / 2
  return `M 0,${cy} A ${cx},${cy} 0 0,1 ${w},${cy} A ${cx},${cy} 0 0,1 0,${cy} Z`
}

/** Same "stadium/pill" construction as tldraw's getStadiumPath: a full
 * semicircle cap on the short axis at each end of the long axis. */
function stadiumPath(w: number, h: number): string {
  if (h > w) {
    const r = w / 2
    return `M 0,${r} A ${r},${r} 0 0,1 ${w},${r} L ${w},${h - r} A ${r},${r} 0 0,1 0,${h - r} Z`
  }
  const r = h / 2
  return `M ${r},${h} A ${r},${r} 0 0,1 ${r},0 L ${w - r},0 A ${r},${r} 0 0,1 ${w - r},${h} Z`
}

function heartPath(w: number, h: number): string {
  const cx = w / 2
  const o = w / 4
  const k = h / 4
  const seg = (cp1: Point, cp2: Point, end: Point) => `C ${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${end.x},${end.y}`
  return [
    `M ${cx},${h}`,
    seg({ x: o * 1.5, y: k * 3 }, { x: 0, y: k * 2.5 }, { x: 0, y: k * 1.2 }),
    seg({ x: 0, y: -k * 0.32 }, { x: o * 1.85, y: -k * 0.32 }, { x: cx, y: k * 0.9 }),
    seg({ x: o * 2.15, y: -k * 0.32 }, { x: w, y: -k * 0.32 }, { x: w, y: k * 1.2 }),
    seg({ x: cx, y: h }, { x: w, y: k * 2.5 }, { x: o * 2.5, y: k * 3 }),
    'Z',
  ].join(' ')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function xBoxInternalPaths(w: number, h: number): string[] {
  return [`M 0,0 L ${w},${h}`, `M ${w},0 L 0,${h}`]
}

function checkBoxInternalPaths(w: number, h: number): string[] {
  const size = Math.min(w, h) * 0.82
  const ox = (w - size) / 2
  const oy = (h - size) / 2
  const p1 = { x: clamp(ox + size * 0.25, 0, w), y: clamp(oy + size * 0.52, 0, h) }
  const p2 = { x: clamp(ox + size * 0.45, 0, w), y: clamp(oy + size * 0.82, 0, h) }
  const p3 = { x: clamp(ox + size * 0.82, 0, w), y: clamp(oy + size * 0.22, 0, h) }
  return [`M ${p1.x},${p1.y} L ${p2.x},${p2.y} L ${p3.x},${p3.y}`]
}

// ============================================================================
// Cloud — v1's bump-count/protrusion math (getOvalPerimeter/getPillPoints),
// wiggle dropped (see module header PURITY).
// ============================================================================

function ovalPerimeter(w: number, h: number): number {
  if (h > w) return (PI * (w / 2) + (h - w)) * 2
  return (PI * (h / 2) + (w - h)) * 2
}

interface PillSection {
  type: 'straight' | 'arc'
  start?: Point
  delta?: Point
  center?: Point
  startAngle?: number
}

function pointOnCircle(center: Point, r: number, a: number): Point {
  return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }
}

function pillPoints(width: number, height: number, numPoints: number): Point[] {
  const radius = Math.min(width, height) / 2
  const longSide = Math.max(width, height) - radius * 2
  const circumference = PI * (radius * 2) + 2 * longSide
  const spacing = circumference / numPoints

  const sections: PillSection[] =
    width > height
      ? [
          { type: 'straight', start: { x: radius, y: 0 }, delta: { x: 1, y: 0 } },
          { type: 'arc', center: { x: width - radius, y: radius }, startAngle: -HALF_PI },
          { type: 'straight', start: { x: width - radius, y: height }, delta: { x: -1, y: 0 } },
          { type: 'arc', center: { x: radius, y: radius }, startAngle: HALF_PI },
        ]
      : [
          { type: 'straight', start: { x: width, y: radius }, delta: { x: 0, y: 1 } },
          { type: 'arc', center: { x: radius, y: height - radius }, startAngle: 0 },
          { type: 'straight', start: { x: 0, y: height - radius }, delta: { x: 0, y: -1 } },
          { type: 'arc', center: { x: radius, y: radius }, startAngle: PI },
        ]

  let sectionOffset = 0
  const points: Point[] = []
  for (let i = 0; i < numPoints; i++) {
    const section = sections[0]!
    if (section.type === 'straight') {
      points.push({ x: section.start!.x + section.delta!.x * sectionOffset, y: section.start!.y + section.delta!.y * sectionOffset })
    } else {
      points.push(pointOnCircle(section.center!, radius, section.startAngle! + sectionOffset / radius))
    }
    sectionOffset += spacing
    let sectionLength = section.type === 'straight' ? longSide : PI * radius
    while (sectionOffset > sectionLength) {
      sectionOffset -= sectionLength
      sections.push(sections.shift()!)
      sectionLength = sections[0]!.type === 'straight' ? longSide : PI * radius
    }
  }
  return points
}

/** Circumcenter of three points, or `null` when (near-)collinear. */
function circumcenter(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (d === 0) return null
  const aSq = a.x * a.x + a.y * a.y
  const bSq = b.x * b.x + b.y * b.y
  const cSq = c.x * c.x + c.y * c.y
  return {
    x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
    y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

const CLOUD_BUMP_PX = 70 // v1's SIZES.m (default 'm' size style) — see module header
const CLOUD_BUMP_PROTRUSION = 0.2 // v1's BUMP_PROTRUSION

function cloudPath(w: number, h: number): string {
  const pillCircumference = ovalPerimeter(w, h)
  const numBumps = Math.max(
    Math.ceil(pillCircumference / CLOUD_BUMP_PX),
    6,
    Math.ceil(pillCircumference / Math.min(w, h)),
  )
  const targetBumpProtrusion = (pillCircumference / numBumps) * CLOUD_BUMP_PROTRUSION

  const innerWidth = Math.max(w - targetBumpProtrusion * 2, 1)
  const innerHeight = Math.max(h - targetBumpProtrusion * 2, 1)
  const innerCircumference = ovalPerimeter(innerWidth, innerHeight)
  const distanceBetweenPointsOnPerimeter = innerCircumference / numBumps

  const paddingX = (w - innerWidth) / 2
  const paddingY = (h - innerHeight) / 2
  const bumpPoints = pillPoints(innerWidth, innerHeight, numBumps).map(p => ({ x: p.x + paddingX, y: p.y + paddingY }))

  const parts: string[] = []
  for (let i = 0; i < bumpPoints.length; i++) {
    const j = i === bumpPoints.length - 1 ? 0 : i + 1
    const left = bumpPoints[i]!
    const right = bumpPoints[j]!

    const distanceBetweenPoints = dist(left, right)
    const curvatureOffset = distanceBetweenPointsOnPerimeter - distanceBetweenPoints
    const finalDistance = Math.max(paddingX, paddingY) + curvatureOffset

    const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
    const dx = right.x - left.x
    const dy = right.y - left.y
    const len = Math.hypot(dx, dy) || 1
    const perp = { x: -dy / len, y: dx / len }
    let arcX = mid.x + perp.x * finalDistance
    let arcY = mid.y + perp.y * finalDistance
    arcX = clamp(arcX, 0, w)
    arcY = clamp(arcY, 0, h)

    const center = circumcenter(left, right, { x: arcX, y: arcY })
    const radius = dist(center ?? { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, left)

    if (i === 0) parts.push(`M ${left.x},${left.y}`)
    parts.push(`A ${radius},${radius} 0 0,1 ${right.x},${right.y}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

// ============================================================================
// Public API
// ============================================================================

function offsetFor(w: number, h: number): number {
  return Math.min(w * 0.38, h * 0.38)
}

/** Compute the outline for one geo variant at a given w/h. Unknown variant
 * strings fall back to 'rectangle' (matches v1's own defaultValue). */
export function getGeoOutline(geo: string, w: number, h: number): GeoOutline {
  const variant: GeoVariant = GEO_VARIANT_SET.has(geo) ? (geo as GeoVariant) : 'rectangle'

  switch (variant) {
    case 'rectangle':
      return polygonOutline([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }])
    case 'ellipse':
      return { vertices: null, path: ellipsePath(w, h), internalPaths: [] }
    case 'triangle':
      return polygonOutline([{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }])
    case 'diamond':
      return polygonOutline([{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }])
    case 'star':
      return polygonOutline(starVertices(w, h))
    case 'pentagon':
      return polygonOutline(getPolygonVertices(w, h, 5))
    case 'hexagon':
      return polygonOutline(getPolygonVertices(w, h, 6))
    case 'octagon':
      return polygonOutline(getPolygonVertices(w, h, 8))
    case 'rhombus': {
      const offset = offsetFor(w, h)
      return polygonOutline([{ x: offset, y: 0 }, { x: w, y: 0 }, { x: w - offset, y: h }, { x: 0, y: h }])
    }
    case 'rhombus-2': {
      const offset = offsetFor(w, h)
      return polygonOutline([{ x: 0, y: 0 }, { x: w - offset, y: 0 }, { x: w, y: h }, { x: offset, y: h }])
    }
    case 'trapezoid': {
      const offset = offsetFor(w, h)
      return polygonOutline([{ x: offset, y: 0 }, { x: w - offset, y: 0 }, { x: w, y: h }, { x: 0, y: h }])
    }
    case 'oval':
      return { vertices: null, path: stadiumPath(w, h), internalPaths: [] }
    case 'arrow-left': {
      const ox = Math.min(w, h) * 0.38
      const oy = h * 0.16
      return polygonOutline([
        { x: ox, y: 0 }, { x: ox, y: oy }, { x: w, y: oy }, { x: w, y: h - oy },
        { x: ox, y: h - oy }, { x: ox, y: h }, { x: 0, y: h / 2 },
      ])
    }
    case 'arrow-up': {
      const ox = w * 0.16
      const oy = Math.min(w, h) * 0.38
      return polygonOutline([
        { x: w / 2, y: 0 }, { x: w, y: oy }, { x: w - ox, y: oy }, { x: w - ox, y: h },
        { x: ox, y: h }, { x: ox, y: oy }, { x: 0, y: oy },
      ])
    }
    case 'arrow-down': {
      const ox = w * 0.16
      const oy = Math.min(w, h) * 0.38
      return polygonOutline([
        { x: ox, y: 0 }, { x: w - ox, y: 0 }, { x: w - ox, y: h - oy }, { x: w, y: h - oy },
        { x: w / 2, y: h }, { x: 0, y: h - oy }, { x: ox, y: h - oy },
      ])
    }
    case 'arrow-right': {
      const ox = Math.min(w, h) * 0.38
      const oy = h * 0.16
      return polygonOutline([
        { x: 0, y: oy }, { x: w - ox, y: oy }, { x: w - ox, y: 0 }, { x: w, y: h / 2 },
        { x: w - ox, y: h }, { x: w - ox, y: h - oy }, { x: 0, y: h - oy },
      ])
    }
    case 'cloud':
      return { vertices: null, path: cloudPath(w, h), internalPaths: [] }
    case 'x-box': {
      const outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
      return { vertices: outer, path: polygonPath(outer), internalPaths: xBoxInternalPaths(w, h) }
    }
    case 'check-box': {
      const outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
      return { vertices: outer, path: polygonPath(outer), internalPaths: checkBoxInternalPaths(w, h) }
    }
    case 'heart':
      return { vertices: null, path: heartPath(w, h), internalPaths: [] }
  }
}
