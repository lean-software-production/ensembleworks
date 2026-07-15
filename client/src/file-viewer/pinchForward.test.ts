/**
 * Run: bun src/file-viewer/pinchForward.test.ts
 * Pure halves only — parsePinchMessage validation and the iframe-content →
 * parent-client coordinate map. The WheelEvent dispatch half is a thin DOM
 * shim exercised manually (plan Task 5).
 */
import assert from 'node:assert/strict'
import { mapIframePointToClient, parsePinchMessage } from './pinchForward'

// parsePinchMessage: accepts only well-formed ew-pinch payloads.
assert.deepEqual(
	parsePinchMessage({ type: 'ew-pinch', deltaX: 1, deltaY: -20, x: 100, y: 50 }),
	{ deltaX: 1, deltaY: -20, x: 100, y: 50 },
)
assert.equal(parsePinchMessage(null), null)
assert.equal(parsePinchMessage({ type: 'ew-scroll', fraction: 0.5 }), null)
assert.equal(parsePinchMessage({ type: 'ew-pinch', deltaX: 'x', deltaY: 0, x: 0, y: 0 }), null)
assert.equal(parsePinchMessage({ type: 'ew-pinch', deltaX: 0, deltaY: 0, x: 0 }), null)

// mapIframePointToClient: the iframe sits in a CSS-scaled world layer, so
// rect (visual) and clientWidth/Height (layout px) differ by the zoom factor.
// rect 200x100 at (10,20), layout 400x200 (canvas zoom 0.5) → content point
// (200,100) is the layout midpoint → rect midpoint (10+100, 20+50) = (110,70).
assert.deepEqual(
	mapIframePointToClient({ left: 10, top: 20, width: 200, height: 100 }, 400, 200, 200, 100),
	{ clientX: 110, clientY: 70 },
)
// Unscaled (zoom 1): identity offset.
assert.deepEqual(
	mapIframePointToClient({ left: 0, top: 0, width: 300, height: 150 }, 300, 150, 30, 15),
	{ clientX: 30, clientY: 15 },
)
// Zero-size layout → null (guards divide-by-zero on a collapsed iframe).
assert.equal(mapIframePointToClient({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, 5, 5), null)

console.log('pinchForward.test.ts OK')
