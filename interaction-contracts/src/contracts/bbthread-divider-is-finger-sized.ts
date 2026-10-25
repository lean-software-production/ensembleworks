// Mobile-touch task, scope 3 — FINGER-SIZED HIT TARGETS. The bbthread pane's
// divider is a 6-unit band either side of the pane's left edge
// (canvas-model's BBTHREAD_DIVIDER_MARGIN) — a 12px-wide target with a mouse
// at 100% zoom, which is already small, and which a fingertip (~9mm, the usual
// 44px guidance) cannot hit at all. A TOUCH pointerdown a finger's width off
// the edge must still grab the divider and resize the pane, not translate the
// whole frame.
//
// WHY A SEPARATE CONTRACT FROM bbthread-divider-drag-resizes-pane: that one
// presses exactly ON the edge and passes with any margin at all, including
// zero. It is structurally incapable of noticing that the band is too narrow
// for the device the whole task is about. This one presses 12 units OFF the
// edge — outside the mouse-sized band, inside a finger-sized one — which is
// the only press that can tell the two apart.
//
// THE SAME GESTURE WITH A MOUSE IS NOT ASSERTED HERE, deliberately: a fine
// pointer landing 12px inside the pane translating the frame is the correct,
// unchanged behaviour (bbthread-pane-is-solid already pins it), and re-pinning
// it here would just couple two contracts to one number.
//
// RED (recorded verbatim in the PR body before the fix landed): the margin is a
// flat 6 regardless of device, so a touch at local x=588 missed the band, fell
// through to the pane's solid-body translate, and moved the whole frame while
// never writing paneFraction.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread-touch'

/** A 900x600 bbthread at the origin puts the divider at local x = 600 (default
 * paneFraction 1/3), exactly as bbthread-divider-drag-resizes-pane's scene
 * does; the camera starts at zoom 1, so local == screen here. */
const DIVIDER_X = 600
/** How far off the edge the finger lands: beyond BBTHREAD_DIVIDER_MARGIN (6),
 * within half of a 44px finger target. */
const FINGER_OFF_BY = 12

export const bbthreadDividerIsFingerSized: Contract = {
  name: 'bbthread-divider-is-finger-sized',
  level: 'fsm',
  when: 'at-end',
  scene: () => [{ id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: DIVIDER_X - FINGER_OFF_BY, y: 300 }, pointer: 1, pointerType: 'touch' },
    { kind: 'move', at: { ref: 'point', x: 450, y: 300 }, steps: 4, pointer: 1, pointerType: 'touch' },
    { kind: 'up', pointer: 1, pointerType: 'touch' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(BBTHREAD_ID)
    if (d.dx !== 0 || d.dy !== 0) {
      return `a FINGER pressing ${FINGER_OFF_BY}px from the divider translated the whole frame (Δ=${JSON.stringify(d)}) -- the divider's grab band must widen for a coarse pointer`
    }
    const fraction = obs.shapeProp(BBTHREAD_ID, 'paneFraction')
    if (typeof fraction !== 'number' || Math.abs(fraction - 0.5) > 1e-6) {
      return `a finger drag of the divider to local x=450 did not set paneFraction to 0.5 (got ${JSON.stringify(fraction)})`
    }
    return null
  },
}
