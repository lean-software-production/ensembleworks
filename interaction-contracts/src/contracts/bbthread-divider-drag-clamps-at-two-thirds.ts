// Resizable pane task (docs/plans/2026-09-15-bb-thread-frame.md's "Resizable
// pane" section) — companion to bbthread-divider-drag-resizes-pane: a drag
// that would push the pane WIDER than BBTHREAD_PANE_MAX_FRACTION (2/3) must
// clamp there instead of tracking the cursor past it (canvas-model's
// `paneFractionOf`/canvas-editor's `resizingPane` mode both clamp to
// [BBTHREAD_PANE_MIN_FRACTION, BBTHREAD_PANE_MAX_FRACTION]).
//
// RED (recorded verbatim in the task report before the fix landed): same
// root cause as bbthread-divider-drag-resizes-pane — the divider lies in the
// solid pane, so the drag translates the whole shape instead of resizing
// anything, and `paneFraction` is never written.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadDividerDragClampsAtTwoThirds: Contract = {
  name: 'bbthread-divider-drag-clamps-at-two-thirds',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    // Same 900x600 bbthread, divider at local x = 600 (default paneFraction 1/3).
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 600, y: 300 } },
    // local x=100 would want paneFraction (900-100)/900 = 8/9, well past the
    // 2/3 max -- must clamp there instead.
    { kind: 'move', at: { ref: 'point', x: 100, y: 300 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(BBTHREAD_ID)
    if (d.dx !== 0 || d.dy !== 0) {
      return `a drag started on the bbthread's divider translated the whole shape (Δ=${JSON.stringify(d)}, expected {dx:0,dy:0}) -- the divider must resize the pane, not move the frame`
    }
    const fraction = obs.shapeProp(BBTHREAD_ID, 'paneFraction')
    const TWO_THIRDS = 2 / 3
    if (typeof fraction !== 'number' || Math.abs(fraction - TWO_THIRDS) > 1e-6) {
      return `dragging the divider past the max clamp did not settle paneFraction at 2/3 (got ${JSON.stringify(fraction)})`
    }
    return null
  },
}
