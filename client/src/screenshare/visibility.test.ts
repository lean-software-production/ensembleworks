/**
 * Viewport-vs-tile subscription geometry. Run: npx tsx src/screenshare/visibility.test.ts
 */
import assert from 'node:assert/strict'
import { DEFAULT_VISIBILITY_SETTINGS, shouldBeSubscribed } from './visibility'

const vp = { x: 0, y: 0, w: 1000, h: 800 }
const s = DEFAULT_VISIBILITY_SETTINGS

// Margins must form a hysteresis band or the loop can flap at one boundary.
assert.ok(s.unsubscribeMargin > s.subscribeMargin)

// Tile inside the viewport → subscribe.
assert.equal(shouldBeSubscribed({ x: 100, y: 100, w: 400, h: 300 }, vp, false, s), true)

// Just past the right edge but within the subscribe margin → subscribe early,
// so the stream is already flowing as the tile pans into view.
assert.equal(shouldBeSubscribed({ x: 1100, y: 0, w: 400, h: 300 }, vp, false, s), true)

// Beyond the subscribe margin and not currently subscribed → leave it off.
assert.equal(shouldBeSubscribed({ x: 1300, y: 0, w: 400, h: 300 }, vp, false, s), false)

// Hysteresis: the SAME tile position, but already subscribed → stays on,
// because subscribed tracks only drop beyond the larger unsubscribe margin.
assert.equal(shouldBeSubscribed({ x: 1300, y: 0, w: 400, h: 300 }, vp, true, s), true)

// Far beyond the unsubscribe margin → dropped even when subscribed.
assert.equal(shouldBeSubscribed({ x: 2000, y: 0, w: 400, h: 300 }, vp, true, s), false)

// Above the viewport works the same way (all four edges carry the margin).
assert.equal(shouldBeSubscribed({ x: 0, y: -450, w: 400, h: 300 }, vp, false, s), true)
assert.equal(shouldBeSubscribed({ x: 0, y: -600, w: 400, h: 300 }, vp, false, s), false)

// No tile on this page for the track → never subscribed, whatever the state.
assert.equal(shouldBeSubscribed(null, vp, true, s), false)
assert.equal(shouldBeSubscribed(null, vp, false, s), false)

console.log('ALL VISIBILITY TESTS PASSED')
