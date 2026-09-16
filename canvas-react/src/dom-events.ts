// Pure DOM-event -> InputEvent mappers. These are the ONLY place canvas-react
// translates a browser event into canvas-editor's normalized InputEvent
// union (input.ts) — Viewport.tsx calls them, then hands the result straight
// to its `onInput` prop; nothing in this module runs a tool or touches an
// Editor.
//
// STRUCTURAL PARAMETER TYPES (deliberate): each mapper accepts a plain
// structural interface (PointerEventLike/WheelEventLike/KeyEventLike) built
// from exactly the fields it reads, NOT `PointerEvent`/`WheelEvent`/
// `KeyboardEvent` or React's `SyntheticEvent<...>` wrapper types. Two
// reasons: (1) a real DOM event class satisfies the structural type for
// free, so Viewport.tsx passes native/React events straight through with no
// cast; (2) viewport.test.ts (no DOM emulator in the house test rig — see
// its header) can fabricate plain `{ ... }` object literals and get EXACT,
// deterministic mapping with no jsdom/happy-dom dependency.
//
// COORDINATES (NORMATIVE, matches input.ts's InputEvent doc comment): our
// screen space is VIEWPORT-RELATIVE, not window-relative — the mapper
// subtracts the viewport element's own `getBoundingClientRect()` offset from
// clientX/clientY so a click at the viewport's top-left corner always
// produces (0, 0) regardless of where the viewport sits on the page. This is
// exactly what camera.ts's CAMERA CONVENTION block cites as the difference
// from tldraw's own screenToPage (which subtracts screenBounds itself
// because ITS screen space is window-relative) — ours already IS
// viewport-relative by the time worldToScreen/screenToWorld ever see it, so
// those functions never need a screenBounds term.
//
// CLOCK: `t` is always `event.timeStamp` (the DOM event's own high-res
// timestamp), never a wall-clock read here — this module has no `Date.now`/
// `performance.now` call of its own, keeping the makeId collision contract's
// clock domain (input.ts: "t is ALWAYS caller-injected") intact all the way
// out to the real browser event.
//
// MULTI-POINTER (mobile-touch task — this block previously declared a
// SINGLE-POINTER V1 SCOPE and predicted that "widening the event union for
// multi-pointer/pointer-kind is a Phase 4 concern that starts in canvas-
// editor's input.ts, not here"; that is exactly what happened): the mapped
// event now carries `pointerId` and `pointerType` through verbatim. This
// module still decides NOTHING with them — it does not know what a pinch is.
// Two consumers downstream do: canvas-editor's multi-touch.ts (which folds a
// pair of touch streams into one pinch) and its coarse-pointer hit tolerances.
// The mapper's job is unchanged: carry what the browser said, interpret none
// of it.
//
// `pointerType` is NARROWED to the 'mouse' | 'pen' | 'touch' union rather than
// passed as the DOM's bare `string`, because that is what the InputEvent's
// field is — and an unrecognized value (the spec permits "" for a device that
// cannot classify itself) maps to `undefined`, i.e. "unknown device", which
// every consumer already handles as the conservative fine-pointer default.
// Passing "" through as a truthy-but-meaningless string is how a device with a
// broken driver would silently get mouse behaviour spelled as something else.
import type { InputEvent, KeyInputEvent, Modifiers, PointerInputEvent, WheelInputEvent } from '@ensembleworks/canvas-editor'

/** Structural subset of `Element` this predicate needs — real DOM elements
 * satisfy it for free, and a fabricated test double (`{ closest: () => ({})
 * }`) needs nothing more (same structural-typing posture as this module's
 * other Like interfaces). */
interface ClosestLike {
  closest(selector: string): unknown
}

/** True when `target` is (or is nested inside) an element the HOST has
 * marked `data-canvas-interactive` — the Viewport's "yield to interactive
 * content" rule (pane input routing task, docs/plans/
 * 2026-09-15-bb-thread-frame.md's follow-up section): a bb thread pane
 * mounts this attribute only while it owns real text selection/scroll (the
 * `editingId === shape.id && editingRegion === 'body'` window — see
 * canvas-editor's EditorState.editingRegion), so the viewport must not
 * capture/forward pointer input, must not forward or `preventDefault` a
 * wheel, and must not forward most keys while the event originated there —
 * see Viewport.tsx's handlePointer/handleWheel/handleKey for where this
 * predicate gates each of those three input kinds.
 *
 * Duck-typed on `.closest` (not `instanceof Element`) so a fabricated test
 * double works with no real DOM (this file's/viewport.test.ts's no-DOM
 * house style) — `null`, a non-Element structural value with no `closest`
 * method, and a real ancestor chain with no matching element all correctly
 * report `false`. */
export function yieldsToInteractive(target: EventTarget | null): boolean {
  if (target === null) return false
  const el = target as Partial<ClosestLike>
  if (typeof el.closest !== 'function') return false
  return el.closest('[data-canvas-interactive]') !== null
}

/** Subset of DOMRect this module needs — a plain `{ left, top }` object
 * satisfies it, no real DOMRect required (see fabrication note above). */
export interface RectLike {
  readonly left: number
  readonly top: number
}

interface ModifierFields {
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

function modifiersOf(e: ModifierFields): Modifiers {
  return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey }
}

/** Structural shape of a PointerEvent (native or React's SyntheticEvent
 * wrapper — both satisfy this). `type` is read as a bare `string` (not the
 * narrower `'pointerdown' | 'pointermove' | 'pointerup'` union) because the
 * DOM's own PointerEvent.type is typed `string`; the mapper trusts its
 * caller to invoke it only from a pointerdown/pointermove/pointerup
 * listener (Viewport.tsx wires exactly those three and no others). */
export interface PointerEventLike extends ModifierFields {
  readonly type: string
  readonly clientX: number
  readonly clientY: number
  /** Bitmask of currently-pressed buttons — DOM PointerEvent.buttons
   * convention, passed through verbatim (see input.ts's PointerInputEvent
   * doc comment). */
  readonly buttons: number
  readonly timeStamp: number
  /** OPTIONAL — forwarded onto the mapped event when present (see the
   * MULTI-POINTER note in the module header), and also what Viewport.tsx's
   * pointer-capture path consumes off the same event object. Optional so
   * fabricated test events remain valid without it. */
  readonly pointerId?: number
  /** DOM PointerEvent.pointerType ('mouse' | 'pen' | 'touch'). OPTIONAL:
   * absent on fabricated test events that predate this field, and on any
   * environment that never sets it. Read to gate `pressure` below (Task W1,
   * D-3) AND forwarded onto the mapped event, narrowed — see the module
   * header's MULTI-POINTER note. Typed as a bare `string` here because the
   * DOM's own field is one; `pointerTypeField` does the narrowing. */
  readonly pointerType?: string
  /** DOM PointerEvent.pressure, 0..1. Read ONLY when `pointerType==='pen'`
   * (see `pressureField` below) — a mouse's pressure is a meaningless
   * 0-or-0.5 constant, not a real signal (D-3), so it is deliberately
   * dropped rather than forwarded. */
  readonly pressure?: number
}

/** D-3's device-gate, mirrored from canvas-editor/script.ts's own
 * `pressureField` helper (same not-imported rationale as this file's other
 * mini-helpers: that one lives in a different package and is private there):
 * `pressure` is spread onto the mapped event ONLY for a real stylus
 * (`pointerType==='pen'`) — mouse/touch, and anything with no `pointerType`
 * at all, get NO `pressure` key whatsoever, not an explicit `pressure:
 * undefined`. That distinction matters: `event.pressure !== undefined` is
 * the pen tool's own pen-vs-mouse switch (draw.ts), and downstream code
 * (canvas-editor's replay/serialization) treats an explicit `undefined` key
 * differently from the key's outright absence — see script.ts's own
 * `pressureField` doc comment for the identical discipline on the FSM-test
 * injection side. */
function pressureField(e: PointerEventLike): { pressure: number } | Record<string, never> {
  return e.pointerType === 'pen' && e.pressure !== undefined ? { pressure: e.pressure } : {}
}

/** The narrowing gate described in the module header's MULTI-POINTER note.
 * Absent-key discipline, exactly like `pressureField`: an unrecognized or
 * missing pointerType writes NO key rather than an explicit `undefined`, which
 * keeps a mapped event structurally identical to a hand-built script one. */
function pointerTypeField(e: PointerEventLike): { pointerType: PointerInputEvent['pointerType'] } | Record<string, never> {
  return e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === 'touch' ? { pointerType: e.pointerType } : {}
}

function pointerIdField(e: PointerEventLike): { pointerId: number } | Record<string, never> {
  return typeof e.pointerId === 'number' ? { pointerId: e.pointerId } : {}
}

export function pointerEventToInput(e: PointerEventLike, viewportRect: RectLike): PointerInputEvent {
  return {
    type: e.type as PointerInputEvent['type'],
    x: e.clientX - viewportRect.left,
    y: e.clientY - viewportRect.top,
    buttons: e.buttons,
    modifiers: modifiersOf(e),
    t: e.timeStamp,
    ...pressureField(e),
    ...pointerIdField(e),
    ...pointerTypeField(e),
  }
}

/** Structural shape of a WheelEvent. dx/dy are read straight off
 * deltaX/deltaY with NO re-signing — input.ts's WheelInputEvent contract
 * ("dx/dy mirror DOM WheelEvent.deltaX/deltaY EXACTLY") is upheld by simply
 * not touching the sign here; camera.ts's applyWheel is where any
 * sign/curve interpretation happens, not this mapper. */
export interface WheelEventLike extends ModifierFields {
  readonly clientX: number
  readonly clientY: number
  readonly deltaX: number
  readonly deltaY: number
  readonly timeStamp: number
}

export function wheelEventToInput(e: WheelEventLike, viewportRect: RectLike): WheelInputEvent {
  return {
    type: 'wheel',
    x: e.clientX - viewportRect.left,
    y: e.clientY - viewportRect.top,
    dx: e.deltaX,
    dy: e.deltaY,
    modifiers: modifiersOf(e),
    t: e.timeStamp,
  }
}

/** Structural shape of a KeyboardEvent. Unlike pointer events, `type` IS
 * narrowed to the exact keydown/keyup union here — Viewport.tsx's two key
 * listeners already know which they're calling from, and input.ts's
 * KeyInputEvent has no third variant to trust the caller about. */
export interface KeyEventLike extends ModifierFields {
  readonly type: 'keydown' | 'keyup'
  readonly key: string
  readonly timeStamp: number
}

export function keyEventToInput(e: KeyEventLike): KeyInputEvent {
  return { type: e.type, key: e.key, modifiers: modifiersOf(e), t: e.timeStamp }
}

// Re-exported only for callers that want to name the union without a second
// import of canvas-editor; this module produces InputEvent-shaped values but
// never imports the doc/intents side of canvas-editor's barrel.
export type { InputEvent }
