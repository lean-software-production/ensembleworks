/**
 * neko per-viewer URL composition. Run: bun src/neko/neko.test.ts
 */
import assert from 'node:assert/strict'
import {
	NEKO_DEFAULT_BASE,
	NEKO_HEADER_HEIGHT,
	NEKO_VIDEO_RATIO,
	buildNekoSrc,
	lockNekoAspect,
} from './NekoShapeUtil'

// Auto-login (usr+pwd) + bare embed mode; name percent-encoded.
assert.equal(
	buildNekoSrc('/dev/8090/', 'David Laing'),
	'/dev/8090/?usr=David%20Laing&pwd=neko&embed=1'
)

// The default base already ends in '/', so the query appends with '?'.
assert.ok(buildNekoSrc(NEKO_DEFAULT_BASE, 'x').startsWith('/shared-browser/?usr=x&'))

// A base that already carries a query string appends with '&', not a second '?'.
assert.equal(
	buildNekoSrc('/dev/8090/?lang=en', 'Mo'),
	'/dev/8090/?lang=en&usr=Mo&pwd=neko&embed=1'
)

// Reserved characters in a name are encoded so they can't break out of the query.
assert.equal(buildNekoSrc('/n/', 'a&b=c'), '/n/?usr=a%26b%3Dc&pwd=neko&embed=1')

// Empty identity (pre-onboarding) is harmless, never throws.
assert.equal(buildNekoSrc('/n/', ''), '/n/?usr=&pwd=neko&embed=1')

// --- aspect lock (Option A: video area stays 16:9, no letterbox) ---

// The video area below the header keeps the stream ratio exactly.
function videoRatio(w: number, h: number) {
	return (h - NEKO_HEADER_HEIGHT) / w
}

// Width-led drag (corner / left-right): height follows width.
{
	const { w, h } = lockNekoAspect(1600, 999, 800, 478)
	assert.equal(w, 1600)
	assert.ok(Math.abs(videoRatio(w, h) - NEKO_VIDEO_RATIO) < 1e-9, 'width-led keeps 16:9')
}

// Height-led drag (top / bottom changed more): width follows height.
{
	const { w, h } = lockNekoAspect(805, 900, 800, 478)
	assert.equal(h, 900)
	assert.ok(Math.abs(videoRatio(w, h) - NEKO_VIDEO_RATIO) < 1e-9, 'height-led keeps 16:9')
}

// A no-op resize stays on ratio (defaults are already locked).
{
	const { w, h } = lockNekoAspect(800, 478, 800, 478)
	assert.ok(Math.abs(videoRatio(w, h) - NEKO_VIDEO_RATIO) < 0.01)
}

console.log('ok - neko url composition + aspect lock')

console.log("ALL NEKO TESTS PASSED")
// The tldraw import keeps the node event loop alive after assertions finish —
// exit explicitly so `bun` runs terminate.
process.exit(0)
