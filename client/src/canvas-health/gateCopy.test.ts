/**
 * The refusal screen's wording is owner-chosen and deliberately states the
 * rule without justifying it. It was unguarded when it lived in the old
 * takeover modal; pin it here so it cannot drift silently.
 */
import assert from 'node:assert/strict'
import { DUPLICATE_TAB_COPY } from './SingleTabGate'

assert.equal(DUPLICATE_TAB_COPY.heading, 'This canvas is open in another tab')
assert.equal(
	DUPLICATE_TAB_COPY.body,
	'You can only open the canvas in one tab at a time. This tab is currently disabled.'
)
// There is no takeover, so the copy must tell the user what actually resolves
// this. Recovery IS automatic (the queued lock request is granted the moment
// the other tab closes), so the instruction must not imply a reload.
assert.equal(DUPLICATE_TAB_COPY.recovery, 'Close the other tab and this one will connect automatically.')
assert.ok(!/reload|refresh/i.test(DUPLICATE_TAB_COPY.recovery))

console.log('gateCopy: ok')
