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
import type { ReactNode } from 'react'
import type { CanvasDocument, Bounds } from '@ensembleworks/canvas-model'
import { worldBounds, worldCorners } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'

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

const OUTLINE_STROKE = 'var(--canvas-selection, #4b8bf4)'
const BOUNDS_STROKE = 'var(--canvas-selection-bounds, #4b8bf4)'

export function Selection({ snapshot, selection, camera }: SelectionProps) {
  if (selection.size === 0) return null

  const outlines: ReactNode[] = []
  for (const id of selection) {
    const shape = snapshot.byId.get(id)
    if (!shape) continue // vanished between selection and render — omit, never throw
    const points = worldCorners(snapshot, shape)
      .map((p) => worldToScreen(camera, p))
      .map((p) => `${p.x},${p.y}`)
      .join(' ')
    outlines.push(
      <polygon
        key={id}
        data-overlay="selection-outline"
        data-shape-id={id}
        points={points}
        fill="none"
        stroke={OUTLINE_STROKE}
        strokeWidth={1}
      />,
    )
  }

  // Multi-select ALSO renders the combined AABB (the rect Handles.tsx's
  // handles attach to) — a single shape's own outline already IS that
  // information, so the extra rect would be redundant (and, for a rotated
  // single shape, visually confusing: a second axis-aligned box drawn right
  // on top of the rotated quad outline).
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
        strokeWidth={1}
        strokeDasharray="4 3"
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
