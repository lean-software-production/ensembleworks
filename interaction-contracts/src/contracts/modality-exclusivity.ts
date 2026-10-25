// Pilot 4 — modality exclusivity. Invariant: whenever a shape is being
// text-edited (Obs.editingShape() === that shape's id), the shape must never
// be translated — the editing textarea owns the pointer, not the drag FSM.
// level: 'fsm' — the select FSM + editingId are fully observable headlessly,
// the cheapest level a violation can be caught (and fixed) at.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:edit-drag'

export const modalityExclusivity: Contract = {
  name: 'no-drag-while-typing',
  level: 'fsm',
  when: 'every-event',
  scene: () => [{ id: ID, kind: 'note', x: 0, y: 0, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // seed-invariant by construction (ignores rng): a fixed click-click-drag
    // sequence; running it across library.test.ts's seed set is redundant but
    // harmless.
    // Two completed clicks on the shape within the double-click window ->
    // BeginEdit (select.ts). script.ts stamps t at dt=16ms/event, comfortably
    // inside DOUBLE_CLICK_MS (450). Then a drag attempt on the same shape.
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 120, dy: 90 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== ID) return null
    const d = obs.shapeDisplacement(ID)
    return d.dx === 0 && d.dy === 0
      ? null
      : `shape moved by ${JSON.stringify(d)} while being edited (editing must be modal)`
  },
}
