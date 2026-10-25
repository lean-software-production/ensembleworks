// Clicking empty space on the current page must not select a shape that
// lives on another page. Owner report (2026-09-15, bb Canvas plugin and the
// web app's v2 mount alike): the tools' ToolContext hit-tested one spatial
// index spanning the whole room, so a click on an empty page landed on an
// invisible shape from another page sitting at the same world coordinates,
// and its selection outline and handles appeared.
//
// Gesture: seed one geo shape on the default page (page:p), click "+ new
// page" (creates a page AND switches to it in one batch), then click the
// SCREEN point where the seeded shape sits. The new page is empty, so the
// click must select nothing.
//
// The final click uses a 'point' anchor, not a 'shape' anchor: once the page
// switches the shape is no longer rendered, so a `[data-shape-id]` lookup
// would fail as a locator error rather than as the assertion. The point is
// the shape's centre as seeded — the room boots with an identity camera, so
// world (x, y) inside the canvas box is screen (x, y) inside the box.
//
// RED against unfixed code: selectedShapeIds() is ['shape:elsewhere'].
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:elsewhere'
const NEW_PAGE_SELECTOR = '[data-canvas-v2-new-page]'
const SHAPE = { x: 300, y: 250, w: 200, h: 200 }

export const selectIgnoresOtherPages: Contract = {
  name: 'select-ignores-other-pages',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'geo', ...SHAPE }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'element', selector: NEW_PAGE_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: SHAPE.x + SHAPE.w / 2, y: SHAPE.y + SHAPE.h / 2 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const pages = obs.pageCount()
    if (pages !== 2) return `expected 2 pages after clicking "+ new page", got ${pages}`
    const selected = obs.selectedShapeIds()
    if (selected.length !== 0) {
      return `expected a click on the new, empty page to select nothing, got selectedShapeIds() ${JSON.stringify(selected)} (a shape from another page)`
    }
    return null
  },
}
