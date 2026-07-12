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

export interface EmbedLifecycleRegistry {
  /** Register `hooks` as shape `shapeId`'s lifecycle. Returns the
   * unregister function — the registering body calls it in its own mount
   * effect's CLEANUP (i.e. `useEffect(() => registry.register(id, hooks),
   * [id])` — the register call's return value IS the cleanup). A second
   * register for the same id REPLACES the first (no error — mirrors
   * registerShape's own replace semantics); the replaced registration's
   * unregister fn goes stale and becomes a silent no-op, so an
   * out-of-order cleanup can never tear down its successor. */
  register(shapeId: string, hooks: EmbedLifecycle): () => void
  /** A per-shape EmbedLifecycle FACADE suitable for EmbedHost's/EmbedLayer's
   * `lifecycle`/`lifecycleFor` props. ALWAYS returns a facade in practice
   * (the `| undefined` in the type only mirrors EmbedLayer's optional-prop
   * contract): each of the facade's four callbacks does a FRESH registry
   * lookup AT CALL TIME — the load-bearing half of the whole design; see
   * the LIFECYCLE REGISTRY block for why a snapshot-at-lookup-time design
   * could never work. */
  lifecycleFor(shapeId: string): EmbedLifecycle | undefined
}

/** LIFECYCLE REGISTRY — how an embed BODY actually wires its hooks to the
 * EmbedHost ABOVE it. Plain props cannot do this: props flow top-down, and
 * the body is EmbedHost's CHILD — there is no upward slot in ShapeBodyProps
 * for the body to hand a hooks object to its own host. The registry is the
 * out-of-band channel: the body registers its hooks under its OWN shape id
 * from its OWN mount effect, and the layer passes
 * `lifecycleFor={registry.lifecycleFor}` so each EmbedHost pulls the right
 * hooks by id (see EmbedHost.tsx's LIFECYCLE WIRING header for the
 * concrete terminal-body sketch). Two ordering facts make this safe — both
 * pinned by embed-reconciler.test.ts's end-to-end case:
 *
 *   1. CHILD EFFECTS COMMIT BEFORE PARENT EFFECTS. The body (EmbedHost's
 *      child) registers in its mount effect; EmbedHost creates its
 *      controller (and fires onMount) in its OWN mount effect — which
 *      React runs strictly AFTER every child's. By the time onMount goes
 *      looking for hooks, the body has already registered them.
 *   2. CALL-TIME LOOKUP. `lifecycleFor` is called during the layer's
 *      RENDER — before ANY effect has run, i.e. before the body has
 *      registered anything. The facade it returns therefore does a fresh
 *      `.get(shapeId)` inside each callback, at call time, instead of
 *      capturing the (empty) registration at lookup time — so the
 *      registration that lands later (the only kind there is, per fact
 *      1's ordering) is seen the first time a callback actually fires.
 *
 * ORDERING, UNMOUNT DIRECTION (empirically pinned — the first draft of the
 * end-to-end test predicted the opposite and the real reconciler proved it
 * wrong): unmount CLEANUPS run PARENT-FIRST (React traverses a deleted
 * subtree top-down — the mirror image of mount effects' child-first
 * order), so EmbedHost's dispose fires the facade's onUnmount while the
 * body is STILL registered — onUnmount IS delivered through the registry,
 * on StrictMode's simulated cleanup and on a real unmount alike. The
 * body's own unregister cleanup runs after. Net: the registry delivers
 * the complete lifecycle, correctly paired in both directions (the
 * end-to-end test asserts mounts === unmounts after a real unmount).
 * Bodies should still treat onMount as idempotent "host is live" and
 * onUnmount as redundant with their own effect cleanup (both fire on a
 * StrictMode simulated remount, in dev, without the body's DOM actually
 * going anywhere) — the registry's irreplaceable payload is
 * onSuspend/onResume, the signals a body cannot infer from its own React
 * lifecycle. */
export function createLifecycleRegistry(): EmbedLifecycleRegistry {
  const hooksById = new Map<string, EmbedLifecycle>()
  return {
    register: (shapeId, hooks) => {
      hooksById.set(shapeId, hooks)
      return () => {
        // Identity-guarded: only remove OUR registration. If a later
        // register() replaced it, this unregister is stale and must not
        // tear down the replacement (see the interface doc).
        if (hooksById.get(shapeId) === hooks) hooksById.delete(shapeId)
      }
    },
    lifecycleFor: (shapeId) => ({
      // Fresh .get per CALL — fact 2 above; load-bearing, not style.
      onMount: () => hooksById.get(shapeId)?.onMount?.(),
      onSuspend: () => hooksById.get(shapeId)?.onSuspend?.(),
      onResume: () => hooksById.get(shapeId)?.onResume?.(),
      onUnmount: () => hooksById.get(shapeId)?.onUnmount?.(),
    }),
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
