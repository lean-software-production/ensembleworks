// Enter on a focused chrome button inside the canvas's keyboard scope is the
// button's own key: it activates the button and must not also begin editing
// the selected shape. canvas-ui's useCanvasSession forwards keydowns from
// outside the viewport through a document listener; from a focused control
// it withholds the control's activation keys (Enter, Space) from the tool,
// while shortcuts and arrow nudge still act.
//
// Browser-only: the toolbar is a DOM control and focus is a DOM concept, so
// the FSM runner has nothing to click.
//
// RED is recorded in the commit that introduced this contract.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:enter-chrome-note'
const SELECT_TOOL_BUTTON = '[data-canvas-tool="select"]'

export const enterOnChromeButtonDoesNotEdit: Contract = {
  name: 'enter-on-chrome-button-does-not-edit',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click-select the note.
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    // Click the toolbar's select button: focuses it, keeps the selection.
    { kind: 'down', at: { ref: 'element', selector: SELECT_TOOL_BUTTON } },
    { kind: 'up' },
    // Enter on the focused button.
    { kind: 'key', key: 'Enter' },
  ],
  check: (obs: Obs): string | null => {
    const selection = obs.selectedShapeIds()
    if (selection.length !== 1 || selection[0] !== ID) {
      return `expected ${ID} to stay selected after clicking the toolbar button, got ${JSON.stringify(selection)}`
    }
    const editing = obs.editingShape()
    if (editing !== null) {
      return `Enter on a focused toolbar button began editing ${JSON.stringify(editing)}; it must only activate the button`
    }
    return null
  },
}
