// Run: bun src/zoom-controls-model.test.ts
import assert from 'node:assert/strict'
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP_FACTOR } from '@ensembleworks/canvas-editor'
import { viewportCentre, zoomControlDisabled, zoomControlIntent } from './zoom-controls-model.js'

const VIEWPORT = { width: 800, height: 600 }
const CENTRE = { x: 400, y: 300 }

// ============================================================================
// viewportCentre
// ============================================================================
assert.deepEqual(viewportCentre(VIEWPORT), CENTRE, 'centre is half the viewport size')
console.log('ok: viewportCentre halves width/height')

// ============================================================================
// zoomControlIntent: 'in'/'out' step by ZOOM_STEP_FACTOR about the viewport
// centre; 'reset' sets the ABSOLUTE level to 1, not a relative step.
// ============================================================================
{
  const camera = { x: 0, y: 0, z: 1 }

  const zoomedIn = zoomControlIntent(camera, VIEWPORT, 'in')
  assert.equal(zoomedIn.z, ZOOM_STEP_FACTOR, "'in' multiplies z by ZOOM_STEP_FACTOR")

  const zoomedOut = zoomControlIntent(camera, VIEWPORT, 'out')
  assert.equal(zoomedOut.z, 1 / ZOOM_STEP_FACTOR, "'out' divides z by ZOOM_STEP_FACTOR")

  // Both preserve the viewport-centre screen point in world space (the
  // camera math itself is camera.ts's job — this only checks the right
  // point/factor were threaded through).
  const worldCentreBefore = { x: CENTRE.x / camera.z - camera.x, y: CENTRE.y / camera.z - camera.y }
  const worldCentreAfterIn = { x: CENTRE.x / zoomedIn.z - zoomedIn.x, y: CENTRE.y / zoomedIn.z - zoomedIn.y }
  assert.ok(Math.abs(worldCentreBefore.x - worldCentreAfterIn.x) < 1e-9, "'in' keeps the viewport centre fixed in world space")
  assert.ok(Math.abs(worldCentreBefore.y - worldCentreAfterIn.y) < 1e-9, "'in' keeps the viewport centre fixed in world space (y)")

  console.log('ok: zoomControlIntent in/out step by ZOOM_STEP_FACTOR about the viewport centre')
}

{
  // 'reset' from a zoomed-in camera lands EXACTLY on z=1, not on
  // camera.z / ZOOM_STEP_FACTOR or any other relative step — the failure a
  // relative implementation would produce for a camera not already sitting
  // on a whole power of ZOOM_STEP_FACTOR.
  const camera = { x: 12, y: -7, z: 3.7 }
  const reset = zoomControlIntent(camera, VIEWPORT, 'reset')
  assert.ok(Math.abs(reset.z - 1) < 1e-9, "'reset' sets the ABSOLUTE zoom level to 1, regardless of the current z")
  console.log("ok: zoomControlIntent 'reset' is absolute, not relative to the current zoom")
}

// ============================================================================
// zoomControlDisabled: true only exactly at (or past) MIN_ZOOM/MAX_ZOOM.
// ============================================================================
{
  assert.deepEqual(zoomControlDisabled({ x: 0, y: 0, z: 1 }), { in: false, out: false }, 'neither button is disabled at z=1')
  assert.deepEqual(zoomControlDisabled({ x: 0, y: 0, z: MIN_ZOOM }), { in: false, out: true }, "'out' is disabled at MIN_ZOOM")
  assert.deepEqual(zoomControlDisabled({ x: 0, y: 0, z: MAX_ZOOM }), { in: true, out: false }, "'in' is disabled at MAX_ZOOM")
  console.log('ok: zoomControlDisabled disables out/in exactly at MIN_ZOOM/MAX_ZOOM')
}

console.log('ok: zoom-controls-model (viewportCentre, zoomControlIntent in/out/reset, zoomControlDisabled)')
