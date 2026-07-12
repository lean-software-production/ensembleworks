// D8 — the culling-safe embed lifecycle host. ShapeLayer/ShapeBody UNMOUNT a
// body the instant its shape culls out of the viewport (ShapeLayer.tsx's
// CULLING UNMOUNTS BODIES header) — fine for stateless bodies, destructive
// for a live terminal/iframe/screenshare session. EmbedHost is the fix:
// `EmbedLayer` (the sibling file) renders EVERY embed-kind shape in the doc
// UNCONDITIONALLY (no viewport cull), and EmbedHost drives VISUAL
// suspend/resume in its place, using embedLifecycle.ts's pure state
// machine. Positioned/sized exactly like ShapeBody (same `shapeBodyTransform`
// + `localBounds` math, reused not re-derived) — EmbedHost is the embed
// analogue of ShapeBody, with the lifecycle/visibility layer added on top.
//
// LIFECYCLE CALLBACKS "VIA PROPS" (the plan's two sanctioned mechanisms were
// "props/registration" — this unit picks props, the simpler of the two):
// EmbedHost accepts an optional `lifecycle: EmbedLifecycle` prop directly.
// A real ported embed body (Seam E: terminal/iframe/screenshare) is
// expected to construct its OWN `EmbedLifecycle` object (binding
// `onSuspend`/`onResume` to its actual session's pause()/resume(), `onMount`
// /`onUnmount` to setup/teardown) and have whatever renders its EmbedHost
// pass that object straight through. EmbedHost itself never constructs or
// inspects the callbacks' internals — it only calls them, via
// embedLifecycle.ts's controller, at the right transitions. A ref-based
// registration (the plan's other sanctioned mechanism) was considered and
// rejected for v1: it would need the embed body to call something in a
// `useEffect`/`useImperativeHandle`, and this house test rig has NO DOM
// emulator (renderToStaticMarkup never runs effects or commits refs — see
// viewport.test.ts's header) — a contract that can ONLY be exercised via a
// real browser buys this unit nothing testable today. Props are exactly as
// expressive and are exercisable by embed.test.ts import-and-call directly.
//
// VISIBLE-BUT-HIDDEN, NOT UNMOUNTED (decision, documented): a suspended
// embed's wrapper gets `visibility: hidden; pointerEvents: none`, NOT
// `display: none`. `display: none` fully removes the element from
// layout/paint and, for an iframe specifically, can unload real state (some
// browsers drop a nested document's decoder/media pipeline state on
// display:none, not just visually — the exact GPU/iframe-state risk this
// whole contract exists to avoid); `visibility: hidden` keeps the DOM (and
// everything inside it — the iframe's nested document, xterm's buffer, a
// video element's decoder) alive and simply removes it from the paint/
// hit-test tree, which is exactly "pause the STREAM, don't destroy the
// SESSION" — the embed body's own `onSuspend` hook handles the
// application-level pause (e.g. actually pausing a websocket/video), and
// this wrapper independently makes sure the BROWSER doesn't ALSO tear
// anything down as a side effect of hiding it. `pointerEvents: none`
// additionally keeps a suspended (but still-DOM-present) embed from
// swallowing clicks meant for whatever IS visible in its place.
//
// CONTENT-MEMO (see embedLifecycle.ts's `sameEmbedContent` + ShapeBody.tsx's
// MEMO STRATEGY block for the underlying problem): EmbedHost wraps the
// registered embed component in `React.memo(Component, embedBodyPropsEqual)`
// itself, memoized via `useMemo` keyed on the Component reference (NOT
// recreated every render — recreating the memo wrapper every render would
// make React treat it as a brand-new component type each time and defeat
// the whole point) — so individual ported embed bodies never have to
// reimplement this.
//
// ONE CONTROLLER PER MOUNT, LAZILY, VIA A REF (StrictMode-safe — this is
// the React-docs-blessed "create an expensive object once, in render"
// pattern, not a side effect smuggled into render): `controllerRef.current`
// starts `null` and is set exactly once, the first time this component
// renders; React's ref persists across StrictMode's dev-only double-
// invocation of a component's render body, so the `=== null` guard
// prevents a second controller (and hence a second `onMount`) even though
// the render function itself runs twice. `useEffect`s (not the render body)
// own advancing the tick machine and disposing on unmount — both are
// ordinary, safe side-effect timing; the ONE deliberate render-time side
// effect is the lazy controller construction, which is safe for the reason
// just given.
//
// TEST-HARNESS LIMITATION (same posture as Viewport.tsx's ACKNOWLEDGED
// LIMITATION): this house rig has no DOM emulator (no jsdom/
// react-test-renderer) — only `renderToStaticMarkup`, a ONE-SHOT string
// render with no persisted fiber tree and no effect/ref phase at all, so it
// cannot observe EmbedHost's actual tick-driven transitions, its dispose-
// on-unmount effect, OR React.memo's real reconciler bailout (there is no
// "second render of the same mounted tree" to observe). That is exactly why
// the markup-producing half of this file is factored into `EmbedBodyFrame`
// — a PURE function of an explicit `state: EmbedState` prop, with no
// controller/ticking involved — so embed.test.ts CAN render the 'suspended'
// case directly (proving "suspended never removes the DOM, just hides it")
// without needing a live reconciler to tick its way there. embed.test.ts
// (a) unit-tests `createEmbedController` and `sameEmbedContent` directly —
// ZERO React, exhaustively covering every transition scenario the D8 task
// asks for — and (b) renders `EmbedBodyFrame`/`EmbedHost` via
// renderToStaticMarkup to pin the wrapper's style and the embed body's
// markup in both states. Proving the ACTUAL effect timing and memo bailout
// in a live reconciler is a G2/e2e concern, exactly like Viewport.tsx's
// deferred pointer-capture coverage.
import { memo, useEffect, useMemo, useRef, type ComponentType } from 'react'
import { localBounds, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { lookupShapeComponent, type ShapeBodyProps } from '../shapeRegistry.js'
import { shapeBodyTransform } from '../ShapeBody.js'
import { createEmbedController, sameEmbedContent, type EmbedController, type EmbedLifecycle, type EmbedState } from './embedLifecycle.js'

export interface EmbedHostProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
  /** Whether this shape's worldBounds currently intersects the viewport —
   * computed by EmbedLayer (see that file), NOT re-derived here. */
  readonly visible: boolean
  /** A monotonically increasing counter the caller (EmbedLayer, ultimately
   * driven by G3's ~1s `setInterval`) bumps once per "tick" — see
   * embedLifecycle.ts's TICKS note. Only the VALUE CHANGING matters (it is
   * an effect dependency, not read for its own sake). */
  readonly tick: number
  readonly suspendAfterTicks: number
  /** The embed body's own lifecycle hooks — see the module header's
   * "LIFECYCLE CALLBACKS VIA PROPS" note. Optional: a body with nothing to
   * pause/resume passes nothing. */
  readonly lifecycle?: EmbedLifecycle
}

/** Content-memo comparator for the `React.memo`-wrapped embed body — see
 * embedLifecycle.ts's `sameEmbedContent` for the underlying rule.
 * Deliberately ignores `snapshot`/`editorState` diffs entirely, same as
 * ShapeBody.tsx's documented MEMO STRATEGY: an embed body SHOULD NOT read
 * `snapshot` (it is optional-by-convention), so no per-shape comparator can
 * prove the rest of the document irrelevant to it anyway — the CONTENT-MEMO
 * win only holds if the comparator ignores everything but this shape's own
 * serialized content. */
function embedBodyPropsEqual(a: ShapeBodyProps, b: ShapeBodyProps): boolean {
  return sameEmbedContent(a.shape, b.shape)
}

/** Pure — exported so embed.test.ts can pin the exact style object per
 * state without rendering anything, mirroring shapeBodyTransform's
 * pattern. See the module header's VISIBLE-BUT-HIDDEN note for why
 * 'suspended' is visibility:hidden, never display:none. */
export function embedWrapperStyle(state: EmbedState): { visibility: 'visible' | 'hidden'; pointerEvents: 'auto' | 'none' } {
  return state === 'suspended'
    ? { visibility: 'hidden', pointerEvents: 'none' }
    : { visibility: 'visible', pointerEvents: 'auto' }
}

export interface EmbedBodyFrameProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
  readonly state: EmbedState
}

/** The PURE (no controller, no ticking, no effects) render of "this shape,
 * in this EmbedState" — positioned/sized exactly like ShapeBody, wrapped in
 * the content-memoized embed component, styled per `embedWrapperStyle`.
 * Factored OUT of `EmbedHost` specifically so embed.test.ts can render the
 * 'suspended' case DIRECTLY (an explicit `state` prop) without needing a
 * live controller to actually tick its way there — this house rig's
 * renderToStaticMarkup never runs effects (see module header's TEST-HARNESS
 * LIMITATION), so a real EmbedHost mount can only ever be observed in its
 * construction-time state ('active') in a single static render; this
 * function is what makes "suspended never removes the DOM" independently
 * provable without a live reconciler. `EmbedHost` below is a thin stateful
 * wrapper that computes `state` via embedLifecycle.ts's controller and
 * delegates the actual markup to this function — there is exactly one
 * place that decides what a given state LOOKS like. */
export function EmbedBodyFrame({ shape, snapshot, editorState, state }: EmbedBodyFrameProps) {
  const { maxX: w, maxY: h } = localBounds(shape) // localBounds is always {minX:0, minY:0, maxX:w, maxY:h} — geometry.ts's contract, same as ShapeBody.tsx
  const Component: ComponentType<ShapeBodyProps> = lookupShapeComponent(shape.kind)
  // Stable across renders as long as `Component` itself doesn't change
  // identity (it won't, in practice — registry entries are set once) — see
  // module header's CONTENT-MEMO note for why this MUST be memoized rather
  // than rebuilt every render (recreating the memo wrapper every render
  // would make React treat it as a brand-new component type each time).
  const MemoizedComponent = useMemo(() => memo(Component, embedBodyPropsEqual), [Component])

  return (
    <div
      data-shape-id={shape.id}
      data-shape-kind={shape.kind}
      data-embed-state={state}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: '0 0',
        transform: shapeBodyTransform(snapshot, shape),
        ...embedWrapperStyle(state),
      }}
    >
      <MemoizedComponent shape={shape} snapshot={snapshot} editorState={editorState} />
    </div>
  )
}

export function EmbedHost({ shape, snapshot, editorState, visible, tick, suspendAfterTicks, lifecycle }: EmbedHostProps) {
  // ONE controller for this EmbedHost's whole mount lifetime — see module
  // header's "ONE CONTROLLER PER MOUNT" note for why this lazy-ref-init
  // pattern is StrictMode-safe.
  const controllerRef = useRef<EmbedController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createEmbedController(lifecycle ?? {}, { suspendAfterTicks })
  }
  const controller = controllerRef.current

  // Advance the tick machine in an effect (deferred to commit, standard
  // React timing) whenever the tick counter or the visibility flag changes.
  useEffect(() => {
    controller.tick(visible)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `controller` is ref-stable for this mount's lifetime; re-running this effect for it would be a no-op anyway, but omitting it keeps the dep list to exactly "what actually changes"
  }, [tick, visible])

  // Dispose exactly once, on real unmount (a doc deletion — see EmbedLayer,
  // whose `.map()` simply stops rendering this EmbedHost once the shape
  // leaves the snapshot, an ordinary React unmount).
  useEffect(() => {
    return () => controller.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only, deliberately empty deps
  }, [])

  return <EmbedBodyFrame shape={shape} snapshot={snapshot} editorState={editorState} state={controller.getState()} />
}
