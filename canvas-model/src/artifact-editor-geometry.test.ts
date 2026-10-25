import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { DEFAULT_SIZE, localBounds, opensBodyEdit, toWorldPoint } from './geometry.js'
import type { Shape } from './shape.js'

const shape = (id: Shape['id'], kind: Shape['kind'], props: Shape['props'], over: Partial<Shape> = {}): Shape => ({
  id, kind, props, parentId: 'page:p', index: 'a1', x: 100, y: 100,
  rotation: 0, isLocked: false, opacity: 1, meta: {}, ...over,
})
const props = { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture', path: 'reports/fixture.html', title: '', w: 720, h: 540 }
assert.deepEqual(DEFAULT_SIZE.artifact, { w: 720, h: 540 })
// Geometry's tolerant fallback is not a schema permission to omit dimensions.
assert.deepEqual(localBounds(shape('shape:default', 'artifact', {})), { minX: 0, minY: 0, maxX: 720, maxY: 540 })
assert.deepEqual(localBounds(shape('shape:explicit', 'artifact', { ...props, w: 350, h: 240 })), { minX: 0, minY: 0, maxX: 350, maxY: 240 })

const parent = shape('shape:parent', 'frame', { w: 1200, h: 900 }, { rotation: Math.PI / 3 })
const artifact = shape('shape:artifact', 'artifact', props, { parentId: parent.id, rotation: Math.PI / 7 })
const thread = shape('shape:thread', 'bbthread', { w: 900, h: 600, paneFraction: 0.4 }, { parentId: parent.id, rotation: Math.PI / 4 })
const geo = shape('shape:geo', 'geo', { w: 200, h: 100 })
const doc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [parent, artifact, thread, geo], bindings: [] })
for (const p of [{ x: 360, y: 270 }, { x: 1, y: 1 }, { x: 719, y: 539 }]) {
  assert.equal(opensBodyEdit(doc, artifact, toWorldPoint(doc, artifact, p)), true, 'artifact body in rotated parent opens local focus')
}
for (const p of [{ x: -1, y: 100 }, { x: 721, y: 100 }, { x: 300, y: -1 }, { x: 300, y: 541 }]) {
  assert.equal(opensBodyEdit(doc, artifact, toWorldPoint(doc, artifact, p)), false, 'outside artifact does not open body')
}
assert.equal(opensBodyEdit(doc, thread, toWorldPoint(doc, thread, { x: 800, y: 300 })), true, 'thread pane stays editable')
for (const p of [{ x: 300, y: 300 }, { x: 800, y: -20 }, { x: -1, y: 300 }]) {
  assert.equal(opensBodyEdit(doc, thread, toWorldPoint(doc, thread, p)), false, 'thread workspace/header/outside does not open body')
}
assert.equal(opensBodyEdit(doc, parent, toWorldPoint(doc, parent, { x: 500, y: 300 })), false)
assert.equal(opensBodyEdit(doc, geo, { x: 200, y: 150 }), false, 'text entry gate remains separate')
console.log('ok: artifact 720x540 defaults and transformed body-entry policy; thread regions unchanged')
