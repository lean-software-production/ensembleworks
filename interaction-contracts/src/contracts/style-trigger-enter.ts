// Enter on a focused style-toolbar trigger is the trigger's own key: it
// activates the button (toggling its popover) and must not reach the canvas,
// where the select tool would begin editing the selected shape.
//
// Browser-only: the trigger is rendered chrome and focus is a DOM concept.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:style-trigger-enter'
const COLOR_TRIGGER = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'

export const styleTriggerEnter: Contract = {
  name: 'style-trigger-enter',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 300, y: 300, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    // Opens the colour popover and focuses the trigger.
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER } },
    { kind: 'up' },
    { kind: 'key', key: 'Enter' },
  ],
  check: (obs: Obs): string | null => {
    const editing = obs.editingShape()
    if (editing !== null) return `Enter on a focused style trigger began editing ${JSON.stringify(editing)}; it must only activate the trigger`
    const selected = obs.selectedShapeIds()
    if (selected.length !== 1 || selected[0] !== ID) return `expected ${ID} to stay selected, got ${JSON.stringify(selected)}`
    const open = obs.openStylePopover()
    if (open !== null) return `expected Enter to activate the trigger and close its popover, but ${JSON.stringify(open)} is still open`
    return null
  },
}
