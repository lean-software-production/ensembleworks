/**
 * Run: bun client/src/chrome/presentCopy.test.ts
 *
 * The Present confirmation's rendering is trivial JSX; its one decision is the
 * copy. Pinned here, verbatim, because that exact sentence is what the card's
 * acceptance criteria (and the humans reading the modal) check for — and
 * because the wording is the whole point of the gate: it has to say out loud
 * that this takes over OTHER people's screens. Extracted into a tldraw-free
 * module so it is testable without react-dom (see
 * canvas-health/modalCopy.test.ts's header).
 */
import assert from 'node:assert/strict'
import {
	PRESENT_CANCEL_LABEL,
	PRESENT_CONFIRM_BODY,
	PRESENT_CONFIRM_LABEL,
	PRESENT_CONFIRM_TITLE,
} from './presentCopy'

assert.equal(
	PRESENT_CONFIRM_BODY,
	"You're about to grab control of everyone's canvas and pull them over to see what you're seeing. Are you sure?"
)
assert.equal(PRESENT_CONFIRM_TITLE, 'Present to the room?')
assert.equal(PRESENT_CONFIRM_LABEL, 'Present')
assert.equal(PRESENT_CANCEL_LABEL, 'Cancel')

// The confirm and cancel labels must not collide — the acceptance smoke picks
// the buttons apart by their text.
assert.notEqual(PRESENT_CONFIRM_LABEL, PRESENT_CANCEL_LABEL)

console.log('presentCopy.test.ts: all assertions passed')
