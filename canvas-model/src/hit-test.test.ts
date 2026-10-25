// Run: bun src/hit-test.test.ts
// Rotation-aware world bounds + point hit-testing. Every expected value below
// is derived independently (plain trig, not by calling the implementation's
// own rotate/compose helpers) so the assertions can't be tautological.
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { localBounds, worldTransform, worldBounds, hitTestPoint } from './geometry.js'

const EPS = 1e-6
const close = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps
function assertClose(actual: number, expected: number, label: string) {
  assert.ok(close(actual, expected), `${label}: expected ${expected}, got ${actual}`)
}
// Independent trig reference for the NORMATIVE convention (translate(x,y) ·
// rotate(rotation), standard math rotation matrix, y-down screen coords) —
// duplicated here on purpose rather than imported, so the test doesn't just
// echo the implementation.
function rotate(x: number, y: number, theta: number) {
  const c = Math.cos(theta), s = Math.sin(theta)
  return { x: x * c - y * s, y: x * s + y * c }
}

const base = () => ({ index: 'a1', isLocked: false, opacity: 1, meta: {} })

// ---- (1) unrotated box world bounds ----
const docUnrotated = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:a', kind: 'geo', parentId: 'page:p', x: 10, y: 20, rotation: 0, props: { w: 100, h: 50 }, ...base() } as any],
  bindings: [],
})
assert.deepEqual(
  worldBounds(docUnrotated, docUnrotated.byId.get('shape:a')!),
  { minX: 10, minY: 20, maxX: 110, maxY: 70 },
  'unrotated box: world bounds are origin + w/h exactly',
)

// ---- (2) rotated-box case, exact trig-derived expectations ----
// 100x100 box at (0,0) rotated pi/4: corners (0,0), (70.71,70.71), (0,141.42), (-70.71,70.71).
const docRotated = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:r', kind: 'geo', parentId: 'page:p', x: 0, y: 0, rotation: Math.PI / 4, props: { w: 100, h: 100 }, ...base() } as any],
  bindings: [],
})
const rotatedShape = docRotated.byId.get('shape:r')!
const rotatedCorners = [rotate(0, 0, Math.PI / 4), rotate(100, 0, Math.PI / 4), rotate(100, 100, Math.PI / 4), rotate(0, 100, Math.PI / 4)]
const expectedRotatedBounds = {
  minX: Math.min(...rotatedCorners.map((c) => c.x)), minY: Math.min(...rotatedCorners.map((c) => c.y)),
  maxX: Math.max(...rotatedCorners.map((c) => c.x)), maxY: Math.max(...rotatedCorners.map((c) => c.y)),
}
// Sanity: matches the spec's literal numbers (100/SQRT2 = 70.71..., 100*SQRT2 = 141.42...).
assertClose(expectedRotatedBounds.minX, -100 / Math.SQRT2, 'sanity minX')
assertClose(expectedRotatedBounds.minY, 0, 'sanity minY')
assertClose(expectedRotatedBounds.maxX, 100 / Math.SQRT2, 'sanity maxX')
assertClose(expectedRotatedBounds.maxY, 100 * Math.SQRT2, 'sanity maxY')

const rotatedBounds = worldBounds(docRotated, rotatedShape)
assertClose(rotatedBounds.minX, expectedRotatedBounds.minX, 'rotated minX')
assertClose(rotatedBounds.minY, expectedRotatedBounds.minY, 'rotated minY')
assertClose(rotatedBounds.maxX, expectedRotatedBounds.maxX, 'rotated maxX')
assertClose(rotatedBounds.maxY, expectedRotatedBounds.maxY, 'rotated maxY')

// ---- (3) parent-chain composition ----
// Unrotated parent: parent frame at (50,50), child at local (10,10) -> world (60,60).
const docChain = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:parent', kind: 'frame', parentId: 'page:p', x: 50, y: 50, rotation: 0, props: { w: 400, h: 400 }, ...base() } as any,
    { id: 'shape:child', kind: 'geo', parentId: 'shape:parent', x: 10, y: 10, rotation: 0, props: { w: 20, h: 20 }, ...base() } as any,
  ],
  bindings: [],
})
const childTransform = worldTransform(docChain, docChain.byId.get('shape:child')!)
assertClose(childTransform.x, 60, 'unrotated-parent child world x')
assertClose(childTransform.y, 60, 'unrotated-parent child world y')
assertClose(childTransform.rotation, 0, 'unrotated-parent child world rotation')

// Rotated parent: parent at (0,0) rotation pi/2, child local offset (10,0).
// Child's world translation must equal rotate((10,0), pi/2) + parent (0,0).
const docChainRotatedParent = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:parent2', kind: 'frame', parentId: 'page:p', x: 0, y: 0, rotation: Math.PI / 2, props: { w: 400, h: 400 }, ...base() } as any,
    { id: 'shape:child2', kind: 'geo', parentId: 'shape:parent2', x: 10, y: 0, rotation: 0, props: { w: 20, h: 20 }, ...base() } as any,
  ],
  bindings: [],
})
const expectedChild2 = rotate(10, 0, Math.PI / 2)
const child2Transform = worldTransform(docChainRotatedParent, docChainRotatedParent.byId.get('shape:child2')!)
assertClose(child2Transform.x, expectedChild2.x, 'rotated-parent child world x')
assertClose(child2Transform.y, expectedChild2.y, 'rotated-parent child world y')
assertClose(child2Transform.rotation, Math.PI / 2, 'rotated-parent child world rotation (rotations add)')

// ---- (4) hitTestPoint: true inside a rotated quad, false just outside each edge ----
// Reuse the pi/4-rotated 100x100 box from case (2). Probe in LOCAL space
// (independent of the implementation's own rotate helper) then map to world
// via the same independent `rotate` reference above.
const probe = (lx: number, ly: number) => rotate(lx, ly, Math.PI / 4)

assert.equal(hitTestPoint(docRotated, rotatedShape, probe(50, 50)), true, 'center is inside')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(1, 1)), true, 'just inside the (0,0) corner')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(99, 50)), true, 'just inside the right edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(50, 1)), true, 'just inside the top edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(1, 99)), true, 'just inside the left edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(50, 99)), true, 'just inside the bottom edge')

assert.equal(hitTestPoint(docRotated, rotatedShape, probe(-1, 50)), false, 'just outside the left (x<0) edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(101, 50)), false, 'just outside the right (x>100) edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(50, -1)), false, 'just outside the top (y<0) edge')
assert.equal(hitTestPoint(docRotated, rotatedShape, probe(50, 101)), false, 'just outside the bottom (y>100) edge')

// ---- (5) kind-default sizes for note/text when props.w/h absent ----
const noteShape = { id: 'shape:note', kind: 'note', parentId: 'page:p', x: 0, y: 0, rotation: 0, props: { color: 'yellow' }, ...base() } as any
const textShape = { id: 'shape:text', kind: 'text', parentId: 'page:p', x: 0, y: 0, rotation: 0, props: {}, ...base() } as any
assert.deepEqual(localBounds(noteShape), { minX: 0, minY: 0, maxX: 200, maxY: 200 }, 'note default 200x200 (scale 1, growY 0)')
assert.deepEqual(localBounds(textShape), { minX: 0, minY: 0, maxX: 200, maxY: 40 }, 'text default 200x40 (matches the existing DEFAULTS map used by pageBounds)')

// ---- degenerate paths: missing parent, cycle ----
// Missing parent (byId can hold orphans mid-merge): treat as page-root —
// worldTransform must still be finite, not throw, not loop forever.
const docOrphan = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:orphan', kind: 'geo', parentId: 'shape:ghost', x: 5, y: 5, rotation: 0, props: { w: 10, h: 10 }, ...base() } as any],
  bindings: [],
})
const orphanTransform = worldTransform(docOrphan, docOrphan.byId.get('shape:orphan')!)
assertClose(orphanTransform.x, 5, 'orphan treated as page-root: its own x is the world x')
assertClose(orphanTransform.y, 5, 'orphan treated as page-root: its own y is the world y')
const orphanBounds = worldBounds(docOrphan, docOrphan.byId.get('shape:orphan')!)
assert.ok(Number.isFinite(orphanBounds.minX) && Number.isFinite(orphanBounds.maxY), 'orphan world bounds are finite')

// Cycle (a <-> b as parents of each other): must terminate, not infinite-loop.
const docCycle = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:cyca', kind: 'geo', parentId: 'shape:cycb', x: 1, y: 1, rotation: 0, props: { w: 10, h: 10 }, ...base() } as any,
    { id: 'shape:cycb', kind: 'geo', parentId: 'shape:cyca', x: 2, y: 2, rotation: 0, props: { w: 10, h: 10 }, ...base() } as any,
  ],
  bindings: [],
})
const cycleTransform = worldTransform(docCycle, docCycle.byId.get('shape:cyca')!)
assert.ok(
  Number.isFinite(cycleTransform.x) && Number.isFinite(cycleTransform.y) && Number.isFinite(cycleTransform.rotation),
  'cyclic parent chain yields a finite transform',
)

// Self-parent (length-1 cycle: a shape naming itself as its own parent) —
// the degenerate case one step shorter than the mutual a<->b cycle above.
// Must still terminate on the very first repeat, not just for cycles of
// length >= 2.
const docSelfParent = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:self', kind: 'geo', parentId: 'shape:self', x: 3, y: 4, rotation: 0, props: { w: 10, h: 10 }, ...base() } as any],
  bindings: [],
})
const selfTransform = worldTransform(docSelfParent, docSelfParent.byId.get('shape:self')!)
assert.ok(
  Number.isFinite(selfTransform.x) && Number.isFinite(selfTransform.y) && Number.isFinite(selfTransform.rotation),
  'a shape parented to itself yields a finite transform',
)
const selfBounds = worldBounds(docSelfParent, docSelfParent.byId.get('shape:self')!)
assert.ok(Number.isFinite(selfBounds.minX) && Number.isFinite(selfBounds.maxY), 'self-parent world bounds are finite')

console.log('ok: hit-test')
