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
    onInput(pointerEventToInput(e, e.currentTarget.getBoundingClientRect()))
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
