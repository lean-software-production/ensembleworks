// The bare-text body (Task C3). Replaces the blue BoxShape fallback for
// `text`-kind shapes with v1-matched typography: font/size/color/align read
// from props, live-doc text FIRST (the Phase-3 SetText-had-no-consumer fix —
// see NoteShape.tsx's HANDWRITING FONT / BoxShape.tsx's labelOf history for
// why that accessor exists at all), transparent background, no box border —
// a text shape is bare text, not a box. Pure presentational — no snapshot
// read (content-memo friendly per this package's MEMO STRATEGY,
// shapeRegistry.ts), no side effects.
//
// MODEL PROPS — what's ACTUALLY on the model's `text` kind (checked, not
// assumed): canvas-model/src/shape.ts:43,48 types `text: withText`, where
// `withText = z.looseObject({ richText: richText.optional(), color:
// z.string().optional() })` — only `richText` and `color` are named in the
// TYPED schema. `font`/`size`/`textAlign` are NOT declared there. However,
// `z.looseObject` passes unknown keys through unchanged, AND the tldraw <->
// model converter is a byte-for-byte, lossless passthrough of `props`
// (server/src/canvas-v2/convert.ts's `shapeFromRecord`: `props: r.props ??
// {}`, "props pass through verbatim (lossless, incl. richText)" per that
// file's own header) — so a REAL text shape synced from v1 DOES carry
// `props.font`/`props.size`/`props.textAlign` at runtime (v1's own
// TLTextShapeProps, see below), even though the model's zod schema doesn't
// name them. This module reads all four (color/font/size/textAlign) as
// untyped passthrough fields off `shape.props`, with v1-matched defaults for
// a shape where they're absent/malformed (e.g. a hand-built fixture that
// only sets `richText`).
//
// FIELD NAME CORRECTION (grounding finding): the task plan calls this prop
// "align", but v1's real field name is `textAlign`, NOT `align` — tldraw's
// "tlschema" package migrated it (shapes/TLTextShape.ts:133, "AddTextAlign:
// Migrated from 'align' to 'textAlign' property", the migration body at
// :153/:157 renames `props.align` -> `props.textAlign`). Every live v1
// document has long since run that migration, so `props.textAlign` is the
// correct — and only — field to read; a stray `props.align` key is NOT an
// alias and is deliberately ignored (see textStyle's align resolution
// below).
//
// GROUNDING (do not re-derive without re-checking these — v1 is the source
// of truth for every value below). All from the unscoped "tldraw" package on
// npm (not a scoped sub-package — see this module's citation style, matching
// NoteShape.tsx/FrameShape.tsx):
//
// TEXT CONTENT: v1's own `getText(shape)` is `renderPlaintextFromRichText(
// editor, shape.props.richText)` (node_modules/tldraw/src/lib/shapes/text/
// TextShapeUtil.tsx:140-142) — i.e. v1 ALSO reads live editor state for a
// text shape's content, not a static prop. Our live-doc analog is
// `getText(shape.id)` (this shape's `LoroText` container, same source
// note/text editing writes through — see shapeRegistry.ts's ShapeBodyProps.
// getText doc comment). EMPTY-TEXT REQUIREMENT (the reason this task
// exists): `labelOf`'s shared resolver (label.ts) ends its fallback chain at
// the shape's own KIND STRING ("text") when nothing else is present — right
// for BoxShape's generic "show SOMETHING" fallback box, wrong for a real
// text shape, which v1 renders as a truly empty box (an empty `richText`,
// `toRichText('')`, is TextShapeUtil.tsx:101's own `getDefaultProps`
// default). So `textContent` below deliberately does NOT reuse `labelOf`
// wholesale: same ORDER (live text first), but truncated BEFORE the
// props.name / kind-string tail — richText fallback (for a fixture with only
// static richText, e.g. client/src/canvas-v2/goldens/fixtures.ts, per
// label.ts's own header) still applies, but the final fallback is the empty
// string, never `shape.kind`.
//
// COLOR: v1's `getDefaultDisplayValues` resolves `color` via `getColorValue(
// theme.colors[colorMode], color, 'solid')` (TextShapeUtil.tsx:76-78) — the
// 'solid' VARIANT, a DIFFERENT resolution than NoteShape's fixed 'noteText'
// (always '#000000') or FrameShape's fixed 'frameText' ('#000000' too) — a
// text shape's color genuinely varies by `props.color`. Light-theme 'solid'
// hex values below are copied verbatim from tldraw's "editor" package (the
// "editor" package in the tldraw scope on npm, same source FrameShape.tsx
// cites), lib/editor/managers/ThemeManager/defaultThemes.ts:146-353's
// `solid` entries under `colors.light.<name>`. Default `color` is 'black'
// (TextShapeUtil.tsx:94's `getDefaultProps`) -> `colors.light.black.solid` =
// '#1d1d1d' (defaultThemes.ts:147) — NOT '#000000' (that's `noteText`, a
// different field entirely). Light mode only, same posture as NoteShape.tsx/
// FrameShape.tsx's GROUNDING blocks (client/src/App.tsx:198-203 force-seeds
// `colorScheme: 'light'`; canvas-react has no theme toggle yet). The 13 color
// names themselves are contracts/src/constants.ts's NOTE_COLORS ("the note
// colours tldraw's default schema accepts (see TLDefaultColorStyle)" — the
// SAME enum backs every colored shape kind, text included, not just notes).
//
// FONT: v1's `font` prop resolves via `getFontFamily(theme, font)`
// (TextShapeUtil.tsx:79, node_modules/tldraw/src/lib/shapes/shared/
// default-shape-constants.ts:52-56) to `theme.fonts[font].fontFamily`, which
// in the default theme is exactly tldraw's "tlschema" package's
// `DefaultFontFamilies[font]` (styles/TLFontStyle.ts:83-88 — the SAME
// constant NoteShape.tsx's HANDWRITING FONT cites for the 'draw' entry).
// Default `font` is 'draw' (TextShapeUtil.tsx:97) -> `"'tldraw_draw',
// sans-serif"`. PARITY GAP carried forward unchanged from NoteShape.tsx (not
// re-litigated here): the actual `tldraw_draw`/`tldraw_sans`/etc. webfont
// files are registered at runtime only inside a live `<Tldraw>` editor
// instance (tldraw's "editor" package's FontManager.ts) which the v2 client
// never mounts — so today these families fall through to their generic tail
// (sans-serif/serif/monospace). Declaring the real family string is still
// the right, forward-compatible move; loading the actual webfont assets is
// out of this task's (and this package's clean-room) scope.
//
// SIZE: v1's `size` prop resolves to `theme.fontSize * FONT_SIZES[size]`
// (TextShapeUtil.tsx:80) where `theme.fontSize` is the default theme's base
// (defaultThemes.ts:16, `16`) and `FONT_SIZES` is TEXT's own scale
// (default-shape-constants.ts:20-25: `{ s: 1.125, m: 1.5, l: 2.25, xl: 2.75
// }` — NOT the same scale as STROKE_SIZES or LABEL_FONT_SIZES, which back
// OTHER shape kinds' label text, not a bare text shape's own size). Default
// `size` is 'm' (TextShapeUtil.tsx:95) -> `16 * 1.5` = 24px. Resolved px
// values used below: s=18, m=24, l=36, xl=44. `lineHeight` is the theme's
// own `1.35` (defaultThemes.ts:17, TextShapeUtilDisplayValues.lineHeight ==
// `theme.lineHeight`, TextShapeUtil.tsx:81) — same value NoteShape.tsx's
// sticky body hard-codes for its own unrelated reasons, here it's the exact
// v1-grounded source.
//
// ALIGN: v1's `textAlign` prop is one of 'start'/'middle'/'end' (tldraw's
// "tlschema" package's `DefaultTextAlignStyle`, styles/TLTextAlignStyle.ts:
// 35-38 — there is NO 'justify' value in this enum at all). v1's
// `component()` maps `textAlign === 'middle' ? 'center' : textAlign`
// (TextShapeUtil.tsx:172) before handing it to `RichTextLabel`, whose CSS
// `text-align` LITERALLY receives 'start'/'center'/'end' as-is (node_modules/
// tldraw/src/lib/shapes/shared/RichTextLabel.tsx:143) — valid CSS keywords
// tldraw does not further translate. This app is LTR-only (no direction
// toggle anywhere in client/), so 'start'==='left' and 'end'==='right'
// render identically; we map explicitly to 'left'/'center'/'right' below
// (matching this task's own naming) since the result is visually identical
// and reads more plainly than 'start'/'end' would to a future maintainer.
// Default `textAlign` is 'start' (TextShapeUtil.tsx:98) -> 'left'.
//
// BACKGROUND/BORDER: v1's `TextShapeUtil.component()` renders ONLY a
// `RichTextLabel` (TextShapeUtil.tsx:164-187) — no `<rect>`, no fill, no
// stroke at all, unlike NoteShapeUtil's colored box or FrameShapeUtil's
// bordered chrome. A text shape is bare text: transparent background, no
// border, confirmed by the absence of any such rendering in v1's source.
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { flattenRichText } from './label.js'

// tldraw's "editor" package's defaultThemes.ts colors.light.<name>.solid —
// the SAME 13 names as NoteShape.tsx's NOTE_FILL (contracts/src/
// constants.ts's NOTE_COLORS), but the 'solid' variant, not 'noteFill'/
// 'noteText' (see GROUNDING > COLOR above).
const TEXT_SOLID: Readonly<Record<string, string>> = Object.freeze({
  black: '#1d1d1d',
  grey: '#9fa8b2',
  'light-violet': '#e085f4',
  violet: '#ae3ec9',
  blue: '#4465e9',
  'light-blue': '#4ba1f1',
  yellow: '#f1ac4b',
  orange: '#e16919',
  green: '#099268',
  'light-green': '#4cb05e',
  'light-red': '#f87777',
  red: '#e03131',
  white: '#FFFFFF',
})
const DEFAULT_COLOR = 'black' // TextShapeUtil.tsx:94 getDefaultProps

// tldraw's "tlschema" package's DefaultFontFamilies (styles/TLFontStyle.ts:
// 83-88) — same values NoteShape.tsx's HANDWRITING_FONT cites for 'draw'.
const TEXT_FONT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  draw: "'tldraw_draw', sans-serif",
  sans: "'tldraw_sans', sans-serif",
  serif: "'tldraw_serif', serif",
  mono: "'tldraw_mono', monospace",
})
const DEFAULT_FONT = 'draw' // TextShapeUtil.tsx:97 getDefaultProps

// theme.fontSize (16, defaultThemes.ts:16) * text's own FONT_SIZES scale
// (default-shape-constants.ts:20-25).
const TEXT_FONT_SIZE_PX: Readonly<Record<string, number>> = Object.freeze({ s: 18, m: 24, l: 36, xl: 44 })
const DEFAULT_SIZE = 'm' // TextShapeUtil.tsx:95 getDefaultProps
const LINE_HEIGHT = 1.35 // theme.lineHeight, defaultThemes.ts:17

// start/middle/end -> left/center/right (see GROUNDING > ALIGN above).
const TEXT_ALIGN_CSS: Readonly<Record<string, 'left' | 'center' | 'right'>> = Object.freeze({
  start: 'left',
  middle: 'center',
  end: 'right',
})
const DEFAULT_ALIGN = 'start' // TextShapeUtil.tsx:98 getDefaultProps

export interface TextStyle {
  readonly color: string
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly textAlign: 'left' | 'center' | 'right'
}

/** Pure style resolver — color/font/size/align, derived from `shape.props`
 * the same way v1's TextShapeUtil resolves its display values (light theme
 * only — see module header). Reads the real tldraw field names
 * (`props.textAlign`, NOT `props.align`) since those are what a lossless
 * converter actually carries through onto the model (see MODEL PROPS
 * above) even though the model's typed schema doesn't name them. */
export function textStyle(shape: ShapeBodyProps['shape']): TextStyle {
  const props = shape.props as Record<string, unknown>

  const color = typeof props.color === 'string' && props.color in TEXT_SOLID ? props.color : DEFAULT_COLOR
  const font = typeof props.font === 'string' && props.font in TEXT_FONT_FAMILY ? props.font : DEFAULT_FONT
  const size = typeof props.size === 'string' && props.size in TEXT_FONT_SIZE_PX ? props.size : DEFAULT_SIZE
  const align = typeof props.textAlign === 'string' && props.textAlign in TEXT_ALIGN_CSS ? props.textAlign : DEFAULT_ALIGN

  return {
    color: TEXT_SOLID[color],
    fontFamily: TEXT_FONT_FAMILY[font],
    fontSize: TEXT_FONT_SIZE_PX[size],
    lineHeight: LINE_HEIGHT,
    textAlign: TEXT_ALIGN_CSS[align],
  }
}

/** Best-effort text content, live-doc first — a DELIBERATELY TRUNCATED
 * version of label.ts's `labelOf` (see GROUNDING > TEXT CONTENT above): same
 * live-getText-then-richText order, but stops there — the final fallback is
 * the EMPTY STRING, never `shape.props.name` (not a field on the text kind)
 * or `shape.kind` (the literal string "text", which v1 never shows for an
 * empty text shape). */
export function textContent(shape: ShapeBodyProps['shape'], getText?: (id: string) => string): string {
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

export function TextShape({ shape, getText }: ShapeBodyProps) {
  const style = textStyle(shape)
  const text = textContent(shape, getText)
  return (
    <div
      data-shape-body="text"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: 'transparent',
        border: 'none',
        overflow: 'hidden',
        overflowWrap: 'break-word',
        whiteSpace: 'pre-wrap',
        padding: 0,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: 'normal', // TEXT_PROPS.fontWeight, default-shape-constants.ts:5
        fontStyle: 'normal', // TEXT_PROPS.fontStyle, default-shape-constants.ts:7
        color: style.color,
        textAlign: style.textAlign,
      }}
    >
      {text}
    </div>
  )
}
