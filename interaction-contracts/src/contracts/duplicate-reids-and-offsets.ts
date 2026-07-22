// Task K1 (docs/plans/2026-07-22-canvas-v2-copy-paste.md) — the interaction
// contract that discharges D1's Ctrl+D wiring: seed one geo shape, click it
// to select, press Ctrl+D, and assert a NEW, distinct shape now exists (the
// end-to-end "duplicate" characterization — the exact +20 offset is C3's
// pure `cloneWithNewIds` test's job, not this contract's).
//
// Browser-only: like Delete/undo/redo, Ctrl+D routes through
// CanvasV2App.tsx's `handleGlobalShortcut`, never a tool FSM — the FSM
// runner drives tool FSMs only (types.ts's `Obs`/`Contract` doc comments,
// CLAUDE.md's "Copy/paste/duplicate are keyboard + clipboard driven" note),
// so this can only run through real Playwright input against a live
// ?engine=v2 room.
//
// RED (Obligation 2/4, teeth-checked live): with D1's Ctrl+D branch reverted
// to a no-op, the key does nothing — `shapeCount()` stays 1 and
// `selectedShapeIds()` stays `[ID]` (the click-select never changes), so
// this contract's `check` fails on the COUNT assertion with a clean,
// specific message — never a Playwright locator-not-found error (the seeded
// shape is always there; only the duplicate is missing). See the K1 task
// note in the copy/paste plan's execution log for the verbatim RED/GREEN
// pair captured for this revert.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:dup-source'

export const duplicateReidsAndOffsets: Contract = {
  name: 'duplicate-reids-and-offsets',
  level: 'browser',
  tool: 'select',
  // Single gesture (click, then Ctrl+D) with nothing transient to catch
  // mid-flight — checking once after both ops land is sufficient and avoids
  // a spurious 'every-event' failure right after the click (before Ctrl+D
  // has run), mirroring style-applies-to-selection's own 'at-end' choice.
  when: 'at-end',
  // One shape, offset from the world origin — plenty of clear empty canvas
  // around it so the click's down-point lands squarely ON the shape (a
  // `dx:0,dy:0` shape anchor resolves to its centre) rather than risking an
  // edge case near (0,0).
  scene: () => [{ id: ID, kind: 'geo', x: 200, y: 200, w: 100, h: 100 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Click (down+up, no move) on the shape's centre: select.ts's Pointing
    // state resolves this as a plain click-select (SetSelection([ID])), not
    // a translate-drag (crossedThreshold never fires with zero movement).
    { kind: 'down', at: { ref: 'shape', id: ID, dx: 0, dy: 0 } },
    { kind: 'up' },
    // Ctrl+D: the duplicate shortcut (clipboard-dom.ts's `clipboardShortcut`
    // maps 'd' + ctrl/meta to 'duplicate'; CanvasV2App.tsx's
    // `handleGlobalShortcut` calls `duplicateSelectionIntents` synchronously
    // — no clipboard I/O at all for this action).
    { kind: 'key', key: 'd', modifiers: { ctrl: true } },
  ],
  check: (obs: Obs): string | null => {
    const count = obs.shapeCount()
    if (count !== 2) {
      return `expected shapeCount() === 2 after selecting shape ${ID} and pressing Ctrl+D (1 original + 1 duplicate), got ${count}`
    }
    const ids = obs.selectedShapeIds()
    if (ids.length !== 1) {
      return `expected exactly one shape selected after Ctrl+D (the new duplicate), got ${JSON.stringify(ids)}`
    }
    if (ids[0] === ID) {
      return `expected the post-duplicate selection to name a NEW, distinct shape id, but it still names the original ${ID} — duplicate did not re-id or did not re-select`
    }
    return null
  },
}
