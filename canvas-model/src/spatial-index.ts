// Uniform-grid spatial index over a CanvasDocument's shapes: culling
// (queryViewport), marquee selection (queryMarquee, both AABB-'contain' and
// quad-accurate 'intersect'), and z-ordered point picking (hitTestTopmost).
// Built once per snapshot of `doc` — callers rebuild after any mutation
// (this package has no mutation/subscription machinery; that's the editor's
// job in a later seam).
import { type CanvasDocument } from './document.js'
import {
  type Bounds, type Point, medianSize, worldBounds, worldCorners, worldTransform, hitTestPoint,
} from './geometry.js'

export interface SpatialIndex {
  readonly cellSize: number
  /** cell key ("cx,cy") -> shape ids whose worldBounds intersects that cell. */
  readonly cells: ReadonlyMap<string, readonly string[]>
  /** Cached worldBounds per shape id, computed once at build time. */
  readonly boundsById: ReadonlyMap<string, Bounds>
  /** The populated cell-coordinate range (inclusive), or null for an empty
   * index. Queries clamp their own (possibly astronomically large — e.g. a
   * "select everything" viewport of ±1e9) cell range to this before
   * iterating, so a huge query costs O(populated cells), never O(query
   * area / cellSize²). Without this clamp, queryViewport over a huge
   * viewport would try to loop literally billions of empty cells. */
  readonly cellRange: { minCx: number; maxCx: number; minCy: number; maxCy: number } | null
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

// Build the grid. Cell size = medianSize(doc.shapes) — "about one median
// shape" per cell, the same scale-relative unit clusterShapes/snapCandidates
// use, so a typical shape spans O(1) cells (few candidates per cell) without
// so many cells that a large shape spans hundreds of them. Degenerate paths:
//   - empty doc: medianSize's own empty-doc fallback (100) applies — no
//     special case needed here.
//   - all-zero-size shapes: medianSize could legitimately be 0, which would
//     make every shape span infinitely many cells (division by zero) — floor
//     the cell size at 1.
export function buildSpatialIndex(doc: CanvasDocument): SpatialIndex {
  const cellSize = Math.max(medianSize(doc.shapes), 1)
  const cells = new Map<string, string[]>()
  const boundsById = new Map<string, Bounds>()
  let cellRange: SpatialIndex['cellRange'] = null
  for (const shape of doc.shapes) {
    const bounds = worldBounds(doc, shape)
    boundsById.set(shape.id, bounds)
    const minCx = Math.floor(bounds.minX / cellSize), maxCx = Math.floor(bounds.maxX / cellSize)
    const minCy = Math.floor(bounds.minY / cellSize), maxCy = Math.floor(bounds.maxY / cellSize)
    cellRange = cellRange === null
      ? { minCx, maxCx, minCy, maxCy }
      : {
          minCx: Math.min(cellRange.minCx, minCx), maxCx: Math.max(cellRange.maxCx, maxCx),
          minCy: Math.min(cellRange.minCy, minCy), maxCy: Math.max(cellRange.maxCy, maxCy),
        }
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = cellKey(cx, cy)
        const bucket = cells.get(key)
        if (bucket) bucket.push(shape.id)
        else cells.set(key, [shape.id])
      }
    }
  }
  return { cellSize, cells, boundsById, cellRange }
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY
}

// Candidate ids from every cell `bounds` overlaps, deduped. A broad-phase
// superset: every caller here (queryViewport itself, and queryMarquee's two
// modes) narrows it further with an exact test. The query's own cell range
// is clamped to the index's populated cellRange FIRST (see SpatialIndex's
// doc comment) — otherwise a "select everything" huge viewport would loop
// its entire (possibly billions-of-cells) span instead of just the
// populated ones.
function candidatesFor(index: SpatialIndex, bounds: Bounds): string[] {
  const ids = new Set<string>()
  if (index.cellRange === null) return []
  const minCx = Math.max(Math.floor(bounds.minX / index.cellSize), index.cellRange.minCx)
  const maxCx = Math.min(Math.floor(bounds.maxX / index.cellSize), index.cellRange.maxCx)
  const minCy = Math.max(Math.floor(bounds.minY / index.cellSize), index.cellRange.minCy)
  const maxCy = Math.min(Math.floor(bounds.maxY / index.cellSize), index.cellRange.maxCy)
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = index.cells.get(cellKey(cx, cy))
      if (bucket) for (const id of bucket) ids.add(id)
    }
  }
  return [...ids]
}

// Culling: every shape whose worldBounds intersects `bounds` at all (any
// intersection, not containment). The exact AABB check after the cell scan
// matters at cell borders: a shape can share a candidate cell with the query
// without their bounds actually overlapping (e.g. touching only at the
// cell's far corner).
export function queryViewport(index: SpatialIndex, bounds: Bounds): string[] {
  return candidatesFor(index, bounds).filter((id) => boundsIntersect(index.boundsById.get(id)!, bounds))
}

// Marquee selection.
//   'contain' — the shape's worldBounds lies entirely inside `bounds` (AABB
//     containment; exact, no quad math needed — a rotated shape whose AABB is
//     already fully inside the marquee is, a fortiori, itself fully inside).
//   'intersect' — rotated-quad-accurate: tests the shape's TRUE rotated
//     rectangle against `bounds` via the separating-axis theorem (both
//     shapes here are rectangles — the marquee axis-aligned, the shape's
//     local box rotated by its world rotation — so only 4 candidate axes
//     ever need checking: the marquee's 2 edge normals + the shape's 2 edge
//     normals). This is what prevents a marquee that only touches a rotated
//     shape's empty AABB corner from wrongly selecting it (see
//     spatial-index.test.ts's diamond case).
// Both modes start from queryViewport's candidate pool: containment implies
// intersection, and true-quad intersection implies AABB intersection (the
// quad's own AABB is a superset of the quad), so narrowing from that pool
// loses nothing.
export function queryMarquee(
  index: SpatialIndex,
  doc: CanvasDocument,
  bounds: Bounds,
  mode: 'intersect' | 'contain',
): string[] {
  const pool = queryViewport(index, bounds)
  if (mode === 'contain') return pool.filter((id) => boundsContains(bounds, index.boundsById.get(id)!))
  return pool.filter((id) => {
    const shape = doc.byId.get(id)
    if (!shape) return false
    const rotation = worldTransform(doc, shape).rotation
    return rectQuadIntersects(bounds, worldCorners(doc, shape), rotation)
  })
}

function projectOntoAxis(points: readonly Point[], axis: Point): [number, number] {
  let min = Infinity, max = -Infinity
  for (const p of points) {
    const d = p.x * axis.x + p.y * axis.y
    if (d < min) min = d
    if (d > max) max = d
  }
  return [min, max]
}

// SAT (separating-axis theorem) between an axis-aligned rect and a rotated
// rectangle (4 corners, known rotation). Both operands are rectangles
// (parallelograms with right angles), so only 4 axes are ever candidate
// separators: the rect's own 2 edge normals (x, y) and the rotated
// rectangle's 2 edge normals (perpendicular to each other, derived from
// `rotation`). If every axis's projected intervals overlap, the shapes
// intersect; any one separating axis proves they don't. Inclusive (touching
// counts as intersecting), matching worldBounds/hitTestPoint's inclusive
// boundary convention.
function rectQuadIntersects(rect: Bounds, quadCorners: readonly Point[], rotation: number): boolean {
  const rectCorners: Point[] = [
    { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY },
  ]
  const cos = Math.cos(rotation), sin = Math.sin(rotation)
  const axes: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: cos, y: sin }, { x: -sin, y: cos }]
  for (const axis of axes) {
    const [rMin, rMax] = projectOntoAxis(rectCorners, axis)
    const [qMin, qMax] = projectOntoAxis(quadCorners, axis)
    if (rMax < qMin || qMax < rMin) return false // separating axis found
  }
  return true
}

// Strict descendant test (a is somewhere under ancestorId in the parent
// chain), cycle-safe via a visited set — same guard pattern as
// geometry.ts's worldTransform, since byId can hold a malformed/cyclic chain
// mid-merge and this must still terminate.
function isDescendantOf(doc: CanvasDocument, id: string, ancestorId: string): boolean {
  const visited = new Set<string>()
  let cur = doc.byId.get(id)
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id)
    if (cur.parentId === ancestorId) return true
    cur = doc.byId.get(cur.parentId)
  }
  return false
}

// Topmost shape at a point, by z-order. Tie-break (exact, deterministic):
// pairwise-fold over every shape whose true (rotated) quad contains the
// point, keeping a running "best":
//   1. if the candidate is a DESCENDANT of the current best, the candidate
//      wins (a child always draws over its ancestor container, regardless
//      of array position);
//   2. else if the current best is a descendant of the candidate, the
//      current best is kept;
//   3. else (unrelated shapes — siblings or different subtrees) the one
//      LATER in `doc.shapes` wins — document array order is treated as
//      z-order for shapes with no ancestor relationship.
// Broad-phase candidates come from the point's own grid cell: correctness
// holds because hitTestPoint(shape, point) true implies point is inside
// shape's worldBounds (the quad is a subset of its own AABB), and
// buildSpatialIndex adds a shape to every cell its worldBounds spans — so
// the point's cell is guaranteed to include every shape that could possibly
// hit-test true there.
export function hitTestTopmost(index: SpatialIndex, doc: CanvasDocument, point: Point): string | null {
  const key = cellKey(Math.floor(point.x / index.cellSize), Math.floor(point.y / index.cellSize))
  const candidates = index.cells.get(key) ?? []
  const hits = candidates.filter((id) => { const s = doc.byId.get(id); return s ? hitTestPoint(doc, s, point) : false })
  if (hits.length === 0) return null
  const order = new Map<string, number>(doc.shapes.map((s, i) => [s.id, i]))
  let best = hits[0]!
  for (let i = 1; i < hits.length; i++) {
    const candidate = hits[i]!
    if (isDescendantOf(doc, candidate, best)) { best = candidate; continue }
    if (isDescendantOf(doc, best, candidate)) continue
    if (order.get(candidate)! > order.get(best)!) best = candidate
  }
  return best
}
