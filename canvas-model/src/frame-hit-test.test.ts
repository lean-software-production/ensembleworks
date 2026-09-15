// Run: bun src/frame-hit-test.test.ts
// frame-interaction task (gaps 2/3/5): a frame's interior is HOLLOW (a click
// deep inside an empty frame must miss, so the select tool starts a marquee
// there instead of dragging the frame), the frame itself stays selectable via
// its BORDER (an edge-margin band) and its HEADER (a label band rendered
// above the frame's top-left corner, canvas-react's FrameShape.tsx HEADER_*
// constants) -- both hit tests below are pinned to those exact constants so
// this test can't silently drift from the renderer it must match.
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import {
  hitTestPoint, FRAME_HEADER_HEIGHT, FRAME_EDGE_MARGIN,
  isFrameLike, localBounds, bbthreadPaneLocalBounds, bbthreadWorkspaceLocalBounds, BBTHREAD_PANE_FRACTION,
} from './geometry.js'

const base = () => ({ index: 'a1', isLocked: false, opacity: 1, meta: {} })

// A 200x200 frame at (100,100) -- local box [0,200]x[0,200], world [100,300]x[100,300].
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:frame', kind: 'frame', parentId: 'page:p', x: 100, y: 100, rotation: 0, props: { w: 200, h: 200 }, ...base() } as any],
  bindings: [],
})
const frame = doc.byId.get('shape:frame')!

// ---- (1) dead-center interior point misses -- the frame is HOLLOW ----
assert.equal(hitTestPoint(doc, frame, { x: 200, y: 200 }), false, 'a point deep in the empty interior misses the frame (hollow)')

// ---- (2) a point just inside the border (within FRAME_EDGE_MARGIN) hits ----
assert.equal(
  hitTestPoint(doc, frame, { x: 100 + FRAME_EDGE_MARGIN - 1, y: 200 }),
  true,
  'a point just inside the left border (within the edge margin) still hits the frame',
)
assert.equal(
  hitTestPoint(doc, frame, { x: 300 - (FRAME_EDGE_MARGIN - 1), y: 200 }),
  true,
  'a point just inside the right border hits the frame',
)
assert.equal(
  hitTestPoint(doc, frame, { x: 200, y: 100 + FRAME_EDGE_MARGIN - 1 }),
  true,
  'a point just inside the top border hits the frame',
)
assert.equal(
  hitTestPoint(doc, frame, { x: 200, y: 300 - (FRAME_EDGE_MARGIN - 1) }),
  true,
  'a point just inside the bottom border hits the frame',
)

// ---- (3) a point just past the edge margin, still inside the box, misses ----
assert.equal(
  hitTestPoint(doc, frame, { x: 100 + FRAME_EDGE_MARGIN + 20, y: 200 }),
  false,
  'a point past the edge margin (but still inside the box) misses -- the hollow interior',
)

// ---- (4) the exact box boundary still hits (inclusive, matches every other kind) ----
assert.equal(hitTestPoint(doc, frame, { x: 100, y: 200 }), true, 'the exact left edge hits')
assert.equal(hitTestPoint(doc, frame, { x: 300, y: 200 }), true, 'the exact right edge hits')

// ---- (5) the header band, ABOVE the box's top-left corner, hits ----
// The header sits in local y in [-FRAME_HEADER_HEIGHT, 0), spanning the
// frame's width (canvas-react's FrameShape.tsx maxWidth:'100%' clip) --
// world y in [100-FRAME_HEADER_HEIGHT, 100).
assert.equal(
  hitTestPoint(doc, frame, { x: 150, y: 100 - FRAME_HEADER_HEIGHT / 2 }),
  true,
  'a point in the header band (above the frame, within its width) hits the frame',
)
assert.equal(
  hitTestPoint(doc, frame, { x: 150, y: 100 - FRAME_HEADER_HEIGHT - 5 }),
  false,
  'a point above the header band entirely misses',
)

// ---- (6) non-frame kinds are UNCHANGED -- still a solid box hit test ----
const geoDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:geo', kind: 'geo', parentId: 'page:p', x: 0, y: 0, rotation: 0, props: { w: 100, h: 100 }, ...base() } as any],
  bindings: [],
})
assert.equal(hitTestPoint(geoDoc, geoDoc.byId.get('shape:geo')!, { x: 50, y: 50 }), true, 'a plain geo shape stays a solid hit test (dead center hits)')

// ============================================================================
// bb-thread-frame task — 'bbthread': isFrameLike, default size, header/edge
// hit exactly like a frame, PLUS a solid right-third thread pane below the
// header, hollow everywhere else in the body.
// ============================================================================

assert.equal(isFrameLike('frame'), true)
assert.equal(isFrameLike('bbthread'), true)
assert.equal(isFrameLike('geo'), false)

// Default size: 960x600 (no props.w/h).
{
  const bare = { id: 'shape:bb0', kind: 'bbthread', parentId: 'page:p', x: 0, y: 0, rotation: 0, props: {}, ...base() } as any
  const lb = localBounds(bare)
  assert.deepEqual({ w: lb.maxX - lb.minX, h: lb.maxY - lb.minY }, { w: 960, h: 600 }, 'bbthread default size is 960x600')
}

// A 900x600 bbthread at the origin -- local box [0,900]x[0,600].
const bbDoc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [{ id: 'shape:bb', kind: 'bbthread', parentId: 'page:p', x: 0, y: 0, rotation: 0, props: { w: 900, h: 600 }, ...base() } as any],
  bindings: [],
})
const bbthread = bbDoc.byId.get('shape:bb')!

// Pane bounds: right third (x in [600,900]), below the header (y in [24,600]).
{
  const pane = bbthreadPaneLocalBounds(bbthread)
  assert.deepEqual(pane, { minX: 900 * (1 - BBTHREAD_PANE_FRACTION), minY: FRAME_HEADER_HEIGHT, maxX: 900, maxY: 600 })
  const workspace = bbthreadWorkspaceLocalBounds(bbthread)
  assert.deepEqual(workspace, { minX: 0, minY: FRAME_HEADER_HEIGHT, maxX: 900 * (1 - BBTHREAD_PANE_FRACTION), maxY: 600 })
}

// (1) a point in the solid pane HITS.
assert.equal(hitTestPoint(bbDoc, bbthread, { x: 800, y: 300 }), true, 'a point inside the solid thread pane hits')

// (2) a point deep in the hollow workspace MISSES.
assert.equal(hitTestPoint(bbDoc, bbthread, { x: 200, y: 300 }), false, 'a point deep in the hollow workspace misses')

// (3) the header band still hits, exactly like a frame.
assert.equal(
  hitTestPoint(bbDoc, bbthread, { x: 150, y: -FRAME_HEADER_HEIGHT / 2 }),
  true,
  'the header band hits a bbthread exactly like a frame',
)

// (4) the border edge margin still hits, exactly like a frame.
assert.equal(
  hitTestPoint(bbDoc, bbthread, { x: FRAME_EDGE_MARGIN - 1, y: 300 }),
  true,
  'the left edge margin hits a bbthread exactly like a frame',
)

console.log('ok: frame-hit-test')
