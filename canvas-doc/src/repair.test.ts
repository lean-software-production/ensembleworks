// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { applyRepairToModel, canonicalPageId, checkInvariants, repairPlan, type CanvasDocument } from '@ensembleworks/canvas-model'
import { dumpModel } from './bridge.js'

// Normalize for cross-engine comparison: Loro list order (tree traversal /
// map key order) need not match the model's array order — sort by id.
const byIdAsc = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
const normalize = (m: CanvasDocument) => ({
  pages: [...m.pages].sort(byIdAsc),
  shapes: [...m.shapes].sort(byIdAsc),
  bindings: [...m.bindings].sort(byIdAsc),
})

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putPage({ id: 'page:p', name: 'P' })
doc.putShape({ id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any)
// A dangling binding: toId points at a shape that never existed.
doc.putBinding({ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {}, meta: {} })
doc.commit()
assert.ok(checkInvariants(dumpModel(doc)).some((v) => v.rule === 'noDanglingBindings'))

const applied = doc.repair() // returns the plan it applied
doc.commit()
assert.deepEqual(applied.map((o) => o.op), ['deleteBinding'])
assert.deepEqual(checkInvariants(dumpModel(doc)), [], 'doc is invariant-clean after repair')
assert.deepEqual(doc.repair(), [], 'repair is idempotent on a clean doc')

// Same-pass binding cascade: binding:x is NOT dangling pre-repair (both
// endpoints exist), but its fromId shape drops in this very pass (validProps).
// A single repair() must delete the binding too — otherwise the doc diverges
// from applyRepairToModel and only converges on a SECOND repair() call.
const doc2 = LoroCanvasDoc.create({ peerId: 2n })
doc2.putPage({ id: 'page:p', name: 'P' })
doc2.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any)
// opacity AFTER the spread so it genuinely trips validProps (base() sets opacity: 1).
// putShapeUnchecked, not putShape: this seed is DELIBERATELY invalid — it
// stands in for what a remote peer's bytes can still deliver, which is the
// only way this state reaches a doc now that the write boundary validates.
doc2.putShapeUnchecked({ id: 'shape:bad', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
doc2.putBinding({ id: 'binding:x', fromId: 'shape:bad', toId: 'shape:ok', props: {}, meta: {} })
doc2.commit()
assert.ok(
  !checkInvariants(dumpModel(doc2)).some((v) => v.rule === 'noDanglingBindings'),
  'precondition: binding:x is not dangling before repair',
)

const applied2 = doc2.repair()
doc2.commit()
assert.deepEqual(applied2, [{ op: 'dropShape', id: 'shape:bad' }])
assert.deepEqual(doc2.listBindings(), [], 'binding orphaned by the same-pass drop is deleted too')
assert.deepEqual(checkInvariants(dumpModel(doc2)), [], 'ONE repair() call converges — no second pass needed')

// Order-independence (adversarial): a plan holding BOTH dropShape(s1) and
// reparentToRoot(s2), where s2 is ALSO a rescue candidate (its parentId names
// the dropped s1). Built via putShape's bulk-load tolerance: s1's parentId
// names s2 before s2 exists (s1 falls to real-tree root, data.parentId kept),
// then s2 lands under s1 — so the DUMPED model holds the 2-cycle s1↔s2 the
// real Loro tree cannot. s1 also fails validProps, so dedup gives
// dropShape(s1) while s2 keeps reparentToRoot (noCycles). This is the one
// fixture where the two rehoming rules compete for the same shape, and both
// engines must resolve it the same way: reparentToRoot wins, and its target is
// the canonical page. Loro-after-repair must equal applyRepairToModel no
// matter what order the ops are applied in.
const doc3 = LoroCanvasDoc.create({ peerId: 3n })
doc3.putPage({ id: 'page:p', name: 'P' })
doc3.putShapeUnchecked({ id: 'shape:s1', kind: 'note', parentId: 'shape:s2', props: {}, ...base(), opacity: 'no' } as any)
doc3.putShape({ id: 'shape:s2', kind: 'note', parentId: 'shape:s1', props: {}, ...base() } as any)
doc3.commit()
const before3 = dumpModel(doc3)
const plan3 = repairPlan(before3)
assert.deepEqual(plan3, [
  { op: 'dropShape', id: 'shape:s1' },
  { op: 'reparentToRoot', id: 'shape:s2' },
], 'precondition: the plan pairs a drop with a reparent of the dropped shape’s own child')
const expected3 = applyRepairToModel(before3, plan3)
const applied3 = doc3.repair()
doc3.commit()
assert.deepEqual(applied3, plan3)
assert.deepEqual(normalize(dumpModel(doc3)), normalize(expected3), 'Loro and model application agree (order-independent)')
assert.deepEqual(checkInvariants(dumpModel(doc3)), [], 'invariant-clean after ONE repair()')

// PROPORTIONATE drop, 3 levels deep, on the Loro doc: dropping the invalid
// root removes ONLY that root. Its direct child is rescued onto the dropped
// root's page, the grandchild rides along under the rescued child (untouched),
// and the binding touching the grandchild SURVIVES — the grandchild is still
// there, so the binding is not dangling. Shapes are PUT descendants-first
// (loadModel's bulk-load pattern: fall to root, then a reparent pass fixes
// placement), so listShapes() — node-creation order — yields the grandchild
// before its ancestors; the assertions below sort, so they do not depend on it.
const doc4 = LoroCanvasDoc.create({ peerId: 4n })
doc4.putPage({ id: 'page:p', name: 'P' })
doc4.putShape({ id: 'shape:ar4', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any)
doc4.putShape({ id: 'shape:grandchild4', kind: 'note', parentId: 'shape:child4', props: {}, ...base() } as any)
doc4.putShape({ id: 'shape:child4', kind: 'note', parentId: 'shape:bad4', props: {}, ...base() } as any)
doc4.putShapeUnchecked({ id: 'shape:bad4', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
doc4.reparent('shape:child4', 'shape:bad4')
doc4.reparent('shape:grandchild4', 'shape:child4')
doc4.putBinding({ id: 'binding:g4', fromId: 'shape:ar4', toId: 'shape:grandchild4', props: {}, meta: {} })
doc4.commit()
{
  const order = dumpModel(doc4).shapes.map((s) => s.id)
  assert.ok(
    order.indexOf('shape:grandchild4') < order.indexOf('shape:child4'),
    `precondition: dump lists the grandchild before its parent (adversarial order); got ${order.join(', ')}`,
  )
}

const before4 = dumpModel(doc4)
const applied4 = doc4.repair()
doc4.commit()
assert.deepEqual(applied4, [{ op: 'dropShape', id: 'shape:bad4' }], 'plan names only the invalid root')
assert.deepEqual(
  doc4.listShapes().map((s) => s.id).sort(),
  ['shape:ar4', 'shape:child4', 'shape:grandchild4'],
  'ONLY bad4 is gone — child4 and grandchild4 survive',
)
assert.equal(doc4.getShape('shape:child4')!.parentId, 'page:p', 'the direct child is rescued to its own page')
assert.equal(doc4.getShape('shape:grandchild4')!.parentId, 'shape:child4', 'the grandchild is untouched, still under the rescued child')
assert.deepEqual(doc4.listBindings().map((b) => b.id), ['binding:g4'], 'the binding survives — its endpoint was rescued, not dropped')
assert.deepEqual(checkInvariants(dumpModel(doc4)), [], 'invariant-clean after ONE repair()')
assert.deepEqual(normalize(dumpModel(doc4)), normalize(applyRepairToModel(before4, repairPlan(before4))), 'model-agreement on the 3-level rescue')

// ---- (5) dedupe: duplicate physical nodes for ONE shape id (the reviewer's
// raw-doc repro of the offline delete+recreate race). Two docs fork from a
// shared genesis holding shape:x; both delete+recreate shape:x concurrently
// (different content) and cross-import: the tree CRDT keeps BOTH new physical
// nodes — every peer now lists two entries for shape:x. Also builds the
// CHILD-RESCUE case: shape:y is created under the copy that will LOSE the
// content-winner election, and must survive the dedupe under the winner. ----
{
  const genesis = LoroCanvasDoc.create({ peerId: 50n })
  genesis.putPage({ id: 'page:p', name: 'P' })
  genesis.putShape({ id: 'shape:x', kind: 'note', parentId: 'page:p', props: {}, ...base() } as any)
  genesis.commit()
  const snap = genesis.exportSnapshot()

  const docA = LoroCanvasDoc.fromSnapshot(snap, { peerId: 51n })
  const docB = LoroCanvasDoc.fromSnapshot(snap, { peerId: 52n })

  // A: delete + recreate as 'note' (the content LOSER — "note" > "geo" at the
  // first divergent key of the key-sorted serialization), then hang a child
  // under it: y's physical node lands under A's (losing) copy.
  docA.deleteShape('shape:x')
  docA.putShape({ id: 'shape:x', kind: 'note', parentId: 'page:p', props: {}, ...base(), x: 500 } as any)
  docA.putShape({ id: 'shape:y', kind: 'note', parentId: 'shape:x', props: {}, ...base() } as any)
  docA.commit()

  // B: delete + recreate as 'geo' (the content WINNER).
  docB.deleteShape('shape:x')
  docB.putShape({ id: 'shape:x', kind: 'geo', parentId: 'page:p', props: {}, ...base() } as any)
  docB.commit()

  const updA = docA.exportUpdate()
  const updB = docB.exportUpdate()
  docA.import(updB); docA.commit()
  docB.import(updA); docB.commit()

  assert.equal(
    docA.listShapes().filter((s) => s.id === 'shape:x').length, 2,
    'precondition: the merge kept BOTH physical nodes for shape:x',
  )
  assert.ok(
    checkInvariants(dumpModel(docA)).some((v) => v.rule === 'uniqueIds' && v.id === 'shape:x'),
    'the duplicate is VISIBLE to invariants (uniqueIds)',
  )

  // PIN the pre-repair public-API anomaly on a throwaway clone — the textbook
  // "undeletable shape": deleteShape kills only the first physical match, so
  // getShape still answers for the id afterwards. This documents the REAL
  // misbehavior dedupe exists to heal (it is intentionally not "fixed" at the
  // deleteShape level: repair is the healing pass, first-match is the
  // documented single-node contract).
  {
    const clone = LoroCanvasDoc.fromSnapshot(docA.exportSnapshot(), { peerId: 53n })
    clone.deleteShape('shape:x')
    assert.ok(
      clone.getShape('shape:x') !== undefined,
      'PINNED pre-repair symptom: deleteShape removed only one physical copy — the id is undeletable',
    )
  }

  // Repair: every peer computes the same content winner and collapses to it.
  const before5 = dumpModel(docA)
  const plan5 = repairPlan(before5)
  assert.deepEqual(plan5, [{ op: 'dedupeShape', id: 'shape:x' }], 'the plan names exactly one dedupe')
  const expected5 = applyRepairToModel(before5, plan5)

  const appliedA = docA.repair(); docA.commit()
  const appliedB = docB.repair(); docB.commit()
  assert.deepEqual(appliedA, plan5)
  assert.deepEqual(appliedB, plan5, 'both peers compute the identical plan from converged state')

  assert.equal(docA.listShapes().filter((s) => s.id === 'shape:x').length, 1, 'exactly ONE physical node survives')
  assert.equal(docA.getShape('shape:x')!.kind, 'geo', 'the survivor is the content winner (smallest stableStringify)')
  assert.ok(docA.getShape('shape:y'), 'CHILD RESCUE: the child parented under the LOSING node survives')
  assert.equal(docA.getShape('shape:y')!.parentId, 'shape:x', 'the rescued child still resolves its parent by id')
  assert.deepEqual(checkInvariants(dumpModel(docA)), [], 'invariant-clean after ONE repair()')
  assert.deepEqual(normalize(dumpModel(docA)), normalize(expected5), 'model-agreement: Loro repair == applyRepairToModel')
  assert.deepEqual(normalize(dumpModel(docA)), normalize(dumpModel(docB)), 'both peers converge to the identical repaired state')
  assert.deepEqual(docA.repair(), [], 'dedupe is idempotent')

  // The id is genuinely deletable now — and the cascade takes the RESCUED
  // child with it, proving y was physically re-homed under the winner (not
  // left dangling under a tombstone).
  docA.deleteShape('shape:x')
  docA.commit()
  assert.equal(docA.getShape('shape:x'), undefined, 'post-repair, deleteShape actually deletes the id')
  assert.equal(docA.getShape('shape:y'), undefined, 'the rescued child cascades with the winner — physical rescue proven')
}

// ---- (6) ORDER PIN: the reported defect, straight through Loro: one bad prop
// on a frame must not execute the frame's contents, and must not wipe their
// TEXT containers. Text is the part only the Loro side can lose — deleteNode
// cascades over the real tree and clears every descendant's text container, so
// this asserts the rescue happens BEFORE the delete, not merely that the shape
// row survives. ----
const doc6 = LoroCanvasDoc.create({ peerId: 6n })
doc6.putPage({ id: 'page:p', name: 'P' })
doc6.putShapeUnchecked({ id: 'shape:f6', kind: 'frame', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
doc6.putShape({ id: 'shape:k6', kind: 'note', parentId: 'shape:f6', props: {}, ...base() } as any)
doc6.putShape({ id: 'shape:gk6', kind: 'note', parentId: 'shape:k6', props: {}, ...base() } as any)
doc6.setText('shape:k6', 'precious content')
doc6.setText('shape:gk6', 'also precious')
doc6.commit()

const before6 = dumpModel(doc6)
const plan6 = doc6.repair()
doc6.commit()
assert.deepEqual(plan6, [{ op: 'dropShape', id: 'shape:f6' }])
assert.deepEqual(
  doc6.listShapes().map((s) => s.id).sort(),
  ['shape:gk6', 'shape:k6'],
  'the frame is gone; its contents survive',
)
assert.equal(doc6.getText('shape:k6'), 'precious content', 'the rescued child keeps its text container')
assert.equal(doc6.getText('shape:gk6'), 'also precious', 'the rescued grandchild keeps its text container')
assert.deepEqual(checkInvariants(dumpModel(doc6)), [], 'ONE repair() call converges')
assert.deepEqual(doc6.repair(), [], 'still idempotent')
assert.deepEqual(normalize(dumpModel(doc6)), normalize(applyRepairToModel(before6, repairPlan(before6))), 'model-agreement on the proportionality case')

// ---- (7) SAME-PAGE rescue (owner ruling 11) on a MULTI-PAGE doc. Every other
// fixture in this file has exactly one page (page:p), where the same-page
// target and canonicalPageId are the same value and the rule is therefore
// UNTESTABLE — a same-page assertion on those fixtures passes vacuously. Two
// pages, with the bad shapes on the NON-canonical one, is the minimum that
// discriminates: canonicalPageId = page:a, the correct answer = page:z.
//
// Note what this fixture deliberately does NOT try to pin: the "rescue to
// pages[0]" mutant. dumpModel's page order comes from LoroMap.keys(), which
// converges sorted, so at the canvas-doc level pages[0] IS the canonical page
// and the two are inseparable. That mutant is killed in canvas-model's
// repair.test.ts, where the page array order is the fixture's own.
//
// The chained drop (shape:mid7's own parent is dropped too) additionally pins
// that the walk passes THROUGH a dropped ancestor to the page rather than
// stopping on it — the case where a naive "use the dropped parent's parentId"
// stamps a tombstoned id onto the survivor.
const doc7 = LoroCanvasDoc.create({ peerId: 7n })
doc7.putPage({ id: 'page:a', name: 'A' })
doc7.putPage({ id: 'page:z', name: 'Z' })
doc7.putShapeUnchecked({ id: 'shape:bad7', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc7.putShapeUnchecked({ id: 'shape:mid7', kind: 'frame', parentId: 'shape:bad7', props: {}, ...base(), opacity: 'no' } as any)
doc7.putShape({ id: 'shape:kid7', kind: 'note', parentId: 'shape:mid7', props: {}, ...base() } as any)
doc7.commit()
{
  const before7 = dumpModel(doc7)
  assert.equal(canonicalPageId(before7.pages), 'page:a', 'precondition: the canonical page is NOT the page the bad frames live on')
  const plan7 = repairPlan(before7)
  assert.deepEqual(plan7, [
    { op: 'dropShape', id: 'shape:bad7' },
    { op: 'dropShape', id: 'shape:mid7' },
  ], 'precondition: BOTH frames are dropped, so the rescue walk must pass through a dropped ancestor')
  const expected7 = applyRepairToModel(before7, plan7)
  assert.deepEqual(doc7.repair(), plan7)
  doc7.commit()
  assert.deepEqual(doc7.listShapes().map((s) => s.id), ['shape:kid7'], 'both bad frames gone, the innocent note survives')
  assert.equal(
    doc7.getShape('shape:kid7')!.parentId,
    'page:z',
    'the rescued child stays on its own page (page:z) — not the canonical page (page:a)',
  )
  assert.deepEqual(checkInvariants(dumpModel(doc7)), [], 'invariant-clean after ONE repair()')
  assert.deepEqual(normalize(dumpModel(doc7)), normalize(expected7), 'model-agreement: Loro and model pick the SAME page')
  assert.deepEqual(doc7.repair(), [], 'idempotent')
}

// ---- (8) LOGICAL child rescue: a shape whose STORED parentId names the
// dropped shape while its real tree node is NOT a child of it. placeInTree
// parks a shape at the Loro tree ROOT when its parentId names a node that
// does not exist yet, retaining data.parentId — so n.children() cannot see
// it, but applyRepairToModel's drop.has(s.parentId) test can. This is the
// state reconcile() reaches in production (its "Absent-parent tolerance"
// note) and that Loro's own cycle resolution reaches over /sync/v2. Two
// pages, bad shape on the NON-canonical one, so the same assertion also
// discriminates the rescue TARGET. ----
const doc8 = LoroCanvasDoc.create({ peerId: 8n })
doc8.putPage({ id: 'page:a', name: 'A' })
doc8.putPage({ id: 'page:z', name: 'Z' })
doc8.putShape({ id: 'shape:kid8', kind: 'note', parentId: 'shape:bad8', props: {}, ...base() } as any)
doc8.putShapeUnchecked({ id: 'shape:bad8', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc8.setText('shape:kid8', 'precious content')
doc8.commit()
{
  const badNode = (doc8 as any).nodeByShapeId('shape:bad8')
  assert.deepEqual(
    (badNode.children() ?? []).map((n: any) => n.data.get('shapeId')),
    [],
    'precondition: kid8 is a LOGICAL child of bad8 only — the real tree node has no children at all',
  )
  assert.equal(doc8.getShape('shape:kid8')!.parentId, 'shape:bad8', 'precondition: kid8 stored parentId still names bad8')
  const before8 = dumpModel(doc8)
  assert.equal(canonicalPageId(before8.pages), 'page:a', 'precondition: the canonical page is NOT the page bad8 lives on')
  const plan8 = repairPlan(before8)
  assert.deepEqual(plan8, [{ op: 'dropShape', id: 'shape:bad8' }], 'precondition: the plan drops only bad8')
  const expected8 = applyRepairToModel(before8, plan8)
  assert.deepEqual(doc8.repair(), plan8)
  doc8.commit()
  assert.deepEqual(doc8.listShapes().map((s) => s.id).sort(), ['shape:kid8'], 'the logical child survives the drop')
  assert.equal(
    doc8.getShape('shape:kid8')!.parentId,
    'page:z',
    'the rescued LOGICAL child is on the dropped parent’s own page (page:z) — not left dangling at shape:bad8, not sent to the canonical page:a',
  )
  assert.equal(doc8.getText('shape:kid8'), 'precious content', 'the rescued logical child keeps its text container')
  assert.deepEqual(checkInvariants(dumpModel(doc8)), [], 'invariant-clean after ONE repair() — no second pass')
  assert.deepEqual(normalize(dumpModel(doc8)), normalize(expected8), 'model-agreement on the logical rescue')
  assert.deepEqual(doc8.repair(), [], 'idempotent')
}

// ---- (9) The two child sets are DIFFERENT, and each needs its own
// treatment. White-box tree.move calls build the split-brain states directly:
// no public-API sequence is known to produce a PHYSICAL child whose stored
// parentId names something else (every mutator that moves a node also writes
// data.parentId, and Loro resolves a concurrent move cycle to the tree ROOT,
// which is doc8's shape, not this one). This pins the intended contract the
// same way hand-built plans pin repair()'s other unreachable guards. ----
const doc9 = LoroCanvasDoc.create({ peerId: 19n })
doc9.putPage({ id: 'page:a', name: 'A' })
doc9.putPage({ id: 'page:z', name: 'Z' })
doc9.putShapeUnchecked({ id: 'shape:bad9', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc9.putShape({ id: 'shape:host9', kind: 'frame', parentId: 'page:a', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:squat9', kind: 'note', parentId: 'page:a', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:kid9', kind: 'note', parentId: 'shape:bad9', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:far9', kind: 'note', parentId: 'shape:bad9', props: {}, ...base() } as any)
doc9.setText('shape:squat9', 'squatter text')
{
  const tree9 = (doc9 as any).tree
  const node9 = (id: string) => (doc9 as any).nodeByShapeId(id)
  // squat9: a PHYSICAL child of bad9 whose stored parentId still says page:a.
  tree9.move(node9('shape:squat9').id, node9('shape:bad9').id)
  // far9: a LOGICAL child of bad9 parked under an unrelated SURVIVOR — so the
  // rescue cannot be a no-op that merely happens to leave it at the root.
  tree9.move(node9('shape:far9').id, node9('shape:host9').id)
  doc9.commit()
  assert.equal(doc9.getShape('shape:squat9')!.parentId, 'page:a', 'precondition: squat9 is physically under bad9 but logically on page:a')
  assert.equal(doc9.getShape('shape:far9')!.parentId, 'shape:bad9', 'precondition: far9 is logically bad9’s child but physically under host9')
  const before9 = dumpModel(doc9)
  const plan9 = repairPlan(before9)
  assert.deepEqual(plan9, [{ op: 'dropShape', id: 'shape:bad9' }], 'precondition: the plan drops only bad9')
  const expected9 = applyRepairToModel(before9, plan9)
  assert.deepEqual(doc9.repair(), plan9)
  doc9.commit()
  assert.deepEqual(
    doc9.listShapes().map((s) => s.id).sort(),
    ['shape:far9', 'shape:host9', 'shape:kid9', 'shape:squat9'],
    'only bad9 is gone — the physical squatter is NOT swept up by the cascade',
  )
  assert.equal(
    doc9.getShape('shape:squat9')!.parentId,
    'page:a',
    'a PHYSICAL-only child keeps its stored parentId — the model does not rehome it, so neither may Loro',
  )
  assert.equal(doc9.getText('shape:squat9'), 'squatter text', 'the physical-only child keeps its text container')
  assert.equal(doc9.getShape('shape:far9')!.parentId, 'page:z', 'the LOGICAL child is rescued to bad9’s own page')
  assert.equal(doc9.getShape('shape:kid9')!.parentId, 'page:z', 'the ordinary logical+physical child is rescued the same way')
  assert.deepEqual(checkInvariants(dumpModel(doc9)), [], 'invariant-clean after ONE repair()')
  assert.deepEqual(normalize(dumpModel(doc9)), normalize(expected9), 'model-agreement on the mixed physical/logical case')
  assert.deepEqual(doc9.repair(), [], 'idempotent')
  // far9 was lifted PHYSICALLY, not merely restamped: deleting its former
  // physical host must not take it along. Same proof shape as the dedupe
  // block's 'physical rescue proven' assertion.
  doc9.deleteShape('shape:host9')
  doc9.commit()
  assert.ok(doc9.getShape('shape:far9'), 'the rescued logical child was physically lifted off its old host — proven by the host’s cascade')
}

console.log('ok: repair (doc)')
