// Task style-memory (gap 3) — the interaction contract that pins NEXT-SHAPE
// STYLE MEMORY: tldraw parity (StylePanelContext.tsx, "every style click
// sets BOTH setStyleForSelectedShapes AND setStyleForNextShapes unless
// Ctrl/Cmd held") means editing a SELECTION's style must ALSO update the
// style used for the next shape drawn with that tool — recolor a selected
// note to red, draw a new note, and it must ALSO be red, not the tool's own
// stale/default armed style. Browser-only, same rationale as
// `style-applies-to-selection`/`armed-style-applies-to-created-shape`: the
// panel (client/src/canvas-v2/StylePanel.tsx) is a React/DOM component with
// no FSM-level equivalent to click.
//
// GESTURE: seed one geo shape, select it, click the SELECTION panel's blue
// color swatch (dispatches `SetStyle` — Task P4 — over the selection); click
// empty canvas with the select tool still active to CLEAR the selection
// (select.ts's empty-click -> `SetSelection([])`, line ~572); arm the geo
// tool (now armed mode, since selection is empty); click empty canvas again
// to CREATE a new geo shape WITHOUT touching the armed panel's swatches at
// all. If styling the earlier selection also armed `nextShapeStyle` (gap 3's
// fix), the freshly created shape inherits blue with no second arming click
// — if it doesn't, the new shape gets whatever the tool's stale/default
// armed style was (never blue, since nothing here ever clicked the ARMED
// panel's blue swatch).
//
// RED (as landed, style-memory task): CanvasV2App.tsx's pre-fix
// `onStyleChange` dispatches only `SetStyle` over the selection, never also
// `SetNextStyle` (see that module's own gap-3 doc comment on `onStyleChange`
// for the fix). So the gesture resolves cleanly (the swatch click restyles
// the selected shape, the selection clears, the geo tool arms, a NEW shape
// IS created on the second empty-canvas click), and the RED is a genuine
// "the new shape's color stayed at the tool's stale default, expected
// 'blue'" value assertion — never a locator-not-found or empty-selection
// error.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const SEEDED_ID = 'shape:style-memory-seed'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-v2-tool={btn.id}` — same convention
// `armed-style-applies-to-created-shape` already anchors onto).
const GEO_TOOL_SELECTOR = '[data-canvas-v2-tool="geo"]'

// The SELECTION panel's blue color swatch — `data-style-panel-mode`
// distinguishes this from the ARMED panel's own blue swatch (same
// distinction `style-applies-to-selection`/`armed-style-applies-to-created-
// shape` already rely on, so this contract's own selector can never
// accidentally collide with either).
const SELECTION_BLUE_SWATCH_SELECTOR = '[data-style-panel-mode="selection"] [data-style-control="color"] [data-style-value="blue"]'

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
    // Click the SELECTION panel's blue swatch: dispatches `SetStyle` over
    // the selection — and, per gap 3's fix, should ALSO arm `nextShapeStyle`.
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
