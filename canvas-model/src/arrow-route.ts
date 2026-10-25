// Pure arrow-routing geometry: given an arrow shape + its bindings, compute
// the WORLD-space path a renderer draws (D5 in canvas-react) or a server-side
// exporter reuses — the whole reason this lives in canvas-model rather than
// canvas-editor: nothing here touches a CanvasDoc mutator or an Intent, it is
// a total function of a CanvasDocument snapshot.
//
// ============================================================================
// ARROW PROPS SCHEMA (OURS — documented here since shape.ts's propsByKind
// entry for 'arrow' is a passthrough `withText` looseObject, which validates
// but does not itself describe these fields):
//
//   shape.x, shape.y  — the arrow's own START point, in the arrow's PARENT
//     frame (exactly like every other shape's x/y) — set once by StartArrow
//     (canvas-editor/src/intents.ts) and never touched again by
//     CompleteArrow. This is the UNBOUND start position; when the start is
//     BOUND (see below), x/y stays a stale historical value and routing
//     ignores it in favor of the binding's live anchor.
//   props.end: { x, y } — the arrow's own END point, as a LOCAL OFFSET from
//     shape.x/shape.y (i.e. world-unbound-end = toWorldPoint(shape, {x:0,y:0}
//     + props.end) — see resolveEndpoint below). Set by CompleteArrow. This
//     is the UNBOUND end position, same relationship to the end binding as
//     x/y has to the start binding.
//   props.bend: number, default 0 — signed perpendicular offset (in the same
//     units as the arrow's own local frame) of the curve's control point
//     from the straight chord's midpoint. 0 = straight (kind: 'straight');
//     any other finite value = a single quadratic curve (kind: 'curved').
//     Parameterization matches tldraw's own arrow `bend` prop in spirit —
//     the installed @tldraw org's tlschema package, src/shapes/TLArrowShape.ts
//     (`bend: number`) and the installed tldraw package's
//     src/lib/shapes/arrow/curved-arrow.ts (`middle = med + u.per().mul(-bend)`,
//     where `med` is the chord midpoint, `u` the chord's unit direction, and
//     `.per()` its perpendicular) — same idea (signed perpendicular offset
//     of a control point from the chord midpoint), NOT a byte-identical
//     port: tldraw's curved arrow renders a true circular ARC through three
//     points (getCurvedArrowInfo, ~400 lines with per-terminal offset/clamp
//     logic for stroke width and mask clipping); ours is a single quadratic
//     Bézier through {start, mid, end} — Phase-4/5 territory per this task's
//     scope limit ("straight + single-curve only"). The Phase-5 tldraw
//     converter should therefore map tldraw's `bend` value straight across
//     (same sign, same units — both are "chord-perpendicular offset of a
//     mid control point") while accepting the visual curve shape itself
//     will differ (arc vs. quadratic) until any later phase upgrades this.
//   Bindings (canvas-doc's putBinding/listBindings; see intents.ts's
//     StartArrow/CompleteArrow) carry `props: { terminal: 'start'|'end',
//     anchor: { nx, ny } }` — nx/ny are the exact normalized 0..1 coordinates
//     canvas-model/src/snapping.ts's resolveArrowAnchor/anchorToWorld
//     produce and consume; id convention `binding:<arrowId>-start` /
//     `binding:<arrowId>-end` (intents.ts). A terminal is BOUND iff a
//     binding with fromId === arrow.id and props.terminal === that terminal
//     exists AND its toId still resolves in the doc; otherwise it's treated
//     as unbound (see the vanished-target fallback below).
// ============================================================================
import { type Binding, type CanvasDocument } from './document.js'
import { type Point, toWorldPoint, worldCorners } from './geometry.js'
import { anchorToWorld } from './snapping.js'
import { type Shape } from './shape.js'

export type ArrowRouteKind = 'straight' | 'curved'

export interface ArrowPath {
  readonly start: Point
  readonly end: Point
  /** Present iff `kind === 'curved'` — the quadratic Bézier's single control
   * point, in WORLD space, computed from the CLIPPED (visible) start/end —
   * see routeArrow's CURVE + CLIPPING ORDERING note below. */
  readonly mid?: Point
  readonly kind: ArrowRouteKind
}

type Terminal = 'start' | 'end'

// The (possibly-bound) terminal's RAW resolved point, before any boundary
// clipping — plus the target id to clip against, if this terminal IS bound
// to a still-resolving target. `boundTargetId: null` covers three cases
// uniformly (no clipping is attempted for any of them): genuinely unbound,
// no binding row for this terminal, and a binding whose toId no longer
// resolves (VANISHED-TARGET FALLBACK, documented below).
function resolveEndpoint(doc: CanvasDocument, arrow: Shape, terminal: Terminal, bindings: readonly Binding[]): { point: Point; boundTargetId: string | null } {
  const binding = bindings.find((b) => b.fromId === arrow.id && (b.props as { terminal?: string })?.terminal === terminal)
  if (binding) {
    const target = doc.byId.get(binding.toId)
    if (target) {
      const anchor = (binding.props as { anchor: { nx: number; ny: number } }).anchor
      return { point: anchorToWorld(doc, binding.toId, anchor), boundTargetId: binding.toId }
    }
    // VANISHED-TARGET FALLBACK (tolerance, documented per the task spec): the
    // binding row still exists (repair() sweeps dangling bindings, but this
    // function must answer NOW, mid-race, without waiting for a repair
    // pass) but its toId no longer resolves — fall back to the arrow's OWN
    // stored point for this terminal exactly as if it had never been bound,
    // rather than propagating anchorToWorld's own {x:0,y:0} degenerate
    // default (which would snap the arrow to the world origin — much worse
    // than "the last place a human actually put this endpoint").
  }
  const localPt: Point = terminal === 'start' ? { x: 0, y: 0 } : ((arrow.props as { end?: Point })?.end ?? { x: 0, y: 0 })
  return { point: toWorldPoint(doc, arrow, localPt), boundTargetId: null }
}

// Intersection of segment [p1,p2] with segment [p3,p4], both parameterized
// on [0,1] — standard 2D line-segment intersection via Cramer's rule.
// Returns null on no intersection (including PARALLEL — |denom| below a
// tight epsilon, which also safely covers a degenerate zero-length edge:
// d2x=d2y=0 forces denom to 0 too) or an intersection outside either
// segment's [0,1] range. `t` is the parameter along [p1,p2] — routeArrow
// uses this to pick the crossing closest to p1 (see clipToBoundary).
function intersectSegments(p1: Point, p2: Point, p3: Point, p4: Point): { t: number; point: Point } | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { t, point: { x: p1.x + d1x * t, y: p1.y + d1y * t } }
}

// Clip the segment [outside, inside] to the boundary of a convex quad given
// as 4 corners (worldCorners' order: TL, TR, BR, BL — the exact order does
// not matter here, only that consecutive entries are edges). `inside` is
// assumed to lie within (or on) the quad — true by construction for every
// caller here, since it always comes from anchorToWorld with an nx/ny
// clamped to [0,1] (snapping.ts's clamp01) against THIS SAME target's local
// box. Picks the crossing with the SMALLEST t (closest to `outside`) — the
// first time the outside->inside ray enters the shape, i.e. exactly the
// boundary point a viewer expects the visible arrow segment to stop at.
// TOTAL: a quad with no valid edge intersection (both points inside/outside
// on the same side, a degenerate zero-area quad, or the other endpoint also
// interior — see routeArrow's self-binding/overlap note) falls back to the
// unclipped `inside` point — never throws, never returns a non-finite point
// given finite inputs.
function clipToBoundary(outside: Point, inside: Point, corners: readonly Point[]): Point {
  let best: { t: number; point: Point } | null = null
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!, b = corners[(i + 1) % corners.length]!
    const hit = intersectSegments(outside, inside, a, b)
    if (hit && (best === null || hit.t < best.t)) best = hit
  }
  return best ? best.point : inside
}

// The quadratic curve's control point: `bend` is a signed distance
// perpendicular to the chord [start, end], applied at its midpoint — see
// the module header's ARROW PROPS SCHEMA note for the exact convention
// (matches tldraw's own bend semantics, different curve family). Perpendic-
// ular direction is the SAME 90° rotation geometry.ts's rotatePoint/
// rotationAxes apply ((x,y) -> (-y,x)), so a positive bend on a
// left-to-right horizontal chord curves the arrow DOWNWARD in this
// package's y-down convention — inlined here rather than imported since
// rotatePoint takes an angle, not a unit vector, and rotationAxes answers a
// different question (a shape's OWN rotated edge axes) than "perpendicular
// to this specific chord". Zero-length chord (start === end, e.g. a
// self-bound arrow whose two anchors coincide) has no defined direction —
// falls back to the chord's midpoint with zero curvature (visually a
// straight/degenerate point), never NaN.
function curveMid(start: Point, end: Point, bend: number): Point {
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2
  const dx = end.x - start.x, dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: mx, y: my }
  const ux = dx / len, uy = dy / len
  const px = -uy, py = ux // perpendicular: 90° rotation of the unit direction
  return { x: mx + px * bend, y: my + py * bend }
}

/**
 * Route `arrow` (a Shape with kind 'arrow') against `bindings` (its own
 * bindings — callers filter `doc.bindings`/`listBindings()` down to the ones
 * whose fromId === arrow.id, or pass every binding; resolveEndpoint's own
 * `.find` filters by fromId regardless, so passing the full doc-wide list is
 * safe, just does a little more scanning). Returns the visible WORLD-space
 * path: bound endpoints resolve against the CURRENT target position/anchor
 * (arrows follow their targets — arrows are re-routed on every call, not
 * cached from bind time), unbound endpoints resolve from the arrow's own
 * stored point, and BOTH kinds of bound endpoint get clipped to the target
 * shape's rotated boundary (worldCorners) rather than terminating at the
 * (possibly interior) anchor point itself.
 *
 * CURVE + CLIPPING ORDERING (OURS, documented): clipping happens FIRST
 * (against the straight line between the two RAW/unclipped resolved
 * points — see clipEndpoint below), and the quadratic's mid control point
 * is computed SECOND, from the CLIPPED (visible) endpoints. This is a
 * deliberate simplification against tldraw's own ordering (tldraw computes
 * its arc's bend from the RAW terminal/handle positions, then separately
 * intersects the resulting ARC against each bound shape's true geometry —
 * see curved-arrow.ts's getCurvedArrowInfo, cited in the module header):
 * doing the true thing here would mean clipping a QUADRATIC curve against a
 * rotated rectangle, which has no closed-form single-intersection answer
 * the way a straight chord does. Clipping the straight chord first keeps
 * clipToBoundary's single simple algorithm the ONLY clipping logic this
 * file needs, and the resulting curve — a quadratic through the two visible
 * endpoints — is a faithful, if not byte-identical, single-curve
 * approximation. Precise curve-vs-rect clipping is Phase-4 elbow/reflow
 * territory, out of this task's "straight + single-curve only" scope.
 */
export function routeArrow(doc: CanvasDocument, arrow: Shape, bindings: readonly Binding[]): ArrowPath {
  const startRes = resolveEndpoint(doc, arrow, 'start', bindings)
  const endRes = resolveEndpoint(doc, arrow, 'end', bindings)

  const clippedStart = startRes.boundTargetId
    ? clipEndpoint(doc, startRes.boundTargetId, startRes.point, endRes.point)
    : startRes.point
  const clippedEnd = endRes.boundTargetId
    ? clipEndpoint(doc, endRes.boundTargetId, endRes.point, startRes.point)
    : endRes.point

  const bend = typeof (arrow.props as { bend?: number })?.bend === 'number' ? (arrow.props as { bend: number }).bend : 0
  if (bend === 0) return { start: clippedStart, end: clippedEnd, kind: 'straight' }
  return { start: clippedStart, end: clippedEnd, mid: curveMid(clippedStart, clippedEnd, bend), kind: 'curved' }
}

// Clip one bound terminal's anchor point against its OWN target's rotated
// quad, using the straight line from the OTHER (raw) endpoint as the
// outside->inside ray (see clipToBoundary). `targetId` is guaranteed to
// resolve here (resolveEndpoint only sets boundTargetId when doc.byId.get
// succeeded), but the lookup is repeated defensively rather than threading
// the already-resolved Shape through, in case a future caller reorders
// these two functions — worldCorners' own contract on a missing shape is
// undefined, so this guards it with the same unclipped-fallback philosophy
// as clipToBoundary's own total contract. A ZERO-SIZE target (w=0 and/or
// h=0 — localBounds clamps negative sizes to 0, but a shape can legitimately
// have zero width/height) degenerates worldCorners to a single point or a
// zero-length edge; intersectSegments' |denom|<epsilon guard then finds no
// intersection on any of the 4 (degenerate) edges, so this falls through to
// the unclipped anchor point — total, never throws.
function clipEndpoint(doc: CanvasDocument, targetId: string, anchorPoint: Point, otherPoint: Point): Point {
  const target = doc.byId.get(targetId)
  if (!target) return anchorPoint
  const corners = worldCorners(doc, target)
  return clipToBoundary(otherPoint, anchorPoint, corners)
}
