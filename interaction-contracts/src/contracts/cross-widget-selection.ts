// Pilot 3 — the first browser-tagged contract. A pointer drag that starts on
// one shape body and ends on another must NEVER produce a native text
// selection spanning both (the drag is a canvas gesture, not a text
// selection). Falsifiable only in a real browser via window.getSelection().
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const A = 'shape:cw-a', B = 'shape:cw-b'

export const crossWidgetSelection: Contract = {
  name: 'no-cross-widget-text-selection',
  level: 'browser',
  when: 'every-event',
  scene: () => [
    { id: A, kind: 'note', x: 100, y: 100, w: 200, h: 200 },
    { id: B, kind: 'note', x: 400, y: 100, w: 200, h: 200 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: A } },
    { kind: 'move', at: { ref: 'shape', id: B }, steps: 6 }, // drag across the gap onto B
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null =>
    obs.textSelectionSpans() <= 1 ? null : `native selection spans ${obs.textSelectionSpans()} shape bodies (expected <= 1)`,
}
