/**
 * Run: bun client/src/chrome/collaborators.test.ts
 */
import assert from 'node:assert/strict'
import { otherCollaborators } from './collaborators'

const SELF = 'user:09f66910-5a3f-4aa9-bbe0-de29bc9dfee1'
const OTHER = 'user:11111111-2222-3333-4444-555555555555'

// 1. Ordinary case: other people survive untouched, order preserved.
assert.deepEqual(otherCollaborators([{ userId: OTHER }], SELF), [{ userId: OTHER }])
assert.deepEqual(otherCollaborators([], SELF), [])

// 2. The bug this exists for: a presence record for OUR OWN user is not a
//    collaborator. tldraw's server holds a closed session's presence for 5s,
//    so the tab that mounts on the single-tab gate's recovery path receives
//    exactly this — and renders the same person twice without the filter.
assert.deepEqual(otherCollaborators([{ userId: SELF }], SELF), [])
assert.deepEqual(
	otherCollaborators([{ userId: SELF }, { userId: OTHER }], SELF),
	[{ userId: OTHER }],
	'a real teammate is kept while our own ghost is dropped'
)

// 3. Several stale records for our own user (reconnect churn can leave more
//    than one) all go, not just the first.
assert.deepEqual(otherCollaborators([{ userId: SELF }, { userId: SELF }], SELF), [])

// 4. Raw vs prefixed: presence carries the prefixed tldraw id, and callers
//    hold ids in both shapes. Matching must be on the RAW id so a prefixed
//    self id still recognises an unprefixed presence record and vice versa —
//    comparing the strings as given would silently let the ghost through.
const rawSelf = '09f66910-5a3f-4aa9-bbe0-de29bc9dfee1'
assert.deepEqual(otherCollaborators([{ userId: rawSelf }], SELF), [], 'prefixed self matches raw presence')
assert.deepEqual(otherCollaborators([{ userId: SELF }], rawSelf), [], 'raw self matches prefixed presence')

// 5. Extra fields ride along untouched — the filter is not a projection.
const rich = { userId: OTHER, userName: 'Sam', color: 'blue' }
assert.deepEqual(otherCollaborators([rich], SELF), [rich])

console.log('collaborators.test.ts: all assertions passed')
