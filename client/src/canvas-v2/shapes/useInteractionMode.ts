/**
 * React wiring for the pure interactionMode.ts state machine — the DOM half
 * (double-click to focus, Escape or a pointerdown outside the body's own
 * root element to exit) every Seam-E body shares. Kept in its own module
 * (rather than folded into interactionMode.ts) so that file stays
 * framework-free and unit-testable under plain `bun`; this file is DOM-
 * dependent by construction and is exercised for real only by
 * IframeShape.test.ts's live reconciler case (see that file + this repo's
 * house test-strategy note: a DOM-dependent hook has no plain-bun unit test
 * of its own — its only testable HALF is the reducer above).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { reduceInteractionMode, shouldSwallowEvents, type InteractionMode } from './interactionMode.js'

export interface InteractionModeControls {
  readonly mode: InteractionMode
  readonly swallow: boolean
  /** Attach to the body's own outermost element (`ref={rootRef}`) so the
   * click-outside listener knows what "outside" means. */
  readonly rootRef: RefObject<HTMLDivElement | null>
  /** Wire to `onDoubleClick` on the body's focus surface. */
  readonly onDoubleClick: () => void
}

export function useInteractionMode(): InteractionModeControls {
  const [mode, setMode] = useState<InteractionMode>('idle')
  const rootRef = useRef<HTMLDivElement>(null)

  const onDoubleClick = useCallback(() => {
    setMode((m) => reduceInteractionMode(m, 'focus-request'))
  }, [])

  useEffect(() => {
    if (mode !== 'focused') return
    const exit = () => setMode((m) => reduceInteractionMode(m, 'exit-request'))
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit()
    }
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) exit()
    }
    // capture: outside handlers must see the click before some other layer
    // (e.g. a canvas select-tool) stops its propagation.
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [mode])

  return { mode, swallow: shouldSwallowEvents(mode), rootRef, onDoubleClick }
}
