/**
 * Run: bun client/src/chrome/focusEditing.test.ts
 *
 * The focus-view ⇄ editing self-heal, as a pure predicate. Extracted from
 * FocusOverlay.tsx so it is testable without react-dom (and without dragging
 * tldraw into a bare-bun process, which hangs on exit — see
 * canvas-health/modalCopy.test.ts's header).
 */
import assert from 'node:assert/strict'
import { EDIT_ON_FOCUS_SHAPE_TYPES, shouldExitFocusForLostEditing } from './focusEditing'

// Policy: terminals attach the keyboard on focus; frames deliberately do not.
assert.equal(EDIT_ON_FOCUS_SHAPE_TYPES.has('terminal'), true, 'terminals attach the keyboard')
assert.equal(EDIT_ON_FOCUS_SHAPE_TYPES.has('frame'), false, 'frames stay focus-only')

// Nothing focused → nothing to heal.
assert.equal(
	shouldExitFocusForLostEditing({ focusedShapeId: null, focusedShapeType: null, editingShapeId: null }),
	false,
	'no focus session, no exit'
)

// The steady state: focused terminal, editing the same shape.
assert.equal(
	shouldExitFocusForLostEditing({
		focusedShapeId: 'shape:t1',
		focusedShapeType: 'terminal',
		editingShapeId: 'shape:t1',
	}),
	false,
	'focused and editing the same terminal is the steady state'
)

// xterm's double-Esc calls setEditingShape(null) — focus must follow it out.
assert.equal(
	shouldExitFocusForLostEditing({
		focusedShapeId: 'shape:t1',
		focusedShapeType: 'terminal',
		editingShapeId: null,
	}),
	true,
	'editing cleared under a focused terminal must exit focus'
)

// Editing moved to a DIFFERENT shape — the matte is over a terminal that no
// longer owns the keyboard, same failure, same cure.
assert.equal(
	shouldExitFocusForLostEditing({
		focusedShapeId: 'shape:t1',
		focusedShapeType: 'terminal',
		editingShapeId: 'shape:t2',
	}),
	true,
	'editing moving elsewhere must exit focus'
)

// Frames never enter editing, so "not editing" is their normal state and must
// NOT bounce them straight back out of focus view.
assert.equal(
	shouldExitFocusForLostEditing({
		focusedShapeId: 'shape:f1',
		focusedShapeType: 'frame',
		editingShapeId: null,
	}),
	false,
	'a focused frame with no editing shape is fine'
)

// Shape type unknown (deleted mid-frame) — the shape-missing effect owns that
// case; do not double-fire from here.
assert.equal(
	shouldExitFocusForLostEditing({
		focusedShapeId: 'shape:t1',
		focusedShapeType: null,
		editingShapeId: null,
	}),
	false,
	'unknown shape type defers to the shape-missing self-heal'
)

console.log('focusEditing.test.ts: all assertions passed')
