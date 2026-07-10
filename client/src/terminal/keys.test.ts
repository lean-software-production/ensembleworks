// Run with: bun src/terminal/keys.test.ts   (from client/)
import assert from 'node:assert/strict'
import { NEWLINE_INPUT, ptyInputForKey } from './keys'

const ev = (over: Partial<Parameters<typeof ptyInputForKey>[0]> = {}) => ({
	type: 'keydown',
	key: 'Enter',
	shiftKey: false,
	ctrlKey: false,
	altKey: false,
	metaKey: false,
	...over,
})

// Shift+Enter → ESC CR (the byte pair claude code treats as "insert newline").
assert.equal(ptyInputForKey(ev({ shiftKey: true })), NEWLINE_INPUT)

// Alt+Enter too — xterm's own alt handling differs by platform (macOS Option
// composes characters), so we normalise it ourselves.
assert.equal(ptyInputForKey(ev({ altKey: true })), NEWLINE_INPUT)

// Plain Enter stays Enter (submit).
assert.equal(ptyInputForKey(ev()), null)

// Ctrl/Cmd+Enter are not ours to rewrite.
assert.equal(ptyInputForKey(ev({ ctrlKey: true, shiftKey: true })), null)
assert.equal(ptyInputForKey(ev({ metaKey: true, shiftKey: true })), null)

// Only keydown fires input; keyup/keypress pass through.
assert.equal(ptyInputForKey(ev({ type: 'keyup', shiftKey: true })), null)

// Non-Enter keys pass through untouched.
assert.equal(ptyInputForKey(ev({ key: 'a', shiftKey: true })), null)

console.log('keys.test.ts: all assertions passed')
