// Task keyboard/K2 (canvas-v2 polish batch — "Keyboard parity") — the
// interaction contract that discharges `flattenForShift` in
// tools/select.ts's onPointing/onDragging: holding Shift while dragging
// flattens the move to whichever axis has the larger raw displacement from
// the grab point (tldraw parity — Translating.ts's own `flatten`), holding
// the OTHER axis at zero for the whole gesture.
//
// FSM-level: the constrain logic lives entirely inside the select tool's own
// FSM — no CanvasV2App/DOM plumbing is exercised (unlike the tool-switch/
// select-all shortcuts, which are browser-only — see this task's sibling
// contracts).
//
// RED (teeth-checked live): with `flattenForShift` reverted to `(dx, dy) =>
// ({dx, dy})` (i.e. Shift has no effect), the drag moves diagonally by the
// FULL raw delta on both axes — shapeDisplacement(ID) reports a non-zero x
// where this contract expects exactly 0, so `check` fails on the
// suppressed-axis assertion with a clean, specific message.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:shift-drag-target'

export const shiftDragConstrainsToAxis: Contract = {
  name: 'shift-drag-constrains-to-axis',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'geo', x: 0, y: 0, w: 100, h: 100 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Grab dead-center (dx:0, dy:0 offset from the shape's centroid).
    { kind: 'down', at: { ref: 'shape', id: ID } },
    // Move 4 screen/world px right, 20 down -- |dy| > |dx|, so Shift must
    // flatten x to 0 and keep the full y.
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 4, dy: 20 }, modifiers: { shift: true } },
    { kind: 'up', modifiers: { shift: true } },
  ],
  check: (obs: Obs): string | null => {
    const { dx, dy } = obs.shapeDisplacement(ID)
    if (dx !== 0 || dy !== 20) {
      return `expected shapeDisplacement(${JSON.stringify(ID)}) === {dx:0, dy:20} after a Shift-held drag with raw delta (4,20) (dominant axis kept, other flattened to 0), got {dx:${dx}, dy:${dy}}`
    }
    return null
  },
}
