// The hovered-shape indicator — tldraw parity target: tldraw's own
// ShapeIndicatorOverlayUtil strokes the shape under the cursor at 1.5 SCREEN
// px in the theme's selectionStroke color whenever the select tool is
// idle/editing, the pointer is over the canvas, AND the hovered shape ISN'T
// already selected
// (its own selection outline already gives that feedback — see that file's
// `!idsToDisplay.includes(hovered)` guard). canvas-editor's select tool
// already computes and stores this (editor.ts's `hover: string | null`,
// tools/select.ts's `SetHover` on every idle pointermove) — this component's
// entire job is painting the value that was already being thrown away (this
// task's brief: "State is computed and thrown away").
//
// Reuses Selection.tsx's `shapeOutlineNode` (arrow-vs-polygon dispatch) so
// hovering an arrow traces its routed path exactly like selecting one does —
// one outline implementation, two colors/consumers.
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import type { Camera } from '@ensembleworks/canvas-editor'
import { shapeOutlineNode } from './Selection.js'

export interface HoverProps {
  readonly snapshot: CanvasDocument
  /** editorState.hover, threaded straight through — null means "nothing
   * hovered" (idle-but-off-canvas, a non-select tool active, etc). */
  readonly hover: string | null
  /** editorState.selection — a hovered id that's ALSO selected renders no
   * indicator here (tldraw parity: the selection outline already covers
   * it; a second ring on top would be redundant/visually noisy). */
  readonly selection: ReadonlySet<string>
  readonly camera: Camera
}

// tldraw parity (ShapeIndicatorOverlayUtil.ts's `options.lineWidth`): 1.5
// SCREEN px at every zoom — see Selection.tsx's SELECTION_STROKE_WIDTH
// comment for why no zoom division is needed in this already-screen-space
// overlay.
const HOVER_STROKE_WIDTH = 1.5
const HOVER_STROKE = 'var(--canvas-hover, #4b8bf4)'

export function Hover({ snapshot, hover, selection, camera }: HoverProps) {
  if (hover === null) return null
  if (selection.has(hover)) return null // already selected — its own outline covers it
  const shape = snapshot.byId.get(hover)
  if (!shape) return null // vanished between hover-set and render — omit, never throw

  return shapeOutlineNode(snapshot, shape, camera, {
    key: hover,
    dataOverlay: 'hover-indicator',
    stroke: HOVER_STROKE,
    strokeWidth: HOVER_STROKE_WIDTH,
  })
}
