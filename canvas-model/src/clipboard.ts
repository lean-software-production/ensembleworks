import type { Shape } from './shape.js'
import type { Binding } from './document.js'

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
