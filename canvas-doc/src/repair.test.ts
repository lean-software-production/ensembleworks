// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { checkInvariants } from '@ensembleworks/canvas-model'
import { dumpModel } from './bridge.js'

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

console.log('ok: repair (doc)')
