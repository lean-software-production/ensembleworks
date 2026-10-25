// Run: bun src/shapes/line-shape.test.ts
// Task R1 — the `line` body: a STROKED SVG path (fill:none, stroke=color),
// replacing the BoxShape fallback. Component tests use renderToStaticMarkup
// (no DOM emulator) with React.createElement, not JSX, so this file stays
// `.test.ts` — same convention as draw/note/frame/text/geo-shape.test.ts.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { linePathData } from '@ensembleworks/canvas-model'
import { LineShape, flattenLinePoints } from './LineShape.js'
import { GEO_COLORS, STROKE_WIDTH_PX, dashArray } from './GeoShape.js'
import { BoxShape } from './BoxShape.js'
import { lookupShapeComponent } from '../shapeRegistry.js'
import { registerCoreShapes } from './registerCoreShapes.js'

function lineShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:line1',
    kind: 'line',
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
    createElement(LineShape, { shape, snapshot: undefined as any, editorState: undefined as any }),
  )
}

// A 3-point keyed map, key order MATCHING index order (a1 < a2 < a3).
const IN_ORDER_POINTS = {
  a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
  a2: { id: 'a2', index: 'a2', x: 10, y: 20 },
  a3: { id: 'a3', index: 'a3', x: 30, y: 30 },
}
const ORDERED_XY = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 30 }]

// ============================================================================
// 1. A real multi-point keyed-map line renders a STROKED <path> (fill:none,
//    stroke = resolved color hex, non-trivial `d` starting 'M'). RED before
//    implementation: the stub renders nothing (null), so no <path> at all.
// ============================================================================
{
  const shape = lineShape({ props: { points: IN_ORDER_POINTS, color: 'blue', spline: 'line' } })
  const html = render(shape)
  assert.ok(html.includes('data-shape-body="line"'), 'LineShape is tagged data-shape-body="line"')

  const match = html.match(/<path[^>]*d="([^"]*)"[^>]*>/)
  assert.ok(match, `expected a <path> with a non-empty d in: ${html}`)
  const d = match![1]!
  assert.ok(d.startsWith('M'), `path d should start with M, got: ${d}`)
  assert.ok(d.length > 5, `path d should be non-trivial, got: ${d}`)

  const expected = linePathData(ORDERED_XY, 'line')
  assert.equal(d, expected, 'LineShape\'s path is EXACTLY linePathData(flattenedOrderedPoints, spline)')

  assert.ok(html.includes('fill="none"'), 'a line is STROKED, not filled — the <path> must carry fill="none"')
  assert.ok(html.includes(`stroke="${GEO_COLORS.blue!.solid}"`), `path stroke should be blue's solid hex ${GEO_COLORS.blue!.solid}, got: ${html}`)
  console.log('ok: LineShape — 3-point keyed-map line renders a stroked <path> (fill:none, stroke=color) matching linePathData exactly')
}

// ============================================================================
// 2. CONVERGENCE CRUX — ordering: the keyed map's KEY insertion order does
//    NOT match the points' `index` order. flattenLinePoints must sort by
//    `index`, not Object.keys/values() insertion order. Mutant "uses
//    Object.values() order verbatim" is caught here: it would produce
//    M30,30 L0,0 L10,20 (insertion order z9,a1,m5) instead of the
//    index-ordered M0,0 L10,20 L30,30.
// ============================================================================
{
  const scrambledKeyOrder = {
    z9: { id: 'z9', index: 'a3', x: 30, y: 30 }, // inserted FIRST, index LAST
    a1: { id: 'a1', index: 'a1', x: 0, y: 0 }, // inserted SECOND, index FIRST
    m5: { id: 'm5', index: 'a2', x: 10, y: 20 }, // inserted THIRD, index MIDDLE
  }
  const shape = lineShape({ props: { points: scrambledKeyOrder, spline: 'line' } })
  const html = render(shape)
  const match = html.match(/<path[^>]*d="([^"]*)"[^>]*>/)
  assert.ok(match, `expected a <path> in: ${html}`)
  const d = match![1]!

  const expectedByIndex = linePathData(ORDERED_XY, 'line') // a1(0,0) -> a2(10,20) -> a3(30,30)
  assert.equal(d, expectedByIndex, 'path must follow INDEX order (a1,a2,a3), not key-insertion order (z9,a1,m5)')

  const wrongByKeyOrder = linePathData([{ x: 30, y: 30 }, { x: 0, y: 0 }, { x: 10, y: 20 }], 'line')
  assert.notEqual(d, wrongByKeyOrder, 'path must NOT match the key-insertion-order (z9,a1,m5) path')

  // Also exercise flattenLinePoints directly, in case a future refactor
  // bypasses it inside LineShape.
  const flattened = flattenLinePoints(shape)
  assert.deepEqual(flattened, ORDERED_XY, 'flattenLinePoints sorts by index, not map key/insertion order')
  console.log('ok: LineShape — flattenLinePoints/render follow INDEX order even when key order differs (convergence property)')
}

// ============================================================================
// 3. Color: props.color resolves stroke via GeoShape's exported GEO_COLORS
//    (reused, not duplicated) — same tolerant guard, 'black' default for an
//    absent/unrecognized color.
// ============================================================================
{
  const red = lineShape({ props: { points: IN_ORDER_POINTS, color: 'red' } })
  assert.ok(render(red).includes(`stroke="${GEO_COLORS.red!.solid}"`), `color:'red' should stroke with ${GEO_COLORS.red!.solid}`)

  const missing = lineShape({ props: { points: IN_ORDER_POINTS } })
  assert.ok(render(missing).includes(`stroke="${GEO_COLORS.black!.solid}"`), 'an absent color prop defaults to black, same as GeoShape/DrawShape')

  const bogus = lineShape({ props: { points: IN_ORDER_POINTS, color: 'chartreuse' } })
  assert.ok(render(bogus).includes(`stroke="${GEO_COLORS.black!.solid}"`), 'an unrecognized color falls back to black, same as GeoShape/DrawShape')
  console.log('ok: LineShape — props.color resolves stroke via GEO_COLORS, black default')
}

// ============================================================================
// 4. Dash: props.dash drives strokeDasharray via GeoShape's exported
//    dashArray/DASH_VALUES. Mutant "ignores dash" is caught: 'dashed' must
//    produce a dasharray attribute; the default ('draw') must not.
// ============================================================================
{
  const dashed = lineShape({ props: { points: IN_ORDER_POINTS, dash: 'dashed', size: 'm' } })
  const dashedHtml = render(dashed)
  const expectedDasharray = dashArray('dashed', STROKE_WIDTH_PX.m!)
  assert.ok(expectedDasharray, 'sanity: dashArray(\'dashed\', …) must be defined')
  assert.ok(dashedHtml.includes(`stroke-dasharray="${expectedDasharray}"`), `dash:'dashed' should render stroke-dasharray="${expectedDasharray}", got: ${dashedHtml}`)

  const solid = lineShape({ props: { points: IN_ORDER_POINTS } })
  assert.ok(!render(solid).includes('stroke-dasharray'), 'an absent/default dash must render NO stroke-dasharray attribute')
  console.log('ok: LineShape — props.dash drives strokeDasharray via dashArray/DASH_VALUES')
}

// ============================================================================
// 5. Size: props.size drives strokeWidth via GeoShape's exported
//    STROKE_WIDTH_PX. Mutant "constant strokeWidth" is caught: 's' and 'xl'
//    must render DIFFERENT stroke-width values.
// ============================================================================
{
  const small = lineShape({ props: { points: IN_ORDER_POINTS, size: 's' } })
  const large = lineShape({ props: { points: IN_ORDER_POINTS, size: 'xl' } })
  const smallHtml = render(small)
  const largeHtml = render(large)
  assert.ok(smallHtml.includes(`stroke-width="${STROKE_WIDTH_PX.s}"`), `size:'s' should render stroke-width="${STROKE_WIDTH_PX.s}", got: ${smallHtml}`)
  assert.ok(largeHtml.includes(`stroke-width="${STROKE_WIDTH_PX.xl}"`), `size:'xl' should render stroke-width="${STROKE_WIDTH_PX.xl}", got: ${largeHtml}`)
  assert.notEqual(STROKE_WIDTH_PX.s, STROKE_WIDTH_PX.xl, 'sanity: s and xl must be different widths in the table')
  console.log('ok: LineShape — props.size drives strokeWidth via STROKE_WIDTH_PX, non-constant')
}

// ============================================================================
// 6. Spline: 'cubic' renders a curved path (contains a `C` command); 'line'
//    (the default) renders a straight polyline (no `C`). Mutant "ignores
//    spline, always straight" is caught here.
// ============================================================================
{
  const straight = lineShape({ props: { points: IN_ORDER_POINTS, spline: 'line' } })
  const cubic = lineShape({ props: { points: IN_ORDER_POINTS, spline: 'cubic' } })
  const straightD = render(straight).match(/<path[^>]*d="([^"]*)"[^>]*>/)![1]!
  const cubicD = render(cubic).match(/<path[^>]*d="([^"]*)"[^>]*>/)![1]!
  assert.ok(!straightD.includes('C'), `spline:'line' must not contain a C command, got: ${straightD}`)
  assert.ok(cubicD.includes('C'), `spline:'cubic' must contain a C command, got: ${cubicD}`)
  assert.notEqual(straightD, cubicD, 'straight and cubic paths must differ for the same points')

  const expectedCubic = linePathData(ORDERED_XY, 'cubic')
  assert.equal(cubicD, expectedCubic, 'cubic path matches linePathData(points, \'cubic\') exactly')
  console.log('ok: LineShape — props.spline selects straight vs cubic path (linePathData)')
}

// ============================================================================
// 7. No scaling viewBox: like DrawShape, a line's points are ALREADY in
//    local (shape-space) coordinates — the <svg> must carry no viewBox and
//    must allow overflow (a v1 line has no normalized w/h).
// ============================================================================
{
  const shape = lineShape({ props: { points: IN_ORDER_POINTS } })
  const html = render(shape)
  assert.ok(!html.includes('viewBox'), `LineShape's <svg> must not carry a viewBox (points are already 1:1 local coords), got: ${html}`)
  assert.ok(html.includes('overflow:visible') || html.includes('overflow: visible'), 'the <svg> must allow overflow')
  console.log('ok: LineShape — renders at 1:1 local coordinates, no scaling viewBox, overflow:visible')
}

// ============================================================================
// 8. Degenerate inputs: empty/absent points, a single point, and a malformed
//    point (missing/non-number coordinate) never throw and never render a
//    <path> (fewer than 2 valid points has no visible segment).
// ============================================================================
{
  const noProps = lineShape({ props: {} })
  assert.doesNotThrow(() => render(noProps), 'a line shape with no points at all must not throw')
  const noPropsHtml = render(noProps)
  assert.ok(noPropsHtml.includes('data-shape-body="line"'), 'still renders the wrapper')
  assert.ok(!noPropsHtml.includes('<path'), 'no points -> no <path> element')

  const empty = lineShape({ props: { points: {} } })
  assert.doesNotThrow(() => render(empty), 'an empty points map must not throw')
  assert.ok(!render(empty).includes('<path'), 'zero points -> no <path> element')

  const onePoint = lineShape({ props: { points: { a1: { id: 'a1', index: 'a1', x: 5, y: 5 } } } })
  assert.doesNotThrow(() => render(onePoint), 'a single-point line must not throw')
  const oneHtml = render(onePoint)
  assert.ok(!oneHtml.includes('<path'), 'a single point has no visible segment -> no <path> element')
  assert.ok(!oneHtml.includes('NaN'), `a single-point line must not emit NaN: ${oneHtml}`)

  const malformed = lineShape({
    props: {
      points: {
        a1: { id: 'a1', index: 'a1', x: 0 }, // missing y
        a2: { id: 'a2', index: 'a2', x: 'nope', y: 5 }, // non-number x
        a3: { id: 'a3', index: 'a3', x: 10, y: 10 }, // the only valid point
      },
    },
  })
  assert.doesNotThrow(() => render(malformed), 'malformed points must not throw')
  const malformedHtml = render(malformed)
  assert.ok(!malformedHtml.includes('<path'), 'only 1 valid point survives the malformed map -> no <path>')
  assert.ok(!malformedHtml.includes('NaN'), `malformed points must not emit NaN: ${malformedHtml}`)
  console.log('ok: LineShape — empty/absent/single/malformed points never throw, never emit NaN, render no <path> below 2 valid points')
}

// ============================================================================
// 9. Registration: lookupShapeComponent('line') falls back to BoxShape
//    before this task registers LineShape, and resolves to LineShape (never
//    BoxShape) after registerCoreShapes(). This is the RED this task's Step 1
//    pins — forgetting to register 'line' leaves this assertion failing.
// ============================================================================
{
  registerCoreShapes()
  const resolved = lookupShapeComponent('line')
  assert.equal(resolved, LineShape, '\'line\' must resolve to LineShape after registerCoreShapes()')
  assert.notEqual(resolved, BoxShape, '\'line\' must NOT fall back to BoxShape after registerCoreShapes()')
  console.log('ok: LineShape — registered in registerCoreShapes(), lookupShapeComponent(\'line\') resolves to it, not BoxShape')
}

console.log('ok: line-shape (stroked path body, ordering/color/dash/size/spline honored, no scaling viewBox, degenerate-safe, registered)')
