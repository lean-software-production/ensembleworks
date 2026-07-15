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
// HANDWRITING FONT: v1 always stamps a note's `props.font` as `'draw'`
// (server/src/features/sticky.ts:91, server/src/features/shape.ts:494 — no
// route ever varies it), whose CSS family is `"'tldraw_draw', sans-serif"`
// (tldraw's "tlschema" package, `DefaultFontFamilies.draw`, in
// styles/TLFontStyle.ts:84). PARITY GAP, noted rather than silently assumed
// away: the actual `tldraw_draw` webfont file is registered at runtime by
// tldraw's own FontManager (the "editor" package's FontManager.ts,
// `new FontFace(...)` + `document.fonts`), which only runs inside a live
// `<Tldraw>` editor instance
// (client/src/App.tsx). The v2 client (client/src/canvas-v2/CanvasV2App.tsx)
// never mounts `<Tldraw>`, and `client/index.html` loads only Google-hosted
// JetBrains Mono / PT Sans / Source Serif 4 — no `tldraw_draw` face at all.
// So today, on the v2 client, this family falls through to the `sans-serif`
// tail of the stack — a real, currently-unclosed parity gap the Seam F
// golden harness should catch, not this unit (loading the actual webfont
// asset for the v2 bundle is client-workspace scope, outside canvas-react's
// clean-room and outside this task's file list). Declaring the same
// `font-family` string here is still the right move: it's forward-compatible
// with that follow-up and degrades gracefully in the meantime.
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { labelOf } from './label.js'

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
const HANDWRITING_FONT = "'tldraw_draw', sans-serif" // DefaultFontFamilies.draw

export interface NoteStyle {
  readonly background: string
  readonly borderColor: string
  readonly color: string
  readonly fontFamily: string
}

/** Pure style resolver — the sticky's background/border/text-color/font,
 * derived from `props.color` the same way v1's NoteShapeUtil resolves
 * noteFill/noteBorder/noteText (light theme only — see module header). */
export function noteStyle(shape: ShapeBodyProps['shape']): NoteStyle {
  const props = shape.props as Record<string, unknown>
  const color = typeof props.color === 'string' && props.color in NOTE_FILL ? props.color : DEFAULT_COLOR
  return {
    background: NOTE_FILL[color],
    borderColor: NOTE_BORDER,
    color: NOTE_TEXT,
    fontFamily: HANDWRITING_FONT,
  }
}

/** `shape.meta.author` — the trusted, credential-stamped identity (see
 * module header). Absent/non-string/empty → no badge, never fabricated. */
export function authorOf(shape: ShapeBodyProps['shape']): string | null {
  const meta = shape.meta as Record<string, unknown>
  return typeof meta.author === 'string' && meta.author.length > 0 ? meta.author : null
}

export function NoteShape({ shape, getText }: ShapeBodyProps) {
  const style = noteStyle(shape)
  const author = authorOf(shape)
  return (
    <div
      data-shape-body="note"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        padding: 16,
        fontSize: 16,
        lineHeight: 1.35,
        borderBottom: `2px solid ${style.borderColor}`,
        background: style.background,
        color: style.color,
        fontFamily: style.fontFamily,
        textAlign: 'center',
        overflowWrap: 'break-word',
      }}
    >
      {labelOf(shape, getText)}
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
