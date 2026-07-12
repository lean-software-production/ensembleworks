// The registry's fallback component (shapeRegistry.ts's FALLBACK POLICY):
// renders ANY shape kind with no registered component of its own as a
// colored rounded box carrying a text label, so an unregistered kind is
// visible-but-plain rather than invisible. Deliberately minimal — no
// selection outline/handles here (that's D4's overlay, a layer ABOVE the
// shape bodies, not something each body draws for itself).
import type { ShapeBodyProps } from '../shapeRegistry.js'

/** Best-effort label: richText-bearing kinds carry plain text nowhere on
 * `props` directly (canvas-model's `plainText(shape)` derives it from
 * `props.richText`, which is the more common case — note/text/geo/arrow);
 * `props.name` covers frame's own labeling field (canvas-model/shape.ts's
 * frame props schema: `{ w, h, name? }`). Falls back to the shape's kind
 * string so an entirely unlabeled shape still shows SOMETHING. */
function labelOf(shape: ShapeBodyProps['shape']): string {
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

export function BoxShape({ shape }: ShapeBodyProps) {
  return (
    <div
      data-shape-body="box"
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        padding: 4,
        fontSize: 12,
        lineHeight: 1.2,
        borderRadius: 8,
        border: '1px solid rgba(0, 0, 0, 0.25)',
        background: 'rgba(120, 170, 255, 0.35)',
      }}
    >
      {labelOf(shape)}
    </div>
  )
}
