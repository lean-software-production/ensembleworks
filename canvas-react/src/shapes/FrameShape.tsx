// The frame body (Task C2 — "chrome + label"). Replaces the blue BoxShape
// fallback for `frame`-kind shapes with v1-matched chrome: a near-white
// bordered body plus a small name-label header pinned above the top-left
// corner. Pure presentational — no snapshot read (content-memo friendly per
// this package's MEMO STRATEGY, shapeRegistry.ts), no side effects, and
// (load-bearing, see Seam C context) it renders ONLY its own chrome — it
// does NOT render or contain its children. ShapeLayer already renders every
// shape, including a frame's children, as FLAT SIBLINGS inside WorldLayer's
// one transformed container (ShapeBody.tsx's FLAT SIBLINGS header) — a
// frame body that tried to DOM-nest its children would double-apply the
// parent transform on top of worldTransform's already-parent-inclusive
// value.
//
// GROUNDING (do not re-derive without re-checking these — v1 is the source
// of truth for every value below):
//
// MODEL PROPS: canvas-model's `frame` kind carries `props.name?` only — no
// `color` field (canvas-model/src/shape.ts:51, `frame: box.extend({ name:
// z.string().optional() })`). v1's TLFrameShape DOES carry an optional
// `color` prop, but only takes effect when `showColors` is turned on via
// `FrameShapeUtil.configure({ showColors: true })`
// (node_modules/tldraw/src/lib/shapes/frame/FrameShapeUtil.tsx:110-119,
// the "evil crimes" `configure` override) — grepping this app's client/server
// for `showColors`/`FrameShapeUtil` turns up NO such call site, so this app
// runs v1's frame with the DEFAULT `showColors: false`
// (FrameShapeUtil.tsx:82). With colors off, v1's own
// `getDefaultDisplayValues` (FrameShapeUtil.tsx:84-99) resolves every color
// through the FIXED 'black' palette entry regardless of `shape.props.color`
// — so there is no per-frame color to thread through even if our model had
// the field, and hard-coding the 'black'-palette values below is the correct
// parity target, not a shortcut.
//
// BODY FILL/BORDER: v1's `component()` renders an SVG `<rect>` whose
// fill/stroke come from `dv.fillColor`/`dv.strokeColor`
// (FrameShapeUtil.tsx:264-273), i.e. (showColors off)
// `getColorValue(colors, 'black', 'frameFill'/'frameStroke')` — LIGHT-mode
// hex values copied verbatim from the "editor" package in the tldraw scope
// on npm's own lib/editor/managers/ThemeManager/defaultThemes.ts:153 (`frameFill:
// '#ffffff'`) and :152 (`frameStroke: '#717171'`), under `colors.light.black`.
// Light mode only, same posture as NoteShape.tsx's GROUNDING block: the
// client force-seeds `colorScheme: 'light'` (client/src/App.tsx:198-203) and
// canvas-react has no theme toggle yet.
//
// HEADER FILL/BORDER/TEXT: v1's `<FrameHeading>` receives `fill`/`stroke`
// from `dv.headingFillColor`/`dv.headingStrokeColor`
// (FrameShapeUtil.tsx:279-281), which `getDefaultDisplayValues` sets to
// `colors.negativeSpace` for BOTH fields (FrameShapeUtil.tsx:92-93) — NOT
// the per-color `frameHeadingFill`/`frameHeadingStroke` entries (those only
// feed `showColorsHeadingFillColor`/`showColorsHeadingStrokeColor`, dead
// with colors off). `colors.light.negativeSpace` is defaultThemes.ts:135,
// `'#f9fafb'` — so header fill and header border resolve to the EXACT SAME
// hex in this app; the boxShadow-style inset border FrameHeading.tsx:74
// draws is only visually distinguishable against the frame body's white,
// not against itself. `headingTextColor` is
// `getColorValue(colors, 'black', 'frameText')` (FrameShapeUtil.tsx:94) =
// defaultThemes.ts:154, `'#000000'`.
//
// HEADER GEOMETRY: v1's CSS (`node_modules/tldraw/tldraw.css:1237-1264`,
// `.tl-frame-heading`/`.tl-frame-heading-hit-area`) pins the header above
// the frame's top-left corner (`bottom: 100%`), `height: 24px`,
// `font-size: 12px`, `padding: 0 6px` (`--tl-frame-padding-x: 6px` on
// `.tl-frame-label`, tldraw.css:1270), `border-radius: 4px`
// (`--tl-radius-1`, tldraw.css:24).
//
// LABEL TEXT: v1's `getText(shape)` returns `shape.props.name` verbatim
// (FrameShapeUtil.tsx:235-237) — matching canvas-model's own frame props
// (`name?`), so this body reads `shape.props.name` DIRECTLY rather than
// going through label.ts's `labelOf` shared resolver: `labelOf`'s fallback
// chain, for a kind that ISN'T `isTextCapableKind` (frame is deliberately
// excluded — canvas-model/src/shape.ts:23, "'frame' (a container, not text
// content)"), skips the live-text branch entirely and would fall through
// past an absent/empty `name` to the RAW KIND STRING (`labelOf`'s final
// `return shape.kind`) — i.e. the lowercase literal `"frame"`. That is NOT
// what v1 shows for an unnamed frame: v1's `FrameLabelInput`
// (node_modules/tldraw/src/lib/shapes/frame/components/FrameLabelInput.tsx:111,
// via `frameHelpers.ts`'s `defaultEmptyAs(name, 'Frame')`, frameHelpers.ts:
// 11-16) renders the literal placeholder `"Frame"` for an empty/whitespace
// name — capitalized, singular, no shape-kind fallback semantics at all.
// So this module implements that exact rule itself (`frameLabel` below)
// rather than reusing `labelOf`.
import type { ShapeBodyProps } from '../shapeRegistry.js'

const FRAME_FILL = '#ffffff' // colors.light.black.frameFill
const FRAME_STROKE = '#717171' // colors.light.black.frameStroke
const HEADER_FILL = '#f9fafb' // colors.light.negativeSpace
const HEADER_BORDER = '#f9fafb' // colors.light.negativeSpace (same value — see GROUNDING)
const HEADER_TEXT = '#000000' // colors.light.black.frameText
const HEADER_HEIGHT = 24 // --tl-frame-height, tldraw.css:1239
const HEADER_RADIUS = 4 // --tl-radius-1, tldraw.css:24
const HEADER_FONT_SIZE = 12 // .tl-frame-heading, tldraw.css:1250
const HEADER_PADDING_X = 6 // --tl-frame-padding-x, tldraw.css:1238
const DEFAULT_LABEL = 'Frame' // frameHelpers.ts's defaultEmptyAs(name, 'Frame')

/** `shape.props.name`, defaulted to the literal `"Frame"` for an
 * empty/whitespace/absent name — mirrors v1's `defaultEmptyAs` exactly (see
 * module header LABEL TEXT). */
export function frameLabel(shape: ShapeBodyProps['shape']): string {
  const props = shape.props as Record<string, unknown>
  const name = typeof props.name === 'string' ? props.name : ''
  return name.trim().length > 0 ? name : DEFAULT_LABEL
}

/** Presentational chrome only — border + translucent/near-white fill + name
 * header. Deliberately does NOT render `shape`'s children: ShapeLayer
 * renders every shape (including a frame's children) as flat siblings (see
 * module header) — this component's whole DOM subtree is exactly the chrome
 * below, nothing more. */
export function FrameShape({ shape }: ShapeBodyProps) {
  const label = frameLabel(shape)
  return (
    <div
      data-shape-body="frame"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        border: `1px solid ${FRAME_STROKE}`,
        background: FRAME_FILL,
      }}
    >
      <div
        data-shape-frame-header=""
        style={{
          position: 'absolute',
          left: 0,
          bottom: '100%',
          height: HEADER_HEIGHT,
          maxWidth: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${HEADER_PADDING_X}px`,
          fontSize: HEADER_FONT_SIZE,
          borderRadius: HEADER_RADIUS,
          background: HEADER_FILL,
          boxShadow: `inset 0 0 0 1px ${HEADER_BORDER}`,
          color: HEADER_TEXT,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
    </div>
  )
}
