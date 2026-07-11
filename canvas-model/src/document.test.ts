// Run: bun src/document.test.ts
import assert from 'node:assert/strict'
import { makeDocument, childrenOf, rootShapes, shapeById } from './document.js'

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'Page' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { name: 'Planning', w: 400, h: 300 } },
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'yellow' } },
  ],
  bindings: [],
} as any)

assert.equal(shapeById(doc, 'shape:n')!.kind, 'note')
assert.deepEqual(childrenOf(doc, 'shape:f').map((s) => s.id), ['shape:n'])
assert.deepEqual(rootShapes(doc).map((s) => s.id), ['shape:f'])
console.log('ok: document')
