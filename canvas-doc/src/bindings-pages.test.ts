// Run: bun src/bindings-pages.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { loadModel, dumpModel } from './bridge.js'
import { makeDocument } from '@ensembleworks/canvas-model'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const model = makeDocument({
  pages: [{ id: 'page:p', name: 'Page', index: 'a0' }],
  shapes: [
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:t', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [{ id: 'binding:1', fromId: 'shape:ar', toId: 'shape:t', props: { terminal: 'end' }, meta: {} }],
})

// --- loadModel round-trips pages + bindings, not just shapes ---
const doc = LoroCanvasDoc.create({ peerId: 1n })
loadModel(doc, model)
doc.commit()
const out = dumpModel(doc)
assert.deepEqual(out.pages.map((p) => p.id), ['page:p'])
assert.deepEqual(out.bindings.map((b) => b.id), ['binding:1'])
assert.equal(out.bindings[0]!.toId, 'shape:t')

// --- direct binding CRUD ---
doc.putBinding({ id: 'binding:2', fromId: 'shape:ar', toId: 'shape:t', props: {}, meta: {} })
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id).sort(), ['binding:1', 'binding:2'])
doc.deleteBinding('binding:1')
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id), ['binding:2'])

// --- pages + bindings survive a snapshot round-trip ---
const dst = LoroCanvasDoc.fromSnapshot(doc.exportSnapshot(), { peerId: 2n })
assert.deepEqual(dst.listPages().map((p) => p.id), ['page:p'])
assert.deepEqual(dst.listBindings().map((b) => b.id), ['binding:2'])

// --- Task A1 (2026-07-22 assets/image sub-cycle): assets map + round-trip ---

const asset1: any = { id: 'asset:a1', type: 'image', props: { src: '/uploads/1', w: 10, h: 10 }, meta: {} }
const asset2: any = { id: 'asset:a2', type: 'image', props: { src: '/uploads/2', w: 20, h: 20 }, meta: {} }

// --- direct asset CRUD: put/get/list, on its OWN map (not bindings/pages) ---
const adoc = LoroCanvasDoc.create({ peerId: 3n })
;(adoc as any).putAsset(asset1)
adoc.commit()
assert.deepEqual((adoc as any).getAsset('asset:a1'), asset1, 'getAsset returns exactly what was put')
assert.deepEqual((adoc as any).listAssets(), [asset1], 'listAssets includes the put asset')
// Pins the assets map is DISTINCT from bindings/pages: a `getMap('bindings')`
// (or 'pages') reused for assets would still self-consistently satisfy the
// two assertions above (putAsset/listAssets read/write the same wrong map),
// so only checking listBindings()/listPages() stay untouched discriminates.
assert.deepEqual(adoc.listBindings(), [], 'writing an asset must not pollute listBindings')
assert.deepEqual(adoc.listPages(), [], 'writing an asset must not pollute listPages')

// --- multiple assets, distinct ids, deterministic (sorted) order ---
;(adoc as any).putAsset(asset2)
adoc.commit()
assert.deepEqual(
  (adoc as any).listAssets().map((a: any) => a.id),
  ['asset:a1', 'asset:a2'],
  'listAssets returns both assets in sorted-by-id order',
)

// --- upsert: putting the same id again overwrites (last-write wins) ---
;(adoc as any).putAsset({ ...asset1, props: { ...asset1.props, src: '/uploads/y' } })
adoc.commit()
assert.equal((adoc as any).getAsset('asset:a1').props.src, '/uploads/y', 'putAsset upserts on a repeated id')
assert.equal((adoc as any).listAssets().length, 2, 'upsert does not create a duplicate entry')

// --- assets survive a snapshot round-trip (peer reload) ---
const adst = LoroCanvasDoc.fromSnapshot(adoc.exportSnapshot(), { peerId: 4n })
assert.deepEqual(
  (adst as any).listAssets().map((a: any) => a.id),
  ['asset:a1', 'asset:a2'],
  'assets survive a snapshot round-trip in the same deterministic order',
)

// --- dumpModel carries assets: THE renderer-blocking round-trip ---
const dumped = dumpModel(adoc)
assert.deepEqual((dumped as any).assets.map((a: any) => a.id), ['asset:a1', 'asset:a2'], 'dumpModel(doc).assets carries listAssets()')
assert.deepEqual((dumped as any).assetById.get('asset:a2'), asset2, 'dumpModel(doc).assetById resolves by id')

// --- loadModel carries assets INTO a fresh doc: full model round-trip ---
const modelWithAssets = makeDocument({ pages: [], shapes: [], bindings: [], assets: [asset1, asset2] } as any)
const loadDoc = LoroCanvasDoc.create({ peerId: 5n })
loadModel(loadDoc, modelWithAssets)
loadDoc.commit()
assert.deepEqual(
  dumpModel(loadDoc).assets.map((a: any) => a.id),
  ['asset:a1', 'asset:a2'],
  'loadModel puts every asset so a full model round-trips',
)

console.log('ok: bindings-pages')
