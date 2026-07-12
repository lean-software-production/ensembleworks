// One shape's positioned wrapper: looks up its component from shapeRegistry
// (or BoxShape, by fallback) and positions that component's rendered output
// on the page via a CSS transform derived from the shape's RIGID WORLD
// TRANSFORM.
//
// DEVIATION FROM THE PLAN'S LITERAL TEXT, ratified by the controller: the
// original task spec says a shape body is "positioned by worldBounds" —
// but worldBounds (geometry.ts) is the AXIS-ALIGNED BOUNDING BOX of a
// shape's (possibly rotated) rectangle, not the rectangle itself. Sizing and
// positioning a body by its AABB would draw every rotated shape as an
// axis-aligned box — visually WRONG the moment rotation != 0 (a 45°-rotated
// square would render as a bigger axis-aligned square covering the diamond's
// bounding area, not the diamond). Positioning instead by the shape's RIGID
// WORLD TRANSFORM (geometry.ts's `worldTransform`: composes the parent
// chain into one {x, y, rotation} — see its ROTATION CONVENTION block) and
// sizing by `localBounds` (the shape's own UNROTATED w×h) is the correct
// operation: render the unrotated box at its natural size, then let ONE CSS
// `rotate()` turn it into the true rotated rectangle on screen — exactly
// what geometry.ts's `worldCorners` computes analytically (rotate each
// unrotated corner, then translate).
//
// FLAT SIBLINGS, NOT NESTED PER PARENT (load-bearing, not a style choice):
// ShapeLayer renders every visible ShapeBody as a flat sibling inside
// WorldLayer's single transformed container — NEVER a child's ShapeBody
// nested inside its parent's ShapeBody DOM node. Nesting would DOUBLE-APPLY
// the parent's transform: `worldTransform` already COMPOSES the entire
// parent chain into the child's OWN world {x, y, rotation} (geometry.ts's
// composeTransform — "rotations add, position orbits"), so a child's CSS
// transform already encodes its parent's rotation/translation baked in. If
// the child's DOM node were ALSO a descendant of the parent's transformed
// node, the browser would apply the parent's CSS transform a SECOND time on
// top of the already-parent-inclusive value worldTransform computed —
// compounding to the wrong (roughly squared) position/rotation for any
// non-identity parent transform. Flat siblings mean each body's transform
// is applied exactly once, against WorldLayer's single camera transform,
// with no other transformed ancestor in between.
//
// CULLING vs POSITIONING (two different geometries, on purpose): ShapeLayer
// culls using `worldBounds` (the AABB) — correct for visibility, because
// "does this shape's bounding box intersect the viewport" is exactly what
// AABB intersection answers, and an over-inclusive answer (rendering a
// shape whose true rotated rect is actually just outside the viewport but
// whose AABB clips it) is harmless, matching spatial-index.ts's own
// STALENESS CONTRACT tradeoff for queryViewport. POSITIONING uses the rigid
// transform (this file). Different geometry for different jobs, not an
// inconsistency.
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import { localBounds, worldTransform } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { lookupShapeComponent } from './shapeRegistry.js'

export interface ShapeBodyContainerProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
}

/** Pure — exported so shape-layer.test.ts can pin the exact CSS transform
 * string without rendering anything, then separately confirm the rendered
 * component actually uses it. */
export function shapeBodyTransform(snapshot: CanvasDocument, shape: Shape): string {
  const t = worldTransform(snapshot, shape)
  return `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}rad)`
}

export function ShapeBody({ shape, snapshot, editorState }: ShapeBodyContainerProps) {
  const { maxX: w, maxY: h } = localBounds(shape) // localBounds is always {minX:0, minY:0, maxX:w, maxY:h} — geometry.ts's contract
  const Component = lookupShapeComponent(shape.kind)
  return (
    <div
      data-shape-id={shape.id}
      data-shape-kind={shape.kind}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: '0 0',
        transform: shapeBodyTransform(snapshot, shape),
      }}
    >
      <Component shape={shape} snapshot={snapshot} editorState={editorState} />
    </div>
  )
}
