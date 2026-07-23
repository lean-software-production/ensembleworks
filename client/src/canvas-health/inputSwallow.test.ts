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

// REGRESSION (2026-07-23): Enter and Space must be swallowed.
//
// They used to pass through whenever focus was inside the panel, so the
// takeover button could be operated by keyboard. That button was deleted when
// the duplicate-tab takeover became a mount gate, but the exemption stayed —
// and because the modal focuses itself on mount, it applied essentially all
// the time. The result was a standing leak of two keys to tldraw's
// document.body handler with nothing left to benefit from it: Space is
// hold-to-pan, and Enter enters shape-edit mode, which is exactly "mutate a
// canvas that cannot sync" — the thing this predicate exists to prevent.
//
// The panel contains nothing focusable now (a tabIndex={-1} div of text,
// chips and a latency pill), so no key needs to reach it. shouldSwallowKey
// therefore takes no focus-location input at all: there is no state in which
// the swallow relaxes. If an interactive control is ever added back, add a
// narrow exemption AND a test saying why.
assert.equal(outside({ key: 'Enter' }), true, 'Enter must be swallowed (no focusable control to operate)')
assert.equal(outside({ key: ' ' }), true, 'Space must be swallowed (tldraw hold-to-pan)')

// The allowlist is unconditional — these hold no matter where focus sits,
// which is the property that replaced the old insidePanel branching.
assert.equal(outside({ key: 'z', ctrlKey: true }), true, 'ctrl+z stays swallowed unconditionally')
assert.equal(outside({ key: 'c', ctrlKey: true }), false, 'ctrl+c passes through unconditionally')
assert.equal(outside({ key: 'd' }), true, 'bare letters stay swallowed (tldraw tool shortcuts)')

console.log('inputSwallow.test.ts: all assertions passed')
