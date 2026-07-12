// The transform tool: idle -> pointing(handle) -> resizing | rotating, back
// to idle on pointerup. Operates on the EXISTING selection only (it never
// changes `editor.get().selection` itself — that's the select tool's job);
// a pointerdown that misses every handle is a no-op here, by design.
//
// HANDLE MODEL (exported, single source of truth — D4's renderer draws
// FROM `selectionHandles`, never recomputing its own layout): 4 corners + 4
// edge midpoints + 1 rotate handle, offset above the top edge by
// ROTATE_HANDLE_OFFSET. `selectionHandles` is coordinate-space AGNOSTIC —
// it just lays out 9 points relative to whatever Bounds it's given, in
// THAT bounds' own space. This tool always calls it with a WORLD-space
// Bounds (the selection's axis-aligned worldBounds union — see
// selectionWorldBounds below), so a single ROTATED shape's handles come out
// axis-aligned to the WORLD, not rotated with the shape itself — an
// explicit SCOPE LIMIT (OURS): tldraw aligns a lone selected shape's
// handles to ITS OWN rotation; matching that is Phase 4/5 tldraw-parity
// polish, out of scope for the C8 task this file closes (which is about
// FRAME-CONVERSION correctness in editor.ts's Resize/RotateShapes, not
// this tool's handle-rendering fidelity for a rotated single shape — see
// worldToParentFrame's doc comment there for what IS now correct
// regardless of this handle-rendering simplification: a shape nested under
// a rotated PARENT still resizes/rotates world-correctly even though the
// handles this tool shows for it are axis-aligned).
import {
  centroid, worldBounds, type Bounds, type CanvasDocument, type Point,
} from '@ensembleworks/canvas-model'
import type { Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, worldToScreen, type Camera, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'
export type HandleKind = 'corner' | 'edge' | 'rotate'

export interface Handle {
  readonly id: HandleId
  readonly kind: HandleKind
  readonly point: Point
}

// Fixed offset (OURS, undocumented tldraw parity — tldraw's shipped product
// actually uses per-CORNER rotate handles, not a single top handle; see
// canvas-model/src/arrow-route.ts's citation-style precedent for how this
// package cites tldraw source, N/A here since there is no single-matching
// tldraw constant to cite against our deliberately simpler one-handle
// design) above the selection's top edge, in the SAME units as the `Bounds`
// passed to `selectionHandles` — i.e. if a caller passes WORLD-space bounds
// (as this file's tool does), the offset is 32 world units; a caller that
// instead wants a SCREEN-space-constant offset (so it doesn't visually
// shrink at high zoom) can pass SCREEN-space bounds instead — the function
// is coordinate-space agnostic by design (see the module header).
const ROTATE_HANDLE_OFFSET = 32

/**
 * Lay out the 9 selection handles (4 corners, 4 edge midpoints, 1 rotate)
 * for `bounds`, in `bounds`' OWN coordinate space (world, local, or screen —
 * this function does not care; see the module header). Corner/edge order is
 * clockwise from top-left, matching worldCorners' own TL/TR/BR/BL
 * convention for the 4 corners.
 */
export function selectionHandles(bounds: Bounds): Handle[] {
  const { minX, minY, maxX, maxY } = bounds
  const { x: midX, y: midY } = centroid(bounds)
  return [
    { id: 'nw', kind: 'corner', point: { x: minX, y: minY } },
    { id: 'n', kind: 'edge', point: { x: midX, y: minY } },
    { id: 'ne', kind: 'corner', point: { x: maxX, y: minY } },
    { id: 'e', kind: 'edge', point: { x: maxX, y: midY } },
    { id: 'se', kind: 'corner', point: { x: maxX, y: maxY } },
    { id: 's', kind: 'edge', point: { x: midX, y: maxY } },
    { id: 'sw', kind: 'corner', point: { x: minX, y: maxY } },
    { id: 'w', kind: 'edge', point: { x: minX, y: midY } },
    { id: 'rotate', kind: 'rotate', point: { x: midX, y: minY - ROTATE_HANDLE_OFFSET } },
  ]
}

/**
 * Which handle (if any) is under `screenPoint`, within `tolerancePx` SCREEN
 * pixels? Every handle's WORLD point (per selectionHandles' contract, this
 * tool always calls it that way — see the module header) is projected to
 * screen via `camera` (worldToScreen — the same NORMATIVE conversion every
 * other tool uses), so the tolerance is naturally zoom-correct: a 4px
 * screen tolerance is 4 screen pixels whether the camera is zoomed in or
 * out, exactly like input.ts's DRAG_THRESHOLD. Picks the CLOSEST handle
 * (not just the first within tolerance — handles can legitimately be close
 * together on a tiny selection), so overlapping handles resolve
 * deterministically rather than by array-iteration order. Returns null if
 * the closest handle is still farther than `tolerancePx`.
 */
export function hitHandle(handles: readonly Handle[], screenPoint: Point, camera: Camera, tolerancePx: number): Handle | null {
  let best: { handle: Handle; distSq: number } | null = null
  for (const h of handles) {
    const s = worldToScreen(camera, h.point)
    const dx = s.x - screenPoint.x, dy = s.y - screenPoint.y
    const distSq = dx * dx + dy * dy
    if (best === null || distSq < best.distSq) best = { handle: h, distSq }
  }
  if (best === null) return null
  return best.distSq <= tolerancePx * tolerancePx ? best.handle : null
}

// Hit tolerance in SCREEN pixels (OURS — a comfortable click target,
// slightly larger than DRAG_THRESHOLD's 4px drag-start distance since a
// handle is a small fixed target a user must land ON, not a "did you move"
// gesture threshold).
const HIT_TOLERANCE_PX = 8

const OPPOSITE: Partial<Record<HandleId, HandleId>> = {
  nw: 'se', ne: 'sw', se: 'nw', sw: 'ne', n: 's', s: 'n', e: 'w', w: 'e',
}

function unionBounds(list: readonly Bounds[]): Bounds | null {
  if (list.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of list) {
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
  }
  return { minX, minY, maxX, maxY }
}

// The current selection's combined WORLD bounds — the union of each
// selected shape's own worldBounds (rotation already baked in per-shape via
// worldCorners' AABB) — or null if the selection is empty or every id has
// since vanished (tolerant: a selection referencing a deleted shape id
// just drops it from the union, same "skip, never throw" discipline as
// editor.ts's TOLERANCE CONTRACT, even though this tool never mutates the
// doc itself).
function selectionWorldBounds(snapshot: CanvasDocument, ids: readonly string[]): Bounds | null {
  const list: Bounds[] = []
  for (const id of ids) {
    const s = snapshot.byId.get(id)
    if (s) list.push(worldBounds(snapshot, s))
  }
  return unionBounds(list)
}

function angleTo(center: Point, pt: Point): number {
  return Math.atan2(pt.y - center.y, pt.x - center.x)
}

// scaleFactor along one axis: how far `current` has moved from `anchor`
// relative to how far the handle's ORIGINAL position was from `anchor`, at
// gesture start. Degenerate span (original coincides with anchor — a
// zero-width/height selection being resized along THAT axis) returns 1 (no
// scale) rather than dividing by zero: TOLERANT, matching this package's
// house style of "skip/no-op the unrecoverable case, never throw or emit
// NaN/Infinity into an intent".
function axisScale(anchor: number, original: number, current: number): number {
  const span = original - anchor
  return span === 0 ? 1 : (current - anchor) / span
}

interface TargetScale { readonly scaleX: number; readonly scaleY: number }

// The ABSOLUTE (from-gesture-start) scale factor this handle+pointer
// position implies right now. `axisScaled` says which axes this handle
// even touches (edge handles: one axis, held at 1 on the other — see
// onEvent's handle.kind branch); `uniform` (shift held at gesture start, a
// CORNER-only concept) forces BOTH axes to follow the X ratio — OURS,
// documented decision: the horizontal axis "wins" and drives the other
// rather than e.g. averaging or picking whichever moved more, for the
// simplest possible deterministic rule.
function computeTargetScale(anchor: Point, originalHandle: Point, axisScaled: { readonly x: boolean; readonly y: boolean }, uniform: boolean, current: Point): TargetScale {
  const rawX = axisScaled.x ? axisScale(anchor.x, originalHandle.x, current.x) : 1
  const rawY = axisScaled.y ? axisScale(anchor.y, originalHandle.y, current.y) : 1
  return uniform ? { scaleX: rawX, scaleY: rawX } : { scaleX: rawX, scaleY: rawY }
}

// The PER-EVENT ResizeShapes factor to emit, given the ABSOLUTE
// (from-gesture-start) target scale and the ABSOLUTE scale already applied
// by every PRIOR event in this gesture (`last`). ResizeShapes composes
// MULTIPLICATIVELY against the doc's CURRENT (already-scaled) shape state
// (editor.ts's applyOne — same reasoning translate's INCREMENTAL delta
// exists for, but multiplicative instead of additive since scale composes
// by multiplication, not addition): applying `target` directly on every
// event would compound (target1 then target1*target2, not target2), so
// each event emits target/last, then updates last=target — see this tool's
// COMMIT CADENCE note below for why this must be per-event rather than
// batched into one intent. `last` at (or near) zero — the pointer dragged
// exactly onto the anchor line, a genuinely degenerate gesture position —
// falls back to emitting `target` directly rather than dividing by
// (near-)zero: TOLERANT, matching axisScale's own philosophy.
function incrementalRatio(last: number, target: number): number {
  return Math.abs(last) < 1e-9 ? target : target / last
}

interface Idle {
  readonly mode: 'idle'
}
interface Pointing {
  readonly mode: 'pointing'
  readonly downScreen: Point
  readonly handle: Handle
  readonly ids: readonly string[]
  readonly handlesAtStart: readonly Handle[]
  readonly shiftDown: boolean
}
interface Resizing {
  readonly mode: 'resizing'
  readonly ids: readonly string[]
  readonly anchorWorld: Point
  readonly originalHandleWorld: Point
  readonly axisScaled: { readonly x: boolean; readonly y: boolean }
  readonly uniform: boolean
  readonly lastScaleX: number
  readonly lastScaleY: number
}
interface Rotating {
  readonly mode: 'rotating'
  readonly ids: readonly string[]
  readonly centerWorld: Point
  readonly angleAtDown: number
  readonly lastAngle: number
}

export type TransformState = Idle | Pointing | Resizing | Rotating

const IDLE: TransformState = { mode: 'idle' }

export function createTransformTool(ctx: ToolContext): Tool<TransformState> {
  const editor = ctx.editor

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  return {
    initialState: IDLE,
    onEvent(state: TransformState, event: InputEvent): { state: TransformState; intents: Intent[] } {
      switch (state.mode) {
        case 'idle': return onIdle(state, event)
        case 'pointing': return onPointing(state, event)
        case 'resizing': return onResizing(state, event)
        case 'rotating': return onRotating(state, event)
      }
    },
  }

  function onIdle(state: Idle, event: InputEvent): { state: TransformState; intents: Intent[] } {
    if (event.type !== 'pointerdown') return { state, intents: [] }
    const ids = [...editor.get().selection]
    const bounds = selectionWorldBounds(ctx.snapshot(), ids)
    if (!bounds) return { state, intents: [] } // empty/all-vanished selection: nothing to grab a handle on
    const handlesAtStart = selectionHandles(bounds)
    const hit = hitHandle(handlesAtStart, { x: event.x, y: event.y }, editor.get().camera, HIT_TOLERANCE_PX)
    if (!hit) return { state, intents: [] } // miss: this tool never changes selection itself
    return {
      state: { mode: 'pointing', downScreen: { x: event.x, y: event.y }, handle: hit, ids, handlesAtStart, shiftDown: event.modifiers.shift },
      intents: [],
    }
  }

  function onPointing(state: Pointing, event: InputEvent): { state: TransformState; intents: Intent[] } {
    if (event.type === 'pointerup') return { state: IDLE, intents: [] } // click on a handle, no drag: no-op
    if (event.type !== 'pointermove') return { state, intents: [] }
    const here = crossedThreshold(state.downScreen, event)
    if (!here) return { state, intents: [] }

    if (state.handle.kind === 'rotate') {
      const centerWorld = centroid(unionBoundsOfHandles(state.handlesAtStart))
      const angleAtDown = angleTo(centerWorld, worldOf(state.downScreen))
      const totalNow = angleTo(centerWorld, worldOf(here)) - angleAtDown
      const intents: Intent[] = totalNow !== 0 ? [{ type: 'RotateShapes', ids: state.ids, center: centerWorld, dRadians: totalNow }] : []
      return { state: { mode: 'rotating', ids: state.ids, centerWorld, angleAtDown, lastAngle: totalNow }, intents }
    }

    // Corner or edge handle: resolve the OPPOSITE handle (fixed anchor) from
    // the SAME handlesAtStart list captured at pointerdown.
    const anchorId = OPPOSITE[state.handle.id]!
    const anchorWorld = state.handlesAtStart.find((h) => h.id === anchorId)!.point
    const originalHandleWorld = state.handle.point
    const axisScaled = state.handle.kind === 'corner'
      ? { x: true, y: true }
      : state.handle.id === 'n' || state.handle.id === 's'
        ? { x: false, y: true }
        : { x: true, y: false }
    const uniform = state.handle.kind === 'corner' && state.shiftDown

    const target = computeTargetScale(anchorWorld, originalHandleWorld, axisScaled, uniform, worldOf(here))
    const intents: Intent[] = [{ type: 'ResizeShapes', ids: state.ids, anchor: anchorWorld, scaleX: target.scaleX, scaleY: target.scaleY }]
    return {
      state: { mode: 'resizing', ids: state.ids, anchorWorld, originalHandleWorld, axisScaled, uniform, lastScaleX: target.scaleX, lastScaleY: target.scaleY },
      intents,
    }
  }

  // COMMIT CADENCE WATCH-ITEM (same note as select.ts's onDragging/create.ts's
  // dragging): each pointermove here becomes its own ResizeShapes/
  // RotateShapes intent, i.e. one doc.commit() per mouse move for the whole
  // gesture — the wire/undo-granularity cost is unmeasured until H3 profiles
  // it, same as every other drag-capable tool in this package.
  function onResizing(state: Resizing, event: InputEvent): { state: TransformState; intents: Intent[] } {
    if (event.type === 'pointermove' || event.type === 'pointerup') {
      const current = worldOf({ x: event.x, y: event.y })
      const target = computeTargetScale(state.anchorWorld, state.originalHandleWorld, state.axisScaled, state.uniform, current)
      const scaleX = incrementalRatio(state.lastScaleX, target.scaleX)
      const scaleY = incrementalRatio(state.lastScaleY, target.scaleY)
      const intents: Intent[] = (scaleX !== 1 || scaleY !== 1)
        ? [{ type: 'ResizeShapes', ids: state.ids, anchor: state.anchorWorld, scaleX, scaleY }]
        : []
      const next: TransformState = event.type === 'pointerup'
        ? IDLE
        : { ...state, lastScaleX: target.scaleX, lastScaleY: target.scaleY }
      return { state: next, intents }
    }
    return { state, intents: [] }
  }

  function onRotating(state: Rotating, event: InputEvent): { state: TransformState; intents: Intent[] } {
    if (event.type === 'pointermove' || event.type === 'pointerup') {
      const totalNow = angleTo(state.centerWorld, worldOf({ x: event.x, y: event.y })) - state.angleAtDown
      const dRadians = totalNow - state.lastAngle
      const intents: Intent[] = dRadians !== 0 ? [{ type: 'RotateShapes', ids: state.ids, center: state.centerWorld, dRadians }] : []
      const next: TransformState = event.type === 'pointerup' ? IDLE : { ...state, lastAngle: totalNow }
      return { state: next, intents }
    }
    return { state, intents: [] }
  }
}

// The rotate handle's own point sits OFFSET from the selection's bounds
// (ROTATE_HANDLE_OFFSET above the top edge — see selectionHandles), so the
// rotation center must come from the 8 corner/edge handles' own bounds, not
// from re-deriving a Bounds that would incorrectly include the offset
// rotate handle's point. Reconstructing a Bounds from handlesAtStart (8
// corner/edge points, excluding 'rotate') rather than threading the
// original Bounds through Pointing's state keeps Pointing's own shape to
// exactly "the 9 handles" with no redundant second copy of the same
// information.
function unionBoundsOfHandles(handles: readonly Handle[]): Bounds {
  const pts = handles.filter((h) => h.kind !== 'rotate').map((h) => h.point)
  return {
    minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)),
  }
}
