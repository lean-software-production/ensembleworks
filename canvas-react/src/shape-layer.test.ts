// Run: bun src/shape-layer.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts`. Fixtures use plain object literals shaped
// like canvas-model's Shape/CanvasDocument, and a HAND-BUILT fake
// ToolContext (not a real Editor/CanvasDoc) — see FAKE TOOLCONTEXT below for
// why that's sufficient and, more importantly, why it's the RIGHT choice
// here rather than pulling in @ensembleworks/canvas-doc as an undeclared
// test-only dependency.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSpatialIndex, makeDocument, worldTransform, type CanvasDocument, type Shape } from '@ensembleworks/canvas-model'
import type { Editor, EditorState, Intent, ToolContext } from '@ensembleworks/canvas-editor'
import { ShapeBody, shapeBodyTransform } from './ShapeBody.js'
import { ShapeLayer } from './ShapeLayer.js'
import { registerShape, type ShapeBodyProps } from './shapeRegistry.js'

// ============================================================================
// Fixture doc: THREE shapes exercising the three cases the exit gate asks
// for — (1) a rotated ROOT shape (no parent composition), (2) a shape
// parented to a ROTATED parent (composition), (3) a huge shape positioned
// far outside any reasonable viewport (culling).
// ============================================================================
function geoShape(id: string, parentId: string, x: number, y: number, rotation: number, w = 100, h = 100): Shape {
  return {
    id, kind: 'geo', parentId, index: 'a1', x, y, rotation,
    isLocked: false, opacity: 1, meta: {}, props: { w, h },
  } as Shape
}

const rootRotated = geoShape('shape:rot', 'page:p', 50, 60, Math.PI / 6, 80, 40)
const rotatedParent = geoShape('shape:parent', 'page:p', 10, 20, Math.PI / 3, 800, 600)
const nestedChild = geoShape('shape:child', 'shape:parent', 15, 5, Math.PI / 12, 30, 30)
const hugeOffViewport = geoShape('shape:huge', 'page:p', 1_000_000, 1_000_000, 0, 100, 100)

const doc: CanvasDocument = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [rootRotated, rotatedParent, nestedChild, hugeOffViewport],
  bindings: [],
})

const editorState: EditorState = {
  camera: Object.freeze({ x: 0, y: 0, z: 1 }),
  selection: new Set<string>(),
  hover: null,
  editingId: null,
}

// ============================================================================
// FAKE TOOLCONTEXT: ShapeLayer's only actual uses of `toolContext` are
// `.editor` (passed straight to useEditorState), `.snapshot()` (via
// useDocSnapshot), and now `.index()` (read directly — see ShapeLayer.tsx's
// CONSUMPTION NOTE), plus `.editor.doc.subscribe` (useDocSnapshot's subscribe
// function) — `hitTestTopmost`/`queryMarquee`/`dispose` are never called by
// the renderer. renderToStaticMarkup never invokes useSyncExternalStore's
// `subscribe` at all (a plain synchronous server render has no later
// update to detect — subscribe is a CLIENT concern), so a no-op stub
// satisfies every path this test actually exercises. Building a REAL
// Editor/ToolContext here would require @ensembleworks/canvas-doc, which is
// NOT a declared dependency of canvas-react (by design — see boundary.test.ts)
// and would only resolve today via bun's workspace hoisting, an
// implementation detail this test correctly declines to lean on. `index()`
// is faked with a plain (un-cached) buildSpatialIndex(snapshot) call — this
// test doesn't probe tool-context.ts's rebuild cadence (that's
// tool-context.test.ts's job); it only needs a real SpatialIndex over the
// SAME snapshot so ShapeLayer's queryViewport culling produces correct
// results.
function fakeToolContext(snapshot: CanvasDocument, texts: ReadonlyMap<string, string> = new Map()): ToolContext {
  const editor = {
    doc: { subscribe: (_listener: () => void) => () => {}, getText: (id: string) => texts.get(id) ?? '' },
    get: (): EditorState => editorState,
    subscribe: (_listener: () => void) => () => {},
  } as unknown as Editor
  return {
    editor,
    snapshot: () => snapshot,
    index: () => buildSpatialIndex(snapshot),
    hitTestTopmost: () => null,
    queryMarquee: () => [],
    dispose: () => {},
  }
}

// ============================================================================
// 1. A rotated ROOT shape's body carries the hand-computed rigid transform
//    string. No parent composition involved — the expected transform is
//    exactly the shape's own (x, y, rotation).
// ============================================================================
{
  const expected = `translate(${rootRotated.x}px, ${rootRotated.y}px) rotate(${rootRotated.rotation}rad)`
  assert.equal(shapeBodyTransform(doc, rootRotated), expected, 'shapeBodyTransform for a root (unparented) shape is just its own x/y/rotation')

  const html = renderToStaticMarkup(createElement(ShapeBody, { shape: rootRotated, snapshot: doc, editorState }))
  assert.ok(html.includes(expected), `rendered ShapeBody HTML should contain "${expected}": ${html}`)
  console.log('ok: rotated root shape — hand-computed transform, rendered verbatim')
}

// ============================================================================
// 2. A shape NESTED under a rotated parent: transform COMPOSES the chain.
//    Hand-computed independently here (re-deriving geometry.ts's documented
//    composeTransform rule directly — "rotations add; position orbits" —
//    rather than calling worldTransform), then cross-checked against BOTH
//    worldTransform (canvas-model) and the rendered component.
// ============================================================================
{
  // composeTransform(parent, local): rotated = rotate(local.xy, parent.rotation);
  // result = { x: parent.x + rotated.x, y: parent.y + rotated.y, rotation: parent.rotation + local.rotation }
  const cos = Math.cos(rotatedParent.rotation), sin = Math.sin(rotatedParent.rotation)
  const rotatedLocal = { x: nestedChild.x * cos - nestedChild.y * sin, y: nestedChild.x * sin + nestedChild.y * cos }
  const expectedWorld = {
    x: rotatedParent.x + rotatedLocal.x,
    y: rotatedParent.y + rotatedLocal.y,
    rotation: rotatedParent.rotation + nestedChild.rotation,
  }

  // Cross-check against canvas-model's own worldTransform — independent
  // hand math above and the library function must agree.
  const viaLibrary = worldTransform(doc, nestedChild)
  assert.ok(
    Math.abs(viaLibrary.x - expectedWorld.x) < 1e-9 && Math.abs(viaLibrary.y - expectedWorld.y) < 1e-9 && Math.abs(viaLibrary.rotation - expectedWorld.rotation) < 1e-9,
    `hand-computed composed transform should match worldTransform: hand=${JSON.stringify(expectedWorld)} lib=${JSON.stringify(viaLibrary)}`,
  )

  const expectedCss = `translate(${expectedWorld.x}px, ${expectedWorld.y}px) rotate(${expectedWorld.rotation}rad)`
  assert.equal(shapeBodyTransform(doc, nestedChild), expectedCss, 'shapeBodyTransform composes the parent chain, matching the hand-computed composition')

  const html = renderToStaticMarkup(createElement(ShapeBody, { shape: nestedChild, snapshot: doc, editorState }))
  assert.ok(html.includes(expectedCss), `rendered nested ShapeBody HTML should contain "${expectedCss}": ${html}`)
  console.log('ok: nested shape under a rotated parent — composition hand-computed AND cross-checked, rendered verbatim')
}

// ============================================================================
// 3. Culling: ShapeLayer, given a normal viewport, renders the two visible
//    shapes and OMITS the huge off-viewport shape entirely (no
//    data-shape-id for it anywhere in the output).
// ============================================================================
{
  const toolContext = fakeToolContext(doc)
  const camera = { x: 0, y: 0, z: 1 }
  const html = renderToStaticMarkup(createElement(ShapeLayer, { toolContext, camera, viewportSize: { width: 800, height: 600 } }))
  assert.ok(html.includes(`data-shape-id="${rootRotated.id}"`), 'rootRotated should be visible')
  assert.ok(html.includes(`data-shape-id="${rotatedParent.id}"`), 'rotatedParent should be visible')
  assert.ok(html.includes(`data-shape-id="${nestedChild.id}"`), 'nestedChild should be visible')
  assert.ok(!html.includes(`data-shape-id="${hugeOffViewport.id}"`), 'hugeOffViewport should be CULLED — absent from the rendered output entirely')
  console.log('ok: ShapeLayer culls the off-viewport shape and renders the rest')
}

// ============================================================================
// 4. Registry: an unregistered kind falls back to BoxShape; a subsequent
//    registerShape() call for that SAME kind replaces the rendered
//    component (registry override).
// ============================================================================
{
  const before = renderToStaticMarkup(createElement(ShapeBody, { shape: rootRotated, snapshot: doc, editorState }))
  assert.match(before, /data-shape-body="box"/, 'unregistered kind (geo, nothing registered for it yet) falls back to BoxShape')

  function CustomGeoShape(_props: ShapeBodyProps) {
    return createElement('div', { 'data-shape-body': 'custom-geo' })
  }
  registerShape('geo', CustomGeoShape)

  const after = renderToStaticMarkup(createElement(ShapeBody, { shape: rootRotated, snapshot: doc, editorState }))
  assert.match(after, /data-shape-body="custom-geo"/, 'registerShape overrides the component for subsequent renders')
  assert.doesNotMatch(after, /data-shape-body="box"/, 'the BoxShape fallback no longer renders once overridden')
  console.log('ok: shapeRegistry — unregistered-kind fallback to BoxShape, then registerShape overrides it')
}

// ============================================================================
// 5. Live text rendering (the closed review gap — shapeRegistry.ts's
//    ShapeBodyProps.getText / BoxShape.tsx's labelOf): a text-capable kind
//    with LIVE doc text renders that text, NOT the kind-string fallback —
//    proving ShapeLayer actually threads toolContext.editor.doc.getText down
//    to the rendered body, end to end. A FRESH note-kind fixture (not
//    `rootRotated`/geo — case 4 above already `registerShape('geo', …)`
//    overrode geo's component for the rest of this file's module-level
//    registry, so geo would no longer hit BoxShape's labelOf here; note is
//    unregistered and also text-capable, per canvas-model's
//    isTextCapableKind, so it's the honest choice for this case).
// ============================================================================
{
  const noteShape: Shape = {
    id: 'shape:note1', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  } as Shape
  const noteDoc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [noteShape], bindings: [] })
  const texts = new Map([[noteShape.id, 'hello from the doc']])
  const toolContext = fakeToolContext(noteDoc, texts)
  const camera = { x: 0, y: 0, z: 1 }
  const html = renderToStaticMarkup(createElement(ShapeLayer, { toolContext, camera, viewportSize: { width: 800, height: 600 } }))
  assert.ok(html.includes('hello from the doc'), `ShapeLayer should render live doc text for a text-capable kind: ${html}`)
  console.log('ok: ShapeLayer threads live doc text (getText) down to a text-capable shape body')
}

// ============================================================================
// 6. dispatch threading (Task D2 — mirrors case 5's getText proof): ShapeBody
//    forwards a `dispatch` prop straight to the resolved component
//    unchanged, ShapeLayer forwards its own `dispatch` prop down to every
//    ShapeBody it renders, and a component that CALLS `dispatch([...])`
//    reaches all the way to `editor.applyAll` — proving the wiring a D3-D5
//    embed will actually rely on to persist a change, not just that a prop
//    of the right shape was passed around.
// ============================================================================
{
  const dispatchCalls: Intent[][] = []
  const fakeEditor = { applyAll: (intents: readonly Intent[]) => dispatchCalls.push([...intents]) }
  const dispatch = (intents: Intent[]) => fakeEditor.applyAll(intents)

  function DispatchProbe({ shape, dispatch: d }: ShapeBodyProps) {
    d?.([{ type: 'UpdateProps', id: shape.id, props: { touched: true } }])
    return createElement('div', { 'data-dispatch-probe': shape.id, 'data-has-dispatch': typeof d === 'function' })
  }
  // 'draw' — a real ShapeKind (canvas-model/shape.ts's SHAPE_KINDS) that is
  // otherwise unregistered/untouched by this file's earlier cases, so
  // registering it here can't collide with case 4's 'geo' override.
  registerShape('draw', DispatchProbe)

  const probeShape: Shape = {
    id: 'shape:probe1', kind: 'draw', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  }

  // 6a. ShapeBody forwards dispatch straight to the resolved component.
  const bodyHtml = renderToStaticMarkup(createElement(ShapeBody, { shape: probeShape, snapshot: doc, editorState, dispatch }))
  assert.match(bodyHtml, /data-has-dispatch="true"/, 'ShapeBody forwards its dispatch prop to the resolved component')
  console.log('ok: ShapeBody forwards dispatch to the resolved component')

  // 6b. ShapeLayer threads its own dispatch prop down to every ShapeBody it renders.
  const probeDoc: CanvasDocument = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [probeShape], bindings: [] })
  const toolContext = fakeToolContext(probeDoc)
  const camera = { x: 0, y: 0, z: 1 }
  const layerHtml = renderToStaticMarkup(
    createElement(ShapeLayer, { toolContext, camera, viewportSize: { width: 800, height: 600 }, dispatch }),
  )
  assert.match(layerHtml, /data-has-dispatch="true"/, 'ShapeLayer threads dispatch down to its ShapeBody children')
  console.log('ok: ShapeLayer threads dispatch down to ShapeBody')

  // 6c. Calling dispatch([...]) from within the rendered component reaches
  //     editor.applyAll — the exact same wiring shape CanvasV2App builds
  //     (`useCallback((intents) => editor.applyAll(intents), [editor])`).
  assert.equal(dispatchCalls.length, 2, 'dispatch was invoked once per render above (ShapeBody direct render + ShapeLayer render)')
  assert.deepEqual(
    dispatchCalls[0],
    [{ type: 'UpdateProps', id: probeShape.id, props: { touched: true } }],
    'the exact intents passed to dispatch() reach editor.applyAll unchanged',
  )
  console.log('ok: dispatch([...intents]) called from a shape body reaches editor.applyAll')
}

// ============================================================================
// 7. PAINT ORDER (Task F1 finding): a shape's DOM position among its
//    `position: absolute` siblings IS its paint order (ShapeBody.tsx's FLAT
//    SIBLINGS design — later DOM nodes paint on top). ShapeLayer renders
//    `queryViewport`'s result directly, and queryViewport answers from a
//    spatial hash grid whose iteration order has NO relationship to
//    document/z order — it can (and, discovered via the Seam-F parity
//    harness's real multi-shape fixture, DOES) return a frame's own id
//    AFTER one of its children's, which — since a frame body is a real,
//    fully-opaque `#ffffff` rect (FrameShape.tsx's v1-matched GROUNDING, not
//    a bug in itself) — visually erases that child. Constructing the doc
//    with the CHILD listed before its PARENT in `shapes` (so a
//    naive/unsorted render would very likely emit the child first) and
//    asserting the render output nonetheless places the parent's
//    `data-shape-id` EARLIER in the HTML than the child's proves
//    `orderParentBeforeChild` (canvas-editor, reused here) is actually
//    wired in, not just imported.
// ============================================================================
{
  const paintFrame: Shape = {
    id: 'shape:paint-frame', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: { w: 400, h: 400, name: 'Paint' },
  } as Shape
  const paintChild: Shape = {
    id: 'shape:paint-child', kind: 'note', parentId: paintFrame.id, index: 'a1', x: 10, y: 10, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  } as Shape
  // Child FIRST in the shapes array/spatial index build order — the
  // arrangement most likely to reproduce the pre-fix bug if the sort were
  // ever removed.
  const paintDoc: CanvasDocument = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [paintChild, paintFrame],
    bindings: [],
  })
  const toolContext = fakeToolContext(paintDoc)
  const camera = { x: 0, y: 0, z: 1 }
  const html = renderToStaticMarkup(createElement(ShapeLayer, { toolContext, camera, viewportSize: { width: 800, height: 600 } }))
  const frameAt = html.indexOf(`data-shape-id="${paintFrame.id}"`)
  const childAt = html.indexOf(`data-shape-id="${paintChild.id}"`)
  assert.ok(frameAt >= 0 && childAt >= 0, 'both the frame and its child should render')
  assert.ok(frameAt < childAt, `the frame must render (and thus paint) BEFORE its child regardless of queryViewport's return order: frameAt=${frameAt} childAt=${childAt}`)
  console.log('ok: ShapeLayer paints parent-before-child (orderParentBeforeChild) even when the spatial index returns the child first')
}

console.log('ok: shape-layer (rigid-transform positioning, flat-sibling composition, culling, registry fallback/override, live text, dispatch threading, paint order)')
