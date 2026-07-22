// Run: bun src/canvas-v2/clipboard-dom.test.ts
//
// Task D1's testable slice: `clipboardShortcut(event, editingId)`, the pure,
// DOM-free key->action DECISION the plan's own Step 1 names verbatim
// ("a DOM-free unit test on the decision helper ... asserting Ctrl+D->
// duplicate, Cmd+C->copy, and that editingId!==null yields null"). The
// actual `navigator.clipboard` I/O (writeClipboardText/readClipboardText)
// is DOM/async and left to the K1/K2 browser contracts per the task brief —
// not faked here.
import assert from 'node:assert/strict'
import { clipboardShortcut } from './clipboard-dom.js'

const MODS = { shift: false, alt: false, ctrl: false, meta: false }

function key(k: string, mods: Partial<typeof MODS> = {}): Parameters<typeof clipboardShortcut>[0] {
	return { type: 'keydown', key: k, modifiers: { ...MODS, ...mods }, t: 0 }
}

// 1. Ctrl+D -> duplicate.
assert.deepEqual(clipboardShortcut(key('d', { ctrl: true }), null), { action: 'duplicate' }, 'Ctrl+D maps to duplicate')

// 2. Cmd+C (metaKey, no ctrlKey) -> copy — either modifier counts.
assert.deepEqual(clipboardShortcut(key('c', { meta: true }), null), { action: 'copy' }, 'Cmd+C (metaKey) maps to copy')

// 3. Ctrl+X -> cut, Ctrl+V -> paste.
assert.deepEqual(clipboardShortcut(key('x', { ctrl: true }), null), { action: 'cut' }, 'Ctrl+X maps to cut')
assert.deepEqual(clipboardShortcut(key('v', { ctrl: true }), null), { action: 'paste' }, 'Ctrl+V maps to paste')

// 4. Case-insensitive key match (mirrors the undo/redo z-branch's own
//    reasoning — a real browser reports the shifted letter's case
//    differently across platforms).
assert.deepEqual(clipboardShortcut(key('D', { ctrl: true }), null), { action: 'duplicate' }, 'uppercase D still maps to duplicate')

// 5. editingId !== null -> null, even with a matching key+modifier — the
//    TextEditor owns Ctrl+C/X/V/D while a shape is being text-edited (native
//    text copy/cut/paste, and Ctrl+D has no meaning inside a text field).
assert.equal(clipboardShortcut(key('c', { ctrl: true }), 'shape:being-edited'), null, 'editingId!==null suppresses the shortcut entirely')

// 6. No modifier -> null (plain 'c'/'d' must not fire; those are letters a
//    user might type while, say, a future text field is focused elsewhere).
assert.equal(clipboardShortcut(key('c'), null), null, 'no ctrl/meta modifier -> null')
assert.equal(clipboardShortcut(key('d'), null), null, 'no ctrl/meta modifier -> null (Ctrl+D specifically)')

// 7. An unrelated key with the modifier held -> null (must not swallow every
//    Ctrl+<key> combination, only the four bound ones).
assert.equal(clipboardShortcut(key('a', { ctrl: true }), null), null, 'Ctrl+A (unbound) -> null')

console.log('ok: clipboard-dom — clipboardShortcut maps Ctrl/Cmd+C/X/V/D to actions, gated on editingId===null')
