// Task AS4 (docs/plans/2026-07-21-canvas-v2-styling.md) — the interaction
// contract that pins ARMED styling (as opposed to P3's selection styling):
// with nothing selected, arm the geo tool, click the panel's armed blue
// color swatch (dispatches `SetNextStyle`, Task AS3), then create a geo
// shape on empty canvas; assert the newly-created shape's stored color is
// 'blue'. Browser-only, same rationale as `style-applies-to-selection`: the
// panel (client/src/canvas-v2/StylePanel.tsx) is a React/DOM component with
// no FSM-level equivalent to click.
//
// DISCOVERING THE CREATED SHAPE'S ID: the created shape's id is minted from
// crypto-random (canvas-editor/src/tools/create.ts's `makeId`), so this
// contract cannot predict it up front the way `style-applies-to-selection`
// predicts its seeded shapes' ids. Instead it rides the create tool's own
// auto-selection (`finalizeIntents` pushes `SetSelection([shape.id])`,
// create.ts:137) via the new `selectedShapeIds()` Obs (Task AS4), then
// reuses P3's `shapeStyle` for the value assertion.
//
// EMPTY SCENE, DELIBERATELY: unlike P3 (which seeds two shapes to select),
// this contract seeds NOTHING. The created shape must be the only shape
// alive when `check` runs, so `selectedShapeIds()` resolving to exactly one
// id is itself part of the assertion that a shape really was created (not
// just that some pre-existing seeded shape got re-selected).
//
// RED (as landed, Task AS4): Task AS3 is in the tree (arming the geo tool
// and clicking the blue swatch really does set `nextShapeStyle.color` to
// 'blue' — the swatch renders, is clickable, and the click resolves), but
// Task AS2 (the create tool reading `nextShapeStyle` into a new shape's
// props) is NOT yet landed — the create path ignores the armed style
// entirely. So the gesture resolves cleanly (armed swatch found and
// clicked, a shape IS created, `selectedShapeIds()` returns exactly its
// id), and the RED is a genuine "shape's color stayed unset, expected
// 'blue'" value assertion — never a locator-not-found or
// empty-selection error. (create.ts's `propsFor` writes no `color` key at
// all pre-AS2, so the live-read value is `undefined`/absent, not some other
// tldraw-style "default black" — `shapeStyle` reports that as `null`; the
// exact non-blue value is incidental, the assertion only requires
// `!== 'blue'`.) Task AS2 turns this GREEN.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// The toolbar button CanvasV2App.tsx renders for each tool
// (`data-canvas-v2-tool={btn.id}` — TOOL_BUTTONS' `id`s are the same
// `ToolId` union the armed panel keys off of).
const GEO_TOOL_SELECTOR = '[data-canvas-v2-tool="geo"]'

// The armed panel's blue color swatch. StylePanel.tsx's module header names
// this exact selector as AS4's anchor: the armed panel carries
// `data-style-panel-mode="armed"` (distinct from the selection panel's
// `data-style-panel-mode="selection"` P3 anchors onto), so this cannot
// collide with `style-applies-to-selection`'s own BLUE_SWATCH_SELECTOR even
// though both target a `data-style-value="blue"` color swatch.
const ARMED_BLUE_SWATCH_SELECTOR = '[data-style-panel-mode="armed"] [data-style-control="color"] [data-style-value="blue"]'

export const armedStyleAppliesToCreatedShape: Contract = {
  name: 'armed-style-applies-to-created-shape',
  level: 'browser',
  when: 'at-end',
  // No seeded shapes — see module header's EMPTY SCENE note.
  scene: () => [],
  gesture: (_rng: Rng): GestureOp[] => [
    // Arm the geo tool (selection is already empty — an empty scene starts
    // with nothing selected — so the panel switches to armed mode as soon
    // as `activeToolId` becomes 'geo').
    { kind: 'down', at: { ref: 'element', selector: GEO_TOOL_SELECTOR } },
    { kind: 'up' },
    // Click the panel's armed blue color swatch: dispatches
    // `SetNextStyle{ props: { color: 'blue' } }` (Task AS3), NOT `SetStyle`
    // (there is no selection for `SetStyle` to apply to).
    { kind: 'down', at: { ref: 'element', selector: ARMED_BLUE_SWATCH_SELECTOR } },
    { kind: 'up' },
    // Click (not drag) on empty canvas: down then up with NO move between
    // them stays under create.ts's crossedThreshold check, so the create
    // tool's 'pointing' state click-creates via `clickShape`/`finalizeIntents`
    // rather than drag-creating. A point well clear of the toolbar (top) and
    // the armed panel (top-center, PANEL_MAX_HEIGHT 480 under MARGIN 8) so
    // the pointerdown genuinely lands on empty canvas, not on a control.
    { kind: 'down', at: { ref: 'point', x: 500, y: 560 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape selected after creating a geo with the geo tool armed blue, got ${JSON.stringify(ids)}`
    }
    const value = obs.shapeStyle(ids[0]!, 'color')
    if (value !== 'blue') {
      return `expected the newly-created shape ${ids[0]}'s color to be 'blue' (armed via the panel's blue swatch before creation), got ${JSON.stringify(value)}`
    }
    return null
  },
}
