// The best-effort label resolver shared by every shape body — extracted
// VERBATIM out of BoxShape.tsx (this module's sole prior owner) so a second
// body (NoteShape, Task C1) can reuse the exact same resolution order
// without duplicating it. Behavior is UNCHANGED from the pre-extraction
// BoxShape.labelOf — this is a pure DRY move, not a rewrite.
import { isTextCapableKind } from '@ensembleworks/canvas-model'
import type { ShapeBodyProps } from '../shapeRegistry.js'

/** Best-effort label. ORDER (live doc text wins first): a text-capable kind
 * (canvas-model's `isTextCapableKind` — note/text/geo) whose `getText`
 * accessor returns a NON-EMPTY string shows that LIVE content — the
 * plain-text editing mount (canvas-react/src/TextEditor.tsx) writes there
 * via `CanvasDoc.setText`, and until this accessor existed nothing ever
 * rendered it outside the editing textarea itself, on ANY client, not just
 * a remote one (see shapeRegistry.ts's ShapeBodyProps.getText doc comment —
 * this is the review gap it closes). Falls back, in order, to `props.name`
 * (frame's own labeling field — canvas-model/shape.ts's frame props schema:
 * `{ w, h, name? }`), then `props.richText` (a DIFFERENT field `SetText`
 * never writes this phase — its only current writer is client/src/
 * canvas-v2/goldens/fixtures.ts's static goldens fixtures), then the
 * shape's own kind string so an entirely unlabeled shape still shows
 * SOMETHING. */
export function labelOf(shape: ShapeBodyProps['shape'], getText?: (id: string) => string): string {
  if (isTextCapableKind(shape.kind) && getText) {
    const live = getText(shape.id)
    if (live.length > 0) return live
  }
  const props = shape.props as Record<string, unknown>
  if (typeof props.name === 'string' && props.name.length > 0) return props.name
  const rich = props.richText as { content?: unknown } | undefined
  if (rich && typeof rich === 'object') {
    // Mirrors canvas-model's plainText() shape-walk without importing it
    // just for a label preview — plainText is exported for full-fidelity
    // text extraction (semantics.ts's real consumer); this is a cheaper
    // best-effort peek, fine for a fallback box's label.
    const text = flattenRichText(rich)
    if (text) return text
  }
  return shape.kind
}

function flattenRichText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: unknown; content?: unknown }
  if (typeof n.text === 'string') return n.text
  if (Array.isArray(n.content)) return n.content.map(flattenRichText).join('')
  return ''
}
