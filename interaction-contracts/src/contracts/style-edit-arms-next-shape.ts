// Next-shape style memory: editing a selection's style also arms the style
// for the next shape drawn. Seed one geo shape, select it, open the selection
// toolbar's color popover and click blue, click empty canvas to clear the
// selection, arm the geo tool, click empty canvas to create a shape, and
// assert the new shape is blue with no armed-panel click. Browser-only, same
// rationale as `style-applies-to-selection`.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const SEEDED_ID = 'shape:style-memory-seed'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-tool={btn.id}` — same convention
// `armed-style-applies-to-created-shape` already anchors onto).
const GEO_TOOL_SELECTOR = '[data-canvas-tool="geo"]'

// Scoped to the selection toolbar so it never collides with the armed panel.
const COLOR_TRIGGER_SELECTOR = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'
const SELECTION_BLUE_SWATCH_SELECTOR = '[data-style-popover="color"] [data-style-value="blue"]'

export const styleEditArmsNextShape: Contract = {
  name: 'style-edit-arms-next-shape',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: SEEDED_ID, kind: 'geo', x: 100, y: 100, w: 100, h: 100 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Select the seeded shape (a plain click lands the down/up on the shape
    // itself, no marquee needed for a single shape).
    { kind: 'down', at: { ref: 'shape', id: SEEDED_ID } },
    { kind: 'up' },
    // Open the color popover and click blue: dispatches `SetStyle` over the
    // selection and should also arm `nextShapeStyle`.
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: SELECTION_BLUE_SWATCH_SELECTOR } },
    { kind: 'up' },
    // Click empty canvas (well clear of the seeded shape and the panel) with
    // the select tool still active: clears the selection (select.ts's
    // empty-click branch), so the panel can switch to armed mode next.
    { kind: 'down', at: { ref: 'point', x: 900, y: 500 } },
    { kind: 'up' },
    // Arm the geo tool. Selection is now empty, so the panel switches to
    // armed mode — but this gesture deliberately never clicks any ARMED
    // swatch: the whole point is that nextShapeStyle should ALREADY be blue
    // from the earlier selection edit, with no second arming click needed.
    { kind: 'down', at: { ref: 'element', selector: GEO_TOOL_SELECTOR } },
    { kind: 'up' },
    // Click (not drag) on empty canvas to create a new geo shape.
    { kind: 'down', at: { ref: 'point', x: 500, y: 560 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape selected after creating a geo shape with the geo tool armed, got ${JSON.stringify(ids)}`
    }
    const newId = ids[0]!
    if (newId === SEEDED_ID) {
      return `expected a NEW shape to be created and auto-selected, but the seeded shape is still selected`
    }
    const value = obs.shapeStyle(newId, 'color')
    if (value !== 'blue') {
      return `expected the newly-created shape ${newId}'s color to be 'blue' — styling the earlier SELECTION blue should have also armed nextShapeStyle (next-shape style memory), with no separate armed-swatch click — got ${JSON.stringify(value)}`
    }
    return null
  },
}
