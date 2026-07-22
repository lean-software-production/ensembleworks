// Run: bun src/shape.test.ts
import assert from 'node:assert/strict'
import { SHAPE_KINDS, TEXT_CAPABLE_KINDS, isTextCapableKind, shapeSchema, validateShape, plainText } from './shape.js'

// Every kind the room can contain is enumerated (9 tldraw incl. group + image + 6 custom).
assert.deepEqual(
  [...SHAPE_KINDS].sort(),
  ['arrow','draw','file-viewer','frame','geo','group','highlight','iframe','image','line','neko','note','roadmap','screenshare','terminal','text'].sort(),
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
// isTextCapableKind: exactly note/text/geo -- not frame, not any embed kind,
// not any structural kind.
assert.deepEqual([...TEXT_CAPABLE_KINDS].sort(), ['geo', 'note', 'text'])
for (const k of TEXT_CAPABLE_KINDS) assert.equal(isTextCapableKind(k), true, `${k} is text-capable`)
for (const k of SHAPE_KINDS) {
  if ((TEXT_CAPABLE_KINDS as readonly string[]).includes(k)) continue
  assert.equal(isTextCapableKind(k), false, `${k} is NOT text-capable`)
}
console.log('ok: shape schema')

// Task M1 — `color` tightens from `z.string()` to a tldraw-parity enum.
function noteWith(props: Record<string, unknown>) {
  return { ...note, props: { ...note.props, ...props } }
}

// a real palette color validates on a note
assert.ok(validateShape(noteWith({ color: 'blue' })).ok, 'a real tldraw color validates')
// a junk color is now REJECTED (this is the behavior change M1 introduces)
assert.ok(!validateShape(noteWith({ color: 'chartreuse' })).ok, 'a non-tldraw color is rejected')
// unknown NON-style keys still pass through (looseObject preserved)
assert.ok(validateShape(noteWith({ color: 'blue', wobble: 7 })).ok, 'unknown passthrough keys still pass')
// every tldraw color name validates (GUARD, not the killing RED -- z.string()
// would also pass this before M1; kept to catch a missing-value mutant)
for (const c of [
  'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
  'orange', 'green', 'light-green', 'light-red', 'red', 'white',
]) {
  assert.ok(validateShape(noteWith({ color: c })).ok, `tldraw color '${c}' validates`)
}
console.log('ok: color enum (M1)')
