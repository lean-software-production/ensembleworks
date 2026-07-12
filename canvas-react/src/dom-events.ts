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
import type { InputEvent, KeyInputEvent, Modifiers, PointerInputEvent, WheelInputEvent } from '@ensembleworks/canvas-editor'

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
}

export function pointerEventToInput(e: PointerEventLike, viewportRect: RectLike): PointerInputEvent {
  return {
    type: e.type as PointerInputEvent['type'],
    x: e.clientX - viewportRect.left,
    y: e.clientY - viewportRect.top,
    buttons: e.buttons,
    modifiers: modifiersOf(e),
    t: e.timeStamp,
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
