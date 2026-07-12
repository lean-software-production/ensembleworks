// Run: bun src/snapping.test.ts
import assert from 'node:assert/strict'
import { makeDocument, type CanvasDocument } from './document.js'
import { localBounds, medianSize, worldTransform } from './geometry.js'
import { buildSpatialIndex } from './spatial-index.js'
import { snapCandidates, resolveArrowAnchor, anchorToWorld } from './snapping.js'

const base = () => ({ index: 'a1', isLocked: false, opacity: 1, meta: {} })
const geo = (id: string, parentId: string, x: number, y: number, rotation: number, w: number, h: number) =>
  ({ id, kind: 'geo', parentId, x, y, rotation, props: { w, h }, ...base() }) as any

// Two 100x100 shapes: medianSize is 100, so the snap threshold (documented
// as medianSize * 0.05) is 5 units.
function twoBoxDoc(gap: number): CanvasDocument {
  return makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [
      geo('shape:anchor', 'page:p', 0, 0, 0, 100, 100),        // static, bounds [0,100]x[0,100]
      geo('shape:moving', 'page:p', 100 + gap, 0, 0, 100, 100), // the one being dragged
    ],
    bindings: [],
  })
}

// ---- edge/edge alignment within threshold snaps ----
{
  const doc = twoBoxDoc(3) // gap 3 <= threshold 5: right edge of anchor (x=100) vs left edge of moving candidate bounds (x=103)
  const index = buildSpatialIndex(doc)
  assert.equal(medianSize(doc.shapes), 100, 'precondition: median size is 100 (threshold = 5)')
  // Candidate bounds: where 'shape:moving' currently sits (as if mid-drag).
  const bounds = { minX: 103, minY: 0, maxX: 203, maxY: 100 }
  const result = snapCandidates(index, doc, ['shape:moving'], bounds)
  assert.equal(result.dx, -3, 'snaps left edge (103) onto the anchor right edge (100): delta -3')
  assert.equal(result.dy, 0, 'no y alignment found (both at y=0, already aligned, so dy is 0 not "no snap")')
  assert.ok(result.guides.some((g) => g.axis === 'x' && g.at === 100 && g.kind === 'edge'), 'an edge guide line at x=100')
}

// ---- outside threshold: no snap ----
{
  const doc = twoBoxDoc(20) // gap 20 > threshold 5
  const index = buildSpatialIndex(doc)
  // Shifted off the y-axis too (both boxes at y=0 would incidentally
  // top-edge-align, muddying this specifically-about-x-threshold case).
  const bounds = { minX: 120, minY: 500, maxX: 220, maxY: 600 }
  const result = snapCandidates(index, doc, ['shape:moving'], bounds)
  assert.equal(result.dx, 0, 'no x snap: gap exceeds threshold')
  assert.equal(result.dy, 0, 'no y snap either: nothing aligned there')
  assert.deepEqual(result.guides, [], 'no guides when nothing is within threshold')
}

// ---- center/center alignment ----
// Deliberately DIFFERENT widths (100 vs 40): if both boxes were the same
// size, a pure translation aligns edges AND centers simultaneously (same
// delta on all three x-features), which can't distinguish "picked the
// center match" from "picked an edge match that happens to tie". Different
// widths make only the centers land within threshold; the edges (0/100 vs
// 33/73) are 27-73 units apart -- nowhere close.
{
  // anchor centered at (50,200); moving candidate bounds centered at (53,400): 3 units off on x, far off on y.
  const doc = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [
      geo('shape:anchor', 'page:p', 0, 150, 0, 100, 100),  // bounds [0,100]x[150,250], center (50, 200)
      geo('shape:moving', 'page:p', 33, 380, 0, 40, 40),   // bounds [33,73]x[380,420], center (53, 400)
    ],
    bindings: [],
  })
  const index = buildSpatialIndex(doc)
  const bounds = { minX: 33, minY: 380, maxX: 73, maxY: 420 } // center (53, 400)
  const result = snapCandidates(index, doc, ['shape:moving'], bounds)
  assert.equal(result.dx, -3, 'center-x (53) snaps onto the anchor center-x (50): delta -3')
  assert.ok(result.guides.some((g) => g.axis === 'x' && g.at === 50 && g.kind === 'center'), 'a center guide line at x=50')
}

// ---- moving-set exclusion, including descendants ----
{
  // A frame (the thing being dragged) with a child that moves WITH it. The
  // child sits exactly edge-aligned with a THIRD shape -- but since the
  // child is a descendant of the moving frame, it must NOT be offered as a
  // snap target (it's moving too, just not explicitly listed in movingIds).
  const doc = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [
      geo('shape:frame', 'page:p', 0, 0, 0, 100, 100),
      geo('shape:child', 'shape:frame', 10, 10, 0, 20, 20),      // local (10,10) -> world [10,30]x[10,30]
      geo('shape:decoy', 'page:p', 10, 400, 0, 20, 20),          // world [10,30]x[400,420] -- x-edge-aligned with shape:child (both minX=10)
    ],
    bindings: [],
  })
  const index = buildSpatialIndex(doc)
  // Drag the frame (and its child along with it) to some new position;
  // candidate bounds for the FRAME only (the child moves along, out of scope
  // for this call's target search).
  const bounds = { minX: 500, minY: 500, maxX: 600, maxY: 600 }
  const result = snapCandidates(index, doc, ['shape:frame'], bounds)
  // Nothing here should align with shape:decoy at these coordinates -- this
  // just proves the call doesn't crash and returns "no snap" when nothing is
  // remotely close, establishing the baseline before the exclusion-specific
  // check below.
  assert.equal(result.dx, 0)
  assert.equal(result.dy, 0)

  // Now the REAL exclusion check: move the frame (and child) so the CHILD's
  // (excluded) position would have edge-aligned with shape:decoy, and verify
  // that alignment is never offered because shape:child is excluded (it's a
  // descendant of the moving frame, not an independent target).
  const bounds2 = { minX: 8, minY: 800, maxX: 108, maxY: 900 } // deliberately near shape:decoy's x (10) but not shape:frame's own x
  const excludedResult = snapCandidates(index, doc, ['shape:frame'], bounds2)
  assert.ok(
    !excludedResult.guides.some((g) => g.axis === 'x' && g.at === 10),
    'shape:child (a descendant of the moving frame) must never be offered as a snap target',
  )
}

// ---- resolveArrowAnchor / anchorToWorld round-trip on a rotated, parented target ----
{
  const doc = makeDocument({
    pages: [{ id: 'page:p', name: 'P' }],
    shapes: [
      geo('shape:parent', 'page:p', 50, 50, Math.PI / 6, 300, 300),
      geo('shape:target', 'shape:parent', 20, 30, Math.PI / 5, 80, 40), // rotated AND parented
    ],
    bindings: [],
  })
  const target = doc.byId.get('shape:target')!

  // Independent oracle for the expected world point at a KNOWN anchor:
  // duplicate trig (see hit-test.test.ts's `rotate`) applied to the
  // PUBLIC worldTransform/localBounds — NOT anchorToWorld itself — so this
  // exercises both anchorToWorld and resolveArrowAnchor against a ground
  // truth neither of them produced.
  const knownAnchor = { nx: 0.3, ny: 0.7 }
  const t = worldTransform(doc, target)
  const lb = localBounds(target)
  const localX = lb.minX + knownAnchor.nx * (lb.maxX - lb.minX)
  const localY = lb.minY + knownAnchor.ny * (lb.maxY - lb.minY)
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation)
  const expectedWorldPoint = { x: localX * cos - localY * sin + t.x, y: localX * sin + localY * cos + t.y }

  const EPS = 1e-9
  const worldPoint = anchorToWorld(doc, 'shape:target', knownAnchor)
  assert.ok(Math.abs(worldPoint.x - expectedWorldPoint.x) < EPS, 'anchorToWorld matches the independently-derived world x')
  assert.ok(Math.abs(worldPoint.y - expectedWorldPoint.y) < EPS, 'anchorToWorld matches the independently-derived world y')

  const resolved = resolveArrowAnchor(doc, 'shape:target', expectedWorldPoint)
  assert.ok(Math.abs(resolved.nx - knownAnchor.nx) < EPS, `nx round-trips: expected ${knownAnchor.nx}, got ${resolved.nx}`)
  assert.ok(Math.abs(resolved.ny - knownAnchor.ny) < EPS, `ny round-trips: expected ${knownAnchor.ny}, got ${resolved.ny}`)
  const roundTripped = anchorToWorld(doc, 'shape:target', resolved)
  assert.ok(Math.abs(roundTripped.x - expectedWorldPoint.x) < EPS, 'world x round-trips')
  assert.ok(Math.abs(roundTripped.y - expectedWorldPoint.y) < EPS, 'world y round-trips')

  // Clamping: a point far outside the target's box resolves to a clamped
  // (0..1) anchor, never negative / never >1.
  const farAway = { x: 100000, y: 100000 }
  const clamped = resolveArrowAnchor(doc, 'shape:target', farAway)
  assert.ok(clamped.nx >= 0 && clamped.nx <= 1 && clamped.ny >= 0 && clamped.ny <= 1, 'anchor is always clamped to 0..1')
}

console.log('ok: snapping')
