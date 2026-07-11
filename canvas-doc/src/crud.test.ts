// Run: bun src/crud.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 1, y: 2, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow' }, ...over,
})

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape(shape('shape:a') as any)
doc.putShape(shape('shape:b', { x: 9 }) as any)
doc.commit()

assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:a', 'shape:b'])
assert.equal(doc.getShape('shape:a')!.x, 1)

doc.updateProps('shape:a', { color: 'blue' })
assert.equal((doc.getShape('shape:a')!.props as any).color, 'blue')

doc.deleteShape('shape:b')
assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:a'])

// --- mutators on a missing id are silent no-ops (interface contract) ---
const before = doc.listShapes()
assert.doesNotThrow(() => doc.updateProps('shape:missing', { color: 'red' }))
assert.doesNotThrow(() => doc.deleteShape('shape:missing'))
doc.commit()
assert.deepEqual(doc.listShapes(), before, 'doc unchanged after no-op mutations')

// --- subscribe fires on commit; unsubscribe stops delivery ---
const subDoc = LoroCanvasDoc.create({ peerId: 3n })
let fires = 0
const unsub = subDoc.subscribe(() => { fires++ })
subDoc.putShape(shape('shape:s1') as any)
subDoc.commit()
assert.equal(fires, 1, 'listener fired once on commit')
unsub()
subDoc.putShape(shape('shape:s2') as any)
subDoc.commit()
assert.equal(fires, 1, 'listener not fired after unsubscribe')

// --- nested objects (meta/props) survive a snapshot round-trip deeply ---
const deep = shape('shape:deep', {
  meta: { a: { b: [1, 2, { c: 3 }] } },
  props: { color: 'green', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } },
})
const src = LoroCanvasDoc.create({ peerId: 4n })
src.putShape(deep as any)
src.commit()
const dst = LoroCanvasDoc.fromSnapshot(src.exportSnapshot(), { peerId: 5n })
assert.deepEqual(dst.getShape('shape:deep'), deep, 'deep meta/props equal after snapshot round-trip')

// --- putShape places the node in the REAL tree (single source of truth) ---
const treeDoc = LoroCanvasDoc.create({ peerId: 6n })
treeDoc.putShape(shape('shape:f', { kind: 'frame', parentId: 'page:p', props: { w: 10, h: 10 } }) as any)
treeDoc.putShape(shape('shape:c', { parentId: 'shape:f' }) as any)
treeDoc.commit()
assert.deepEqual(treeDoc.listShapes().map((s) => s.id).sort(), ['shape:c', 'shape:f'])
// deleteShape cascades the real subtree: deleting the frame removes its child too.
treeDoc.deleteShape('shape:f')
assert.deepEqual(treeDoc.listShapes(), [], 'cascade delete removed the child along with the parent')

// --- bulk-load order resilience: child put before its parent exists ---
const bulkDoc = LoroCanvasDoc.create({ peerId: 7n })
assert.doesNotThrow(() => bulkDoc.putShape(shape('shape:child', { parentId: 'shape:notyet' }) as any))
bulkDoc.commit()
assert.equal(bulkDoc.getShape('shape:child')!.parentId, 'shape:notyet', 'data.parentId retained even though the tree node stayed a root')

// --- upsert to a not-yet-loaded parent DETACHES from the old real parent ---
// (regression: leaving the node under its stale parent would let deleteShape
// of the old parent cascade-delete a shape that logically moved away)
const detachDoc = LoroCanvasDoc.create({ peerId: 8n })
detachDoc.putShape(shape('shape:A', { kind: 'frame', props: { w: 10, h: 10 } }) as any)
detachDoc.putShape(shape('shape:childA', { parentId: 'shape:A' }) as any)
detachDoc.commit()
// Upsert the child to point at a parent whose node isn't loaded yet.
detachDoc.putShape(shape('shape:childA', { parentId: 'shape:notloaded' }) as any)
detachDoc.deleteShape('shape:A')
detachDoc.commit()
const survivor = detachDoc.getShape('shape:childA')
assert.ok(survivor, 'child survives deletion of its former real parent (now a root)')
assert.equal(survivor!.parentId, 'shape:notloaded', 'data.parentId retained for the later reparent pass')

console.log('ok: crud')
