// Run: bun src/document.test.ts
import assert from 'node:assert/strict'
import { makeDocument, childrenOf, descendantsOf, rootShapes, shapeById, validateAsset } from './document.js'

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'Page' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { name: 'Planning', w: 400, h: 300 } },
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'yellow' } },
    // A group nested in the frame, with a note inside the group: the classic
    // container chain descendantsOf exists for.
    { id: 'shape:g', kind: 'group', parentId: 'shape:f', index: 'a2', x: 50, y: 50, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} },
    { id: 'shape:gn', kind: 'note', parentId: 'shape:g', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'blue' } },
  ],
  bindings: [],
} as any)

assert.equal(shapeById(doc, 'shape:n')!.kind, 'note')
// childrenOf is DIRECT children only (v1-parity counts depend on this).
assert.deepEqual(childrenOf(doc, 'shape:f').map((s) => s.id), ['shape:n', 'shape:g'])
assert.deepEqual(rootShapes(doc).map((s) => s.id), ['shape:f'])
// descendantsOf crosses containers: frame → group → note all included.
assert.deepEqual(descendantsOf(doc, 'shape:f').map((s) => s.id).sort(), ['shape:g', 'shape:gn', 'shape:n'])
assert.deepEqual(descendantsOf(doc, 'shape:g').map((s) => s.id), ['shape:gn'])
assert.deepEqual(descendantsOf(doc, 'shape:gn'), [])

// Cycle safety: a malformed parent cycle must terminate, not spin forever.
const cyclic = makeDocument({
  pages: [{ id: 'page:p', name: 'Page' }],
  shapes: [
    { id: 'shape:a', kind: 'group', parentId: 'shape:b', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} },
    { id: 'shape:b', kind: 'group', parentId: 'shape:a', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} },
  ],
  bindings: [],
} as any)
assert.deepEqual(descendantsOf(cyclic, 'shape:a').map((s) => s.id), ['shape:b'])

// --- Task M1 (2026-07-22 assets/image sub-cycle): validateAsset ---

// A real created asset (D-1 permissiveness guard): must validate.
{
  const r = validateAsset({ id: 'asset:a', type: 'image', props: { src: '/uploads/x', w: 10, h: 10 } })
  assert.equal(r.ok, true, 'a real created asset must validate')
}

// A converted v1 image-asset with extra props: loose passthrough guard.
{
  const r = validateAsset({
    id: 'asset:v1',
    type: 'image',
    props: { src: '/uploads/y', w: 100, h: 80, mimeType: 'image/png', name: 'photo.png', fileSize: 123, isAnimated: false },
    meta: {},
  })
  assert.equal(r.ok, true, 'a converted v1 image-asset with extra props must validate (loose passthrough)')
}

// A bookmark-style asset with no src at all: src is optional, must still validate.
{
  const r = validateAsset({ id: 'asset:b', type: 'bookmark', props: {} })
  assert.equal(r.ok, true, 'a src-less bookmark-style asset must validate (src is optional)')
}

// A foreign asset type (not 'image'): type is a plain string, must ride through.
{
  const r = validateAsset({ id: 'asset:v', type: 'video', props: { src: '/uploads/v.mp4' } })
  assert.equal(r.ok, true, 'a foreign asset type (video) must ride through permissively')
}

// A non-string src must be rejected — the one field with teeth.
{
  const r = validateAsset({ id: 'asset:a', type: 'image', props: { src: 123 } })
  assert.equal(r.ok, false, 'a non-string src must be rejected')
}

// A bad id prefix must be rejected.
{
  const r = validateAsset({ id: 'binding:a', type: 'image', props: {} })
  assert.equal(r.ok, false, 'a binding:-prefixed id must be rejected for an asset')
}

// A missing id must be rejected.
{
  const r = validateAsset({ type: 'image', props: {} })
  assert.equal(r.ok, false, 'a missing id must be rejected')
}

console.log('ok: document')
