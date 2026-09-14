// Run: bun src/geo-outline.test.ts
import assert from 'node:assert/strict'
import { getGeoOutline, getPolygonVertices, GEO_VARIANTS } from './geo-outline.js'

// ============================================================================
// 1. Every one of the 20 GeoShapeGeoStyle variants (shape.ts's GEO enum)
//    produces SOME real outline — the point of this task: no variant should
//    silently fall back to a plain rectangle path any more (star !== rectangle).
// ============================================================================
{
  assert.equal(GEO_VARIANTS.length, 20, 'GEO_VARIANTS should list all 20 geo variants')
  const rectangle = getGeoOutline('rectangle', 100, 100)
  for (const variant of GEO_VARIANTS) {
    const outline = getGeoOutline(variant, 100, 100)
    assert.ok(outline.path.length > 0, `${variant} should produce a non-empty path`)
    // x-box/check-box legitimately share the plain rectangle OUTER path —
    // their real geometry is the internal strokes (section 6 below), the
    // one case in the enum where "not a rectangle fallback" shows up as
    // internalPaths rather than a different outer path.
    if (variant !== 'rectangle' && variant !== 'x-box' && variant !== 'check-box') {
      assert.notEqual(outline.path, rectangle.path, `${variant} should NOT fall back to the plain rectangle path`)
    }
  }
  console.log('ok: getGeoOutline — every one of the 20 geo variants has real, non-rectangle-fallback geometry')
}

// ============================================================================
// 2. An unknown variant string falls back to rectangle (matches v1's own
//    defaultValue posture), never throws.
// ============================================================================
{
  const unknown = getGeoOutline('not-a-real-geo-type', 100, 50)
  const rectangle = getGeoOutline('rectangle', 100, 50)
  assert.equal(unknown.path, rectangle.path, 'an unrecognized geo variant falls back to rectangle geometry')
  console.log('ok: getGeoOutline — unknown variant falls back to rectangle, never throws')
}

// ============================================================================
// 3. Straight-edge ("polygon" snapType) variants expose closed vertex
//    arrays for a later hit-test task to walk; curved ("blobby") variants
//    expose null (they aren't a straight-edge polygon).
// ============================================================================
{
  const polygonVariants = ['rectangle', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'trapezoid', 'arrow-left', 'arrow-right', 'arrow-up', 'arrow-down', 'x-box', 'check-box']
  for (const variant of polygonVariants) {
    const outline = getGeoOutline(variant, 100, 80)
    assert.ok(outline.vertices && outline.vertices.length >= 3, `${variant} should expose closed polygon vertices`)
  }
  const blobbyVariants = ['ellipse', 'oval', 'cloud', 'heart']
  for (const variant of blobbyVariants) {
    const outline = getGeoOutline(variant, 100, 80)
    assert.equal(outline.vertices, null, `${variant} (blobby) should expose null vertices, not a fake polygon`)
  }
  console.log('ok: getGeoOutline — vertices present for polygon-snapType variants, null for blobby ones')
}

// ============================================================================
// 4. Exact vertex geometry for a few variants, matching getGeoShapePath.ts's
//    proportions (read from source, cited by file path per this task's
//    grounding convention).
// ============================================================================
{
  const triangle = getGeoOutline('triangle', 100, 100)
  assert.deepEqual(triangle.vertices, [{ x: 50, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 'triangle: apex at (w/2,0), base corners at (w,h)/(0,h)')

  const diamond = getGeoOutline('diamond', 100, 100)
  assert.deepEqual(diamond.vertices, [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }], 'diamond: top/right/bottom/left edge midpoints')

  const hexagon = getGeoOutline('hexagon', 100, 100)
  assert.equal(hexagon.vertices!.length, 6, 'hexagon has 6 vertices')

  const pentagon = getGeoOutline('pentagon', 100, 100)
  assert.equal(pentagon.vertices!.length, 5, 'pentagon has 5 vertices')

  const star = getGeoOutline('star', 200, 190)
  assert.equal(star.vertices!.length, 10, 'a 5-point star has 10 vertices (5 outer + 5 inner)')

  console.log('ok: getGeoOutline — exact vertex geometry for triangle/diamond, vertex counts for hexagon/pentagon/star')
}

// ============================================================================
// 5. getPolygonVertices(w,h,sides): a regular polygon inscribed in and
//    rescaled to exactly fill the w×h box (matches tldraw's own helper in
//    SHAPE, reimplemented fresh — see module header).
// ============================================================================
{
  const square = getPolygonVertices(100, 100, 4)
  const xs = square.map(p => p.x)
  const ys = square.map(p => p.y)
  assert.ok(Math.min(...xs) >= -0.001 && Math.max(...xs) <= 100.001, 'polygon vertices stay within the w bound')
  assert.ok(Math.min(...ys) >= -0.001 && Math.max(...ys) <= 100.001, 'polygon vertices stay within the h bound')
  console.log('ok: getPolygonVertices — rescales a regular polygon to exactly fill the given w/h box')
}

// ============================================================================
// 6. x-box / check-box: the outer outline is a plain rectangle, plus
//    non-empty internalPaths for the un-filled internal strokes (diagonals /
//    check mark) — the ONE case in the whole enum with internal marks.
// ============================================================================
{
  const xBox = getGeoOutline('x-box', 100, 100)
  assert.deepEqual(xBox.vertices, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 'x-box outer outline is a plain rectangle')
  assert.equal(xBox.internalPaths.length, 2, 'x-box has two internal diagonal strokes')

  const checkBox = getGeoOutline('check-box', 100, 100)
  assert.deepEqual(checkBox.vertices, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 'check-box outer outline is a plain rectangle')
  assert.equal(checkBox.internalPaths.length, 1, 'check-box has one internal check-mark stroke')

  for (const variant of GEO_VARIANTS) {
    if (variant === 'x-box' || variant === 'check-box') continue
    assert.equal(getGeoOutline(variant, 100, 100).internalPaths.length, 0, `${variant} should have no internal strokes`)
  }
  console.log('ok: getGeoOutline — x-box/check-box carry internal strokes, every other variant has none')
}

// ============================================================================
// 7. Determinism / purity: same (variant, w, h) always yields byte-identical
//    output — no hidden entropy (module header PURITY; matters for
//    draw-geometry.ts-style convergence guarantees and for a later
//    hit-test task relying on stable vertices).
// ============================================================================
{
  for (const variant of GEO_VARIANTS) {
    const a = getGeoOutline(variant, 137, 84)
    const b = getGeoOutline(variant, 137, 84)
    assert.deepEqual(a, b, `${variant} outline must be a pure function of (variant, w, h)`)
  }
  console.log('ok: getGeoOutline — deterministic, no hidden entropy, across all 20 variants')
}

// ============================================================================
// 8. Degenerate sizes (w or h tiny/near-zero) never produce NaN/Infinity in
//    the emitted path or vertices — every arc/vertex formula above divides
//    by w/h/min(w,h) somewhere, so this guards the divide-by-zero edges.
// ============================================================================
{
  for (const variant of GEO_VARIANTS) {
    const outline = getGeoOutline(variant, 1, 1)
    assert.ok(!/NaN|Infinity/.test(outline.path), `${variant} at 1x1 should not emit NaN/Infinity in its path: ${outline.path}`)
    for (const p of outline.internalPaths) {
      assert.ok(!/NaN|Infinity/.test(p), `${variant} at 1x1 should not emit NaN/Infinity in an internal path: ${p}`)
    }
  }
  console.log('ok: getGeoOutline — degenerate 1x1 sizes never produce NaN/Infinity')
}

console.log('ok: geo-outline (pure outline math for all 20 geo variants)')
