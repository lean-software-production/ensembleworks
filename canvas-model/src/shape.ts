import { z } from 'zod'

// The shape kinds a room can contain: tldraw defaults we use + image + the six
// custom HTML-box shapes (contracts/src/shapes.ts).
export const SHAPE_KINDS = [
  'note', 'text', 'geo', 'arrow', 'frame', 'line', 'draw', 'highlight', 'image',
  'terminal', 'iframe', 'neko', 'roadmap', 'screenshare', 'file-viewer',
] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

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
  geo: z.looseObject({ richText: richText.optional(), color: z.string().optional(), w: z.number().optional(), h: z.number().optional() }),
  arrow: z.looseObject({ richText: richText.optional(), color: z.string().optional() }),
  frame: z.looseObject({ name: z.string().optional(), w: z.number().optional(), h: z.number().optional() }),
  line: z.looseObject({}),
  draw: z.looseObject({}),
  highlight: z.looseObject({}),
  image: box,
  terminal: box, iframe: box, neko: box, roadmap: box, screenshare: box, 'file-viewer': box,
}

const idField = z.string().regex(/^shape:/)
const parentField = z.string().regex(/^(shape|page):/)

// The strict envelope shared by every shape. props is refined per-kind below.
const envelope = z.object({
  id: idField,
  kind: z.enum(SHAPE_KINDS),
  parentId: parentField,
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
