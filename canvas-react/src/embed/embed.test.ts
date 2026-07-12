// Run: bun src/embed/embed.test.ts
// Two halves, deliberately split by what each CAN prove given this house
// rig's constraints (see below):
//
//   PART A — embedLifecycle.ts's pure state machine (createEmbedController,
//   sameEmbedContent): ZERO React, ZERO DOM. This is where every scenario
//   the D8 task lists (mount-once, suspend-after-N-ticks, resume-without-
//   remount, sub-threshold blip, per-embed independence, unmount-on-
//   dispose) gets exhaustive, direct coverage — a plain node:assert script
//   driving `tick()` by hand, no timers, no rendering.
//
//   PART B — EmbedHost/EmbedLayer rendered via renderToStaticMarkup (no DOM
//   emulator in this house rig — see viewport.test.ts's header): a
//   ONE-SHOT string render has no persisted fiber tree, so it CANNOT
//   observe React.memo's actual reconciler bailout or EmbedHost's own
//   tick-driven useEffect transitions across a SECOND render of the SAME
//   mounted tree — there is no such second render to observe. What static
//   markup CAN and DOES prove here: (1) EmbedLayer selects embed-kind
//   shapes regardless of viewport visibility (the actual culling-exemption
//   this unit exists to deliver) while ShapeLayer excludes them entirely;
//   (2) EmbedHost, rendered directly with an explicit `visible`/pre-ticked
//   state, produces the right wrapper style AND still contains the embed
//   body's markup in the SUSPENDED case — i.e. suspending never removes the
//   DOM, which is the whole contract's point. The ACTUAL live-reconciler
//   behavior (real ticking over time, real memo bailout under a real
//   commit) is a G2/e2e concern, exactly like Viewport.tsx's deferred
//   pointer-capture coverage.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSpatialIndex, makeDocument, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Editor, EditorState, ToolContext } from '@ensembleworks/canvas-editor'
import { createEmbedController, sameEmbedContent, type EmbedLifecycle } from './embedLifecycle.js'
import { EmbedBodyFrame, EmbedHost, embedWrapperStyle } from './EmbedHost.js'
import { EmbedLayer, boundsIntersect } from './EmbedLayer.js'
import { ShapeLayer } from '../ShapeLayer.js'
import { registerShape, type ShapeBodyProps } from '../shapeRegistry.js'

// ============================================================================
// PART A — embedLifecycle.ts's pure state machine
// ============================================================================

function fakeLifecycle() {
  const calls: string[] = []
  const lifecycle: EmbedLifecycle = {
    onMount: () => calls.push('mount'),
    onSuspend: () => calls.push('suspend'),
    onResume: () => calls.push('resume'),
    onUnmount: () => calls.push('unmount'),
  }
  return { lifecycle, calls }
}

// 1. onMount fires exactly once, synchronously, at construction.
{
  const { lifecycle, calls } = fakeLifecycle()
  createEmbedController(lifecycle, { suspendAfterTicks: 2 })
  assert.deepEqual(calls, ['mount'], 'onMount fires exactly once, at construction, before any tick')
  console.log('ok: onMount fires once at construction')
}

// 2. Suspend after MORE THAN suspendAfterTicks consecutive invisible ticks;
//    resume on the next visible tick, with NO extra onMount (no remount).
{
  const { lifecycle, calls } = fakeLifecycle()
  const controller = createEmbedController(lifecycle, { suspendAfterTicks: 2 })
  controller.tick(false) // invisibleTicks=1 — still active
  controller.tick(false) // invisibleTicks=2 — still active (threshold is "more than 2")
  assert.equal(controller.getState(), 'active', 'exactly suspendAfterTicks invisible ticks must NOT suspend yet')
  controller.tick(false) // invisibleTicks=3 > 2 — suspends now
  assert.equal(controller.getState(), 'suspended', 'more than suspendAfterTicks consecutive invisible ticks suspends')
  assert.deepEqual(calls, ['mount', 'suspend'], 'onSuspend fires exactly once on crossing the threshold')

  controller.tick(true) // visible again
  assert.equal(controller.getState(), 'active', 'a visible tick resumes')
  assert.deepEqual(calls, ['mount', 'suspend', 'resume'], 'onResume fires — no extra onMount: this is a resume, not a remount')
  console.log('ok: suspend after threshold, resume without remount (mount count stays 1 — one onMount total)')
}

// 3. Sub-threshold blip: invisible for fewer than the threshold, then
//    visible again — NEVER suspends, onSuspend never fires.
{
  const { lifecycle, calls } = fakeLifecycle()
  const controller = createEmbedController(lifecycle, { suspendAfterTicks: 2 })
  controller.tick(false) // 1 invisible tick — a transient blip
  controller.tick(true) // visible again before the threshold
  assert.equal(controller.getState(), 'active', 'a sub-threshold blip never suspends')
  assert.deepEqual(calls, ['mount'], 'onSuspend must NOT fire for a sub-threshold blip')
  console.log('ok: sub-threshold blip does not suspend')
}

// 4. Two embeds have fully independent lifecycles — ticking one never
//    affects the other's state or call history.
{
  const a = fakeLifecycle()
  const b = fakeLifecycle()
  const controllerA = createEmbedController(a.lifecycle, { suspendAfterTicks: 1 })
  const controllerB = createEmbedController(b.lifecycle, { suspendAfterTicks: 1 })
  controllerA.tick(false)
  controllerA.tick(false) // A suspends (invisibleTicks=2 > 1)
  assert.equal(controllerA.getState(), 'suspended', 'A suspends on its own schedule')
  assert.equal(controllerB.getState(), 'active', 'B is untouched by ticking A')
  assert.deepEqual(a.calls, ['mount', 'suspend'])
  assert.deepEqual(b.calls, ['mount'], 'B never received a suspend call')
  console.log('ok: two embeds — fully independent lifecycles')
}

// 5. Shape deletion -> dispose -> onUnmount, exactly once, idempotent on a
//    second dispose() call.
{
  const { lifecycle, calls } = fakeLifecycle()
  const controller = createEmbedController(lifecycle, { suspendAfterTicks: 1 })
  controller.dispose()
  controller.dispose() // second call — must be a silent no-op, not a double onUnmount
  assert.deepEqual(calls, ['mount', 'unmount'], 'onUnmount fires exactly once, even under a repeated dispose() call')
  // Ticking after dispose is a no-op — no further state changes/callbacks.
  controller.tick(false)
  controller.tick(false)
  controller.tick(false)
  assert.deepEqual(calls, ['mount', 'unmount'], 'tick() after dispose() is a no-op')
  console.log('ok: dispose (shape-deleted) fires onUnmount exactly once; post-dispose ticks are no-ops')
}

// 6. sameEmbedContent (the content-memo comparator): true for two distinct
//    object references with identical id + serialized content; false once
//    either id or content differs. Mirrors dumpModel()'s "always a new
//    reference" reality (ShapeBody.tsx's MEMO STRATEGY block) directly.
{
  const shapeA: Shape = { id: 'shape:s1', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 } } as Shape
  const shapeACopy: Shape = { ...shapeA, props: { ...shapeA.props } } // distinct reference, identical content
  const shapeAMoved: Shape = { ...shapeA, x: 5 }
  const shapeB: Shape = { ...shapeA, id: 'shape:s2' }

  assert.equal(sameEmbedContent(shapeA, shapeACopy), true, 'distinct references with identical content are the same for memo purposes')
  assert.equal(sameEmbedContent(shapeA, shapeAMoved), false, 'a changed field (x) makes the content different')
  assert.equal(sameEmbedContent(shapeA, shapeB), false, 'a different id is never the same content')
  console.log('ok: sameEmbedContent — the content-memo comparator (render-count-probe logic, tested directly)')
}

// ============================================================================
// PART B — EmbedHost/EmbedLayer rendering (renderToStaticMarkup, see the
// file header's ACKNOWLEDGED LIMITATION for what this half can and cannot
// prove).
// ============================================================================

function FakeEmbed({ shape }: ShapeBodyProps) {
  return createElement('div', { 'data-fake-embed': shape.id }, `embed:${shape.id}`)
}
registerShape('terminal', FakeEmbed, { embed: true })

const embedShapeVisible = { id: 'shape:embed-visible', kind: 'terminal', parentId: 'page:p', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 } } as Shape
const embedShapeOffscreen = { id: 'shape:embed-offscreen', kind: 'terminal', parentId: 'page:p', index: 'a2', x: 1_000_000, y: 1_000_000, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 } } as Shape
const plainGeoShape = { id: 'shape:geo', kind: 'geo', parentId: 'page:p', index: 'a3', x: 20, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 50, h: 50 } } as Shape

const doc: CanvasDocument = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [embedShapeVisible, embedShapeOffscreen, plainGeoShape],
  bindings: [],
})

// `indexThrows`: true for the EmbedLayer half of test 7 below, proving
// EmbedLayer never touches toolContext.index() (it does its own direct
// worldBounds check — see EmbedLayer.tsx's module header); false for
// ShapeLayer, which DOES need a real index (its own, unrelated culling
// path — see ShapeLayer.tsx).
function fakeToolContext(snapshot: CanvasDocument, indexThrows: boolean): ToolContext {
  const state: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null })
  const editor = {
    doc: { subscribe: (_l: () => void) => () => {} },
    get: (): EditorState => state,
    subscribe: (_l: () => void) => () => {},
  } as unknown as Editor
  return {
    editor,
    snapshot: () => snapshot,
    index: () => {
      if (indexThrows) throw new Error('EmbedLayer must never call toolContext.index() — it does its own direct worldBounds check, see the module header')
      return buildSpatialIndex(snapshot)
    },
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  }
}

// 7. ShapeLayer EXCLUDES embed-kind shapes entirely (isEmbedKind filter);
//    EmbedLayer INCLUDES every embed-kind shape REGARDLESS of viewport
//    visibility — the actual culling exemption this unit exists to
//    deliver, and the reason ShapeLayer's own culling stays "dumb".
{
  const camera = { x: 0, y: 0, z: 1 }
  const viewportSize = { width: 800, height: 600 }

  const shapeLayerHtml = renderToStaticMarkup(createElement(ShapeLayer, { toolContext: fakeToolContext(doc, false), camera, viewportSize }))
  assert.ok(!shapeLayerHtml.includes('data-fake-embed'), 'ShapeLayer must never render an embed-kind shape')
  assert.ok(shapeLayerHtml.includes(`data-shape-id="${plainGeoShape.id}"`), 'ShapeLayer still renders ordinary (non-embed) shapes')

  const embedLayerHtml = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContext(doc, true), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(embedLayerHtml.includes(`data-fake-embed="${embedShapeVisible.id}"`), 'EmbedLayer renders the on-screen embed shape')
  assert.ok(
    embedLayerHtml.includes(`data-fake-embed="${embedShapeOffscreen.id}"`),
    'EmbedLayer renders the OFF-SCREEN embed shape too — no viewport cull at all, unlike ShapeLayer',
  )
  assert.ok(!embedLayerHtml.includes(`data-shape-id="${plainGeoShape.id}"`), 'EmbedLayer never renders a non-embed shape')
  console.log('ok: ShapeLayer excludes embed kinds; EmbedLayer includes every embed shape regardless of visibility')
}

// 8. EmbedLayer's own visibility computation (boundsIntersect over
//    worldBounds) agrees with which shape is on/off screen — pinned
//    directly, independent of any rendering.
{
  const viewport = { minX: 0, minY: 0, maxX: 800, maxY: 600 }
  assert.equal(boundsIntersect({ minX: 10, minY: 10, maxX: 110, maxY: 110 }, viewport), true, 'an on-screen box intersects the viewport')
  assert.equal(boundsIntersect({ minX: 1_000_000, minY: 1_000_000, maxX: 1_000_100, maxY: 1_000_100 }, viewport), false, 'a far-off-screen box does not intersect the viewport')
  console.log('ok: boundsIntersect — pinned directly')
}

// 9. EmbedHost, rendered directly: the ACTIVE case shows the embed body
//    with normal (visible) wrapper styling. EmbedHost's own controller
//    always starts 'active' (renderToStaticMarkup never runs the tick
//    effect — react-dom/server runs no effects at all, see
//    viewport.test.ts's header), so the SUSPENDED case is instead proven
//    via `EmbedBodyFrame` — the PURE render function EmbedHost delegates
//    to, factored out for exactly this reason (see EmbedHost.tsx's module
//    header) — rendered with an explicit `state: 'suspended'` prop: the
//    embed body's markup is STILL PRESENT (DOM stays mounted) with
//    visibility:hidden + pointerEvents:none, never display:none, per the
//    module header's VISIBLE-BUT-HIDDEN decision. Part A above already
//    proves the state machine that DECIDES when 'suspended' applies,
//    exhaustively and independent of React; this proves what 'suspended'
//    LOOKS like once EmbedHost's controller reaches it.
{
  assert.deepEqual(embedWrapperStyle('active'), { visibility: 'visible', pointerEvents: 'auto' })
  assert.deepEqual(embedWrapperStyle('suspended'), { visibility: 'hidden', pointerEvents: 'none' })

  const editorState: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null })

  // ACTIVE, via the real stateful EmbedHost: visible=true, tick=0 — the
  // controller starts 'active' and a construction-time render observes
  // exactly that.
  const activeHtml = renderToStaticMarkup(
    createElement(EmbedHost, { shape: embedShapeVisible, snapshot: doc, editorState, visible: true, tick: 0, suspendAfterTicks: 1 }),
  )
  assert.ok(activeHtml.includes(`data-fake-embed="${embedShapeVisible.id}"`), 'active EmbedHost renders the embed body')
  assert.ok(activeHtml.includes('data-embed-state="active"'), 'active EmbedHost reports state=active')
  assert.ok(!activeHtml.includes('visibility:hidden'), 'active EmbedHost must not be visibility:hidden')

  // SUSPENDED, via the pure EmbedBodyFrame (explicit state prop — see
  // comment above for why EmbedHost itself can't reach this state under
  // renderToStaticMarkup): the embed body's markup MUST still be present.
  const suspendedHtml = renderToStaticMarkup(
    createElement(EmbedBodyFrame, { shape: embedShapeVisible, snapshot: doc, editorState, state: 'suspended' }),
  )
  assert.ok(
    suspendedHtml.includes(`data-fake-embed="${embedShapeVisible.id}"`),
    `suspended EmbedBodyFrame must still contain the embed body's DOM (never unmounted): ${suspendedHtml}`,
  )
  assert.ok(suspendedHtml.includes('data-embed-state="suspended"'), 'suspended EmbedBodyFrame reports state=suspended')
  assert.ok(suspendedHtml.includes('visibility:hidden'), 'suspended EmbedBodyFrame is visibility:hidden')
  assert.ok(suspendedHtml.includes('pointer-events:none'), 'suspended EmbedBodyFrame is pointer-events:none')
  assert.ok(!suspendedHtml.includes('display:none'), 'suspended EmbedBodyFrame must NOT use display:none — see the VISIBLE-BUT-HIDDEN decision')
  console.log('ok: EmbedHost/EmbedBodyFrame render — active via the real controller, suspended via the pure frame; DOM stays mounted, visibility:hidden not display:none')
}

console.log('ok: embed (lifecycle state machine + culling-exempt EmbedLayer + EmbedHost rendering)')
