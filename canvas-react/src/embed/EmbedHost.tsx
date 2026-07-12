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
// ONE CONTROLLER PER COMMIT LIFETIME, RE-ARMABLE (StrictMode-safe — FIXED
// after a reviewer probe with a real react-dom/client + StrictMode
// reconciler proved the original design dead-on-arrival in dev): the
// controller is created in a MOUNT EFFECT (commit-scoped), and that
// effect's cleanup both disposes the controller AND resets
// `controllerRef.current = null` so the effect's re-run creates a FRESH
// controller. Why this exact shape is load-bearing: React StrictMode
// (dev-only — and client/src/main.tsx wraps the whole app in it) simulates
// a remount on every initial mount — mount → run effects → run cleanups →
// re-run effects, with NO re-render in between. The original design (lazy
// ref-init in the render body + a dispose-only cleanup) permanently killed
// the controller under that simulation: the cleanup disposed the one
// controller (disposed=true, no re-arm), the ref still pointed at the dead
// object, and since no render intervened before the effects re-ran,
// nothing ever recreated it — every subsequent tick() was a documented
// no-op and the embed stayed frozen 'active' forever, silently defeating
// the entire suspend/resume contract in dev (probe-verified: lifecycle
// calls were ["mount","unmount"] and never moved again; pinned red-first
// by embed-reconciler.test.ts). Prior art for this hazard class elsewhere
// in this repo: client/src/av/AvOverlay.tsx (StrictMode's mount-only
// cleanup vs a local-ref dedupe — reads the bridge, not a ref, for the
// same reason) and client/src/kernel/roomHooks.ts (cleanup returned
// explicitly "for StrictMode double-mount and real unmounts").
//
// THE SIMULATED REMOUNT'S onUnmount+onMount PAIR IS CORRECT, NOT A BUG TO
// SUPPRESS: under StrictMode dev, the embed body's callbacks see mount →
// unmount → mount on initial mount. That pair is semantically exactly what
// a REAL remount produces, and producing it is StrictMode's whole job —
// embed bodies' onMount/onUnmount are setup/teardown by contract, so a
// body that tolerates a real remount (it must) tolerates this for free.
// Deduping the pair away (e.g. an "already mounted once" latch) would hide
// real remount bugs — precisely what StrictMode exists to surface.
// Corollary: onMount now fires at COMMIT time (inside the mount effect),
// never during render — ALSO more correct than the original: the "lazy ref
// init in render" blessing covers object CREATION, not observable side
// effects, and an embed body's onMount is an arbitrary side effect.
//
// STATE LAG (one render, by construction): the wrapper's rendered
// `data-embed-state`/style reflect the controller's state AS OF THE
// PREVIOUS render — `controller.tick()` runs in an effect AFTER the render
// that delivered the new `tick`/`visible` props, and nothing here forces a
// re-render on a state transition; the NEXT render (the next tick-prop
// bump, ~1s later under G3's documented cadence) picks the new state up.
// The lifecycle CALLBACKS (the part that actually pauses/resumes streams)
// fire immediately, in the effect — only the visual hide/show lags one
// tick. Accepted for v1: a freshly-suspended embed is off-screen by
// definition, so a one-tick-late visibility:hidden is unobservable; the
// resume direction shows one tick of hidden-while-visible, bounded by the
// tick cadence. Pinned by embed-reconciler.test.ts's "state catches up on
// the next render" assertions.
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
  const controllerRef = useRef<EmbedController | null>(null)
  // Latest-value refs for the mount effect below (bound once per commit
  // lifetime, empty deps) — same latest-ref pattern as Viewport.tsx's
  // onInputRef: the effect must not close over one particular render's
  // lifecycle/threshold, and re-subscribing on every prop change would
  // wrongly dispose+recreate the controller (a spurious unmount/mount pair
  // for a mere prop identity change).
  const lifecycleRef = useRef(lifecycle)
  lifecycleRef.current = lifecycle
  const suspendAfterTicksRef = useRef(suspendAfterTicks)
  suspendAfterTicksRef.current = suspendAfterTicks

  // Controller lifetime = COMMIT lifetime. Declared BEFORE the tick effect
  // so on any (re)mount this effect runs first and the tick effect below
  // finds a live controller. The cleanup DISPOSES AND RE-ARMS (nulls the
  // ref) — the load-bearing half of the StrictMode fix; see the module
  // header's "ONE CONTROLLER PER COMMIT LIFETIME, RE-ARMABLE" block for the
  // frozen-forever failure the dispose-only version caused, and
  // embed-reconciler.test.ts for the red-first pin. Real unmount (a doc
  // deletion — EmbedLayer's `.map()` simply stops rendering this EmbedHost
  // once the shape leaves the snapshot) runs the same cleanup; the re-arm
  // is then simply never followed by a re-run.
  useEffect(() => {
    controllerRef.current = createEmbedController(lifecycleRef.current ?? {}, { suspendAfterTicks: suspendAfterTicksRef.current })
    return () => {
      controllerRef.current?.dispose()
      controllerRef.current = null // RE-ARM: a following effect re-run (StrictMode's simulated remount) creates a FRESH controller — see module header
    }
  }, [])

  // Advance the tick machine in an effect (deferred to commit, standard
  // React timing) whenever the tick counter or the visibility flag changes.
  // `?.`: under renderToStaticMarkup effects never run at all, and even in
  // a live reconciler this guard is belt-and-braces ordering tolerance —
  // with both effects in this component, mount order is declaration order,
  // so the controller exists by the time this runs.
  useEffect(() => {
    controllerRef.current?.tick(visible)
  }, [tick, visible])

  // 'active' fallback: before the mount effect has run (the very first
  // render, and any renderToStaticMarkup render — no effects there at all)
  // there is no controller yet; a brand-new embed is by definition active.
  const state = controllerRef.current?.getState() ?? 'active'
  return <EmbedBodyFrame shape={shape} snapshot={snapshot} editorState={editorState} state={state} />
}
