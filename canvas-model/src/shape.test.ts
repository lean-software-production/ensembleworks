// Run: bun src/shape.test.ts
import assert from 'node:assert/strict'
import { SHAPE_KINDS, shapeSchema, validateShape, plainText } from './shape.js'

// Every kind the room can contain is enumerated (8 tldraw + image + 6 custom).
assert.deepEqual(
  [...SHAPE_KINDS].sort(),
  ['arrow','draw','file-viewer','frame','geo','highlight','iframe','image','line','neko','note','roadmap','screenshare','terminal','text'].sort(),
)

const note = {
  id: 'shape:n1', kind: 'note', parentId: 'page:p', index: 'a1',
  x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } },
}
const r = validateShape(note)
assert.equal(r.ok, true)
assert.equal(plainText(note as any), 'hi')

// Unknown props survive (lossless passthrough).
const kept = shapeSchema.parse({ ...note, props: { ...note.props, growY: 7, mystery: 'x' } })
assert.equal((kept.props as any).growY, 7)
assert.equal((kept.props as any).mystery, 'x')

// Bad envelope is rejected with a typed error, never thrown past validateShape.
const bad = validateShape({ ...note, id: 'nope', kind: 'note' })
assert.equal(bad.ok, false)

// Bad per-kind props are rejected too (the superRefine branch): a typed field
// with the wrong type fails validation even though the envelope is fine.
const badProps = validateShape({ ...note, props: { color: 123 } })
assert.equal(badProps.ok, false)
console.log('ok: shape schema')
