// The ONE relative-positioned, overflow-clipping div that owns every raw
// browser input listener in the renderer: pointer (down/move/up), wheel,
// and keyboard (down/up), plus a blur hook for the abandonment-gap wiring
// (see ABANDONMENT-GAP HOOK below). Viewport does NOT run any tool itself —
// G3 owns the actual dispatch loop (script.ts's `run()` semantics, or an
// equivalent live loop G3 builds around it); this component's entire job is
// DOM event -> InputEvent normalization (via dom-events.ts's pure mappers)
// followed by handing the result to the `onInput` prop, unchanged, once per
// event. That is the logic-free boundary in concrete terms: nothing here
// decides what an event MEANS.
//
// NON-PASSIVE WHEEL LISTENER (why this can't just be a JSX `onWheel` prop):
// React attaches wheel/touch listeners at the root as PASSIVE by default
// (a performance default so the browser doesn't have to wait for the
// handler before starting to scroll) — calling `preventDefault()` inside a
// passive listener is a silent no-op (plus a console warning), so a JSX
// `onWheel={...}` handler CANNOT block the browser's native ctrl/pinch-
// zoom-the-whole-page gesture. Wiring the listener manually via
// `addEventListener('wheel', handler, { passive: false })` in an effect is
// the only way to get a listener whose preventDefault() actually sticks,
// which is required here: ctrl/meta+wheel is OUR zoom gesture (see
// camera.ts's applyWheel), and letting the browser ALSO zoom the page at
// the same time is a broken double-zoom.
//
// POINTER CAPTURE (why drags don't die at the viewport edge): on
// pointerdown the viewport element captures the pointer
// (`setPointerCapture(e.pointerId)`), so every subsequent pointermove AND
// the terminating pointerup are delivered to THIS element even after the
// pointer physically leaves its bounds — without capture, a drag that
// exits the viewport (drag a shape toward the toolbar, overshoot the
// window edge) loses its pointerup entirely: the tool FSM is stranded
// mid-gesture with no terminating event. The blur hook does NOT cover this
// case — keyboard focus stays on the viewport while the pointer wanders,
// so no blur ever fires. Capture is released on pointerup. Both calls are
// feature-guarded AND try/catch-wrapped: fabricated/synthetic events carry
// pointerIds no real pointer owns (setPointerCapture throws NotFoundError
// for an unknown pointerId; releasePointerCapture throws when that pointer
// isn't captured), and non-browser render environments may lack the API
// entirely — capture is an enhancement to event DELIVERY, never a gate on
// event FORWARDING, so a failed capture must not swallow the input.
//
// STACKING CONTRACT (the composition D4's overlay builds against): a
// caller composes the canvas as, in DOM order inside this Viewport —
//   1. <Grid>       — SCREEN-space, bottom layer (its own screen-space div
//                     computes dot pitch/offset from the camera; it does
//                     NOT live inside WorldLayer's transformed container).
//   2. <WorldLayer> — THE transformed world container, holding ShapeLayer
//                     (every shape body).
//   3. D4's selection overlay — a SCREEN-SPACE full-viewport SVG, a
//                     SIBLING of WorldLayer placed AFTER it in DOM order,
//                     drawing outlines/handles in screen coordinates via
//                     worldToScreen (per the plan's "one full-viewport SVG
//                     overlay" design). It does NOT live inside the
//                     transformed container — screen-space drawing is what
//                     keeps handle strokes and hit areas zoom-invariant
//                     (1px is 1px at any zoom).
// DOM ORDER IS THE MECHANISM: later siblings paint over earlier ones; no
// z-index anywhere in this package. The Grid-before-WorldLayer half is
// pinned by viewport.test.ts's composition smoke case; the overlay half is
// D4's to pin when it lands.
//
// ABANDONMENT-GAP HOOK: arrow.ts's ABANDONMENT GAP note (tools/arrow.ts
// header) documents that an in-flight drag/arrow-draw gesture has no cancel
// path inside canvas-editor's tool FSMs themselves — Seam D/G3 owns wiring
// a cancel trigger (Escape, blur, unmount) to a DeleteShapes intent for
// whatever preview shape is mid-gesture. `onViewportBlur` is that trigger,
// surfaced here as a plain callback prop: this component does not know what
// "cancel" means (it has no Intent vocabulary — see boundary.test.ts's
// public-entry-only rule), it only tells its caller "focus left the
// viewport, decide what that means." A `document.visibilitychange` variant
// (tab-hidden while still focused) is a documented, deferred extension of
// the same hook — not wired yet; blur already covers the common
// tool-switch/click-away case.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { InputEvent } from '@ensembleworks/canvas-editor'
import { keyEventToInput, pointerEventToInput, wheelEventToInput } from './dom-events.js'

export interface ViewportProps {
  /** Called once per normalized input event, in the order the browser
   * delivered the underlying DOM events. The renderer never batches,
   * reorders, or drops events here. */
  readonly onInput: (event: InputEvent) => void
  /** The abandonment-gap hook — see module header. Optional: a caller with
   * no in-flight-gesture cancellation wired yet (e.g. this unit's own tests)
   * simply omits it. */
  readonly onViewportBlur?: () => void
  readonly children?: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
}

export function Viewport({ onInput, onViewportBlur, children, className, style }: ViewportProps): ReactNode {
  const elRef = useRef<HTMLDivElement | null>(null)
  // Latest onInput, read by the native listener below. The listener is
  // bound ONCE (see the effect's empty deps) — its own closure would
  // otherwise pin the `onInput` reference from whichever render happened to
  // be current the one time the effect ran, silently ignoring any LATER
  // onInput identity the parent passes down. Routing through a ref keeps
  // "bind the native listener once" and "always call the current onInput"
  // independent of each other.
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    function handleWheel(e: WheelEvent): void {
      if (e.ctrlKey || e.metaKey) e.preventDefault() // block the browser's native page-zoom (see module header)
      onInputRef.current(wheelEventToInput(e, el!.getBoundingClientRect()))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
    // Empty deps deliberately: the element itself never changes identity
    // across renders, so the listener only needs binding once; staying
    // current with `onInput` is the ref's job, not a re-subscribe's.
  }, [])

  function handlePointer(e: PointerEvent<HTMLDivElement>): void {
    const el = e.currentTarget
    // POINTER CAPTURE — see the module header. Guarded twice: optional-call
    // (`?.`) tolerates environments where the API is absent altogether, and
    // try/catch tolerates a pointerId the browser doesn't recognize
    // (fabricated/synthetic events) or a release of a never-captured
    // pointer. A capture failure never blocks forwarding the event below.
    try {
      if (e.type === 'pointerdown') el.setPointerCapture?.(e.pointerId)
      else if (e.type === 'pointerup') el.releasePointerCapture?.(e.pointerId)
    } catch { /* capture is best-effort — see header */ }
    onInput(pointerEventToInput(e, el.getBoundingClientRect()))
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>): void {
    onInput(keyEventToInput({ type: e.type as 'keydown' | 'keyup', key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, timeStamp: e.timeStamp }))
  }

  return (
    <div
      ref={elRef}
      className={className}
      // tabIndex makes the div a valid keyboard-focus target — without it,
      // onKeyDown/onKeyUp never fire (a non-focusable div never receives
      // key events) and onBlur never fires either (nothing to blur FROM).
      tabIndex={0}
      style={{ position: 'relative', overflow: 'hidden', outline: 'none', ...style }}
      onPointerDown={handlePointer}
      onPointerMove={handlePointer}
      onPointerUp={handlePointer}
      onKeyDown={handleKey}
      onKeyUp={handleKey}
      onBlur={onViewportBlur}
    >
      {children}
    </div>
  )
}
