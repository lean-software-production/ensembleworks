// Normalized input events: the ONE shape every pointer/keyboard/wheel event
// gets rewritten into before it reaches a tool FSM, regardless of source
// (a real browser event in canvas-react, or a hand-built script.ts sequence
// in a test). Coordinates are SCREEN space (pixels in the viewport, before
// the camera's screen->world transform — that conversion lives wherever the
// camera is applied, i.e. the hand tool / canvas-react, not here). `t` is
// ALWAYS caller-injected, never read from a wall clock here — the boundary
// test forbids reading one directly in this file, and determinism (same
// script -> identical event array) depends on every timestamp being
// supplied, never sampled.
export interface Modifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
  readonly meta: boolean
}

export interface PointerInputEvent {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup'
  readonly x: number
  readonly y: number
  /** Bitmask of currently-pressed buttons (DOM PointerEvent.buttons
   * convention: 1 = primary). 0 on pointerup unless another button is still
   * held. */
  readonly buttons: number
  readonly modifiers: Modifiers
  readonly t: number
}

export interface KeyInputEvent {
  readonly type: 'keydown' | 'keyup'
  readonly key: string
  readonly modifiers: Modifiers
  readonly t: number
}

export interface WheelInputEvent {
  readonly type: 'wheel'
  readonly x: number
  readonly y: number
  readonly dx: number
  readonly dy: number
  readonly modifiers: Modifiers
  readonly t: number
}

export type InputEvent = PointerInputEvent | KeyInputEvent | WheelInputEvent

// tldraw's own drag-start threshold, read from source rather than assumed:
// node_modules, @tldraw's editor package, dist-cjs/lib/options.js:36 —
//   dragDistanceSquared: 16,  // 4 squared
// i.e. tldraw starts a drag once the pointer has moved 4 SCREEN pixels from
// its down-point (for a fine/mouse pointer — options.js also has a larger
// `coarseDragDistanceSquared: 36` (6px) for touch, which OURS does not yet
// distinguish; see the note below). Pinned here to match: the select tool
// (C4) is the consumer, deciding pointing -> dragging off this exact value.
export const DRAG_THRESHOLD = 4

/**
 * Has the pointer moved far enough from `a` to `b` to count as a drag
 * (rather than a click), per DRAG_THRESHOLD? Squared-distance comparison
 * (matches tldraw's own dragDistanceSquared, avoiding a sqrt per call).
 *
 * SCOPE: this operates in SCREEN pixels and is zoom-INDEPENDENT at this
 * layer — a 4px screen movement is a 4px screen movement whether the camera
 * is zoomed in or out. Where zoom needs to enter the decision (tldraw
 * scales its coarse-pointer threshold by zoom in some contexts) is the
 * select tool's problem (C4), applied AFTER converting screen deltas to
 * world space via the camera transform that lives with the hand tool /
 * canvas-react — not here, since this module has no notion of a camera.
 */
export function exceedsDragThreshold(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD
}

/** Pure FSM contract every tool (select/hand/create/arrow/transform)
 * implements: given its own current state and one normalized InputEvent,
 * return the next state and zero or more Intents. `run()` (script.ts) is the
 * dispatch loop that drives this against a live Editor; nothing about the
 * interface itself touches a doc, a DOM, or a clock — that is exactly what
 * makes a tool replayable from a recorded InputEvent[] with no environment
 * at all. */
export interface Tool<S> {
  readonly initialState: S
  onEvent(state: S, event: InputEvent): { state: S; intents: import('./intents.js').Intent[] }
}
