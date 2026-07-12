// The screen-space SVG overlay — per Viewport.tsx's STACKING CONTRACT, a
// SIBLING of WorldLayer placed AFTER it in DOM order (later siblings paint on
// top; no z-index anywhere in this package). Everything this component draws
// (selection outlines, handles, snap guides, arrows) is computed in WORLD
// space and converted to SCREEN coordinates via worldToScreen — the SVG
// itself has NO transform of its own, unlike WorldLayer's CSS camera
// transform. That is precisely what keeps stroke widths and handle sizes
// zoom-invariant (a 1px stroke is 1px on screen at any camera.z), which a
// world-space-transformed SVG could not give for free.
//
// POINTER EVENTS: the SVG root sets `pointer-events: none` — ALL pointer
// interaction stays on the Viewport div underneath (per the stacking
// contract; this overlay is purely a screen-space PAINT layer this unit, not
// an input target). Individual handle elements (Handles.tsx) MAY opt back
// in with their own `pointer-events: auto` in a LATER unit, once G3 wires
// actual handle-dragging (pointerdown on a handle -> the transform tool) —
// that hook is noted here, not wired: this unit draws, it does not listen.
//
// PROPS CONTRACT (decided here, D4): the lean set every sub-component below
// actually needs, no more — `editorState` for `.selection` (Selection/
// Handles), `snapshot` for shape geometry (Selection/Handles/Arrows),
// `camera`/`viewportSize` for the screen-space conversion + guide/line
// extents, and an OPTIONAL `snapResult` (only present mid-drag, when a tool
// is actively computing snap candidates — omitted the rest of the time, in
// which case SnapGuides renders nothing).
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import type { Camera, EditorState } from '@ensembleworks/canvas-editor'
import type { SnapResult } from '@ensembleworks/canvas-model'
import { combinedWorldBounds, Selection } from './overlay/Selection.js'
import { Handles } from './overlay/Handles.js'
import { SnapGuides } from './overlay/SnapGuides.js'
import type { ViewportSize } from './ShapeLayer.js'

export interface OverlayProps {
  readonly editorState: EditorState
  readonly snapshot: CanvasDocument
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  readonly snapResult?: SnapResult
}

// PAINT ORDER (later = on top; no z-index — same house convention as
// Viewport.tsx's Grid-before-WorldLayer): Selection outlines first, then
// SnapGuides (a transient drag affordance that should stay visible over
// static outlines), then Handles topmost (the actual interactive targets a
// later unit wires — nothing should occlude them). D5 adds Arrows BELOW
// Selection (arrows are document content, conceptually "under" any selection
// chrome drawn on top of them) — noted here since D5 lands in this same
// file. OURS: no tldraw-source citation for this exact order.
export function Overlay({ editorState, snapshot, camera, viewportSize, snapResult }: OverlayProps) {
  // combinedWorldBounds already returns null for an empty selection (zero
  // iterations never sets its internal `any` flag) — Handles' own `!bounds`
  // guard then renders nothing, so no separate empty-selection branch is
  // needed here.
  const combinedBounds = combinedWorldBounds(snapshot, editorState.selection)
  return (
    <svg
      data-canvas-layer="overlay"
      width={viewportSize.width}
      height={viewportSize.height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <Selection snapshot={snapshot} selection={editorState.selection} camera={camera} />
      <SnapGuides snapResult={snapResult} camera={camera} viewportSize={viewportSize} />
      <Handles bounds={combinedBounds} camera={camera} />
    </svg>
  )
}
