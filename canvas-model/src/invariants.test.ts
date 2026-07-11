// Run: bun src/invariants.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { checkInvariants } from './invariants.js'

const base = (over = {}) => ({ rotation: 0, isLocked: false, opacity: 1, meta: {}, ...over })

// Healthy doc → no violations.
const good = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { name: 'F', w: 100, h: 100 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 0, y: 0, props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
} as any)
assert.deepEqual(checkInvariants(good), [])

// Orphan: parent id doesn't exist.
const orphan = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:x', kind: 'note', parentId: 'shape:ghost', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
], bindings: [] } as any)
assert.ok(checkInvariants(orphan).some((v) => v.rule === 'noOrphans'))

// Cycle: a→b→a.
const cycle = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:a', kind: 'frame', parentId: 'shape:b', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
  { id: 'shape:b', kind: 'frame', parentId: 'shape:a', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
], bindings: [] } as any)
assert.ok(checkInvariants(cycle).some((v) => v.rule === 'noCycles'))

// 3-cycle a→b→c→a plus descendant d→a: every affected shape gets its own
// noCycles violation (once per shape, not per cycle).
const cycle3 = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:a', kind: 'frame', parentId: 'shape:b', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
  { id: 'shape:b', kind: 'frame', parentId: 'shape:c', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
  { id: 'shape:c', kind: 'frame', parentId: 'shape:a', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
  { id: 'shape:d', kind: 'note', parentId: 'shape:a', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
], bindings: [] } as any)
assert.deepEqual(
  checkInvariants(cycle3).filter((v) => v.rule === 'noCycles').map((v) => v.id).sort(),
  ['shape:a', 'shape:b', 'shape:c', 'shape:d'],
)

// Dangling binding.
const dangling = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
], bindings: [{ id: 'binding:1', fromId: 'shape:ar', toId: 'shape:gone', props: {} }] } as any)
assert.ok(checkInvariants(dangling).some((v) => v.rule === 'noDanglingBindings'))

// Invalid props (use a clearly bad envelope: opacity as a string).
const badProps = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:z', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 'nope' as any, meta: {}, props: {} } as any,
], bindings: [] } as any)
assert.ok(checkInvariants(badProps).some((v) => v.rule === 'validProps'))

console.log('ok: invariants')
