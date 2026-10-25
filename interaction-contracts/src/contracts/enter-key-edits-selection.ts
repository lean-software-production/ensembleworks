// create-edit-flow task (tldraw parity: node_modules/tldraw/src/lib/tools/
// SelectTool/childStates/Idle.ts:640-661 — Enter on a lone selected
// text-capable shape begins editing it). FSM-level: this is purely
// select.ts's own key handling, no DOM/renderer involved, so it runs
// against the headless Editor exactly like the other select-tool
// contracts (e.g. drag-cursor-lock).
//
// RED (recorded verbatim in the PR/task report before the fix landed):
// select.ts had no `keydown`/'Enter' branch at all, so this contract's
// `check` read `editor.get().editingId` as `null` — the seeded note was
// selected (the down/up click) but Enter did nothing.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:enter-edit-note'

export const enterKeyEditsSelection: Contract = {
  name: 'enter-key-edits-selection',
  level: 'fsm',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click-select the lone note, then press Enter.
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'key', key: 'Enter' },
  ],
  check: (obs: Obs): string | null => {
    const selection = obs.selectedShapeIds()
    if (selection.length !== 1 || selection[0] !== ID) {
      return `expected ${ID} to remain the lone selection after Enter, got ${JSON.stringify(selection)}`
    }
    if (obs.editingShape() !== ID) {
      return `Enter on the lone selected shape ${ID} did not begin editing it (editingShape: ${JSON.stringify(obs.editingShape())})`
    }
    return null
  },
}
