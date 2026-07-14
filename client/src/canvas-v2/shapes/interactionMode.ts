/**
 * INTERACTIVE-CONTENT EVENT POLICY — the pure state machine every Seam-E
 * shape body's interactivity is built on. Decided once here, applied
 * identically by every body (see ./index.ts's module header for the
 * one-paragraph policy statement); this file holds the PURE half (a plain
 * reducer, no React/DOM) so it unit-tests under plain `bun` — the React glue
 * (`useInteractionMode` below) wires it to real double-click/Escape/
 * click-outside events and is intentionally untested here (DOM-dependent;
 * covered by the one real-reconciler test per the house test strategy — see
 * IframeShape.test.ts).
 *
 * OURS v1 (ratified by the controller, stated once): a shape body has TWO
 * interaction states —
 *   'idle'    — a single click selects the shape; pointer/keyboard events
 *               are NOT swallowed, so they reach Viewport/the canvas's own
 *               select/pan/zoom handling exactly like any other shape.
 *   'focused' — entered via a dedicated affordance (double-click on the
 *               body, or an explicit focus-button-strip click a body may
 *               offer instead/in addition — e.g. a heavy embed with no
 *               sensible "double-click surface", though all six ports below
 *               use double-click); pointer/keyboard events ARE swallowed
 *               (stopPropagation) so typing into a terminal, dragging inside
 *               an iframe, etc. never also drives canvas tools. Escape or a
 *               click outside the body's own DOM exits back to 'idle'.
 * This is deliberately NOT full parity with the legacy tldraw builds (which
 * additionally drive tldraw's own editingShapeId, support double-Esc-vs-
 * single-Esc-to-terminal disambiguation, title-bar drag-to-move, etc.) — v1
 * is the minimal, STATED boundary the plan asks for; full parity is
 * G2-golden/Phase-4 territory (see ./index.ts).
 */

export type InteractionMode = 'idle' | 'focused'

export type InteractionEvent =
  | 'focus-request' // double-click / focus-strip click
  | 'exit-request' // Escape / click-outside

/** Pure transition table — total function, every (mode, event) pair has a
 * defined next mode (idempotent no-ops where the event doesn't apply: a
 * focus-request while already focused stays focused; an exit-request while
 * already idle stays idle). */
export function reduceInteractionMode(mode: InteractionMode, event: InteractionEvent): InteractionMode {
  if (event === 'focus-request') return 'focused'
  return 'idle'
}

/** True iff `mode` should stopPropagation on pointer/keyboard events reaching
 * the body — the single predicate every body's event handlers consult, so
 * the idle/focused -> swallow-or-not mapping is decided in exactly one place. */
export function shouldSwallowEvents(mode: InteractionMode): boolean {
  return mode === 'focused'
}
