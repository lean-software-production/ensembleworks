// Run: bun src/ids.test.ts
import assert from 'node:assert/strict'
import { isShapeId, isPageId, isBindingId, isAssetId, parentKind } from './ids.js'

assert.equal(isShapeId('shape:abc'), true)
assert.equal(isShapeId('page:1'), false)
assert.equal(isPageId('page:1'), true)
assert.equal(isBindingId('binding:x'), true)
assert.equal(isBindingId('shape:x'), false)
// Task M1 (2026-07-22 assets/image sub-cycle)
assert.equal(isAssetId('asset:x'), true)
assert.equal(isAssetId('shape:x'), false)
assert.equal(parentKind('page:1'), 'page')
assert.equal(parentKind('shape:1'), 'shape')
assert.equal(parentKind('binding:x'), 'other')
console.log('ok: ids')
