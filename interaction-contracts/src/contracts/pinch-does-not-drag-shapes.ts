// Mobile-touch task, scope 1 — the other half of the pinch contract, and the
// half that is a real BUG rather than a missing feature: with `touch-action:
// none` on the viewport (canvas-react's Viewport.tsx — required, or every touch
// drag dies at its first move as a pointercancel), a second finger landing
// mid-gesture is just another pointerdown. Handed to the select tool, a pinch
// reads as one pointer jumping about and DRAGS whatever is under it. So:
// putting a second finger down must leave the shape under the first one exactly
// where it was, however far the fingers then travel.
//
// Note the first finger lands ON the shape and then MOVES — i.e. a genuine
// single-finger drag is under way when the second finger arrives. Nothing here
// is testing a merely-starved tool: the in-flight gesture has to be actively
// unwound (multi-touch.ts's `cancelGesture`), not just denied further events.
//
// WHAT THE ASSERTION IS, PRECISELY: the shape must sit exactly where the
// PRE-PINCH one-finger drag left it (30 world units right, at zoom 1) — not at
// the origin. A pinch ABANDONS the gesture in flight, it does not REVERT it,
// which is the same policy `cancelActiveTool` already applies to every other
// abandonment trigger (blur, pointercancel, tool switch): select's drag
// translates EXISTING shapes and has nothing to delete or roll back. Asserting
// the exact 30 rather than merely "not far" is what makes this contract catch
// the suppression leaking in either direction — a further drag, or a surprise
// rollback.
//
// RED (recorded verbatim in the PR body before the fix landed): the select tool
// saw both touches, so the shape was dragged off by hundreds of world units.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:pinched-over'

export const pinchDoesNotDragShapes: Contract = {
  name: 'pinch-does-not-drag-shapes',
  level: 'fsm',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'geo', x: 500, y: 300, w: 200, h: 120 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID }, pointer: 1, pointerType: 'touch' },
    // A real one-finger drag, past the drag threshold, before the pinch starts.
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 30, dy: 0 }, steps: 3, pointer: 1, pointerType: 'touch' },
    { kind: 'down', at: { ref: 'point', x: 900, y: 500 }, pointer: 2, pointerType: 'touch' },
    { kind: 'move', at: { ref: 'point', x: 1100, y: 650 }, steps: 5, pointer: 2, pointerType: 'touch' },
    { kind: 'move', at: { ref: 'point', x: 200, y: 100 }, steps: 5, pointer: 1, pointerType: 'touch' },
    { kind: 'up', pointer: 1, pointerType: 'touch' },
    // The SECOND finger lifts last, and its remaining travel must not be read
    // as a fresh drag either (multi-touch.ts's "suppression outlives the
    // pinch") -- so it moves once more before releasing.
    { kind: 'move', at: { ref: 'point', x: 400, y: 400 }, steps: 3, pointer: 2, pointerType: 'touch' },
    { kind: 'up', pointer: 2, pointerType: 'touch' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(ID)
    if (Math.abs(d.dx - 30) > 1e-6 || Math.abs(d.dy) > 1e-6) {
      return `a two-finger pinch moved the shape under the first finger (Δ=${JSON.stringify(d)}, expected exactly {dx:30,dy:0} -- where the pre-pinch one-finger drag left it): the touches must never reach a tool as a drag`
    }
    return null
  },
}
