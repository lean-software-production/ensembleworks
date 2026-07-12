// Run: bun src/overlay.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header) with React.createElement, hence `.test.ts` not
// `.test.tsx` (see that same header for why). Covers D4: Selection outlines
// (incl. multi-select combined bounds), Handles, and SnapGuides — the three
// pieces Overlay.tsx composes into one screen-space SVG. D5 (Arrows) extends
// this same file.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeDocument, type CanvasDocument, type Shape, type SnapResult } from '@ensembleworks/canvas-model'
import { selectionHandles, worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { combinedWorldBounds, Selection } from './overlay/Selection.js'
import { Handles } from './overlay/Handles.js'
import { SnapGuides } from './overlay/SnapGuides.js'

const geoShape = (id: string, x: number, y: number, w = 100, h = 100, rotation = 0): Shape =>
  ({
    id, kind: 'geo', parentId: 'page:p', index: 'a1', x, y, rotation,
    isLocked: false, opacity: 1, meta: {}, props: { w, h },
  }) as Shape

function docOf(shapes: Shape[]): CanvasDocument {
  return makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes, bindings: [] })
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

console.log('ok: overlay (selection outlines, combined bounds, handles, zoom-independence, snap guides)')
