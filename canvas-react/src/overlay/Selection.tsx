// Selection outlines: for each selected shape, its true ROTATED outline (the
// world quad worldCorners computes, NOT the axis-aligned worldBounds — a
// rotated shape's selection outline must hug the actual quad, not a
// bigger/smaller enclosing box). Multi-select additionally renders the
// combined AABB — the SAME union-of-worldBounds Bounds Handles.tsx lays its
// handles out from — so the outline a user sees around a multi-selection
// visually matches where the handles attach (this file exports
// `combinedWorldBounds` for exactly that sharing).
//
// tldraw MODEL NOTE (documented as OURS, not verified against tldraw's exact
// source the way camera.ts/arrow-route.ts cite specific files): per-shape
// outline PLUS a group bounding rect for multi-select is our understanding of
// tldraw's own selection treatment, not a byte-for-byte read of their
// SelectionShapesGroup rendering — flagged here per this task's own
// instruction to note it as ours if unverified.
//
// H3 WATCH-ITEM (perf, measured in review round 2): outlines cost
// O(selection size) worldCorners+worldToScreen per render — select-all on a
// 1k-shape doc measured ~8.7ms/render. Bounded by SELECTION size, not doc
// size (an empty/small selection costs ~nothing regardless of doc scale),
// so this is only reachable via large explicit selections. Whether
// selection-outline culling (skip outlines for selected shapes outside the
// viewport — the same queryViewport broad phase Arrows.tsx now uses) is
// worth adding is H3's to measure — same profile-first posture as
// WorldLayer's contain/will-change hints and the COMMIT CADENCE watch-items
// in canvas-editor's drag tools.
import type { ReactNode } from 'react'
import type { CanvasDocument, Bounds, Shape } from '@ensembleworks/canvas-model'
import { routeArrow, worldBounds, worldCorners } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { pathString } from './Arrows.js'

/**
 * ONE shape's outline as a screen-space SVG node — an arrow traces its
 * routed path (Arrows.tsx's SAME pathString, per the ARROW SPECIAL CASE note
 * below), every other kind traces its rotated worldCorners quad. Shared by
 * Selection (below) and Hover.tsx so "how do we draw a shape's indicator
 * outline" has exactly one implementation, not two that could drift apart —
 * the two callers differ only in stroke color/width and the `data-overlay`
 * tag a consumer/test selects by.
 */
export function shapeOutlineNode(
  snapshot: CanvasDocument,
  shape: Shape,
  camera: Camera,
  opts: { readonly key: string; readonly dataOverlay: string; readonly stroke: string; readonly strokeWidth: number },
): ReactNode {
  if (shape.kind === 'arrow') {
    const routed = routeArrow(snapshot, shape, snapshot.bindings)
    const start = worldToScreen(camera, routed.start)
    const end = worldToScreen(camera, routed.end)
    const mid = routed.mid ? worldToScreen(camera, routed.mid) : undefined
    return (
      <path
        key={opts.key}
        data-overlay={opts.dataOverlay}
        data-shape-id={shape.id}
        d={pathString(start, end, mid)}
        fill="none"
        stroke={opts.stroke}
        strokeWidth={opts.strokeWidth}
      />
    )
  }
  const points = worldCorners(snapshot, shape)
    .map((p) => worldToScreen(camera, p))
    .map((p) => `${p.x},${p.y}`)
    .join(' ')
  return (
    <polygon
      key={opts.key}
      data-overlay={opts.dataOverlay}
      data-shape-id={shape.id}
      points={points}
      fill="none"
      stroke={opts.stroke}
      strokeWidth={opts.strokeWidth}
    />
  )
}

export interface SelectionProps {
  readonly snapshot: CanvasDocument
  readonly selection: ReadonlySet<string>
  readonly camera: Camera
}

/**
 * The union of `ids`' own worldBounds (AABB, rotation already baked into
 * each shape's own worldBounds) — i.e. the same Bounds transform.ts's
 * PRIVATE (not exported from canvas-editor's barrel) `selectionWorldBounds`
 * computes for the transform tool's own handle layout. Reimplemented here
 * rather than imported because transform.ts never exports it (or its
 * `unionBounds` helper) — only `selectionHandles`/`hitHandle`/the `Handle`
 * type cross the canvas-editor package boundary. Exported so Handles.tsx (and
 * overlay.test.ts, hand-computing an expectation) share this EXACT
 * computation instead of two independent reimplementations drifting apart.
 *
 * TOLERANT, matching transform.ts's own "skip, never throw" discipline: an
 * id with no resolving shape in `snapshot` (selection referencing a deleted
 * shape) is silently skipped. Returns null iff every id is empty/vanished.
 */
export function combinedWorldBounds(snapshot: CanvasDocument, ids: Iterable<string>): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const id of ids) {
    const shape = snapshot.byId.get(id)
    if (!shape) continue
    const b = worldBounds(snapshot, shape)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
    any = true
  }
  return any ? { minX, minY, maxX, maxY } : null
}

// tldraw parity (SelectionForegroundOverlayUtil.ts's `options.lineWidth`,
// checked against source): a 1.5 SCREEN-space px stroke at every zoom — v1
// renders in world space with ctx scaled by zoom so its `1.5 / zoom` world
// units come out to 1.5px on screen; this overlay is already screen-space
// (Overlay.tsx's module header), so the plain constant IS that same
// zoom-invariant 1.5px with no division needed.
const SELECTION_STROKE_WIDTH = 1.5
const OUTLINE_STROKE = 'var(--canvas-selection, #4b8bf4)'
const BOUNDS_STROKE = 'var(--canvas-selection-bounds, #4b8bf4)'

export function Selection({ snapshot, selection, camera }: SelectionProps) {
  if (selection.size === 0) return null

  const outlines: ReactNode[] = []
  for (const id of selection) {
    const shape = snapshot.byId.get(id)
    if (!shape) continue // vanished between selection and render — omit, never throw
    outlines.push(
      shapeOutlineNode(snapshot, shape, camera, {
        key: id,
        dataOverlay: 'selection-outline',
        stroke: OUTLINE_STROKE,
        strokeWidth: SELECTION_STROKE_WIDTH,
      }),
    )
  }

  // Multi-select ALSO renders the combined AABB (the rect Handles.tsx's
  // handles attach to) — a single shape's own outline already IS that
  // information, so the extra rect would be redundant (and, for a rotated
  // single shape, visually confusing: a second axis-aligned box drawn right
  // on top of the rotated quad outline).
  //
  // tldraw parity: v1's own selection box (SelectionForegroundOverlayUtil's
  // `_renderSelectionBox`) is a plain SOLID `strokeRect` at the same
  // lineWidth as every other selection stroke — no dashed treatment. The
  // combined-bounds rect used to draw `strokeDasharray="4 3"` (flagged in
  // this task's brief as "not a v1 treatment"); dropped so multi-select
  // reads as the same solid chrome as a single selection.
  const combined = selection.size > 1 ? combinedWorldBounds(snapshot, selection) : null
  let boundsRect: ReactNode = null
  if (combined) {
    const tl = worldToScreen(camera, { x: combined.minX, y: combined.minY })
    const br = worldToScreen(camera, { x: combined.maxX, y: combined.maxY })
    boundsRect = (
      <rect
        data-overlay="selection-bounds"
        x={Math.min(tl.x, br.x)}
        y={Math.min(tl.y, br.y)}
        width={Math.abs(br.x - tl.x)}
        height={Math.abs(br.y - tl.y)}
        fill="none"
        stroke={BOUNDS_STROKE}
        strokeWidth={SELECTION_STROKE_WIDTH}
      />
    )
  }

  return (
    <>
      {outlines}
      {boundsRect}
    </>
  )
}
