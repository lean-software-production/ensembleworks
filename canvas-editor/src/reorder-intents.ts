// Pure emitter over the selection's z-order (Task E2, D-4) — mirrors the
// landed duplicateSelectionIntents/pasteIntents precedent in
// clipboard-intents.ts: reads editor.get().selection + editor.doc, computes
// new fractional indices via canvas-model's A1 generator
// (generateKeyBetween/generateNKeysBetween, both pure — no Math.random, no
// Date.now), and returns a batch of SetIndex intents (E1). The caller
// applies the batch through a single editor.applyAll(...) call, which is
// what makes one reorder ONE commit / ONE undo step (see editor.ts's
// applyAll doc comment) — this module never calls applyAll itself.
//
// Siblings-only: a shape only ever reorders among shapes sharing its
// parentId. A selection spanning multiple parents is grouped by parentId
// and each group's siblings are reordered completely independently — no
// index is ever generated relative to a shape outside that group.
//
// Movers preserve relative order (tldraw parity): within a parent group,
// "movers" are the selected siblings taken in their CURRENT (index ASC,
// id ASC) doc order — never selection-array order, which the multi-select
// toFront test deliberately scrambles to prove this. toFront/toBack hand
// that ordered run straight to generateNKeysBetween, which mints N
// strictly-increasing keys in one call — the topmost mover before the move
// stays topmost among the movers after it.
import { generateKeyBetween as indexBetween, generateNKeysBetween, type Shape } from '@ensembleworks/canvas-model'
import type { Editor } from './editor.js'
import type { Intent } from './intents.js'

export type ReorderOp = 'toFront' | 'toBack' | 'forward' | 'backward'

function compareByIndexThenId(a: Shape, b: Shape): number {
  if (a.index < b.index) return -1
  if (a.index > b.index) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

// One step of the forward/backward walk: `arr` is the CURRENT (index,id)
// order for one parent's siblings (mutated in place as movers are placed),
// `movingIds` marks which entries are selected. `ascending` picks the
// direction: false = forward (process the highest-position mover first,
// look at its upper neighbor), true = backward (process the lowest-position
// mover first, look at its lower neighbor). Returns id -> new index for
// every mover that actually moved; a mover whose neighbor-to-hop is absent
// or itself selected is blocked and gets no entry (D-4: "the mover is
// blocked/at-top -> no change").
//
// The local splice (not a fresh re-sort) is what makes a contiguous run of
// selected siblings walk together one step at a time instead of the first
// mover leapfrogging past a still-unprocessed second mover — D-4's exact
// wording ("splice the mover to its new position in the local sorted array
// so the next mover sees the updated arrangement").
function stepMovers(arr: Shape[], movingIds: ReadonlySet<string>, ascending: boolean): Map<string, string> {
  const result = new Map<string, string>()
  const pending = new Set(movingIds)
  while (pending.size > 0) {
    // Find the currently-most-extreme (highest position for forward,
    // lowest for backward) unprocessed mover in the live array.
    let bestPos = -1
    let bestId: string | null = null
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i]!.id
      if (!pending.has(id)) continue
      if (bestId === null || (ascending ? i < bestPos : i > bestPos)) {
        bestPos = i
        bestId = id
      }
    }
    pending.delete(bestId!)
    const p = bestPos
    const neighborPos = ascending ? p - 1 : p + 1
    const neighbor = arr[neighborPos]
    if (!neighbor || movingIds.has(neighbor.id)) continue // blocked: absent or itself a mover

    const beyondPos = ascending ? p - 2 : p + 2
    const beyond = arr[beyondPos]
    const newIndex = ascending ? indexBetween(beyond?.index ?? null, neighbor.index) : indexBetween(neighbor.index, beyond?.index ?? null)
    result.set(bestId!, newIndex)

    // Splice: the mover and its neighbor swap positions in the local array
    // so any remaining mover sees the updated arrangement. `neighborPos`'s
    // numeric value is valid as the post-removal insertion index in BOTH
    // directions: forward removes at p < neighborPos (positions at/after
    // neighborPos shift left by one, landing neighborPos exactly where the
    // mover belongs, just past the neighbor); backward removes at p >
    // neighborPos (everything at/before neighborPos is untouched by the
    // removal, so neighborPos still names the mover's target slot, just
    // before the neighbor).
    //
    // The re-inserted record carries the JUST-COMPUTED newIndex, not the
    // mover's stale original `.index` — this is load-bearing, not cosmetic:
    // when two adjacent siblings are selected and walk forward/backward
    // together, the SECOND mover processed reads its "beyond" bound off
    // THIS array slot (see `beyond` above). A stale original index there
    // can violate strict ordering against the (already-moved) neighbor —
    // e.g. the neighbor now sits between the block's two movers — and hand
    // indexBetween an inverted (a >= b) bound, which throws. Carrying the
    // real new index keeps the local array's `.index` values consistent
    // with the moves already made, so every subsequent bound is valid.
    const [mover] = arr.splice(p, 1)
    arr.splice(neighborPos, 0, { ...mover!, index: newIndex })
  }
  return result
}

/** Compute the batch of SetIndex intents (E1) for the four Arrange ops over
 * the current selection, among each shape's own siblings (same parentId).
 * Empty selection -> []. A parent group with no OTHER (unselected) siblings
 * has nothing to reorder relative to, so toFront/toBack emit nothing for it
 * (D-4 / the plan's "single only-child -> [] (no siblings to move past)"
 * case); forward/backward reach the same outcome naturally, since a mover
 * with no unselected neighbor is always blocked. Only shapes whose computed
 * index actually differs from their current one get a SetIndex — this
 * function never manufactures a spurious no-op intent. */
export function reorderSelectionIntents(editor: Editor, op: ReorderOp): Intent[] {
  const selectedIds = new Set(editor.get().selection)
  if (selectedIds.size === 0) return []

  const allShapes = editor.doc.listShapes()
  const byParent = new Map<string, Shape[]>()
  for (const s of allShapes) {
    const bucket = byParent.get(s.parentId)
    if (bucket) bucket.push(s)
    else byParent.set(s.parentId, [s])
  }

  const intents: Intent[] = []

  // Group the SELECTED shapes by parent (siblings-only: each group is
  // reordered completely independently of every other group).
  const selectedByParent = new Map<string, Shape[]>()
  for (const s of allShapes) {
    if (!selectedIds.has(s.id)) continue
    const bucket = selectedByParent.get(s.parentId)
    if (bucket) bucket.push(s)
    else selectedByParent.set(s.parentId, [s])
  }

  for (const [parentId, selectedInGroup] of selectedByParent) {
    const siblings = (byParent.get(parentId) ?? []).slice().sort(compareByIndexThenId)
    const movingIds = new Set(selectedInGroup.map((s) => s.id))
    const movers = siblings.filter((s) => movingIds.has(s.id)) // already in (index,id) order
    const others = siblings.filter((s) => !movingIds.has(s.id))

    const results = new Map<string, string>()

    if (op === 'toFront' || op === 'toBack') {
      if (others.length === 0) continue // nothing to move past — no-op for this group
      if (op === 'toFront') {
        const lastOther = others[others.length - 1]!
        const newKeys = generateNKeysBetween(lastOther.index, null, movers.length)
        movers.forEach((m, i) => results.set(m.id, newKeys[i]!))
      } else {
        const firstOther = others[0]!
        const newKeys = generateNKeysBetween(null, firstOther.index, movers.length)
        movers.forEach((m, i) => results.set(m.id, newKeys[i]!))
      }
    } else {
      const ascending = op === 'backward' // backward walks from the bottom up; forward from the top down
      const stepped = stepMovers(siblings.slice(), movingIds, ascending)
      for (const [id, idx] of stepped) results.set(id, idx)
    }

    for (const s of movers) {
      const newIndex = results.get(s.id)
      if (newIndex === undefined) continue
      if (newIndex === s.index) continue
      intents.push({ type: 'SetIndex', id: s.id, index: newIndex })
    }
  }

  return intents
}
