// Pane input routing task (follow-up after live test, docs/plans/
// 2026-09-15-bb-thread-frame.md's "Pane input routing" section): a
// double-click inside a `bbthread`'s solid right-third thread pane
// (canvas-model's `bbthreadPaneLocalBounds`) must begin EDITING the shape
// (`region: 'body'`), exactly like double-clicking a text-capable shape's
// body -- even though 'bbthread' is never text-capable (isTextCapableKind
// excludes it, same as every other frame-like kind) and the pane sits well
// clear of the header band double-click already opens a rename for
// (frame-header-double-click-renames.ts).
//
// RED (recorded verbatim in the task report before the fix landed): select.ts's
// double-click gate only fires BeginEdit for a text-capable shape
// (isTextCapableKind) or a frame-like shape's HEADER band
// (isPointInFrameHeaderBand/opensFrameRename) -- neither condition is true
// for a click inside the pane, so the double-click falls through to the
// ordinary click-select branch and editingShape() stays null throughout.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadPaneDoubleClickBeginsEditing: Contract = {
  name: 'bbthread-pane-double-click-begins-editing',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    // A 900x600 bbthread at the origin -- the right-third pane spans local x
    // in [600,900], spanning the full local height y in [0,600] (the header band sits above this, at negative y, exactly like a plain frame's). (800,300) is
    // well inside the pane, clear of both the header band and the 8px edge
    // margin on every side (mirrors bbthread-pane-is-solid.ts's own fixture).
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== BBTHREAD_ID) {
      return `double-clicking inside the bbthread's thread pane did not begin editing it (editingShape: ${JSON.stringify(obs.editingShape())}, expected ${JSON.stringify(BBTHREAD_ID)})`
    }
    return null
  },
}
