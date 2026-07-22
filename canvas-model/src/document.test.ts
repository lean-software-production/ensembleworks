// Run: bun src/document.test.ts
import assert from 'node:assert/strict'
import { makeDocument, childrenOf, descendantsOf, rootShapes, shapeById, validateAsset, pageSchema, orderedPages, type Page } from './document.js'

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

// --- Task A1 (2026-07-22 assets/image sub-cycle): makeDocument carries assets ---

// makeDocument accepts an `assets` array and builds `.assets`/`.assetById` off it.
{
  const a: any = { id: 'asset:a', type: 'image', props: { src: '/uploads/x' }, meta: {} }
  const withAssets = makeDocument({ pages: [], shapes: [], bindings: [], assets: [a] } as any)
  assert.deepEqual((withAssets as any).assets, [a], 'CanvasDocument.assets carries the input array')
  assert.equal((withAssets as any).assetById.get('asset:a'), a, 'assetById resolves the same asset by id')
}

// makeDocument with NO `assets` argument still compiles/works (default []) —
// every existing caller (repair.ts, fixtures) must keep working unchanged.
{
  const noAssets = makeDocument({ pages: [], shapes: [], bindings: [] })
  assert.deepEqual((noAssets as any).assets, [], 'assets defaults to [] when omitted')
  assert.equal((noAssets as any).assetById.size, 0, 'assetById is empty when assets is omitted')
}

// --- Task A1 (2026-07-22 multi-page sub-cycle): Page.index + orderedPages ---

// pageSchema.parse keeps a valid `index`; a page with no `index` still
// validates (permissive — existing pages carry no index).
{
  const withIndex = pageSchema.parse({ id: 'page:p', name: 'Canvas', index: 'a0' })
  assert.equal(withIndex.index, 'a0', 'index rides through parse when present')
  const withoutIndex = pageSchema.parse({ id: 'page:p', name: 'Canvas' })
  assert.equal(withoutIndex.index, undefined, 'index is undefined when omitted, parse still succeeds')
}

// Case 1: scrambled input order, distinct indices → output follows INDEX
// order, not input order. Input order is deliberately the REVERSE of index
// order so an input-order-preserving impl fails visibly. Ids are
// deliberately ANTI-correlated with index order (id 'page:z' has the
// SMALLEST index, 'page:a' the LARGEST) — the plan's own literal example
// (ids page:a1/a2/a3 matching indices a1/a2/a3) coincidentally sorts
// correctly under an id-only mutant too, since id order equals index order
// by accident of naming; verified this escapes a sort-by-id-only mutant
// before strengthening here. This case alone must now kill that mutant.
{
  const pages: Page[] = [
    { id: 'page:a', name: 'Third', index: 'a3' } as Page,
    { id: 'page:z', name: 'First', index: 'a1' } as Page,
    { id: 'page:m', name: 'Second', index: 'a2' } as Page,
  ]
  assert.deepEqual(orderedPages(pages).map((p) => p.id), ['page:z', 'page:m', 'page:a'], 'orderedPages sorts by index, not input order or id')
}

// Case 2: (index, id) tie-break — two pages share index 'a1'; input order
// puts page:b BEFORE page:a, but the id tie-break must still put page:a
// first, deterministically (regardless of input order — the convergence
// property, same as paint-order.ts's orderForPaint).
{
  const pages: Page[] = [
    { id: 'page:b', name: 'B', index: 'a1' } as Page,
    { id: 'page:a', name: 'A', index: 'a1' } as Page,
  ]
  assert.deepEqual(orderedPages(pages).map((p) => p.id), ['page:a', 'page:b'], 'equal index ties break on id ascending')
  // Same pages, reversed input order → SAME output (input-order independence).
  assert.deepEqual(orderedPages(pages.slice().reverse()).map((p) => p.id), ['page:a', 'page:b'], 'tie-break output is independent of input order')
}

// Case 3: missing-index bootstrap page sorts FIRST relative to an indexed
// page ('' sorts before any non-empty index string lexically).
{
  const pages: Page[] = [
    { id: 'page:x', name: 'X', index: 'a0' } as Page,
    { id: 'page:p', name: 'Bootstrap' } as Page, // no index
  ]
  assert.deepEqual(orderedPages(pages).map((p) => p.id), ['page:p', 'page:x'], 'missing-index page sorts first')
}

// Convergence/shuffle: a larger set, input order UNRELATED to index order
// (including duplicate indices requiring the id tie-break AND a missing-index
// page), sorted from several different input permutations must all converge
// on the SAME output — the property orderedPages exists to guarantee.
{
  const p1: Page = { id: 'page:1', name: '1', index: 'a2' } as Page
  const p2: Page = { id: 'page:2', name: '2', index: 'a4' } as Page
  const p3: Page = { id: 'page:3', name: '3' } as Page // no index
  const p4: Page = { id: 'page:4', name: '4', index: 'a2' } as Page // ties with p1
  const p5: Page = { id: 'page:5', name: '5', index: 'a1' } as Page
  const expected = ['page:3', 'page:5', 'page:1', 'page:4', 'page:2']
  const permutations: Page[][] = [
    [p1, p2, p3, p4, p5],
    [p5, p4, p3, p2, p1],
    [p3, p1, p5, p4, p2],
    [p2, p3, p4, p1, p5],
  ]
  for (const perm of permutations) {
    assert.deepEqual(orderedPages(perm).map((p) => p.id), expected, `orderedPages converges regardless of input order: ${perm.map((p) => p.id).join(',')}`)
  }
}

console.log('ok: document')
