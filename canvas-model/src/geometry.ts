import { type CanvasDocument } from './document.js'
import { isPageId, type PageId } from './ids.js'
import { isFixedSizeKind, type Shape, type ShapeKind } from './shape.js'

// bb-thread-frame task — the kinds that behave like a FRAME for hit-testing
// (hollow interior + header band + edge-margin border): 'frame' itself, plus
// 'bbthread' (a frame-like container whose right third additionally renders
// a solid thread pane — see bbthreadPaneLocalBounds below). Every one of
// this file's frame-only branches (frameHeaderLocalBounds callers,
// isPointInFrameHeaderBand, hitTestPoint, shapeHitIndexBounds) is keyed off
// this predicate instead of a literal `kind === 'frame'` check, so bbthread
// gets the same header/edge-margin treatment for free, with nothing to keep
// in sync by hand.
export function isFrameLike(kind: ShapeKind): boolean {
  return kind === 'frame' || kind === 'bbthread'
}

// ============================================================================
// ROTATION CONVENTION (NORMATIVE — the renderer, the editor, and the Phase-5
// tldraw converter all depend on this agreeing):
//
//   A shape's local→parent transform is  translate(x, y) · rotate(rotation).
//   The pivot is the shape's LOCAL ORIGIN — the top-left of its unrotated box
//   (0,0)..(w,h) — matching tldraw's shape transform (Mat.Translate then
//   Mat.Rotate applied to that translation, i.e. rotation happens "in place"
//   around the shape's own (x,y)). rotation is in radians. Coordinates are
//   y-down screen space; rotation uses the ordinary math rotation matrix
//     x' = x·cos(θ) − y·sin(θ)
//     y' = x·sin(θ) + y·cos(θ)
//   applied to a LOCAL point BEFORE the translate is added — i.e. world =
//   rotate(local, rotation) + (x, y). (In y-down space this reads as a
//   clockwise turn on screen for positive θ; that's a labeling detail, not
//   a degree of freedom — this file, the editor, and the Phase-5 converter
//   must all use the same matrix, and this is it.)
//
//   World transform COMPOSES the parent chain: a child's transform is
//   relative to its parent's frame, so the world transform of a shape is
//   parentWorld ∘ (translate(x,y) · rotate(rotation)). Composing two pure
//   translate+rotate (rigid, no scale/skew) transforms yields another rigid
//   transform, so the whole chain collapses to a single {x, y, rotation} —
//   see `worldTransform` below. This is a deliberate scope limit: shapes have
//   no scale/skew in the envelope (canvas-model, Phase 3), so a 3-number
//   rigid transform is sufficient; a full affine matrix would be needed the
//   moment scale/skew enters the model.
//
//   Worked example (also asserted in hit-test.test.ts): a 100×100 box at
//   (0,0) rotated π/4 has corners (0,0), (70.71,70.71), (0,141.42),
//   (−70.71,70.71) → world bounds {minX:−70.71, minY:0, maxX:70.71,
//   maxY:141.42}.
// ============================================================================

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface Point { x: number; y: number }
/** A pure translate+rotate (no scale/skew) transform from a shape's local
 * frame to world (page) space. See the ROTATION CONVENTION block above. */
export interface RigidTransform { x: number; y: number; rotation: number }

const IDENTITY_TRANSFORM: RigidTransform = { x: 0, y: 0, rotation: 0 }

// Rotate a point by `theta` radians around the origin, per the NORMATIVE
// convention above (ordinary math rotation matrix, y-down coordinates).
function rotatePoint(p: Point, theta: number): Point {
  const cos = Math.cos(theta), sin = Math.sin(theta)
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

// The two edge-direction unit axes of a rectangle rotated by `theta` under
// the NORMATIVE convention above: the images of the local x/y unit vectors,
// i.e. the rotation matrix's columns [{cosθ, sinθ}, {−sinθ, cosθ}] (equal
// to rotatePoint({1,0}) and rotatePoint({0,1})). Exported so consumers that
// need the axes directly — e.g. spatial-index's SAT rectangle intersection
// projects onto exactly these — derive them HERE, from the same matrix
// rotatePoint applies, instead of re-deriving cos/sin locally and silently
// depending on this file's sign convention with no compiler link
// (drift-proofing: a convention change now breaks exactly one function, not
// one function plus a stealth copy in another file).
export function rotationAxes(theta: number): [Point, Point] {
  const cos = Math.cos(theta), sin = Math.sin(theta)
  return [{ x: cos, y: sin }, { x: -sin, y: cos }]
}

// Compose a parent's world rigid transform with a child's local (relative to
// parent) rigid transform, yielding the child's world rigid transform.
// Derivation: World(p) = parentWorld(rotate(p, local.rotation) + local.xy)
//           = rotate(rotate(p, local.rotation), parent.rotation)
//             + rotate(local.xy, parent.rotation) + parent.xy
//           = rotate(p, parent.rotation + local.rotation)
//             + [rotate(local.xy, parent.rotation) + parent.xy]
// — i.e. rotations add, and the child's local offset is rotated BY THE
// PARENT'S rotation before being added to the parent's translation. This is
// exactly "the parent's rotation applied to the child's local offset".
function composeTransform(parent: RigidTransform, local: RigidTransform): RigidTransform {
  const rotated = rotatePoint({ x: local.x, y: local.y }, parent.rotation)
  return { x: parent.x + rotated.x, y: parent.y + rotated.y, rotation: parent.rotation + local.rotation }
}

const DEFAULTS: Partial<Record<Shape['kind'], { w: number; h: number }>> = {
  geo: { w: 220, h: 120 }, frame: { w: 800, h: 600 },
  text: { w: 200, h: 40 }, image: { w: 200, h: 200 },
  bbthread: { w: 960, h: 600 },
}
// Rendered size, clamped to >= 0 so inverted bounds can never reach downstream
// rectangle math. Notes never store w/h in tldraw: their real rendered size is
// 200*scale × (200+growY)*scale. Geo stores w/h ALREADY scaled (GeoShapeUtil
// computes unscaledShapeW = w / scale — opposite convention from text) and
// renders height as h + growY, so no scale multiply there. Other kinds:
// props.w/h → per-kind default → 100, times props.scale (tldraw's uniform
// render multiplier) when present.
function size(s: Shape): { w: number; h: number } {
  const p = s.props as any
  const scale = typeof p?.scale === 'number' ? p.scale : 1
  if (s.kind === 'note') {
    const growY = typeof p?.growY === 'number' ? p.growY : 0
    return { w: Math.max(0, 200 * scale), h: Math.max(0, (200 + growY) * scale) }
  }
  const w = typeof p?.w === 'number' ? p.w : DEFAULTS[s.kind]?.w ?? 100
  const h = typeof p?.h === 'number' ? p.h : DEFAULTS[s.kind]?.h ?? 100
  if (s.kind === 'geo') {
    const growY = typeof p?.growY === 'number' ? p.growY : 0
    return { w: Math.max(0, w), h: Math.max(0, h + growY) }
  }
  return { w: Math.max(0, w * scale), h: Math.max(0, h * scale) }
}

// The shape's unrotated local box: (0,0)..(w,h), pivot at the local origin per
// the NORMATIVE convention above. Reuses `size()` (the same per-kind/DEFAULTS
// sizing pageBounds already uses) so kind defaults are defined in exactly one
// place: note falls back to 200×200 (200 base × scale 1, +0 growY), text to
// 200×40 (the existing DEFAULTS entry — chosen to match pageBounds/DEFAULTS
// rather than inventing a second, inconsistent text default).
export function localBounds(shape: Shape): Bounds {
  const { w, h } = size(shape)
  return { minX: 0, minY: 0, maxX: w, maxY: h }
}

// note-fixed-size task — true iff EVERY id in `ids` resolves to a shape whose
// kind is fixed-size (isFixedSizeKind — 'note', matching this file's own
// note special case in `size()` above: a note's rendered box is
// `200 * props.scale` and never reads props.w/h, so ResizeShapes' props.w/h
// scaling has nothing to act on for it). Consumed by BOTH the FSM-level
// suppression (canvas-editor's transform tool, which must never ARM a
// corner/edge handle for such a selection) and the paint-level suppression
// (canvas-react's Handles/Overlay, which must never DRAW one) — one shared
// predicate so the two can't silently drift apart, same reasoning as
// selectionHandles being the FSM's single source of truth for handle layout.
//
// TOLERANT, matching this package's "skip, never throw" discipline (see
// Overlay/transform.ts's own selection-bounds helpers): an id with no
// resolving shape (selection referencing a deleted shape) is simply skipped,
// neither proving nor disproving the predicate on its own. An EMPTY or
// entirely-vanished selection returns false — "every shape is fixed-size" is
// vacuously true over zero shapes, but a selection with nothing real in it
// has no handles to suppress in the first place, so false (don't suppress)
// is the useful answer here, not the logically-vacuous one.
export function isFixedSizeSelection(doc: CanvasDocument, ids: Iterable<string>): boolean {
  let any = false
  for (const id of ids) {
    const shape = doc.byId.get(id)
    if (!shape) continue
    any = true
    if (!isFixedSizeKind(shape.kind)) return false
  }
  return any
}

// This shape's world (page-space) rigid transform, composing the parent
// chain root-to-leaf (see composeTransform). Total by construction:
//   - Missing parent (byId can hold orphans mid-merge; repair() fixes them
//     later, but geometry must answer NOW): the walk simply stops climbing,
//     so the shape's own frame is composed against the identity transform —
//     equivalent to treating it as a page-root shape.
//   - Cycle: a visited-set breaks the climb the first time an id repeats, so
//     a cyclic parent chain still terminates (composed against whatever
//     partial chain was collected up to the repeat) instead of looping.
// Either way the result is always finite — never throws, never hangs.
export function worldTransform(doc: CanvasDocument, shape: Shape): RigidTransform {
  const chain: Shape[] = []
  const visited = new Set<string>()
  let cur: Shape | undefined = shape
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id)
    chain.push(cur)
    cur = doc.byId.get(cur.parentId)
  }
  // chain is leaf-first (shape, parent, grandparent, ...); compose root-first.
  let transform = IDENTITY_TRANSFORM
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i]!
    transform = composeTransform(transform, { x: s.x, y: s.y, rotation: s.rotation })
  }
  return transform
}

// The shape's 4 corners in WORLD space, in local-box order (top-left,
// top-right, bottom-right, bottom-left of the unrotated box — i.e. the same
// corners worldBounds takes the AABB of). Exposed on its own because exact
// (non-AABB) intersection tests — e.g. spatial-index's marquee 'intersect'
// mode — need the true rotated rectangle, not just its bounding box.
// `precomputedTransform` is an optional perf escape hatch: a caller that
// already has this shape's worldTransform (e.g. because it also needs
// `.rotation` for its own purposes, as queryMarquee's 'intersect' mode
// does) can pass it in to avoid a second walk up the parent chain.
export function worldCorners(doc: CanvasDocument, shape: Shape, precomputedTransform?: RigidTransform): Point[] {
  const t = precomputedTransform ?? worldTransform(doc, shape)
  const lb = localBounds(shape)
  return [
    { x: lb.minX, y: lb.minY }, { x: lb.maxX, y: lb.minY },
    { x: lb.maxX, y: lb.maxY }, { x: lb.minX, y: lb.maxY },
  ].map((p) => { const r = rotatePoint(p, t.rotation); return { x: r.x + t.x, y: r.y + t.y } })
}

// World-space AABB of a (possibly rotated, possibly nested) shape: the
// min/max of its worldCorners. For an unrotated shape with unrotated
// ancestors this degenerates to pageBounds' result (see the cross-check in
// hit-test.test.ts).
//
// ARROW SPECIAL CASE (Task arrow-body): an arrow's real "body" is the drawn
// start->end path, not a local (0,0)..(w,h) box — arrows carry no props.w/h,
// so size()'s DEFAULTS fallback (100x100) would otherwise hang a fixed box
// off the arrow's START point regardless of where its actual end/bound
// target is. See arrowPathBounds below for the path-following replacement.
export function worldBounds(doc: CanvasDocument, shape: Shape): Bounds {
  if (shape.kind === 'arrow') return arrowPathBounds(doc, shape)
  const corners = worldCorners(doc, shape)
  return {
    minX: Math.min(...corners.map((c) => c.x)), minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)), maxY: Math.max(...corners.map((c) => c.y)),
  }
}

// ============================================================================
// ARROW BOUNDS / HIT-TEST (Task arrow-body — worldBounds/hitTestPoint's
// kind === 'arrow' special case, self-contained in this file)
//
// An arrow's meaningful geometry is the path from its (possibly BOUND) start
// terminal to its (possibly BOUND) end terminal — exactly what arrow-route.ts's
// `routeArrow` computes for RENDERING. This block resolves the SAME two
// endpoints (bound terminal -> anchorToWorld against the CURRENT target;
// unbound -> the arrow's own stored point) but deliberately WITHOUT
// routeArrow's boundary-CLIPPING step (arrow-route.ts's clipToBoundary trims
// the VISIBLE line to stop at a bound target's edge — a rendering nicety,
// not a bounds/hit-test concern): the unclipped anchor point sits ON or
// inside the target's own box (nx/ny is clamped to [0,1] against that box),
// so using it makes this file's bounds/hit-test AT MOST slightly more
// generous than the visually-clipped line — never less — matching this
// whole codebase's established "over-inclusion is fine, omission is the
// real bug" posture (spatial-index.ts's STALENESS CONTRACT; Arrows.tsx's
// OVER-INCLUSION SEMANTICS, which takes the same shortcut — a bound
// terminal's WHOLE target worldBounds, not its exact clipped anchor — for
// its own culling bbox).
//
// NOT IMPLEMENTED VIA arrow-route.ts's `routeArrow` ON PURPOSE: arrow-route.ts
// already imports THIS file (toWorldPoint, worldCorners) and, transitively
// via snapping.ts's spatial-index.ts import, sits ABOVE spatial-index.ts in
// the package's dependency order; this file staying a self-contained leaf
// (no import of arrow-route.ts) avoids turning that into a real import
// cycle. The small duplication below (endpoint resolution, curve midpoint)
// is the accepted cost — same tradeoff Arrows.tsx already made for its own
// culling bbox rather than calling the exact (but more expensive/entangled)
// routeArrow.
// ============================================================================

// The RAW (unclipped) world point for one of an arrow's two terminals: the
// live anchor on its bound target if bound (and that target still
// resolves), else the arrow's own stored point (start: its own x/y; end:
// props.end as a local offset from x/y, defaulting to {x:0,y:0} — a
// degenerate zero-length arrow, never a throw).
function resolveArrowEndpointRaw(doc: CanvasDocument, arrow: Shape, terminal: 'start' | 'end'): Point {
  const binding = doc.bindings.find((b) => b.fromId === arrow.id && (b.props as { terminal?: string } | undefined)?.terminal === terminal)
  if (binding) {
    const target = doc.byId.get(binding.toId)
    if (target) {
      const anchor = (binding.props as { anchor?: { nx: number; ny: number } }).anchor ?? { nx: 0.5, ny: 0.5 }
      return anchorToWorld(doc, binding.toId, anchor)
    }
    // vanished target (binding row survives, toId no longer resolves) — fall
    // through to the arrow's own stored point, same fallback arrow-route.ts's
    // resolveEndpoint documents for this case.
  }
  const p = arrow.props as { end?: Point } | undefined
  const localPt: Point = terminal === 'start' ? { x: 0, y: 0 } : (p?.end ?? { x: 0, y: 0 })
  return toWorldPoint(doc, arrow, localPt)
}

// Path-following world bounds: the AABB of {start, end}, inflated by
// |bend| on both axes for a curved arrow. A quadratic Bézier lies entirely
// within the convex hull of {start, mid, end} (standard property), and
// curveMidRaw's control point is exactly `bend` away from the chord's
// midpoint along the perpendicular — so inflating the straight chord's AABB
// by |bend| on both axes is a safe (if not pixel-tight) superset of the
// curve, without needing the mid point's exact direction. Same shortcut
// Arrows.tsx's own culling bbox takes for the identical reason.
function arrowPathBounds(doc: CanvasDocument, arrow: Shape): Bounds {
  const start = resolveArrowEndpointRaw(doc, arrow, 'start')
  const end = resolveArrowEndpointRaw(doc, arrow, 'end')
  const rawBend = (arrow.props as { bend?: number } | undefined)?.bend
  const bend = typeof rawBend === 'number' && Number.isFinite(rawBend) ? Math.abs(rawBend) : 0
  return {
    minX: Math.min(start.x, end.x) - bend, minY: Math.min(start.y, end.y) - bend,
    maxX: Math.max(start.x, end.x) + bend, maxY: Math.max(start.y, end.y) + bend,
  }
}

// The quadratic curve's control point — same convention as arrow-route.ts's
// curveMid (perpendicular 90° rotation of the chord's unit direction,
// applied at its midpoint; zero-length chord falls back to the midpoint
// with no curvature). Duplicated here (not imported — see the module header)
// rather than left unbuilt, so `arrowHitTest` below can test a curved
// arrow's real path, not just its straight chord.
function curveMidRaw(start: Point, end: Point, bend: number): Point {
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2
  const dx = end.x - start.x, dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: mx, y: my }
  const ux = dx / len, uy = dy / len
  return { x: mx + -uy * bend, y: my + ux * bend }
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

// Distance from `p` to the quadratic Bézier through (start, mid, end),
// approximated by sampling the curve into straight sub-segments and taking
// the nearest one — a total, cheap approximation (no closed-form point-to-
// quadratic distance is needed for a click-precision hit test). 16 segments
// is generous for the gentle, single-curve arcs this shape supports (Phase-4
// scope — see arrow-route.ts's CURVE + CLIPPING ORDERING note).
function distanceToQuadratic(p: Point, start: Point, mid: Point, end: Point): number {
  const SAMPLES = 16
  let best = Infinity
  let prev = start
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    const it = 1 - t
    const cur: Point = {
      x: it * it * start.x + 2 * it * t * mid.x + t * t * end.x,
      y: it * it * start.y + 2 * it * t * mid.y + t * t * end.y,
    }
    best = Math.min(best, distanceToSegment(p, prev, cur))
    prev = cur
  }
  return best
}

// Click-precision slack for an arrow's line/curve, in WORLD units. This file
// has no notion of camera/zoom (canvas-editor's select tool converts a
// screen click to a world point BEFORE calling hitTestPoint), so this is
// necessarily a fixed world-space tolerance rather than a screen-pixel one —
// same tradeoff every other kind's exact (zero-margin) box hit test already
// makes. 8 mirrors canvas-editor/src/tools/transform.ts's HIT_TOLERANCE_PX
// (a "comfortable click target" in screen px at zoom 1, where world and
// screen units coincide) — OURS, tune alongside this file's other tunable
// constants (see localBounds' comment) if real usage says otherwise.
export const ARROW_HIT_MARGIN = 8

function arrowHitTest(doc: CanvasDocument, arrow: Shape, point: Point): boolean {
  const start = resolveArrowEndpointRaw(doc, arrow, 'start')
  const end = resolveArrowEndpointRaw(doc, arrow, 'end')
  const rawBend = (arrow.props as { bend?: number } | undefined)?.bend
  const bend = typeof rawBend === 'number' && Number.isFinite(rawBend) ? rawBend : 0
  const dist = bend === 0 ? distanceToSegment(point, start, end) : distanceToQuadratic(point, start, curveMidRaw(start, end, bend), end)
  return dist <= ARROW_HIT_MARGIN
}

// Polyline approximation of an arrow's RESOLVED path (same endpoint/curve
// resolution as arrowHitTest/arrowPathBounds above), for exact geometric
// tests that need real points along the path rather than just a bbox or a
// point-distance check — currently spatial-index.ts's queryMarquee
// 'intersect' narrow phase (Task arrow-body validator fix, gap 4): a
// marquee rectangle must be tested against the arrow's REAL LINE, not
// worldCorners' generic box-quad SAT test (worldCorners has no arrow special
// case — an arrow has no meaningful rotated box to test against, same
// reasoning as hitTestPoint's kind==='arrow' branch above).
// Straight (bend===0): exactly [start, end] — a marquee/segment intersection
// test needs no more. Curved: sampled into the SAME 16 sub-segments
// distanceToQuadratic already uses, so a marquee that would register a
// click-precision curve hit and a marquee-drag hit agree on one sampling
// density defined once.
export function arrowPathPoints(doc: CanvasDocument, arrow: Shape): Point[] {
  const start = resolveArrowEndpointRaw(doc, arrow, 'start')
  const end = resolveArrowEndpointRaw(doc, arrow, 'end')
  const rawBend = (arrow.props as { bend?: number } | undefined)?.bend
  const bend = typeof rawBend === 'number' && Number.isFinite(rawBend) ? rawBend : 0
  if (bend === 0) return [start, end]
  const mid = curveMidRaw(start, end, bend)
  const SAMPLES = 16
  const points: Point[] = [start]
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    const it = 1 - t
    points.push({
      x: it * it * start.x + 2 * it * t * mid.x + t * t * end.x,
      y: it * it * start.y + 2 * it * t * mid.y + t * t * end.y,
    })
  }
  return points
}

// Inverse-transform a WORLD point into `shape`'s LOCAL frame: undo the
// translate, then undo the rotate (by rotating -rotation) — the exact
// inverse of worldTransform + a forward rotate/translate. Used by
// hitTestPoint (test against the local box) and by snapping.ts's
// resolveArrowAnchor (Seam C7's normalized arrow anchors need this same
// operation), so it's factored out once rather than duplicated.
export function toLocalPoint(doc: CanvasDocument, shape: Shape, point: Point): Point {
  const t = worldTransform(doc, shape)
  return rotatePoint({ x: point.x - t.x, y: point.y - t.y }, -t.rotation)
}

// Forward-transform a LOCAL point (in `shape`'s own unrotated frame) into
// WORLD space — the exact inverse of toLocalPoint. Used by snapping.ts's
// anchorToWorld (the round-trip counterpart of resolveArrowAnchor).
export function toWorldPoint(doc: CanvasDocument, shape: Shape, point: Point): Point {
  const t = worldTransform(doc, shape)
  const r = rotatePoint(point, t.rotation)
  return { x: r.x + t.x, y: r.y + t.y }
}

// ============================================================================
// FRAME HIT-TEST (frame-interaction task, gaps 2/3/5): a frame's interior is
// HOLLOW — a click deep inside an empty frame must MISS (so the select tool
// starts a marquee there instead of dragging the whole frame + its
// children), while the frame stays selectable/draggable via a BORDER
// edge-margin band and a HEADER label band rendered above its top-left
// corner (canvas-react's FrameShape.tsx). This is the model-side half of
// that renderer's chrome — kept in sync with its HEADER_HEIGHT constant by
// this file's own comment (not a shared import: canvas-react may depend on
// canvas-model, never the reverse).
// ============================================================================

/** The frame header band's height, in WORLD units — mirrors canvas-react's
 * FrameShape.tsx `HEADER_HEIGHT` (24, itself v1's `--tl-frame-height`
 * tldraw.css constant). WORLD, not screen: this file has no notion of
 * camera/zoom (same caveat ARROW_HIT_MARGIN documents above), so a header
 * rendered as 24 CSS px inside WorldLayer's camera-scaled container is 24
 * world units at zoom 1 — exact at that zoom, a fixed-size approximation at
 * any other, same tradeoff every other pixel-ish tolerance in this file
 * already accepts. */
export const FRAME_HEADER_HEIGHT = 24

/** How close to a frame's border (in WORLD units, both inside and — via the
 * inclusive box test below — right up to the true edge) still counts as a
 * hit, keeping the frame itself selectable/draggable by its edge even
 * though its interior is hollow. Mirrors ARROW_HIT_MARGIN's "comfortable
 * click target" tradeoff/value (8) — this file's other pixel-ish
 * tolerance. */
export const FRAME_EDGE_MARGIN = 8

/** The frame's header band, in the frame's OWN local frame: a strip of
 * height FRAME_HEADER_HEIGHT sitting immediately ABOVE the frame's local
 * box (local y in [-FRAME_HEADER_HEIGHT, 0)), spanning the frame's full
 * width — an approximation of canvas-react's FrameShape.tsx header (which
 * clips to `maxWidth:'100%'` of the frame but can render NARROWER when the
 * name is short; over-inclusion here is the same accepted tradeoff this
 * whole file already takes for arrow hit margins/culling bounds — a
 * generous hit region is a UX nicety, never a correctness bug). Exported
 * for spatial-index.ts's index-bounds helper below, which needs the SAME
 * band to widen a frame's indexed bounds so a header click's grid cell
 * actually contains the frame as a candidate in the first place. */
export function frameHeaderLocalBounds(shape: Shape): Bounds {
  const lb = localBounds(shape)
  return { minX: lb.minX, minY: lb.minY - FRAME_HEADER_HEIGHT, maxX: lb.maxX, maxY: lb.minY }
}

/** True iff WORLD `point` falls in `shape`'s header band (frameHeaderLocalBounds)
 * — false for a non-frame kind, or for a point that lands on the frame's
 * body/border instead. Exposed on its own (distinct from hitTestPoint,
 * which treats header/border/interior-miss as one boolean) so a caller that
 * needs to distinguish WHICH part of a frame was hit — canvas-editor's
 * select tool, deciding whether a double-click opens the rename input
 * (frame-interaction task, gap 1) — doesn't have to re-derive the same
 * local-space band test. */
export function isPointInFrameHeaderBand(doc: CanvasDocument, shape: Shape, point: Point): boolean {
  if (!isFrameLike(shape.kind)) return false
  const local = toLocalPoint(doc, shape, point)
  const header = frameHeaderLocalBounds(shape)
  return local.x >= header.minX && local.x <= header.maxX && local.y >= header.minY && local.y <= header.maxY
}

// ============================================================================
// BBTHREAD PANE (bb-thread-frame task): a bbthread shape is a frame-like
// container (isFrameLike) whose right third — BELOW the header band — is a
// solid "thread pane" (the BB plugin's ThreadChat mount), unlike an ordinary
// frame's fully-hollow interior. `bbthreadWorkspaceLocalBounds` is the
// complementary left-two-thirds region (below the header) where captured
// children live, staying hollow exactly like a frame's interior.
// ============================================================================

/** The fraction of a bbthread's width given to the solid thread pane, from
 * the right edge. */
export const BBTHREAD_PANE_FRACTION = 1 / 3

/** The bbthread's thread-pane rect, in the shape's OWN local frame: the
 * right `BBTHREAD_PANE_FRACTION` of its width, BELOW the header band (local
 * y in [FRAME_HEADER_HEIGHT, h]). Meaningless for any other kind — callers
 * only invoke this once `shape.kind === 'bbthread'` is already established
 * (hitTestPoint below). */
export function bbthreadPaneLocalBounds(shape: Shape): Bounds {
  const lb = localBounds(shape)
  return {
    minX: lb.maxX * (1 - BBTHREAD_PANE_FRACTION), minY: FRAME_HEADER_HEIGHT,
    maxX: lb.maxX, maxY: lb.maxY,
  }
}

/** The bbthread's hollow workspace rect, in the shape's OWN local frame: the
 * left two-thirds of its width, BELOW the header band — the complement of
 * `bbthreadPaneLocalBounds` (same y-range, x from 0 up to the pane's left
 * edge). Where creation-time-captured children (isFrameLike's frame-capture
 * treatment) live. */
export function bbthreadWorkspaceLocalBounds(shape: Shape): Bounds {
  const lb = localBounds(shape)
  return {
    minX: lb.minX, minY: FRAME_HEADER_HEIGHT,
    maxX: lb.maxX * (1 - BBTHREAD_PANE_FRACTION), maxY: lb.maxY,
  }
}

// Is `point` (world/page space) inside this shape's rotated box? Inverse-
// transforms the point into local space (toLocalPoint) and tests it against
// the axis-aligned local box — cheaper and exactly equivalent to testing
// the point against the rotated quad in world space. Inclusive of the
// boundary (matches worldBounds treating min/max as part of the box).
//
// ARROW SPECIAL CASE (Task arrow-body): see worldBounds' comment — an arrow
// has no meaningful local box to test against, so this delegates to
// arrowHitTest (line/curve-proximity, not box containment) instead.
//
// FRAME-LIKE SPECIAL CASE (frame-interaction task, gaps 2/3/5; extended to
// 'bbthread' by isFrameLike, bb-thread-frame task): a frame-like shape hits
// iff the point falls in its HEADER band (frameHeaderLocalBounds, above —
// selects/drags the shape by its name label) OR within FRAME_EDGE_MARGIN of
// its border (selects/drags it by its edge) OR — bbthread only — inside its
// solid thread pane (bbthreadPaneLocalBounds) — the REMAINING interior is a
// deliberate MISS, so a marquee started there rubber-bands the shape's
// children instead of moving the shape itself. Every other kind keeps the
// original solid-box test unchanged (gap 5's broader "every kind"
// fill-awareness is explicitly NOT implemented here — scoped to frame-like
// kinds only, the high-impact case; see this task's report).
export function hitTestPoint(doc: CanvasDocument, shape: Shape, point: Point): boolean {
  if (shape.kind === 'arrow') return arrowHitTest(doc, shape, point)
  const local = toLocalPoint(doc, shape, point)
  const lb = localBounds(shape)
  if (isFrameLike(shape.kind)) {
    const header = frameHeaderLocalBounds(shape)
    if (local.x >= header.minX && local.x <= header.maxX && local.y >= header.minY && local.y <= header.maxY) return true
    if (shape.kind === 'bbthread') {
      const pane = bbthreadPaneLocalBounds(shape)
      if (local.x >= pane.minX && local.x <= pane.maxX && local.y >= pane.minY && local.y <= pane.maxY) return true
    }
    const inBox = local.x >= lb.minX && local.x <= lb.maxX && local.y >= lb.minY && local.y <= lb.maxY
    if (!inBox) return false
    return (
      local.x <= lb.minX + FRAME_EDGE_MARGIN || local.x >= lb.maxX - FRAME_EDGE_MARGIN ||
      local.y <= lb.minY + FRAME_EDGE_MARGIN || local.y >= lb.maxY - FRAME_EDGE_MARGIN
    )
  }
  return local.x >= lb.minX && local.x <= lb.maxX && local.y >= lb.minY && local.y <= lb.maxY
}

// The bounds spatial-index.ts buckets a shape under (Task frame-interaction,
// gap 2; extended to 'bbthread' by isFrameLike, bb-thread-frame task):
// identical to worldBounds for every kind EXCEPT frame-like ones, where it
// is widened to also cover the header band (frameHeaderLocalBounds) rotated
// into world space — otherwise a click on the header, which sits OUTSIDE
// worldBounds' own box, would hash to a grid cell that never lists the
// shape as a candidate at all, and hitTestPoint's header branch above would
// never even run. Deliberately NOT folded into worldBounds itself: worldBounds
// also feeds transform.ts's resize-handle placement and Selection.tsx's
// selection-outline box, where "the shape's real geometry" (not the header
// chrome) is the correct answer — widening THOSE would move resize handles
// and the outline up into the header, a regression this task doesn't own.
export function shapeHitIndexBounds(doc: CanvasDocument, shape: Shape): Bounds {
  const base = worldBounds(doc, shape)
  if (!isFrameLike(shape.kind)) return base
  const t = worldTransform(doc, shape)
  const header = frameHeaderLocalBounds(shape)
  const corners = [
    { x: header.minX, y: header.minY }, { x: header.maxX, y: header.minY },
    { x: header.maxX, y: header.maxY }, { x: header.minX, y: header.maxY },
  ].map((p) => { const r = rotatePoint(p, t.rotation); return { x: r.x + t.x, y: r.y + t.y } })
  return {
    minX: Math.min(base.minX, ...corners.map((c) => c.x)),
    minY: Math.min(base.minY, ...corners.map((c) => c.y)),
    maxX: Math.max(base.maxX, ...corners.map((c) => c.x)),
    maxY: Math.max(base.maxY, ...corners.map((c) => c.y)),
  }
}

// ============================================================================
// Arrow anchor resolution (Seam C7 dependency) — MOVED HERE from snapping.ts
// (Task arrow-body): resolveArrowEndpointRaw above (and arrow-route.ts's
// routeArrow) both need anchorToWorld, and snapping.ts itself depends on
// spatial-index.ts (for snapCandidates' queryViewport calls) — keeping
// anchorToWorld/resolveArrowAnchor there would force a real import cycle the
// moment arrow-route.ts (already relied on by spatial-index.ts's callers)
// needed them too. Both functions only ever needed geometry.ts's own
// primitives (toLocalPoint/toWorldPoint/localBounds), never spatial-index.ts,
// so moving them here keeps this file a leaf. snapping.ts re-exports both
// names so every existing `from './snapping.js'` import keeps working
// byte-compatibly.
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

// The page a shape ultimately lives on, walking parents with the same guard<50
// tolerance as pageOrigin (malformed trees yield undefined, not an error).
// This is READ-PATH tolerance, not the repair contract: it stops on the
// 'page:' PREFIX (a nonexistent page like 'page:ghost' matches) and gives up
// after 50 hops. repair.ts's pageAncestorId is the exact version — membership
// in doc.pages, an unbounded seen-set guard — for deciding where a rescued
// shape lands. Do not use pageIdOf to pick a repair write target.
export function pageIdOf(doc: CanvasDocument, s: Shape): PageId | undefined {
  let cur: Shape | undefined = s
  let guard = 0
  while (cur && guard++ < 50) {
    if (isPageId(cur.parentId)) return cur.parentId
    cur = doc.byId.get(cur.parentId)
  }
  return undefined
}

// Page-space top-left: sum this shape's x/y with every ancestor shape's x/y.
// Rotation ignored (unrotated-parents-only, matching server geometry.pagePoint).
function pageOrigin(doc: CanvasDocument, s: Shape): { x: number; y: number } {
  let x = s.x, y = s.y, guard = 0
  let parent = doc.byId.get(s.parentId)
  while (parent && guard++ < 50) { x += parent.x; y += parent.y; parent = doc.byId.get(parent.parentId) }
  return { x, y }
}

export function pageBounds(doc: CanvasDocument, s: Shape): Bounds {
  const o = pageOrigin(doc, s)
  const { w, h } = size(s)
  return { minX: o.x, minY: o.y, maxX: o.x + w, maxY: o.y + h }
}

export const centroid = (b: Bounds) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })

// Median of max(w,h) over the given shapes — the scale-relative unit the semantic
// layer measures gaps against (design: "gaps relative to median sticky size").
export function medianSize(shapes: readonly Shape[]): number {
  const sizes = shapes.map((s) => { const { w, h } = size(s); return Math.max(w, h) }).sort((a, b) => a - b)
  if (sizes.length === 0) return 100
  const mid = Math.floor(sizes.length / 2)
  return sizes.length % 2 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2
}
