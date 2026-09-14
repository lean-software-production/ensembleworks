// create-edit-flow FIXER task — a browser-level twin for
// enter-key-edits-selection.ts, added because that FSM-level contract is
// structurally incapable of catching this bug: no DOM textarea exists at the
// FSM level, so it can only ever observe "editingShape became non-null", never
// what landed in the shape's TEXT.
//
// RED (recorded verbatim, reproduced live in a real browser BEFORE this
// task's fix, via a throwaway spec since deleted): select.ts's Enter-to-edit
// branch fires `BeginEdit`, but the underlying keydown was never
// `preventDefault`-ed, and TextEditor.tsx's textarea takes `autoFocus`
// SYNCHRONOUSLY within that same keydown (the BeginEdit intent flips
// `editingId`, React re-renders and mounts the textarea, autoFocus moves
// focus there, all before the ORIGINAL native keydown's default-action phase
// runs) — so the browser's native "Enter inserts a newline" default action
// lands in the FRESHLY FOCUSED textarea instead of doing nothing. Seeded
// text `text for shape:enter-preserve-note` became
// `\ntext for shape:enter-preserve-note` after one Enter.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:enter-preserve-note'
// Matches e2e/lib/contracts.ts's seedScene, which stamps every seeded
// shape's live text to this exact template — the contract asserts against
// the SAME string the runner actually wrote, not a value this file invents.
const SEEDED_TEXT = `text for ${ID}`

export const enterKeyEditPreservesText: Contract = {
  name: 'enter-key-edit-preserves-text',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click-select the lone note, then press Enter — the same gesture
    // enter-key-edits-selection.ts plays, just observed through a real DOM.
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'key', key: 'Enter' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== ID) {
      return `Enter on the lone selected shape ${ID} did not begin editing it (editingShape: ${JSON.stringify(obs.editingShape())})`
    }
    const text = obs.shapeText(ID)
    if (text !== SEEDED_TEXT) {
      return `Enter-to-edit must not itself mutate the shape's text (a stray keydown default action) — expected ${JSON.stringify(SEEDED_TEXT)}, got ${JSON.stringify(text)}`
    }
    return null
  },
}
