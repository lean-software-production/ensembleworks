// Uniform-grid spatial index over a CanvasDocument's shapes: culling
// (queryViewport), marquee selection (queryMarquee, both AABB-'contain' and
// quad-accurate 'intersect'), and z-ordered point picking (hitTestTopmost).
//
// ============================================================================
// STALENESS CONTRACT (Seam C/D: read this before wiring the editor to it)
//
// REBUILD CADENCE: rebuild on DOC COMMIT, not per-pointermove. "Any
// mutation" includes REMOTE peers' edits arriving through sync — a doc that
// changed under you for any reason needs a rebuild before the index
// reflects it. This package has no mutation/subscription machinery; wiring
// rebuild-on-commit is the editor's job in a later seam.
//
// WHAT A STALE INDEX DOES, precisely (per query — the two families differ):
//   - The quad-exact queries — hitTestTopmost, queryMarquee('intersect') —
//     take candidates from BUILD-TIME cell buckets but run their exact test
//     (hitTestPoint / SAT) against the CURRENT doc. Staleness therefore
//     produces OMISSIONS ONLY (a shape that moved into the queried region
//     since the build isn't in the right bucket yet), never false
//     positives: a bucket hit that no longer overlaps fails the exact test
//     and is filtered out.
//   - The AABB queries — queryViewport, queryMarquee('contain') — answer
//     entirely from build-time boundsById: they can BOTH omit a shape that
//     moved in AND report a shape at its build-time position after it moved
//     away. For culling this over-inclusion is deliberate and harmless
//     (drawing a shape that would have been culled is correct, just
//     unclipped); for 'contain' marquees it means selection reflects the
//     last committed positions — which is exactly what a user mid-someone-
//     else's-drag should see anyway.
//
// DRAGGING: during a drag, the moving selection's correctness comes from
// snapCandidates' movingIds/excludedIds EXCLUSION, not from re-querying the
// selection's own (stale) indexed position — unmoving shapes sitting in a
// slightly-old index is the design, not a bug to fix with per-move rebuilds.
//
// NO IDENTITY CHECK: nothing ties an index to the doc it was built from.
// Passing a mismatched (index, doc) pair is not detected — it fails
// SILENTLY as omissions (and, for the AABB queries, as answers about the
// wrong doc's geometry). Keep the pairing straight at the call site.
// ============================================================================
import { type CanvasDocument } from './document.js'
import {
  type Bounds, type Point, medianSize, rotationAxes, worldBounds, worldCorners, worldTransform, hitTestPoint,
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
  /** Shape ids the grid could not spatially partition. The trigger is
   * MEDIAN-RELATIVE, not "one pathological shape": a shape lands here when
   * its worldBounds is non-finite (NaN/±Infinity — the envelope's schema
   * doesn't bound these) OR spans more than MAX_CELLS_PER_SHAPE cells at
   * cellSize ≈ medianSize(doc.shapes). Because the cell size tracks the
   * MEDIAN, a bimodal size distribution routes the entire large mode here —
   * e.g. 501 tiny + 499 huge shapes puts ALL 499 huge ones in overflow
   * (median = tiny), not just an outlier or two.
   *
   * DEGRADATION MODE: overflow ids are unconditionally added to EVERY
   * query's candidate pool — including a 10×10 point probe on the far side
   * of the canvas — so each query silently pays O(overflow) extra exact
   * tests (boundsIntersect / hitTestPoint / SAT). Correctness is fully
   * preserved (the exact tests decide; nothing is dropped), but for the
   * overflow subset the index degrades to a linear scan. This is the
   * accepted tradeoff: the alternative — fanning a huge-relative-to-median
   * shape into its ~1e8 spanned cells — is a build-time hang, and NaN cell
   * keys are impossible. Pinned by spatial-index.test.ts's bimodal-doc
   * case. */
  readonly overflow: readonly string[]
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

// No shape may make index-build cost unbounded: this caps how many cells
// any one shape may fan into before it's routed to `overflow` instead.
// 4096 is generous (a 64x64 cell footprint at the default
// ~one-median-shape cell size) while still being small compared to
// "iterate the entire spanned range" for a shape whose bounds are orders
// of magnitude larger than the document's MEDIAN size. Note the trigger is
// median-relative: in a bimodal doc, EVERY shape of the large mode
// exceeds this and lands in overflow — see SpatialIndex.overflow for the
// degradation mode that implies.
const MAX_CELLS_PER_SHAPE = 4096

// Is this shape's cell span small and finite enough to fan out into `cells`?
// False for non-finite bounds (NaN/Infinity anywhere — Math.floor of those
// is NaN/Infinity, and a `for` loop from/to a non-finite bound never
// terminates) and for a finite-but-huge span (e.g. props.w = 1e10 while
// every other shape is ~100 — cellSize stays small, so this one shape would
// otherwise iterate ~1e8+ cells).
function cellSpanIsSane(minCx: number, maxCx: number, minCy: number, maxCy: number): boolean {
  if (![minCx, maxCx, minCy, maxCy].every(Number.isFinite)) return false
  const spanX = maxCx - minCx + 1, spanY = maxCy - minCy + 1
  return spanX * spanY <= MAX_CELLS_PER_SHAPE
}

// Build the grid. Cell size = medianSize(doc.shapes) — "about one median
// shape" per cell, the same scale-relative unit clusterShapes/snapCandidates
// use, so a typical shape spans O(1) cells (few candidates per cell) without
// so many cells that a large shape spans hundreds of them.
//
// COST (relevant because the staleness contract above says rebuild on every
// doc commit): O(n·depth) — each shape's worldBounds walks its own parent
// chain to the root with NO cross-shape ancestor memoization, so deeply
// nested trees pay the chain repeatedly (measured: ~2ms at 1k flat shapes;
// ~4ms at a 200-deep chain; ~80ms at 1600-deep — super-linear in depth). The
// working assumption is that real canvases nest shallowly (frames/groups a
// few levels deep); a pathologically deep parent chain is a KNOWN,
// UNMITIGATED perf risk of the rebuild-per-commit model. If it ever bites,
// the fix is memoizing worldTransform per build pass — an internal change,
// no API impact.
//
// Degenerate paths:
//   - empty doc: medianSize's own empty-doc fallback (100) applies — no
//     special case needed here.
//   - all-zero-size shapes: medianSize could legitimately be 0, which would
//     make every shape span infinitely many cells (division by zero) — floor
//     the cell size at 1.
//   - non-finite medianSize (e.g. one shape with props.w = Infinity skews
//     the median itself, not just that shape's own span) — fall back to a
//     fixed default (100, matching geometry.ts's own kind-default unit)
//     rather than building a NaN/Infinity-sized grid.
//   - a single pathologically-huge or non-finite shape — see
//     cellSpanIsSane/overflow above.
export function buildSpatialIndex(doc: CanvasDocument): SpatialIndex {
  const rawCellSize = medianSize(doc.shapes)
  const cellSize = Number.isFinite(rawCellSize) ? Math.max(rawCellSize, 1) : 100
  const cells = new Map<string, string[]>()
  const boundsById = new Map<string, Bounds>()
  const overflow: string[] = []
  let cellRange: SpatialIndex['cellRange'] = null
  for (const shape of doc.shapes) {
    const bounds = worldBounds(doc, shape)
    boundsById.set(shape.id, bounds)
    const minCx = Math.floor(bounds.minX / cellSize), maxCx = Math.floor(bounds.maxX / cellSize)
    const minCy = Math.floor(bounds.minY / cellSize), maxCy = Math.floor(bounds.maxY / cellSize)
    if (!cellSpanIsSane(minCx, maxCx, minCy, maxCy)) { overflow.push(shape.id); continue }
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
  return { cellSize, cells, boundsById, cellRange, overflow }
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY
}

// Candidate ids from every cell `bounds` overlaps, deduped, PLUS every
// overflow shape (see SpatialIndex.overflow — a shape the grid couldn't
// spatially partition is always a candidate everywhere; the exact
// boundsIntersect/hitTestPoint check downstream is what keeps this correct
// rather than over-selecting). A broad-phase superset: every caller here
// (queryViewport itself, and queryMarquee's two modes) narrows it further
// with an exact test. The query's own cell range is clamped to the index's
// populated cellRange FIRST (see SpatialIndex's doc comment) — otherwise a
// "select everything" huge viewport would loop its entire (possibly
// billions-of-cells) span instead of just the populated ones.
function candidatesFor(index: SpatialIndex, bounds: Bounds): string[] {
  const ids = new Set<string>(index.overflow)
  if (index.cellRange === null) return [...ids]
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
// STALENESS: answers entirely from build-time bounds — can both omit
// moved-in shapes and report moved-away shapes at their old position (by
// design for culling; see the contract at the top of this file).
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
// STALENESS: 'intersect' runs its exact SAT test against the CURRENT doc
// (stale index ⇒ omissions only); 'contain' answers from build-time bounds
// (stale index ⇒ omissions AND last-committed positions). Contract at the
// top of this file.
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
    // One worldTransform call, reused for both the rotation (SAT axes) and
    // the corners (worldCorners' precomputedTransform param) — avoids
    // walking the parent chain twice per candidate.
    const t = worldTransform(doc, shape)
    return rectQuadIntersects(bounds, worldCorners(doc, shape, t), t.rotation)
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
// rectangle's 2 edge axes — taken from geometry.ts's rotationAxes so the
// sign convention has a single source of truth (see that function's
// drift-proofing note) rather than a local cos/sin re-derivation. If every
// axis's projected intervals overlap, the shapes intersect; any one
// separating axis proves they don't. Inclusive (touching counts as
// intersecting), matching worldBounds/hitTestPoint's inclusive boundary
// convention.
function rectQuadIntersects(rect: Bounds, quadCorners: readonly Point[], rotation: number): boolean {
  const rectCorners: Point[] = [
    { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY },
  ]
  const [quadAxisX, quadAxisY] = rotationAxes(rotation)
  const axes: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, quadAxisX, quadAxisY]
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

// Topmost shape at a point, by z-order. Tie-break (exact, deterministic),
// computed in TWO passes over every shape whose true (rotated) quad
// contains the point — NOT a single pairwise fold keeping a running "best"
// (a fold isn't safe here: "descendant beats ancestor" is only a PARTIAL
// order, and folding it together with the "last in doc.shapes" total order
// pairwise-by-pairwise is not transitive — e.g. hits [b (child of a), c
// (unrelated, later in doc.shapes than b), a (parent of b, later still)]:
// b beats a directly, c beats b by array order, but a beats c by array
// order — a genuine 3-way cycle. Folding left-to-right can then return the
// ancestor `a` over its own descendant `b`, violating the rule below):
//   1. Drop every hit that is an ANCESTOR of some other hit — an ancestor
//      never wins over its own descendant, full stop, regardless of array
//      order (a child always draws over its ancestor container).
//   2. Among what's left (now a true antichain — no remaining hit is an
//      ancestor of another), the one LATEST in `doc.shapes` wins — document
//      array order is treated as z-order for shapes with no ancestor
//      relationship.
// Broad-phase candidates come from the point's own grid cell PLUS the
// index's overflow list (see SpatialIndex.overflow): correctness holds
// because hitTestPoint(shape, point) true implies point is inside shape's
// worldBounds (the quad is a subset of its own AABB), and buildSpatialIndex
// adds a shape to every (sane-sized) cell its worldBounds spans — so the
// point's cell is guaranteed to include every non-overflow shape that could
// possibly hit-test true there, and overflow shapes are always candidates.
// STALENESS: candidates come from build-time buckets but hitTestPoint runs
// against the CURRENT doc — stale index ⇒ omissions only, never a false
// hit (contract at the top of this file).
export function hitTestTopmost(index: SpatialIndex, doc: CanvasDocument, point: Point): string | null {
  const key = cellKey(Math.floor(point.x / index.cellSize), Math.floor(point.y / index.cellSize))
  const candidates = [...(index.cells.get(key) ?? []), ...index.overflow]
  const hits = candidates.filter((id) => { const s = doc.byId.get(id); return s ? hitTestPoint(doc, s, point) : false })
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]!
  const isAncestorOfAnotherHit = (id: string) => hits.some((other) => other !== id && isDescendantOf(doc, other, id))
  const antichain = hits.filter((id) => !isAncestorOfAnotherHit(id))
  const order = new Map<string, number>(doc.shapes.map((s, i) => [s.id, i]))
  let best = antichain[0]!
  for (let i = 1; i < antichain.length; i++) {
    const candidate = antichain[i]!
    if (order.get(candidate)! > order.get(best)!) best = candidate
  }
  return best
}
