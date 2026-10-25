// Escape with a style popover open closes the popover and leaves the
// selection alone: the popover is the innermost thing Escape should dismiss.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:style-popover-escape'
const COLOR_TRIGGER = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'
const BLUE_SWATCH = '[data-style-popover="color"] [data-style-value="blue"]'

export const stylePopoverEscape: Contract = {
  name: 'style-popover-escape',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 300, y: 300, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER } },
    { kind: 'up' },
    // Clicking a swatch leaves focus inside the popover, where Escape lands.
    { kind: 'down', at: { ref: 'element', selector: BLUE_SWATCH } },
    { kind: 'up' },
    { kind: 'key', key: 'Escape' },
  ],
  check: (obs: Obs): string | null => {
    const open = obs.openStylePopover()
    if (open !== null) return `expected Escape to close the style popover, but ${JSON.stringify(open)} is still open`
    const selected = obs.selectedShapeIds()
    if (selected.length !== 1 || selected[0] !== ID) return `expected Escape to keep ${ID} selected, got ${JSON.stringify(selected)}`
    if (obs.shapeStyle(ID, 'color') !== 'blue') return `expected the swatch click to have applied blue, got ${JSON.stringify(obs.shapeStyle(ID, 'color'))}`
    return null
  },
}
