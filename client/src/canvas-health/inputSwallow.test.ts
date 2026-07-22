/**
 * Run: bun client/src/canvas-health/inputSwallow.test.ts
 *
 * `shouldSwallowKey` is the modal's overlay-swallow decision, extracted as a
 * pure predicate so it's testable without react-dom. It matters more than it
 * looks: tldraw's keyboard-shortcut handler is attached to `document.body`
 * itself (not its own container — see CanvasBlockerModal.tsx's comment), so
 * this predicate is the ONLY thing standing between a blocked, unsynced
 * canvas and Ctrl/Cmd+Z (undo) mutating local state while the modal is up.
 */
import assert from 'node:assert/strict'
import { shouldSwallowKey } from './CanvasBlockerModal'

const outside = (over: Partial<Parameters<typeof shouldSwallowKey>[0]>) =>
	shouldSwallowKey({
		key: 'a',
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		insidePanel: false,
		...over,
	})

// Mutating tldraw shortcuts must be swallowed, ctrl or meta, with or without shift.
assert.equal(outside({ key: 'z', ctrlKey: true }), true, 'ctrl+z (undo) must be swallowed')
assert.equal(outside({ key: 'z', metaKey: true }), true, 'cmd+z (undo) must be swallowed')
assert.equal(outside({ key: 'z', ctrlKey: true, shiftKey: true }), true, 'ctrl+shift+z (redo) must be swallowed')
assert.equal(outside({ key: 'z', metaKey: true, shiftKey: true }), true, 'cmd+shift+z (redo) must be swallowed')
assert.equal(outside({ key: 'a', ctrlKey: true }), true, 'ctrl+a (select-all) must be swallowed')
assert.equal(outside({ key: 'a', metaKey: true }), true, 'cmd+a (select-all) must be swallowed')
assert.equal(outside({ key: 'x', ctrlKey: true }), true, 'ctrl+x (cut) must be swallowed')
assert.equal(outside({ key: 'v', ctrlKey: true }), true, 'ctrl+v (paste) must be swallowed')

// The allowlist: copy, and bare Tab for focus movement.
assert.equal(outside({ key: 'c', ctrlKey: true }), false, 'ctrl+c (copy) must pass through')
assert.equal(outside({ key: 'c', metaKey: true }), false, 'cmd+c (copy) must pass through')
assert.equal(outside({ key: 'Tab' }), false, 'bare Tab must pass through')

// Plain, unmodified tldraw-shortcut-space keys are swallowed.
assert.equal(outside({ key: 'a' }), true, 'a plain letter must be swallowed')
assert.equal(outside({ key: 'Delete' }), true, 'Delete must be swallowed')
assert.equal(outside({ key: 'Backspace' }), true, 'Backspace must be swallowed')
assert.equal(outside({ key: 'Escape' }), true, 'Escape must be swallowed')

// insidePanel is true in the common case (focus-on-mount lands there), so it
// must NOT be a blanket bypass — only Enter/Space (operating a focused
// button) get exempted by it. Modifier chords stay swallowed regardless of
// focus location, and so do bare tool-shortcut keys.
assert.equal(outside({ key: 'z', ctrlKey: true, insidePanel: true }), true, 'insidePanel must not bypass ctrl+z')
assert.equal(outside({ key: 'z', metaKey: true, insidePanel: true }), true, 'insidePanel must not bypass cmd+z')
assert.equal(outside({ key: 'a', ctrlKey: true, insidePanel: true }), true, 'insidePanel must not bypass ctrl+a')
assert.equal(outside({ key: 'a', metaKey: true, insidePanel: true }), true, 'insidePanel must not bypass cmd+a')
assert.equal(outside({ key: 'c', ctrlKey: true, insidePanel: true }), false, 'ctrl+c passes through inside the panel too')
assert.equal(outside({ key: 'c', metaKey: true, insidePanel: true }), false, 'cmd+c passes through inside the panel too')
assert.equal(outside({ key: 'Enter', insidePanel: true }), false, 'Enter must operate the focused button')
assert.equal(outside({ key: ' ', insidePanel: true }), false, 'Space must operate the focused button')
assert.equal(outside({ key: 'd', insidePanel: true }), true, 'bare letters inside the panel must still be swallowed (tldraw tool shortcuts)')
assert.equal(outside({ key: 'Tab', insidePanel: true }), false, 'bare Tab must pass through inside the panel too')

console.log('inputSwallow.test.ts: all assertions passed')
