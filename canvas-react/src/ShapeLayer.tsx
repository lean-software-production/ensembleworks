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
// CULLING UNMOUNTS BODIES (prominent warning for D8 and every stateful
// embed): a shape culled out of the viewport is not hidden — its ShapeBody
// (and everything the registered component rendered inside it) is
// UNMOUNTED, and remounted from scratch when it scrolls back in. For
// stateless bodies (BoxShape, note/text/geo renders) that is exactly
// right: cheapest possible off-screen cost, no correctness impact. For
// STATEFUL embeds it is destructive TODAY: panning a live terminal
// (xterm + websocket), an iframe, or a screenshare tile off-screen and
// back destroys and recreates its session/connection/DOM state. That
// keep-alive/suspend policy is D8's EmbedHost contract, NOT this layer's —
// culling stays dumb here by design. Until D8 lands, heavy shapes MUST NOT
// assume mount persistence across viewport exits.
//
// DEVIATION FROM THE PLAN'S LITERAL TEXT, noted here for the same reason
// ShapeBody.tsx documents its own: the task spec describes culling as
// `queryViewport(toolContext.index(), viewportWorldBounds)` — but
// tool-context.ts's exported `ToolContext` interface has NO `.index()`
// accessor and no `queryViewport` method; it exposes exactly `editor`,
// `snapshot()`, `hitTestTopmost()`, `queryMarquee()`, and `dispose()` (see
// that file — its internal `index`/`buildIndex`/`fresh()` machinery is a
// PRIVATE implementation detail of `createToolContext`, never returned to
// callers). Modifying canvas-editor's tool-context.ts to expose its
// internal index was out of scope for this seam (it's substrate owned by
// C4-C8/tool-context.ts, not Seam D) and unnecessary: canvas-model's
// `buildSpatialIndex`/`queryViewport` are already a direct, allowed
// dependency of this package, so ShapeLayer builds its OWN spatial index
// from the SAME `toolContext.snapshot()` every tool already reads, via
// `useMemo` keyed on the snapshot's reference. Because `snapshot()` is
// documented as stable (===) between doc commits (tool-context.ts's
// IDENTITY SEMANTICS — a fresh reference appears only on the first read
// after a commit), this `useMemo` rebuilds at the SAME cadence
// (once-per-commit, on first read) the STALENESS CONTRACT already mandates
// for a spatial index — it is a second index instance, not a second
// rebuild cadence. The alternative (having ShapeLayer share the tool's
// exact index object) would need a new accessor on ToolContext; this
// achieves the same asymptotic behavior without touching that file.
import { useMemo } from 'react'
import { buildSpatialIndex, queryViewport, type Bounds } from '@ensembleworks/canvas-model'
import { screenToWorld, type Camera, type ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from './use-editor-state.js'
import { ShapeBody } from './ShapeBody.js'

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export interface ShapeLayerProps {
  readonly toolContext: ToolContext
  readonly camera: Camera
  readonly viewportSize: ViewportSize
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

export function ShapeLayer({ toolContext, camera, viewportSize }: ShapeLayerProps) {
  const snapshot = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  // See DEVIATION note above: this index is OURS (canvas-model's own
  // buildSpatialIndex), rebuilt only when `snapshot` changes identity —
  // i.e. at most once per doc commit, never per render/pan/zoom.
  const index = useMemo(() => buildSpatialIndex(snapshot), [snapshot])
  const bounds = viewportWorldBounds(camera, viewportSize)
  const visibleIds = queryViewport(index, bounds)

  return (
    <>
      {visibleIds.map((id) => {
        const shape = snapshot.byId.get(id)
        if (!shape) return null // vanished between index build and this render — omit, never throw (matches the STALENESS CONTRACT's "omissions only" posture)
        return <ShapeBody key={id} shape={shape} snapshot={snapshot} editorState={editorState} />
      })}
    </>
  )
}
