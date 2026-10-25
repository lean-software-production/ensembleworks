// Run: bun src/tree-ops.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const s = (id: string, parentId = 'page:p') => ({
  id, kind: 'frame', parentId, index: 'a1', x: 0, y: 0, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
})
const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape(s('shape:f') as any)
doc.putShape(s('shape:g') as any)
doc.putShape(s('shape:c', 'shape:f') as any) // c under f
doc.commit()

// Reparent c under g; its model parentId reflects the move.
doc.reparent('shape:c', 'shape:g')
assert.equal(doc.getShape('shape:c')!.parentId, 'shape:g')

// Reparenting into own descendant is rejected by Loro's native cycle guard.
assert.throws(() => doc.reparent('shape:g', 'shape:c'))
// The rejected cycle must not have mutated data.parentId (tree.move throws first).
assert.equal(doc.getShape('shape:g')!.parentId, 'page:p')

// Missing id is a silent no-op (interface contract).
assert.doesNotThrow(() => doc.reparent('shape:missing', 'shape:f'))

// Unknown parent shape id throws.
assert.throws(() => doc.reparent('shape:c', 'shape:nope'))

console.log('ok: tree ops')
