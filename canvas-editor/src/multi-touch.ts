// THE TWO-FINGER GESTURE RECOGNIZER — pure, clock-free, DOM-free (mobile-touch
// task). The browser has no "pinch" event: it delivers two INDEPENDENT pointer
// streams and leaves "are these two fingers one gesture?" entirely to the
// application. This module is that decision, and it is deliberately NOT written
// inside canvas-react's Viewport, for the reason canvas-react's boundary test
// exists at all: a threshold or a state transition living in a component is a
// rule no house test can read. Viewport keeps its one job (DOM event ->
// InputEvent, unchanged), canvas-ui's `useCanvasSession` — the funnel that
// already consumes 'wheel' before dispatching to a tool — drives this reducer,
// and the FSM contract runner drives the SAME reducer, so a contract exercises
// the real recognizer rather than a re-implementation of it.
//
// THE PROBLEM IT SOLVES, concretely: with `touch-action: none` on the viewport
// (Viewport.tsx's own note — without it every touch drag dies at its first move
// as a `pointercancel`), a second finger landing mid-gesture is just another
// pointerdown. Handed to the select tool, two fingers spreading apart read as
// one pointer jumping around, which translates whatever is under it. So the
// recognizer does two things a plain forward cannot: it SUPPRESSES the pointer
// stream for the whole two-finger gesture, and it tells its caller to CANCEL
// the single-finger gesture already in flight (the first finger's drag was real
// up to that moment — the tool has to be reset, not merely starved of events).
//
// TOUCH ONLY, ON PURPOSE. Only `pointerType === 'touch'` pointers are tracked.
// A mouse cannot produce two simultaneous pointers at all, a pen plus a finger
// is palm contact rather than a pinch, and an event with no `pointerType`
// (a hand-built script step, a fabricated test event) is the single-pointer
// world every pre-existing test lives in — all three pass straight through
// untouched, which is what makes this module additive rather than a rewrite of
// how input reaches the tools.
//
// SUPPRESSION OUTLIVES THE PINCH, and this is the subtle half. When one finger
// of a pinch lifts, the OTHER is still down — and no `pointerdown` will ever
// arrive for it again. Forwarding its moves at that point would hand the tool a
// drag that began nowhere: it would translate a shape the user was only trying
// to let go of. So suppression persists until the LAST tracked finger lifts,
// not until the pinch pair breaks. The cost, stated as a choice: you cannot
// slide straight from a two-finger pinch into a one-finger drag; you lift both
// fingers and start again.
//
// NO CLOCK, NO THRESHOLD. A pinch arms on the second finger's DOWN, not on
// movement or elapsed time. Two fingers on a canvas has exactly one meaning,
// unlike a tab strip's press (see the plugin's pages/tab-drag.ts, where a long
// press has to be told apart from a scroll), so there is nothing here to
// disambiguate and no timer to inject.
import type { PinchInputEvent, PointerInputEvent } from './input.js'

export interface MultiTouchPoint {
  readonly x: number
  readonly y: number
}

/** The live pinch pair: WHICH two pointers, and the sample the next one is
 * measured against. `distance`/`midpoint` are re-derived from the pair's
 * current positions on every move — never accumulated — so a long gesture
 * cannot drift the way a running sum would. */
export interface PinchAnchor {
  readonly a: number
  readonly b: number
  readonly distance: number
  readonly midpoint: MultiTouchPoint
}

export interface MultiTouchState {
  /** Every currently-down TOUCH pointer, in the order it went down —
   * insertion order is load-bearing: the pinch pair is the first two, so a
   * third finger joining a live pinch is tracked but never steers it. */
  readonly pointers: ReadonlyMap<number, MultiTouchPoint>
  readonly pinch: PinchAnchor | null
  /** True from the moment a pinch begins until the last tracked finger lifts
   * — see the SUPPRESSION OUTLIVES THE PINCH note above. */
  readonly suppressing: boolean
}

export const IDLE_MULTI_TOUCH: MultiTouchState = { pointers: new Map(), pinch: null, suppressing: false }

export interface MultiTouchResult {
  readonly state: MultiTouchState
  /** Should the caller hand this pointer event to the active tool? False for
   * every event belonging to a two-finger gesture (and to its aftermath). */
  readonly forward: boolean
  /** True on the ONE event that starts a pinch. The caller abandons whatever
   * single-finger gesture was in flight (canvas-ui routes this to the same
   * `cancelAndReset` that blur/pointercancel use) — the first finger's drag
   * was genuinely in progress and has to be unwound, not just ignored. */
  readonly cancelGesture: boolean
  /** The camera sample this event produced, or null (a pinch emits one per
   * move of either pinch pointer; every other event emits none). */
  readonly pinch: PinchInputEvent | null
}

function passthrough(state: MultiTouchState): MultiTouchResult {
  return { state, forward: true, cancelGesture: false, pinch: null }
}

function isFinitePoint(p: MultiTouchPoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

function anchorOf(a: number, b: number, pa: MultiTouchPoint, pb: MultiTouchPoint): PinchAnchor {
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  return {
    a, b,
    distance: Math.sqrt(dx * dx + dy * dy),
    midpoint: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
  }
}

/** Does this event take part in multi-touch at all? See the TOUCH ONLY note. */
function tracks(event: PointerInputEvent): event is PointerInputEvent & { pointerId: number } {
  return event.pointerType === 'touch' && typeof event.pointerId === 'number'
}

/**
 * One transition. Returns the next state, whether the caller should still
 * forward this event to the active tool, whether an in-flight single-finger
 * gesture must be cancelled, and the pinch camera sample (if any) this event
 * produced.
 *
 * A non-touch / id-less event is returned VERBATIM as `forward: true` with the
 * state untouched — see the module header.
 */
export function reduceMultiTouch(state: MultiTouchState, event: PointerInputEvent): MultiTouchResult {
  if (!tracks(event)) return passthrough(state)
  const id = event.pointerId
  const point: MultiTouchPoint = { x: event.x, y: event.y }
  const pointers = new Map(state.pointers)

  if (event.type === 'pointerdown') {
    pointers.set(id, point)
    // A pinch forms (or RE-forms, after a finger lifted and came back) as soon
    // as two touch pointers are down and no pair is live.
    if (state.pinch === null && pointers.size >= 2) {
      const [a, b] = [...pointers.keys()]
      const pa = pointers.get(a!)!
      const pb = pointers.get(b!)!
      if (isFinitePoint(pa) && isFinitePoint(pb)) {
        return {
          state: { pointers, pinch: anchorOf(a!, b!, pa, pb), suppressing: true },
          // The pinch OWNS this pointerdown: the tool must not also see a
          // second press land on whatever is under the second finger.
          forward: false,
          // ...and must unwind the first finger's in-flight gesture. Only
          // when one was actually possible: if we were already suppressing,
          // no tool gesture exists to cancel.
          cancelGesture: !state.suppressing,
          pinch: null,
        }
      }
    }
    const suppressing = state.suppressing || state.pinch !== null
    return { state: { pointers, pinch: state.pinch, suppressing }, forward: !suppressing, cancelGesture: false, pinch: null }
  }

  if (event.type === 'pointermove') {
    // An untracked pointer (its down was never seen — a gesture that began
    // before this reducer did, or one whose down went elsewhere) is not part
    // of any pinch, but is still gated by an active suppression.
    if (!state.pointers.has(id)) return { state, forward: !state.suppressing, cancelGesture: false, pinch: null }
    pointers.set(id, point)
    const anchor = state.pinch
    if (anchor && (id === anchor.a || id === anchor.b)) {
      const pa = pointers.get(anchor.a)
      const pb = pointers.get(anchor.b)
      // POISON GUARD, mirroring applyWheel's: a non-finite coordinate makes
      // the SAMPLE a no-op (the anchor is left where it was, so the next good
      // move measures from the last good sample) rather than writing a NaN
      // factor into the camera, which nothing downstream could recover from.
      if (pa && pb && isFinitePoint(pa) && isFinitePoint(pb)) {
        const next = anchorOf(anchor.a, anchor.b, pa, pb)
        // A degenerate previous distance (two fingers reported at the exact
        // same point) has no ratio to give — pan only, zoom by 1.
        const factor = anchor.distance > 0 ? next.distance / anchor.distance : 1
        const pinch: PinchInputEvent = {
          type: 'pinch',
          x: anchor.midpoint.x,
          y: anchor.midpoint.y,
          factor,
          dx: next.midpoint.x - anchor.midpoint.x,
          dy: next.midpoint.y - anchor.midpoint.y,
          t: event.t,
        }
        return { state: { pointers, pinch: next, suppressing: true }, forward: false, cancelGesture: false, pinch }
      }
      return { state: { pointers, pinch: anchor, suppressing: true }, forward: false, cancelGesture: false, pinch: null }
    }
    const suppressing = state.suppressing || anchor !== null
    return { state: { pointers, pinch: anchor, suppressing }, forward: !suppressing, cancelGesture: false, pinch: null }
  }

  // pointerup
  pointers.delete(id)
  const anchor = state.pinch
  // Breaking the pair ends the PINCH; suppression continues while any finger
  // is still down (see the module header).
  const pinch = anchor && (id === anchor.a || id === anchor.b) ? null : anchor
  const suppressing = pointers.size > 0 && (state.suppressing || anchor !== null)
  // Forwarded whenever no two-finger gesture is (or was) in play — including
  // for a pointer whose `down` this reducer never saw: a swallowed pointerup
  // strands a tool mid-drag with no terminating event (Viewport.tsx's own
  // pointer-capture note on exactly that failure), while a stray one reaching
  // an idle tool is a no-op.
  const forward = !(state.suppressing || anchor !== null)
  return { state: { pointers, pinch, suppressing }, forward, cancelGesture: false, pinch: null }
}

/**
 * Drop every tracked pointer — the abandonment path (`pointercancel`, viewport
 * blur, unmount). The browser takes the pointers away without delivering the
 * pointerups this reducer would otherwise wait for, and a suppression that
 * outlives its fingers would silently eat the user's NEXT gesture entirely.
 * Same "reset, don't reconcile" posture as canvas-editor's `cancelActiveTool`.
 */
export function resetMultiTouch(): MultiTouchState {
  return IDLE_MULTI_TOUCH
}
