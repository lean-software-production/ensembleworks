/**
 * Run: bun contracts/src/user-id.test.ts   (from the repo root)
 */
import assert from 'node:assert/strict'
import { rawUserId } from './user-id.js'

// strips the tldraw presence prefix
assert.equal(rawUserId('user:abc123'), 'abc123')
// raw ids pass through
assert.equal(rawUserId('abc123'), 'abc123')
// only the leading prefix is stripped
assert.equal(rawUserId('user:user:x'), 'user:x')
assert.equal(rawUserId('xuser:y'), 'xuser:y')
// null and undefined normalise to the empty string
assert.equal(rawUserId(null), '')
assert.equal(rawUserId(undefined), '')

console.log('ok: user-id rawUserId')
