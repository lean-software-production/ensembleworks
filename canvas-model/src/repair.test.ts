// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { repairPlan, applyRepairToModel } from './repair.js'
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

console.log('ok: repair (model)')
