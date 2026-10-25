// Run: bun src/shapes/draw-shape.test.ts
// Task R1 — the `draw` body: a filled freehand-ink outline (G1-G3's
// getStrokePath), replacing the BoxShape fallback. Component tests use
// renderToStaticMarkup (no DOM emulator) with React.createElement, not JSX,
// so this file stays `.test.ts` — same convention as note/frame/text/
// geo-shape.test.ts.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { getStrokePath, strokeOptionsForSize } from '@ensembleworks/canvas-model'
import { DrawShape } from './DrawShape.js'
import { GEO_COLORS } from './GeoShape.js'
import { BoxShape } from './BoxShape.js'
import { lookupShapeComponent } from '../shapeRegistry.js'
import { registerCoreShapes } from './registerCoreShapes.js'

function drawShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:draw1',
    kind: 'draw',
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

function render(shape: Shape) {
  return renderToStaticMarkup(
    createElement(DrawShape, { shape, snapshot: undefined as any, editorState: undefined as any }),
  )
}

const THREE_POINTS = [
  { x: 0, y: 0, z: 0.5 },
  { x: 10, y: 8, z: 0.7 },
  { x: 20, y: 2, z: 0.3 },
]

// ============================================================================
// 1. A real multi-point segment renders a filled <path> (perfect-freehand
//    outline, not a stroked centerline) whose `d` matches G3's getStrokePath
//    verbatim, and whose fill is the resolved color's solid hex (GEO_COLORS,
//    reused from GeoShape.tsx — not re-copied). RED before implementation:
//    the stub (or the unregistered-kind fallback) renders no <path> at all.
// ============================================================================
{
  const shape = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }], color: 'blue', size: 'm', isPen: false } })
  const html = render(shape)
  assert.ok(html.includes('data-shape-body="draw"'), 'DrawShape is tagged data-shape-body="draw"')

  const match = html.match(/<path[^>]*d="([^"]*)"[^>]*>/)
  assert.ok(match, `expected a <path> with a non-empty d in: ${html}`)
  const d = match![1]!
  assert.ok(d.startsWith('M'), `path d should start with M (getSvgPathFromOutline), got: ${d}`)
  assert.ok(d.length > 10, `path d should be a non-trivial outline, got: ${d}`)

  const expected = getStrokePath(THREE_POINTS, strokeOptionsForSize('m', false))
  assert.equal(d, expected, 'DrawShape\'s path is EXACTLY getStrokePath(flattenedPoints, strokeOptionsForSize(size, isPen)) — no extra transform/scaling applied')

  assert.ok(html.includes(`fill="${GEO_COLORS.blue!.solid}"`), `path fill should be blue's solid hex ${GEO_COLORS.blue!.solid}, got: ${html}`)
  assert.ok(!html.includes('stroke='), 'a freehand stroke is a FILLED outline, not a stroked centerline — no stroke attribute')
  console.log('ok: DrawShape — multi-point segment renders a filled <path> matching getStrokePath exactly, fill = color solid hex')
}

// ============================================================================
// 2. Color: props.color drives the path's fill via GeoShape's exported
//    GEO_COLORS (reused, not duplicated) — same tolerant guard, 'black'
//    default for an absent/unrecognized color.
// ============================================================================
{
  const red = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }], color: 'red' } })
  assert.ok(render(red).includes(`fill="${GEO_COLORS.red!.solid}"`), `color:'red' should fill with ${GEO_COLORS.red!.solid}`)

  const missing = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }] } })
  assert.ok(render(missing).includes(`fill="${GEO_COLORS.black!.solid}"`), 'an absent color prop defaults to black, same as GeoShape')

  const bogus = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }], color: 'chartreuse' } })
  assert.ok(render(bogus).includes(`fill="${GEO_COLORS.black!.solid}"`), 'an unrecognized color falls back to black, same as GeoShape')
  console.log('ok: DrawShape — props.color resolves fill via GEO_COLORS, black default')
}

// ============================================================================
// 3. Size: props.size (via strokeOptionsForSize) widens the outline — a
//    larger size must NOT produce the identical path as a smaller one for
//    the same points (a constant-width mutant is caught here).
// ============================================================================
{
  const small = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }], size: 's' } })
  const large = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }], size: 'xl' } })
  const smallHtml = render(small)
  const largeHtml = render(large)
  const smallD = smallHtml.match(/<path[^>]*d="([^"]*)"/)![1]
  const largeD = largeHtml.match(/<path[^>]*d="([^"]*)"/)![1]
  assert.notEqual(smallD, largeD, 'props.size must change the outline path (s vs xl) — a constant-width implementation is wrong')

  const expectedLarge = getStrokePath(THREE_POINTS, strokeOptionsForSize('xl', false))
  assert.equal(largeD, expectedLarge, 'size xl path matches strokeOptionsForSize(\'xl\', isPen) exactly')
  console.log('ok: DrawShape — props.size changes the rendered outline via strokeOptionsForSize')
}

// ============================================================================
// 4. No scaling viewBox: unlike GeoShape (which scales a fixed viewBox to
//    w x h), a draw shape's points are ALREADY in local (shape-space =
//    screen-pixel) coordinates — D-4's "1:1 local coordinates" decision. The
//    rendered <svg> must carry no viewBox attribute (a scaling viewBox on
//    already-local points would double-transform them).
// ============================================================================
{
  const shape = drawShape({ props: { segments: [{ type: 'free', points: THREE_POINTS }] } })
  const html = render(shape)
  assert.ok(!html.includes('viewBox'), `DrawShape's <svg> must not carry a viewBox (points are already 1:1 local coords), got: ${html}`)
  assert.ok(html.includes('overflow:visible') || html.includes('overflow: visible'), 'the <svg> must allow overflow (a stroke can extend beyond the shape bbox by ~radius)')
  console.log('ok: DrawShape — renders at 1:1 local coordinates, no scaling viewBox, overflow:visible')
}

// ============================================================================
// 5. The v1 base64 `path`-only case (M1's finding, canvas-model/src/shape.ts's
//    drawSegment comment): a synced v1 draw shape's segment carries
//    `{type, path: <base64>}`, no `points`. Decoding that format is deferred
//    (documented — see DrawShape.tsx's module header): a path-only segment
//    contributes NO points, so the shape renders its wrapper div with NO
//    <path> child at all — degraded, but never a crash / NaN.
// ============================================================================
{
  const v1Shape = drawShape({ props: { segments: [{ type: 'free', path: 'YmFzZTY0LWVuY29kZWQ=' }] } })
  const html = render(v1Shape)
  assert.ok(html.includes('data-shape-body="draw"'), 'a path-only (v1) draw shape still renders its wrapper')
  assert.ok(!html.includes('<path'), 'a path-only (v1) segment contributes no points -> no <path> element (documented defer, not a crash)')
  console.log('ok: DrawShape — a v1 base64 path-only segment renders degraded (no <path>), never a crash')
}

// ============================================================================
// 6. Degenerate inputs: absent/empty segments and a single-point segment
//    never throw and never emit NaN into the path data.
// ============================================================================
{
  const noProps = drawShape({ props: {} })
  assert.doesNotThrow(() => render(noProps), 'a draw shape with no segments at all must not throw')
  assert.ok(!render(noProps).includes('<path'), 'no segments -> no <path> element')

  const emptySegments = drawShape({ props: { segments: [] } })
  assert.doesNotThrow(() => render(emptySegments), 'an empty segments array must not throw')

  const emptyPoints = drawShape({ props: { segments: [{ type: 'free', points: [] }] } })
  assert.doesNotThrow(() => render(emptyPoints), 'a segment with an empty points array must not throw')
  assert.ok(!render(emptyPoints).includes('<path'), 'zero points -> no <path> element')

  const onePoint = drawShape({ props: { segments: [{ type: 'free', points: [{ x: 5, y: 5, z: 0.5 }] }] } })
  assert.doesNotThrow(() => render(onePoint), 'a single-point segment (a dot) must not throw')
  const oneHtml = render(onePoint)
  assert.ok(!oneHtml.includes('NaN'), `a single-point stroke must not emit NaN into the path: ${oneHtml}`)
  console.log('ok: DrawShape — absent/empty/single-point segments never throw and never emit NaN')
}

// ============================================================================
// 7. Registration: lookupShapeComponent('draw') falls back to BoxShape
//    before this task registers DrawShape, and resolves to DrawShape (never
//    BoxShape) after registerCoreShapes(). This is the RED this task's Step 1
//    pins — forgetting to register 'draw' leaves this assertion failing.
// ============================================================================
{
  registerCoreShapes()
  const resolved = lookupShapeComponent('draw')
  assert.equal(resolved, DrawShape, '\'draw\' must resolve to DrawShape after registerCoreShapes()')
  assert.notEqual(resolved, BoxShape, '\'draw\' must NOT fall back to BoxShape after registerCoreShapes()')
  console.log('ok: DrawShape — registered in registerCoreShapes(), lookupShapeComponent(\'draw\') resolves to it, not BoxShape')
}

console.log('ok: draw-shape (filled freehand outline body, color/size honored, no scaling viewBox, v1 path-only degrades without crashing, registered)')
