// Task Z1 (docs/plans/2026-07-22-canvas-v2-zorder.md) — the interaction
// contract that discharges this z-order sub-cycle's CLAUDE.md obligation:
// seed THREE non-overlapping geo shapes (initial paint order = id order,
// since every seeded shape carries index 'a1' and the renderer tie-breaks on
// id — D-2/A2), click the BOTTOM (first-in-paint-order) shape to select it,
// press Shift+] (bring-to-front), and assert via paintOrder() that the
// selected shape is now LAST in paint order (on top of everything else).
//
// Browser-only: reorder is keyboard-driven through CanvasV2App.tsx's
// `handleGlobalShortcut`, never a tool FSM (like Delete/undo/copy/paste) —
// the FSM runner drives tool FSMs only, so this can only run through real
// Playwright input against a live ?engine=v2 room. Also, `paintOrder()`
// itself is browser-only by construction (H1) — it reads the renderer's DOM
// paint order, which has no headless equivalent.
//
// RED (Obligation 2/4, teeth-checked live): with D1's reorder branch
// reverted to a no-op, Shift+] does nothing — shape:a keeps index 'a1', so
// paint order stays [a, b, c] and the LAST element is shape:c, not shape:a —
// a clean, specific "shape didn't move to top" assertion failure, never a
// Playwright locator-not-found error (all three shapes are always present
// and visible). See the Z1 task note in the z-order plan's execution log for
// the verbatim RED/GREEN pair captured for this revert.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:a'
const ID_B = 'shape:b'
const ID_C = 'shape:c'

export const bringToFrontPaintsOnTop: Contract = {
  name: 'bring-to-front-paints-on-top',
  level: 'browser',
  tool: 'select',
  // Single gesture (click, then Shift+]) with nothing transient to catch
  // mid-flight — checking once after both ops land avoids a spurious
  // failure right after the click (before the reorder key has run),
  // mirroring style-applies-to-selection's / duplicate-reids-and-offsets'
  // own 'at-end' choice.
  when: 'at-end',
  // Three NON-overlapping geo shapes (so "on top" is proven by paint order,
  // not by visual occlusion) with ids that sort shape:a < shape:b < shape:c
  // lexically. All default to index 'a1' (seedScene/putShape's convention),
  // so the (index, id) tie-break (D-2/A2) makes the INITIAL paint order
  // exactly the id order [a, b, c] — c on top, a on the bottom.
  scene: () => [
    { id: ID_A, kind: 'geo', x: 100, y: 100, w: 100, h: 100 },
    { id: ID_B, kind: 'geo', x: 300, y: 100, w: 100, h: 100 },
    { id: ID_C, kind: 'geo', x: 500, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click (down+up, no move) on shape:a's centre: select.ts's Pointing
    // state resolves this as a plain click-select (SetSelection([a])), not
    // a translate-drag (crossedThreshold never fires with zero movement).
    { kind: 'down', at: { ref: 'shape', id: ID_A, dx: 0, dy: 0 } },
    { kind: 'up' },
    // Shift+] : D-6/D1's bring-to-front shortcut. Shift+`]` arrives as
    // `event.key === '}'` (verified against reorder-dom.ts's
    // `reorderShortcut`, which matches on the delivered character, not a
    // separate shift flag) — so the gesture presses the literal '}'
    // character, which Playwright's `page.keyboard.press('}')` delivers as
    // `event.key === '}'` (the same shifted-key delivery the undo code's
    // `key.toLowerCase()` comment documents elsewhere in this codebase).
    { kind: 'key', key: '}' },
  ],
  check: (obs: Obs): string | null => {
    const order = obs.paintOrder()
    if (order.length === 0) {
      return `expected paintOrder() to report the 3 seeded shapes, got an empty order`
    }
    if (order[order.length - 1] !== ID_A) {
      return `expected ${ID_A} (bring-to-front target) to be LAST in paint order (on top) after selecting it and pressing Shift+], got order ${JSON.stringify(order)}`
    }
    return null
  },
}
