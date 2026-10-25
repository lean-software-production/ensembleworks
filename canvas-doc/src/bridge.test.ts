// Run: bun src/bridge.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from '@ensembleworks/canvas-model'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { loadModel, dumpModel } from './bridge.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const model = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { name: 'F', w: 100, h: 100 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 5, y: 5, props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})

const doc = LoroCanvasDoc.create({ peerId: 1n })
loadModel(doc, model)
doc.commit()

// Subscription fires on a mutation.
let fired = 0
const unsub = doc.subscribe(() => { fired++ })
doc.updateProps('shape:n', { color: 'blue' })
doc.commit()
unsub()
assert.ok(fired >= 1)

// Model round-trips (order-insensitive) through Loro.
const back = dumpModel(doc)
assert.deepEqual(back.shapes.map((s) => s.id).sort(), ['shape:f', 'shape:n'])
assert.equal(back.byId.get('shape:n')!.parentId, 'shape:f')
console.log('ok: bridge')
