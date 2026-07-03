/**
 * Tests for the client-computed spatial stamp — the {at, frame} pair each
 * browser publishes via presence.meta.stamp. Semantics must match what the
 * server used to compute in app.ts (frameAtPoint/viewportCenter), relocated.
 * Run with: npx tsx src/presence/stamp.test.ts
 */
import assert from 'node:assert/strict'
import { computeStamp, type StampRecord } from './stamp'

// One page, one 800×600 frame at (1000, 0) — same fixture geometry the
// server tests use ("Drafting — crew-a" at 1000..1800 × 0..600).
const FRAME: StampRecord = {
	id: 'shape:frame-drafting',
	typeName: 'shape',
	type: 'frame',
	parentId: 'page:page',
	x: 1000,
	y: 0,
	props: { w: 800, h: 600, name: 'Drafting — crew-a' },
}
const PAGE_RECORD: StampRecord = { id: 'page:page', typeName: 'page' }

const NO_VIEW = { camera: null, screenBounds: null }

// 1. Cursor inside a frame wins: at = cursor, frame = that frame, dist 0.
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 1200, y: 300 },
		camera: { x: 0, y: 0, z: 1 },
		screenBounds: { w: 1920, h: 1080 },
	})
	assert.deepEqual(stamp.at, { x: 1200, y: 300 }, 'at is the cursor when it is inside a frame')
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 0, 'inside the frame ⇒ dist 0')
	console.log('ok: cursor inside frame ⇒ at=cursor, dist 0')
}

// 2. Cursor parked outside every frame ⇒ locate by viewport centre.
// centre = (w/2/z − camX, h/2/z − camY) = (400 − (−1000), 100 − (−200)) = (1400, 300).
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 50, y: 5000 },
		camera: { x: -1000, y: -200, z: 1 },
		screenBounds: { w: 800, h: 200 },
	})
	assert.deepEqual(stamp.at, { x: 1400, y: 300 }, 'at is the viewport centre, not the parked cursor')
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 0, 'viewport centre is inside the frame ⇒ dist 0')
	console.log('ok: parked cursor ⇒ at=viewport centre')
}

// 3. No camera/screenBounds ⇒ fall back to the cursor; nearest frame by edge
// distance. Cursor at (900, 300) is 100 left of the frame's x=1000 edge.
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 900, y: 300 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 900, y: 300 })
	assert.equal(stamp.frame?.name, 'Drafting — crew-a')
	assert.equal(stamp.frame?.dist, 100, 'edge distance to the nearest frame')
	console.log('ok: no camera ⇒ at=cursor, nearest frame by edge distance')
}

// 4. Nested frames: a child frame's x/y are parent-relative, so page-space
// containment must add the parent offset. The child deliberately protrudes
// past its parent's right edge: parent spans 1000..1800, child (parent-
// relative x:700, w:200) spans page 1700..1900. A point at (1850, 100) is
// inside the child ONLY — finding it proves the offset arithmetic.
{
	const child: StampRecord = {
		id: 'shape:frame-child',
		typeName: 'shape',
		type: 'frame',
		parentId: 'shape:frame-drafting',
		x: 700,
		y: 30,
		props: { w: 200, h: 100, name: 'Child' },
	}
	const stamp = computeStamp([PAGE_RECORD, FRAME, child], {
		currentPageId: 'page:page',
		cursor: { x: 1850, y: 100 },
		...NO_VIEW,
	})
	assert.equal(stamp.frame?.name, 'Child', 'child frame resolved in page space')
	assert.equal(stamp.frame?.dist, 0, 'point is inside the (offset) child rect')
	console.log('ok: nested frame coordinates resolve to page space')
}

// 5. A page with no frames ⇒ frame: null, at still recorded.
{
	const stamp = computeStamp([PAGE_RECORD], {
		currentPageId: 'page:page',
		cursor: { x: 10, y: 20 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 10, y: 20 })
	assert.equal(stamp.frame, null, 'no frames on the page ⇒ frame is null')
	console.log('ok: no frames ⇒ frame null, at recorded')
}

// 6. Frames on other pages are ignored.
{
	const otherPageFrame: StampRecord = {
		id: 'shape:frame-elsewhere',
		typeName: 'shape',
		type: 'frame',
		parentId: 'page:other',
		x: 0,
		y: 0,
		props: { w: 100, h: 100, name: 'Elsewhere' },
	}
	const stamp = computeStamp([PAGE_RECORD, otherPageFrame], {
		currentPageId: 'page:page',
		cursor: { x: 50, y: 50 },
		...NO_VIEW,
	})
	assert.equal(stamp.frame, null, 'frames on other pages never match')
	console.log('ok: other-page frames ignored')
}

// 7. Fractional inputs are rounded on the way out (the wire carries ints).
{
	const stamp = computeStamp([PAGE_RECORD, FRAME], {
		currentPageId: 'page:page',
		cursor: { x: 1200.6, y: 300.4 },
		...NO_VIEW,
	})
	assert.deepEqual(stamp.at, { x: 1201, y: 300 }, 'at is rounded to integers')
	console.log('ok: at is rounded')
}

console.log('stamp.test.ts: all tests passed')
