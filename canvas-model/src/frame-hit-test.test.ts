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
  isFrameLike, isPointInBbthreadPane, localBounds, bbthreadPaneLocalBounds, bbthreadWorkspaceLocalBounds, BBTHREAD_PANE_FRACTION,
  paneFractionOf, BBTHREAD_PANE_MIN_FRACTION, BBTHREAD_PANE_MAX_FRACTION, BBTHREAD_DIVIDER_MARGIN, isPointOnBbthreadDivider,
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

// Pane bounds: right third (x in [600,900]), spanning the shape's FULL local
// height (y in [0,600]) -- the header band sits entirely above this, at
// negative y, exactly like a plain frame's; there is no dead strip between
// the header and the pane.
{
  const pane = bbthreadPaneLocalBounds(bbthread)
  assert.deepEqual(pane, { minX: 900 * (1 - BBTHREAD_PANE_FRACTION), minY: 0, maxX: 900, maxY: 600 })
  const workspace = bbthreadWorkspaceLocalBounds(bbthread)
  assert.deepEqual(workspace, { minX: 0, minY: 0, maxX: 900 * (1 - BBTHREAD_PANE_FRACTION), maxY: 600 })
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

// ============================================================================
// isPointInBbthreadPane (pane input routing task): standalone predicate the
// select tool uses to distinguish "double-click landed in the solid thread
// pane" from every other bbthread hit region.
// ============================================================================

// (1) a point inside the pane hits.
assert.equal(isPointInBbthreadPane(bbDoc, bbthread, { x: 800, y: 300 }), true, 'a point inside the thread pane is reported')

// (2) a point in the hollow workspace misses.
assert.equal(isPointInBbthreadPane(bbDoc, bbthread, { x: 200, y: 300 }), false, 'a point in the hollow workspace is not in the pane')

// (3) a point in the header band misses (even though hitTestPoint hits there too).
assert.equal(isPointInBbthreadPane(bbDoc, bbthread, { x: 150, y: -FRAME_HEADER_HEIGHT / 2 }), false, 'a point in the header band is not in the pane')

// (4) a non-bbthread kind never reports a pane hit, even at the same coordinates.
assert.equal(isPointInBbthreadPane(doc, frame, { x: 250, y: 200 }), false, 'a plain frame has no thread pane at all')

// ============================================================================
// Resizable pane task (docs/plans/2026-09-15-bb-thread-frame.md's "Resizable
// pane" section) — paneFractionOf's clamp/default, isPointOnBbthreadDivider,
// and bbthreadPaneLocalBounds/bbthreadWorkspaceLocalBounds tracking a
// non-default paneFraction.
// ============================================================================

const bbBare = (props: Record<string, unknown>) =>
  ({ id: 'shape:bb2', kind: 'bbthread', parentId: 'page:p', x: 0, y: 0, rotation: 0, props, ...base() } as any)

// (1) no paneFraction prop -> the default (BBTHREAD_PANE_FRACTION, 1/3).
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600 })), BBTHREAD_PANE_FRACTION, 'an absent paneFraction resolves to the default')

// (2) a non-number paneFraction -> the default (schema rejects this at
// validateShape time, but paneFractionOf itself must degrade gracefully for
// any raw props object a caller hands it directly).
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600, paneFraction: '0.5' })), BBTHREAD_PANE_FRACTION, 'a non-number paneFraction resolves to the default')
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600, paneFraction: NaN })), BBTHREAD_PANE_FRACTION, 'a NaN paneFraction resolves to the default')

// (3) an in-range paneFraction passes through unchanged.
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600, paneFraction: 0.5 })), 0.5, 'an in-range paneFraction passes through unchanged')

// (4) below BBTHREAD_PANE_MIN_FRACTION clamps up to the floor.
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600, paneFraction: 0.01 })), BBTHREAD_PANE_MIN_FRACTION, 'a paneFraction below the min clamps to BBTHREAD_PANE_MIN_FRACTION')

// (5) above BBTHREAD_PANE_MAX_FRACTION clamps down to the ceiling.
assert.equal(paneFractionOf(bbBare({ w: 900, h: 600, paneFraction: 5 })), BBTHREAD_PANE_MAX_FRACTION, 'a paneFraction above the max clamps to BBTHREAD_PANE_MAX_FRACTION')

// (6) bbthreadPaneLocalBounds/bbthreadWorkspaceLocalBounds track a
// non-default paneFraction: a 900x600 bbthread with paneFraction 0.5 splits
// evenly at local x=450.
{
  const half = bbBare({ w: 900, h: 600, paneFraction: 0.5 })
  const halfDoc = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [half], bindings: [] })
  const halfShape = halfDoc.byId.get('shape:bb2')!
  assert.deepEqual(bbthreadPaneLocalBounds(halfShape), { minX: 450, minY: 0, maxX: 900, maxY: 600 }, 'the pane bounds follow a resized paneFraction')
  assert.deepEqual(bbthreadWorkspaceLocalBounds(halfShape), { minX: 0, minY: 0, maxX: 450, maxY: 600 }, 'the workspace bounds follow a resized paneFraction')
}

// (7) isPointOnBbthreadDivider: a point within BBTHREAD_DIVIDER_MARGIN of the
// pane's left edge (local x=600 for the default-fraction 900x600 bbthread
// fixture, modulo float noise in the (1 - 1/3) division -- so the boundary
// checks below stay one full unit clear of the margin on either side rather
// than pinning the exact float, which `900 * (1 - 1/3)` does not land on
// 600.0 dead-on) hits, whether on the pane side or the workspace side; a
// point further away, or above/below the pane's y-range, misses.
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600, y: 300 }), true, 'exactly on the divider hits')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600 - (BBTHREAD_DIVIDER_MARGIN - 1), y: 300 }), true, 'just inside the workspace-side of the divider margin hits')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600 + (BBTHREAD_DIVIDER_MARGIN - 1), y: 300 }), true, 'just inside the pane-side of the divider margin hits')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600 - (BBTHREAD_DIVIDER_MARGIN + 1), y: 300 }), false, 'just past the workspace-side margin misses')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600 + (BBTHREAD_DIVIDER_MARGIN + 1), y: 300 }), false, 'just past the pane-side margin misses')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600, y: -1 }), false, 'above the pane (in the header band) misses')
assert.equal(isPointOnBbthreadDivider(bbDoc, bbthread, { x: 600, y: 601 }), false, 'below the pane (past the shape) misses')
assert.equal(isPointOnBbthreadDivider(doc, frame, { x: 600, y: 300 }), false, 'a plain frame has no divider at all')

// (8) hitTestPoint counts the divider band as a hit even on the
// workspace-side half of the margin, which falls OUTSIDE bbthreadPaneLocalBounds
// (a would-be miss on the otherwise-hollow interior without this).
assert.equal(
  hitTestPoint(bbDoc, bbthread, { x: 600 - (BBTHREAD_DIVIDER_MARGIN - 1), y: 300 }),
  true,
  'the workspace-side half of the divider margin still hits the shape',
)

console.log('ok: frame-hit-test')
