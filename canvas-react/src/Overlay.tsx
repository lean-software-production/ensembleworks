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
// POINTER EVENTS (PERMANENT-BY-DESIGN, not a temporary state): the SVG root
// sets `pointer-events: none`, and nothing in this overlay will ever opt
// back in — the overlay is a pure paint layer, forever. Handle-dragging
// does NOT need DOM hit targets: the transform tool's own FSM already picks
// handles by PURE GEOMETRY — transform.ts's onIdle runs `hitHandle(...)`
// against the pointerdown's normalized SCREEN coordinates (the same
// InputEvent x/y the Viewport div already captures and forwards via
// onInput), resolving the nearest handle within HIT_TOLERANCE_PX with no
// DOM element involved. Wiring handle-dragging is therefore G3 making the
// transform tool active on the Viewport's EXISTING onInput stream — zero
// changes here, zero `pointer-events: auto` anywhere. Keeping every pointer
// event on the one Viewport div is also what keeps input handling
// single-sourced (one capture path, one normalization — dom-events.ts)
// instead of split across paint layers.
//
// PROPS CONTRACT (decided here, D4; extended in review round 2): the lean
// set every sub-component below actually needs, no more — `editorState` for
// `.selection` (Selection/Handles), `snapshot` for shape geometry
// (Selection/Handles/Arrows), `camera`/`viewportSize` for the screen-space
// conversion + guide/line extents, `index` for Arrows' viewport culling
// (G3 passes toolContext.index() — the same shared-index consumption
// pattern as ShapeLayer, with tool-context.ts's coherence guarantee that
// index() and snapshot() from one post-commit read cycle describe the same
// doc state), and an OPTIONAL `snapResult`.
//
// snapResult — PRODUCER LANDED (Unit 13, was previously unassigned): canvas-
// editor's select tool (tools/select.ts) now computes snapCandidates on every
// pointermove of a drag-translate gesture (excludedIds precomputed ONCE at
// drag start — see that file's SNAP-DURING-DRAG section) and carries the
// result on its own 'dragging' FSM state. canvas-ui's CanvasSurface reads it
// back out of the select tool's current ToolStates (canvas-editor's
// session/tool-loop.ts `currentSnapResult`) and threads it into THIS prop. Undefined whenever there's nothing to show (not
// dragging, a different tool active, or the drag hasn't computed its first
// snap yet) — SnapGuides.tsx's existing "renders nothing on undefined"
// handling needed no change at all.
import type { CanvasDocument, SpatialIndex } from '@ensembleworks/canvas-model'
import type { Camera, EditorState } from '@ensembleworks/canvas-editor'
import { isFixedSizeSelection, type SnapResult } from '@ensembleworks/canvas-model'
import { combinedWorldBounds, Selection } from './overlay/Selection.js'
import { Hover } from './overlay/Hover.js'
import { Handles } from './overlay/Handles.js'
import { SnapGuides } from './overlay/SnapGuides.js'
import { Arrows } from './overlay/Arrows.js'
import type { ViewportSize } from './ShapeLayer.js'

export interface OverlayProps {
  readonly editorState: EditorState
  readonly snapshot: CanvasDocument
  readonly camera: Camera
  readonly viewportSize: ViewportSize
  /** The shared spatial index (toolContext.index()) — consumed by Arrows'
   * culling broad phase. See the PROPS CONTRACT note above. */
  readonly index: SpatialIndex
  /** undefined unless the select tool's own FSM is currently mid-drag with a
   * computed snap — see the module header's "PRODUCER LANDED" note. */
  readonly snapResult?: SnapResult
}

// PAINT ORDER (later = on top; no z-index — same house convention as
// Viewport.tsx's Grid-before-WorldLayer): Arrows first (they're DOCUMENT
// CONTENT, conceptually "under" any selection chrome drawn on top of them),
// then the Hover indicator (a lighter-weight affordance that a real
// selection should visually outrank), then Selection outlines, then
// SnapGuides (a transient drag affordance that should stay visible over
// static outlines), then Handles topmost (the transform tool's geometric
// targets — nothing should occlude them). OURS: no tldraw-source citation
// for this exact order (v1 batches hover+selection into ONE stroke call at
// the same z — see ShapeIndicatorOverlayUtil.ts — so there's no source
// ordering to match here either way).
export function Overlay({ editorState, snapshot, camera, viewportSize, index, snapResult }: OverlayProps) {
  // combinedWorldBounds already returns null for an empty selection (zero
  // iterations never sets its internal `any` flag) — Handles' own `!bounds`
  // guard then renders nothing, so no separate empty-selection branch is
  // needed here.
  const combinedBounds = combinedWorldBounds(snapshot, editorState.selection)
  // UX honesty (pilot 4 ext): while a selected shape is being text-edited the
  // transform FSM refuses to grab its handles (transform.ts's modality guard),
  // so don't PAINT handles that won't respond. Purely cosmetic — the FSM
  // guard, not this hide, is what makes the invariant TRUE (Handles is a
  // pointer-events:none paint layer). Distinct step precisely because a
  // render-only fix is insufficient on its own (see E8's seam decision).
  const editingSelected =
    editorState.editingId !== null && editorState.selection.has(editorState.editingId)
  // note-fixed-size task (tldraw parity: NoteShapeUtil.hideResizeHandles()
  // returns true — a note's selection box shows no resize handles, only
  // rotate): don't PAINT corner/edge handles when EVERY selected shape is a
  // fixed-size kind (canvas-model's isFixedSizeSelection — currently just
  // 'note'). Same "render-only fix is insufficient alone" reasoning as the
  // editingSelected guard just above — transform.ts's own hittable-handle
  // filter is what makes the invariant TRUE; this is the matching cosmetic
  // half, so the painted chrome doesn't promise an interaction the FSM
  // refuses.
  const hideResizeHandles = isFixedSizeSelection(snapshot, editorState.selection)
  // arrow-handles task: a LONE selected 'arrow' shape gets Handles.tsx's
  // arrow-handle model instead of the box one — mirrors transform.ts's own
  // onIdle branch (see TransformState's module comment there) exactly, so
  // the painted chrome always matches what the FSM will actually respond to.
  const soleArrow = (() => {
    if (editorState.selection.size !== 1) return null
    const [id] = editorState.selection
    const shape = snapshot.byId.get(id!)
    return shape && shape.kind === 'arrow' ? shape : null
  })()
  return (
    <svg
      data-canvas-layer="overlay"
      width={viewportSize.width}
      height={viewportSize.height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
    >
      <Arrows snapshot={snapshot} camera={camera} viewportSize={viewportSize} index={index} currentPageId={editorState.currentPageId} />
      <Hover snapshot={snapshot} hover={editorState.hover} selection={editorState.selection} camera={camera} />
      <Selection snapshot={snapshot} selection={editorState.selection} camera={camera} />
      <SnapGuides snapResult={snapResult} camera={camera} viewportSize={viewportSize} />
      <Handles
        bounds={editingSelected ? null : combinedBounds}
        camera={camera}
        hideResizeHandles={hideResizeHandles}
        soleArrow={editingSelected ? null : soleArrow}
        snapshot={snapshot}
      />
    </svg>
  )
}
