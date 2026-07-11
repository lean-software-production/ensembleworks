// Run: bun src/semantic.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { semanticView } from './semantic.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number) =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 100, h: 100, color: 'yellow' }, ...base() }) as any

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:a1', 0, 0), note('shape:a2', 0, 120),        // cluster A
    note('shape:b1', 900, 0), note('shape:b2', 900, 120),    // cluster B
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
  ],
  bindings: [
    { id: 'binding:1', fromId: 'shape:ar', toId: 'shape:a1', props: {} },
    { id: 'binding:2', fromId: 'shape:ar', toId: 'shape:b1', props: {} },
  ],
})

const view = semanticView(doc, doc.shapes)
assert.equal(view.clusters.length, 2)
// The arrow bridges the two clusters → one relation between distinct clusters.
assert.equal(view.relations.length, 1)
assert.notEqual(view.relations[0]!.fromCluster, view.relations[0]!.toCluster)
console.log('ok: semantic')
