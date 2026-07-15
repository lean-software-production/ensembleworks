// D8 — the culling-EXEMPT sibling to ShapeLayer (the layer ShapeLayer.tsx's
// CULLING UNMOUNTS BODIES header points at). Renders EVERY embed-kind shape
// in the current doc snapshot (`isEmbedKind` — shapeRegistry.ts), in a
// flat-sibling position inside WorldLayer exactly like ShapeLayer's bodies,
// but WITHOUT the `queryViewport` cull: an embed shape mounts once when it
// first appears in the doc's snapshot and stays mounted for as long as it
// exists there — never because it scrolled off-screen, only because the
// shape itself was deleted (at which point `.map()` below simply stops
// producing an `<EmbedHost>` for it, an ordinary React unmount that fires
// `onUnmount` via EmbedHost's own effect cleanup — see that file).
// Visibility instead feeds EmbedHost's suspend/resume state machine
// (visual, never mount/unmount — see embedLifecycle.ts).
//
// SAME STACKING SLOT AS SHAPELAYER: a sibling of ShapeLayer inside
// WorldLayer (Viewport.tsx's STACKING CONTRACT) — DOM order between the two
// doesn't matter for correctness (they render disjoint sets of shape kinds,
// by `isEmbedKind`'s construction, so there is no overlap to worry about
// painting-order for).
//
// VISIBILITY CHECK: a direct AABB intersect of `worldBounds` (canvas-model/
// geometry.ts) against the same viewport-world-bounds ShapeLayer.tsx
// computes (`viewportWorldBounds`, exported from that file and reused here
// verbatim, not re-derived) — NOT `toolContext.index()`/`queryViewport`.
// `queryViewport`'s STALENESS CONTRACT (spatial-index.ts) is scoped to
// CULLING semantics, where an over-inclusive answer is deliberately
// harmless; EmbedLayer instead needs a simple, direct boolean per embed
// shape ("is THIS ONE visible right now") to feed the suspend timer, so a
// plain per-shape AABB intersect against the live snapshot's own
// `worldBounds` is simpler and exactly as correct for this narrower job —
// it also means EmbedLayer has no dependency on the shared SpatialIndex's
// rebuild cadence at all.
//
// H3 WATCH-ITEM (cost trajectory, same profile-first posture as
// Selection.tsx's H3 WATCH-ITEM and Arrows.tsx's viewport-cull note): this
// layer's cost is O(embed-kind shapes IN THE DOC) per render — a filter +
// worldBounds check over snapshot.shapes, plus one ALWAYS-MOUNTED EmbedHost
// (DOM subtree and all) per embed shape, on-screen or not; that
// always-mounted part is not an oversight, it is the layer's entire
// contract (mount persistence is WHY it exists). Accepted for v1 because
// embed counts are structurally small in practice: embeds are the
// heavyweight kinds (terminal/iframe/screenshare — each one a live
// session/process/stream a human deliberately created), so a room holds a
// handful, not the hundreds-to-thousands the note/geo layers are sized
// for. If dogfood ever produces embed-heavy rooms, the mitigations are
// known and contained (suspend already pauses the streams; an
// off-screen-longest LRU cap on mounted-but-suspended hosts would be the
// next lever) — whether any of that is needed is H3's to MEASURE, not this
// unit's to pre-build.
import type { Bounds, CanvasDocument } from '@ensembleworks/canvas-model'
import { worldBounds } from '@ensembleworks/canvas-model'
import type { Camera, ToolContext } from '@ensembleworks/canvas-editor'
import { useDocSnapshot, useEditorState } from '../use-editor-state.js'
import { viewportWorldBounds, type ViewportSize } from '../ShapeLayer.js'
import { isEmbedKind } from '../shapeRegistry.js'
import { EmbedHost } from './EmbedHost.js'
import type { EmbedLifecycle } from './embedLifecycle.js'

export interface EmbedLayerProps {
  readonly toolContext: ToolContext
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  /** Forwarded straight to every EmbedHost — see that file's `tick` prop
   * doc. One shared counter for every embed shape in the doc: the client
   * mount (G3) bumps it on its own ~1s cadence; embed.test.ts bumps it
   * manually. */
  readonly tick: number
  readonly suspendAfterTicks: number
  /** Per-shape lifecycle hooks, keyed by shape id — see EmbedHost.tsx's
   * "LIFECYCLE CALLBACKS VIA PROPS" note. Optional: omitted entirely by a
   * caller with no embed bodies that need pause/resume wiring yet (e.g.
   * this unit's own tests, or before Seam E ports real embed bodies). */
  readonly lifecycleFor?: (shapeId: string) => EmbedLifecycle | undefined
}

/** Pure — exported so embed.test.ts can pin visibility decisions
 * independently of rendering anything, same pattern as
 * ShapeLayer.tsx's viewportWorldBounds/shapeBodyTransform. */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

export function EmbedLayer({ toolContext, camera, viewportSize, tick, suspendAfterTicks, lifecycleFor }: EmbedLayerProps) {
  const snapshot: CanvasDocument = useDocSnapshot(toolContext)
  const editorState = useEditorState(toolContext.editor)
  const viewport = viewportWorldBounds(camera, viewportSize)

  return (
    <>
      {snapshot.shapes
        .filter((shape) => isEmbedKind(shape.kind))
        .map((shape) => {
          const visible = boundsIntersect(worldBounds(snapshot, shape), viewport)
          return (
            <EmbedHost
              key={shape.id}
              shape={shape}
              snapshot={snapshot}
              editorState={editorState}
              visible={visible}
              tick={tick}
              suspendAfterTicks={suspendAfterTicks}
              lifecycle={lifecycleFor?.(shape.id)}
            />
          )
        })}
    </>
  )
}
