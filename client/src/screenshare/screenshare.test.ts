/**
 * Screen-share aspect lock + title helpers. Run: npx tsx src/screenshare/screenshare.test.ts
 */
import assert from 'node:assert/strict'
import {
	SCREENSHARE_HEADER_HEIGHT,
	lockScreenShareAspect,
	propsForAspect,
	shareTitle,
	titleFromTrackLabel,
} from './helpers'

const HDR = SCREENSHARE_HEADER_HEIGHT
const WIDE = 16 / 9

// Width-led drag (height untouched): height follows from the aspect + header.
assert.deepEqual(lockScreenShareAspect(1600, 748, 1280, 748, WIDE), {
	w: 1600,
	h: 1600 / WIDE + HDR,
})

// Height-led drag (width untouched): width follows from the video area height.
assert.deepEqual(lockScreenShareAspect(1280, 1000, 1280, 748, WIDE), {
	w: (1000 - HDR) * WIDE,
	h: 1000,
})

// A portrait window (aspect < 1) locks taller than wide.
const portrait = lockScreenShareAspect(500, 0, 400, 800, 9 / 16)
assert.equal(portrait.h, 0)
assert.equal(portrait.w, (0 - HDR) * (9 / 16)) // formula check only; min sizes clamp in onResize

// propsForAspect: height for a given width, header included, aspect echoed.
assert.deepEqual(propsForAspect(1280, WIDE), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })

// Garbage aspect (0 / NaN — e.g. getSettings() returned nothing) falls back
// to 16:9 rather than producing Infinity-sized shapes.
assert.deepEqual(propsForAspect(1280, NaN), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })
assert.deepEqual(propsForAspect(1280, 0), { h: Math.round(1280 / WIDE) + HDR, aspect: WIDE })
assert.equal(lockScreenShareAspect(1280, 748, 1280, 700, NaN).w, 1280)

// Chrome labels captures with opaque ids; real window titles pass through.
assert.equal(titleFromTrackLabel('screen:0:0'), 'screen share')
assert.equal(titleFromTrackLabel('window:12345:0'), 'screen share')
assert.equal(titleFromTrackLabel('web-contents-media-stream://5:1'), 'screen share')
assert.equal(titleFromTrackLabel(''), 'screen share')
assert.equal(titleFromTrackLabel('main.ts — my-editor'), 'main.ts — my-editor')

// Tile titles carry who is sharing and what: "<name> · <window>". The window
// part reuses the label cleanup above; a blank sharer name falls back.
assert.equal(shareTitle('David', 'main.ts — my-editor'), 'David · main.ts — my-editor')
assert.equal(shareTitle('David', 'screen:0:0'), 'David · screen share')
assert.equal(shareTitle('  ', 'window:1:0'), 'someone · screen share')

console.log('ALL SCREENSHARE HELPER TESTS PASSED')
