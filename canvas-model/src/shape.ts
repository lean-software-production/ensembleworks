import { z } from 'zod'
import { shapeIdField, parentIdField, type ShapeId, type ParentId } from './ids.js'

// The shape kinds a room can contain: tldraw defaults we use (incl. 'group' —
// a structural container users create with Ctrl+G; dropping it would orphan
// its children's parentId chains) + image + the six custom HTML-box shapes
// (contracts/src/shapes.ts).
export const SHAPE_KINDS = [
  'note', 'text', 'geo', 'arrow', 'frame', 'group', 'line', 'draw', 'highlight', 'image',
  'terminal', 'iframe', 'neko', 'roadmap', 'screenshare', 'file-viewer',
] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

// The kinds eligible for the plain-text editing mount (canvas-react's
// TextEditor.tsx) and its double-click-to-edit trigger (canvas-editor's
// select tool, Unit 13) — deliberately a static, kind-name-only allowlist,
// not a runtime registry lookup: canvas-editor may never import canvas-react
// (its own boundary test forbids a react dependency at all), so it has no way
// to consult canvas-react's `isEmbedKind` registry (canvas-react/src/
// shapeRegistry.ts) even if it wanted to. Living here instead — a fixed,
// pure fact about a ShapeKind literal, exactly like SHAPE_KINDS itself — is
// the seam BOTH packages can share with no cross-import at all.
// EXCLUDED, deliberately: 'frame' (a container, not text content), 'arrow'
// (its optional label is real richText too, but arrow-label double-click
// editing is a documented Phase-4 parity gap, not this unit's scope), every
// structural kind (group/line/draw/highlight/image), and the six custom
// HTML-embed kinds (terminal/iframe/neko/roadmap/screenshare/file-viewer) —
// none of which carry a plain-text body a textarea could ever edit.
export const TEXT_CAPABLE_KINDS = ['note', 'text', 'geo'] as const
export type TextCapableKind = (typeof TEXT_CAPABLE_KINDS)[number]

/** True iff `kind` is one of TEXT_CAPABLE_KINDS above. */
export function isTextCapableKind(kind: ShapeKind): boolean {
  return (TEXT_CAPABLE_KINDS as readonly string[]).includes(kind)
}

// Rich text is ProseMirror JSON; we keep it verbatim for lossless round-trip and
// derive plain text for semantics. Structural (not exhaustively typed).
const richText = z.object({ type: z.literal('doc'), content: z.array(z.any()) })

// tldraw's default color palette (shared by note/text/geo/arrow), copied
// verbatim from tldraw's DefaultColorStyle value set. This package is
// clean-room and may never import the tldraw package itself, so the list is
// hand-verified against the installed dependency rather than imported from
// it. tldraw CAN register additional palette colors at runtime from custom
// themes (a theme's color keys get synced onto the style's accepted values),
// but this deployment's sync client passes no custom themes and nothing in
// this codebase calls the theme/color registration API, so the resolved
// palette is exactly these 13 defaults with nothing added or removed. If a
// custom theme ever gets wired into the sync client, any palette colors it
// adds would be silently dropped at this write boundary until this enum
// grows to match — this list must track whatever the sync client actually
// resolves, not just tldraw's out-of-the-box default.
const COLOR = z.enum([
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
])

// Task M2 — the rest of tldraw's closed style value-sets, each hand-verified
// against the installed tlschema dependency's `src/` tree (clean-room: this
// package may never import that dependency itself, so these are copied values,
// not imported types). One enum per `Default*Style`/`*ArrowheadStyle` export;
// see each constant's comment for the exact source file and export read.

// styles/TLFillStyle.ts, DefaultFillStyle. Renderer support for all six is
// already in canvas-react's GeoShape.tsx (see its FILL comment block).
const FILL = z.enum(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'])

// styles/TLDashStyle.ts, DefaultDashStyle. NOTE: the plan's Decisions section
// lists only draw/solid/dashed/dotted (4) — the installed tlschema (5.1.0)
// actually defines a 5th value, 'none', matching canvas-react's GeoShape.tsx
// dash comment which is *also* stale on this point. Included here because
// omitting a real tldraw value would drop any shape that carries it at the
// write boundary (the risk this task exists to avoid) — flagged as a plan
// discrepancy, not silently "corrected" without a paper trail.
const DASH = z.enum(['draw', 'solid', 'dashed', 'dotted', 'none'])

// styles/TLSizeStyle.ts, DefaultSizeStyle.
const SIZE = z.enum(['s', 'm', 'l', 'xl'])

// styles/TLFontStyle.ts, DefaultFontStyle. tldraw can grow this set at
// runtime via theme font registration (registerFontsFromThemes) exactly like
// COLOR's theme caveat above; nothing in this codebase calls that API, so the
// resolved set is exactly these 4 defaults.
const FONT = z.enum(['draw', 'sans', 'serif', 'mono'])

// styles/TLHorizontalAlignStyle.ts, DefaultHorizontalAlignStyle. This is the
// `align` prop on note/geo (and arrow labels) — NOT the same enum as `text`'s
// `textAlign` below. Includes the three `-legacy` variants: older documents
// carry them and they must round-trip, even though no current tool writes
// them. The plan's Decisions section names only start/middle/end; the three
// `-legacy` members are real tlschema values omitted there (see plan's own
// "CRITICAL RISK" callout, which explicitly says to get these exact names).
const ALIGN = z.enum(['start', 'middle', 'end', 'start-legacy', 'end-legacy', 'middle-legacy'])

// styles/TLVerticalAlignStyle.ts, DefaultVerticalAlignStyle.
const VERTICAL_ALIGN = z.enum(['start', 'middle', 'end'])

// styles/TLTextAlignStyle.ts, DefaultTextAlignStyle. The `text` kind's own
// alignment prop (`props.textAlign`) — a distinct StyleProp from ALIGN above
// even though the value sets happen to overlap; text shapes use this one,
// note/geo use ALIGN. Confirmed against TLTextShapeProps vs TLNoteShapeProps/
// TLGeoShapeProps, which use different prop names for exactly this reason.
const TEXT_ALIGN = z.enum(['start', 'middle', 'end'])

// shapes/TLGeoShape.ts, GeoShapeGeoStyle. Cross-checked against the repo's
// own `GEO_TYPES` in contracts/src/constants.ts — identical, 20 values, same
// order; no discrepancy.
const GEO = z.enum([
  'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon',
  'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
  'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box',
  'heart',
])

// shapes/TLArrowShape.ts, `arrowheadTypes` (shared by both
// ArrowShapeArrowheadStartStyle and ArrowShapeArrowheadEndStyle — one value
// set, two independent props, default 'none' for start and 'arrow' for end).
const ARROWHEAD = z.enum(['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none'])

// The style axes typed so far, keyed by the prop name they live under. One
// map so `styleProps(...)` below and any future caller share a single
// source of truth instead of re-listing enums per kind.
const STYLE_ENUMS = {
  color: COLOR,
  fill: FILL,
  dash: DASH,
  size: SIZE,
  font: FONT,
  align: ALIGN,
  verticalAlign: VERTICAL_ALIGN,
  textAlign: TEXT_ALIGN,
  geo: GEO,
  arrowheadStart: ARROWHEAD,
  arrowheadEnd: ARROWHEAD,
} as const
type StyleAxis = keyof typeof STYLE_ENUMS

// Task M3 — a UI-consumable value list per style axis, derived FROM
// STYLE_ENUMS's Zod enums via `.options` (zod v4's array-of-accepted-values
// accessor, in declaration order) rather than a second hand-maintained copy.
// This is what makes drift structurally impossible: STYLE_ENUMS is what
// `styleProps`/`propsByKind` above validate writes against, and this export
// reads the SAME enum objects, so editing an axis here (e.g. adding a new
// DASH value) changes both validation and this export in the same edit —
// there is no second list to forget. Consumers (e.g. client/src/canvas-v2/
// style-axes.ts's styling panel) import this instead of hand-copying
// tldraw's palette.
export const STYLE_VALUE_SETS: { [K in StyleAxis]: readonly string[] } = Object.fromEntries(
  (Object.keys(STYLE_ENUMS) as StyleAxis[]).map((axis) => [axis, STYLE_ENUMS[axis].options]),
) as unknown as { [K in StyleAxis]: readonly string[] }

// Shared fragment builder: given a list of style axes, returns a loose
// object exposing exactly those keys as optional tldraw-parity enums.
// Loose (not strict) so composing it onto a per-kind schema via `.extend()`
// never seals that schema — unknown, non-style tldraw props must keep
// passing through losslessly (CRDT forward-compat), only the named axes gain
// closed-set validation. Kind schemas below request only the axes real
// tldraw gives that shape kind (the Decisions "kind→axis map"); an axis not
// requested for a kind is simply never type-checked there and rides through
// as an ordinary passthrough key (e.g. `geo` on a `text` shape).
function styleProps<A extends readonly StyleAxis[]>(...axes: A) {
  const shape = {} as Record<StyleAxis, z.ZodOptional<(typeof STYLE_ENUMS)[StyleAxis]>>
  for (const axis of axes) shape[axis] = STYLE_ENUMS[axis].optional()
  return z.looseObject(shape)
}

// Per-kind props: type the fields semantics reads; passthrough the rest so no
// tldraw prop is lost. All keys optional except where a field is load-bearing.
const withText = z.looseObject({ richText: richText.optional() })
const box = z.looseObject({ w: z.number().optional(), h: z.number().optional() })

// Task M1 (2026-07-22 draw sub-cycle) -- a stroke point: v1 VecModel
// {x, y, z} where z = pressure 0..1. LOOSE so a point carrying extra keys
// still passes; x/y REQUIRED numbers so a malformed point (missing/non-number
// coord) is caught; z OPTIONAL (v1 pen points always have it, simulated-
// pressure points may not).
const drawPoint = z.looseObject({ x: z.number(), y: z.number(), z: z.number().optional() })
// A segment: v1 {type:'free'|'straight', points:[...]}. `type` a loose
// string (NOT a closed enum -- future/unknown segment types must ride
// through), `points` optional (a degenerate empty segment still validates).
// NOTE: the installed tldraw tlschema dependency (5.1.0) has since migrated
// segments to carry a delta-encoded base64 `path: string` instead of
// `points` (shapes/TLDrawShape.ts's DrawShapeSegment; this repo's own legacy write path,
// server/src/canvas/drawShapes.ts, already emits that format via
// compressLegacySegments) -- `path` isn't typed here but rides through as an
// ordinary passthrough key on this loose object, so that current real v1
// format validates too, not just the older points-based shape this schema
// types explicitly.
const drawSegment = z.looseObject({ type: z.string().optional(), points: z.array(drawPoint).optional() })

// Task M1 (2026-07-22 line sub-cycle) -- a line handle/point: v1 stores
// `props.points` as a KEYED MAP { [id]: { id, index, x, y } } (verified
// against the installed dependency's line-shape module, `points: T.dict(...)`
// -- read only, never imported; this package stays clean-room). LOOSE so
// extra keys ride through; x/y REQUIRED numbers so a malformed point
// (missing/non-number coord) is caught; id/index OPTIONAL strings (present on
// real v1, our own tool writes them, the renderer tolerates their absence).
const linePoint = z.looseObject({
  x: z.number(), y: z.number(),
  id: z.string().optional(), index: z.string().optional(),
})
// line's `spline` axis: closed enum, kept LOCAL to the line kind rather than
// added to STYLE_ENUMS (that would ripple a new key into STYLE_VALUE_SETS,
// which the client style panel consumes -- an unplanned panel change; see the
// plan's judgment call). Still a closed set, so a bad value is rejected.
const LINE_SPLINE = z.enum(['line', 'cubic'])

const propsByKind: Record<ShapeKind, z.ZodTypeAny> = {
  note: withText.extend(styleProps('color', 'size', 'font', 'align', 'verticalAlign').shape),
  text: withText.extend(styleProps('color', 'size', 'font', 'textAlign').shape),
  geo: withText.extend(box.shape).extend(
    styleProps('color', 'fill', 'dash', 'size', 'font', 'align', 'verticalAlign', 'geo').shape,
  ),
  arrow: withText.extend(styleProps('color', 'fill', 'dash', 'size', 'font', 'arrowheadStart', 'arrowheadEnd').shape),
  frame: box.extend({ name: z.string().optional() }),
  group: z.looseObject({}), // tldraw groups carry no props; container only
  // `points` a KEYED MAP (z.record), NOT z.array -- v1's line shape always
  // carries the dict form (points: T.dict(...)); typing it as an array would
  // silently DROP every real synced v1 line at the write boundary. `spline`
  // is the line-local closed enum above. `w/h` (box.shape) are OUR OWN
  // passthrough (v1 line carries none) for tight localBounds on our own
  // normalized lines.
  line: z.looseObject({
    points: z.record(z.string(), linePoint).optional(),
    spline: LINE_SPLINE.optional(),
  })
    .extend(box.shape)
    .extend(styleProps('color', 'dash', 'size').shape),
  draw: z.looseObject({ segments: z.array(drawSegment).optional(), isPen: z.boolean().optional(), isClosed: z.boolean().optional() })
    .extend(box.shape)
    .extend(styleProps('color', 'fill', 'dash', 'size').shape),
  highlight: z.looseObject({}),
  // Task M2 (2026-07-22 assets/image sub-cycle) -- tldraw's TLImageShape
  // stores `assetId: TLAssetId | null` plus w/h/crop/playing/url/flipX/
  // flipY/altText. Type ONLY assetId (nullable+optional so a v1 image with
  // an unset asset -- assetId:null -- and one with no assetId key both still
  // validate); crop/flip/etc keep riding through box's looseObject as
  // ordinary passthrough keys. `image: box` (pre-M2) rode assetId through
  // UNTYPED, so a non-string/non-null assetId wrongly validated.
  image: box.extend({ assetId: z.string().nullable().optional() }),
  terminal: box, iframe: box, neko: box, roadmap: box, screenshare: box, 'file-viewer': box,
}

// The strict envelope shared by every shape. props is refined per-kind below.
// Branded id fields come from ids.ts so the prefix rules live in one module.
const envelope = z.object({
  id: shapeIdField,
  kind: z.enum(SHAPE_KINDS),
  parentId: parentIdField,
  index: z.string().min(1),          // fractional-index string (z-order), kept verbatim
  x: z.number(),
  y: z.number(),
  rotation: z.number(),
  isLocked: z.boolean(),
  opacity: z.number(),
  meta: z.record(z.string(), z.unknown()),
  props: z.record(z.string(), z.unknown()),
})

export type Shape = z.infer<typeof envelope>

// Compile-time drift guards: the schema's inferred id types must stay assignable
// to ids.ts's branded types (and vice versa). A mismatch is a type error here.
type _IdMatches = [Shape['id'] extends ShapeId ? true : never, ShapeId extends Shape['id'] ? true : never]
type _ParentMatches = [Shape['parentId'] extends ParentId ? true : never, ParentId extends Shape['parentId'] ? true : never]
const _idCheck: _IdMatches = [true, true]
const _parentCheck: _ParentMatches = [true, true]
void _idCheck, void _parentCheck

// Full schema: envelope + per-kind props refinement (superRefine keeps a single
// discriminant while validating props against the kind's schema).
export const shapeSchema = envelope.superRefine((s, ctx) => {
  const res = propsByKind[s.kind as ShapeKind].safeParse(s.props)
  if (!res.success) {
    ctx.addIssue({ code: 'custom', message: `invalid props for kind ${s.kind}: ${res.error.message}`, path: ['props'] })
  }
})

export type ShapeValidation = { ok: true; shape: Shape } | { ok: false; error: string }

export function validateShape(input: unknown): ShapeValidation {
  const res = shapeSchema.safeParse(input)
  return res.success ? { ok: true, shape: res.data } : { ok: false, error: res.error.message }
}

// Plain text from a shape's richText (paragraphs join on newline). Pure inverse
// of tldraw toRichText, matching server/src/canvas/geometry.ts richTextToPlainText.
export function plainText(shape: Shape): string {
  const rich = (shape.props as any)?.richText
  if (!rich || !Array.isArray(rich.content)) return ''
  const textOf = (n: any): string =>
    !n ? '' : typeof n.text === 'string' ? n.text : Array.isArray(n.content) ? n.content.map(textOf).join('') : ''
  return rich.content.map(textOf).join('\n')
}
