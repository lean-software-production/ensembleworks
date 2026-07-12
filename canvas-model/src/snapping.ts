// Snap-guide computation (alignment against nearby non-moving shapes while
// dragging a selection) and normalized arrow-anchor resolution (the local,
// rotation-independent 0..1 coordinate an arrow endpoint binds to on its
// target — Seam C7 consumes this for arrow routing).
import { descendantsOf, type CanvasDocument } from './document.js'
import {
  type Bounds, type Point, localBounds, medianSize, toLocalPoint, toWorldPoint,
} from './geometry.js'
import { queryViewport, type SpatialIndex } from './spatial-index.js'

// ============================================================================
// snapCandidates
// ============================================================================

export interface SnapGuide { axis: 'x' | 'y'; at: number; kind: 'edge' | 'center' }
export interface SnapResult {
  /** The delta to ADD to the moving selection's current position so its
   * snapped axis/axes land exactly on the guide(s) below. 0 on an axis with
   * no snap found (NOT a sentinel — a real 0 also means "already aligned"
   * and both read the same to a caller: no adjustment needed on that axis). */
  dx: number
  dy: number
  guides: SnapGuide[]
}

// Snap tolerance, scale-relative rather than a fixed pixel count (a fixed
// count would feel loose on a document of tiny shapes and tight on one of
// huge shapes): 5% of medianSize(doc.shapes) — OURS, chosen to be tight
// enough that it doesn't fire on shapes that merely happen to be nearby at
// normal document scale, loose enough to forgive imprecise manual dragging.
// Calibrate against tldraw parity in Phase 5 alongside the other OURS
// defaults (see geometry.ts's localBounds comment).
const SNAP_THRESHOLD_K = 0.05

// How far to LOOK for candidate targets, as a multiple of medianSize — a
// separate, much larger number than the snap threshold itself. Alignment is
// per-axis (a shape stacked far away vertically can still be a valid
// center-x snap target), so the search radius can't just be the threshold
// padded onto `bounds` — that would only find targets already overlapping
// on BOTH axes, which defeats cross-axis alignment entirely. 10x is a
// generous "same general vicinity" radius: OURS, calibrate against real
// editor feel in Phase 5 alongside the other tunable constants in this file.
const SEARCH_RADIUS_K = 10

// The 3 alignable features of a bounds on one axis: both edges + the
// center. `kind` records which: an edge/edge or center/center match reports
// its own kind; edge/center (either direction) is classified 'edge' below —
// only a center-to-center hit is presented to the caller as a 'center'
// guide (matching the common editor convention that a center guide implies
// BOTH shapes are centered on it, not just one incidentally sharing an edge
// with the other's midpoint).
function featuresOf(b: Bounds, axis: 'x' | 'y'): { value: number; kind: 'edge' | 'center' }[] {
  const min = axis === 'x' ? b.minX : b.minY
  const max = axis === 'x' ? b.maxX : b.maxY
  return [{ value: min, kind: 'edge' }, { value: (min + max) / 2, kind: 'center' }, { value: max, kind: 'edge' }]
}

// movingIds ∪ every descendant of every movingId — a frame's children move
// WITH it, so they must never be offered as an independent snap target even
// if only the frame's id was passed in.
function excludedIds(doc: CanvasDocument, movingIds: readonly string[]): Set<string> {
  const excluded = new Set(movingIds)
  for (const id of movingIds) for (const d of descendantsOf(doc, id)) excluded.add(d.id)
  return excluded
}

/**
 * Find alignment guides for a selection mid-drag. `bounds` is the moving
 * selection's CANDIDATE bounds (where it would land if dropped right now,
 * as a single combined AABB — multi-shape drags snap the group's bounds as
 * a unit, not shape-by-shape). `movingIds` names the shapes being dragged
 * (their descendants are excluded too — see excludedIds).
 *
 * STALENESS: consult SpatialIndex's staleness contract (spatial-index.ts) —
 * this reads the index's build-time buckets/bounds, so targets are where
 * they were at the last rebuild; the moving selection's own correctness
 * comes from the exclusion set, not from the index.
 *
 * `opts.excludedIds` is a perf escape hatch mirroring worldCorners'
 * precomputedTransform: deriving the excluded set costs a descendantsOf BFS
 * per moving id (O(n) filter per BFS node — measured ~2.4ms/call derived
 * vs ~0.02ms precomputed at 1k shapes dragging a frame with 999 children),
 * and movingIds does not change mid-gesture, so Seam C should compute the
 * set ONCE at drag-start
 * (movingIds ∪ all their descendants — exactly what the derived path
 * builds) and pass it on every pointermove. The supplied set is trusted
 * verbatim: a set missing descendants will let a moving child be offered
 * as its own snap target.
 *
 * Independently finds the single best (closest) snap on the X axis and on
 * the Y axis, across every candidate target's edge/edge, center/center, and
 * edge/center feature pairs. "Best" = smallest |delta|; ties are broken by
 * scan order (candidate ids sorted, then target features in
 * [minEdge, center, maxEdge] order, then moving features in the same
 * order) — deterministic, not "whichever object.values() iterates first".
 */
export function snapCandidates(
  index: SpatialIndex,
  doc: CanvasDocument,
  movingIds: readonly string[],
  bounds: Bounds,
  opts?: { excludedIds?: ReadonlySet<string> },
): SnapResult {
  const excluded = opts?.excludedIds ?? excludedIds(doc, movingIds)
  const unit = medianSize(doc.shapes)
  const threshold = unit * SNAP_THRESHOLD_K
  // Search area padded by SEARCH_RADIUS_K (not `threshold` — see its
  // comment): wide enough to catch cross-axis alignment against a shape
  // that's far away on the OTHER axis.
  const searchRadius = unit * SEARCH_RADIUS_K
  const searchArea: Bounds = {
    minX: bounds.minX - searchRadius, minY: bounds.minY - searchRadius,
    maxX: bounds.maxX + searchRadius, maxY: bounds.maxY + searchRadius,
  }
  const candidateIds = queryViewport(index, searchArea).filter((id) => !excluded.has(id)).sort()

  const movingX = featuresOf(bounds, 'x')
  const movingY = featuresOf(bounds, 'y')

  let bestX: { delta: number; at: number; kind: 'edge' | 'center' } | null = null
  let bestY: { delta: number; at: number; kind: 'edge' | 'center' } | null = null

  for (const id of candidateIds) {
    const targetBounds = index.boundsById.get(id)
    if (!targetBounds) continue
    for (const tf of featuresOf(targetBounds, 'x')) {
      for (const mf of movingX) {
        const delta = tf.value - mf.value
        if (Math.abs(delta) <= threshold && (bestX === null || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = { delta, at: tf.value, kind: tf.kind === 'center' && mf.kind === 'center' ? 'center' : 'edge' }
        }
      }
    }
    for (const tf of featuresOf(targetBounds, 'y')) {
      for (const mf of movingY) {
        const delta = tf.value - mf.value
        if (Math.abs(delta) <= threshold && (bestY === null || Math.abs(delta) < Math.abs(bestY.delta))) {
          bestY = { delta, at: tf.value, kind: tf.kind === 'center' && mf.kind === 'center' ? 'center' : 'edge' }
        }
      }
    }
  }

  const guides: SnapGuide[] = []
  if (bestX) guides.push({ axis: 'x', at: bestX.at, kind: bestX.kind })
  if (bestY) guides.push({ axis: 'y', at: bestY.at, kind: bestY.kind })
  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides }
}

// ============================================================================
// Arrow anchor resolution (Seam C7 dependency)
// ============================================================================

// Clamp to [0,1], TOTAL over all number inputs: Math.max/Math.min PROPAGATE
// NaN rather than clamping it, so a bare max/min chain would let a
// NaN-poisoned caller point produce a NaN anchor — which, persisted into a
// binding, silently breaks that arrow forever (anchorToWorld does no
// re-validation). Non-finite input (NaN from arithmetic on a NaN point;
// ±Infinity likewise) falls back to 0.5 — center, matching
// resolveArrowAnchor's missing-target fallback philosophy.
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5)

/**
 * Normalized anchor (0..1 on both axes, clamped) of a world `point` within
 * `targetId`'s LOCAL unrotated box — computed by inverse-transforming the
 * world point (toLocalPoint) and dividing by the box's own w/h. Independent
 * of the target's rotation and parent chain by construction (that's exactly
 * what toLocalPoint undoes), so it stays valid as the target moves/rotates —
 * the whole reason arrow bindings store a normalized anchor instead of a
 * world offset.
 *
 * Degenerate paths: missing target -> {nx:0.5, ny:0.5} (center — an
 * arbitrary but harmless default; the caller (Seam C7) is expected to drop
 * the binding for a target that no longer resolves, this is just a total,
 * non-throwing fallback). Zero-width or zero-height local box -> that axis's
 * normalized coordinate is 0 (dividing by a zero span is meaningless; 0 is a
 * stable, arbitrary pick — since min===max on that axis, anchorToWorld's
 * result is IDENTICAL for every nx/ny choice there, so the choice of default
 * never actually loses information on that axis).
 */
export function resolveArrowAnchor(doc: CanvasDocument, targetId: string, point: Point): { nx: number; ny: number } {
  const shape = doc.byId.get(targetId)
  if (!shape) return { nx: 0.5, ny: 0.5 }
  const local = toLocalPoint(doc, shape, point)
  const lb = localBounds(shape)
  const w = lb.maxX - lb.minX, h = lb.maxY - lb.minY
  const nx = w > 0 ? clamp01((local.x - lb.minX) / w) : 0
  const ny = h > 0 ? clamp01((local.y - lb.minY) / h) : 0
  return { nx, ny }
}

/**
 * The inverse of resolveArrowAnchor: map a normalized (nx,ny) anchor back to
 * a world point, given the target's CURRENT transform (so this re-resolves
 * correctly after the target has moved/rotated — arrow routing calls this
 * every frame, not once at bind time). Missing target -> {x:0, y:0}
 * (documented total fallback, matching resolveArrowAnchor's degenerate-path
 * policy).
 */
export function anchorToWorld(doc: CanvasDocument, targetId: string, anchor: { nx: number; ny: number }): Point {
  const shape = doc.byId.get(targetId)
  if (!shape) return { x: 0, y: 0 }
  const lb = localBounds(shape)
  const local: Point = { x: lb.minX + anchor.nx * (lb.maxX - lb.minX), y: lb.minY + anchor.ny * (lb.maxY - lb.minY) }
  return toWorldPoint(doc, shape, local)
}
