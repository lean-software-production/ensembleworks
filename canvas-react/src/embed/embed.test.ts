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
import type { Editor, EditorState, Intent, ToolContext } from '@ensembleworks/canvas-editor'
import { createEmbedController, createLifecycleRegistry, sameEmbedContent, type EmbedLifecycle } from './embedLifecycle.js'
import { EmbedBodyFrame, EmbedHost, embedBodyPropsEqual, embedWrapperStyle } from './EmbedHost.js'
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

// 7. createLifecycleRegistry — the out-of-band wiring bodies actually use
//    (see EmbedHost.tsx's LIFECYCLE WIRING header for why props alone can't
//    work: the body sits BELOW EmbedHost in the tree, so it can't hand a
//    props object UP to it). Pinned here: register/unregister round-trip,
//    LATE registration through an already-handed-out facade (lifecycleFor's
//    closures do a FRESH map lookup at CALL time, so a facade obtained
//    before the body registered still reaches the hooks afterward — the
//    fact that makes the EmbedLayer render-time lifecycleFor call safe even
//    though the body only registers in its own mount effect), and
//    stale-unregister safety (an unregister fn from a REPLACED registration
//    must not remove the replacement).
{
  const registry = createLifecycleRegistry()
  const calls: string[] = []

  // LATE REGISTRATION: facade handed out BEFORE anything registers.
  const facade = registry.lifecycleFor('shape:reg')!
  facade.onMount?.() // nothing registered — silent no-op, not a crash
  // .length, not deepEqual(calls, []): node:assert/strict's deepEqual has an
  // `asserts actual is T` signature, and a `[]` literal would NARROW `calls`
  // to never[], breaking every later push() under typecheck.
  assert.equal(calls.length, 0, 'a facade callback with nothing registered is a silent no-op')

  const unregister = registry.register('shape:reg', {
    onMount: () => calls.push('mount'),
    onSuspend: () => calls.push('suspend'),
  })
  facade.onMount?.() // the SAME pre-registration facade now reaches the hooks
  facade.onSuspend?.()
  assert.deepEqual(calls, ['mount', 'suspend'], 'late registration is visible through a facade handed out earlier (call-time lookup)')

  unregister()
  facade.onSuspend?.() // unregistered — silent no-op again
  assert.deepEqual(calls, ['mount', 'suspend'], 'after unregister the facade goes back to no-op')

  // STALE UNREGISTER: replacing a registration invalidates the OLD
  // unregister fn — calling it must not tear down the replacement.
  const unregisterFirst = registry.register('shape:reg', { onMount: () => calls.push('first') })
  registry.register('shape:reg', { onMount: () => calls.push('second') })
  unregisterFirst() // stale — must be a no-op
  registry.lifecycleFor('shape:reg')!.onMount?.()
  assert.deepEqual(calls, ['mount', 'suspend', 'second'], 'a stale unregister must not remove a replacement registration')

  // Independence: a second id has its own slot.
  registry.register('shape:other', { onMount: () => calls.push('other-mount') })
  registry.lifecycleFor('shape:other')!.onMount?.()
  assert.deepEqual(calls, ['mount', 'suspend', 'second', 'other-mount'])
  console.log('ok: createLifecycleRegistry — register/unregister, late registration via call-time lookup, stale-unregister safety')
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
  const state: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' })
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
//    with normal (visible) wrapper styling. Under renderToStaticMarkup
//    EmbedHost has NO controller at all (the controller is created in a
//    mount EFFECT — EmbedHost.tsx's "ONE CONTROLLER PER COMMIT LIFETIME,
//    RE-ARMABLE" block — and react-dom/server runs no effects, see
//    viewport.test.ts's header), so the rendered state is the documented
//    'active' fallback; the SUSPENDED case is instead proven
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

  const editorState: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' })

  // ACTIVE, via the real stateful EmbedHost: no effects run under
  // renderToStaticMarkup, so this observes the pre-controller 'active'
  // fallback (see the block comment above). The LIVE mount path — real
  // controller, real ticks, StrictMode — is embed-reconciler.test.ts's job.
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

// ============================================================================
// 10. dispatch threading (Task D2): EmbedHost forwards `dispatch` to the
//     embed component (mirroring case 9's shape/snapshot/editorState
//     forwarding), EmbedLayer threads its own `dispatch` prop down to every
//     EmbedHost it renders, and — THE CONTENT-MEMO CONSTRAINT this task is
//     really about — `embedBodyPropsEqual` still returns true (i.e. still
//     bails out of a re-render) when the shape's CONTENT is unchanged even
//     though `dispatch` is a BRAND NEW reference on the second props object.
//     If dispatch were compared (or included in a content hash), this
//     assertion would flip to false and the Phase-3 memo win would be
//     silently defeated the moment D2 landed.
// ============================================================================
{
  const dispatchCalls: Intent[][] = []
  const fakeEditor = { applyAll: (intents: readonly Intent[]) => dispatchCalls.push([...intents]) }
  const dispatch = (intents: Intent[]) => fakeEditor.applyAll(intents)

  function DispatchEmbed({ shape, dispatch: d }: ShapeBodyProps) {
    d?.([{ type: 'UpdateProps', id: shape.id, props: { touched: true } }])
    return createElement('div', { 'data-dispatch-embed': shape.id, 'data-has-dispatch': typeof d === 'function' })
  }
  // 'iframe' — a real ShapeKind (canvas-model/shape.ts's SHAPE_KINDS) that is
  // an embed kind but otherwise unregistered/untouched by this file's
  // earlier cases (only 'terminal' -> FakeEmbed is registered above).
  registerShape('iframe', DispatchEmbed, { embed: true })

  const dispatchEmbedShape: Shape = {
    id: 'shape:dispatch-embed1', kind: 'iframe', parentId: 'page:p', index: 'a1', x: 10, y: 10, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 50, h: 50 },
  }

  const editorStateForDispatch: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId: 'page:p' })

  // 10a. EmbedHost forwards dispatch straight to the resolved embed component.
  const hostHtml = renderToStaticMarkup(
    createElement(EmbedHost, { shape: dispatchEmbedShape, snapshot: doc, editorState: editorStateForDispatch, visible: true, tick: 0, suspendAfterTicks: 1, dispatch }),
  )
  assert.match(hostHtml, /data-has-dispatch="true"/, 'EmbedHost forwards dispatch to the resolved embed component')
  console.log('ok: EmbedHost forwards dispatch to the resolved embed component')

  // 10b. EmbedLayer threads its own dispatch prop down to every EmbedHost it renders.
  const dispatchEmbedDoc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [dispatchEmbedShape], bindings: [] })
  const camera = { x: 0, y: 0, z: 1 }
  const viewportSize = { width: 800, height: 600 }
  const embedLayerHtml = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContext(dispatchEmbedDoc, true), camera, viewportSize, tick: 0, suspendAfterTicks: 1, dispatch }),
  )
  assert.match(embedLayerHtml, /data-has-dispatch="true"/, 'EmbedLayer threads dispatch down to its EmbedHost children')
  console.log('ok: EmbedLayer threads dispatch down to EmbedHost')

  // 10c. Calling dispatch([...]) from within the rendered embed body reaches
  //      editor.applyAll — same wiring shape as shape-layer.test.ts's case 6c.
  assert.equal(dispatchCalls.length, 2, 'dispatch was invoked once per render above (EmbedHost direct render + EmbedLayer render)')
  assert.deepEqual(
    dispatchCalls[0],
    [{ type: 'UpdateProps', id: dispatchEmbedShape.id, props: { touched: true } }],
    'the exact intents passed to dispatch() reach editor.applyAll unchanged',
  )
  console.log('ok: dispatch([...intents]) called from an embed body reaches editor.applyAll')

  // 10d. THE CONTENT-MEMO CONSTRAINT: embedBodyPropsEqual must still return
  //      true when only dispatch differs (a brand new function reference
  //      each time, exactly what an UNSTABLE dispatch would look like) and
  //      the shape's serialized content is identical — proving dispatch is
  //      excluded from the comparator entirely, not merely "usually stable
  //      enough to pass". Two semantically-identical-but-distinct dispatch
  //      references (mirroring dumpModel's "always new shape reference"
  //      reality that sameEmbedContent already tolerates for `shape`).
  const propsA: ShapeBodyProps = { shape: dispatchEmbedShape, snapshot: dispatchEmbedDoc, editorState: editorStateForDispatch, dispatch: (intents) => fakeEditor.applyAll(intents) }
  const propsB: ShapeBodyProps = { shape: { ...dispatchEmbedShape, props: { ...dispatchEmbedShape.props } }, snapshot: dispatchEmbedDoc, editorState: editorStateForDispatch, dispatch: (intents) => fakeEditor.applyAll(intents) }
  assert.notEqual(propsA.dispatch, propsB.dispatch, 'the two dispatch references must be genuinely distinct for this to prove anything')
  assert.equal(
    embedBodyPropsEqual(propsA, propsB),
    true,
    'embedBodyPropsEqual must still bail out (return true/"equal") when only dispatch identity differs and shape content is unchanged — dispatch must be EXCLUDED from the comparator',
  )

  // And the converse sanity check: a REAL content change still returns false
  // regardless of dispatch being present/stable — the comparator did not
  // silently stop comparing shape content either.
  const propsC: ShapeBodyProps = { shape: { ...dispatchEmbedShape, x: 999 }, snapshot: dispatchEmbedDoc, editorState: editorStateForDispatch, dispatch: propsA.dispatch }
  assert.equal(
    embedBodyPropsEqual(propsA, propsC),
    false,
    'embedBodyPropsEqual must still return false for an actual content change, even with dispatch present on both sides',
  )
  console.log('ok: embedBodyPropsEqual excludes dispatch from the content-memo comparison (Phase-3 memo win survives D2)')
}

// ============================================================================
// 11. Task R1 — the PAGE render filter applies to EmbedLayer too (plan
//    Correction 2 — a culling-EXEMPT sibling that also renders shapes, so it
//    would otherwise paint another page's terminals/iframes onto the
//    current screen). Same page predicate as ShapeLayer
//    (`pageIdOf(snapshot, shape) === currentPageId`), composed with the
//    existing `isEmbedKind` + worldBounds-intersect filter — proven here
//    with a shape DELIBERATELY off-viewport (so only the page filter, not
//    culling, could be hiding it) to isolate the page predicate from
//    EmbedLayer's "no viewport cull at all" contract (case 7 above).
// ============================================================================
function fakeToolContextForPage(snapshot: CanvasDocument, currentPageId: string): ToolContext {
  const state: EditorState = Object.freeze({ camera: Object.freeze({ x: 0, y: 0, z: 1 }), selection: new Set<string>(), hover: null, editingId: null, nextShapeStyle: {}, currentPageId })
  const editor = {
    doc: { subscribe: (_l: () => void) => () => {} },
    get: (): EditorState => state,
    subscribe: (_l: () => void) => () => {},
  } as unknown as Editor
  return {
    editor,
    snapshot: () => snapshot,
    index: () => { throw new Error('EmbedLayer must never call toolContext.index()') },
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  }
}

{
  const embedOnP: Shape = { id: 'shape:embed-onP', kind: 'terminal', parentId: 'page:p', index: 'a1', x: 1_000_000, y: 1_000_000, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 } } as Shape
  const embedOnQ: Shape = { id: 'shape:embed-onQ', kind: 'terminal', parentId: 'page:q', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 100, h: 100 } } as Shape
  const twoPageEmbedDoc: CanvasDocument = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }, { id: 'page:q', name: 'Q' }],
    shapes: [embedOnP, embedOnQ],
    bindings: [],
  })
  const camera = { x: 0, y: 0, z: 1 }
  const viewportSize = { width: 800, height: 600 }

  const htmlP = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContextForPage(twoPageEmbedDoc, 'page:p'), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(htmlP.includes('data-fake-embed="shape:embed-onP"'), `embed on page:p should render regardless of viewport (no cull) when currentPageId='page:p': ${htmlP}`)
  assert.ok(!htmlP.includes('data-fake-embed="shape:embed-onQ"'), `embed on page:q must NOT render when currentPageId='page:p', even though it IS on-screen: ${htmlP}`)
  console.log('ok: EmbedLayer paints only the current page — an on-screen embed on another page is still excluded')

  const htmlQ = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContextForPage(twoPageEmbedDoc, 'page:q'), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(!htmlQ.includes('data-fake-embed="shape:embed-onP"'), `embed on page:p must NOT render when currentPageId='page:q': ${htmlQ}`)
  assert.ok(htmlQ.includes('data-fake-embed="shape:embed-onQ"'), `embed on page:q should render when currentPageId='page:q': ${htmlQ}`)
  console.log('ok: switching currentPageId to page:q flips which page EmbedLayer paints')

  // MIGRATION SAFETY: single-page room (both embeds on page:p) renders both
  // regardless of viewport position — the filter hides NOTHING when every
  // shape IS on the current page.
  const singlePageEmbedDoc: CanvasDocument = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [embedOnP, { ...embedOnQ, id: 'shape:embed-onP2', parentId: 'page:p' }],
    bindings: [],
  })
  const migrationHtml = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContextForPage(singlePageEmbedDoc, 'page:p'), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(migrationHtml.includes('data-fake-embed="shape:embed-onP"'), `single-page migration: shape:embed-onP must still render: ${migrationHtml}`)
  assert.ok(migrationHtml.includes('data-fake-embed="shape:embed-onP2"'), `single-page migration: shape:embed-onP2 must still render: ${migrationHtml}`)
  console.log('ok: MIGRATION SAFETY — EmbedLayer in a single-page room renders every embed unchanged')

  // NESTED: an embed whose FRAME parent is on page:q must resolve to
  // page:q via pageIdOf's ancestor walk, NOT via its own direct parentId
  // (which is the frame's id, never a page id). A mutant that checks
  // `shape.parentId === currentPageId` directly would hide this embed under
  // EVERY currentPageId, since its parentId is never a page id at all —
  // this case is what actually catches that mutant for EmbedLayer (the
  // root-parented embedOnP/embedOnQ above do NOT: their parentId already
  // happens to equal their page id, so a parentId-only check would
  // accidentally still pass those).
  const frameOnQForEmbed: Shape = { id: 'shape:embed-frameQ', kind: 'frame', parentId: 'page:q', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 400, h: 400, name: 'F' } } as Shape
  const nestedEmbedOnQ: Shape = { id: 'shape:embed-nestedQ', kind: 'terminal', parentId: 'shape:embed-frameQ', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 50, h: 50 } } as Shape
  const nestedEmbedDoc: CanvasDocument = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }, { id: 'page:q', name: 'Q' }],
    shapes: [frameOnQForEmbed, nestedEmbedOnQ],
    bindings: [],
  })
  const nestedHtmlP = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContextForPage(nestedEmbedDoc, 'page:p'), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(!nestedHtmlP.includes('data-fake-embed="shape:embed-nestedQ"'), `a nested embed under a frame on page:q must NOT render when currentPageId='page:p': ${nestedHtmlP}`)
  const nestedHtmlQ = renderToStaticMarkup(
    createElement(EmbedLayer, { toolContext: fakeToolContextForPage(nestedEmbedDoc, 'page:q'), camera, viewportSize, tick: 0, suspendAfterTicks: 2 }),
  )
  assert.ok(nestedHtmlQ.includes('data-fake-embed="shape:embed-nestedQ"'), `a nested embed under a frame on page:q SHOULD render when currentPageId='page:q' (pageIdOf walks to the page ancestor): ${nestedHtmlQ}`)
  console.log('ok: EmbedLayer resolves a nested embed to its PAGE ancestor (pageIdOf), not its direct parentId')
}

console.log('ok: embed (lifecycle state machine + culling-exempt EmbedLayer + EmbedHost rendering + dispatch threading with memo-safety, page filter)')
