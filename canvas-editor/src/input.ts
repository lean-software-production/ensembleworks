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
  /** Stylus pressure, 0..1 — RECORDED on the event, never sampled inside a
   * tool FSM (same replay-safety posture as `t`: input.ts's header
   * mandates every timestamp be caller-injected, never read from a wall
   * clock; this field extends that rule to pressure). `undefined` means "no
   * real pen signal" — canvas-react's DOM normalization (Task W1) sets this
   * ONLY for `pointerType === 'pen'`, leaving it `undefined` for mouse/touch,
   * so `event.pressure !== undefined` is the pen tool's own pen-vs-mouse
   * test (Task T1, Decision D-3). */
  readonly pressure?: number
  /** DOM `PointerEvent.pointerId` — the identity that makes MULTI-POINTER
   * input representable at all (mobile-touch task). `undefined` means "this
   * source has no pointer identity" (a hand-built script step, a fabricated
   * test event), and every multi-pointer consumer treats an id-less event as
   * a plain single pointer — so every pre-existing script/replay stays
   * byte-identical in meaning. Carried, never interpreted, by the tool FSMs:
   * only multi-touch.ts's recognizer reads it. */
  readonly pointerId?: number
  /** DOM `PointerEvent.pointerType`. `undefined` = unknown device (the same
   * "no signal" posture `pressure` takes). TWO consumers, both of which need
   * to know a FINGER from a mouse rather than guess:
   *   - multi-touch.ts, which only ever forms a pinch out of 'touch'
   *     pointers (a pen and a finger together is not a pinch, and a mouse
   *     can never produce two simultaneous pointers anyway);
   *   - the coarse-pointer hit tolerances (transform.ts's
   *     `hitTolerancePx`, select.ts's divider band), which widen a small
   *     fixed target to a finger-sized one.
   * NOTE this is deliberately NOT the same signal as a CSS `(pointer:
   * coarse)` media query: that describes the device's PRIMARY pointer, while
   * this describes the pointer that actually produced THIS event — a tablet
   * with a mouse attached, or a touchscreen laptop, gives different answers,
   * and the per-event one is the correct one for a hit test. */
  readonly pointerType?: 'mouse' | 'pen' | 'touch'
}

/** A two-finger pinch/pan sample — the ONE event kind no single DOM event
 * maps to (mobile-touch task). The browser delivers two independent pointer
 * streams; multi-touch.ts's pure recognizer folds a pair of them into these,
 * and camera.ts's `applyPinch` is the only consumer. It rides the SAME
 * `InputEvent` funnel as wheel rather than bypassing it, so a pinch is
 * replayable, scriptable, and observable by exactly the same machinery a
 * wheel-zoom is.
 *
 * `x`/`y` are the PREVIOUS sample's two-finger midpoint in SCREEN space (the
 * point the zoom is anchored about — the world point under it is what stays
 * put), `factor` is the multiplicative zoom for this sample (fingers
 * spreading => > 1 => zoom IN), and `dx`/`dy` are how far that midpoint
 * TRAVELLED since the previous sample, in screen pixels — which is the
 * two-finger PAN half of the same gesture. Note the sign convention differs
 * from `WheelInputEvent` on purpose and the difference is real: a wheel's
 * dy is how far the WHEEL turned (content moves the other way), while a
 * pinch's dx/dy is how far the FINGERS moved (content follows them). */
export interface PinchInputEvent {
  readonly type: 'pinch'
  readonly x: number
  readonly y: number
  readonly factor: number
  readonly dx: number
  readonly dy: number
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
  /** SIGN CONVENTION (normative): dx/dy mirror DOM WheelEvent.deltaX/deltaY
   * EXACTLY, no re-signing at this layer — positive dy = wheel scrolled
   * down/away from the user, which a camera consumer conventionally
   * interprets as zoom OUT (and positive dx = scroll right). Whatever the
   * renderer receives from the browser it forwards verbatim; scripts
   * (script.ts's .wheel()) inject the same DOM-convention values. Pinned by
   * script.test.ts's wheel-sign assertion. */
  readonly dx: number
  readonly dy: number
  readonly modifiers: Modifiers
  readonly t: number
}

// NOTE `PinchInputEvent` is part of this union, so a tool FSM's `onEvent`
// receives it like any other event — every shipped tool simply ignores an
// event type it does not handle (they all switch on `event.type` and fall
// through), and the session funnel consumes a pinch itself before dispatch
// anyway (canvas-ui's useCanvasSession, exactly as it already does for
// 'wheel').
export type InputEvent = PointerInputEvent | KeyInputEvent | WheelInputEvent | PinchInputEvent

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

/**
 * The pointing-state pointermove guard every drag-capable tool shares
 * (select/hand/create today; the arrow/transform tools of C7/C8 next): has
 * this pointermove crossed DRAG_THRESHOLD from `downScreen`? Returns the
 * event's SCREEN point ({x, y}, ready to use as the drag's first "here")
 * when it has, or null when the tool should stay in its pointing state.
 * Exactly exceedsDragThreshold plus the point-plucking every call site was
 * repeating — extracted once so the threshold idiom can't drift between
 * tools.
 */
export function crossedThreshold(
  downScreen: { readonly x: number; readonly y: number },
  event: { readonly x: number; readonly y: number },
): { x: number; y: number } | null {
  return exceedsDragThreshold(downScreen, event) ? { x: event.x, y: event.y } : null
}

// tldraw's own double-click TIME window, read from source rather than
// assumed: the installed @tldraw's editor package, dist-cjs/lib/options.js:32 —
//   doubleClickDurationMs: 450,
// i.e. two clicks resolve as a double-click when the second lands within
// 450ms of the first (tldraw's ClickManager schedules the "settle" dispatch
// at exactly this timeout — dist-cjs/lib/editor/managers/ClickManager module).
// Pinned here to match: the select tool (Unit 13) is the consumer, deciding a
// completed click's double-click-ness off this exact value, using event.t
// deltas only — never a wall clock (this module's own determinism rule).
export const DOUBLE_CLICK_MS = 450

// tldraw's own double-click DISTANCE tolerance, same source file:
// dist-cjs/lib/editor/managers/ClickManager module, line 32 —
//   const MAX_CLICK_DISTANCE = 40;
// — compared as a SCREEN-pixel distance between the two clicks' points
// (squared, matching exceedsDragThreshold's own squared comparison below, to
// avoid a sqrt per call).
export const DOUBLE_CLICK_RADIUS_PX = 40

/**
 * Do two completed clicks (each `{x, y, t}` in SCREEN space) count as one
 * double-click, per DOUBLE_CLICK_MS/DOUBLE_CLICK_RADIUS_PX above? This module
 * has no notion of a target shape id — the select tool layers the "same
 * target" requirement on top (see select.ts). A negative `dt` (a caller
 * passing events out of order) is treated as "not a double-click" rather than
 * silently accepting it via an unsigned distance check on time — a real
 * second click always has `next.t > prev.t`.
 */
export function isDoubleClick(
  prev: { readonly x: number; readonly y: number; readonly t: number },
  next: { readonly x: number; readonly y: number; readonly t: number },
): boolean {
  const dt = next.t - prev.t
  if (dt < 0 || dt > DOUBLE_CLICK_MS) return false
  const dx = next.x - prev.x
  const dy = next.y - prev.y
  return dx * dx + dy * dy <= DOUBLE_CLICK_RADIUS_PX * DOUBLE_CLICK_RADIUS_PX
}

// ============================================================================
// CAMERA CONVENTION (NORMATIVE — D2's CSS world transform and C5's
// zoom-about-cursor must BOTH derive from these two helpers, never re-derive
// the formula locally; a sign/order disagreement between the renderer's
// transform and the editor's screen->world reads makes every click land on
// the wrong shape):
//
//   screen = (world + camera.xy) · camera.z
//   world  = screen / camera.z − camera.xy
//
// This is tldraw's own convention, read from source rather than assumed —
// the installed @tldraw editor package, dist-cjs/lib/editor/Editor.js
// (pageToScreen: `(point.x + cx) * cz + screenBounds.x`; screenToPage:
// `(point.x - screenBounds.x) / cz - cx`), minus the screenBounds term:
// tldraw's screen space is window-relative so it offsets by the editor
// element's position, whereas OUR screen space (InputEvent x/y) is already
// viewport-relative — the renderer subtracts the element offset when it
// normalizes the DOM event, so these helpers never see it. camera.xy is
// therefore "the world-space translation applied BEFORE zoom" (equal to the
// world point visible at screen (0,0) negated), and camera.z is the zoom
// factor (z > 1 zooms in). Equivalent CSS (D2):
//   transform: scale(camera.z) translate(camera.x px, camera.y px)
// ============================================================================

/** The camera triple as EditorState holds it (structural — editor.ts's
 * EditorState.camera satisfies it without importing this type). */
export interface Camera { readonly x: number; readonly y: number; readonly z: number }

export function worldToScreen(camera: Camera, point: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: (point.x + camera.x) * camera.z, y: (point.y + camera.y) * camera.z }
}

export function screenToWorld(camera: Camera, point: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: point.x / camera.z - camera.x, y: point.y / camera.z - camera.y }
}

/** Pure FSM contract every tool (select/hand/create/arrow/transform)
 * implements: given its own current state and one normalized InputEvent,
 * return the next state and zero or more Intents. `run()` (script.ts) is the
 * dispatch loop that drives this against a live Editor; nothing about the
 * interface itself touches a doc, a DOM, or a clock — that is exactly what
 * makes a tool replayable from a recorded InputEvent[] with no environment
 * at all.
 *
 * CONSTRUCTION PATTERN (normative for C4+): tools are built by a factory
 * closing over the Editor — `const makeSelectTool = (editor: Editor):
 * Tool<SelectState> => ({ ... })` — so onEvent can read the doc
 * (editor.doc.getShape/listShapes), the editor-local state (editor.get()),
 * and any spatial index the tool maintains, while the Tool interface itself
 * stays a pure (state, event) -> (state', intents) function of what it
 * closed over. One convention, three consumers (C4/C5/C6) — don't invent
 * another.
 *
 * SPATIAL-INDEX CADENCE: a tool that hit-tests builds its index via
 * buildSpatialIndex(dumpModel(editor.doc)) and refreshes it once per DOC
 * COMMIT (subscribe via editor.doc.subscribe), NOT per pointermove — the
 * STALENESS CONTRACT at the top of canvas-model/src/spatial-index.ts is
 * normative here: mid-drag correctness comes from snapCandidates'
 * excludedIds, and a stale index yields omissions, never false hits, for
 * the quad-exact queries. */
export interface Tool<S> {
  readonly initialState: S
  onEvent(state: S, event: InputEvent): { state: S; intents: import('./intents.js').Intent[] }
}
