// Run: bun src/clipboard.test.ts
import assert from 'node:assert/strict'
import { serializeSelection, encodeClipboard, decodeClipboard, cloneWithNewIds } from './clipboard.js'
import type { Shape } from './shape.js'
import { bindingSchema, type Binding } from './document.js'

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

// ============================================================================
// Task C2 — decodeClipboard / encodeClipboard (the SECURITY gate)
// ============================================================================
// The clipboard is UNTRUSTED input: arbitrary text from any app on the
// system clipboard. decodeClipboard must be a TOTAL function — every input
// returns a value, never throws — and must never let an invalid shape or a
// dangling binding leave the function. Each case below is its own named
// test (not one giant assert chain) so a mutant that removes exactly one
// gate fails exactly one named case, and so a broken run reports every
// failure instead of stopping at the first.
let failures = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL - ${name}`)
    console.error(err instanceof Error ? err.stack ?? err.message : err)
  }
}

const validNote: Shape = {
  id: 'shape:v1', kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow' },
}
const validNote2: Shape = {
  id: 'shape:v2', kind: 'note', parentId: 'page:p', index: 'a2',
  x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'blue' },
}
// Invalid: 'not-a-color' is not a member of the closed COLOR enum, so
// validateShape must reject this via the per-kind props refinement.
const junkPropsShape = {
  id: 'shape:junk', kind: 'note', parentId: 'page:p', index: 'a3',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'not-a-color' },
}
const validBinding: Binding = {
  id: 'binding:v1', fromId: 'shape:v1', toId: 'shape:v2', props: {}, meta: {},
}

// --- 1. Malformed JSON must not throw ---
test('malformed JSON returns empty, does not throw', () => {
  const result = decodeClipboard('{ not json')
  assert.deepEqual(result, { shapes: [], bindings: [] })
})

// --- 2. Valid JSON, but not a plain object (null / array) ---
test('JSON literal null returns empty', () => {
  assert.deepEqual(decodeClipboard('null'), { shapes: [], bindings: [] })
})
test('JSON array returns empty (not a plain object)', () => {
  assert.deepEqual(decodeClipboard('[]'), { shapes: [], bindings: [] })
})

// --- 3. Valid object, but missing/wrong marker ---
test('empty object (no marker key) returns empty', () => {
  assert.deepEqual(decodeClipboard('{}'), { shapes: [], bindings: [] })
})
test('wrong marker version returns empty (foreign/future format)', () => {
  const foreign = JSON.stringify({ 'ensembleworks/clipboard': 2, shapes: [validNote], bindings: [] })
  assert.deepEqual(decodeClipboard(foreign), { shapes: [], bindings: [] })
})
test('marker key absent but object otherwise shape-shaped returns empty', () => {
  const foreign = JSON.stringify({ shapes: [validNote], bindings: [] })
  assert.deepEqual(decodeClipboard(foreign), { shapes: [], bindings: [] })
})

// --- 4. Marker present but `shapes` missing / wrong type / null ---
test('marker present, shapes key missing entirely returns empty', () => {
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, bindings: [] })
  assert.deepEqual(decodeClipboard(p), { shapes: [], bindings: [] })
})
test('marker present, shapes is a string (not an array) returns empty, no throw', () => {
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: 'not-an-array', bindings: [] })
  assert.deepEqual(decodeClipboard(p), { shapes: [], bindings: [] })
})
test('marker present, shapes is null returns empty, no throw', () => {
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: null, bindings: [] })
  assert.deepEqual(decodeClipboard(p), { shapes: [], bindings: [] })
})
test('marker present, bindings is not an array returns empty bindings, no throw', () => {
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: [validNote], bindings: 'nope' })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes.map((s) => s.id), ['shape:v1'])
  assert.deepEqual(result.bindings, [])
})

// --- 5. A single invalid shape must not poison the whole paste ---
test('invalid shape (bad props enum) is dropped, valid sibling is kept', () => {
  const p = JSON.stringify({
    'ensembleworks/clipboard': 1,
    shapes: [validNote, junkPropsShape, validNote2],
    bindings: [],
  })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes.map((s) => s.id).sort(), ['shape:v1', 'shape:v2'])
})
test('shape missing required envelope fields (index, etc.) is dropped', () => {
  const missingFields = { id: 'shape:bad', kind: 'note', props: {} } // no parentId/index/x/y/...
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: [validNote, missingFields], bindings: [] })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes.map((s) => s.id), ['shape:v1'])
})

// --- 6. Bindings: dangling endpoint (never in payload at all) is dropped ---
test('binding whose endpoint is outside the payload entirely is dropped', () => {
  const dangling: Binding = { id: 'binding:dangling', fromId: 'shape:v1', toId: 'shape:nowhere', props: {}, meta: {} }
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: [validNote], bindings: [dangling] })
  const result = decodeClipboard(p)
  assert.deepEqual(result.bindings, [])
})

// --- 7. Bindings: endpoint that WAS in the raw payload but got dropped as
// invalid must also cause the binding to be dropped — proves the endpoint
// check runs against the KEPT (post-validateShape) id set, not the raw
// input id set. ---
test('binding pointing at a shape that was itself dropped as invalid is dropped', () => {
  const toDropped: Binding = { id: 'binding:to-dropped', fromId: 'shape:v1', toId: 'shape:junk', props: {}, meta: {} }
  const p = JSON.stringify({
    'ensembleworks/clipboard': 1,
    shapes: [validNote, junkPropsShape],
    bindings: [toDropped],
  })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes.map((s) => s.id), ['shape:v1'])
  assert.deepEqual(result.bindings, [])
})

// --- 8. Bindings: structurally junk fields fail bindingSchema and are dropped ---
test('binding with junk/missing fields fails bindingSchema and is dropped', () => {
  const junkBinding = { id: 'not-a-binding-id', fromId: 'shape:v1', toId: 'shape:v2' } // bad id prefix
  const p = JSON.stringify({
    'ensembleworks/clipboard': 1,
    shapes: [validNote, validNote2],
    bindings: [junkBinding],
  })
  const result = decodeClipboard(p)
  assert.deepEqual(result.bindings, [])
})

// --- 9. A valid binding between two valid, kept shapes survives ---
test('valid binding between two kept shapes is kept', () => {
  const p = JSON.stringify({
    'ensembleworks/clipboard': 1,
    shapes: [validNote, validNote2],
    bindings: [validBinding],
  })
  const result = decodeClipboard(p)
  assert.deepEqual(result.bindings.map((b) => b.id), ['binding:v1'])
})

// --- 10. Round-trip: a valid payload survives encode -> decode unchanged ---
test('valid payload round-trips through encodeClipboard -> decodeClipboard', () => {
  const payload = serializeSelection([validNote, validNote2], [validBinding], ['shape:v1', 'shape:v2'])
  const result = decodeClipboard(encodeClipboard(payload))
  assert.deepEqual(result.shapes.map((s) => s.id).sort(), ['shape:v1', 'shape:v2'])
  assert.deepEqual(result.bindings.map((b) => b.id), ['binding:v1'])
})

// --- 11. Total-function / hostile-input hardening beyond the plan's list ---
test('a huge junk shapes array does not throw or hang', () => {
  const junkArray = Array.from({ length: 5000 }, (_, i) => ({ garbage: i, __proto__: { polluted: true } }))
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: junkArray, bindings: [] })
  const result = decodeClipboard(p)
  assert.deepEqual(result, { shapes: [], bindings: [] })
})
test('a __proto__-keyed shape entry does not pollute Object.prototype and is dropped', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"id":"shape:v1","kind":"note"}')
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: [hostile], bindings: [] })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes, [])
  assert.equal(({} as any).polluted, undefined, 'Object.prototype must not be polluted')
})
test('deeply nested junk props on an otherwise-invalid shape does not throw', () => {
  let nested: unknown = 'leaf'
  for (let i = 0; i < 500; i++) nested = { child: nested }
  const p = JSON.stringify({ 'ensembleworks/clipboard': 1, shapes: [{ id: 'shape:deep', kind: 'note', props: { nested } }], bindings: [] })
  const result = decodeClipboard(p)
  assert.deepEqual(result.shapes, [])
})

console.log('ok: clipboard (decodeClipboard / encodeClipboard security gate)')

// ============================================================================
// Task C3 — cloneWithNewIds (pure id/parent/binding remap + offset + cycle-break)
// ============================================================================
// cloneWithNewIds takes VALIDATED shapes+bindings (C2's output — every shape
// already passed validateShape, every binding already resolves both endpoints
// within the set) plus an injected mint(i) and turns them into a brand-new,
// self-consistent set: fresh ids throughout, parentId/binding endpoints
// rewritten through the old->new map, a shape whose parent is outside the set
// (or whose parent chain cycles without ever escaping the set) re-rooted to
// rootParentId, and the position offset applied ONLY to re-rooted (root)
// shapes — a child rides its parent's move via parentId, so offsetting the
// child's own x/y too would double-move it.
const cFrame: Shape = {
  id: 'shape:cf', kind: 'frame', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { name: 'Frame', w: 400, h: 300 },
}
const cChildA: Shape = {
  id: 'shape:ca', kind: 'note', parentId: 'shape:cf', index: 'a1',
  x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow' },
}
const cChildB: Shape = {
  id: 'shape:cb', kind: 'note', parentId: 'shape:cf', index: 'a2',
  x: 20, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'blue' },
}
const cBinding: Binding = {
  id: 'binding:cint', fromId: 'shape:ca', toId: 'shape:cb', props: {}, meta: {},
}
const cShapes = [cFrame, cChildA, cChildB]
const cBindings = [cBinding]
const stableMint = (i: number) => 'new:' + i
const stableMintBinding = (j: number) => 'binding:new' + j

test('new shape ids are mint(i) in stable input order, all unique, none reuse an old id', () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.deepEqual(cloned.shapes.map((s) => s.id), ['new:0', 'new:1', 'new:2'])
  const oldIds = new Set(cShapes.map((s) => s.id))
  for (const s of cloned.shapes) assert.equal(oldIds.has(s.id), false, `${s.id} must not reuse an old id`)
})

test("a child's new parentId points at the parent's NEW id, not the old one", () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  const [newFrame, newChildA, newChildB] = cloned.shapes
  assert.equal(newChildA.parentId, newFrame.id)
  assert.equal(newChildB.parentId, newFrame.id)
})

test('the frame (parent = page, outside the set) is re-rooted to rootParentId', () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.equal(cloned.shapes[0].parentId, 'page:p')
})

test("rootIds contains exactly the frame's new id, nothing else", () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.deepEqual(cloned.rootIds, [cloned.shapes[0].id])
})

test('root shape x/y shifted by the offset', () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.equal(cloned.shapes[0].x, cFrame.x + 20)
  assert.equal(cloned.shapes[0].y, cFrame.y + 20)
})

test('child x/y unchanged — offset applies to roots only, children ride the parent', () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.equal(cloned.shapes[1].x, cChildA.x)
  assert.equal(cloned.shapes[1].y, cChildA.y)
  assert.equal(cloned.shapes[2].x, cChildB.x)
  assert.equal(cloned.shapes[2].y, cChildB.y)
})

test("binding fromId/toId rewritten to the children's NEW ids", () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.equal(cloned.bindings.length, 1)
  assert.equal(cloned.bindings[0].fromId, cloned.shapes[1].id)
  assert.equal(cloned.bindings[0].toId, cloned.shapes[2].id)
})

test('the binding itself gets a fresh minted id, distinct from every shape id', () => {
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.notEqual(cloned.bindings[0].id, cBinding.id)
  const shapeIds = new Set<string>(cloned.shapes.map((s) => s.id))
  assert.equal(shapeIds.has(cloned.bindings[0].id), false)
})

test('same input + same mint stream => identical output (replay-deterministic)', () => {
  const first = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, (i) => 'det:' + i, (j) => 'binding:det' + j, 'page:p', { x: 20, y: 20 })
  const second = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, (i) => 'det:' + i, (j) => 'binding:det' + j, 'page:p', { x: 20, y: 20 })
  assert.deepEqual(first, second)
})

// The E1 mint scheme folds ONE random() draw + a per-node batch index; under a
// CONSTANT random (production tests inject FIXED_RANDOM), only the index
// separates nodes. This proves cloneWithNewIds threads mint's `i` argument
// rather than, say, calling mint() with a fixed index or ignoring it.
test('a mint constant except for the index salt still yields N distinct shape ids', () => {
  const constantSaltedMint = (i: number) => 'const-9000-' + i
  const constantSaltedMintBinding = (j: number) => 'binding:const-9000-' + j
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, constantSaltedMint, constantSaltedMintBinding, 'page:p', { x: 20, y: 20 })
  const ids = cloned.shapes.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 3)
})

const orphanRef: Shape = {
  id: 'shape:orphanref', kind: 'note', parentId: 'shape:not-in-the-set', index: 'a1',
  x: 5, y: 5, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'green' },
}
test('a shape whose parent is a SHAPE outside the input set is re-rooted, not left dangling', () => {
  const cloned = cloneWithNewIds({ shapes: [orphanRef], bindings: [] }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  assert.equal(cloned.shapes[0].parentId, 'page:p')
  assert.deepEqual(cloned.rootIds, [cloned.shapes[0].id])
  assert.equal(cloned.shapes[0].x, orphanRef.x + 20, 're-rooted (via out-of-set parent) shapes are roots and get the offset too')
})

// D-2's promise: "cyclic parentId among the payload is broken in the clone
// step by re-rooting a shape whose ancestor chain doesn't terminate at a
// payload root." A naive single-hop "is parentId in the id map" check does
// NOT catch this — both cycleA and cycleB's parents ARE in the map (each
// other) — so this pins the deeper ancestor-chain walk.
const cycleA: Shape = {
  id: 'shape:cyca', kind: 'note', parentId: 'shape:cycb', index: 'a1',
  x: 1, y: 1, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'red' },
}
const cycleB: Shape = {
  id: 'shape:cycb', kind: 'note', parentId: 'shape:cyca', index: 'a1',
  x: 2, y: 2, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'blue' },
}
test('a mutual (2-node) parentId cycle among the payload is broken: both members are re-rooted', () => {
  const cloned = cloneWithNewIds({ shapes: [cycleA, cycleB], bindings: [] }, stableMint, stableMintBinding, 'page:p', { x: 20, y: 20 })
  for (const s of cloned.shapes) {
    assert.equal(s.parentId, 'page:p', `${s.id} must be re-rooted directly, not left pointing at the other cycle member`)
  }
  assert.deepEqual(cloned.rootIds.slice().sort(), cloned.shapes.map((s) => s.id).slice().sort())
})

// Fidelity guard (post-review): a cloned binding's id must itself satisfy
// bindingSchema — which requires a 'binding:' prefix (ids.ts's
// bindingIdField). E1's real shape mint is 'shape:'-prefixed (D-3); if
// cloneWithNewIds mints binding ids off the SAME stream, every cloned
// binding gets a 'shape:'-prefixed id, bindingSchema.safeParse fails, and
// the E2 PutBinding gate silently drops it — bindings vanish on paste.
test("a cloned binding's id satisfies bindingSchema (binding: prefix) under a realistic shape: mint, and its endpoints are the new shape ids", () => {
  const realisticShapeMint = (i: number) => 'shape:s' + i
  const realisticBindingMint = (j: number) => 'binding:b' + j
  const cloned = cloneWithNewIds({ shapes: cShapes, bindings: cBindings }, realisticShapeMint, realisticBindingMint, 'page:p', { x: 20, y: 20 })
  const result = bindingSchema.safeParse(cloned.bindings[0])
  assert.equal(result.success, true, `cloned binding must satisfy bindingSchema; got id=${cloned.bindings[0]?.id}`)
  assert.equal(cloned.bindings[0].fromId, cloned.shapes[1].id)
  assert.equal(cloned.bindings[0].toId, cloned.shapes[2].id)
})

if (failures > 0) {
  console.error(`\n${failures} clipboard test(s) FAILED`)
  process.exit(1)
}
console.log('ok: clipboard (cloneWithNewIds)')
