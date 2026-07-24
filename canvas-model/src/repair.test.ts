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

// Chain under a dropped shape (3 levels): dropping the invalid root rescues
// its direct child to the page bad2 was already on; the grandchild keeps its
// surviving parent; a binding whose endpoints (ar2, grandchild) both still
// exist survives. Two pages (page:a, page:p) so this discriminates: bad2's
// page is page:p, canonicalPageId is page:a (lexicographically smallest) —
// the assertion below can only pass if the same-page rule, not the doc-wide
// fallback, picked the target. Descendants are listed BEFORE ancestors below
// — a holdover from the cascade era, when that ordering pinned a real
// fixpoint requirement. The rescue is now a single pass keyed on the plan's
// `drop` set, so it cannot be order-sensitive by construction; this ordering
// is no longer load-bearing.
const chain = makeDocument({
  pages: [{ id: 'page:a', name: 'A' }, { id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:ar2', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:grandchild', kind: 'note', parentId: 'shape:child', props: {}, ...base() } as any,
    { id: 'shape:child', kind: 'note', parentId: 'shape:bad2', props: {}, ...base() } as any,
    { id: 'shape:bad2', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
  ],
  bindings: [{ id: 'binding:g', fromId: 'shape:ar2', toId: 'shape:grandchild', props: {}, meta: {} }],
})
const chainPlan = repairPlan(chain)
assert.deepEqual(chainPlan, [{ op: 'dropShape', id: 'shape:bad2' }], 'only the invalid root is in the plan — descendants are rescued, not cascaded')
const chainRepaired = applyRepairToModel(chain, chainPlan)
// CHANGED 2026-07-20 (proportionality, owner ruling 4): dropping bad2 no
// longer cascades. `child` is rescued to the page bad2 was already on,
// `grandchild` keeps `child` as its parent, and binding:g — whose endpoints
// (ar2, grandchild) BOTH still exist — survives with them.
assert.deepEqual(
  chainRepaired.shapes.map((s) => s.id).sort(),
  ['shape:ar2', 'shape:child', 'shape:grandchild'],
  'only bad2 is dropped; child and grandchild are rescued',
)
assert.equal(chainRepaired.byId.get('shape:child')!.parentId, 'page:p', 'child rescued to bad2\'s page')
assert.deepEqual(chainRepaired.bindings.map((b) => b.id), ['binding:g'], 'a binding whose endpoints both survive is kept')
assert.deepEqual(checkInvariants(chainRepaired), [], 'invariant-clean after ONE pass')

// ---- PROPORTIONALITY (2026-07-20, owner ruling 4) ----
// The reported defect, in the pure model: a frame with ONE bad numeric prop
// must not execute its innocent contents. `props: { w: 'wide' }` fails the
// frame's per-kind props schema (w is z.number().optional()), so validProps
// fires on the frame and on nothing else.
//
// Three pages separate three possible rescue targets: pages[0] is page:m,
// canonicalPageId is page:a, and the same-page rule's answer is page:z — the
// page shape:badf was already on. A single equality on the rescued child's
// parentId is a three-way discriminator between all of them. Three bindings
// pin the binding rule from both sides: the one pointing AT the dropped shape
// must be swept (it is not dangling before the repair, so the plan carries no
// deleteBinding op for it — only a same-pass sweep converges in ONE call),
// while the two pointing at RESCUED shapes must survive.
const rescueDoc = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
  shapes: [
    { id: 'shape:arw', kind: 'arrow', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:badf', kind: 'frame', parentId: 'page:z', props: { w: 'wide' }, ...base() } as any,
    { id: 'shape:kid', kind: 'note', parentId: 'shape:badf', props: {}, ...base() } as any,
    { id: 'shape:gkid', kind: 'note', parentId: 'shape:kid', props: {}, ...base() } as any,
  ],
  bindings: [
    { id: 'binding:toBad', fromId: 'shape:arw', toId: 'shape:badf', props: {}, meta: {} },
    { id: 'binding:toKid', fromId: 'shape:arw', toId: 'shape:kid', props: {}, meta: {} },
    { id: 'binding:toGkid', fromId: 'shape:arw', toId: 'shape:gkid', props: {}, meta: {} },
  ],
})
const rescuePlan = repairPlan(rescueDoc)
assert.deepEqual(rescuePlan, [{ op: 'dropShape', id: 'shape:badf' }], 'precondition: the frame is the only flagged shape')
const rescued = applyRepairToModel(rescueDoc, rescuePlan)
assert.deepEqual(
  rescued.shapes.map((s) => s.id).sort(),
  ['shape:arw', 'shape:gkid', 'shape:kid'],
  'only the invalid shape is removed',
)
assert.equal(
  rescued.byId.get('shape:kid')!.parentId,
  'page:z',
  'the rescued child stays on its own page (page:z) — not pages[0] (page:m), not the canonical page (page:a)',
)
assert.equal(
  rescued.byId.get('shape:gkid')!.parentId,
  'shape:kid',
  'a grandchild keeps its surviving parent — only DIRECT children are rehomed',
)
assert.deepEqual(
  rescued.bindings.map((b) => b.id).sort(),
  ['binding:toGkid', 'binding:toKid'],
  'bindings to rescued children survive; the binding to the dropped shape is swept',
)
assert.deepEqual(checkInvariants(rescued), [], 'invariant-clean after ONE pass')

// Removal outranks rescue: a child that is ITSELF invalid is dropped, not
// resurrected by the rescue map. Its own valid child is then rescued to the
// page — proving the rescue target is resolved against the plan, not against
// whatever the parent chain happened to become.
const bothBad = makeDocument({
  pages: [{ id: 'page:a', name: 'A' }, { id: 'page:b', name: 'B' }],
  shapes: [
    { id: 'shape:badp', kind: 'note', parentId: 'page:b', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:badc', kind: 'note', parentId: 'shape:badp', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:okg', kind: 'note', parentId: 'shape:badc', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const bothBadPlan = repairPlan(bothBad)
assert.deepEqual(
  bothBadPlan,
  [{ op: 'dropShape', id: 'shape:badc' }, { op: 'dropShape', id: 'shape:badp' }],
  'precondition: both invalid shapes are named, id-ascending',
)
const bothBadRepaired = applyRepairToModel(bothBad, bothBadPlan)
assert.deepEqual(bothBadRepaired.shapes.map((s) => s.id), ['shape:okg'], 'both invalid shapes go; only the valid grandchild survives')
assert.equal(
  bothBadRepaired.byId.get('shape:okg')!.parentId,
  'page:b',
  'the walk passes THROUGH a dropped ancestor to the page (page:b), never stopping on shape:badp',
)
assert.deepEqual(checkInvariants(bothBadRepaired), [], 'invariant-clean after ONE pass')

// The rescue target is always a PAGE, never a surviving shape. shape:innerbad
// is dropped from inside a perfectly healthy frame; its child does NOT get
// re-nested into that frame (repair has no mandate to invent a containment
// relationship — it rehomes to the page root, on the page the shape was
// already on).
const nested = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
  shapes: [
    { id: 'shape:outer', kind: 'frame', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:innerbad', kind: 'frame', parentId: 'shape:outer', props: { w: 'wide' }, ...base() } as any,
    { id: 'shape:kid2', kind: 'note', parentId: 'shape:innerbad', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const nestedPlan = repairPlan(nested)
assert.deepEqual(nestedPlan, [{ op: 'dropShape', id: 'shape:innerbad' }], 'precondition: only the inner frame is flagged')
const nestedRepaired = applyRepairToModel(nested, nestedPlan)
assert.equal(
  nestedRepaired.byId.get('shape:kid2')!.parentId,
  'page:z',
  'the walk continues past a SURVIVING ancestor shape to its page — rescue targets a page root, never shape:outer',
)
assert.deepEqual(checkInvariants(nestedRepaired), [], 'invariant-clean after ONE pass')

// No page ancestor at all: the dropped shape is itself an orphan, so walking
// up dead-ends. There is no "same page" to stay on, so the rescue falls back
// to canonicalPageId — the pre-5A doc-wide target. Falling back is forced, not
// chosen: leaving the child on a nonexistent parent would emit a FRESH
// noOrphans violation out of a pass that is required to converge in one call.
// This also pins that a page ancestor is decided by MEMBERSHIP in doc.pages,
// not by the `page:` prefix — 'page:ghost' has the prefix and names no page.
const deadEnd = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }],
  shapes: [
    { id: 'shape:lost', kind: 'note', parentId: 'page:ghost', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:kept', kind: 'note', parentId: 'shape:lost', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const deadEndPlan = repairPlan(deadEnd)
assert.deepEqual(deadEndPlan, [{ op: 'dropShape', id: 'shape:lost' }], 'precondition: drop subsumes the orphan reparent for shape:lost')
const deadEndRepaired = applyRepairToModel(deadEnd, deadEndPlan)
assert.equal(
  deadEndRepaired.byId.get('shape:kept')!.parentId,
  'page:a',
  'no page ancestor ⇒ fall back to the canonical page, never to the prefix-shaped non-page page:ghost',
)
assert.deepEqual(checkInvariants(deadEndRepaired), [], 'invariant-clean after ONE pass')

// Cycle guard. repairPlan can never produce this pairing (a shape whose parent
// chain cycles is itself flagged noCycles, so it is reparented rather than
// rescued), so the plan here is HAND-BUILT — the same dead-code-safety
// contract applyRepairToModel already honours for zero-page plans. Without a
// visited set the walk never terminates: a wrong implementation HANGS here
// rather than failing an assertion.
const cyc = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }],
  shapes: [
    { id: 'shape:cycA', kind: 'note', parentId: 'shape:cycB', props: {}, ...base() } as any,
    { id: 'shape:cycB', kind: 'note', parentId: 'shape:cycA', props: {}, ...base() } as any,
    { id: 'shape:kid3', kind: 'note', parentId: 'shape:cycB', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const cycRepaired = applyRepairToModel(cyc, [{ op: 'dropShape', id: 'shape:cycB' }])
assert.equal(
  cycRepaired.byId.get('shape:kid3')!.parentId,
  'page:a',
  'a cycling parent chain terminates and falls back to the canonical page',
)
assert.deepEqual(checkInvariants(cycRepaired), [], 'invariant-clean after ONE pass')

// reparentToRoot is NOT touched by the same-page rule: an orphan/cycle member
// has no page to stay on, which is the entire reason that op exists. Hand-built
// again, because repairPlan cannot pair reparentToRoot with a resolvable page
// ancestor (see the cycle note above), so only a hand-built plan can tell the
// two targets apart.
const reroot = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
  shapes: [
    { id: 'shape:host', kind: 'frame', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:orph2', kind: 'note', parentId: 'shape:host', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const rerooted = applyRepairToModel(reroot, [{ op: 'reparentToRoot', id: 'shape:orph2' }])
assert.equal(
  rerooted.byId.get('shape:orph2')!.parentId,
  'page:a',
  'reparentToRoot still targets the canonical page — the same-page rule applies to the RESCUE path only',
)
assert.deepEqual(checkInvariants(rerooted), [], 'invariant-clean after ONE pass')

// Purity: the target is resolved through doc.byId (the content winner), never
// through a first-match scan of doc.shapes, and never through the partially
// rehomed output. shape:dupp has two entries on DIFFERENT pages; the geo entry
// wins the content election (see the dedupe block below), so the walk must
// land on page:m even though the note entry (page:z) comes first in the array.
// The reversed construction below asserts the same result under a permuted
// input, which is the property canonicalPageId exists to protect.
const dupChainShapes = [
  { id: 'shape:dupp', kind: 'note', parentId: 'page:z', props: {}, ...base() } as any,
  { id: 'shape:dupp', kind: 'geo', parentId: 'page:m', props: {}, ...base() } as any,
  { id: 'shape:baddd', kind: 'note', parentId: 'shape:dupp', props: {}, ...base(), opacity: 'no' as any } as any,
  { id: 'shape:kiddd', kind: 'note', parentId: 'shape:baddd', props: {}, ...base() } as any,
]
const dupPages = [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }] as const
const projectIds = (d: ReturnType<typeof applyRepairToModel>) =>
  d.shapes.map((s) => `${s.id}<-${s.parentId}`).sort()
const dupChain = makeDocument({ pages: dupPages, shapes: dupChainShapes, bindings: [] })
const dupChainRepaired = applyRepairToModel(dupChain, repairPlan(dupChain))
assert.equal(
  dupChainRepaired.byId.get('shape:kiddd')!.parentId,
  'page:m',
  'the walk resolves an ancestor id through byId (content winner, page:m) — not the first array match (page:z)',
)
const dupChainRev = makeDocument({ pages: [...dupPages].reverse(), shapes: [...dupChainShapes].reverse(), bindings: [] })
assert.deepEqual(
  projectIds(applyRepairToModel(dupChainRev, repairPlan(dupChainRev))),
  projectIds(dupChainRepaired),
  'identical converged state ⇒ identical rescue targets, whatever order the arrays arrive in',
)
assert.deepEqual(checkInvariants(dupChainRepaired), [], 'invariant-clean after ONE pass')

// Zero-page doc: no rescue target exists, so dropShape is SUPPRESSED and the
// violation is left standing — the same policy repairPlan already applies to
// reparentToRoot (ruling 3, decision D4). Emitting a drop we could only apply
// by deleting the children would be disproportionate deletion by another route.
const noPageBad = makeDocument({
  pages: [],
  shapes: [{ id: 'shape:badnp', kind: 'note', parentId: 'shape:badnp', props: {}, ...base(), opacity: 'no' as any } as any],
  bindings: [],
})
assert.deepEqual(repairPlan(noPageBad), [], 'a zero-page doc emits no dropShape — there is no rescue target')
assert.ok(checkInvariants(noPageBad).some((v) => v.rule === 'validProps'), 'the validProps violation stands — honestly unrepairable')

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
// id is strictly stronger than collapsing them down to one.
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

// ---- ORDER PIN: dedupe's winnerKey must be captured from doc.shapes BEFORE
// the rescue map touches parentId (2026-07-20, quality-review finding 1) ----
// shape:bad3 is invalid (dropped). shape:dup3 has TWO physical entries: one
// parented under shape:bad3 (rescue-eligible once bad3 drops), the other
// parented under a nonexistent shape:ghost3 (noOrphans -> reparentToRoot).
// Both conditions independently route shape:dup3's survivor to page:p, so
// dedupeShape(dup3) COEXISTS with reparentToRoot(dup3) in the plan (see the
// coexistence comment above repairPlan's dedup step). If the rescue .map ever
// ran BEFORE the dedupe filter, both physical entries would already carry
// parentId: page:p by the time the dedupe filter re-derives stableStringify,
// which no longer matches the winnerKey captured from the ORIGINAL (pre-map)
// entries — so NEITHER entry matches and the id is silently annihilated.
const orderDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:bad3', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:dup3', kind: 'note', parentId: 'shape:bad3', props: {}, ...base() } as any,
    { id: 'shape:dup3', kind: 'geo', parentId: 'shape:ghost3', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const orderPlan = repairPlan(orderDoc)
assert.deepEqual(
  orderPlan,
  [
    { op: 'dropShape', id: 'shape:bad3' },
    { op: 'dedupeShape', id: 'shape:dup3' },
    { op: 'reparentToRoot', id: 'shape:dup3' },
  ],
  'precondition: drop + coexisting dedupe/reparent ops for shape:dup3',
)
const orderRepaired = applyRepairToModel(orderDoc, orderPlan)
assert.deepEqual(
  orderRepaired.shapes.map((s) => `${s.id}<-${s.parentId}`),
  ['shape:dup3<-page:p'],
  'exactly ONE surviving physical copy of shape:dup3, rescued to the canonical page — not annihilated',
)
assert.deepEqual(checkInvariants(orderRepaired), [])

console.log('ok: repair (model)')
