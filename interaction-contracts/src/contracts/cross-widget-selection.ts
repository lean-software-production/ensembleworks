// Pilot 3 — the first browser-tagged contract. A MARQUEE that starts on empty
// canvas and sweeps across two shape bodies' text must NEVER produce a native
// text selection spanning both (the sweep is a canvas gesture — it selects
// SHAPES, not text). This is the falsifiable form of the QA bug "clicking to
// select selects text across multiple widgets." A translate drag (down ON a
// shape) canNOT reproduce it — the per-move TranslateShapes re-render mutates
// the dragged body's DOM mid-cycle and Chromium drops the cross-element
// selection; only the marquee, whose onMarquee emits NO intents on pointermove
// (select.ts — "no live-preview intent exists yet"), leaves the DOM untouched
// long enough for the native selection to sweep across both bodies.
// Falsifiable only in a real browser via window.getSelection().
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const A = 'shape:cw-a', B = 'shape:cw-b'

export const crossWidgetSelection: Contract = {
  name: 'no-cross-widget-text-selection',
  level: 'browser',
  when: 'every-event',
  // Two notes side by side (world coords; identity camera == 1:1 screen). The
  // browser runner's seedScene sets each shape's live text, so both bodies
  // render selectable text centred at (200,200) and (500,200).
  scene: () => [
    { id: A, kind: 'note', x: 100, y: 100, w: 200, h: 200 },
    { id: B, kind: 'note', x: 400, y: 100, w: 200, h: 200 },
  ],
  // MARQUEE: down on EMPTY canvas (x=60, left of A — targetId===null routes
  // select.ts to marquee mode), then sweep RIGHT at y=200 through A's centred
  // text (~200,200) and into B's (~500,200), then up. steps:12 makes the sweep
  // a continuous drag so the native selection extends the whole way.
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 60, y: 200 } },
    { kind: 'move', at: { ref: 'point', x: 560, y: 200 }, steps: 12 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null =>
    obs.textSelectionSpans() <= 1 ? null : `native selection spans ${obs.textSelectionSpans()} shape bodies (expected <= 1)`,
}
