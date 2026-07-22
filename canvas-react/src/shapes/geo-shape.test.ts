// Run: bun src/shapes/geo-shape.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts` (same convention as note/frame/text-shape.test.ts).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { GeoShape, geoStyle, geoVariant, geoLabel } from './GeoShape.js'

function geoShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:geo1',
    kind: 'geo',
    parentId: 'page:p',
    index: 'a1',
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 100, h: 100 },
    ...overrides,
  } as Shape
}

function render(shape: Shape, getText?: (id: string) => string) {
  return renderToStaticMarkup(createElement(GeoShape, { shape, snapshot: undefined as any, editorState: undefined as any, getText }))
}

// ============================================================================
// 1. geoVariant: the discriminator key is props.geo (GeoShapeGeoStyle,
//    the "tlschema" package's shapes/TLGeoShape.ts:40-59 — a StyleProp enum of 20
//    values: cloud/rectangle/ellipse/triangle/diamond/pentagon/hexagon/
//    octagon/star/rhombus/rhombus-2/oval/trapezoid/arrow-right/arrow-left/
//    arrow-up/arrow-down/x-box/check-box/heart, defaultValue 'rectangle').
//    canvas-model's geo props schema (canvas-model/src/shape.ts:47,
//    `geo: withText.extend(box.shape)`) does NOT name `geo` in its TYPED
//    fields — same passthrough situation as TextShape's font/size/textAlign
//    (withText is z.looseObject) — a real geo shape synced from v1 still
//    carries props.geo at runtime via the lossless converter
//    (server/src/canvas-v2/convert.ts's shapeFromRecord: `props: r.props ?? {}`).
// ============================================================================
{
  assert.equal(geoVariant(geoShape({ props: { geo: 'ellipse' } })), 'ellipse', 'geoVariant reads props.geo verbatim')
  assert.equal(geoVariant(geoShape({ props: {} })), 'rectangle', 'a geo shape with no geo prop defaults to v1s own default (rectangle), matching GeoShapeUtil.tsx getDefaultProps')
  console.log('ok: geoVariant — reads props.geo, defaulting to v1s "rectangle"')
}

// ============================================================================
// 2. SVG geometry per variant: non-rectangle variants render REAL SVG
//    elements sized to the shape's w/h (getGeoShapePath.ts's
//    defaultGeoTypeDefinitions — ellipse's arcTo path is an actual ellipse,
//    triangle/diamond are polygons through the exact vertices tldraw's own
//    getPath functions compute for a given w/h).
// ============================================================================
{
  const rect = geoShape({ props: { geo: 'rectangle', w: 120, h: 80 } })
  const rectHtml = render(rect)
  assert.ok(rectHtml.includes('<rect'), 'rectangle variant renders an <rect>')
  assert.ok(rectHtml.includes('width="120"') && rectHtml.includes('height="80"'), 'rectangle <rect> is sized to the shapes w/h')

  const ellipse = geoShape({ props: { geo: 'ellipse', w: 100, h: 60 } })
  const ellipseHtml = render(ellipse)
  assert.ok(ellipseHtml.includes('<ellipse'), 'ellipse variant renders a real <ellipse>, not a box')
  assert.ok(ellipseHtml.includes('cx="50"') && ellipseHtml.includes('cy="30"'), 'ellipse is centered on the shapes w/h (rx=w/2, ry=h/2 per getGeoShapePath.ts)')

  const triangle = geoShape({ props: { geo: 'triangle', w: 100, h: 100 } })
  const triangleHtml = render(triangle)
  assert.ok(triangleHtml.includes('<polygon'), 'triangle variant renders a <polygon>')
  assert.ok(triangleHtml.includes('50,0') && triangleHtml.includes('100,100') && triangleHtml.includes('0,100'), 'triangle vertices match getGeoShapePath.ts (apex at cx,0; base corners at w,h and 0,h)')

  const diamond = geoShape({ props: { geo: 'diamond', w: 100, h: 100 } })
  const diamondHtml = render(diamond)
  assert.ok(diamondHtml.includes('<polygon'), 'diamond variant renders a <polygon>')
  assert.ok(
    diamondHtml.includes('50,0') && diamondHtml.includes('100,50') && diamondHtml.includes('50,100') && diamondHtml.includes('0,50'),
    'diamond vertices match getGeoShapePath.ts (top/right/bottom/left midpoints)',
  )
  console.log('ok: GeoShape — rectangle/ellipse/triangle/diamond each render the right real SVG element/geometry, not always a box')
}

// ============================================================================
// 3. Unhandled variant falls back to a rectangle outline, never a crash.
// ============================================================================
{
  const star = geoShape({ props: { geo: 'star', w: 100, h: 100 } })
  const html = render(star)
  assert.ok(html.includes('<rect'), 'an unhandled geo variant (star) falls back to a plain rectangle outline, not a crash')
  console.log('ok: GeoShape — unhandled variant (star) falls back to a rectangle outline, documented, never a crash')
}

// ============================================================================
// 4. Stroke color: getColorValue(colors, color, 'solid') — the SAME
//    light-theme 'solid' hex table TextShape.tsx cites (defaultThemes.ts:
//    146-353), default color 'black' -> '#1d1d1d' (GeoShapeUtil.tsx's
//    getDefaultProps: color: 'black').
// ============================================================================
{
  const blue = geoStyle(geoShape({ props: { color: 'blue' } }))
  assert.equal(blue.strokeColor, '#4465e9', 'blue color -> v1s solid stroke hex #4465e9')

  const missing = geoStyle(geoShape({ props: {} }))
  assert.equal(missing.strokeColor, '#1d1d1d', 'a geo shape with no color prop defaults to v1s own default (black) -> #1d1d1d')
  console.log('ok: geoStyle — stroke color resolves via v1s solid variant, same 13-color table as TextShape')
}

// ============================================================================
// 4b. labelColor is an INDEPENDENT prop, defaulting to 'black' on its own
//     (GeoShapeUtil.tsx getDefaultProps: `labelColor: 'black'`), NOT to the
//     shape's own `color`. A blue geo with no labelColor renders a BLACK
//     label, not a blue one — a latent correctness bug caught in review.
// ============================================================================
{
  const blueNoLabelColor = geoStyle(geoShape({ props: { color: 'blue' } }))
  assert.equal(blueNoLabelColor.strokeColor, '#4465e9', 'stroke still follows props.color (blue)')
  assert.equal(blueNoLabelColor.labelColor, '#1d1d1d', 'label color defaults to black (#1d1d1d) INDEPENDENTLY of props.color — not blue')

  const explicitLabelColor = geoStyle(geoShape({ props: { color: 'blue', labelColor: 'red' } }))
  assert.equal(explicitLabelColor.labelColor, '#e03131', 'an explicit labelColor is honored (red -> #e03131)')
  console.log('ok: geoStyle — labelColor defaults to black independently of color, honors an explicit labelColor')
}

// ============================================================================
// 5. Fill behavior: fill:'none' -> no fill rendered at all; fill:'semi' ->
//    the FIXED near-white theme.colors.light.solid ('#fcfffe',
//    defaultThemes.ts:136) REGARDLESS of the shape's own color (a real
//    grounding surprise: GeoShapeUtil.tsx's getDefaultDisplayValues resolves
//    fill:'semi' to `colors.solid`, the theme-level field, NOT a per-color
//    tint); fill:'solid' -> getColorValue(colors, color, 'semi') — i.e. the
//    per-color PASTEL 'semi' variant (defaultFills.ts's
//    DEFAULT_FILL_COLOR_NAMES.solid === 'semi'), NOT the strong solid/stroke
//    hex. Default fill is 'none' (GeoShapeUtil.tsx getDefaultProps).
// ============================================================================
{
  const none = geoStyle(geoShape({ props: { fill: 'none', color: 'blue' } }))
  assert.equal(none.fillColor, null, 'fill:none renders no fill at all')

  const defaultFill = geoStyle(geoShape({ props: { color: 'blue' } }))
  assert.equal(defaultFill.fillColor, null, 'a geo shape with no fill prop defaults to v1s own default (none)')

  const semi = geoStyle(geoShape({ props: { fill: 'semi', color: 'blue' } }))
  assert.equal(semi.fillColor, '#fcfffe', 'fill:semi is the FIXED theme.colors.light.solid near-white, not a per-color tint')

  const semiRed = geoStyle(geoShape({ props: { fill: 'semi', color: 'red' } }))
  assert.equal(semiRed.fillColor, '#fcfffe', 'fill:semi is the SAME fixed hex regardless of color (red vs blue above)')

  const solidBlue = geoStyle(geoShape({ props: { fill: 'solid', color: 'blue' } }))
  assert.equal(solidBlue.fillColor, '#dce1f8', 'fill:solid resolves to the per-color pastel "semi" variant (#dce1f8 for blue), not the strong stroke hex #4465e9')
  console.log('ok: geoStyle — fill none/semi/solid match v1s exact (and non-obvious) getDefaultDisplayValues resolution')
}

// ============================================================================
// 5b. Size scaling: strokeWidth and label fontSize both scale up with
//     props.size (STROKE_SIZES/LABEL_FONT_SIZES * theme.strokeWidth/fontSize
//     — GeoShapeUtil.tsx getDefaultDisplayValues). Guards against a typo'd
//     multiplier silently regressing to a constant.
// ============================================================================
{
  const small = geoStyle(geoShape({ props: { size: 's' } }))
  const medium = geoStyle(geoShape({ props: { size: 'm' } }))
  const extraLarge = geoStyle(geoShape({ props: { size: 'xl' } }))

  assert.ok(small.strokeWidth < medium.strokeWidth && medium.strokeWidth < extraLarge.strokeWidth, 'strokeWidth increases s < m < xl with props.size')
  assert.ok(small.fontSize < medium.fontSize && medium.fontSize < extraLarge.fontSize, 'label fontSize increases s < m < xl with props.size')

  const missing = geoStyle(geoShape({ props: {} }))
  assert.equal(missing.strokeWidth, medium.strokeWidth, 'a geo shape with no size prop defaults to v1s own default (m)')
  assert.equal(missing.fontSize, medium.fontSize, 'default fontSize is the m-size value too')
  console.log('ok: geoStyle — strokeWidth and label fontSize scale with props.size (s < m < xl), default m')
}

// ============================================================================
// 6. Live label: geo is text-capable (canvas-model's TEXT_CAPABLE_KINDS
//    includes 'geo') and carries a centered label — live getText wins first
//    (same order as label.ts's labelOf), falling back to richText. EMPTY ->
//    NO label at all (v1's component(): `showHtmlContainer = isReadyForEditing
//    || !isEmpty` — GeoShapeUtil.tsx — an empty geo shows no RichTextLabel,
//    NOT the kind string "geo"; geoLabel is a truncated resolver like
//    TextShape.tsx's textContent, not label.ts's full labelOf).
// ============================================================================
{
  const shape = geoShape({ props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fallback text' }] }] } } })

  assert.equal(geoLabel(shape, (id) => (id === shape.id ? 'live doc text wins' : '')), 'live doc text wins', 'geoLabel prefers live getText')
  assert.equal(geoLabel(shape, () => ''), 'fallback text', 'with no live text, geoLabel falls back to richText')

  const empty = geoShape({ props: {} })
  assert.equal(geoLabel(empty, () => ''), '', 'an empty geo shape has NO label text at all (not the kind string "geo")')

  const htmlWithLabel = render(geoShape({ props: { color: 'green' } }), () => 'hello world')
  assert.ok(htmlWithLabel.includes('hello world'), 'GeoShape renders the live label text')
  assert.ok(htmlWithLabel.includes('data-shape-geo-label'), 'the label renders inside a dedicated, centered label element')

  const htmlEmpty = render(geoShape({ props: {} }), () => '')
  assert.ok(!htmlEmpty.includes('data-shape-geo-label'), 'an empty geo shape renders NO label element at all')
  console.log('ok: GeoShape — live label wins first, empty geo shows no label (matches v1, not the kind-string fallback)')
}

// ============================================================================
// 7. Belt-and-suspenders DOM-wiring check: the resolved stroke/fill colors
//    actually land in the rendered markup, tagged with data-shape-body.
// ============================================================================
{
  const shape = geoShape({ props: { geo: 'ellipse', color: 'green', fill: 'solid', w: 80, h: 80 } })
  const html = render(shape)
  assert.ok(html.includes('data-shape-body="geo"'), 'GeoShape is tagged data-shape-body="geo"')
  assert.ok(html.includes('data-shape-geo-variant="ellipse"'), 'GeoShape tags its resolved variant')
  assert.ok(html.includes('#099268'), 'rendered geo carries v1s green solid stroke color')
  assert.ok(html.includes('#d3e9e3'), 'rendered geo carries v1s green fill:solid pastel fill color')
  console.log('ok: GeoShape — resolved stroke/fill colors actually reach the rendered DOM, not just the pure helper')
}

// ============================================================================
// 8. Task R2 — GeoShape honors props.dash: 'dashed'/'dotted' render a real
//    stroke-dasharray (DIFFERENT arrays from each other); 'solid'/'draw'
//    (the default) stay a clean, un-dashed solid stroke; 'none' renders NO
//    stroke at all (v1's PathBuilder.toSvg returns no <path> element when
//    style==='none' — node_modules/tldraw/src/lib/shapes/shared/
//    PathBuilder.tsx's `toSvg`: `if (opts.style === 'none') return null` —
//    confirmed by reading source, not assumed). Arrays scale with
//    strokeWidth (module header's DASH section cites
//    getPerfectDashProps.ts's per-unit constants), checked here by
//    comparing size 'm' vs 'xl'.
// ============================================================================
{
  const dashedHtml = render(geoShape({ props: { dash: 'dashed', color: 'blue' } }))
  const dashedMatch = dashedHtml.match(/<rect[^>]*stroke-dasharray="([^"]*)"/)
  assert.ok(dashedMatch, `dash:'dashed' should render a stroke-dasharray on the stroke element: ${dashedHtml}`)

  const dottedHtml = render(geoShape({ props: { dash: 'dotted', color: 'blue' } }))
  const dottedMatch = dottedHtml.match(/<rect[^>]*stroke-dasharray="([^"]*)"/)
  assert.ok(dottedMatch, `dash:'dotted' should render a stroke-dasharray on the stroke element: ${dottedHtml}`)

  assert.notEqual(dottedMatch![1], dashedMatch![1], `dashed and dotted must produce DIFFERENT dasharray patterns, got the same: ${dashedMatch![1]}`)

  const solidHtml = render(geoShape({ props: { dash: 'solid', color: 'blue' } }))
  assert.ok(!solidHtml.includes('stroke-dasharray'), `dash:'solid' should render a clean solid stroke (no stroke-dasharray): ${solidHtml}`)

  const drawHtml = render(geoShape({ props: { dash: 'draw', color: 'blue' } }))
  assert.ok(!drawHtml.includes('stroke-dasharray'), `dash:'draw' (default) should render a clean solid stroke (no stroke-dasharray): ${drawHtml}`)

  const noDashPropHtml = render(geoShape({ props: { color: 'blue' } }))
  assert.ok(!noDashPropHtml.includes('stroke-dasharray'), `an absent dash prop defaults to v1's own default (draw) — no stroke-dasharray: ${noDashPropHtml}`)

  const noneHtml = render(geoShape({ props: { dash: 'none', color: 'blue' } }))
  assert.ok(!noneHtml.includes('stroke="#4465e9"'), `dash:'none' should render NO stroke at all (not just no dasharray): ${noneHtml}`)
  assert.ok(!noneHtml.includes('stroke-dasharray'), `dash:'none' should carry no stroke-dasharray either (there is no stroke element): ${noneHtml}`)

  // Scaling: the dashed/dotted arrays must scale with strokeWidth (props.size),
  // not be a fixed magic-number array that ignores it.
  const dashedSmall = geoStyle(geoShape({ props: { dash: 'dashed', size: 'm' } }))
  const dashedLarge = geoStyle(geoShape({ props: { dash: 'dashed', size: 'xl' } }))
  assert.ok(dashedSmall.strokeDasharray, 'geoStyle exposes a strokeDasharray for dash:dashed')
  assert.notEqual(dashedSmall.strokeDasharray, dashedLarge.strokeDasharray, `dashed's dasharray must scale with strokeWidth (size m vs xl differed not at all: ${dashedSmall.strokeDasharray})`)

  const dottedSmall = geoStyle(geoShape({ props: { dash: 'dotted', size: 'm' } }))
  const dottedLarge = geoStyle(geoShape({ props: { dash: 'dotted', size: 'xl' } }))
  assert.notEqual(dottedSmall.strokeDasharray, dottedLarge.strokeDasharray, `dotted's dasharray must scale with strokeWidth (size m vs xl differed not at all: ${dottedSmall.strokeDasharray})`)

  console.log('ok: GeoShape — dashed/dotted render distinct stroke-dasharray patterns scaling with strokeWidth, solid/draw stay clean, none renders no stroke at all')
}

console.log('ok: geo-shape (variant discriminator + real SVG geometry, v1-grounded stroke/fill, live label, DOM wiring, dash)')
