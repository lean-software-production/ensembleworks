// Resizable pane task (docs/plans/2026-09-15-bb-thread-frame.md's "Resizable
// pane" section, owner request) — the bbthread pane's left edge is
// draggable, and width is a synced shape prop (`paneFraction`), not local UI
// state. A drag starting ON the divider (canvas-model's
// isPointOnBbthreadDivider — a BBTHREAD_DIVIDER_MARGIN-wide band straddling
// the pane's left edge, below the header) must resize the pane in place —
// NOT translate the shape, which is what a drag anywhere else in the solid
// pane does (see bbthread-pane-is-solid.ts) because the divider sits inside
// that same solid region.
//
// RED (recorded verbatim in the task report before the fix landed): the
// divider has no special handling yet, so a pointerdown at its location
// (600,300) lands squarely inside the existing solid-pane hit region
// (bbthreadPaneLocalBounds' local x in [600,900]) and the select tool's
// ordinary pane-is-solid translate path takes over — the drag moves the
// WHOLE SHAPE by the drag delta instead of resizing the pane, and
// `paneFraction` is never written at all.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadDividerDragResizesPane: Contract = {
  name: 'bbthread-divider-drag-resizes-pane',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    // A 900x600 bbthread at the origin. Default paneFraction (1/3) puts the
    // pane's left edge (the divider) at local x = 900 * (1 - 1/3) = 600.
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 600, y: 300 } },
    { kind: 'move', at: { ref: 'point', x: 450, y: 300 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(BBTHREAD_ID)
    if (d.dx !== 0 || d.dy !== 0) {
      return `a drag started on the bbthread's divider translated the whole shape (Δ=${JSON.stringify(d)}, expected {dx:0,dy:0}) -- the divider must resize the pane, not move the frame`
    }
    const fraction = obs.shapeProp(BBTHREAD_ID, 'paneFraction')
    if (typeof fraction !== 'number' || Math.abs(fraction - 0.5) > 1e-6) {
      return `dragging the divider from local x=600 to x=450 did not set paneFraction to 0.5 (got ${JSON.stringify(fraction)})`
    }
    return null
  },
}
