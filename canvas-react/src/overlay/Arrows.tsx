// Arrow rendering: every VIEWPORT-RELEVANT arrow-kind shape's routed
// WORLD-space path (canvas-model's `routeArrow`, arrow-route.ts) converted
// point-by-point to SCREEN space and drawn as an SVG path, plus a small
// arrowhead triangle at the end.
//
// WHY ARROWS LIVE IN THE OVERLAY, NOT AS SHAPE BODIES (ShapeBody.tsx/
// ShapeLayer.tsx): `routeArrow` reads a bound terminal's CURRENT anchor
// position off whatever shape it's bound to — "arrows are re-routed on every
// call, not cached from bind time" (arrow-route.ts's routeArrow doc comment).
// That is a CROSS-SHAPE read (an arrow shape's rendered geometry depends on
// some OTHER shape's current position/rotation, not just its own props), which
// ShapeBody's per-shape, `snapshot`-optional-by-convention memo model
// (ShapeBody.tsx's MEMO STRATEGY note) is not built for — a bound arrow would
// need to re-render on every OTHER shape's move, defeating exactly the
// content-memo win that model exists for. The overlay already re-renders
// wholesale on every doc commit (it reads the whole `snapshot`), so routing
// the RELEVANT arrows fresh here, on every render, is the natural place: no
// extra subscription wiring, and a moved target's next commit re-renders the
// overlay (and therefore re-routes every surviving arrow) for free.
//
// ============================================================================
// VIEWPORT CULLING (review round 2 — measured before this existed: routing
// was O(all arrows) per render regardless of camera, ~1.07ms at 100 arrows
// and ~17.4ms at 2000, past the frame budget on its own): an arrow is routed
// AND rendered iff at least one of three cheap checks passes, each strictly
// cheaper than routeArrow (no anchorToWorld/worldCorners/clipping):
//   (a) the arrow's OWN shape id is in queryViewport(index, viewport) — the
//       same index/queryViewport culling ShapeLayer already does for bodies
//       (an arrow's own worldBounds covers its x/y box, NOT its routed
//       path, so this alone is insufficient — hence (b)/(c));
//   (b) EITHER bound target's id is in that same queryViewport set (one
//       O(bindings) pass over snapshot.bindings builds the arrowId ->
//       {start/end target} map per render — binding rows carry fromId +
//       props.terminal, see arrow-route.ts's ARROW PROPS SCHEMA);
//   (c) the APPROXIMATE segment bbox intersects the viewport: endpoints
//       approximated as the arrow's own stored point (unbound terminal —
//       toWorldPoint of {0,0} / props.end, exactly resolveEndpoint's unbound
//       arm) or the bound target's worldBounds CENTER (bound terminal — the
//       true anchor is somewhere inside the target; the target's own
//       half-extent slack is absorbed by over-inclusion), the bbox inflated
//       by |bend| (a curved arrow's control point sits |bend| off the chord,
//       so the curve can bulge outside the chord's bbox by at most that).
//       This is what saves the long-arrow-spanning-the-screen case (both
//       endpoints off-viewport, segment crossing it) WITHOUT routing it.
//
// OVER-INCLUSION SEMANTICS (deliberate, one-sided): every check errs toward
// RENDERING — a few extra near-edge/near-miss arrows get routed and drawn
// (harmless: the SVG clips them; cost is a handful of spare routeArrow
// calls), but an arrow whose visible path could touch the viewport is never
// dropped. Same posture as spatial-index.ts's culling tradeoff ("drawing a
// shape that would have been culled is correct, just unclipped") and
// ShapeLayer's AABB body culling. Staleness: (a)/(b) read the index's
// build-time buckets (queryViewport can omit a target that moved INTO view
// since the last commit — the same staleness window as every other index
// consumer, healed at the next commit's rebuild), while (c) reads the
// CURRENT snapshot, so a moved endpoint is caught by (c) even before the
// index rebuilds. Routing cost is now bounded by (visible + spanning)
// arrows, not doc-total — pinned by overlay.test.ts's routeFn-counter case
// via the test seam below.
// ============================================================================
//
// CURVE RENDERING: `kind === 'straight'` -> `M start L end`; `kind ===
// 'curved'` (bend != 0) -> a quadratic Bézier `M start Q mid end`, using
// routeArrow's `mid` as the SVG `Q` command's single control point verbatim
// (arrow-route.ts documents `mid` as exactly a quadratic control point, in
// WORLD space — converted to screen here like every other point).
//
// ARROWHEAD ORIENTATION: a small triangle at the visible `end` point, aimed
// along the path's incoming tangent — for a straight path that's `end -
// start`; for a quadratic Bézier, the tangent at t=1 (the curve's END) is
// proportional to `end - mid` (the standard quadratic-Bézier derivative
// B'(1) = 2(P2 - P1) for control points P0=start, P1=mid, P2=end — the
// constant 2 doesn't matter, only the DIRECTION does here). Both cases
// therefore reduce to "the last segment's direction", computed directly from
// the already screen-converted points (worldToScreen is a translate+uniform
// scale, so direction angles survive the conversion unchanged in sign, only
// scaled in magnitude, which normalizing away here loses nothing).
//
// Ink (freehand drawing) is OUT of scope per the ratified Open Q3 answer —
// this file renders arrow-kind shapes ONLY; a hypothetical Ink.tsx is
// deferred, not stubbed.
import type { Binding, Bounds, CanvasDocument, Point, Shape, SpatialIndex } from '@ensembleworks/canvas-model'
import { centroid, queryViewport, routeArrow, toWorldPoint, worldBounds } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { viewportWorldBounds, type ViewportSize } from '../ShapeLayer.js'

export interface ArrowsProps {
  readonly snapshot: CanvasDocument
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  /** The shared spatial index — G3 passes toolContext.index(), the same
   * consumption pattern (and coherence guarantee) as ShapeLayer:
   * tool-context.ts pins that index() and snapshot() from one post-commit
   * read cycle always describe the same doc state. Used ONLY for the
   * culling broad phase; routing always reads the live `snapshot`. */
  readonly index: SpatialIndex
  /** Test seam: replaces routeArrow so a test can count routing calls
   * (pinning that culled arrows are never routed — overlay.test.ts's
   * counter case). Production callers omit it. */
  readonly routeFn?: typeof routeArrow
}

const ARROW_STROKE = 'var(--canvas-arrow, #1a1a1a)'
const ARROWHEAD_LENGTH_PX = 10
const ARROWHEAD_HALF_WIDTH_PX = 4

function pathString(start: Point, end: Point, mid?: Point): string {
  if (!mid) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`
  return `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`
}

/** The triangle's 3 screen points for an arrowhead pointing FROM `tail`
 * TOWARD `tip` (i.e. oriented along `tip - tail`). Exported so overlay.test.ts
 * can hand-compute the same geometry independently rather than re-deriving
 * trig locally. Degenerate `tip === tail` (zero-length last segment — e.g. a
 * self-bound arrow whose two anchors coincide, arrow-route.test.ts's own
 * documented degenerate case): `Math.atan2(0, 0)` is well-defined (0, not
 * NaN), so this still returns a finite (if visually meaningless) triangle,
 * never throws or emits NaN into the SVG. */
export function arrowheadPoints(tail: Point, tip: Point): [Point, Point, Point] {
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const backX = tip.x - ARROWHEAD_LENGTH_PX * cos
  const backY = tip.y - ARROWHEAD_LENGTH_PX * sin
  // Perpendicular to the tangent, same 90°-rotation convention geometry.ts
  // documents ((x,y) -> (-y,x)) — screen space, not world space, since these
  // points are already converted; the convention is the same rotation either
  // way, just applied to a different vector.
  const perpX = -sin
  const perpY = cos
  const left: Point = { x: backX + ARROWHEAD_HALF_WIDTH_PX * perpX, y: backY + ARROWHEAD_HALF_WIDTH_PX * perpY }
  const right: Point = { x: backX - ARROWHEAD_HALF_WIDTH_PX * perpX, y: backY - ARROWHEAD_HALF_WIDTH_PX * perpY }
  return [tip, left, right]
}

// Plain inclusive AABB intersection (canvas-model keeps its own equivalent
// private inside spatial-index.ts — four comparisons, not worth an export).
function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

interface BoundTerminals { start?: string; end?: string }

// One O(bindings) pass: arrowId -> which target each terminal is bound to.
// Rows with an unrecognized/missing props.terminal are skipped (the same
// rows resolveEndpoint's own `.find` would never match).
function boundTargetsByArrow(bindings: readonly Binding[]): Map<string, BoundTerminals> {
  const map = new Map<string, BoundTerminals>()
  for (const b of bindings) {
    const terminal = (b.props as { terminal?: string })?.terminal
    if (terminal !== 'start' && terminal !== 'end') continue
    const entry = map.get(b.fromId) ?? {}
    entry[terminal] = b.toId
    map.set(b.fromId, entry)
  }
  return map
}

// Cull check (c)'s endpoint approximation — deliberately NOT routeArrow:
// bound terminal -> the target's worldBounds center (the true anchor lies
// somewhere inside the target; over-inclusion absorbs the difference);
// unbound (or vanished-target, matching routeArrow's own fallback family) ->
// the arrow's own stored point, exactly resolveEndpoint's unbound arm.
function approxEndpoint(snapshot: CanvasDocument, arrow: Shape, terminal: 'start' | 'end', targetId: string | undefined): Point {
  if (targetId) {
    const target = snapshot.byId.get(targetId)
    if (target) return centroid(worldBounds(snapshot, target))
  }
  const localPt: Point = terminal === 'start' ? { x: 0, y: 0 } : ((arrow.props as { end?: Point })?.end ?? { x: 0, y: 0 })
  return toWorldPoint(snapshot, arrow, localPt)
}

export function Arrows({ snapshot, camera, viewportSize, index, routeFn }: ArrowsProps) {
  const allArrows = snapshot.shapes.filter((s) => s.kind === 'arrow')
  if (allArrows.length === 0) return null

  const viewport = viewportWorldBounds(camera, viewportSize)
  const visibleIds = new Set(queryViewport(index, viewport))
  const terminals = boundTargetsByArrow(snapshot.bindings)
  const route = routeFn ?? routeArrow

  const relevant = allArrows.filter((arrow) => {
    if (visibleIds.has(arrow.id)) return true // (a) own shape bbox on-screen
    const t = terminals.get(arrow.id)
    if (t && ((t.start !== undefined && visibleIds.has(t.start)) || (t.end !== undefined && visibleIds.has(t.end)))) return true // (b) a bound target on-screen
    // (c) approximate segment bbox, inflated by |bend| for the curve bulge.
    const p1 = approxEndpoint(snapshot, arrow, 'start', t?.start)
    const p2 = approxEndpoint(snapshot, arrow, 'end', t?.end)
    const rawBend = (arrow.props as { bend?: number })?.bend
    const bend = typeof rawBend === 'number' && Number.isFinite(rawBend) ? Math.abs(rawBend) : 0
    const bbox: Bounds = {
      minX: Math.min(p1.x, p2.x) - bend, minY: Math.min(p1.y, p2.y) - bend,
      maxX: Math.max(p1.x, p2.x) + bend, maxY: Math.max(p1.y, p2.y) + bend,
    }
    return boundsIntersect(bbox, viewport)
  })
  if (relevant.length === 0) return null

  return (
    <>
      {relevant.map((arrow) => {
        const routed = route(snapshot, arrow, snapshot.bindings)
        const startScreen = worldToScreen(camera, routed.start)
        const endScreen = worldToScreen(camera, routed.end)
        const midScreen = routed.mid ? worldToScreen(camera, routed.mid) : undefined
        const tail = midScreen ?? startScreen // the tangent's "from" point at t=1 — see module header
        const [tip, left, right] = arrowheadPoints(tail, endScreen)
        return (
          <g key={arrow.id} data-overlay="arrow" data-shape-id={arrow.id}>
            <path
              d={pathString(startScreen, endScreen, midScreen)}
              fill="none"
              stroke={ARROW_STROKE}
              strokeWidth={1.5}
            />
            <polygon
              data-overlay="arrowhead"
              points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
              fill={ARROW_STROKE}
            />
          </g>
        )
      })}
    </>
  )
}
