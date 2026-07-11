// Run: bun src/cluster.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { clusterShapes } from './cluster.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number, color = 'yellow') =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 100, h: 100, color }, ...base() }) as any

// Two tight vertical columns far apart, plus one lone outlier.
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:a1', 0, 0), note('shape:a2', 0, 120), note('shape:a3', 0, 240),   // column A
    note('shape:b1', 800, 0), note('shape:b2', 800, 120),                          // column B
    note('shape:z', 2000, 2000),                                                   // outlier
  ],
  bindings: [],
})

const { clusters, outliers } = clusterShapes(doc, doc.shapes)
assert.equal(clusters.length, 2)
assert.deepEqual(outliers.sort(), ['shape:z'])
// The 3-member column is classified 'column'.
const colA = clusters.find((c) => c.members.includes('shape:a1'))!
assert.equal(colA.arrangement, 'column')
assert.ok(colA.confidence > 0.5) // aligned + uniform colour
console.log('ok: cluster')
