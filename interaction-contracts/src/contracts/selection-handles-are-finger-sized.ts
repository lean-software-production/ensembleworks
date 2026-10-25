// Mobile-touch task, scope 3 — the selection handles' side of the same
// finger-size problem. transform.ts's HIT_TOLERANCE_PX is 8 SCREEN pixels: a
// 16px-wide grab target, about a third of the ~44px a fingertip needs. Touching
// near a corner handle therefore misses it and falls through to select.ts's
// ordinary body-drag, so on a phone a shape can be MOVED but never RESIZED —
// the failure is silent (something does happen, just the wrong thing), which is
// exactly the kind a human tester reports as "resizing doesn't work" without
// being able to say why.
//
// tool: 'select+transform' — the real client composite, so transform.ts gets
// first crack at the pointerdown exactly as in the browser (the precedent
// no-transform-while-typing and note-resize-handles-suppressed both set).
//
// THE OBSERVABLE IS A SIZE CHANGE, NOT A TRANSLATION, and that choice is load
// bearing: a missed handle still moves the shape (the body-drag fallback), so
// `shapeDisplacement` cannot tell "resized" from "missed and dragged instead".
// `shapeSizeDelta` can — only a real handle grab changes w/h.
//
// RED (recorded verbatim in the PR body before the fix landed): a touch 14px
// from the SE corner missed every handle at the flat 8px tolerance, the gesture
// fell through to a body drag, and the size delta came back {dw:0, dh:0}.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:resize-by-finger'
/** The seeded shape's SE corner in world (== screen, camera starts at zoom 1). */
const SE_X = 300
const SE_Y = 300
/** How far off the handle the finger lands: beyond HIT_TOLERANCE_PX (8),
 * within half of a 44px finger target. */
const FINGER_OFF_BY = 14

export const selectionHandlesAreFingerSized: Contract = {
  name: 'selection-handles-are-finger-sized',
  level: 'fsm',
  when: 'at-end',
  tool: 'select+transform',
  // A geo (not a note — notes have their resize handles suppressed outright,
  // see note-resize-handles-suppressed) at world (100,100), 200x200, so its SE
  // corner handle sits at (300,300).
  scene: () => [{ id: ID, kind: 'geo', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select it first (with a finger, as the whole gesture is): transform.ts
    // only arms handles for an EXISTING selection.
    { kind: 'down', at: { ref: 'shape', id: ID }, pointer: 1, pointerType: 'touch' },
    { kind: 'up', pointer: 1, pointerType: 'touch' },
    // ...then grab near, but not on, the SE corner and pull it out.
    { kind: 'down', at: { ref: 'point', x: SE_X + FINGER_OFF_BY, y: SE_Y + FINGER_OFF_BY }, pointer: 1, pointerType: 'touch' },
    { kind: 'move', at: { ref: 'point', x: SE_X + FINGER_OFF_BY + 100, y: SE_Y + FINGER_OFF_BY + 100 }, steps: 4, pointer: 1, pointerType: 'touch' },
    { kind: 'up', pointer: 1, pointerType: 'touch' },
  ],
  check: (obs: Obs): string | null => {
    const s = obs.shapeSizeDelta(ID)
    if (s.dw <= 0 || s.dh <= 0) {
      return `a FINGER pressing ${FINGER_OFF_BY}px from the SE handle did not resize the shape (Δsize=${JSON.stringify(s)}, expected both to GROW) -- the handle grab radius must widen for a coarse pointer`
    }
    return null
  },
}
