// Run: bun src/clipboard.test.ts
import assert from 'node:assert/strict'
import { serializeSelection } from './clipboard.js'
import type { Shape } from './shape.js'
import type { Binding } from './document.js'

// Scene: a frame with two children (childA a note, childB a note). One of
// the children (childA) doubles as the "arrow" endpoint for test purposes —
// the pure model layer only cares that a Binding's fromId/toId are shape
// ids, not that the fromId shape is literally kind:'arrow' — so an internal
// binding between the two children needs no third arrow shape to exist.
// An unrelated outside note also has a binding to a collected child
// (dangling-out): one endpoint inside the selection, one outside.
const frame: Shape = {
  id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { name: 'Frame', w: 400, h: 300 },
}
const childA: Shape = {
  id: 'shape:a', kind: 'note', parentId: 'shape:f', index: 'a1',
  x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow' },
}
const childB: Shape = {
  id: 'shape:b', kind: 'note', parentId: 'shape:f', index: 'a2',
  x: 20, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'blue' },
}
const outside: Shape = {
  id: 'shape:out', kind: 'note', parentId: 'page:p', index: 'a1',
  x: 500, y: 500, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'red' },
}

const internalBinding: Binding = {
  id: 'binding:internal', fromId: 'shape:a', toId: 'shape:b', props: {}, meta: {},
}
const danglingOutBinding: Binding = {
  id: 'binding:dangling', fromId: 'shape:out', toId: 'shape:a', props: {}, meta: {},
}

const shapes = [frame, childA, childB, outside]
const bindings = [internalBinding, danglingOutBinding]

// --- Step 1 RED scenario: select just the frame ---
const payload = serializeSelection(shapes, bindings, ['shape:f'])

assert.equal(payload['ensembleworks/clipboard'], 1, 'marker/version must be present')

assert.deepEqual(
  payload.shapes.map((s) => s.id).sort(),
  ['shape:a', 'shape:b', 'shape:f'],
  'frame selection must include the frame and both its subtree children, and nothing outside',
)

assert.deepEqual(
  payload.bindings.map((b) => b.id),
  ['binding:internal'],
  'only the binding whose BOTH endpoints are in the collected set survives',
)

// --- De-dupe: selecting both the frame AND a child must not duplicate the child ---
const overlapPayload = serializeSelection(shapes, bindings, ['shape:f', 'shape:a'])
assert.deepEqual(
  overlapPayload.shapes.map((s) => s.id).sort(),
  ['shape:a', 'shape:b', 'shape:f'],
  'overlapping parent+child selection must not duplicate the child shape',
)

// --- A single selected leaf shape (no descendants) ---
const leafPayload = serializeSelection(shapes, bindings, ['shape:b'])
assert.deepEqual(leafPayload.shapes.map((s) => s.id), ['shape:b'])
assert.deepEqual(leafPayload.bindings, [], 'no binding has both endpoints in a lone-leaf selection')

// --- Determinism: same input, same output, across repeated calls ---
const first = serializeSelection(shapes, bindings, ['shape:f'])
const second = serializeSelection(shapes, bindings, ['shape:f'])
assert.deepEqual(first, second, 'serializeSelection must be a pure, deterministic function of its input')

console.log('ok: clipboard (serializeSelection)')
