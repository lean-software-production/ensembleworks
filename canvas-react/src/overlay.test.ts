// Run: bun src/overlay.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header) with React.createElement, hence `.test.ts` not
// `.test.tsx` (see that same header for why). Covers D4 (Selection/Handles/
// SnapGuides) and D5 (Arrows) — both land in the same screen-space overlay
// SVG, so one file exercises the whole paint stack Overlay.tsx composes.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSpatialIndex, makeDocument, routeArrow, type Binding, type CanvasDocument, type Shape, type SnapResult } from '@ensembleworks/canvas-model'
import { selectionHandles, worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { arrowheadPoints, Arrows } from './overlay/Arrows.js'
import { combinedWorldBounds, Selection } from './overlay/Selection.js'
import { Handles } from './overlay/Handles.js'
import { SnapGuides } from './overlay/SnapGuides.js'

// Shared viewport for every Arrows test — Arrows needs one for culling (its
// viewportWorldBounds derives the world-space cull rect from camera + size).
const VP = { width: 800, height: 600 }

const geoShape = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): Shape =>
  ({
    id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation,
    isLocked: false, opacity: 1, meta: {}, props: { w, h },
  }) as Shape

const arrowShape = (id: string, x: number, y: number, props: Record<string, unknown> = {}): Shape =>
  ({
    id, kind: 'arrow', parentId: 'page:p', index: 'a1', x, y, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props,
  }) as Shape

const endBinding = (arrowId: string, targetId: string, nx: number, ny: number): Binding => ({
  id: `binding:${arrowId}-end` as any, fromId: arrowId as any, toId: targetId as any,
  props: { terminal: 'end', anchor: { nx, ny } }, meta: {},
})
const startBinding = (arrowId: string, targetId: string, nx: number, ny: number): Binding => ({
  id: `binding:${arrowId}-start` as any, fromId: arrowId as any, toId: targetId as any,
  props: { terminal: 'start', anchor: { nx, ny } }, meta: {},
})

function docOf(shapes: Shape[], bindings: Binding[] = []): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings })
}

// Direct arithmetic reimplementation of input.ts's NORMATIVE camera
// convention (screen = (world + camera.xy) * z) — used throughout so
// expectations are computed independently of `worldToScreen` itself, not
// merely re-invoking the function under test's own dependency.
function toScreen(camera: Camera, p: { x: number; y: number }): { x: number; y: number } {
  return { x: (p.x + camera.x) * camera.z, y: (p.y + camera.y) * camera.z }
}

// ============================================================================
// 1. Selection: a rotated shape's outline polygon — hand-rotated corners
//    (independent trig, NOT calling worldCorners), then converted to screen
//    via the direct arithmetic above.
// ============================================================================
{
  const theta = Math.PI / 6 // 30 degrees
  const shape = geoShape('shape:rot', 40, 20, 80, 40, theta)
  const camera: Camera = { x: 5, y: -10, z: 1.5 }
  const doc = docOf([shape])

  const cos = Math.cos(theta), sin = Math.sin(theta)
  // Local box corners (0,0),(w,0),(w,h),(0,h) — hand-rotated by theta then
  // translated by the shape's own x/y (an unparented root shape, so world ==
  // local-rotated-then-translated with NO parent composition involved).
  const rotate = (lx: number, ly: number) => ({ x: lx * cos - ly * sin + shape.x, y: lx * sin + ly * cos + shape.y })
  const handCorners = [rotate(0, 0), rotate(80, 0), rotate(80, 40), rotate(0, 40)]
  const expectedPoints = handCorners.map((c) => toScreen(camera, c)).map((p) => `${p.x},${p.y}`).join(' ')

  const html = renderToStaticMarkup(
    createElement(Selection, { snapshot: doc, selection: new Set(['shape:rot']), camera }),
  )
  assert.ok(html.includes(`points="${expectedPoints}"`), `rotated selection outline should be "${expectedPoints}": ${html}`)
  assert.doesNotMatch(html, /data-overlay="selection-bounds"/, 'a SINGLE selected shape renders no separate combined-bounds rect')
  console.log('ok: Selection — rotated shape outline matches independently hand-rotated corners')
}

// ============================================================================
// 2. Multi-select: combined AABB bounds rect, via combinedWorldBounds (shared
//    with Handles.tsx) — two axis-aligned shapes, union hand-computed.
// ============================================================================
{
  const a = geoShape('shape:a', 0, 0, 100, 50)
  const b = geoShape('shape:b', 200, 100, 50, 50)
  const doc = docOf([a, b])
  const camera: Camera = { x: 0, y: 0, z: 1 }

  const bounds = combinedWorldBounds(doc, ['shape:a', 'shape:b'])
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: 250, maxY: 150 }, 'hand-expected union of both AABBs')

  const html = renderToStaticMarkup(
    createElement(Selection, { snapshot: doc, selection: new Set(['shape:a', 'shape:b']), camera }),
  )
  assert.match(html, /data-overlay="selection-bounds"/, 'multi-select renders the combined bounds rect')
  assert.ok(html.includes('width="250"') && html.includes('height="150"'), `combined bounds rect should be 250x150: ${html}`)
  console.log('ok: Selection — multi-select combined AABB bounds rect')
}

// ============================================================================
// 3. Handles: screen positions cross-checked by COMPOSING the library
//    functions by hand (selectionHandles + worldToScreen), for a known
//    camera — one handle ('nw') spot-checked exactly.
// ============================================================================
{
  const bounds = { minX: 10, minY: 20, maxX: 110, maxY: 120 }
  const camera: Camera = { x: 3, y: 4, z: 2 }
  const handles = selectionHandles(bounds)
  const nw = handles.find((h) => h.id === 'nw')!
  const expectedNw = worldToScreen(camera, nw.point) // composed by hand from the two library primitives
  assert.deepEqual(expectedNw, { x: (10 + 3) * 2, y: (20 + 4) * 2 }, 'sanity: hand arithmetic agrees with worldToScreen')

  const html = renderToStaticMarkup(createElement(Handles, { bounds, camera }))
  const expectedX = expectedNw.x - 8 / 2 // HANDLE_SIZE_PX = 8, rect is centered on the point
  const expectedY = expectedNw.y - 8 / 2
  assert.ok(
    html.includes(`data-handle-id="nw"`) && html.includes(`x="${expectedX}"`) && html.includes(`y="${expectedY}"`),
    `nw handle rect should be positioned at (${expectedX},${expectedY}): ${html}`,
  )
  // All 9 handles present.
  for (const h of handles) assert.match(html, new RegExp(`data-handle-id="${h.id}"`), `handle ${h.id} should render`)
  console.log('ok: Handles — nw handle screen position cross-checked against selectionHandles + worldToScreen composed by hand')
}

// ============================================================================
// 4. Zoom independence: the SAME bounds under z=1 and z=4 render handle
//    rects of the IDENTICAL pixel size (8x8) — only the CENTER moves, per
//    worldToScreen, never the glyph's own dimensions.
// ============================================================================
{
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const htmlZ1 = renderToStaticMarkup(createElement(Handles, { bounds, camera: { x: 0, y: 0, z: 1 } }))
  const htmlZ4 = renderToStaticMarkup(createElement(Handles, { bounds, camera: { x: 0, y: 0, z: 4 } }))
  const sizeRe = /data-handle-id="nw"[^>]*width="(-?[\d.]+)"[^>]*height="(-?[\d.]+)"/
  const m1 = htmlZ1.match(sizeRe)
  const m4 = htmlZ4.match(sizeRe)
  assert.ok(m1 && m4, `both renders should expose the nw handle's rect width/height: z1=${htmlZ1} z4=${htmlZ4}`)
  assert.equal(m1![1], '8', 'z=1: handle width is the fixed 8px constant')
  assert.equal(m4![1], '8', 'z=4: handle width is STILL the fixed 8px constant — zoom-independent')
  assert.equal(m1![1], m4![1])
  assert.equal(m1![2], m4![2])
  console.log('ok: Handles — zoom-independent screen size (8px at both z=1 and z=4)')
}

// ============================================================================
// 5. SnapGuides: exact line coordinates for one x-axis and one y-axis guide,
//    hand-computed against a known camera + viewport.
// ============================================================================
{
  const camera: Camera = { x: 10, y: -20, z: 2 }
  const viewportSize = { width: 800, height: 600 }
  const snapResult: SnapResult = {
    dx: 0, dy: 0,
    guides: [{ axis: 'x', at: 50, kind: 'edge' }, { axis: 'y', at: 30, kind: 'center' }],
  }
  const html = renderToStaticMarkup(createElement(SnapGuides, { snapResult, camera, viewportSize }))

  const screenX = toScreen(camera, { x: 50, y: 0 }).x
  const screenY = toScreen(camera, { x: 0, y: 30 }).y
  assert.ok(
    html.includes(`data-snap-axis="x"`) && html.includes(`x1="${screenX}"`) && html.includes(`y1="0"`) && html.includes(`y2="${viewportSize.height}"`),
    `x-axis guide should be a full-height vertical line at screen-x=${screenX}: ${html}`,
  )
  assert.ok(
    html.includes(`data-snap-axis="y"`) && html.includes(`y1="${screenY}"`) && html.includes(`x1="0"`) && html.includes(`x2="${viewportSize.width}"`),
    `y-axis guide should be a full-width horizontal line at screen-y=${screenY}: ${html}`,
  )
  console.log('ok: SnapGuides — exact hand-computed line coordinates, full-viewport-length')
}

// ============================================================================
// 6. Empty selection / no snap result: nothing renders.
// ============================================================================
{
  const doc = docOf([geoShape('shape:a', 0, 0)])
  const camera: Camera = { x: 0, y: 0, z: 1 }
  const selHtml = renderToStaticMarkup(createElement(Selection, { snapshot: doc, selection: new Set<string>(), camera }))
  assert.equal(selHtml, '', 'empty selection renders nothing from Selection')
  const handlesHtml = renderToStaticMarkup(createElement(Handles, { bounds: null, camera }))
  assert.equal(handlesHtml, '', 'null bounds (empty/vanished selection) renders nothing from Handles')
  const guidesHtml = renderToStaticMarkup(createElement(SnapGuides, { camera, viewportSize: { width: 100, height: 100 } }))
  assert.equal(guidesHtml, '', 'no snapResult renders nothing from SnapGuides')
  console.log('ok: empty selection / absent snap result render nothing')
}

// ============================================================================
// 7. Arrows: unbound straight arrow — hand-computed screen path string.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 } })
  const doc = docOf([arrow])
  const camera: Camera = { x: 10, y: -5, z: 2 }
  const startScreen = toScreen(camera, { x: 0, y: 0 })
  const endScreen = toScreen(camera, { x: 100, y: 0 })
  const expectedD = `M ${startScreen.x} ${startScreen.y} L ${endScreen.x} ${endScreen.y}`

  const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
  assert.ok(html.includes(`d="${expectedD}"`), `straight arrow path should be "${expectedD}": ${html}`)
  console.log('ok: Arrows — straight path, hand-computed screen coordinates')
}

// ============================================================================
// 8. Arrows: curved (bend != 0) — hand-computed control point (chord midpoint
//    + bend along the chord's perpendicular, same convention arrow-route.
//    test.ts pins) THEN converted to screen, composing a Q path.
// ============================================================================
{
  const arrow = arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 }, bend: 10 })
  const doc = docOf([arrow])
  const camera: Camera = { x: 10, y: -5, z: 2 }
  // Hand-derived per arrow-route.ts's curveMid: horizontal chord (0,0)->
  // (100,0), unit dir (1,0), perpendicular (0,1) -> mid = (50,0) + 10*(0,1) = (50,10).
  const expectedMidWorld = { x: 50, y: 10 }
  const startScreen = toScreen(camera, { x: 0, y: 0 })
  const endScreen = toScreen(camera, { x: 100, y: 0 })
  const midScreen = toScreen(camera, expectedMidWorld)
  const expectedD = `M ${startScreen.x} ${startScreen.y} Q ${midScreen.x} ${midScreen.y} ${endScreen.x} ${endScreen.y}`

  const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
  assert.ok(html.includes(`d="${expectedD}"`), `curved arrow path should be "${expectedD}": ${html}`)
  console.log('ok: Arrows — curved path, hand-computed control point')
}

// ============================================================================
// 9. Arrowhead tangent orientation: STRAIGHT arrow orients along
//    (end - start); CURVED arrow orients along (end - mid), NOT (end -
//    start) — both hand-computed via direct trig (not by calling
//    arrowheadPoints), then cross-checked against arrowheadPoints itself.
// ============================================================================
{
  const camera: Camera = { x: 10, y: -5, z: 2 }

  function handArrowhead(tail: { x: number; y: number }, tip: { x: number; y: number }) {
    const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x)
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const back = { x: tip.x - 10 * cos, y: tip.y - 10 * sin }
    const left = { x: back.x + 4 * -sin, y: back.y + 4 * cos }
    const right = { x: back.x - 4 * -sin, y: back.y - 4 * cos }
    return [tip, left, right] as const
  }

  // Straight: tail = start, tip = end.
  {
    const startScreen = toScreen(camera, { x: 0, y: 0 })
    const endScreen = toScreen(camera, { x: 100, y: 0 })
    const expected = handArrowhead(startScreen, endScreen)
    const viaLibrary = arrowheadPoints(startScreen, endScreen)
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(expected[i]!.x - viaLibrary[i]!.x) < 1e-9 && Math.abs(expected[i]!.y - viaLibrary[i]!.y) < 1e-9, `point ${i} should match`)
    }
    const doc = docOf([arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 } })])
    const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
    const pointsStr = expected.map((p) => `${p.x},${p.y}`).join(' ')
    assert.ok(html.includes(`data-overlay="arrowhead" points="${pointsStr}"`), `straight arrowhead should point along (end-start): ${html}`)
    console.log('ok: Arrows — straight arrowhead oriented along (end - start)')
  }

  // Curved: tail = mid (NOT start) — the whole point of this test.
  {
    const midScreen = toScreen(camera, { x: 50, y: 10 })
    const endScreen = toScreen(camera, { x: 100, y: 0 })
    const expected = handArrowhead(midScreen, endScreen)
    const viaLibrary = arrowheadPoints(midScreen, endScreen)
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(expected[i]!.x - viaLibrary[i]!.x) < 1e-9 && Math.abs(expected[i]!.y - viaLibrary[i]!.y) < 1e-9, `point ${i} should match`)
    }
    const doc = docOf([arrowShape('shape:arrow', 0, 0, { end: { x: 100, y: 0 }, bend: 10 })])
    const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
    const pointsStr = expected.map((p) => `${p.x},${p.y}`).join(' ')
    assert.ok(html.includes(`data-overlay="arrowhead" points="${pointsStr}"`), `curved arrowhead should point along (end-mid), NOT (end-start): ${html}`)
    console.log('ok: Arrows — curved arrowhead oriented along (end - mid), not (end - start)')
  }
}

// ============================================================================
// 10. A BOUND arrow re-routes when the snapshot moves the target: two
//     renders, the target translated between them, the rendered path's
//     start point moves accordingly — proving arrows read live snapshot
//     state each render rather than a cached bind-time position.
// ============================================================================
{
  const camera: Camera = { x: 0, y: 0, z: 1 } // identity — screen == world, isolates the assertion to routing, not projection
  const arrow = arrowShape('shape:arrow', 50, 50, { end: { x: 500, y: 0 } })
  const bindings = [startBinding('shape:arrow', 'shape:a', 0.5, 0.5)]

  const a0 = geoShape('shape:a', 0, 0, 100, 100)
  const before = docOf([a0, arrow], bindings)
  const htmlBefore = renderToStaticMarkup(createElement(Arrows, { snapshot: before, camera, viewportSize: VP, index: buildSpatialIndex(before) }))
  assert.ok(htmlBefore.includes('d="M 100 50'), `before the move, bound start should clip to A's original right edge (100,50): ${htmlBefore}`)

  const a1 = geoShape('shape:a', 200, 0, 100, 100) // translated +200 on x
  const after = docOf([a1, arrow], bindings)
  const htmlAfter = renderToStaticMarkup(createElement(Arrows, { snapshot: after, camera, viewportSize: VP, index: buildSpatialIndex(after) }))
  assert.ok(htmlAfter.includes('d="M 300 50'), `after the move, bound start should clip to A's NEW right edge (300,50): ${htmlAfter}`)
  assert.notEqual(htmlBefore, htmlAfter, 'the two renders must actually differ')
  console.log('ok: Arrows — a bound arrow re-routes against the live snapshot when its target moves')
}

// ============================================================================
// 11. Arrow CULLING: with the camera parked over one small region, only the
//     near arrow renders — five arrows living ~10k world units away are
//     culled (their own shape bbox is off-viewport, they have no bindings,
//     and their approximate segment bbox doesn't touch the viewport either).
//     RED-FIRST: written against the pre-culling Arrows (which routed and
//     rendered every arrow in the doc unconditionally) — all five far ids
//     appeared in the output and this block failed.
// ============================================================================
{
  const camera: Camera = { x: 0, y: 0, z: 1 } // viewport = world [0,800]x[0,600]
  const near = arrowShape('shape:near', 100, 100, { end: { x: 100, y: 0 } })
  const fars = [0, 1, 2, 3, 4].map((i) => arrowShape(`shape:far${i}`, 10_000 + i * 1_000, 10_000, { end: { x: 100, y: 0 } }))
  const doc = docOf([near, ...fars])

  const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
  assert.ok(html.includes('data-shape-id="shape:near"'), `the near arrow must render: ${html}`)
  for (let i = 0; i < 5; i++) {
    assert.ok(!html.includes(`data-shape-id="shape:far${i}"`), `far arrow shape:far${i} must be culled: ${html}`)
  }
  console.log('ok: Arrows — culling: only the near arrow renders, five ~10k-units-away arrows culled')
}

// ============================================================================
// 12. Culling MUST NOT drop a spanning arrow (the over-inclusion bound's
//     non-negotiable half): both endpoints off-viewport — start at world
//     (-1000, 300), end at (2000, 300) — but the segment crosses the whole
//     viewport horizontally. The arrow's own shape bbox sits off-screen at
//     x=-1000 and there are no bindings, so only the approximate-segment-
//     bbox check (cull path (c)) can save it. ALSO: a bound arrow whose own
//     stored position is far away but whose TARGET is on-screen must render
//     (cull path (b)/(c) via the target).
// ============================================================================
{
  const camera: Camera = { x: 0, y: 0, z: 1 }
  const spanning = arrowShape('shape:span', -1000, 300, { end: { x: 3000, y: 0 } }) // world end = (2000, 300)
  const target = geoShape('shape:target', 300, 200, 100, 100) // on-screen
  const boundFarArrow = arrowShape('shape:boundfar', 5000, 5000) // own bbox far off-screen
  const bindings = [endBinding('shape:boundfar', 'shape:target', 0.5, 0.5)]
  const doc = docOf([spanning, target, boundFarArrow], bindings)

  const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc) }))
  assert.ok(html.includes('data-shape-id="shape:span"'), `the spanning arrow (both endpoints off-viewport, segment crosses it) MUST render: ${html}`)
  assert.ok(html.includes('data-shape-id="shape:boundfar"'), `the far-away arrow bound to an ON-SCREEN target MUST render: ${html}`)
  console.log('ok: Arrows — spanning arrow and far-arrow-with-visible-target both survive culling')
}

// ============================================================================
// 13. Culling actually SKIPS the routing work (the perf point, pinned via
//     the injectable routeFn test seam): near + spanning + 5 far arrows —
//     routeFn is called EXACTLY twice (the two renderable arrows), never
//     for the culled five. RED-FIRST: the pre-culling Arrows had no routeFn
//     seam and routed all 7 unconditionally — this block failed with
//     calls=0 (prop ignored).
// ============================================================================
{
  const camera: Camera = { x: 0, y: 0, z: 1 }
  const near = arrowShape('shape:near', 100, 100, { end: { x: 100, y: 0 } })
  const spanning = arrowShape('shape:span', -1000, 300, { end: { x: 3000, y: 0 } })
  const fars = [0, 1, 2, 3, 4].map((i) => arrowShape(`shape:far${i}`, 10_000 + i * 1_000, 10_000, { end: { x: 100, y: 0 } }))
  const doc = docOf([near, spanning, ...fars])

  const routed: string[] = []
  const countingRoute: typeof routeArrow = (snapshot, arrow, bindings) => {
    routed.push(arrow.id)
    return routeArrow(snapshot, arrow, bindings)
  }
  const html = renderToStaticMarkup(createElement(Arrows, { snapshot: doc, camera, viewportSize: VP, index: buildSpatialIndex(doc), routeFn: countingRoute }))
  assert.ok(html.includes('data-shape-id="shape:near"') && html.includes('data-shape-id="shape:span"'), `both renderable arrows present: ${html}`)
  assert.deepEqual(routed.sort(), ['shape:near', 'shape:span'], `routeFn must be called EXACTLY for the two renderable arrows, never the culled five — got [${routed.join(', ')}]`)
  console.log('ok: Arrows — routing cost bounded by visible+spanning (routeFn called 2x for 7 arrows)')
}

console.log('ok: overlay (selection outlines, combined bounds, handles, zoom-independence, snap guides, arrow rendering + tangent orientation + live re-routing + viewport culling)')
