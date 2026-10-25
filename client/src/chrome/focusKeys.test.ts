/**
 * Run: bun client/src/chrome/focusKeys.test.ts
 *
 * `focusKeyVerdict` is FocusOverlay's capture-phase key decision, extracted as
 * a pure function so it is testable without react-dom (and without dragging
 * tldraw into a bare-bun process, which hangs on exit — see
 * canvas-health/modalCopy.test.ts's header).
 *
 * It matters more than it looks: this listener runs in the CAPTURE phase on
 * `window`, ahead of tldraw's own body-level shortcut handler AND ahead of
 * CommandBar's accelerator engine, so it is the last word on what a
 * focus-viewed terminal's keystrokes are allowed to reach.
 */
import assert from 'node:assert/strict'
import { focusKeyVerdict } from './focusKeys'

const key = (over: Partial<Parameters<typeof focusKeyVerdict>[0]>) =>
	focusKeyVerdict({
		key: 'a',
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		editableTarget: false,
		inDialog: false,
		...over,
	})

// The exit chord wins over everything — including from inside the terminal's
// own textarea, which is the whole reason it is checked first.
assert.equal(key({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'exit', 'ctrl+shift+enter exits focus')
assert.equal(key({ key: 'Enter', metaKey: true, shiftKey: true }), 'exit', 'cmd+shift+enter exits focus')
assert.equal(
	key({ key: 'Enter', ctrlKey: true, shiftKey: true, editableTarget: true }),
	'exit',
	'the chord still exits from inside xterm'
)

// EW26: 'p' is no longer a pass-through. Present has no keyboard route at all.
assert.equal(key({ key: 'p' }), 'swallow', "'p' must be swallowed — Present has no key route")
assert.equal(key({ key: 'P', shiftKey: true }), 'swallow', "shift+'P' must be swallowed too")

// EW26: Escape is swallowed as well, so it cannot reach CommandBar's
// end-present / stop-follow handling while a shape is focus-viewed.
assert.equal(key({ key: 'Escape' }), 'swallow', 'Escape must not escape focus view')

// ...but a terminal that owns the keyboard keeps EVERYTHING, Escape included
// (vim, and xterm's own double-Esc exit).
assert.equal(key({ key: 'Escape', editableTarget: true }), 'pass', 'Escape reaches the terminal')
assert.equal(key({ key: 'a', editableTarget: true }), 'pass', 'letters reach the terminal')

// A modal opened ON TOP of focus view (the Present confirmation) owns its own
// keys — otherwise this listener would eat its Escape before Radix saw it.
assert.equal(key({ key: 'Escape', inDialog: true }), 'pass', 'Escape reaches an open dialog')
assert.equal(key({ key: 'a', inDialog: true }), 'pass', 'typing reaches an open dialog')

// Single characters are the canvas tool keys — swallowed while focused.
assert.equal(key({ key: 'n' }), 'swallow', 'tldraw tool keys are swallowed')
assert.equal(key({ key: 'm' }), 'swallow', 'former new-terminal key is swallowed')

// Modified keys are left alone (browser/OS chords, copy/paste, undo).
assert.equal(key({ key: 'c', ctrlKey: true }), 'pass', 'ctrl+c passes through')
assert.equal(key({ key: 'z', metaKey: true }), 'pass', 'cmd+z passes through')
assert.equal(key({ key: 'a', altKey: true }), 'pass', 'alt chords pass through')

// Non-character, non-Escape keys are not ours to eat.
assert.equal(key({ key: 'Tab' }), 'pass', 'Tab passes through')
assert.equal(key({ key: 'ArrowLeft' }), 'pass', 'arrows pass through')
assert.equal(key({ key: 'Enter' }), 'pass', 'bare Enter passes through')

console.log('focusKeys.test.ts: all assertions passed')
