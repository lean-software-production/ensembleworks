// Pane input routing task (follow-up after live test) -- the general half of
// the new "interacting with a thread pane is an editor state" decision: a
// pointerdown on anything OTHER than the shape currently being edited must
// end that edit first (`EndEdit`), before the normal click/selection
// handling for the new target runs. Proven here against an ordinary `text`
// shape (not bbthread) because this is a GENERAL select-tool rule, not
// something scoped to the bbthread pane -- today, ending an edit on an
// outside click only happens for note/text/geo because the DOM textarea's
// own blur handler does it; the FSM has no such mechanism at all, which is
// exactly the gap the bbthread pane (no textarea of its own) exposes.
//
// RED (recorded verbatim in the task report before the fix landed): the
// select tool's idle->pointing pointerdown transition never inspects
// `editor.get().editingId` at all, so a click on empty canvas while editing
// leaves editingShape() unchanged -- ending an edit today happens ONLY via
// the DOM textarea's own blur, which this FSM-level runner never drives.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:editing-ends-outside-click'

export const editingEndsOnOutsideClick: Contract = {
  name: 'editing-ends-on-outside-click',
  level: 'fsm',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'text', x: 0, y: 0, w: 200, h: 40 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Double-click the text shape -- begins editing it (existing behaviour,
    // same double-click-to-edit gesture as enter-key-edits-selection.ts's
    // sibling contracts).
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    // Then a plain click on empty canvas, far from the shape.
    { kind: 'down', at: { ref: 'point', x: 600, y: 600 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== null) {
      return `a click on empty canvas, far from the shape being edited, did not end the edit (editingShape: ${JSON.stringify(obs.editingShape())}, expected null)`
    }
    return null
  },
}
