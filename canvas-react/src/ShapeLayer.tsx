// Reads the doc snapshot (via the shared ToolContext) + camera, culls to
// what's actually visible, and renders one ShapeBody per surviving shape.
//
// TOOLCONTEXT OWNERSHIP: the `toolContext` prop is CALLER-OWNED — this
// component subscribes through it but never disposes it. The owner (G3,
// which constructs Editor + ToolContext once and shares them) MUST call
// `toolContext.dispose()` on unmount — see tool-context.ts's dispose() doc
// comment for the strict-mode/HMR leak this prevents (every undisposed
// context keeps its doc listener registered forever, re-marking itself
// dirty on every commit).
//
// CULLING UNMOUNTS BODIES (D8 RESOLVED — embed kinds route around this):
// a shape culled out of the viewport is not hidden — its ShapeBody (and
// everything the registered component rendered inside it) is UNMOUNTED,
// and remounted from scratch when it scrolls back in. For stateless bodies
// (BoxShape, note/text/geo renders) that is exactly right: cheapest
// possible off-screen cost, no correctness impact. For STATEFUL embeds
// (terminal/iframe/screenshare) it would be destructive — panning a live
// terminal (xterm + websocket) off-screen and back would destroy and
// recreate its session/connection/DOM state — so this layer does not
// render embed-kind shapes AT ALL (see the `isEmbedKind` filter below):
// they are exclusively `embed/EmbedLayer.tsx`'s job, a culling-EXEMPT
// sibling layer that stays mounted for the shape's whole lifetime in the
// doc and drives visual suspend/resume instead of mount/unmount (see
// `embed/embedLifecycle.ts` for the state machine and `embed/EmbedHost.tsx`
// for the wrapper). This layer's culling stays dumb BY DESIGN for every
// kind it still handles — that split (cull-and-unmount here, stay-mounted-
// and-suspend there) is the whole point of the isEmbedKind flag.
//
// CONSUMPTION NOTE (was a DEVIATION, now resolved — Seam D consolidation
// item queued from Unit 7's review): tool-context.ts now exposes
// `ToolContext.index()`, the SAME SpatialIndex the context already builds
// internally per commit — ShapeLayer previously built its OWN redundant
// index via `useMemo(buildSpatialIndex(snapshot))` because no accessor
// existed yet (see git history for that workaround). Reading
// `toolContext.index()` directly here (no local `useMemo`) is safe and
// correct because of tool-context.ts's own COHERENCE GUARANTEE: `index()`
// and `snapshot()` share one lazy `dirty` flag and are rebuilt TOGETHER by
// the same `fresh()` pass, so within one render — where this component
// reads `useDocSnapshot(toolContext)` (-> `toolContext.snapshot()`) and then
// `toolContext.index()` — both accessors are guaranteed to describe the
// IDENTICAL post-commit doc state; there is no way to observe one from a
// newer/older doc read than the other. No local memoization is needed
// because `index()` is itself already stable (===) between rebuilds, exactly
// like `snapshot()`.
import { orderForPaint, pageIdOf, queryViewport, type Bounds, type Shape } from '@ensembleworks/canvas-model'
import { screenToWorld, type Camera, type Intent, type ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from './use-editor-state.js'
import { ShapeBody } from './ShapeBody.js'
import { isEmbedKind } from './shapeRegistry.js'

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export interface ShapeLayerProps {
  readonly toolContext: ToolContext
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  /** See shapeRegistry.ts's ShapeBodyProps.dispatch doc comment — forwarded
   * verbatim to every ShapeBody this layer renders, exactly like `getText`
   * (derived from `toolContext` just below) is. UNLIKE getText, this is not
   * derived from toolContext at all: the caller (CanvasV2App) builds ONE
   * stable `dispatch` wrapping `editor.applyAll` and passes it straight
   * through as a prop — see that file's CONTENT-MEMO-safe construction.
   * Optional so callers/tests with nothing to dispatch (most of
   * shape-layer.test.ts) can omit it, exactly like getText. */
  readonly dispatch?: (intents: Intent[]) => void
}

/** The visible WORLD-space rectangle for a viewport of `size` screen pixels
 * under `camera` — the two screen-space corners (0,0) and (width,height),
 * each converted via input.ts's `screenToWorld` (the exact inverse of the
 * camera convention WorldLayer.tsx's transform implements). Camera.z is
 * always > 0 (camera.ts clamps zoom to [MIN_ZOOM, MAX_ZOOM], both positive),
 * so screenToWorld is order-preserving — the top-left screen corner maps to
 * the min world corner and bottom-right to the max, with no axis flip to
 * account for. */
export function viewportWorldBounds(camera: Camera, size: ViewportSize): Bounds {
  const topLeft = screenToWorld(camera, { x: 0, y: 0 })
  const bottomRight = screenToWorld(camera, { x: size.width, y: size.height })
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y }
}

export function ShapeLayer({ toolContext, camera, viewportSize, dispatch }: ShapeLayerProps) {
  const snapshot = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  // See CONSUMPTION NOTE above: the shared index, coherent with `snapshot`
  // by tool-context.ts's construction — no local memoization needed.
  const index = toolContext.index()
  const bounds = viewportWorldBounds(camera, viewportSize)
  const visibleIds = queryViewport(index, bounds)
  // PAGE FILTER (Task R1): keep only shapes whose PAGE ancestor is the
  // current page. `pageIdOf` (canvas-model/geometry.ts) walks a shape's
  // parent chain to its `page:` ancestor, so this is correct for a NESTED
  // shape too (a child of a frame on page:q resolves to page:q, not to its
  // direct parentId, which is the frame's id — never a page id). Applied to
  // the culled (visible) set BEFORE `orderForPaint`: dropping a cross-page
  // shape from the input never orphans an in-page child's ordering, because
  // orderForPaint already treats a shape whose parent is absent from its
  // input as a forest root (see that function's own header). Migration-safe
  // by construction: in a single-page room every shape's `pageIdOf` equals
  // that one page's id, which always equals `currentPageId` (E1 seeds it
  // from `opts.pageId`), so nothing is ever filtered out there.
  const currentPageId = editorState.currentPageId
  const onCurrentPage = visibleIds
    .map((id) => snapshot.byId.get(id))
    .filter((s): s is Shape => s !== undefined) // vanished between index build and this render — omit, never throw (matches the STALENESS CONTRACT's "omissions only" posture)
    .filter((s) => pageIdOf(snapshot, s) === currentPageId)
  // PAINT ORDER (Task R1 — supersedes the Task F1 depth-only fix):
  // queryViewport answers from a spatial hash grid — its return order is
  // cell-iteration order, NOT document/z order. Every rendered body is a
  // `position: absolute` DOM sibling (ShapeBody.tsx's FLAT SIBLINGS
  // design), so DOM order IS paint order. `orderForPaint` (canvas-model,
  // pure) replaces the old depth-only `orderParentBeforeChild` sort with a
  // DFS pre-order over this CULLED-AND-PAGE-FILTERED (visible, current-page)
  // set: each level's siblings — starting with this set's own forest roots
  // (a shape whose parent fell outside the set is treated as a root, never
  // dropped) — sorted by `(index ASC, id ASC)`, then recursively each
  // shape's in-set children. This subsumes the old parent-before-child
  // guarantee (a parent always precedes its descendants in DFS pre-order,
  // so an opaque container like FrameShape's fully-opaque body can never
  // occlude its own children) AND additionally makes the doc's `index`
  // field the visible z-order: a higher-index shape paints later (on top)
  // among its siblings, and the `(index, id)` tie-break gives every peer
  // the SAME deterministic order for the all-'a1' legacy corpus (no data
  // migration performed — see the z-order plan's Decision D-2) regardless
  // of queryViewport's iteration order, which still carries no correctness
  // meaning here.
  const visibleShapes = orderForPaint(onCurrentPage, snapshot.byId)

  return (
    <>
      {visibleShapes.map((shape) => {
        if (isEmbedKind(shape.kind)) return null // embed kinds are EmbedLayer's exclusive job — see module header
        // getText: reads through toolContext.editor.doc (the SAME "not an
        // import" posture TextEditor.tsx documents) so a text-capable
        // kind's body can render live LoroText content — see
        // shapeRegistry.ts's ShapeBodyProps.getText doc comment for the
        // review gap this closes. Guarded with a typeof check (not a bare
        // call) because several house tests (embed.test.ts,
        // embed-reconciler.test.ts) construct a deliberately minimal fake
        // `editor.doc` that implements only `subscribe` — exactly enough
        // for the paths THEY exercise; a hard call here would break every
        // one of those pre-existing fakes for a feature they don't test.
        return (
          <ShapeBody
            key={shape.id}
            shape={shape}
            snapshot={snapshot}
            editorState={editorState}
            getText={(sid) => (typeof toolContext.editor.doc.getText === 'function' ? toolContext.editor.doc.getText(sid) : '')}
            dispatch={dispatch}
          />
        )
      })}
    </>
  )
}
