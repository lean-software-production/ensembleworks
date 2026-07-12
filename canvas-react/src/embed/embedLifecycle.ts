// D8 — the embed lifecycle contract + its pure state machine. This is the
// fix for ShapeLayer.tsx's CULLING UNMOUNTS BODIES problem: a heavy custom
// shape body (terminal/iframe/screenshare, ported in Seam E) must stay
// MOUNTED for the shape's whole lifetime in the doc — panning it off-screen
// suspends it (visually + via the `onSuspend` hook, so the body can pause
// its own stream), it never remounts from scratch just because the camera
// moved. Only a real doc deletion unmounts it.
//
// EVERYTHING IN THIS FILE IS FRAMEWORK-FREE (no React, no DOM) BY DESIGN:
// `EmbedHost.tsx` is a thin React wrapper around `createEmbedController`
// below (see that file's module header for exactly how it wires in), but
// the actual mount/suspend/resume/unmount STATE MACHINE — the part with
// real decisions to get right (does a one-tick blip suspend? does resuming
// remount? is each embed's state independent of every other embed's?) —
// lives here as a plain object with a `tick()` method, so embed.test.ts can
// drive and assert it directly with node:assert, no rendering required.
// This also satisfies the package's own determinism posture even though
// canvas-react is DOM-touching by charter: nothing here reads Date.now or
// Math.random (boundary.test.ts would fail if it did) — see TICKS below.
//
// TICKS, NOT WALL-CLOCK TIME: the suspend delay is counted in caller-driven
// TICKS, not milliseconds. `tick(visible)` is meant to be called once per
// "frame" of whatever cadence the caller chooses — the real client mount
// (Seam G3) calls it once per second via a plain `setInterval`; this file
// never starts that interval itself (no I/O, no timers, no Date.now) — it only
// counts how many CONSECUTIVE invisible ticks have elapsed since the embed
// was last visible. Tests call `tick()` manually, as many times as a
// scenario needs, with no wall-clock dependency at all.
import { stableStringify, type Shape } from '@ensembleworks/canvas-model'

export type EmbedState = 'active' | 'suspended'

/** The lifecycle hooks an embed body declares (via the `lifecycle` prop
 * EmbedHost accepts — see EmbedHost.tsx's module header for why "props" is
 * the mechanism this unit picked over the plan's other sanctioned option,
 * a ref-based registration). All four are optional: a body that has
 * nothing to pause/resume (e.g. it holds no live connection) may register
 * none of them, or only the ones it cares about. `onMount`/`onUnmount` fire
 * exactly once each, at controller construction and at `dispose()`
 * respectively; `onSuspend`/`onResume` fire once per actual active<->
 * suspended TRANSITION (never twice in a row for the same state — see
 * createEmbedController's transition guards). */
export interface EmbedLifecycle {
  readonly onMount?: () => void
  readonly onSuspend?: () => void
  readonly onResume?: () => void
  readonly onUnmount?: () => void
}

export interface EmbedControllerOptions {
  /** An embed goes 'suspended' once it has been invisible for MORE THAN
   * this many consecutive ticks (i.e. `suspendAfterTicks + 1` consecutive
   * invisible ticks) — "longer than N ticks", per the phase-3 plan's D8
   * task text. A single invisible tick followed by a visible one (a
   * transient scroll blip) therefore NEVER suspends when
   * `suspendAfterTicks >= 1`. Must be a non-negative integer; not
   * validated here (a caller passing a negative/fractional value gets
   * whatever `invisibleTicks > suspendAfterTicks` evaluates to — the
   * degenerate cases are harmless, not worth a guard). */
  readonly suspendAfterTicks: number
}

export interface EmbedController {
  /** Current lifecycle state. Starts 'active' at construction. */
  readonly getState: () => EmbedState
  /** Advance the state machine by one tick, given whether the embed is
   * CURRENTLY visible. Idempotent in the sense that calling it again with
   * the SAME `visible` value the controller already reflects does not
   * re-fire onSuspend/onResume (see the transition guards in the
   * implementation) — safe to call more often than "once per real tick"
   * if a caller's own cadence is imprecise; only genuine active<->
   * suspended TRANSITIONS fire a callback. A no-op after `dispose()`. */
  readonly tick: (visible: boolean) => void
  /** Tear down: fires `onUnmount` exactly once (idempotent — a second call
   * is a silent no-op, matching CanvasDoc's own tolerant-mutator
   * conventions elsewhere in this codebase) and makes all subsequent
   * `tick()` calls no-ops. Called when the embed's shape is deleted from
   * the doc (EmbedLayer stops rendering its EmbedHost, which is an
   * ordinary React unmount — see EmbedHost.tsx). */
  readonly dispose: () => void
}

/** Build a fresh per-embed state machine. `lifecycle.onMount` fires
 * SYNCHRONOUSLY, once, before this function returns — the embed is
 * considered "mounted" from the moment its controller exists (EmbedHost.tsx
 * constructs exactly one controller per EmbedHost mount, lazily, via a
 * React ref — see that file for why that pattern is StrictMode-safe). */
export function createEmbedController(lifecycle: EmbedLifecycle, opts: EmbedControllerOptions): EmbedController {
  let state: EmbedState = 'active'
  let invisibleTicks = 0
  let disposed = false
  lifecycle.onMount?.()
  return {
    getState: () => state,
    tick: (visible: boolean) => {
      if (disposed) return
      if (visible) {
        invisibleTicks = 0
        if (state === 'suspended') {
          state = 'active'
          lifecycle.onResume?.() // TRANSITION guard: only fires when actually leaving 'suspended'
        }
        return
      }
      // Invisible this tick. Only 'active' embeds accumulate toward the
      // suspend threshold — an already-'suspended' embed just stays put
      // (no repeated onSuspend calls while it remains invisible).
      if (state === 'active') {
        invisibleTicks += 1
        if (invisibleTicks > opts.suspendAfterTicks) {
          state = 'suspended'
          lifecycle.onSuspend?.() // TRANSITION guard: only fires once, on crossing the threshold
        }
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      lifecycle.onUnmount?.()
    },
  }
}

/** The embed CONTENT-MEMO comparator (see ShapeBody.tsx's MEMO STRATEGY
 * block for the underlying problem this solves): `dumpModel()` mints a
 * brand-new Shape object on every doc commit even for shapes whose data
 * didn't change, and the whole-document `snapshot` prop changes identity
 * every commit regardless — so reference-based React.memo NEVER bails for
 * an embed body. Comparing by id + `stableStringify` (canvas-model's own
 * canonical serialization, already trusted by `makeDocument`'s duplicate-id
 * dedupe) is the CONTENT truth: two Shape objects with the same id and the
 * same stableStringify output are, for rendering purposes, the identical
 * shape, no matter that they're different object references. `EmbedHost`
 * applies this comparator itself (wrapping the registered embed component
 * in `React.memo(Component, embedBodyPropsEqual)` — see EmbedHost.tsx) so
 * individual ported embed bodies (terminal/iframe/screenshare, Seam E)
 * never have to reimplement it. */
export function sameEmbedContent(a: Shape, b: Shape): boolean {
  return a.id === b.id && stableStringify(a) === stableStringify(b)
}
