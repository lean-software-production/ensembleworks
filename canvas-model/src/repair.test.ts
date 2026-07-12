// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { repairPlan, applyRepairToModel, stableStringify } from './repair.js'
import { checkInvariants } from './invariants.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })

// Orphan → reparentToRoot; dangling binding → deleteBinding; invalid → dropShape.
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:ok', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
    { id: 'shape:orphan', kind: 'note', parentId: 'shape:ghost', props: {}, ...base() } as any,
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    // opacity set AFTER the ...base() spread so it actually overrides base's opacity: 1
    // (spec text ordered it before the spread, where base() would clobber it back to a
    // valid number — genuinely tripping validProps requires this order).
    { id: 'shape:bad', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
  ],
  bindings: [{ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {}, meta: {} }],
})

const plan = repairPlan(doc)
// Deterministic, sorted by (op, id): stable across peers.
assert.deepEqual(plan, [
  { op: 'deleteBinding', id: 'binding:d' },
  { op: 'dropShape', id: 'shape:bad' },
  { op: 'reparentToRoot', id: 'shape:orphan' },
])

// Applying the plan to the model yields an invariant-clean document (idempotent).
const repaired = applyRepairToModel(doc, plan)
assert.deepEqual(checkInvariants(repaired), [])
assert.deepEqual(repairPlan(repaired), [], 'repair is idempotent — a repaired doc needs no repair')

// Cascade fixpoint (3 levels): dropping the invalid root removes the WHOLE
// descendant chain, and a binding touching a cascaded shape (not the dropped
// shape itself) goes too. Descendants are listed BEFORE ancestors on purpose:
// a single in-order pass over the array cannot reach the grandchild (its
// parent isn't in the set yet when it's visited), so only a true fixpoint
// passes — a single-pass mutation of cascadeDropSet must fail here.
const chain = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:ar2', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:grandchild', kind: 'note', parentId: 'shape:child', props: {}, ...base() } as any,
    { id: 'shape:child', kind: 'note', parentId: 'shape:bad2', props: {}, ...base() } as any,
    { id: 'shape:bad2', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
  ],
  bindings: [{ id: 'binding:g', fromId: 'shape:ar2', toId: 'shape:grandchild', props: {}, meta: {} }],
})
const chainPlan = repairPlan(chain)
assert.deepEqual(chainPlan, [{ op: 'dropShape', id: 'shape:bad2' }], 'only the invalid root is in the plan — descendants cascade')
const chainRepaired = applyRepairToModel(chain, chainPlan)
assert.deepEqual(chainRepaired.shapes.map((s) => s.id), ['shape:ar2'], 'bad2, child AND grandchild all dropped')
assert.deepEqual(chainRepaired.bindings, [], 'binding touching the cascaded grandchild dropped too')
assert.deepEqual(checkInvariants(chainRepaired), [], 'invariant-clean after ONE pass')

// Dedup collision: a shape BOTH orphaned (parent names nothing) and invalid
// (validProps) gets exactly ONE op — dropShape wins over reparentToRoot.
const dual = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:dual', kind: 'note', parentId: 'shape:ghost', props: {}, ...base(), opacity: 'no' as any } as any],
  bindings: [],
})
assert.deepEqual(repairPlan(dual), [{ op: 'dropShape', id: 'shape:dual' }], 'exactly one op for the doubly-flagged shape: dropShape')

// Sort tiebreak: two same-op violations constructed in REVERSE id order come
// out id-ascending — the (op, id) sort decides, not input order.
const rev = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:zz', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:aa', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
  ],
  bindings: [],
})
assert.deepEqual(repairPlan(rev), [
  { op: 'dropShape', id: 'shape:aa' },
  { op: 'dropShape', id: 'shape:zz' },
], 'same-op ops sort id-ascending regardless of construction order')

// Canonical page is EXPLICIT, not iteration-order luck: pages listed in
// non-sorted order (page:z first) — the orphan must land on the
// lexicographically smallest page id (page:a) on every peer.
const twoPage = makeDocument({
  pages: [{ id: 'page:z', name: 'Z' }, { id: 'page:a', name: 'A' }],
  shapes: [{ id: 'shape:orphan', kind: 'note', parentId: 'shape:ghost', props: {}, ...base() } as any],
  bindings: [],
})
const twoPagePlan = repairPlan(twoPage)
assert.deepEqual(twoPagePlan, [{ op: 'reparentToRoot', id: 'shape:orphan' }])
const twoPageRepaired = applyRepairToModel(twoPage, twoPagePlan)
assert.equal(
  twoPageRepaired.byId.get('shape:orphan')!.parentId,
  'page:a',
  'orphan re-roots to the lexicographically smallest page id, not pages[0]',
)
assert.deepEqual(checkInvariants(twoPageRepaired), [])

// Zero-page doc: orphans are unrepairable (no target page). repairPlan emits
// NO reparentToRoot op — checkInvariants still reports the orphan, and that's
// the honest outcome: a standing violation, not a forever-non-converging op.
const noPages = makeDocument({
  pages: [],
  shapes: [{ id: 'shape:orphan', kind: 'note', parentId: 'shape:ghost', props: {}, ...base() } as any],
  bindings: [],
})
assert.deepEqual(repairPlan(noPages), [], 'zero-page doc: no non-converging reparent op emitted')
assert.ok(checkInvariants(noPages).some((v) => v.rule === 'noOrphans'), 'the orphan violation stands — unrepairable')

// ---- dedupe: duplicate shape ids (the convergence rig's discovery) ----
// Two entries share shape:x — REACHABLE IN PRODUCTION via the supported
// offline reconnect flow (both clients delete+recreate the same id while
// disconnected; the tree CRDT keeps both physical nodes on merge). Pages and
// bindings cannot duplicate — they live in LoroMap containers keyed by id
// (LWW per key) — so uniqueIds scopes to shapes only.
const dupLoser = { id: 'shape:x', kind: 'note', parentId: 'page:p', props: {}, ...base(), x: 500 } as any
const dupWinner = { id: 'shape:x', kind: 'geo', parentId: 'page:p', props: {}, ...base() } as any
// Winner = smallest stableStringify. The entries differ first (in key-sorted
// serialization) at "kind": "geo" < "note", so dupWinner wins — verified
// here so the assertions below can't silently test the wrong entry.
assert.ok(stableStringify(dupWinner) < stableStringify(dupLoser), 'precondition: dupWinner is the content winner')
const dup = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as any,
    dupLoser,
    dupWinner,
  ],
  bindings: [{ id: 'binding:bx', fromId: 'shape:ok', toId: 'shape:x', props: {}, meta: {} }],
})
assert.deepEqual(
  checkInvariants(dup).map((v) => ({ rule: v.rule, id: v.id })),
  [{ rule: 'uniqueIds', id: 'shape:x' }],
  'ONE uniqueIds violation per duplicated id (not per entry), and nothing else fires',
)
const dupPlan = repairPlan(dup)
assert.deepEqual(dupPlan, [{ op: 'dedupeShape', id: 'shape:x' }])
const dupRepaired = applyRepairToModel(dup, dupPlan)
assert.deepEqual(
  dupRepaired.shapes.filter((s) => s.id === 'shape:x'),
  [dupWinner],
  'exactly the stableStringify-smallest entry survives',
)
assert.equal(dupRepaired.bindings.length, 1, 'a binding to the deduped id survives — the id still resolves')
assert.deepEqual(checkInvariants(dupRepaired), [])
assert.deepEqual(repairPlan(dupRepaired), [], 'dedupe is idempotent')

// stableStringify is key-order-INSENSITIVE (Loro reorders map keys across
// peers — the lesson that already cost one bug, see the order-independent
// shape comparison fix) and recursive; arrays stay order-SENSITIVE (element
// order is data there, e.g. richText content).
assert.equal(
  stableStringify({ a: 1, b: { d: 2, c: [1, 2] } }),
  stableStringify({ b: { c: [1, 2], d: 2 }, a: 1 }),
  'object key order never affects the serialization',
)
assert.notEqual(stableStringify({ c: [1, 2] }), stableStringify({ c: [2, 1] }), 'array order is data')

// dropShape ∩ uniqueIds collision: one duplicate entry is ALSO invalid →
// dropShape(x) subsumes dedupeShape(x): dropping every physical copy of the
// id (cascade included) is strictly stronger than collapsing them.
const dupBad = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:x', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:x', kind: 'geo', parentId: 'page:p', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const dupBadPlan = repairPlan(dupBad)
assert.deepEqual(dupBadPlan, [{ op: 'dropShape', id: 'shape:x' }], 'dropShape outranks dedupeShape for the same id')
const dupBadRepaired = applyRepairToModel(dupBad, dupBadPlan)
assert.deepEqual(dupBadRepaired.shapes, [], 'ALL physical copies of a dropped id go — the valid twin too')
assert.deepEqual(checkInvariants(dupBadRepaired), [])

console.log('ok: repair (model)')
