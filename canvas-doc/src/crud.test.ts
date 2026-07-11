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
console.log('ok: crud')
