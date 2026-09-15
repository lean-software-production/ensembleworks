// Snap-guide computation (alignment against nearby non-moving shapes while
// dragging a selection) and normalized arrow-anchor resolution (the local,
// rotation-independent 0..1 coordinate an arrow endpoint binds to on its
// target — Seam C7 consumes this for arrow routing).
import { descendantsOf, type CanvasDocument } from './document.js'
import { type Bounds, medianSize } from './geometry.js'
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
//
// EXPORTED (Unit 13): this is the EXACT computation `opts.excludedIds` exists
// to let a caller precompute ONCE at drag start and pass on every subsequent
// pointermove (see snapCandidates's own doc comment on `opts.excludedIds` for
// the measured cost of re-deriving it per call: ~2.4ms derived vs ~0.02ms
// precomputed at 1k shapes dragging a frame with 999 children). Exporting the
// SAME function the zero-opts path falls back to (rather than duplicating its
// logic in canvas-editor's select tool) is what guarantees the precomputed and
// derived paths can never drift apart.
export function computeExcludedIds(doc: CanvasDocument, movingIds: readonly string[]): Set<string> {
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
  const excluded = opts?.excludedIds ?? computeExcludedIds(doc, movingIds)
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
// Arrow anchor resolution (Seam C7 dependency) — MOVED to geometry.ts (Task
// arrow-body): geometry.ts's own arrowPathBounds/arrowHitTest need these two
// functions too, and geometry.ts sits BELOW this module in the package's
// dependency order (this file already imports FROM geometry.ts, never the
// reverse), so defining them there and re-exporting here keeps every
// existing `from './snapping.js'` import working byte-compatibly without
// duplicating the logic across two files.
// ============================================================================
export { resolveArrowAnchor, anchorToWorld } from './geometry.js'
