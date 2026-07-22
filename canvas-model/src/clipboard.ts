import { validateShape, type Shape } from './shape.js'
import { bindingSchema, type Binding } from './document.js'

export function encodeClipboard(payload: ClipboardPayload): string {
  return JSON.stringify(payload)
}

// The clipboard is UNTRUSTED input (D-2, THE #1 security requirement):
// arbitrary text from any app on the system clipboard, decoded on paste.
// This is a TOTAL function — every input, however hostile or malformed,
// returns a value and never throws — and nothing invalid ever leaves it:
//   1. JSON.parse in try/catch: malformed JSON -> empty, never propagates.
//   2. Reject anything that isn't a plain (non-array, non-null) object, or
//      whose 'ensembleworks/clipboard' marker isn't exactly version 1 —
//      this is how foreign clipboard content (or a future/older version of
//      our own format) is told apart from ours and silently ignored.
//   3. `shapes` is guarded to be an array (missing/null/wrong-type -> no
//      shapes, not a throw), then each entry runs through validateShape
//      (canvas-model/src/shape.ts) — only ok:true survives. One bad shape
//      never poisons the rest of the paste.
//   4. Bindings are checked against the KEPT id set (post-validateShape,
//      not the raw input), so a binding pointing at a shape that was itself
//      dropped as invalid is dropped too, not just one pointing outside the
//      payload entirely. Each binding also has to structurally parse via
//      bindingSchema (canvas-model/src/document.ts).
// Cyclic/out-of-set parentId chains among the surviving shapes are NOT
// resolved here — that re-rooting is cloneWithNewIds's job (Task C3, D-2/
// D-4); this function's only contract is "every returned shape individually
// passed validateShape and every returned binding's endpoints are among the
// returned shapes."
export function decodeClipboard(text: string): { shapes: Shape[]; bindings: Binding[] } {
  const empty = { shapes: [] as Shape[], bindings: [] as Binding[] }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
  const obj = parsed as Record<string, unknown>
  if (obj['ensembleworks/clipboard'] !== 1) return empty

  const rawShapes = Array.isArray(obj.shapes) ? obj.shapes : []
  const shapes: Shape[] = []
  for (const raw of rawShapes) {
    const result = validateShape(raw)
    if (result.ok) shapes.push(result.shape)
  }

  const keptIds = new Set(shapes.map((s) => s.id))
  const rawBindings = Array.isArray(obj.bindings) ? obj.bindings : []
  const bindings: Binding[] = []
  for (const raw of rawBindings) {
    const result = bindingSchema.safeParse(raw)
    if (result.success && keptIds.has(result.data.fromId) && keptIds.has(result.data.toId)) {
      bindings.push(result.data)
    }
  }

  return { shapes, bindings }
}

// The versioned clipboard envelope (D-1): a recognizable marker key whose
// value is the format version, plus full shape envelopes and the bindings
// internal to the copied set. Consumed by decodeClipboard (Task C2).
export interface ClipboardPayload {
  readonly 'ensembleworks/clipboard': 1
  readonly shapes: readonly Shape[]
  readonly bindings: readonly Binding[]
}

// Collect a selection's full subtree (BFS over parentId, cycle-safe via a
// seen set — mirrors document.ts's descendantsOf, but over a raw shapes
// array + Map rather than a CanvasDocument, since callers may be serializing
// a selection that doesn't come from a live doc) plus every binding whose
// BOTH endpoints land inside the collected set (D-4: a binding pointing
// outside the copied set is dropped, never carried half-dangling).
//
// Deterministic by construction: iteration follows selectedIds order and
// each shape's insertion position in `shapes`/`byParent` — both plain
// arrays — so the same input always walks in the same order. The Map/Set
// below are used only for membership + de-dupe, never iterated in a way
// that would leak their (already-deterministic, insertion-ordered) internal
// order into a place that mattered non-deterministically.
export function serializeSelection(
  shapes: readonly Shape[],
  bindings: readonly Binding[],
  selectedIds: readonly string[],
): ClipboardPayload {
  const byId = new Map<string, Shape>()
  const byParent = new Map<string, Shape[]>()
  for (const s of shapes) {
    byId.set(s.id, s)
    const siblings = byParent.get(s.parentId)
    if (siblings) siblings.push(s)
    else byParent.set(s.parentId, [s])
  }

  // Keyed by id so a selected parent + selected child never duplicate.
  const collected = new Map<string, Shape>()
  for (const selectedId of selectedIds) {
    const root = byId.get(selectedId)
    if (!root) continue
    if (collected.has(root.id)) continue
    collected.set(root.id, root)

    const seen = new Set<string>([root.id])
    const queue: string[] = [root.id]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const child of byParent.get(current) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        collected.set(child.id, child)
        queue.push(child.id)
      }
    }
  }

  const collectedIds = collected // Map already gives O(1) `.has` by id.
  const keptBindings = bindings.filter((b) => collectedIds.has(b.fromId) && collectedIds.has(b.toId))

  return {
    'ensembleworks/clipboard': 1,
    shapes: Array.from(collected.values()),
    bindings: keptBindings,
  }
}
