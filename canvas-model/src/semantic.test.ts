// Run: bun src/semantic.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { semanticView } from './semantic.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number) =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 100, h: 100, color: 'yellow' }, ...base() }) as any
const arrow = (id: string) =>
  ({ id, kind: 'arrow', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: {}, ...base() }) as any

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:a1', 0, 0), note('shape:a2', 0, 120),        // cluster A (index 0)
    note('shape:b1', 900, 0), note('shape:b2', 900, 120),    // cluster B (index 1)
    note('shape:z', 3000, 3000),                             // outlier
    arrow('shape:ar'),   // B → A by terminals (REVERSED from binding array order)
    arrow('shape:ar2'),  // A → outlier: must yield no relation
    arrow('shape:ar3'),  // no terminals: falls back to binding array order (A → B)
  ],
  bindings: [
    // Array order lists the A-side target first, but the terminals say the
    // arrow points B → A. Terminal must win over order.
    { id: 'binding:1', fromId: 'shape:ar', toId: 'shape:a1', props: { terminal: 'end' } },
    { id: 'binding:2', fromId: 'shape:ar', toId: 'shape:b1', props: { terminal: 'start' } },
    { id: 'binding:3', fromId: 'shape:ar2', toId: 'shape:a1', props: { terminal: 'start' } },
    { id: 'binding:4', fromId: 'shape:ar2', toId: 'shape:z', props: { terminal: 'end' } },
    { id: 'binding:5', fromId: 'shape:ar3', toId: 'shape:a2', props: {} },
    { id: 'binding:6', fromId: 'shape:ar3', toId: 'shape:b2', props: {} },
  ],
})

const view = semanticView(doc, doc.shapes)
assert.equal(view.clusters.length, 2)
assert.deepEqual(view.outliers, ['shape:z'])

// ar bridges the clusters, oriented by terminals: fromCluster = B (1), toCluster = A (0).
const rel = view.relations.find((r) => r.arrowId === 'shape:ar')!
assert.equal(rel.fromCluster, 1)
assert.equal(rel.toCluster, 0)
assert.notEqual(rel.fromCluster, rel.toCluster)

// ar2 points at an outlier → no relation (cluster↔cluster only).
assert.equal(view.relations.some((r) => r.arrowId === 'shape:ar2'), false)

// ar3 has no terminals → deterministic binding-array-order fallback: A → B.
const rel3 = view.relations.find((r) => r.arrowId === 'shape:ar3')!
assert.equal(rel3.fromCluster, 0)
assert.equal(rel3.toCluster, 1)

assert.equal(view.relations.length, 2)
console.log('ok: semantic')
