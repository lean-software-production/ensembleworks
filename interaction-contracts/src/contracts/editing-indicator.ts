// Pilot 5 (F1 owner decision: Option 1 — indicator, no lock). Browser-only,
// MULTI-actor: two real clients (A and B) joined to the SAME room. A opens
// the editor on a shape; B must SEE a non-blocking "A is editing" indicator
// on that shape, driven purely off A's presence.editing (canvas-sync/src/
// presence.ts) — B is never prevented from also entering the editor (the
// documented, already-deferred rich-text merge remains the real fix for the
// concurrent setText LWW stomp; this contract does not assert anything about
// that). FSM-unobservable by construction: a peer's remote indicator is a
// rendered DOM element on the OTHER client, not a concept either editor FSM
// has any notion of — this contract has no `level: 'fsm'` counterpart.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:lock'

export const editingIndicator: Contract = {
  name: 'peer-editing-is-visible',
  level: 'browser',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Actor A opens the editor on the shape (double-click-to-edit).
    { actor: 'A', kind: 'down', at: { ref: 'shape', id: ID } }, { actor: 'A', kind: 'up' },
    { actor: 'A', kind: 'down', at: { ref: 'shape', id: ID } }, { actor: 'A', kind: 'up' },
    { actor: 'A', kind: 'key', key: 'x' }, // type something so editing is unambiguous
  ],
  check: (obs: Obs): string | null =>
    obs.on('B').peerEditingIndicator(ID)
      ? null
      : `peer B does not see that A is editing ${ID} (no editing indicator)`,
}
