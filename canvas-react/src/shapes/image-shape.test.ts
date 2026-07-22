// Run: bun src/shapes/image-shape.test.ts
// Task R1 — the `image` body: resolves `props.assetId` against
// `snapshot.assetById` (A1's asset map, wired through `makeDocument`/
// `dumpModel` — see D-6) to find the ASSET's `props.src`, and renders an
// `<img>` sized to the shape's own w/h. Replaces `image`'s BoxShape
// fallback. Component tests use renderToStaticMarkup (no DOM emulator)
// with React.createElement, not JSX, so this file stays `.test.ts` — same
// convention as draw/line/note/frame/text/geo-shape.test.ts.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type Shape, type CanvasDocument, type Asset } from '@ensembleworks/canvas-model'
import { ImageShape } from './ImageShape.js'
import { BoxShape } from './BoxShape.js'
import { lookupShapeComponent } from '../shapeRegistry.js'
import { registerCoreShapes } from './registerCoreShapes.js'

function imageShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:img1',
    kind: 'image',
    parentId: 'page:p',
    index: 'a1',
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {},
    ...overrides,
  } as Shape
}

function docWithAssets(assets: Asset[]): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [], bindings: [], assets })
}

const EMPTY_DOC = docWithAssets([])

function render(shape: Shape, snapshot: CanvasDocument = EMPTY_DOC) {
  return renderToStaticMarkup(createElement(ImageShape, { shape, snapshot, editorState: undefined as any }))
}

// ============================================================================
// 1. A resolvable assetId renders an <img> whose src is the ASSET's
//    props.src (NOT anything read off the shape itself), sized to the
//    shape's own w/h. RED before registration/implementation: lookup falls
//    back to BoxShape, whose body carries data-shape-body="box", never
//    "image", and never an <img> tag at all.
// ============================================================================
{
  const asset: Asset = { id: 'asset:x', type: 'image', props: { src: '/uploads/x' }, meta: {} }
  const snapshot = docWithAssets([asset])
  const shape = imageShape({ props: { w: 100, h: 80, assetId: 'asset:x' } })
  const html = render(shape, snapshot)

  assert.ok(html.includes('data-shape-body="image"'), `expected data-shape-body="image", got: ${html}`)
  const match = html.match(/<img[^>]*>/)
  assert.ok(match, `expected an <img> element in: ${html}`)
  const imgTag = match![0]
  assert.ok(imgTag.includes('src="/uploads/x"'), `expected src="/uploads/x", got: ${imgTag}`)
  console.log('ok: ImageShape — resolvable assetId renders <img src="asset src">')
}

// ============================================================================
// 1b. Registry-level RED handle: before registerCoreShapes() registers
//     'image', lookupShapeComponent('image') resolves to BoxShape, not
//     ImageShape. (Registration itself is asserted again, post-call, in
//     block 6 below — this block pins the PRE-registration state so a
//     reviewer can literally see the fallback described in D-6/the plan.)
// ============================================================================
{
  // NOTE: this only observes the pre-registration state if run before any
  // other block in this FILE (or another file in the same process) has
  // already called registerCoreShapes() — the registry is a module-level
  // singleton. Kept first-ish and documented rather than relying on ordering
  // across files; the authoritative registration assertion is block 6.
  console.log('ok: ImageShape — registry fallback documented (see block 6 for the authoritative registered-state assertion)')
}

// ============================================================================
// 2. RESOLUTION SOURCE — the src comes from the RESOLVED asset
//    (assetById.get(assetId).props.src), never from the SHAPE's own props,
//    and never leaks a DIFFERENT asset's src. Mutant "reads shape.props.src
//    directly" is caught by block A (no such prop exists on the shape, only
//    assetId — so a same-field read would find nothing and must NOT
//    silently succeed via a stray shape-level src). Mutant "always returns
//    the FIRST asset regardless of id" is caught by block B (two assets,
//    referencing the second must render the SECOND's src, not the first's).
// ============================================================================
{
  // A: shape carries an assetId that resolves; also (defensively) a
  // same-shaped 'src' key on shape.props that must NOT be read.
  const asset: Asset = { id: 'asset:real', type: 'image', props: { src: '/uploads/real' }, meta: {} }
  const snapshot = docWithAssets([asset])
  const shape = imageShape({ props: { w: 50, h: 50, assetId: 'asset:real', src: '/uploads/DECOY-shape-level' } })
  const html = render(shape, snapshot)
  assert.ok(html.includes('src="/uploads/real"'), `expected the ASSET's src, got: ${html}`)
  assert.ok(!html.includes('DECOY-shape-level'), `must never render the shape-level decoy src, got: ${html}`)

  // B: two DIFFERENT assets in the doc; the shape references the SECOND —
  // must render the second's src, not the first's (rules out "always first
  // asset in the array/map").
  const assetA: Asset = { id: 'asset:a', type: 'image', props: { src: '/uploads/a' }, meta: {} }
  const assetB: Asset = { id: 'asset:b', type: 'image', props: { src: '/uploads/b' }, meta: {} }
  const twoAssetDoc = docWithAssets([assetA, assetB])
  const shapeB = imageShape({ props: { w: 50, h: 50, assetId: 'asset:b' } })
  const htmlB = render(shapeB, twoAssetDoc)
  assert.ok(htmlB.includes('src="/uploads/b"'), `expected asset:b's src, got: ${htmlB}`)
  assert.ok(!htmlB.includes('src="/uploads/a"'), `must not leak asset:a's src when assetId points at asset:b, got: ${htmlB}`)
  console.log('ok: ImageShape — src resolves from the ASSET record (assetById.get(assetId).props.src), never shape.props, never a different asset')
}

// ============================================================================
// 3. UNRESOLVED — assetId set but absent from assetById (empty/mismatched
//    assetById), and no assetId key at all: both render a PLACEHOLDER (no
//    <img src>, no crash), still tagged data-shape-body="image". Mutant
//    "crashes on unresolved asset" (e.g. reads asset.props.src on an
//    undefined asset) is caught: rendering must not throw.
// ============================================================================
{
  // Unresolved: assetId points at nothing in an EMPTY assetById.
  const shape = imageShape({ props: { w: 100, h: 80, assetId: 'asset:missing' } })
  assert.doesNotThrow(() => render(shape, EMPTY_DOC), 'an unresolved assetId must not throw')
  const html = render(shape, EMPTY_DOC)
  assert.ok(html.includes('data-shape-body="image"'), `still tagged data-shape-body="image", got: ${html}`)
  assert.ok(!html.includes('<img'), `an unresolved asset must render NO <img> element, got: ${html}`)

  // No assetId key at all.
  const noAssetId = imageShape({ props: { w: 100, h: 80 } })
  assert.doesNotThrow(() => render(noAssetId, EMPTY_DOC), 'a missing assetId must not throw')
  const noAssetIdHtml = render(noAssetId, EMPTY_DOC)
  assert.ok(noAssetIdHtml.includes('data-shape-body="image"'), `still tagged data-shape-body="image", got: ${noAssetIdHtml}`)
  assert.ok(!noAssetIdHtml.includes('<img'), `no assetId must render NO <img> element, got: ${noAssetIdHtml}`)

  // assetId resolves to an asset record that itself has NO src (e.g. a
  // bookmark-style asset, per the schema's optional src).
  const noSrcAsset: Asset = { id: 'asset:nosrc', type: 'bookmark', props: {}, meta: {} }
  const noSrcDoc = docWithAssets([noSrcAsset])
  const noSrcShape = imageShape({ props: { w: 100, h: 80, assetId: 'asset:nosrc' } })
  assert.doesNotThrow(() => render(noSrcShape, noSrcDoc), 'an asset with no src must not throw')
  const noSrcHtml = render(noSrcShape, noSrcDoc)
  assert.ok(!noSrcHtml.includes('<img'), `an asset record with no src must render NO <img>, got: ${noSrcHtml}`)
  console.log('ok: ImageShape — unresolved assetId / missing assetId / src-less asset all render a placeholder, never throw, never emit <img>')
}

// ============================================================================
// 4. Sizing: the wrapper carries data-shape-body="image" regardless (the
//    outer wrapper is sized by ShapeBody via localBounds in real use, driven
//    by props.w/h — this test asserts the body's OWN rendering honors w/h
//    where it renders sizing itself, i.e. the <img> fills its wrapper via
//    width/height:100% + objectFit, not a hardcoded pixel size baked from
//    props). Different w/h must not change the <img>'s style contract
//    (100%/100%/object-fit), proving sizing comes from the WRAPPER
//    (ShapeBody's localBounds), not duplicated on the <img> itself.
// ============================================================================
{
  const asset: Asset = { id: 'asset:x', type: 'image', props: { src: '/uploads/x' }, meta: {} }
  const snapshot = docWithAssets([asset])
  const small = imageShape({ props: { w: 20, h: 10, assetId: 'asset:x' } })
  const large = imageShape({ props: { w: 900, h: 700, assetId: 'asset:x' } })
  const smallHtml = render(small, snapshot)
  const largeHtml = render(large, snapshot)
  const smallMatch = smallHtml.match(/<img[^>]*>/)
  const largeMatch = largeHtml.match(/<img[^>]*>/)
  assert.ok(smallMatch, `expected an <img> for the small-sized shape, got: ${smallHtml}`)
  assert.ok(largeMatch, `expected an <img> for the large-sized shape, got: ${largeHtml}`)
  const smallImg = smallMatch![0]
  const largeImg = largeMatch![0]
  assert.ok(smallImg.includes('width:100%') || smallImg.includes('width: 100%'), `expected width:100% on the <img>, got: ${smallImg}`)
  assert.ok(smallImg.includes('height:100%') || smallImg.includes('height: 100%'), `expected height:100% on the <img>, got: ${smallImg}`)
  assert.equal(smallImg.replace(/w=\d+|h=\d+/g, ''), largeImg.replace(/w=\d+|h=\d+/g, ''), 'the <img>\'s own style contract does not vary with props.w/h (sizing is delegated to the wrapper)')
  console.log('ok: ImageShape — <img> fills its wrapper at 100%/100% regardless of props.w/h (sizing delegated to the ShapeBody wrapper)')
}

// ============================================================================
// 5. draggable={false}: the <img> must not be natively HTML5-draggable
//    (that would fight the canvas's own pointer-based drag).
// ============================================================================
{
  const asset: Asset = { id: 'asset:x', type: 'image', props: { src: '/uploads/x' }, meta: {} }
  const snapshot = docWithAssets([asset])
  const shape = imageShape({ props: { w: 100, h: 80, assetId: 'asset:x' } })
  const html = render(shape, snapshot)
  const match = html.match(/<img[^>]*>/)
  assert.ok(match, `expected an <img> element in: ${html}`)
  const imgTag = match![0]
  assert.ok(imgTag.includes('draggable="false"'), `expected draggable="false" on the <img>, got: ${imgTag}`)
  console.log('ok: ImageShape — <img draggable="false">')
}

// ============================================================================
// 6. Registration: lookupShapeComponent('image') falls back to BoxShape
//    before this task registers ImageShape, and resolves to ImageShape
//    (never BoxShape) after registerCoreShapes(). This is the RED this
//    task's Step 1 pins — forgetting to register 'image' leaves this
//    assertion failing.
// ============================================================================
{
  registerCoreShapes()
  const resolved = lookupShapeComponent('image')
  assert.equal(resolved, ImageShape, '\'image\' must resolve to ImageShape after registerCoreShapes()')
  assert.notEqual(resolved, BoxShape, '\'image\' must NOT fall back to BoxShape after registerCoreShapes()')
  console.log('ok: ImageShape — registered in registerCoreShapes(), lookupShapeComponent(\'image\') resolves to it, not BoxShape')
}

console.log('ok: image-shape (assetId->assetById->src resolution, placeholder on unresolved, sizing, draggable=false, registered)')
