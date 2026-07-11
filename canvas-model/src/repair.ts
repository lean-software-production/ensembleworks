import { type CanvasDocument, type Page, makeDocument } from './document.js'
import { checkInvariants, type InvariantRule } from './invariants.js'

export type RepairOp =
  | { op: 'reparentToRoot'; id: string } // orphan or cycle member → page root
  | { op: 'deleteBinding'; id: string } // dangling binding
  | { op: 'dropShape'; id: string } // invalid envelope/props (quarantine)

const rank: Record<RepairOp['op'], number> = { deleteBinding: 0, dropShape: 1, reparentToRoot: 2 }

function opFor(rule: InvariantRule, id: string): RepairOp {
  switch (rule) {
    case 'noOrphans':
    case 'noCycles':
      return { op: 'reparentToRoot', id }
    case 'noDanglingBindings':
      return { op: 'deleteBinding', id }
    case 'validProps':
      return { op: 'dropShape', id }
  }
}

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
  // Dedup by id: an invalid shape flagged both validProps and noOrphans drops (dropShape wins over reparent).
  const byId = new Map<string, RepairOp>()
  for (const o of ops) {
    const prev = byId.get(o.id)
    if (!prev || rank[o.op] < rank[prev.op]) byId.set(o.id, o)
  }
  return [...byId.values()].sort((a, b) => rank[a.op] - rank[b.op] || a.id.localeCompare(b.id))
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
  // Drop invalid shapes AND their descendants (cascade). The filter below runs
  // before the toRoot map, so a shape both cascade-dropped and reparent-flagged
  // is DROPPED — same precedence as repair()'s skip of reparent ops in dropAll.
  const dropAll = cascadeDropSet(doc.shapes, drop)
  // The 'page:orphans' fallback is unreachable when `plan` comes from
  // repairPlan (it emits no reparentToRoot ops for a zero-page doc); kept as
  // dead-code safety for hand-built plans.
  const pageId = canonicalPageId(doc.pages) ?? 'page:orphans'
  const shapes = doc.shapes
    .filter((s) => !dropAll.has(s.id))
    .map((s) => (toRoot.has(s.id) ? { ...s, parentId: pageId } : s))
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !dropAll.has(b.fromId) && !dropAll.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
