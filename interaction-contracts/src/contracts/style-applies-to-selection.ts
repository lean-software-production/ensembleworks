// Task P3 (docs/plans/2026-07-21-canvas-v2-styling.md) — the interaction
// contract that discharges this styling sub-cycle's CLAUDE.md obligation:
// seed two geo shapes, marquee-select both, click the style panel's blue
// color swatch, and assert BOTH shapes' stored color changed to 'blue'.
// Browser-only: the panel (client/src/canvas-v2/StylePanel.tsx) is a React/
// DOM component — the FSM runner drives headless tool FSMs against a
// DOM-less Editor and has no panel to click, so this gesture can only run
// through real Playwright input against a live ?engine=v2 room.
//
// RED (as landed, Task P3): Task P2 mounts StylePanel with an UNWIRED
// onStyleChange (CanvasV2Session passes a no-op — nothing dispatches
// SetStyle yet). The swatch renders and IS clickable (P2 gives every
// control a stable data-style-control/data-style-value hook), so this
// contract's gesture resolves cleanly against the real DOM — the RED is a
// genuine "shapeStyle stayed unset, expected 'blue'" assertion failure,
// never a Playwright locator-not-found error. Task P4 wires the handler and
// turns this GREEN.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:style-a'
const ID_B = 'shape:style-b'

// The swatch DOM P2 renders (StylePanel.tsx's AxisRow): a row keyed by
// data-style-control="<axis>", each value inside as a <button> carrying
// data-style-value="<value>". 'blue' is a real member of the model's COLOR
// enum (canvas-model/src/shape.ts) and neither seeded shape below sets a
// color prop, so a successful click is a genuine, observable change
// (unset -> 'blue'), never a same-value no-op that could pass by
// coincidence.
const BLUE_SWATCH_SELECTOR = '[data-style-control="color"] [data-style-value="blue"]'

export const styleAppliesToSelection: Contract = {
  name: 'style-applies-to-selection',
  level: 'browser',
  tool: 'select',
  // 'at-end': the gesture is marquee-select-both THEN click-the-swatch — an
  // 'every-event' check would fire (and fail) right after the marquee op,
  // before the click even runs, which would misreport the contract as
  // permanently RED even once P4 wires the handler. Checking once, after
  // the whole gesture, is what lets this actually turn GREEN in P4.
  when: 'at-end',
  // Two geo shapes side by side, OFFSET from the world origin (x:100/300,
  // not 0/200) so there is clear empty canvas above-left of A for the
  // marquee's down-point to land on. This is load-bearing, not cosmetic:
  // lib/canvas-v2.ts's seedGrid doc comment calls this out explicitly ("a
  // pointerdown that lands ON a shape starts a translate-drag instead of a
  // marquee — canvas-editor/src/tools/select.ts's FSM") — a shape seeded
  // flush against the origin leaves the marquee's own down-point with
  // nowhere empty to land, which was this contract's own first RED
  // (verified live: selection stayed `[]`, a translate-drag, not the
  // "shapeStyle unchanged" RED this contract exists to pin).
  scene: () => [
    { id: ID_A, kind: 'geo', x: 100, y: 100, w: 100, h: 100 },
    { id: ID_B, kind: 'geo', x: 300, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Marquee both shapes: down on EMPTY canvas above-left of A, drag past
    // B's bottom-right corner. select.ts's marquee mode is 'intersect', but
    // this sweep's bounds fully enclose both shapes anyway ((-70,-70) off
    // A's centre to (+70,+70) off B's centre spans well past both boxes).
    { kind: 'down', at: { ref: 'shape', id: ID_A, dx: -70, dy: -70 } },
    { kind: 'move', at: { ref: 'shape', id: ID_B, dx: 70, dy: 70 }, steps: 4 },
    { kind: 'up' },
    // Click the panel's blue color swatch.
    { kind: 'down', at: { ref: 'element', selector: BLUE_SWATCH_SELECTOR } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    for (const id of [ID_A, ID_B]) {
      const value = obs.shapeStyle(id, 'color')
      if (value !== 'blue') {
        return `expected shape ${id}'s color to be 'blue' after clicking the blue swatch on a 2-shape selection, got ${JSON.stringify(value)}`
      }
    }
    return null
  },
}
