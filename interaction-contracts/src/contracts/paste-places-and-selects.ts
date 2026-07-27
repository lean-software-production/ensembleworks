// Task K2 (docs/plans/2026-07-22-canvas-v2-copy-paste.md) — the interaction
// contract that discharges D1's Ctrl+C/Ctrl+V wiring: seed two geo shapes,
// marquee-select both, copy, then paste — assert TWO new, distinct shapes
// now exist and are the current selection (the end-to-end "paste"
// characterization; D-5's exact offset and D-3's id-mint scheme are C3/E1's
// pure tests' job, not this contract's).
//
// This exercises the REAL Ctrl+C -> OS clipboard -> Ctrl+V round trip
// (rather than pre-seeding via the `clipboard` Contract field, Task H1) —
// per the task brief's "seed a shape, copy it (Ctrl+C) then paste (Ctrl+V)"
// option — because K3 already exercises the `clipboard` pre-seed path for
// the hostile-payload case; K2 covers the OTHER half of Task H1's plumbing
// (the Playwright clipboard-read/write permission grant) end-to-end too.
//
// Browser-only: like Delete/undo/redo/Ctrl+D, Ctrl+C/Ctrl+V route through
// CanvasV2App.tsx's `handleGlobalShortcut`, never a tool FSM.
//
// RED (Obligation 2/4, teeth-checked live): with D1's `c`/`v` branches
// reverted to no-ops, both keys do nothing — `shapeCount()` stays 2 and
// `selectedShapeIds()` keeps naming the two ORIGINAL (marquee-selected)
// ids, so `check` fails on the count assertion with a clean, specific
// message — never a locator-not-found error (both seeded shapes are always
// present; only the paste is missing). See the K2 task note in the
// copy/paste plan's execution log for the verbatim RED/GREEN pair.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID_A = 'shape:paste-a'
const ID_B = 'shape:paste-b'

export const pastePlacesAndSelects: Contract = {
  name: 'paste-places-and-selects',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  // Two geo shapes side by side, OFFSET from the world origin (x:100/300,
  // matching style-applies-to-selection's proven pattern) so there is clear
  // empty canvas above-left of A for the marquee's down-point to land on
  // (P3's load-bearing lesson: a down ON a shape starts a translate-drag
  // instead of a marquee).
  scene: () => [
    { id: ID_A, kind: 'geo', x: 100, y: 100, w: 100, h: 100 },
    { id: ID_B, kind: 'geo', x: 300, y: 100, w: 100, h: 100 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // Marquee both shapes: down on EMPTY canvas above-left of A, drag past
    // B's bottom-right corner (same sweep style-applies-to-selection uses).
    { kind: 'down', at: { ref: 'shape', id: ID_A, dx: -70, dy: -70 } },
    { kind: 'move', at: { ref: 'shape', id: ID_B, dx: 70, dy: 70 }, steps: 4 },
    { kind: 'up' },
    // Copy the marquee-selected pair to the OS clipboard.
    { kind: 'key', key: 'c', modifiers: { ctrl: true } },
    // Paste: reads the clipboard back and creates a new, re-id'd,
    // re-offset pair, selecting exactly the two new root ids (D-6).
    { kind: 'key', key: 'v', modifiers: { ctrl: true } },
  ],
  check: (obs: Obs): string | null => {
    const count = obs.shapeCount()
    if (count !== 4) {
      return `expected shapeCount() === 4 after marquee-selecting 2 shapes, Ctrl+C, Ctrl+V (2 originals + 2 pasted), got ${count}`
    }
    const ids = obs.selectedShapeIds()
    if (ids.length !== 2) {
      return `expected exactly two shapes selected after paste (the new pasted pair), got ${JSON.stringify(ids)}`
    }
    for (const id of ids) {
      if (id === ID_A || id === ID_B) {
        return `expected the post-paste selection to name NEW, distinct shape ids, but it still names a seeded original (${id}) — paste did not re-id or did not re-select`
      }
    }
    return null
  },
}
