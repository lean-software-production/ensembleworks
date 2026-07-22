// Run: bun src/embed/embed-reconciler.test.ts
// The ONE house test that runs a REAL React reconciler (react-dom/client +
// happy-dom + <StrictMode>) — added after a reviewer probe proved a whole
// class of bug the rest of this rig is structurally blind to:
// renderToStaticMarkup never runs effects, so no static-markup test can
// observe effect/cleanup TIMING, and EmbedHost's original dispose-on-unmount
// effect was not StrictMode-safe (React dev's simulated remount — mount →
// effects → cleanups → effects again — disposed the one-and-only controller
// during the simulated cleanup, leaving every embed frozen 'active' with
// inert ticks for the app's whole dev lifetime; client/src/main.tsx wraps in
// StrictMode, so this silently defeated D8's entire purpose in dev).
//
// SCOPE: deliberately restricted to the embed lifecycle — this is NOT the
// start of a general component-test migration to happy-dom. Everything else
// in this package keeps the renderToStaticMarkup posture (see
// viewport.test.ts's header); this file exists because the embed lifecycle
// is the one contract whose CORRECTNESS lives in effect/cleanup timing.
//
// STRICTMODE EXPECTATION (what "safe" means here, asserted below): the
// simulated remount legitimately fires the embed body's onUnmount + a fresh
// onMount — that unmount/mount PAIR is semantically correct (it is exactly
// what a real remount does, and simulating it is StrictMode's whole job).
// What must NEVER happen is the frozen-dead state: the LAST lifecycle event
// after mounting must be 'mount' (a live controller), and subsequent
// invisible ticks past the threshold must still produce 'suspend'.
//
// DOM GLOBALS BEFORE REACT-DOM (why the dynamic imports): react-dom/client
// binds to the document at createRoot time, and static `import` declarations
// hoist above any statement — so happy-dom's window/document are installed
// on globalThis FIRST and everything React-flavored is imported dynamically
// AFTER. `IS_REACT_ACT_ENVIRONMENT` makes React 19's `act()` flush renders +
// effects synchronously (including StrictMode's dev-only double-invoke),
// which is what makes every assertion below deterministic.
//
// process.exit(0) at the end per the house rule: happy-dom's window owns
// timers that can hold the process open.
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win = new Window()
;(globalThis as any).window = win
;(globalThis as any).document = win.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { createElement, StrictMode, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { makeDocument } = await import('@ensembleworks/canvas-model')
type Shape = import('@ensembleworks/canvas-model').Shape
type EditorState = import('@ensembleworks/canvas-editor').EditorState
const { useEffect } = await import('react')
const { registerShape } = await import('../shapeRegistry.js')
const { EmbedHost } = await import('./EmbedHost.js')
const { EmbedLayer } = await import('./EmbedLayer.js')
const { createLifecycleRegistry } = await import('./embedLifecycle.js')
type ShapeBodyProps = import('../shapeRegistry.js').ShapeBodyProps
type ToolContext = import('@ensembleworks/canvas-editor').ToolContext
type Editor = import('@ensembleworks/canvas-editor').Editor
type CanvasDocument = import('@ensembleworks/canvas-model').CanvasDocument

// ============================================================================
// Fixture: one terminal-kind embed shape, a recording lifecycle, a marker
// fake embed component.
// ============================================================================
const embedShape = {
  id: 'shape:live-embed', kind: 'terminal', parentId: 'page:p', index: 'a1',
  x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
} as Shape

const doc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [embedShape], bindings: [] })
const editorState: EditorState = Object.freeze({
  camera: Object.freeze({ x: 0, y: 0, z: 1 }),
  selection: new Set<string>(),
  hover: null,
  editingId: null,
  nextShapeStyle: {},
})

const calls: string[] = []
const lifecycle = {
  onMount: () => calls.push('mount'),
  onSuspend: () => calls.push('suspend'),
  onResume: () => calls.push('resume'),
  onUnmount: () => calls.push('unmount'),
}
const count = (event: string) => calls.filter((c) => c === event).length

function FakeEmbed() {
  return createElement('div', { 'data-fake-embed': embedShape.id }, 'live embed')
}
registerShape('terminal', FakeEmbed, { embed: true })

const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)

function render(visible: boolean, tick: number): void {
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(EmbedHost, { shape: embedShape, snapshot: doc, editorState, visible, tick, suspendAfterTicks: 1, lifecycle }),
      ),
    )
  })
}

// ============================================================================
// (a) Initial StrictMode mount: the simulated unmount/remount pair is FINE
//     (and expected in dev); frozen-dead is not — the LAST event must be
//     'mount' and mounts must lead unmounts by exactly one (a live,
//     armed controller).
// ============================================================================
render(true, 0)
assert.equal(calls.at(-1), 'mount', `after the initial StrictMode mount the latest lifecycle event must be 'mount' (live controller) — got ${JSON.stringify(calls)}`)
assert.equal(count('mount'), count('unmount') + 1, `mounts must lead unmounts by exactly one after mounting — got ${JSON.stringify(calls)}`)
const mountsAfterInitial = count('mount')
console.log(`ok: StrictMode initial mount — controller live (calls so far: ${JSON.stringify(calls)})`)

// ============================================================================
// (b) Invisible ticks past the threshold -> suspend fires (exactly once).
//     THE RED-FIRST PROBE for the original bug: with the broken
//     dispose-without-re-arm cleanup, the controller is already dead here
//     and these ticks are inert — no 'suspend' ever fires.
// ============================================================================
render(false, 1) // invisibleTicks=1 — at the threshold, not past it
render(false, 2) // invisibleTicks=2 > suspendAfterTicks(1) — suspends
assert.equal(count('suspend'), 1, `invisible ticks past the threshold must fire onSuspend exactly once — got ${JSON.stringify(calls)}`)

// One more render so the RENDERED state catches up (the wrapper's
// data-embed-state lags the controller by one render — controller.tick runs
// in an effect AFTER the render that delivered the tick; see EmbedHost.tsx's
// STATE LAG note). The DOM must STILL contain the embed body — suspended is
// hidden, never unmounted.
render(false, 3)
const wrapper = container.querySelector('[data-embed-state]')
assert.ok(wrapper, 'the embed wrapper must still be in the DOM while suspended')
assert.equal(wrapper!.getAttribute('data-embed-state'), 'suspended', 'the rendered wrapper reflects the suspended state')
assert.ok(container.querySelector('[data-fake-embed]'), 'the embed BODY must still be in the DOM while suspended — hidden, never unmounted')
assert.equal((wrapper as any).style.visibility, 'hidden', 'suspended wrapper is visibility:hidden')
console.log('ok: suspend fires through a real reconciler; DOM stays mounted, visibility:hidden')

// ============================================================================
// (c) Visible again -> resume, with NO remount (mount count unchanged).
// ============================================================================
render(true, 4)
assert.equal(count('resume'), 1, `a visible tick after suspension must fire onResume exactly once — got ${JSON.stringify(calls)}`)
assert.equal(count('mount'), mountsAfterInitial, 'resume must NOT remount — mount count unchanged since the initial mount')
render(true, 5) // rendered state catches up (same one-render lag as above)
assert.equal(container.querySelector('[data-embed-state]')!.getAttribute('data-embed-state'), 'active', 'the rendered wrapper reflects the resumed state')
console.log('ok: resume without remount')

// ============================================================================
// (d) Real unmount (root.unmount()) -> final onUnmount; mounts and unmounts
//     balance.
// ============================================================================
act(() => { root.unmount() })
assert.equal(calls.at(-1), 'unmount', `a real unmount must fire onUnmount last — got ${JSON.stringify(calls)}`)
assert.equal(count('mount'), count('unmount'), `after a real unmount every mount must have a matching unmount — got ${JSON.stringify(calls)}`)
console.log('ok: real unmount fires the final onUnmount')

// ============================================================================
// (e) THE FULL DOCUMENTED WIRING, END-TO-END: a body that registers its own
//     hooks with createLifecycleRegistry in its own mount effect, an
//     EmbedLayer handed `lifecycleFor={registry.lifecycleFor}` — covering
//     the `lifecycle={lifecycleFor?.(shape.id)}` pass-through line, which
//     previously had zero coverage. Two ORDERING facts make this pattern
//     work (both documented in EmbedHost.tsx's LIFECYCLE WIRING header and
//     exercised here for real):
//       1. Child effects commit BEFORE parent effects — the body's
//          register-in-mount-effect has already run by the time EmbedHost's
//          own mount effect creates the controller and fires onMount.
//       2. lifecycleFor's facade does a FRESH registry lookup at CALL time —
//          EmbedLayer calls lifecycleFor during RENDER (before ANY effect,
//          i.e. before the body has registered); a snapshot-at-render-time
//          lookup would capture "nothing registered" forever.
//     ALSO PINNED (empirically corrected — the first draft of this test
//     predicted the opposite and the reconciler proved it wrong): unmount
//     CLEANUPS run PARENT-FIRST (React traverses a deleted subtree
//     top-down), the mirror image of mount effects' child-first order —
//     so EmbedHost's dispose fires the facade's onUnmount while the body
//     is STILL registered, and onUnmount IS delivered through the
//     registry, both on StrictMode's simulated cleanup and on a real
//     unmount. The body's own unregister cleanup runs after. Net: the
//     registry delivers the complete, correctly-paired lifecycle in both
//     directions (documented in embedLifecycle.ts's ORDERING block).
// ============================================================================
{
  const registry = createLifecycleRegistry()
  const bodyCalls: string[] = []
  const bodyCount = (event: string) => bodyCalls.filter((c) => c === event).length

  function RegisteringEmbed({ shape }: ShapeBodyProps) {
    useEffect(() => {
      return registry.register(shape.id, {
        onMount: () => bodyCalls.push('mount'),
        onSuspend: () => bodyCalls.push('suspend'),
        onResume: () => bodyCalls.push('resume'),
        onUnmount: () => bodyCalls.push('unmount'),
      })
    }, [shape.id])
    return createElement('div', { 'data-registering-embed': shape.id }, 'registering embed')
  }
  registerShape('iframe', RegisteringEmbed, { embed: true })

  const layerShape = {
    id: 'shape:layer-embed', kind: 'iframe', parentId: 'page:p', index: 'a1',
    x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 },
  } as Shape
  const layerDoc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [layerShape], bindings: [] })

  const toolContext = {
    editor: {
      doc: { subscribe: (_l: () => void) => () => {} },
      get: () => editorState,
      subscribe: (_l: () => void) => () => {},
    } as unknown as Editor,
    snapshot: (): CanvasDocument => layerDoc,
    index: () => { throw new Error('EmbedLayer must never call toolContext.index()') },
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  } as ToolContext

  const layerContainer = document.createElement('div')
  document.body.appendChild(layerContainer)
  const layerRoot = createRoot(layerContainer)
  const viewportSize = { width: 800, height: 600 }
  const onScreen = { x: 0, y: 0, z: 1 } // viewport world (0,0)-(800,600): shape at (10,10) visible
  const offScreen = { x: -100_000, y: -100_000, z: 1 } // viewport world starts at (100000,100000): shape invisible

  function renderLayer(camera: { x: number; y: number; z: number }, tick: number): void {
    act(() => {
      layerRoot.render(
        createElement(
          StrictMode,
          null,
          createElement(EmbedLayer, { toolContext, camera, viewportSize, tick, suspendAfterTicks: 1, lifecycleFor: registry.lifecycleFor }),
        ),
      )
    })
  }

  renderLayer(onScreen, 0)
  assert.equal(bodyCalls.at(-1), 'mount', `the body's REGISTERED onMount must fire through the registry -> EmbedLayer -> EmbedHost chain — got ${JSON.stringify(bodyCalls)}`)
  assert.equal(bodyCount('mount'), bodyCount('unmount') + 1, `mounts lead unmounts by one after mounting (the StrictMode simulated pair is delivered through the registry too) — got ${JSON.stringify(bodyCalls)}`)
  assert.ok(bodyCount('suspend') === 0 && bodyCount('resume') === 0, `no suspend/resume yet — got ${JSON.stringify(bodyCalls)}`)

  renderLayer(offScreen, 1) // invisibleTicks=1 — at threshold, not past
  renderLayer(offScreen, 2) // invisibleTicks=2 > 1 — suspends
  assert.equal(bodyCount('suspend'), 1, `the body's registered onSuspend must fire when the shape scrolls out past the threshold — got ${JSON.stringify(bodyCalls)}`)
  assert.ok(layerContainer.querySelector('[data-registering-embed]'), 'the body DOM stays mounted while suspended (EmbedLayer never culls)')

  renderLayer(onScreen, 3)
  assert.equal(bodyCount('resume'), 1, `the body's registered onResume must fire when the shape scrolls back — got ${JSON.stringify(bodyCalls)}`)

  act(() => { layerRoot.unmount() })
  assert.equal(bodyCalls.at(-1), 'unmount', `a real unmount delivers onUnmount through the registry — unmount cleanups run PARENT-first, so the host's dispose fires before the body unregisters (see the block comment above); got ${JSON.stringify(bodyCalls)}`)
  assert.equal(bodyCount('mount'), bodyCount('unmount'), `every mount pairs with an unmount through the registry — got ${JSON.stringify(bodyCalls)}`)
  console.log(`ok: registry -> EmbedLayer -> EmbedHost end-to-end — body-registered hooks fire, fully paired (log: ${JSON.stringify(bodyCalls)})`)
}

console.log(`ok: embed-reconciler (StrictMode-safe lifecycle through a real react-dom/client reconciler; full call log: ${JSON.stringify(calls)})`)
process.exit(0) // happy-dom's window can hold timers open — house rule for any test that boots a DOM/browser-ish environment
