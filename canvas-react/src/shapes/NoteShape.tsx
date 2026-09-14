// The sticky-note body (Task C1 — "the wireframe fix"). Replaces the blue
// BoxShape fallback for `note`-kind shapes with a real colored sticky:
// v1-matched fill/border, the shared label resolver (label.ts, live doc text
// first), a corner author badge, and v1's handwriting font-family. Pure
// presentational — no snapshot read (content-memo friendly per this
// package's MEMO STRATEGY, shapeRegistry.ts), no side effects.
//
// GROUNDING (do not re-derive without re-checking these — v1 is the source
// of truth for every value below):
//
// COLOR → FILL: canvas-model's `note` kind carries `props.color` as one of
// the 13 tldraw palette names (contracts/src/constants.ts's NOTE_COLORS,
// re-exported by server/src/canvas/constants.ts — the same list both
// `/api/canvas/sticky` (server/src/features/sticky.ts:33) and
// `/api/canvas/shape` validate against). v1's NoteShapeUtil resolves a
// note's background via `getColorValue(colors, color, 'noteFill')`
// (node_modules/tldraw/src/lib/shapes/note/NoteShapeUtil.tsx:119), where
// `colors` is `theme.colors[colorMode]` — the LIGHT-mode hex values below
// are copied verbatim from tldraw's own editor package, in
// lib/editor/managers/ThemeManager/defaultThemes.ts:146-353's `noteFill`
// entries (the "editor" package in the tldraw scope on npm).
// Light mode only: the client force-seeds every user onto
// `colorScheme: 'light'` once (client/src/App.tsx:198-203, the "paper-light"
// migration), and canvas-react/the v2 client have no theme toggle yet, so
// dark-mode noteFill is out of scope until one exists. `noteBorder` (a
// theme-level field, not per-color) is defaultThemes.ts:138
// `'rgb(144, 144, 144)'`; `noteText` is `'#000000'` for EVERY color in light
// mode (defaultThemes.ts, same range) — v1's default `labelColor: 'black'`
// resolves through `noteText`, so black text is correct regardless of the
// sticky's own color.
//
// AUTHOR BADGE: `shape.meta.author` — confirmed against the real write
// path, not guessed. Both agent-facing routes that create a note
// (`/api/canvas/sticky`, server/src/features/sticky.ts:85, and
// `/api/canvas/shape`, server/src/features/shape.ts:289) stamp
// `meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {}`
// via server/src/kernel/attribution.ts's `resolveAttribution` — `metaAuthor`
// is set ONLY for a credentialed caller (human SSO or bot service-token),
// never fabricated from a body-supplied name. The tldraw→model converter
// (server/src/canvas-v2/convert.ts:27, `meta: r.meta ?? {}`) passes `meta`
// through byte-for-byte, so `shape.meta.author` is the exact same string in
// the model. An anonymous write's `meta` is `{}` (e2e's seedGoldenBoard,
// e2e/lib/seed.ts, creates notes exactly this way in the test environment —
// no CF Access header, no service token — so its real seeded notes carry NO
// author key), which is why an absent/non-string `meta.author` renders no
// badge at all rather than a placeholder.
//
// FONT / SIZE / EMPTY-LABEL FIX (label-render task): v1's note reads props.
// font (any of the four DefaultFontFamilies, NOT a fixed 'draw' — a stray
// earlier grounding note above over-claimed every route stamps 'draw'; a
// synced v1 doc's note.props.font is a REAL passthrough field, same as
// TextShape.tsx/GeoShape.tsx's own font tables) and props.size (theme.
// fontSize(16) * LABEL_FONT_SIZES[size] -> 18/22/26/32px, default 'm' ->
// 22px — NoteShapeUtil.tsx:126-127, default-shape-constants.ts:28-33) to
// resolve its label typography — this module previously hardcoded BOTH to
// a single family/16px regardless of props, which GeoShape.tsx/TextShape.tsx
// were already fixed to avoid. The PARITY GAP on the actual webfont ASSET
// (tldraw_draw/_sans/_serif/_mono are never registered outside a live
// `<Tldraw>` instance, so they fall through to each family's generic tail)
// still applies to all four, unchanged from the note above this one.
//
// EMPTY LABEL FIX: v1's RichTextLabel.tsx returns null (`!isEditing &&
// isEmpty`) for a note with no text — this module used to call the SHARED
// `labelOf` resolver, whose final fallback is the shape's own KIND STRING,
// so a brand-new note rendered the literal word "note". `noteLabel` below
// mirrors GeoShape.tsx's `geoLabel`/TextShape.tsx's `textContent`: same
// live-getText-then-richText order, truncated BEFORE that kind-string tail.
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { flattenRichText } from './label.js'

// v1's noteFill per NOTE_COLORS palette name, light theme (see GROUNDING
// above). Keys match contracts/src/constants.ts's NOTE_COLORS exactly.
const NOTE_FILL: Readonly<Record<string, string>> = Object.freeze({
  black: '#FCE19C',
  grey: '#C0CAD3',
  'light-violet': '#DFB0F9',
  violet: '#DB91FD',
  blue: '#8AA3FF',
  'light-blue': '#9BC4FD',
  yellow: '#FED49A',
  orange: '#FAA475',
  green: '#6FC896',
  'light-green': '#98D08A',
  'light-red': '#F7A5A1',
  red: '#FC8282',
  white: '#FFFFFF',
})

// tldraw's own NoteShapeUtil.getDefaultProps() default `color` is 'black'
// (node_modules/tldraw/src/lib/shapes/note/NoteShapeUtil.tsx:170) — used
// here as the fallback for a note with no (or an unrecognized) `props.color`,
// for the same reason: a truly default, un-styled note still gets a fill.
const DEFAULT_COLOR = 'black'
const NOTE_BORDER = 'rgb(144, 144, 144)' // theme.colors.light.noteBorder
const NOTE_TEXT = '#000000' // theme.colors.light.<every color>.noteText

// tldraw's "tlschema" package's DefaultFontFamilies (styles/TLFontStyle.ts:
// 83-88) — the SAME table GeoShape.tsx/TextShape.tsx already carry; a
// note's `props.font` genuinely varies (see FONT / SIZE FIX above), it is
// not fixed to 'draw'.
const FONT_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  draw: "'tldraw_draw', sans-serif",
  sans: "'tldraw_sans', sans-serif",
  serif: "'tldraw_serif', serif",
  mono: "'tldraw_mono', monospace",
})
const DEFAULT_FONT = 'draw' // NoteShapeUtil.tsx:173 getDefaultProps

// theme.fontSize(16) * LABEL_FONT_SIZES[size] (NoteShapeUtil.tsx:126-127,
// default-shape-constants.ts:28-33) — the SAME s/m/l/xl -> 18/22/26/32
// table GeoShape.tsx's own (module-private) LABEL_FONT_SIZE_PX carries;
// notes and geo share the identical formula, they just never shared the
// literal table (each shape module owns its own copy, same pattern as
// GEO_COLORS/TEXT_SOLID not being shared either).
const LABEL_FONT_SIZE_PX: Readonly<Record<string, number>> = Object.freeze({ s: 18, m: 22, l: 26, xl: 32 })
const DEFAULT_SIZE = 'm' // NoteShapeUtil.tsx:172 getDefaultProps

// The note body's fixed line-height (theme.lineHeight, defaultThemes.ts) —
// UNLIKE font size, v1's labelLineHeight does not vary by `size`. Exported
// so TextEditor.tsx's editing overlay reuses the EXACT SAME number (not
// re-derive/duplicate it) when deriving its own font/size for a note being
// edited — see TextEditor.tsx's `editorTextStyle`.
export const NOTE_LABEL_LINE_HEIGHT = 1.35

// text-autosize fixer task: the note body's own rendered padding (below),
// exported so TextEditor.tsx's autosize MEASUREMENT can match it exactly.
// Deliberately NOT the same value as editorTextStyle's editing-textarea
// `padding: 4` — that 4px is a purely visual choice for the caret's editing
// box (see TextEditor.tsx's PARITY GAP note) and was never meant to stand in
// for the static body's real 16px inset. Measuring wrap/height against the
// wrong (smaller) padding wraps text at a wider effective column than the
// body actually renders, so `computeAutosizeProps` under-computes growY and
// the static body clips text the moment editing ends — the exact defect a
// validator round caught via the new `labelOverflow` contract check.
export const NOTE_LABEL_PADDING = 16

// Deterministic per-id "lift"/"jitter" for the drop shadow below — a djb2
// hash (the SAME idiom as Cursors.tsx's `colorForKey`; NOT Math.random, so
// a given note always renders an IDENTICAL shadow — pure and reproducible,
// unlike v1's own `rng(id)`, an internal seeded PRNG this clean-room
// package cannot import (a scoped "editor" package this app doesn't
// depend on). Two independent draws (":lift"/":jitter" suffixes) mirror
// v1's `getNoteShadow` calling its seeded rng() twice — once for `lift`,
// once for the third shadow layer's opacity jitter.
function djb2(key: string): number {
  let hash = 5381
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33 + key.charCodeAt(i)) | 0 // |0 keeps this a 32-bit int, matching djb2's usual overflow behavior
  }
  return hash
}
function unitFraction(key: string): number {
  return (Math.abs(djb2(key)) % 1000) / 1000 // deterministic pseudo-random value in [0, 1)
}

// NoteShapeUtil.tsx:339's `useEfficientZoomThreshold(0.25 / scale)` — v2
// notes carry no `scale` prop (always effectively 1, unlike v1's own
// auto-shrink `props.scale`), so the threshold is the bare 0.25.
const SHADOW_HIDE_ZOOM_THRESHOLD = 0.25

/** v1's `getNoteShadow` (NoteShapeUtil.tsx:751-763) — a per-id seeded,
 * rotation-aware three-layer box-shadow. Reproduced with a deterministic
 * hash (see djb2/unitFraction above) rather than v1's actual `rng`; same
 * formula shape, a different (equally pure) source of "lift"/"jitter".
 * NO multiplication by a `scale` factor here (unlike v1's `* scale` terms):
 * WorldLayer applies exactly ONE `scale(camera.z)` CSS transform to the
 * whole world (WorldLayer.tsx), so any world-space px value drawn here is
 * already re-scaled by the browser for free — multiplying by zoom a second
 * time here would double-apply it. */
export function noteShadow(id: string, rotation: number): string {
  const lift = unitFraction(`${id}:lift`) + 0.5 // v1: Math.abs(random()) + 0.5, range [0.5, 1.5)
  const jitter = unitFraction(`${id}:jitter`)
  const oy = Math.cos(rotation)
  const a = 5
  const b = 4
  const c = 6
  const d = 7
  const layer1 = `0px ${Math.max(0, a - lift)}px ${a}px -${a}px rgba(15, 23, 31, .6)`
  const layer2 = `0px ${(b + lift * d) * Math.max(0, oy)}px ${c + lift * d}px -${b + lift * c}px rgba(15, 23, 31, ${(0.3 + lift * 0.1).toFixed(2)})`
  const layer3 = `0px 48px 10px -10px inset rgba(15, 23, 44, ${((0.022 + jitter * 0.005) * ((1 + oy) / 2)).toFixed(2)})`
  return `${layer1}, ${layer2}, ${layer3}`
}

// props.align (DefaultHorizontalAlignStyle — start/middle/end plus the three
// -legacy variants, default 'middle', same enum GeoShape.tsx's ALIGN_CSS
// documents) -> the body's own text-align/justify-content (the note body IS
// the flex/label container — no separate label div, unlike GeoShape). Keyed
// only by the three PRIMARY values; `normalizeAlign` strips a `-legacy`
// suffix before indexing here so the legacy variants render identically to
// their base rather than falling through to the default.
const ALIGN_CSS: Readonly<Record<string, { textAlign: 'left' | 'center' | 'right'; justifyContent: 'flex-start' | 'center' | 'flex-end' }>> =
  Object.freeze({
    start: { textAlign: 'left', justifyContent: 'flex-start' },
    middle: { textAlign: 'center', justifyContent: 'center' },
    end: { textAlign: 'right', justifyContent: 'flex-end' },
  })
const DEFAULT_ALIGN = 'middle' // DefaultHorizontalAlignStyle defaultValue

// props.verticalAlign (DefaultVerticalAlignStyle — start/middle/end only) ->
// align-items.
const VERTICAL_ALIGN_CSS: Readonly<Record<string, 'flex-start' | 'center' | 'flex-end'>> = Object.freeze({
  start: 'flex-start',
  middle: 'center',
  end: 'flex-end',
})
const DEFAULT_VERTICAL_ALIGN = 'middle' // DefaultVerticalAlignStyle defaultValue

/** `props.align`, stripped of a trailing `-legacy` (real accepted values a
 * synced document may carry — must render identically to their base, not
 * fall through to the default). Unrecognized/absent -> v1's own 'middle'. */
function normalizeAlign(align: unknown): keyof typeof ALIGN_CSS {
  if (typeof align !== 'string') return DEFAULT_ALIGN
  const base = align.endsWith('-legacy') ? align.slice(0, -'-legacy'.length) : align
  return base in ALIGN_CSS ? (base as keyof typeof ALIGN_CSS) : DEFAULT_ALIGN
}

/** `props.verticalAlign`, defaulted to v1's own 'middle' — no `-legacy`
 * variants exist for this axis. */
function normalizeVerticalAlign(verticalAlign: unknown): keyof typeof VERTICAL_ALIGN_CSS {
  return typeof verticalAlign === 'string' && verticalAlign in VERTICAL_ALIGN_CSS
    ? (verticalAlign as keyof typeof VERTICAL_ALIGN_CSS)
    : DEFAULT_VERTICAL_ALIGN
}

export interface NoteStyle {
  readonly background: string
  readonly borderColor: string
  readonly color: string
  readonly fontFamily: string
  /** Resolved from `props.size` (LABEL_FONT_SIZES table above); 22px
   * (size 'm') when absent or unrecognized (v1 default). */
  readonly fontSize: number
  /** Resolved from `props.align` (Task R3); 'center' when absent or
   * unrecognized (v1 default). */
  readonly textAlign: 'left' | 'center' | 'right'
  readonly justifyContent: 'flex-start' | 'center' | 'flex-end'
  /** Resolved from `props.verticalAlign`; 'center' when absent (v1 default). */
  readonly alignItems: 'flex-start' | 'center' | 'flex-end'
}

/** Pure style resolver — the sticky's background/border/text-color/font/
 * size/align, derived from `props.color`/`props.font`/`props.size`/
 * `props.align`/`props.verticalAlign` the same way v1's NoteShapeUtil
 * resolves noteFill/noteBorder/noteText/labelFontFamily/labelFontSize
 * (light theme only — see module header). */
export function noteStyle(shape: ShapeBodyProps['shape']): NoteStyle {
  const props = shape.props as Record<string, unknown>
  const color = typeof props.color === 'string' && props.color in NOTE_FILL ? props.color : DEFAULT_COLOR
  const font = typeof props.font === 'string' && props.font in FONT_FAMILY ? props.font : DEFAULT_FONT
  const size = typeof props.size === 'string' && props.size in LABEL_FONT_SIZE_PX ? props.size : DEFAULT_SIZE
  const align = ALIGN_CSS[normalizeAlign(props.align)]
  const alignItems = VERTICAL_ALIGN_CSS[normalizeVerticalAlign(props.verticalAlign)]
  return {
    background: NOTE_FILL[color],
    borderColor: NOTE_BORDER,
    color: NOTE_TEXT,
    fontFamily: FONT_FAMILY[font],
    fontSize: LABEL_FONT_SIZE_PX[size],
    textAlign: align.textAlign,
    justifyContent: align.justifyContent,
    alignItems,
  }
}

/** `shape.meta.author` — the trusted, credential-stamped identity (see
 * module header). Absent/non-string/empty → no badge, never fabricated. */
export function authorOf(shape: ShapeBodyProps['shape']): string | null {
  const meta = shape.meta as Record<string, unknown>
  return typeof meta.author === 'string' && meta.author.length > 0 ? meta.author : null
}

/** Best-effort label, live-doc first — a DELIBERATELY TRUNCATED resolver
 * mirroring GeoShape.tsx's `geoLabel`/TextShape.tsx's `textContent` (see
 * this module's EMPTY LABEL FIX header note): same live-getText-then-
 * richText order as label.ts's shared `labelOf`, but truncated BEFORE the
 * props.name/kind-string tail — v1 renders a truly empty note with NO label
 * text at all (RichTextLabel.tsx's own `if (!isEditing && isEmpty) return
 * null`), never the literal string "note". */
export function noteLabel(shape: ShapeBodyProps['shape'], getText?: (id: string) => string): string {
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

export function NoteShape({ shape, getText, editorState }: ShapeBodyProps) {
  const style = noteStyle(shape)
  const author = authorOf(shape)
  // STATIC LABEL HIDDEN WHILE EDITING (gap fix): TextEditor.tsx mounts a
  // sibling textarea overlay while `editorState.editingId === shape.id` —
  // rendering this body's OWN label text at the same time double-draws it
  // underneath the editing surface. `editorState` is optional (most
  // fixtures/goldens omit it, per shapeRegistry.ts's ShapeBodyProps doc
  // comment) — absent means "not editing", never a crash.
  const isEditing = editorState?.editingId === shape.id
  const label = isEditing ? '' : noteLabel(shape, getText)
  // DROP SHADOW / ZOOM-DEPENDENT BORDER (gap fix): v1 hides the seeded
  // shadow below a 0.25 zoom threshold in favor of a cheap flat border
  // (NoteShapeUtil.tsx:339/366-369) — see SHADOW_HIDE_ZOOM_THRESHOLD above.
  // `editorState` absent (most fixtures/goldens) defaults to zoom 1 (the
  // shadow, not the degraded fallback) — the common, "normal viewing" case.
  const zoom = editorState?.camera.z ?? 1
  const hideShadows = zoom < SHADOW_HIDE_ZOOM_THRESHOLD
  return (
    <div
      data-shape-body="note"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        display: 'flex',
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        overflow: 'hidden',
        padding: NOTE_LABEL_PADDING,
        fontSize: style.fontSize,
        lineHeight: NOTE_LABEL_LINE_HEIGHT,
        whiteSpace: 'pre-wrap', // gap fix: preserve newlines the textarea happily accepted (TextEditor.tsx)
        borderRadius: 1, // v1's tldraw.css .tl-note__container { border-radius: 1px }, unconditional
        borderBottom: hideShadows ? `2px solid ${style.borderColor}` : 'none',
        boxShadow: hideShadows ? 'none' : noteShadow(shape.id, shape.rotation),
        background: style.background,
        color: style.color,
        fontFamily: style.fontFamily,
        textAlign: style.textAlign,
        overflowWrap: 'break-word',
      }}
    >
      {label}
      {author && (
        <div
          data-shape-note-author=""
          style={{
            position: 'absolute',
            right: 8,
            bottom: 6,
            fontSize: 11,
            opacity: 0.6,
            fontFamily: 'sans-serif',
          }}
        >
          {author}
        </div>
      )}
    </div>
  )
}
