// Run with: bun src/terminal/keys.test.ts   (from client/)
import assert from 'node:assert/strict'
import {
	FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN,
	fontSizeActionForKey, nextFontSize,
	NEWLINE_INPUT, ptyInputForKey,
} from './keys'

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

// Ctrl/Cmd +/-/0 map to font actions; '=' is unshifted '+', '_' shifted '-'.
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true })), 'up')
assert.equal(fontSizeActionForKey(ev({ key: '=', metaKey: true })), 'up')
assert.equal(fontSizeActionForKey(ev({ key: '-', ctrlKey: true })), 'down')
assert.equal(fontSizeActionForKey(ev({ key: '_', ctrlKey: true })), 'down')
assert.equal(fontSizeActionForKey(ev({ key: '0', metaKey: true })), 'reset')
// No modifier / alt combos / keyup: not ours.
assert.equal(fontSizeActionForKey(ev({ key: '+' })), null)
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true, altKey: true })), null)
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true, type: 'keyup' })), null)
// Clamping and reset.
assert.equal(nextFontSize(16, 'up'), 17)
assert.equal(nextFontSize(FONT_SIZE_MAX, 'up'), FONT_SIZE_MAX)
assert.equal(nextFontSize(FONT_SIZE_MIN, 'down'), FONT_SIZE_MIN)
assert.equal(nextFontSize(23, 'reset'), FONT_SIZE_DEFAULT)

console.log('keys.test.ts: all assertions passed')
