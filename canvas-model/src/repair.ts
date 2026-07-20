import { type CanvasDocument, type Page, makeDocument } from './document.js'
import { checkInvariants, type InvariantRule } from './invariants.js'
import { stableStringify } from './stable-stringify.js'

export type RepairOp =
  | { op: 'reparentToRoot'; id: string } // orphan or cycle member → page root
  | { op: 'deleteBinding'; id: string } // dangling binding
  // Invalid envelope/props. Removes ONLY this shape; any shape whose parentId
  // is a dropped id is rehomed to the canonical page root (see
  // applyRepairToModel). Deliberately NOT a subtree cascade: a container with
  // one bad prop must not execute its innocent contents, and Loro tombstones
  // make that loss unrecoverable. Rescued children keep their parent-relative
  // x/y and may visually jump — accepted, owner ruling 1.
  | { op: 'dropShape'; id: string }
  | { op: 'dedupeShape'; id: string } // >1 entry shares this id → keep the content winner only

// Execution/sort order. dedupeShape sits BETWEEN dropShape and reparentToRoot
// deliberately: drops run first (a dropped id needs no dedupe), and dedupe
// runs BEFORE reparentToRoot so a coexisting reparent op for the same id
// operates on the single surviving entry/node, never on a multiset.
const rank: Record<RepairOp['op'], number> = { deleteBinding: 0, dropShape: 1, dedupeShape: 2, reparentToRoot: 3 }

function opFor(rule: InvariantRule, id: string): RepairOp {
  switch (rule) {
    case 'noOrphans':
    case 'noCycles':
      return { op: 'reparentToRoot', id }
    case 'noDanglingBindings':
      return { op: 'deleteBinding', id }
    case 'validProps':
      return { op: 'dropShape', id }
    case 'uniqueIds':
      return { op: 'dedupeShape', id }
  }
}

// The dedupe winner rule's serialization — see stable-stringify.ts for the
// full contract (key-order-insensitive, arrays stay ordered, and why
// JSON.stringify / traversal order are forbidden). Re-exported here because
// this module OWNS the winner rule; it lives in its own file only so
// document.ts (makeDocument's byId under duplicate ids) can share it without
// an import cycle.
export { stableStringify } from './stable-stringify.js'

// The canonical root page every reparentToRoot targets: the lexicographically
// SMALLEST page id, chosen explicitly. Repair must be a pure function of
// converged state, so the target can't depend on container iteration order
// (e.g. LoroMap.keys() happens to converge sorted today, but that's an
// undocumented Loro internal — nothing pins it). Both applyRepairToModel and
// LoroCanvasDoc.repair() use this helper so the two can't drift.
export function canonicalPageId(pages: readonly Page[]): Page['id'] | undefined {
  return pages.map((p) => p.id).sort((a, b) => a.localeCompare(b))[0]
}

// Pure: identical input ⇒ identical plan on every peer. Sorted by (op,id) so the
// order is stable regardless of input order or which peer computes it.
export function repairPlan(doc: CanvasDocument): RepairOp[] {
  const ops: RepairOp[] = []
  // Zero-page docs: orphans are unrepairable (no reparent target), so
  // reparentToRoot is suppressed and the violation is left standing rather
  // than emitting a non-converging op. dropShape is suppressed by the SAME
  // uniform rule, deliberately coarse: it fires whether or not the dropped
  // shape actually has children to rescue. Consequence, honestly stated: a
  // zero-page doc with a CHILDLESS invalid shape used to get it quarantined
  // (dropShape has no rescue-target dependency pre-Task-5); now repairPlan
  // returns [] for it too, and checkInvariants keeps reporting validProps —
  // permanently invalid, with repair reporting nothing to do, until a page
  // exists. Accepted for uniformity rather than special-casing "does this
  // dropped shape have children right now" (itself iteration work, and a
  // property that can change from one repair pass to the next).
  const canReparent = doc.pages.length > 0
  for (const v of checkInvariants(doc)) {
    const o = opFor(v.rule, v.id)
    if ((o.op === 'reparentToRoot' || o.op === 'dropShape') && !canReparent) continue
    ops.push(o)
  }
  // Dedup by id: an invalid shape flagged both validProps and noOrphans drops
  // (dropShape wins over reparent). dedupeShape is handled OUTSIDE that
  // one-op-per-id rule: it COEXISTS with reparentToRoot for the same id (they
  // are orthogonal — collapsing duplicate entries vs. relocating the survivor
  // — and a duplicated id can genuinely need both, e.g. one entry orphaned),
  // but is SUBSUMED by dropShape (dropping every physical copy of the id is
  // strictly stronger than collapsing them).
  const byId = new Map<string, RepairOp>()
  const dedupes = new Map<string, RepairOp>()
  for (const o of ops) {
    if (o.op === 'dedupeShape') { dedupes.set(o.id, o); continue }
    const prev = byId.get(o.id)
    if (!prev || rank[o.op] < rank[prev.op]) byId.set(o.id, o)
  }
  const kept: RepairOp[] = [...byId.values()]
  for (const [id, o] of dedupes) {
    if (byId.get(id)?.op === 'dropShape') continue // drop subsumes dedupe
    kept.push(o)
  }
  return kept.sort((a, b) => rank[a.op] - rank[b.op] || a.id.localeCompare(b.id))
}

// Transitive closure of shapes to drop: the seed ids plus every shape whose
// ancestry passes through a seed — a fixpoint over parentId edges, so chains
// of any depth are caught regardless of input order. Shared by
// applyRepairToModel AND LoroCanvasDoc.repair() (its reparent skip-set and
// binding sweep): one implementation, zero drift.
export function cascadeDropSet(
  shapes: readonly { id: string; parentId: string }[],
  seed: ReadonlySet<string>,
): Set<string> {
  const out = new Set(seed)
  let grew = true
  while (grew) {
    grew = false
    for (const s of shapes) if (!out.has(s.id) && out.has(s.parentId)) { out.add(s.id); grew = true }
  }
  return out
}

// Reference application on the pure model (used by tests and the convergence rig
// to compute the expected post-repair state). canvas-doc applies the same plan
// to Loro; both must agree.
export function applyRepairToModel(doc: CanvasDocument, plan: RepairOp[]): CanvasDocument {
  const drop = new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id))
  const toRoot = new Set(plan.filter((o) => o.op === 'reparentToRoot').map((o) => o.id))
  const delBind = new Set(plan.filter((o) => o.op === 'deleteBinding').map((o) => o.id))
  const dedupeIds = new Set(plan.filter((o) => o.op === 'dedupeShape').map((o) => o.id))
  // Drop ONLY the shapes the plan names. Their children are rescued below by
  // the same rehoming rule that serves reparentToRoot. Removal outranks
  // rescue unconditionally: a dropped id is filtered out of the result no
  // matter what else is true of it — there is no code path back in.
  // dedupeShape: keep exactly the content winner among the entries sharing
  // the id — smallest stableStringify (see its comment for why content, never
  // order). Children survive untouched: their parentId is the ID, which the
  // winner keeps resolving. Bindings to the id survive for the same reason.
  const winnerKey = new Map<string, string>()
  for (const s of doc.shapes) {
    if (!dedupeIds.has(s.id)) continue
    const k = stableStringify(s)
    const prev = winnerKey.get(s.id)
    if (prev === undefined || k < prev) winnerKey.set(s.id, k)
  }
  const keptDupe = new Set<string>() // exact-content ties: keep the FIRST matching entry (ties are byte-identical, so the result is order-independent anyway)
  // The 'page:orphans' fallback is unreachable when `plan` comes from
  // repairPlan (it emits no reparentToRoot ops for a zero-page doc); kept as
  // dead-code safety for hand-built plans.
  const pageId = canonicalPageId(doc.pages) ?? 'page:orphans'
  // Drop, dedupe, and rehome are ONE fused pass over the untransformed
  // doc.shapes, not a filter/filter/map chain: `winnerKey` was captured from
  // the pre-repair shapes above, and the dedupe comparison below re-derives
  // stableStringify(s) against that key from the SAME untransformed `s` this
  // callback receives — never from a copy some earlier stage already
  // rehomed. Fusing the three decisions into one step makes that ordering
  // structural rather than a chain a later edit could quietly reorder: there
  // is no separate rehoming stage for a reordering to move earlier than the
  // dedupe check (a real bug this fusion replaces — see repair.test.ts's
  // ORDER PIN case for the reproduction).
  const shapes = doc.shapes.flatMap((s) => {
    if (drop.has(s.id)) return []
    if (dedupeIds.has(s.id)) {
      if (keptDupe.has(s.id) || stableStringify(s) !== winnerKey.get(s.id)) return []
      keptDupe.add(s.id)
    }
    // A shape is rehomed to the canonical page either because it was flagged
    // (orphan/cycle) or because its parent was just dropped. Same target,
    // same determinism — the rescue must not invent a second rehoming rule.
    return [toRoot.has(s.id) || drop.has(s.parentId) ? { ...s, parentId: pageId } : s]
  })
  // A binding dies iff the plan names it, or an ENDPOINT was dropped (that
  // binding is not dangling when the plan is computed, so no deleteBinding op
  // exists for it — sweeping it here is what makes ONE pass converge). A
  // binding to a merely RESCUED shape survives: the shape still exists.
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !drop.has(b.fromId) && !drop.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
