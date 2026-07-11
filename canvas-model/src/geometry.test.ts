// Run: bun src/geometry.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { pageBounds, centroid, medianSize } from './geometry.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 100, y: 100, props: { name: 'F', w: 200, h: 200 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 20, props: { w: 40, h: 40, color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})

// Child page-space origin = frame origin + child offset.
const b = pageBounds(doc, doc.byId.get('shape:n')!)
assert.deepEqual({ x: b.minX, y: b.minY }, { x: 110, y: 120 })
assert.deepEqual(centroid(b), { x: 130, y: 140 })
assert.equal(medianSize(doc.shapes.filter((s) => s.kind === 'note')), 40)
console.log('ok: geometry')
