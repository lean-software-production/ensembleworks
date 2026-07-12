import { type CanvasDocument } from './document.js'
import { isPageId, type PageId } from './ids.js'
import { type Shape } from './shape.js'

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

// World-space AABB of a (possibly rotated, possibly nested) shape: transform
// the 4 corners of its local box and take the min/max. For an unrotated
// shape with unrotated ancestors this degenerates to pageBounds' result (see
// the cross-check in hit-test.test.ts).
export function worldBounds(doc: CanvasDocument, shape: Shape): Bounds {
  const t = worldTransform(doc, shape)
  const lb = localBounds(shape)
  const corners: Point[] = [
    { x: lb.minX, y: lb.minY }, { x: lb.maxX, y: lb.minY },
    { x: lb.maxX, y: lb.maxY }, { x: lb.minX, y: lb.maxY },
  ].map((p) => { const r = rotatePoint(p, t.rotation); return { x: r.x + t.x, y: r.y + t.y } })
  return {
    minX: Math.min(...corners.map((c) => c.x)), minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)), maxY: Math.max(...corners.map((c) => c.y)),
  }
}

// Is `point` (world/page space) inside this shape's rotated box? Inverse-
// transforms the point into the shape's local frame (undo translate, then
// undo rotate by rotating -rotation) and tests it against the axis-aligned
// local box — cheaper and exactly equivalent to testing the point against
// the rotated quad in world space. Inclusive of the boundary (matches
// worldBounds treating min/max as part of the box).
export function hitTestPoint(doc: CanvasDocument, shape: Shape, point: Point): boolean {
  const t = worldTransform(doc, shape)
  const local = rotatePoint({ x: point.x - t.x, y: point.y - t.y }, -t.rotation)
  const lb = localBounds(shape)
  return local.x >= lb.minX && local.x <= lb.maxX && local.y >= lb.minY && local.y <= lb.maxY
}

// The page a shape ultimately lives on, walking parents with the same guard<50
// tolerance as pageOrigin (malformed trees yield undefined, not an error).
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
