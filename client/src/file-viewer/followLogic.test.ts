// followLogic: pick the presenter for a shape from collaborator presence meta.
// Run: bun src/file-viewer/followLogic.test.ts
import assert from 'node:assert/strict'
import { presenterFor } from './followLogic'

const peer = (userId: string, meta: unknown) => ({ userId, userName: userId, meta }) as never

assert.equal(presenterFor([peer('a', {})], 'shape:1'), null)
const p = presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.5 } })], 'shape:1')
assert.equal(p?.userId, 'a')
assert.equal(p?.fraction, 0.5)
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:2', fraction: 0.5 } })], 'shape:1'), null)
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 42 } })], 'shape:1'), null)
const two = [
	peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.1 } }),
	peer('b', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.9 } }),
]
assert.equal(presenterFor(two, 'shape:1')?.userId, 'a')

console.log('ok: followLogic')
