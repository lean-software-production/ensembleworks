// Run: bun src/camera.test.ts
import assert from 'node:assert/strict'
import { screenToWorld } from './input.js'
import { applyWheel, zoomAboutPoint, MIN_ZOOM, MAX_ZOOM } from './camera.js'

const EPS = 1e-9
const closeEnough = (a: { x: number; y: number }, b: { x: number; y: number }, eps = EPS) =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

const NEUTRAL = { shift: false, alt: false, ctrl: false, meta: false }

// ============================================================================
// 1. zoomAboutPoint invariance: the world point under `screenPoint` is
//    unchanged by the zoom, across a spread of cameras/points/factors.
// ============================================================================
{
  const cases: Array<{ camera: { x: number; y: number; z: number }; point: { x: number; y: number }; factor: number }> = [
    { camera: { x: 0, y: 0, z: 1 }, point: { x: 0, y: 0 }, factor: 2 },
    { camera: { x: 10, y: -20, z: 1 }, point: { x: 100, y: 50 }, factor: 1.5 },
    { camera: { x: -5, y: 5, z: 2 }, point: { x: 300, y: 200 }, factor: 0.5 },
    { camera: { x: 0, y: 0, z: 0.25 }, point: { x: -40, y: 60 }, factor: 4 },
    { camera: { x: 123.456, y: -78.9, z: 3.3 }, point: { x: 17, y: 900 }, factor: 1 / 3 },
  ]
  for (const { camera, point, factor } of cases) {
    const before = screenToWorld(camera, point)
    const after = zoomAboutPoint(camera, point, factor)
    const afterWorld = screenToWorld(after, point)
    assert.ok(
      closeEnough(before, afterWorld, 1e-6),
      `zoomAboutPoint invariance failed for camera=${JSON.stringify(camera)} point=${JSON.stringify(point)} factor=${factor}: before=${JSON.stringify(before)} after=${JSON.stringify(afterWorld)}`,
    )
  }
  console.log('ok: zoomAboutPoint preserves the world point under screenPoint across cameras/points/factors')
}

// ============================================================================
// 2. One hand-computed zoomAboutPoint case, derived on paper (not by calling
//    the helper and comparing to itself).
// ============================================================================
{
  // camera (0,0,1), screenPoint (100,100), factor 2: newZ = 2.
  // newX = 0 + 100/2 - 100/1 = 50 - 100 = -50. Same for y.
  const result = zoomAboutPoint({ x: 0, y: 0, z: 1 }, { x: 100, y: 100 }, 2)
  assert.deepEqual(result, { x: -50, y: -50, z: 2 }, 'hand-computed zoomAboutPoint case')
  console.log('ok: zoomAboutPoint hand-computed case (camera (0,0,1), point (100,100), factor 2) => (-50,-50,2)')
}

// ============================================================================
// 3. z-clamp edges: a factor that would overshoot [MIN_ZOOM, MAX_ZOOM]
//    clamps z, and the invariance property STILL holds against the clamped z
//    (the xy correction is computed against whatever z the zoom actually
//    lands on).
// ============================================================================
{
  const camera = { x: 0, y: 0, z: 1 }
  const point = { x: 50, y: 50 }

  const zoomedOut = zoomAboutPoint(camera, point, 0.0001) // would drive z far below MIN_ZOOM
  assert.equal(zoomedOut.z, MIN_ZOOM, 'z clamps at MIN_ZOOM')
  assert.ok(closeEnough(screenToWorld(camera, point), screenToWorld(zoomedOut, point), 1e-6), 'invariance holds even when z is clamped (zoom out)')

  const zoomedIn = zoomAboutPoint(camera, point, 100000) // would drive z far above MAX_ZOOM
  assert.equal(zoomedIn.z, MAX_ZOOM, 'z clamps at MAX_ZOOM')
  assert.ok(closeEnough(screenToWorld(camera, point), screenToWorld(zoomedIn, point), 1e-6), 'invariance holds even when z is clamped (zoom in)')

  console.log('ok: zoomAboutPoint clamps z to [MIN_ZOOM, MAX_ZOOM] while preserving the point invariance')
}

// ============================================================================
// 4. applyWheel: plain wheel pans (dx/dy / z), ctrl-or-meta+wheel zooms about
//    the cursor instead.
// ============================================================================
{
  const camera = { x: 0, y: 0, z: 2 }
  const panned = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: 6, dy: 4, modifiers: NEUTRAL, t: 0 })
  assert.deepEqual(panned, { x: 3, y: 2, z: 2 }, 'plain wheel pans by dx/dy divided by z, z unchanged')

  const zoomedByCtrl = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: 0, dy: 50, modifiers: { ...NEUTRAL, ctrl: true }, t: 0 })
  assert.notEqual(zoomedByCtrl.z, camera.z, 'ctrl+wheel changes z instead of panning')
  assert.ok(zoomedByCtrl.z < camera.z, 'positive dy (scroll down/away) zooms OUT per our documented convention')
  assert.ok(closeEnough(screenToWorld(camera, { x: 10, y: 20 }), screenToWorld(zoomedByCtrl, { x: 10, y: 20 }), 1e-6), 'ctrl+wheel zoom is about the cursor point')

  const zoomedByMeta = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: 0, dy: -50, modifiers: { ...NEUTRAL, meta: true }, t: 0 })
  assert.ok(zoomedByMeta.z > camera.z, 'negative dy zooms IN, and meta triggers zoom exactly like ctrl')

  console.log('ok: applyWheel pans on a plain wheel, zooms-about-cursor on ctrl/meta+wheel')
}

// ============================================================================
// 5. applyWheel's zoom delta is clamped per tick (large |dy| doesn't blow
//    past the documented ZOOM_DELTA_CLAMP-derived factor).
// ============================================================================
{
  const camera = { x: 0, y: 0, z: 1 }
  const huge = applyWheel(camera, { type: 'wheel', x: 0, y: 0, dx: 0, dy: 100000, modifiers: { ...NEUTRAL, ctrl: true }, t: 0 })
  const modest = applyWheel(camera, { type: 'wheel', x: 0, y: 0, dx: 0, dy: 20, modifiers: { ...NEUTRAL, ctrl: true }, t: 0 })
  // Both a huge and a modest-but-over-10 |dy| clamp to the SAME per-tick
  // delta magnitude (0.1 of z) once |dy| > 10 -- proving the clamp actually
  // bounds it rather than scaling unboundedly.
  assert.ok(Math.abs(huge.z - camera.z) <= 0.1 * camera.z + EPS, 'a single wheel tick cannot move z by more than the documented clamp')
  assert.equal(huge.z, modest.z, 'dy magnitudes beyond the clamp threshold produce the identical clamped zoom step')
  console.log('ok: applyWheel clamps the per-tick zoom delta magnitude')
}

// ============================================================================
// 6. Poison guard: non-finite wheel deltas must be a NO-OP, never a
//    camera-corrupting write. Without the guard, a NaN dy on the zoom path
//    produces camera {NaN,NaN,NaN} with NO recovery (clampZoom propagates
//    NaN: Math.min/max with NaN is NaN, so every subsequent zoom stays NaN),
//    and an Infinity dx on the pan path shoots x to Infinity.
// ============================================================================
{
  const camera = { x: 1, y: 2, z: 2 }

  const nanZoom = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: 0, dy: NaN, modifiers: { ...NEUTRAL, ctrl: true }, t: 0 })
  assert.deepEqual(nanZoom, camera, 'NaN dy on the ctrl (zoom) path is a no-op — camera unchanged')

  const nanPan = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: 0, dy: NaN, modifiers: NEUTRAL, t: 0 })
  assert.deepEqual(nanPan, camera, 'NaN dy on the plain (pan) path is a no-op — camera unchanged')

  const infPan = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: Infinity, dy: 0, modifiers: NEUTRAL, t: 0 })
  assert.deepEqual(infPan, camera, 'Infinity dx on the pan path is a no-op — camera unchanged')

  const infZoom = applyWheel(camera, { type: 'wheel', x: 10, y: 20, dx: -Infinity, dy: 3, modifiers: { ...NEUTRAL, meta: true }, t: 0 })
  assert.deepEqual(infZoom, camera, 'non-finite dx makes the whole event a no-op even when dy alone looks usable — uniform guard')

  console.log('ok: applyWheel treats non-finite dx/dy as a no-op (camera can never be NaN/Infinity-poisoned)')
}

console.log('ok: camera math (zoomAboutPoint invariance, applyWheel pan/zoom, z-clamp, poison guard)')
