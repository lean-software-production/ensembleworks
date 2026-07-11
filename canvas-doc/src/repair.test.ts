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

console.log('ok: repair (doc)')
