// The geo body (Task C4 — "variants"). Replaces the blue BoxShape fallback
// for `geo`-kind shapes (rectangle/ellipse/triangle/diamond/... — v1's
// "shape" tool) with real SVG geometry per variant, v1-matched stroke/fill
// from `color`/`fill`, and a centered live label. Pure presentational — no
// snapshot read (content-memo friendly per this package's MEMO STRATEGY,
// shapeRegistry.ts), no side effects.
//
// GROUNDING (do not re-derive without re-checking these — v1 is the source
// of truth for every value below). All from the unscoped "tldraw" package
// (node_modules/tldraw/src/lib/shapes/geo/) and its "tlschema"/"editor"
// scoped dependencies on npm — cited by file path, never with the scoped
// package-name-slash form (see this package's boundary.test.ts regex).
//
// VARIANT DISCRIMINATOR: the field is `props.geo` — GeoShapeGeoStyle, a
// StyleProp enum of 20 values (tlschema's shapes/TLGeoShape.ts:40-59):
// cloud, rectangle, ellipse, triangle, diamond, pentagon, hexagon, octagon,
// star, rhombus, rhombus-2, oval, trapezoid, arrow-right, arrow-left,
// arrow-up, arrow-down, x-box, check-box, heart — defaultValue 'rectangle'.
// The Seam C intro's "geo adds `box`" refers to canvas-model's OWN typed
// schema (canvas-model/src/shape.ts:47, `geo: withText.extend(box.shape)` —
// i.e. geo = withText's {richText, color} + box's {w, h}): `geo` (the
// variant key itself) is NOT a named field there, any more than
// TextShape.tsx's font/size/textAlign are on the `text` kind — same
// passthrough situation (withText is a z.looseObject), and the same
// lossless converter (server/src/canvas-v2/convert.ts's shapeFromRecord:
// `props: r.props ?? {}`) carries a real v1 geo shape's `props.geo` through
// to the model at runtime regardless of the typed schema's silence on it.
//
// GEOMETRY: getGeoShapePath.ts's `defaultGeoTypeDefinitions` is the source
// of every variant's actual path. Special-cased here (the "common" set the
// task calls out): rectangle (a plain box), ellipse (arcTo a true ellipse,
// not a superellipse), triangle (apex at (w/2,0), base corners at (w,h)/
// (0,h)), diamond (top/right/bottom/left points at the four edge
// midpoints). Every OTHER variant (cloud/pentagon/hexagon/octagon/star/
// rhombus/rhombus-2/oval/trapezoid/the four arrows/x-box/check-box/heart)
// falls back to a plain rectangle OUTLINE — documented here, not a crash —
// real polygon math for the remaining ~16 variants is future work, not this
// task's scope. SVG is drawn in a viewBox exactly `w x h` (the shape's own
// props.w/props.h, default 100x100 per GeoShapeUtil.tsx's getDefaultProps)
// at 100%x100% of the body div, which ShapeBody.tsx already sizes to the
// shape's localBounds — so shape-space coordinates ARE screen pixels here,
// same posture as every other body in this package.
//
// STROKE COLOR: `getColorValue(colors, color, 'solid')`
// (GeoShapeUtil.tsx's getDefaultDisplayValues: `strokeColor:
// getColorValue(colors, color, 'solid')`) — the exact same light-theme
// 'solid' hex table TextShape.tsx's TEXT_SOLID cites (defaultThemes.ts:
// 146-353), because 'solid' is a per-color variant shared by every colored
// shape kind, not a geo-specific palette. Default `color` is 'black'
// (GeoShapeUtil.tsx getDefaultProps) -> '#1d1d1d'.
//
// FILL: `fill` is one of 'none'/'semi'/'solid'/'pattern'/'fill'/
// 'lined-fill' (tlschema's styles/TLFillStyle.ts:37-40, DefaultFillStyle,
// defaultValue 'none' — matching GeoShapeUtil.tsx's getDefaultProps `fill:
// 'none'`). getDefaultDisplayValues' exact (and non-obvious) resolution
// (GeoShapeUtil.tsx):
//   fillColor = fill === 'none' ? 'transparent'
//             : fill === 'semi' ? colors.solid
//             : getColorValue(colors, color, DEFAULT_FILL_COLOR_NAMES[fill])
// Two real surprises worth flagging explicitly (a naive reading of "solid"/
// "semi" gets this backwards):
//   - fill:'semi' does NOT tint by the shape's own color at all — it always
//     resolves to `colors.solid`, a THEME-LEVEL field (not the per-color
//     'solid' variant!), '#fcfffe' in light mode (defaultThemes.ts:136) — a
//     fixed near-white, the same for every color. Against this app's
//     near-white canvas background this reads as a barely-there tint,
//     which is presumably the "semi" in the name, but it is achieved with a
//     FIXED hex, not per-color opacity.
//   - fill:'solid' does NOT use the strong per-color 'solid'/stroke hex —
//     defaultFills.ts's DEFAULT_FILL_COLOR_NAMES maps fill:'solid' to the
//     per-color variant key 'semi' (a light pastel tint, e.g. blue's
//     `#dce1f8` vs its strokeColor `#4465e9`), so "solid" fill is visually
//     the SUBTLE pastel one, and "semi" fill is the plain near-white one —
//     the names describe the STYLE OPTION, not the resulting visual
//     strength. fill:'fill'/'lined-fill'/'pattern' are handled by the same
//     DEFAULT_FILL_COLOR_NAMES formula (mapping to the 'fill'/'linedFill'/
//     'pattern' per-color variants respectively) as a flat-color
//     approximation — v1's actual 'pattern' fill renders a diagonal-hatch
//     SVG pattern (GeoShapeBody.tsx's <PatternFill>), which this body does
//     NOT reproduce (documented simplification, not a crash).
// Per-color hex tables below (solid/semi/fill/linedFill/pattern) are copied
// verbatim from the "editor" package's defaultThemes.ts:146-353, light mode
// only — same posture as every other shape body's GROUNDING block
// (client/src/App.tsx:198-203 force-seeds `colorScheme: 'light'`; no theme
// toggle exists yet).
//
// DASH: `dash` is one of 'draw'/'solid'/'dashed'/'dotted'/'none' (default
// 'draw', GeoShapeUtil.tsx getDefaultProps; DefaultDashStyle's `values:`
// array — tlschema's styles/TLDashStyle.ts:38 — has FIVE entries even
// though its own doc-comment prose only lists four; canvas-model's DASH enum,
// shape.ts, correctly types all five, and this body must too). v1 renders:
// draw -> a HAND-WOBBLED stroke (GeoShapeBody.tsx's `path.toDrawD(...)`,
// seeded per-shape); solid -> a clean solid stroke; dashed/dotted -> real
// dash-array patterns; none -> NO stroke element at all (PathBuilder.tsx's
// `toSvg`: `if (opts.style === 'none') return null` — the shape's fill, if
// any, still renders, just with no outline). This body reproduces dashed/
// dotted (via `dashArray` below) and none (`geoStyle` resolves `strokeColor`
// to `null`), but NOT the draw hand-wobble — draw still renders as a clean
// solid stroke, a deliberate, documented simplification (like the
// pattern-fill / align / stroke-inset gaps below). Reproducing the
// draw-wobble RNG path is deferred to the Seam F parity work, not
// implemented here.
//
// DASH ARRAYS: v1's real dash/dot arrays are PERIMETER-FITTING — computed
// against each path's total length so dashes divide evenly around a closed
// outline (getPerfectDashProps.ts's `dashLength`/`gapLength` math, driven by
// `totalLength`). This body has no such path-length machinery (see GEOMETRY
// above — plain SVG primitives, not a v1 `PathBuilder`), so `dashArray`
// below borrows only getPerfectDashProps.ts's two PER-STROKE-WIDTH unit
// constants rather than the full perimeter fit: dashed's dash segment is
// `strokeWidth * lengthRatio` (default `lengthRatio` there is 2) and
// dotted's dot segment is `strokeWidth / 100` (its `ratio: 100` branch) — a
// near-zero-length dash that reads as a round dot under the `strokeLinecap:
// 'round'` this body also applies (matching v1's own
// `.tl-svg-container { stroke-linecap: round }`, editor.css). The GAP
// lengths (1:1 for dashed, 2.5x strokeWidth for dotted) are NOT from v1 —
// v1 solves its gap from total path length, which this body doesn't track —
// a documented approximation, not a bug.
//
// STROKE WIDTH / LABEL SIZE: `size` (default 'm', GeoShapeUtil.tsx
// getDefaultProps) resolves strokeWidth via `theme.strokeWidth *
// STROKE_SIZES[size]` and label font size via `theme.fontSize *
// LABEL_FONT_SIZES[size]` (both GeoShapeUtil.tsx's getDefaultDisplayValues;
// STROKE_SIZES/LABEL_FONT_SIZES tables from default-shape-constants.ts:
// 12-17/28-33; theme.strokeWidth=2, theme.fontSize=16, defaultThemes.ts:
// 18/root). Like `geo`/`fill` itself, `size`/`font`/`labelColor` are NOT
// named on canvas-model's geo props schema — read here as untyped
// passthrough fields, same posture as TextShape.tsx's font/size/textAlign.
//
// LABEL: geo is text-capable (canvas-model's TEXT_CAPABLE_KINDS includes
// 'geo', shape.ts:29) and v1's `getText(shape)` is
// `renderPlaintextFromRichText(editor, shape.props.richText)`
// (GeoShapeUtil.tsx) — the same "read live editor state" posture
// TextShape.tsx's GROUNDING > TEXT CONTENT documents for the `text` kind.
// v1's `component()` only mounts a label at all when `isReadyForEditing ||
// !isEmptyRichText(richText)` (GeoShapeUtil.tsx's `showHtmlContainer`) — an
// empty geo shape shows NO label whatsoever, not the kind string "geo".
// So `geoLabel` below is a TRUNCATED resolver mirroring TextShape.tsx's
// `textContent` exactly (same live-then-richText order, final fallback ''
// — deliberately NOT label.ts's `labelOf`, whose fallback chain would fall
// through an empty/absent name straight to the raw kind string). v1
// CENTERS a geo label by default (`align`/`verticalAlign` both default
// 'middle', GeoShapeUtil.tsx getDefaultProps) but honors non-default values
// (Task R3): `props.align` drives horizontal `text-align`/`justify-content`
// and `props.verticalAlign` drives `align-items` — see ALIGN_CSS/
// VERTICAL_ALIGN_CSS below. `align` is `DefaultHorizontalAlignStyle`, a
// SIX-value enum (start/middle/end plus start-legacy/end-legacy/
// middle-legacy — tlschema's styles/TLAlignStyle.ts): the three `-legacy`
// variants are real values legacy documents carry and MUST render
// identically to their base (start-legacy -> left, same as start), never
// fall through to the center default — `normalizeAlign` strips the
// `-legacy` suffix before the lookup so both cases share one code path.
import type { ReactElement } from 'react'
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { flattenRichText } from './label.js'

// Per-color hex tables, light theme, verbatim from the "editor" package's
// defaultThemes.ts:146-353 (colors.light.<name>). `solid` doubles as
// STROKE color (getColorValue(..., 'solid')) AND as the DEFAULT_FILL_COLOR_
// NAMES target for fill:'fill' would use 'fill' below, not 'solid' — kept
// as separate keys since they're independently-named fields in v1 even
// where the hex values happen to coincide.
// Exported (GEO_COLORS/colorEntry/STROKE_WIDTH_PX/DASH_VALUES/dashArray
// below) so Arrows.tsx (canvas-react/src/overlay/Arrows.tsx, the arrow
// style-props wiring task) can reuse the SAME color/size/dash tables
// instead of hand-copying a second one — `color`/`dash`/`size` are shared
// style axes (canvas-model's STYLE_ENUMS), not geo-specific, even though
// this module happened to type them first.
export interface GeoColorEntry {
  readonly solid: string
  readonly semi: string
  readonly fill: string
  readonly linedFill: string
  readonly pattern: string
}
export const GEO_COLORS: Readonly<Record<string, GeoColorEntry>> = Object.freeze({
  black: { solid: '#1d1d1d', fill: '#1d1d1d', linedFill: '#363636', semi: '#e8e8e8', pattern: '#494949' },
  grey: { solid: '#9fa8b2', fill: '#9fa8b2', linedFill: '#bbc1c9', semi: '#eceef0', pattern: '#bcc3c9' },
  'light-violet': { solid: '#e085f4', fill: '#e085f4', linedFill: '#e9abf7', semi: '#f5eafa', pattern: '#e9acf8' },
  violet: { solid: '#ae3ec9', fill: '#ae3ec9', linedFill: '#be68d4', semi: '#ecdcf2', pattern: '#bd63d3' },
  blue: { solid: '#4465e9', fill: '#4465e9', linedFill: '#6580ec', semi: '#dce1f8', pattern: '#6681ee' },
  'light-blue': { solid: '#4ba1f1', fill: '#4ba1f1', linedFill: '#7abaf5', semi: '#ddedfa', pattern: '#6fbbf8' },
  yellow: { solid: '#f1ac4b', fill: '#f1ac4b', linedFill: '#f5c27a', semi: '#f9f0e6', pattern: '#fecb92' },
  orange: { solid: '#e16919', fill: '#e16919', linedFill: '#ea8643', semi: '#f8e2d4', pattern: '#f78438' },
  green: { solid: '#099268', fill: '#099268', linedFill: '#0bad7c', semi: '#d3e9e3', pattern: '#39a785' },
  'light-green': { solid: '#4cb05e', fill: '#4cb05e', linedFill: '#7ec88c', semi: '#dbf0e0', pattern: '#65cb78' },
  'light-red': { solid: '#f87777', fill: '#f87777', linedFill: '#f99a9a', semi: '#f4dadb', pattern: '#fe9e9e' },
  red: { solid: '#e03131', fill: '#e03131', linedFill: '#e75f5f', semi: '#f4dadb', pattern: '#e55959' },
  white: { solid: '#FFFFFF', fill: '#FFFFFF', linedFill: '#ffffff', semi: '#f5f5f5', pattern: '#f9f9f9' },
})
export const DEFAULT_COLOR = 'black' // GeoShapeUtil.tsx getDefaultProps
const THEME_SOLID_LIGHT = '#fcfffe' // theme.colors.light.solid (defaultThemes.ts:136) — used for fill:'semi'

// defaultFills.ts's DEFAULT_FILL_COLOR_NAMES — which per-color variant a
// given `fill` STYLE resolves through (NOT the fill style's own name — see
// module header's FILL surprises).
const FILL_VARIANT: Readonly<Record<string, keyof GeoColorEntry>> = Object.freeze({
  solid: 'semi',
  fill: 'fill',
  'lined-fill': 'linedFill',
  pattern: 'pattern',
})
const DEFAULT_FILL = 'none' // GeoShapeUtil.tsx getDefaultProps

// default-shape-constants.ts's STROKE_SIZES/LABEL_FONT_SIZES * theme.strokeWidth(2)/fontSize(16).
export const STROKE_WIDTH_PX: Readonly<Record<string, number>> = Object.freeze({ s: 2, m: 3.5, l: 5, xl: 10 })
const LABEL_FONT_SIZE_PX: Readonly<Record<string, number>> = Object.freeze({ s: 18, m: 22, l: 26, xl: 32 })
export const DEFAULT_SIZE = 'm' // GeoShapeUtil.tsx getDefaultProps
const LINE_HEIGHT = 1.35 // theme.lineHeight, defaultThemes.ts — same value every other body cites

// tlschema's DefaultFontFamilies (styles/TLFontStyle.ts:83-88) — same table
// NoteShape.tsx/TextShape.tsx cite.
const FONT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  draw: "'tldraw_draw', sans-serif",
  sans: "'tldraw_sans', sans-serif",
  serif: "'tldraw_serif', serif",
  mono: "'tldraw_mono', monospace",
})
const DEFAULT_FONT = 'draw' // GeoShapeUtil.tsx getDefaultProps

// DefaultDashStyle's five real values (tlschema's TLDashStyle.ts:38 —
// module header's DASH section). 'draw'/'solid' resolve to no dasharray
// (see `dashArray` below); 'none' resolves `strokeColor` to `null` in
// `geoStyle` instead (no stroke element at all).
export const DASH_VALUES = new Set(['draw', 'solid', 'dashed', 'dotted', 'none'])
export const DEFAULT_DASH = 'draw' // GeoShapeUtil.tsx getDefaultProps
const DASH_LENGTH_RATIO = 2 // getPerfectDashProps.ts's default `lengthRatio`
const DOT_RATIO = 100 // getPerfectDashProps.ts's dotted-case `ratio`
const DOT_GAP_MULTIPLIER = 2.5 // NOT from v1 — see module header DASH ARRAYS

/** dashed/dotted -> a `strokeWidth`-scaled `stroke-dasharray` string;
 * draw/solid/none -> `undefined` (no dasharray attribute at all — see
 * module header DASH ARRAYS for exactly which constants are v1-grounded
 * vs. this body's own approximation). */
export function dashArray(dash: string, strokeWidth: number): string | undefined {
  switch (dash) {
    case 'dashed': {
      const segment = strokeWidth * DASH_LENGTH_RATIO
      return `${segment} ${segment}`
    }
    case 'dotted': {
      const dot = strokeWidth / DOT_RATIO
      const gap = strokeWidth * DOT_GAP_MULTIPLIER
      return `${dot} ${gap}`
    }
    default:
      return undefined
  }
}

// props.align (DefaultHorizontalAlignStyle, module header's LABEL section) ->
// the label div's CSS. start/middle/end map to left/center/right for
// text-align and flex-start/center/flex-end for justify-content (the label
// div is a flex container so it can also vertically center — see
// VERTICAL_ALIGN_CSS below). Keyed only by the three PRIMARY values —
// `normalizeAlign` strips a `-legacy` suffix before indexing here, so the
// three legacy variants share these same rows rather than duplicating them.
const ALIGN_CSS: Readonly<Record<string, { textAlign: 'left' | 'center' | 'right'; justifyContent: 'flex-start' | 'center' | 'flex-end' }>> =
  Object.freeze({
    start: { textAlign: 'left', justifyContent: 'flex-start' },
    middle: { textAlign: 'center', justifyContent: 'center' },
    end: { textAlign: 'right', justifyContent: 'flex-end' },
  })
const DEFAULT_ALIGN = 'middle' // DefaultHorizontalAlignStyle defaultValue, GeoShapeUtil.tsx getDefaultProps

// props.verticalAlign (DefaultVerticalAlignStyle — start/middle/end only, no
// -legacy variants) -> the label div's align-items.
const VERTICAL_ALIGN_CSS: Readonly<Record<string, 'flex-start' | 'center' | 'flex-end'>> = Object.freeze({
  start: 'flex-start',
  middle: 'center',
  end: 'flex-end',
})
const DEFAULT_VERTICAL_ALIGN = 'middle' // DefaultVerticalAlignStyle defaultValue, GeoShapeUtil.tsx getDefaultProps

/** `props.align`, stripped of a trailing `-legacy` (the three legacy values
 * are real accepted values a synced document may carry — module header's
 * LABEL section — and must render identically to their base, not fall
 * through to the default). Unrecognized/absent -> v1's own default
 * ('middle'). */
function normalizeAlign(align: unknown): keyof typeof ALIGN_CSS {
  if (typeof align !== 'string') return DEFAULT_ALIGN
  const base = align.endsWith('-legacy') ? align.slice(0, -'-legacy'.length) : align
  return base in ALIGN_CSS ? (base as keyof typeof ALIGN_CSS) : DEFAULT_ALIGN
}

/** `props.verticalAlign`, defaulted to v1's own 'middle' — no `-legacy`
 * variants exist for this axis (DefaultVerticalAlignStyle). */
function normalizeVerticalAlign(verticalAlign: unknown): keyof typeof VERTICAL_ALIGN_CSS {
  return typeof verticalAlign === 'string' && verticalAlign in VERTICAL_ALIGN_CSS
    ? (verticalAlign as keyof typeof VERTICAL_ALIGN_CSS)
    : DEFAULT_VERTICAL_ALIGN
}

const DEFAULT_GEO = 'rectangle' // GeoShapeGeoStyle defaultValue
const DEFAULT_W = 100 // GeoShapeUtil.tsx getDefaultProps
const DEFAULT_H = 100

// The variants this body draws with real, shape-specific geometry — every
// other value in GeoShapeGeoStyle's 20-entry enum falls back to a plain
// rectangle outline (see module header GEOMETRY).
const SPECIAL_CASED_VARIANTS = new Set(['rectangle', 'ellipse', 'triangle', 'diamond'])

export interface GeoStyle {
  /** null => dash:'none', render no stroke element at all (v1's
   * PathBuilder.toSvg returns no <path> — see module header DASH). */
  readonly strokeColor: string | null
  readonly strokeWidth: number
  /** dashed/dotted's stroke-dasharray, scaled to strokeWidth; undefined for
   * draw/solid/none (a clean, un-dashed stroke — or no stroke at all). */
  readonly strokeDasharray: string | undefined
  /** null => fill:'none', render no fill at all (not even 'transparent' —
   * simplest to just omit the fill element entirely). */
  readonly fillColor: string | null
  readonly labelColor: string
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  /** Resolved from `props.align` (Task R3 — see module header LABEL /
   * ALIGN_CSS above); 'center' when absent or unrecognized (v1 default). */
  readonly textAlign: 'left' | 'center' | 'right'
  readonly justifyContent: 'flex-start' | 'center' | 'flex-end'
  /** Resolved from `props.verticalAlign`; 'center' when absent (v1 default). */
  readonly alignItems: 'flex-start' | 'center' | 'flex-end'
}

/** `props.geo`, defaulted to v1's own 'rectangle' (see module header
 * VARIANT DISCRIMINATOR). */
export function geoVariant(shape: ShapeBodyProps['shape']): string {
  const props = shape.props as Record<string, unknown>
  return typeof props.geo === 'string' && props.geo.length > 0 ? props.geo : DEFAULT_GEO
}

export function colorEntry(color: unknown): GeoColorEntry {
  return typeof color === 'string' && color in GEO_COLORS ? GEO_COLORS[color] : GEO_COLORS[DEFAULT_COLOR]
}

/** Pure style resolver — stroke/fill colors + label typography, derived
 * from `shape.props` the same way v1's GeoShapeUtil.getDefaultDisplayValues
 * resolves them (light theme only — see module header). */
export function geoStyle(shape: ShapeBodyProps['shape']): GeoStyle {
  const props = shape.props as Record<string, unknown>
  const entry = colorEntry(props.color)
  // labelColor is an INDEPENDENT prop, defaulting to 'black' on its own
  // (GeoShapeUtil.tsx getDefaultProps: `labelColor: 'black'`) — NOT to the
  // shape's own `color`. So an un-labelColor'd blue geo gets a BLACK label,
  // not a blue one. colorEntry's own black default handles `undefined`.
  const labelEntry = colorEntry(props.labelColor)
  const fill = typeof props.fill === 'string' ? props.fill : DEFAULT_FILL
  const size = typeof props.size === 'string' && props.size in STROKE_WIDTH_PX ? props.size : DEFAULT_SIZE
  const font = typeof props.font === 'string' && props.font in FONT_FAMILY ? props.font : DEFAULT_FONT
  const dash = typeof props.dash === 'string' && DASH_VALUES.has(props.dash) ? props.dash : DEFAULT_DASH
  const strokeWidth = STROKE_WIDTH_PX[size]

  const fillColor = fill === 'none' ? null : fill === 'semi' ? THEME_SOLID_LIGHT : entry[FILL_VARIANT[fill] ?? 'semi']
  const align = ALIGN_CSS[normalizeAlign(props.align)]
  const alignItems = VERTICAL_ALIGN_CSS[normalizeVerticalAlign(props.verticalAlign)]

  return {
    strokeColor: dash === 'none' ? null : entry.solid,
    strokeWidth,
    strokeDasharray: dashArray(dash, strokeWidth),
    fillColor,
    labelColor: labelEntry.solid,
    fontFamily: FONT_FAMILY[font],
    fontSize: LABEL_FONT_SIZE_PX[size],
    lineHeight: LINE_HEIGHT,
    textAlign: align.textAlign,
    justifyContent: align.justifyContent,
    alignItems,
  }
}

/** Best-effort label, live-doc first — a DELIBERATELY TRUNCATED resolver
 * like TextShape.tsx's `textContent` (see module header LABEL): same
 * live-getText-then-richText order, but the final fallback is the EMPTY
 * STRING, never `shape.kind` (v1 shows no label at all for an empty geo
 * shape). */
export function geoLabel(shape: ShapeBodyProps['shape'], getText?: (id: string) => string): string {
  if (getText) {
    const live = getText(shape.id)
    if (live.length > 0) return live
  }
  const props = shape.props as Record<string, unknown>
  const rich = props.richText as { content?: unknown } | undefined
  if (rich && typeof rich === 'object') {
    const text = flattenRichText(rich)
    if (text) return text
  }
  return ''
}

/** The SVG element for one geo variant, sized to `w`x`h` in shape-space
 * (the enclosing <svg>'s viewBox is exactly `0 0 w h`, so these are already
 * screen pixels — see module header GEOMETRY). Vertices/centers copied from
 * getGeoShapePath.ts's defaultGeoTypeDefinitions for the four special-cased
 * variants; anything else falls back to the same <rect> as 'rectangle'. */
function geoPath(variant: string, w: number, h: number, style: GeoStyle): ReactElement {
  const fill = style.fillColor ?? 'none'
  // dash:'none' -> strokeColor is null -> render stroke:'none' (no visible
  // outline; the fill, if any, still renders) — see GeoStyle's strokeColor doc.
  const strokeProps =
    style.strokeColor === null
      ? { stroke: 'none' }
      : {
          stroke: style.strokeColor,
          strokeWidth: style.strokeWidth,
          strokeLinecap: 'round' as const, // matches v1's .tl-svg-container { stroke-linecap: round } (editor.css) — load-bearing for dotted to read as round dots, not invisible slivers
          ...(style.strokeDasharray !== undefined ? { strokeDasharray: style.strokeDasharray } : {}),
        }
  const common = { fill, ...strokeProps }
  switch (SPECIAL_CASED_VARIANTS.has(variant) ? variant : 'rectangle') {
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...common} />
    case 'triangle':
      return <polygon points={`${w / 2},0 ${w},${h} 0,${h}`} {...common} />
    case 'diamond':
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...common} />
    case 'rectangle':
    default:
      return <rect x={0} y={0} width={w} height={h} {...common} />
  }
}

export function GeoShape({ shape, getText }: ShapeBodyProps) {
  const props = shape.props as Record<string, unknown>
  const w = typeof props.w === 'number' && props.w > 0 ? props.w : DEFAULT_W
  const h = typeof props.h === 'number' && props.h > 0 ? props.h : DEFAULT_H
  const variant = geoVariant(shape)
  const style = geoStyle(shape)
  const label = geoLabel(shape, getText)

  return (
    <div
      data-shape-body="geo"
      data-shape-geo-variant={variant}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
      >
        {geoPath(variant, w, h, style)}
      </svg>
      {label.length > 0 && (
        <div
          data-shape-geo-label=""
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: style.alignItems,
            justifyContent: style.justifyContent,
            textAlign: style.textAlign,
            padding: 8,
            boxSizing: 'border-box',
            overflow: 'hidden',
            overflowWrap: 'break-word',
            pointerEvents: 'none',
            color: style.labelColor,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
          }}
        >
          {label}
        </div>
      )}
    </div>
  )
}
