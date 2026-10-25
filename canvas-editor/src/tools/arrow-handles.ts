// Arrow-terminal/bend handle geometry — the arrow-kind analogue of
// transform.ts's `selectionHandles`/`hitHandle` pair. A SELECTED ARROW (and
// only a lone selected arrow — see select-and-transform.ts's composite and
// transform.ts's onIdle branch that consumes this module) shows THREE
// handles instead of the usual 8 resize + 1 rotate: `start`/`end` (the
// arrow's two terminals — tldraw parity: ArrowShapeUtil.tsx's `getHandles`,
// `ArrowHandles.Start`/`ArrowHandles.End`) and `mid` (the curve's virtual
// midpoint handle — tldraw's `ArrowHandles.Middle`, present for the 'arc'
// kind; this package has no elbow kind at all, so `mid` is unconditional).
//
// WORLD-SPACE, ROUTED (not raw props): every handle sits at the arrow's
// CURRENT ROUTED position (`routeArrow`, canvas-model/src/arrow-route.ts) —
// i.e. a BOUND terminal's handle tracks its target's live anchor + boundary
// clip, exactly what's actually drawn (canvas-react/src/overlay/Arrows.tsx
// renders from the same routeArrow call). Grabbing a handle therefore always
// starts from where the user visually sees it, never a stale stored x/y.
import { routeArrow, type CanvasDocument, type Point, type Shape } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '../input.js'

export type ArrowHandleId = 'start' | 'end' | 'mid'

export interface ArrowHandle {
  readonly id: ArrowHandleId
  readonly point: Point
}

/** The 3 handles for `arrow`, in WORLD space, at its CURRENT routed
 * position. `mid` is the curve control point when bent (`routed.mid`), or
 * the plain chord midpoint when straight (bend === 0 has no `mid` in
 * `ArrowPath` — see arrow-route.ts's `routeArrow`, which only sets `mid` for
 * `kind: 'curved'`) — a straight arrow's mid handle therefore starts
 * exactly on the line, matching tldraw's own "grab the middle of a straight
 * line to start bending it" affordance. */
export function arrowHandles(doc: CanvasDocument, arrow: Shape): ArrowHandle[] {
  const routed = routeArrow(doc, arrow, doc.bindings)
  const mid = routed.mid ?? { x: (routed.start.x + routed.end.x) / 2, y: (routed.start.y + routed.end.y) / 2 }
  return [
    { id: 'start', point: routed.start },
    { id: 'end', point: routed.end },
    { id: 'mid', point: mid },
  ]
}

/** Which arrow handle (if any) is under `screenPoint`, within `tolerancePx`
 * SCREEN pixels — same closest-within-tolerance contract as transform.ts's
 * `hitHandle` (deliberately NOT reused directly: `Handle.id` is typed to the
 * 9-member `HandleId` union there, `ArrowHandle.id` to this module's
 * distinct 3-member one — reusing would need an unsafe cast either way, and
 * this is a five-line function). */
export function hitArrowHandle(handles: readonly ArrowHandle[], screenPoint: Point, camera: Camera, tolerancePx: number): ArrowHandleId | null {
  let best: { id: ArrowHandleId; distSq: number } | null = null
  for (const h of handles) {
    const s = worldToScreen(camera, h.point)
    const dx = s.x - screenPoint.x, dy = s.y - screenPoint.y
    const distSq = dx * dx + dy * dy
    if (best === null || distSq < best.distSq) best = { id: h.id, distSq }
  }
  if (best === null) return null
  return best.distSq <= tolerancePx * tolerancePx ? best.id : null
}

/** Invert `curveMid` (arrow-route.ts): given the (routed, CLIPPED) chord
 * `start`/`end` and the mid handle's CURRENT dragged world point `current`,
 * return the signed perpendicular offset from the chord's midpoint that
 * reproduces `current` (or the closest point on that perpendicular line to
 * it — same "project onto the bend axis" posture as tldraw's own
 * `onArcMidpointHandleDrag`, checked against source: node_modules/tldraw/
 * src/lib/shapes/arrow/ArrowShapeUtil.tsx's `Vec.NearestPointOnLineSegment`
 * + signed `Vec.Dist`/`Vec.Clockwise` — ours is the same dot-product
 * projection, just against an unbounded line rather than a clamped
 * segment). Degenerate zero-length chord (start === end) has no defined
 * perpendicular direction — returns 0 (no bend), matching `curveMid`'s own
 * degenerate fallback (it returns the coincident midpoint with no offset
 * applied either). NOTE: checked against tldraw's real source — it does
 * NOT snap back to straight near the centre; the v1-audit brief's "snaps
 * back to straight near centre" claim does not hold for the shipped
 * `onArcMidpointHandleDrag`, so this function does not add a snap either. */
export function bendFromPoint(start: Point, end: Point, current: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return 0
  const ux = dx / len, uy = dy / len
  const px = -uy, py = ux // perpendicular unit vector — same 90° rotation convention curveMid uses
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2
  return (current.x - mx) * px + (current.y - my) * py
}
