// Run: bun src/canvas-v2/reorder-dom.test.ts
//
// Task D1's testable slice: `reorderShortcut(event, editingId)`, the pure,
// DOM-free key->op DECISION (D-6), mirroring clipboard-dom.test.ts's
// `clipboardShortcut` coverage. The actual dispatch
// (reorderSelectionIntents -> editor.applyAll) is composed in
// CanvasV2App.tsx's handleGlobalShortcut and is NOT re-tested here; the
// end-to-end "press ] -> shape moves up in paint order" is Z1's browser
// contract (see the plan's D1 section: "Don't fake a browser RED here").
import assert from 'node:assert/strict'
import { reorderShortcut } from './reorder-dom.js'

const MODS = { shift: false, alt: false, ctrl: false, meta: false }

function key(k: string, mods: Partial<typeof MODS> = {}): Parameters<typeof reorderShortcut>[0] {
	return { type: 'keydown', key: k, modifiers: { ...MODS, ...mods }, t: 0 }
}

// 1. ']' -> bring-forward.
assert.deepEqual(reorderShortcut(key(']'), null), { op: 'forward' }, "']' maps to forward")

// 2. '[' -> send-backward.
assert.deepEqual(reorderShortcut(key('['), null), { op: 'backward' }, "'[' maps to backward")

// 3. '}' (Shift+]) -> bring-to-front. The delivered event.key is already the
//    shifted character ('}'), NOT ']' with a shift flag — D-6's own
//    "match on the delivered character directly" rule, so this asserts on
//    the character alone (shift modifier not set on the event) to prove the
//    mapping doesn't secretly require it.
assert.deepEqual(reorderShortcut(key('}'), null), { op: 'toFront' }, "'}' maps to toFront")

// 4. '{' (Shift+[) -> send-to-back.
assert.deepEqual(reorderShortcut(key('{'), null), { op: 'toBack' }, "'{' maps to toBack")

// 5. An unrelated key -> null (must not swallow every keystroke).
assert.equal(reorderShortcut(key('a'), null), null, "unrelated key 'a' -> null")

// 6. editingId !== null -> null, even for a bound key — brackets are
//    typeable characters and the TextEditor owns the keyboard while editing
//    (same gate as clipboardShortcut/Escape/Delete).
assert.equal(reorderShortcut(key(']'), 'shape:being-edited'), null, 'editingId!==null suppresses the shortcut entirely')
assert.equal(reorderShortcut(key('}'), 'shape:being-edited'), null, 'editingId!==null suppresses the shifted variant too')

// 7. Missing-modifier-distinction guard: ']' must NOT map to toFront, and
//    '}' must NOT map to forward — the four keys are pairwise distinct ops,
//    not "bracket direction, shift optional."
assert.notDeepEqual(reorderShortcut(key(']'), null), { op: 'toFront' }, "']' must not map to toFront")
assert.notDeepEqual(reorderShortcut(key('}'), null), { op: 'forward' }, "'}' must not map to forward")

console.log('ok: reorder-dom — reorderShortcut maps ]/[/{/} to the four Arrange ops, gated on editingId===null')
