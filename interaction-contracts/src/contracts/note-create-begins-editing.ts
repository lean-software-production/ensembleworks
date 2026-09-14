// create-edit-flow task — tldraw parity: node_modules/tldraw/src/lib/
// shapes/note/toolStates/Pointing.ts's `complete()` calls
// `startEditingShapeWithRichText` on a completed click-create, so clicking
// the Note tool onto empty canvas both creates the sticky AND immediately
// enters editing — no second gesture. LEVEL: browser (not fsm) — the note
// tool is only reachable in the FSM runner via `contract.tool`, which the
// runner limits to 'select'/'select+transform' (fsm-runner.ts's TOOL SEAM
// comment); this contract drives the real Note toolbar button instead,
// same pattern as drawCreatesADrawShape.
//
// EMPTY SCENE, DELIBERATELY: no seeded shapes — the created sticky must be
// the only shape alive when `check` runs (shapeCount() === 1 is itself part
// of the "a shape was really created" assertion), and its id is minted from
// crypto-random (create.ts's makeId), so it's discovered via
// `selectedShapeIds()` (create.ts's finalizeIntents auto-selects it), same
// discovery pattern as armedStyleAppliesToCreatedShape/
// drawCreatesADrawShape.
//
// RED (recorded verbatim in the PR/task report before the fix landed):
// create.ts's finalizeIntents emitted only CreateShape + SetSelection, no
// BeginEdit — this contract's `check` read `editingShape()` as `null`
// while a shape genuinely existed and was selected.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const NOTE_TOOL_SELECTOR = '[data-canvas-tool="note"]'

export const noteCreateBeginsEditing: Contract = {
  name: 'note-create-begins-editing',
  level: 'browser',
  when: 'at-end',
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select the Note tool.
    { kind: 'down', at: { ref: 'element', selector: NOTE_TOOL_SELECTOR } },
    { kind: 'up' },
    // Click on empty canvas, well clear of the toolbar.
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape selected after a note-tool click, got ${JSON.stringify(ids)}`
    }
    if (obs.shapeCount() !== 1) {
      return `expected shapeCount 1 after one note click, got ${obs.shapeCount()}`
    }
    const kind = obs.shapeKind(ids[0]!)
    if (kind !== 'note') {
      return `expected the created shape ${ids[0]} to be kind 'note', got ${JSON.stringify(kind)}`
    }
    if (obs.editingShape() !== ids[0]) {
      return `a note-tool click did not begin editing the created shape immediately (editingShape: ${JSON.stringify(obs.editingShape())}, expected ${ids[0]})`
    }
    return null
  },
}
