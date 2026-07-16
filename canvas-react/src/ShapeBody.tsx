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
//
// MEMO STRATEGY (design constraint for Seam E's heavy embeds — direction,
// not implementation; Seam E implements it):
//   (a) PROVEN (code-read, canvas-doc/src/bridge.ts + loro-canvas-doc.ts):
//       every dumpModel() call materializes ALL-NEW Shape objects —
//       listShapes() maps readNode(n) per node, per call — so after ANY
//       commit, every shape in the fresh snapshot is a new reference even
//       if that shape's data didn't change. Reference-based React.memo
//       (shallow prop comparison) therefore NEVER bails out across
//       commits: `shape` is always "new".
//   (b) The whole-document `snapshot` prop makes this true INDEPENDENTLY:
//       it changes identity on every commit by design (tool-context.ts's
//       IDENTITY SEMANTICS — that's how consumers detect doc change), so
//       any component receiving it shallow-fails memo on every commit no
//       matter what happens to `shape`.
//   (c) CONSEQUENCE for heavy embeds (terminal/iframe/screenshare — any
//       body whose re-render is expensive or state-destructive): they MUST
//       wrap in React.memo with a CONTENT comparator —
//         (a, b) => a.shape.id === b.shape.id
//                && stableStringify(a.shape) === stableStringify(b.shape)
//       (canvas-model exports stableStringify; it's the same canonical
//       serialization makeDocument's duplicate-id dedupe already trusts) —
//       and SHOULD NOT read `snapshot` unless they truly render from
//       sibling/children data (roadmap/file-viewer plausibly do; a
//       terminal does not). `snapshot` is OPTIONAL-BY-CONVENTION for
//       exactly this reason: always passed, but touching it forfeits the
//       content-memo win. (`editorState` is cheap-and-cached — see
//       use-editor-state.ts — but a content comparator must still decide
//       which of its fields, if any, the embed cares about.)
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import { localBounds, worldTransform } from '@ensembleworks/canvas-model'
import type { EditorState, Intent } from '@ensembleworks/canvas-editor'
import { lookupShapeComponent } from './shapeRegistry.js'

export interface ShapeBodyContainerProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
  /** See shapeRegistry.ts's ShapeBodyProps.getText doc comment — forwarded
   * verbatim to the looked-up Component, never read by this wrapper div
   * itself. */
  readonly getText?: (id: string) => string
  /** See shapeRegistry.ts's ShapeBodyProps.dispatch doc comment — forwarded
   * verbatim to the looked-up Component, never called by this wrapper div
   * itself. */
  readonly dispatch?: (intents: Intent[]) => void
}

/** Pure — exported so shape-layer.test.ts can pin the exact CSS transform
 * string without rendering anything, then separately confirm the rendered
 * component actually uses it. */
export function shapeBodyTransform(snapshot: CanvasDocument, shape: Shape): string {
  const t = worldTransform(snapshot, shape)
  return `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}rad)`
}

export function ShapeBody({ shape, snapshot, editorState, getText, dispatch }: ShapeBodyContainerProps) {
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
        // Pilot 3 (interaction-contracts/cross-widget-selection.ts): a static
        // body's text must never join a NATIVE browser text selection — a
        // canvas drag selects shapes, not text (matching tldraw's own
        // canvas-wide suppression). Scoped to this static wrapper ONLY: the
        // editing textarea (TextEditor.tsx, a sibling overlay — never a
        // descendant of this div) and the embed bodies (EmbedLayer/EmbedHost,
        // disjoint by isEmbedKind) keep their own caret/selection untouched —
        // that structural scoping IS the editable-target exemption, no
        // per-event guard needed.
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <Component shape={shape} snapshot={snapshot} editorState={editorState} getText={getText} dispatch={dispatch} />
    </div>
  )
}
