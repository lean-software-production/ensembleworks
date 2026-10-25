// Pane input routing task (follow-up after live test) -- companion to
// bbthread-pane-double-click-begins-editing.ts: once a double-click inside
// the thread pane has begun editing the bbthread, Escape must end it. The
// pane mounts no DOM textarea of its own (unlike note/text/geo, which exit
// editing via their textarea's own Escape/blur handling), so ending the
// edit has to be a decision the SELECT TOOL/editor itself makes on the
// Escape keydown, not something the pane's (nonexistent) editing surface
// does for it.
//
// RED (recorded verbatim in the task report before the fix landed): while
// `editingId` is set, select.ts's idle-state keydown handling recognizes
// only 'Enter' (edit-selection) and the arrow-nudge keys -- Escape falls
// through to the default `{ state, intents: [] }` branch, so editingShape()
// stays `'shape:bbthread'` after the keypress instead of going back to null.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadEscapeEndsEditing: Contract = {
  name: 'bbthread-escape-ends-editing',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    // The same double-click bbthread-pane-double-click-begins-editing.ts
    // uses to begin editing the pane...
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } },
    { kind: 'up' },
    // ...then Escape.
    { kind: 'key', key: 'Escape' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== null) {
      return `Escape while editing the bbthread's thread pane did not end the edit (editingShape: ${JSON.stringify(obs.editingShape())}, expected null)`
    }
    return null
  },
}
