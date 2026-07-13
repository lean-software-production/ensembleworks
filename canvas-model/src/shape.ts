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

// Per-kind props: type the fields semantics reads; passthrough the rest so no
// tldraw prop is lost. All keys optional except where a field is load-bearing.
const withText = z.looseObject({ richText: richText.optional(), color: z.string().optional() })
const box = z.looseObject({ w: z.number().optional(), h: z.number().optional() })

const propsByKind: Record<ShapeKind, z.ZodTypeAny> = {
  note: withText,
  text: withText,
  geo: withText.extend(box.shape),
  arrow: withText,
  frame: box.extend({ name: z.string().optional() }),
  group: z.looseObject({}), // tldraw groups carry no props; container only
  line: z.looseObject({}),
  draw: z.looseObject({}),
  highlight: z.looseObject({}),
  image: box,
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
