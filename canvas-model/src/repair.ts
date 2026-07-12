import { type CanvasDocument, type Page, makeDocument } from './document.js'
import { checkInvariants, type InvariantRule } from './invariants.js'
import { stableStringify } from './stable-stringify.js'

export type RepairOp =
  | { op: 'reparentToRoot'; id: string } // orphan or cycle member → page root
  | { op: 'deleteBinding'; id: string } // dangling binding
  | { op: 'dropShape'; id: string } // invalid envelope/props (quarantine)
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
  // Zero-page docs: orphans are unrepairable (no target); the violation is
  // left standing rather than emitting a non-converging op (reparenting to a
  // made-up page id would leave the shape just as orphaned, forever).
  const canReparent = doc.pages.length > 0
  for (const v of checkInvariants(doc)) {
    const o = opFor(v.rule, v.id)
    if (o.op === 'reparentToRoot' && !canReparent) continue
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
  // Drop invalid shapes AND their descendants (cascade). The filter below runs
  // before the toRoot map, so a shape both cascade-dropped and reparent-flagged
  // is DROPPED — same precedence as repair()'s skip of reparent ops in dropAll.
  const dropAll = cascadeDropSet(doc.shapes, drop)
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
  const shapes = doc.shapes
    .filter((s) => !dropAll.has(s.id))
    .filter((s) => {
      if (!dedupeIds.has(s.id)) return true
      if (keptDupe.has(s.id) || stableStringify(s) !== winnerKey.get(s.id)) return false
      keptDupe.add(s.id)
      return true
    })
    .map((s) => (toRoot.has(s.id) ? { ...s, parentId: pageId } : s))
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !dropAll.has(b.fromId) && !dropAll.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
