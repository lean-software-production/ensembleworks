// Pilot 3 — the first browser-tagged contract. A pointer sweep across two
// shape bodies' text must NEVER produce a native text selection spanning both
// (a canvas drag selects SHAPES, not text). This is the falsifiable form of
// the QA bug "clicking to select selects text across multiple widgets."
//
// REACHABILITY — all three verified in a real Chromium (see the plan's Phase D
// CHANGE NOTE, both entries):
//  - A TRANSLATE drag (down ON a shape) cannot reproduce it: the per-move
//    TranslateShapes re-render mutates the dragged body's DOM mid-cycle and
//    Chromium drops the cross-element selection.
//  - An IN-VIEWPORT MARQUEE cannot either — but only by side effect:
//    Viewport's handlePointer takes pointer capture on every pointerdown (a
//    best-effort try/catch that exists for DRAG SURVIVAL, not as a selection
//    guarantee), and in Chromium an active pointer capture suppresses the
//    native selection sweep entirely. A/B-verified: no-op the capture and the
//    same in-viewport marquee selects across both bodies.
//  - The USER-REACHABLE RED: anchor the drag OUTSIDE the viewport on the
//    chrome strip above it (non-button chrome — UA stylesheets give <button>
//    user-select:none) and sweep down into the canvas. The pointerdown never
//    hits Viewport, so no capture is taken; the selection's range runs from
//    the chrome anchor to the focus inside the second body, bracketing the
//    first body in document order — it spans both.
// The fix (user-select:none on static shape bodies) protects BOTH sweep paths
// on principle, instead of leaning on capture's accidental shield.
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
  // CHROME-ANCHORED SWEEP: down at viewport-relative (700, -20) — negative y
  // resolves, via resolveAnchor's plain box-offset math, to the chrome strip
  // ABOVE the viewport (page y≈20 for a viewport starting at y=40; verified
  // non-button chrome there) — then sweep into the canvas to (560, 200),
  // inside B's text row. Anchor-before-the-world-layer + focus-inside-B means
  // the selection range brackets A in document order too. steps:12 makes the
  // sweep a continuous drag so the native selection extends the whole way.
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 700, y: -20 } },
    { kind: 'move', at: { ref: 'point', x: 560, y: 200 }, steps: 12 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null =>
    obs.textSelectionSpans() <= 1 ? null : `native selection spans ${obs.textSelectionSpans()} shape bodies (expected <= 1)`,
}
