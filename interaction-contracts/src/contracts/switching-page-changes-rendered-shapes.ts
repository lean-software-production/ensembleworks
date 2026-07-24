// Task Z1 (docs/plans/2026-07-22-canvas-v2-pages.md) — the interaction
// contract that discharges this pages sub-cycle's CLAUDE.md obligation:
// seed TWO non-overlapping geo shapes on the default page (page:p), click
// the switcher's "+ new page" control (creates a page AND switches to it,
// U1's `newPageIntents` — one applyAll batch), and assert the new page
// renders EMPTY while the doc itself now holds TWO pages.
//
// Browser-only: the switcher is a client/src/canvas-v2 React component with
// no FSM-level equivalent to click (same rationale as
// armed-style-applies-to-created-shape/style-applies-to-selection) — the FSM
// runner drives tool FSMs only, this needs a real mounted PageSwitcher.
//
// THE TEETH — two INDEPENDENT assertions, deliberately not one:
//   - pageCount() === 2 proves the CREATE half (a page really was minted;
//     model-level, doesn't depend on rendering at all).
//   - paintOrder().length === 0 proves the RENDER FILTER half (R1): the two
//     seeded shapes are still very much alive in the doc (pageCount alone
//     can't tell you that — shapeCount would, but paintOrder's emptiness on
//     the NEW page is what's load-bearing here), just not painted on this
//     page. Reverting R1's filter (canvas-react/src/ShapeLayer.tsx's
//     `.filter((s) => pageIdOf(snapshot, s) === currentPageId)`) makes every
//     shape paint regardless of page, so paintOrder().length becomes 2, not
//     0 — a clean COUNT assertion failure, never a locator error (the
//     "+ new page" control is always present once U1 lands, and the click
//     itself always succeeds whether or not the filter exists).
//
// NOT included: switching back to page:p and re-asserting the shapes
// reappear. The empty-page filter observation above is what has teeth (see
// the plan's Task Z1 "Final contract shape (chosen)" note) — a round trip
// would only re-prove SetCurrentPage dispatches, which E1's own unit tests
// already pin, and would turn one clean at-end assertion into a fragile
// two-stage one for no additional coverage.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:a'
const ID_B = 'shape:b'

// The switcher's "+" button (PageSwitcher.tsx's module header names this
// exact selector as Z1's anchor).
const NEW_PAGE_SELECTOR = '[data-canvas-v2-new-page]'

export const switchingPageChangesRenderedShapes: Contract = {
  name: 'switching-page-changes-rendered-shapes',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  // Two NON-overlapping geo shapes on the default page (page:p) — enough to
  // prove "the whole page's content vanished from paint", not just one shape.
  scene: () => [
    { id: ID_A, kind: 'geo', x: 100, y: 100, w: 100, h: 100 },
    { id: ID_B, kind: 'geo', x: 300, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click (down+up, no move) the "+ new page" control: U1's `newPageIntents`
    // batches `CreatePage` + `SetCurrentPage` in one applyAll — create AND
    // switch, one commit, so by the time `up` resolves the current page is
    // the freshly-minted, empty one.
    { kind: 'down', at: { ref: 'element', selector: NEW_PAGE_SELECTOR } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const pageCount = obs.pageCount()
    if (pageCount !== 2) {
      return `expected pageCount() === 2 after clicking "+ new page" (page:p plus the newly created page), got ${pageCount}`
    }
    const order = obs.paintOrder()
    if (order.length !== 0) {
      return `expected paintOrder() to be EMPTY on the newly created (and switched-to) page — the render filter (R1) should hide page:p's ${ID_A}/${ID_B} — got ${JSON.stringify(order)}`
    }
    return null
  },
}
