// Run: bun src/neighbors.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { neighbors } from './neighbors.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number) =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 40, h: 40, color: 'yellow' }, ...base() }) as any
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [note('shape:a', 0, 0), note('shape:b', 50, 0), note('shape:c', 500, 0)],
  bindings: [],
})

// Within radius 100 of a's centroid, b is a neighbor but c is not.
const near = neighbors(doc, 'shape:a', 100)
assert.deepEqual(near.map((n) => n.id), ['shape:b'])
console.log('ok: neighbors')
