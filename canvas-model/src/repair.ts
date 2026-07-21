import { type CanvasDocument, type Page, makeDocument } from './document.js'
import { checkInvariants, type InvariantRule } from './invariants.js'
import { stableStringify } from './stable-stringify.js'

export type RepairOp =
  | { op: 'reparentToRoot'; id: string } // orphan or cycle member → page root
  | { op: 'deleteBinding'; id: string } // dangling binding
  // Invalid envelope/props. Removes ONLY this shape; any shape whose parentId
  // is a dropped id is rehomed to the root of the page it was ALREADY on (see
  // pageAncestorId). Deliberately NOT a subtree cascade: a container with
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
// LoroCanvasDoc.repair() use this helper so the two can't drift. In
// applyRepairToModel it is ALSO the fallback target for a RESCUED child whose
// page ancestor can't be resolved (dead-end or cycle) — see pageAncestorId
// below. LoroCanvasDoc.repair() mirrors this: it rescues children the same
// proportionate way and falls back to this same value when a rescued child's
// page ancestor can't be resolved.
export function canonicalPageId(pages: readonly Page[]): Page['id'] | undefined {
  return pages.map((p) => p.id).sort((a, b) => a.localeCompare(b))[0]
}

// The page a RESCUED child must stay on: walk `parentId` up from `startId`
// (the dropped parent) until an id that names a page. Owner ruling 11: a
// rescued child may shift in POSITION but must not change PAGE, so this
// per-shape target replaces the doc-wide canonicalPageId on the rescue path
// ONLY — reparentToRoot still uses canonicalPageId, because an orphan or a
// cycle member has no page to stay on, which is the whole point of that op.
//
// NOT geometry.ts's pageIdOf, despite the similar walk — that one is read-
// path tolerance (stops on the 'page:' PREFIX, caps at 50 hops), both wrong
// for a repair write target. The two are NOT YET UNIFIED. Two of the three
// apparent distinctions aren't real permanent contracts: the signature (id vs
// Shape) is cosmetic — pageIdOf(doc, s) is pageAncestorId(doc, s.parentId)
// modulo the walk semantics below — and the guard discipline isn't two
// contracts either, it's one correct implementation (this one, unbounded
// seen-set) and one loose one (pageIdOf's 50-hop cap silently returns
// undefined on a legitimately deeper chain). The one distinction that IS
// load-bearing, and demonstrated by a case below: MEMBERSHIP in doc.pages
// vs. the 'page:' PREFIX. 'page:ghost' carries the prefix and names no page;
// unifying onto prefix semantics would change neighbors.ts's behavior
// (neighbors.ts:12,18 currently groups shapes under a ghost page together
// because pageIdOf returns 'page:ghost' for all of them — switching to
// membership would return [] instead), which is a real behavior change
// needing its own test and is out of scope here. (By contrast,
// server/src/features/canvas-v2.ts:177 compares pageIdOf's result against a
// real doc.pages[0].id, never a ghost value, so it is unaffected either way.)
//
// Properties, each pinned by a case in repair.test.ts:
// - It stops at a page by MEMBERSHIP in doc.pages, never by the 'page:'
//   prefix. A parentId like 'page:ghost' carries the prefix and names no page
//   (that is what invariants.ts's noOrphans rule tests for); stamping it onto
//   a rescued child would emit a fresh noOrphans violation out of a pass that
//   has to converge in ONE call.
// - It walks THROUGH shapes — dropped or surviving — and stops only at a page.
//   Stopping on a dropped ancestor would leave the child pointing at something
//   being removed. Stopping on a SURVIVING ancestor would put the child inside
//   a frame it was never in, inventing a containment relationship repair has
//   no mandate to create.
// - It terminates. noCycles is a real invariant, so a parent chain can cycle;
//   `seen` bounds the walk and the caller falls back to canonicalPageId.
//   Unreachable from a repairPlan-produced plan (a shape whose chain cycles is
//   itself flagged noCycles, so it is reparented rather than rescued) — this is
//   dead-code safety for hand-built plans, like the 'page:orphans' fallback.
// Ancestors resolve through doc.byId — the CONTENT winner under duplicate ids
// (see makeDocument) — never a scan of doc.shapes, so the target is a pure
// function of converged state and cannot depend on array order.
//
// `pageIds` is caller-supplied rather than derived here: applyRepairToModel
// calls this once per rescued child, and doc.pages doesn't change mid-pass,
// so deriving the Set inside this function would rebuild an invariant value
// O(pages × rescued) times per repair.
export function pageAncestorId(doc: CanvasDocument, startId: string, pageIds: ReadonlySet<string>): Page['id'] | undefined {
  const seen = new Set<string>()
  let cur: string | undefined = startId
  while (cur !== undefined && !seen.has(cur)) {
    if (pageIds.has(cur)) return cur as Page['id']
    seen.add(cur)
    cur = doc.byId.get(cur)?.parentId
  }
  return undefined
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
  // Hoisted out of the flatMap below: doc.pages doesn't change mid-pass, so
  // this is loop-invariant across every rescued child pageAncestorId is
  // called for.
  const pageIds = new Set<string>(doc.pages.map((p) => p.id))
  // Drop, dedupe, and rehome are ONE fused pass over the untransformed
  // doc.shapes, not a filter/filter/map chain: `winnerKey` was captured from
  // the pre-repair shapes above, and the dedupe comparison below re-derives
  // stableStringify(s) against that key from the SAME untransformed `s` this
  // callback receives — never from a copy some earlier stage already
  // rehomed. Fusing the three decisions into one step removes the separate
  // rehoming stage that a later edit could quietly move ahead of the dedupe
  // check. That forecloses the mistake mechanically; it does NOT put the bug
  // out of reach — hoisting the rehome into a local above the dedupe
  // compare, a three-line edit inside this callback, still annihilates every
  // copy of a deduped-and-rescued shape. Hence the ORDER PIN case in
  // repair.test.ts: it pins the constraint the shape of this code only
  // discourages. The chain form never shipped the bug, so that case is a
  // pin, not a regression test.
  const shapes = doc.shapes.flatMap((s) => {
    if (drop.has(s.id)) return []
    if (dedupeIds.has(s.id)) {
      if (keptDupe.has(s.id) || stableStringify(s) !== winnerKey.get(s.id)) return []
      keptDupe.add(s.id)
    }
    // TWO rehoming rules, and the precedence between them is deliberate.
    // reparentToRoot (orphan/cycle) goes to the canonical page: such a shape
    // has no page to stay on. A shape rescued because its PARENT was dropped
    // stays on its own page (owner ruling 11) — the page ancestor of that
    // dropped parent, falling back to the canonical page when the chain
    // dead-ends or cycles.
    // The two branches never disagree on a plan repairPlan produced: a shape
    // whose chain cycles is itself flagged noCycles (so it is in toRoot), and
    // a shape flagged noOrphans has a parent that names nothing (so its parent
    // cannot be dropped). Every toRoot shape therefore has no page ancestor
    // anyway and falls back to the same target. The ordering below defines
    // hand-built plans and keeps the rule statable: removal, then flag, then
    // rescue.
    if (toRoot.has(s.id)) return [{ ...s, parentId: pageId }]
    // LOGICAL rescue, keyed on the STORED parentId. loro-canvas-doc.ts's
    // dropShapeRescuingChildren mirrors this exactly; it ALSO lifts any
    // merely-physical tree child clear of Loro's delete cascade, which is
    // invisible here because dropping is a filter over a flat array.
    if (drop.has(s.parentId)) return [{ ...s, parentId: pageAncestorId(doc, s.parentId, pageIds) ?? pageId }]
    return [s]
  })
  // A binding dies iff the plan names it, or an ENDPOINT was dropped (that
  // binding is not dangling when the plan is computed, so no deleteBinding op
  // exists for it — sweeping it here is what makes ONE pass converge). A
  // binding to a merely RESCUED shape survives: the shape still exists.
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !drop.has(b.fromId) && !drop.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
