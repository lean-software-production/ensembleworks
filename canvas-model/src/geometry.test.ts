// Run: bun src/geometry.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { pageBounds, centroid, medianSize, pageIdOf } from './geometry.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
// Notes ignore props.w/h (tldraw never stores them): size = 200*scale × (200+growY)*scale.
// scale 0.2 → 40×40, keeping the nested-origin numbers below meaningful.
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 100, y: 100, props: { name: 'F', w: 200, h: 200 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 20, props: { scale: 0.2, growY: 0, color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})

// Child page-space origin = frame origin + child offset.
const b = pageBounds(doc, doc.byId.get('shape:n')!)
assert.deepEqual({ x: b.minX, y: b.minY }, { x: 110, y: 120 })
assert.deepEqual(centroid(b), { x: 130, y: 140 })
assert.equal(medianSize(doc.shapes.filter((s) => s.kind === 'note')), 40)

// pageIdOf walks the parent chain to the containing page.
assert.equal(pageIdOf(doc, doc.byId.get('shape:n')!), 'page:p')
assert.equal(pageIdOf(doc, doc.byId.get('shape:f')!), 'page:p')

// Note sizing: w = 200*scale, h = (200+growY)*scale — growY 100, scale 2 → 400×600.
const grown = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:g', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { growY: 100, scale: 2, color: 'yellow' }, ...base() } as any],
  bindings: [],
})
const gb = pageBounds(grown, grown.byId.get('shape:g')!)
assert.deepEqual({ w: gb.maxX - gb.minX, h: gb.maxY - gb.minY }, { w: 400, h: 600 })
assert.equal(medianSize(grown.shapes), 600) // max(w,h) feeds the median

// Geo sizing: props.w/h are ALREADY scaled (tldraw GeoShapeUtil divides by scale
// to recover the unscaled size) and rendered height adds growY — no scale multiply.
const geoScaled = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:gs', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { w: 100, h: 50, growY: 30, scale: 2 }, ...base() } as any],
  bindings: [],
})
const gsb = pageBounds(geoScaled, geoScaled.byId.get('shape:gs')!)
assert.deepEqual({ w: gsb.maxX - gsb.minX, h: gsb.maxY - gsb.minY }, { w: 100, h: 80 })

// Negative sizes clamp to 0: bounds never invert.
const neg = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:neg', kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { w: -50, h: 10 }, ...base() } as any],
  bindings: [],
})
const nb = pageBounds(neg, neg.byId.get('shape:neg')!)
assert.ok(nb.maxX >= nb.minX)
assert.ok(nb.maxY >= nb.minY)

// medianSize edges: empty → 100; even count → average of middle two; odd → middle.
const geo = (id: string, w: number) =>
  ({ id, kind: 'geo', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { w, h: 1 }, ...base() }) as any
assert.equal(medianSize([]), 100)
assert.equal(medianSize([geo('shape:1', 10), geo('shape:2', 30)]), 20)
assert.equal(medianSize([geo('shape:1', 10), geo('shape:2', 30), geo('shape:3', 90)]), 30)

console.log('ok: geometry')
