// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { applyRepairToModel, checkInvariants, repairPlan, type CanvasDocument } from '@ensembleworks/canvas-model'
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
doc2.putShape({ id: 'shape:bad', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
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
// reparentToRoot(s2) where s2 is inside s1's cascade. Built via putShape's
// bulk-load tolerance: s1's parentId names s2 before s2 exists (s1 falls to
// real-tree root, data.parentId kept), then s2 lands under s1 — so the DUMPED
// model holds the 2-cycle s1↔s2 the real Loro tree cannot. s1 also fails
// validProps, so dedup gives dropShape(s1) while s2 keeps reparentToRoot
// (noCycles). Loro-after-repair must equal applyRepairToModel no matter what
// order the ops are applied in — reparent must never resurrect a shape the
// drop cascade claims.
const doc3 = LoroCanvasDoc.create({ peerId: 3n })
doc3.putPage({ id: 'page:p', name: 'P' })
doc3.putShape({ id: 'shape:s1', kind: 'note', parentId: 'shape:s2', props: {}, ...base(), opacity: 'no' } as any)
doc3.putShape({ id: 'shape:s2', kind: 'note', parentId: 'shape:s1', props: {}, ...base() } as any)
doc3.commit()
const before3 = dumpModel(doc3)
const plan3 = repairPlan(before3)
assert.deepEqual(plan3, [
  { op: 'dropShape', id: 'shape:s1' },
  { op: 'reparentToRoot', id: 'shape:s2' },
], 'precondition: the plan pairs a drop with a reparent of a shape inside its cascade')
const expected3 = applyRepairToModel(before3, plan3)
const applied3 = doc3.repair()
doc3.commit()
assert.deepEqual(applied3, plan3)
assert.deepEqual(normalize(dumpModel(doc3)), normalize(expected3), 'Loro and model application agree (order-independent)')
assert.deepEqual(checkInvariants(dumpModel(doc3)), [], 'invariant-clean after ONE repair()')

// Cascade fixpoint (3 levels) on the Loro doc: dropping the invalid root
// removes child AND grandchild (the real-tree subtree), and the binding
// touching the grandchild is swept too. ONE call. Shapes are PUT descendants-
// first (loadModel's bulk-load pattern: fall to root, then a reparent pass
// fixes placement), so listShapes() — node-creation order — yields the
// grandchild before its ancestors and a single in-order pass over it cannot
// reach the grandchild: only a true fixpoint sweeps binding:g4.
const doc4 = LoroCanvasDoc.create({ peerId: 4n })
doc4.putPage({ id: 'page:p', name: 'P' })
doc4.putShape({ id: 'shape:ar4', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any)
doc4.putShape({ id: 'shape:grandchild4', kind: 'note', parentId: 'shape:child4', props: {}, ...base() } as any)
doc4.putShape({ id: 'shape:child4', kind: 'note', parentId: 'shape:bad4', props: {}, ...base() } as any)
doc4.putShape({ id: 'shape:bad4', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
doc4.reparent('shape:child4', 'shape:bad4')
doc4.reparent('shape:grandchild4', 'shape:child4')
doc4.putBinding({ id: 'binding:g4', fromId: 'shape:ar4', toId: 'shape:grandchild4', props: {}, meta: {} })
doc4.commit()
{
  const order = dumpModel(doc4).shapes.map((s) => s.id)
  assert.ok(
    order.indexOf('shape:grandchild4') < order.indexOf('shape:child4'),
    `precondition: dump lists the grandchild before its parent (fixpoint required); got ${order.join(', ')}`,
  )
}

const applied4 = doc4.repair()
doc4.commit()
assert.deepEqual(applied4, [{ op: 'dropShape', id: 'shape:bad4' }], 'plan names only the invalid root — descendants cascade')
assert.deepEqual(doc4.listShapes().map((s) => s.id), ['shape:ar4'], 'bad4, child4 AND grandchild4 all gone')
assert.deepEqual(doc4.listBindings(), [], 'binding touching the cascaded grandchild swept in the same pass')
assert.deepEqual(checkInvariants(dumpModel(doc4)), [], 'invariant-clean after ONE repair()')

console.log('ok: repair (doc)')
