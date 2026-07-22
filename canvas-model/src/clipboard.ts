import { validateShape, type Shape } from './shape.js'
import { bindingSchema, type Binding, makeDocument } from './document.js'
import { checkInvariants } from './invariants.js'
import type { ShapeId, BindingId, ParentId } from './ids.js'

// Turns VALIDATED shapes+bindings (C2's output: every shape already passed
// validateShape; every binding already resolves both endpoints within the
// set) into a brand-new, self-consistent set ready for the write boundary:
// fresh ids throughout, every parentId/binding-endpoint rewritten through the
// old->new map, and the position offset applied only to shapes that come out
// as ROOTS.
//
// `mint(i)` is called once per node, in STABLE order (shapes first in their
// input-array order, then bindings, continuing the same index) — the index
// argument is the uniqueness salt D-3 documents: production injects one
// `editor.random()` draw folded with this index, so N nodes get N distinct
// ids even under a CONSTANT random stream (paste has no pointer event to
// salt from). `mint` is the ONLY source of ids here — this file never reads
// Math.random or any clock, keeping the clean-room boundary.
//
// Cycle-breaking (D-2: "cyclic parentId among the payload is broken in the
// clone step by re-rooting a shape whose ancestor chain doesn't terminate at
// a payload root") needs more than a single-hop "is parentId in the map?"
// check: two shapes that point at EACH OTHER both have a parent that IS in
// the map, so a naive per-shape lookup would remap them straight back into
// the same cycle with new ids. Instead of hand-rolling a second cycle
// detector, this reuses invariants.ts's `checkInvariants` — the same
// memoized parent-chain walk canvas-doc's repair pass already trusts — over
// a throwaway CanvasDocument built from ONLY the input shapes (no pages, no
// bindings: we want its noCycles rule and nothing else). Any shape it flags
// noCycles for (a cycle member, or a shape descending from one — the walk
// can't tell those apart mid-cycle, and repair.ts already treats both the
// same way in production) is forced to re-root here regardless of what its
// old parentId was.
export function cloneWithNewIds(
  input: { shapes: Shape[]; bindings: Binding[] },
  mint: (i: number) => string,
  rootParentId: string,
  offset: { x: number; y: number },
): { shapes: Shape[]; bindings: Binding[]; rootIds: string[] } {
  const idMap = new Map<string, string>()
  input.shapes.forEach((s, i) => idMap.set(s.id, mint(i)))

  const cycleDoc = makeDocument({ pages: [], shapes: input.shapes, bindings: [] })
  const cyclicIds = new Set<string>(
    checkInvariants(cycleDoc)
      .filter((v) => v.rule === 'noCycles')
      .map((v) => v.id),
  )

  const rootIds: string[] = []
  const shapes: Shape[] = input.shapes.map((s) => {
    const newId = idMap.get(s.id) as ShapeId
    // A cyclic (or cycle-descending) shape is force-rooted regardless of
    // whether its old parentId happens to resolve through idMap — that
    // resolution is exactly what would put it right back in the cycle.
    const mappedParentId = cyclicIds.has(s.id) ? undefined : idMap.get(s.parentId)
    const isRoot = mappedParentId === undefined
    if (isRoot) rootIds.push(newId)
    return {
      ...s,
      id: newId,
      parentId: (isRoot ? rootParentId : mappedParentId) as ParentId,
      x: isRoot ? s.x + offset.x : s.x,
      y: isRoot ? s.y + offset.y : s.y,
    }
  })

  // Both endpoints are guaranteed present (C1/C2 already dropped bindings
  // pointing outside the copied set) — the undefined check is assert-and-skip
  // defense-in-depth, not an expected path: a binding that somehow slipped
  // through with an endpoint outside `input.shapes` is dropped here rather
  // than emitted half-dangling with a stale endpoint id.
  const bindings: Binding[] = input.bindings.flatMap((b, j) => {
    const fromId = idMap.get(b.fromId)
    const toId = idMap.get(b.toId)
    if (fromId === undefined || toId === undefined) return []
    return [{ ...b, id: mint(input.shapes.length + j) as BindingId, fromId: fromId as ShapeId, toId: toId as ShapeId }]
  })

  return { shapes, bindings, rootIds }
}

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
