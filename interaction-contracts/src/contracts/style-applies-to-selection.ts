// Seed two geo shapes, marquee-select both, open the selection toolbar's color
// popover, click its blue swatch, and assert BOTH shapes' stored color is
// 'blue'. Browser-only: the toolbar (canvas-ui/src/StylePanel.tsx) is a
// React/DOM component with no FSM-level equivalent to click.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:style-a'
const ID_B = 'shape:style-b'

// The color slot's trigger opens its popover; the swatch lives inside it.
// Neither seeded shape sets a color, so the click is an observable change.
const COLOR_TRIGGER_SELECTOR = '[data-style-panel-mode="selection"] [data-style-trigger="color"]'
const BLUE_SWATCH_SELECTOR = '[data-style-popover="color"] [data-style-value="blue"]'

export const styleAppliesToSelection: Contract = {
  name: 'style-applies-to-selection',
  level: 'browser',
  tool: 'select',
  // 'at-end': an 'every-event' check would fail right after the marquee,
  // before the swatch click runs; check once, after the whole gesture.
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
    // Open the color popover, then click its blue swatch.
    { kind: 'down', at: { ref: 'element', selector: COLOR_TRIGGER_SELECTOR } },
    { kind: 'up' },
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
