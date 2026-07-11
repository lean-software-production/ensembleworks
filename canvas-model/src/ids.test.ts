// Run: bun src/ids.test.ts
import assert from 'node:assert/strict'
import { isShapeId, isPageId, isBindingId, parentKind } from './ids.js'

assert.equal(isShapeId('shape:abc'), true)
assert.equal(isShapeId('page:1'), false)
assert.equal(isPageId('page:1'), true)
assert.equal(isBindingId('binding:x'), true)
assert.equal(parentKind('page:1'), 'page')
assert.equal(parentKind('shape:1'), 'shape')
console.log('ok: ids')
