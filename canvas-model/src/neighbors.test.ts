// Run: bun src/neighbors.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { neighbors } from './neighbors.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number, parentId = 'page:p') =>
  ({ id, kind: 'note', parentId, index: 'a1', x, y, props: { color: 'yellow' }, ...base() }) as any
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [note('shape:a', 0, 0), note('shape:b', 50, 0), note('shape:c', 500, 0)],
  bindings: [],
})

// Within radius 100 of a's centroid, b is a neighbor but c is not.
const near = neighbors(doc, 'shape:a', 100)
assert.deepEqual(near.map((n) => n.id), ['shape:b'])

// Page-scoped: identical coordinates on a different page never match.
const paged = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }, { id: 'page:q', name: 'Q' }],
  shapes: [note('shape:a', 0, 0), note('shape:other', 0, 0, 'page:q')],
  bindings: [],
})
assert.deepEqual(neighbors(paged, 'shape:a', 100), [])

// Equidistant shapes tie-break by id; radius boundary is inclusive (<=).
const ties = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [note('shape:a', 0, 0), note('shape:t2', 60, 0), note('shape:t1', -60, 0), note('shape:edge', 0, 120)],
  bindings: [],
})
const t = neighbors(ties, 'shape:a', 120)
assert.deepEqual(t.map((n) => n.id), ['shape:t1', 'shape:t2', 'shape:edge'])
assert.equal(t[2]!.distance, 120) // exactly on the radius → included

// Missing target id → empty result.
assert.deepEqual(neighbors(doc, 'shape:missing', 100), [])

console.log('ok: neighbors')
