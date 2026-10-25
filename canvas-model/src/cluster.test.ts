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

// --- 2×2 grid → 'grid'. Notes render 200×200; 300px pitch → 100px gaps, all
// within threshold (180), so one cluster with 2 distinct rows and columns.
const gridDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:g1', 0, 0), note('shape:g2', 300, 0),
    note('shape:g3', 0, 300), note('shape:g4', 300, 300),
  ],
  bindings: [],
})
const gridRes = clusterShapes(gridDoc, gridDoc.shapes)
assert.equal(gridRes.clusters.length, 1)
assert.equal(gridRes.outliers.length, 0)
assert.equal(gridRes.clusters[0]!.arrangement, 'grid')

// --- k override: a tiny threshold splits everything into outliers (the grid's
// 100px gaps exceed 200 * 0.01 = 2).
const tiny = clusterShapes(gridDoc, gridDoc.shapes, 0.01)
assert.equal(tiny.clusters.length, 0)
assert.equal(tiny.outliers.length, 4)

// --- nearestLabel: nearest NON-EMPTY text wins; empty-text shapes are ignored
// even when closer, and farther non-empty text loses to the nearer one.
const rich = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
})
const textShape = (id: string, x: number, y: number, text: string) =>
  ({ id, kind: 'text', parentId: 'page:p', index: 'a1', x, y, props: { richText: rich(text) }, ...base() }) as any
const labelDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:n1', 0, 0), note('shape:n2', 0, 220),          // cluster centroid (100, 210)
    textShape('shape:t-empty', 120, 200, ''),                  // closest but empty → ignored
    textShape('shape:t-near', 250, 190, 'Ideas'),              // nearest non-empty
    textShape('shape:t-far', 1500, 210, 'Far'),                // farther non-empty
  ],
  bindings: [],
})
const labelRes = clusterShapes(labelDoc, labelDoc.shapes)
assert.equal(labelRes.clusters.length, 1)
assert.equal(labelRes.clusters[0]!.label, 'Ideas')

console.log('ok: cluster')
