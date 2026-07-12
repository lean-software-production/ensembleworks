// Run: bun src/bindings-pages.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { loadModel, dumpModel } from './bridge.js'
import { makeDocument } from '@ensembleworks/canvas-model'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const model = makeDocument({
  pages: [{ id: 'page:p', name: 'Page', index: 'a0' }],
  shapes: [
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:t', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [{ id: 'binding:1', fromId: 'shape:ar', toId: 'shape:t', props: { terminal: 'end' }, meta: {} }],
})

// --- loadModel round-trips pages + bindings, not just shapes ---
const doc = LoroCanvasDoc.create({ peerId: 1n })
loadModel(doc, model)
doc.commit()
const out = dumpModel(doc)
assert.deepEqual(out.pages.map((p) => p.id), ['page:p'])
assert.deepEqual(out.bindings.map((b) => b.id), ['binding:1'])
assert.equal(out.bindings[0]!.toId, 'shape:t')

// --- direct binding CRUD ---
doc.putBinding({ id: 'binding:2', fromId: 'shape:ar', toId: 'shape:t', props: {}, meta: {} })
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id).sort(), ['binding:1', 'binding:2'])
doc.deleteBinding('binding:1')
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id), ['binding:2'])

// --- pages + bindings survive a snapshot round-trip ---
const dst = LoroCanvasDoc.fromSnapshot(doc.exportSnapshot(), { peerId: 2n })
assert.deepEqual(dst.listPages().map((p) => p.id), ['page:p'])
assert.deepEqual(dst.listBindings().map((b) => b.id), ['binding:2'])

console.log('ok: bindings-pages')
