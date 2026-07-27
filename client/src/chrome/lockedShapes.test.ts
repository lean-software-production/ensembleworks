/**
 * Run: bun client/src/chrome/lockedShapes.test.ts
 */
import assert from 'node:assert/strict'
import { badgedLockedShapeIds, everySelectedShapeLocked } from './lockedShapes'

// A lock lookup built from an explicit set — stands in for
// editor.isShapeOrAncestorLocked, which is what the component injects.
const lockedAmong =
	(...ids: string[]) =>
	(id: string) =>
		ids.includes(id)

// Hovered and locked → badged.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:a'),
	}),
	['shape:a']
)

// Hovered but NOT locked → nothing. A locked shape at rest looks like any
// other shape; an unlocked one must never sprout a padlock.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: [],
		isLocked: lockedAmong(),
	}),
	[]
)

// Nothing hovered, nothing selected → nothing.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:a'),
	}),
	[]
)

// Selected and locked (not hovered) → badged. This is the trigger that keeps
// the badge up after a click moves the pointer away (spec §3).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['shape:a'],
		isLocked: lockedAmong('shape:a'),
	}),
	['shape:a']
)

// Mixed selection → only the locked members, selection order preserved.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['shape:a', 'shape:b', 'shape:c'],
		isLocked: lockedAmong('shape:a', 'shape:c'),
	}),
	['shape:a', 'shape:c']
)

// No cap: every locked shape in a large selection badges (spec §5).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: null,
		selectedShapeIds: ['s:0', 's:1', 's:2', 's:3', 's:4', 's:5', 's:6', 's:7', 's:8', 's:9'],
		isLocked: () => true,
	}),
	['s:0', 's:1', 's:2', 's:3', 's:4', 's:5', 's:6', 's:7', 's:8', 's:9']
)

// Hovered shape is ALSO selected → one badge, not two.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:a',
		selectedShapeIds: ['shape:a', 'shape:b'],
		isLocked: lockedAmong('shape:a', 'shape:b'),
	}),
	['shape:a', 'shape:b']
)

// Ancestor-locked child: the caller's predicate reports the CHILD as locked
// (that is what editor.isShapeOrAncestorLocked does), so it badges even
// though nothing set isLocked on the child itself. A locked frame makes its
// children inert too — a live hypothesis during the incident (spec §5).
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:child',
		selectedShapeIds: [],
		isLocked: lockedAmong('shape:child'),
	}),
	['shape:child']
)

// Hovered qualifies and comes first, ahead of the selection.
assert.deepEqual(
	badgedLockedShapeIds({
		hoveredShapeId: 'shape:h',
		selectedShapeIds: ['shape:a'],
		isLocked: () => true,
	}),
	['shape:h', 'shape:a']
)

// ---------------------------------------------------------------------------
// everySelectedShapeLocked — the style panel's suppression test.
// ---------------------------------------------------------------------------

// A selection of one locked shape: the panel's controls would all be no-ops.
assert.equal(everySelectedShapeLocked(['shape:a'], lockedAmong('shape:a')), true)

// One unlocked shape: the panel is useful, keep it.
assert.equal(everySelectedShapeLocked(['shape:a'], lockedAmong()), false)

// Every member locked → suppress.
assert.equal(everySelectedShapeLocked(['shape:a', 'shape:b'], lockedAmong('shape:a', 'shape:b')), true)

// MIXED selection → do NOT suppress. tldraw's updateShapes lock-filters, so the
// controls still restyle the unlocked members; hiding the panel would take a
// working tool away.
assert.equal(everySelectedShapeLocked(['shape:a', 'shape:b'], lockedAmong('shape:a')), false)

// Empty selection is NOT "every shape locked" — with nothing selected the panel
// has its own armed-tool behaviour, which this must not suppress.
assert.equal(everySelectedShapeLocked([], lockedAmong('shape:a')), false)

// Ancestor-locked child counts as locked, same predicate as the badge.
assert.equal(everySelectedShapeLocked(['shape:child'], lockedAmong('shape:child')), true)

console.log('lockedShapes.test.ts: all assertions passed')
