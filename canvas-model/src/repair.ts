import { type CanvasDocument, makeDocument } from './document.js'
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

// Pure: identical input ⇒ identical plan on every peer. Sorted by (op,id) so the
// order is stable regardless of input order or which peer computes it.
export function repairPlan(doc: CanvasDocument): RepairOp[] {
  const ops: RepairOp[] = []
  for (const v of checkInvariants(doc)) ops.push(opFor(v.rule, v.id))
  // Dedup by id: an invalid shape flagged both validProps and noOrphans drops (dropShape wins over reparent).
  const byId = new Map<string, RepairOp>()
  for (const o of ops) {
    const prev = byId.get(o.id)
    if (!prev || rank[o.op] < rank[prev.op]) byId.set(o.id, o)
  }
  return [...byId.values()].sort((a, b) => rank[a.op] - rank[b.op] || a.id.localeCompare(b.id))
}

// Reference application on the pure model (used by tests and the convergence rig
// to compute the expected post-repair state). canvas-doc applies the same plan
// to Loro; both must agree.
export function applyRepairToModel(doc: CanvasDocument, plan: RepairOp[]): CanvasDocument {
  const drop = new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id))
  const toRoot = new Set(plan.filter((o) => o.op === 'reparentToRoot').map((o) => o.id))
  const delBind = new Set(plan.filter((o) => o.op === 'deleteBinding').map((o) => o.id))
  // Drop invalid shapes AND their descendants (cascade).
  const dropAll = new Set(drop)
  let grew = true
  while (grew) {
    grew = false
    for (const s of doc.shapes) if (!dropAll.has(s.id) && dropAll.has(s.parentId)) { dropAll.add(s.id); grew = true }
  }
  const pageId = doc.pages[0]?.id ?? 'page:orphans'
  const shapes = doc.shapes
    .filter((s) => !dropAll.has(s.id))
    .map((s) => (toRoot.has(s.id) ? { ...s, parentId: pageId } : s))
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !dropAll.has(b.fromId) && !dropAll.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
