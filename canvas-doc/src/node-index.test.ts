// Run: bun src/node-index.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
})

// --- correctness parity: index resolves the same node the scan would ---
const a = LoroCanvasDoc.create({ peerId: 1n })
for (let i = 0; i < 200; i++) { a.putShape(shape(`shape:s${i}`) as any) }
a.commit()
assert.equal(a.getShape('shape:s0')!.id, 'shape:s0')
assert.equal(a.getShape('shape:s199')!.id, 'shape:s199')
assert.equal(a.getShape('shape:missing'), undefined)

// --- mutators keep the index coherent ---
a.reparent('shape:s5', 'shape:s0'); a.commit()
assert.equal(a.getShape('shape:s5')!.parentId, 'shape:s0')
a.deleteShape('shape:s0'); a.commit()             // cascades s5
assert.equal(a.getShape('shape:s0'), undefined)
assert.equal(a.getShape('shape:s5'), undefined)

// --- index survives an import (rebuild on merge) ---
const b = LoroCanvasDoc.create({ peerId: 2n })
b.import(a.exportUpdate()); b.commit()
assert.equal(b.listShapes().length, a.listShapes().length)
assert.equal(b.getShape('shape:s1')!.id, 'shape:s1')

// --- duplicate-id contract preserved: repair still reconciles EVERY copy ---
const c = LoroCanvasDoc.create({ peerId: 3n })
c.putShape(shape('shape:dup') as any); c.commit()
c.repair(); c.commit()
assert.equal(c.getShape('shape:dup')!.id, 'shape:dup')

// --- index survives fromSnapshot (rebuild path) ---
const snap = LoroCanvasDoc.fromSnapshot(a.exportSnapshot(), { peerId: 4n })
assert.equal(snap.getShape('shape:s1')!.id, 'shape:s1')
assert.equal(snap.getShape('shape:s0'), undefined) // was deleted before snapshot

// --- perf gate: getShape must NOT scan the whole tree per lookup ---
// Spy on the private `tree` field's `nodes()` method (the O(n) WASM marshal
// nodeByShapeId used to call on every single lookup) and assert getShape
// does not invoke it at all once the doc is built and indexed.
const d = LoroCanvasDoc.create({ peerId: 5n })
for (let i = 0; i < 1000; i++) { d.putShape(shape(`shape:p${i}`) as any) }
d.commit()

const tree = (d as any).tree
const originalNodes = tree.nodes.bind(tree)
let nodesCallCount = 0
tree.nodes = (...args: unknown[]) => { nodesCallCount++; return originalNodes(...args) }

for (let i = 0; i < 1000; i++) { d.getShape(`shape:p${i % 1000}`) }
assert.equal(nodesCallCount, 0, 'getShape must resolve via the id→node index, not a tree.nodes() scan')

tree.nodes = originalNodes

console.log('ok: node-index')
