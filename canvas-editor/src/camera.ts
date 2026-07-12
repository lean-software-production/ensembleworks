// Camera math shared by the hand tool (this seam, C5) and D2's renderer
// (which wires wheel events globally, outside any particular tool) — kept as
// PURE functions of (Camera, ...) rather than tool-local methods, exactly
// because two different callers need the identical formula: a
// sign/order disagreement between the renderer's wheel handling and a tool's
// own would make one interpret a scroll gesture differently than the other.
// Both functions derive from input.ts's NORMATIVE camera convention:
//   screen = (world + camera.xy) * camera.z
//   world  = screen / camera.z − camera.xy
import type { Camera, WheelInputEvent } from './input.js'

/** tldraw's own zoom range, read from source rather than assumed: installed
 * `tldraw` package, node_modules/tldraw/src/lib/tools/… no — actually
 * constants.ts: `DEFAULT_CAMERA_OPTIONS.zoomSteps: [0.05, 0.1, 0.25, 0.5, 1,
 * 2, 4, 8]` (node_modules/tldraw/src/lib/constants.ts). We don't replicate
 * tldraw's discrete step-array zoom-button behavior (zoomIn/zoomOut jumping
 * between named steps) — only the min/max of that array, as a continuous
 * clamp range for wheel/pinch zoom, which is all this seam needs. */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

/**
 * Zoom `camera` by `factor` (multiplicative — 1.2 zooms in 20%, 1/1.2 zooms
 * out) about `screenPoint`, such that the WORLD point currently under
 * screenPoint is still under it after the zoom (screenToWorld(before,
 * screenPoint) === screenToWorld(after, screenPoint)).
 *
 * DERIVATION (from the NORMATIVE convention: world = screen/z − camera.xy):
 * holding worldPt = screenPoint/z − camera.xy fixed while z changes to newZ
 * requires newCamera.xy = camera.xy + screenPoint/newZ − screenPoint/z. This
 * is the exact invariant tldraw's own wheel-zoom handler computes (installed
 * `tldraw` package, node_modules/tldraw/src/lib/editor/Editor.ts — the
 * `case 'wheel'` handler's 'zoom' branch: `this._setCamera(new Vec(cx + x/zoom
 * - x/cz, cy + y/zoom - y/cz, zoom), ...)`, same shape once tldraw's own
 * screenBounds offset — irrelevant here, our screen space is already
 * viewport-relative — is dropped), confirming the two conventions
 * (input.ts's and tldraw's) agree on this formula, not just on
 * worldToScreen/screenToWorld individually.
 *
 * `newZ` is clamped to [MIN_ZOOM, MAX_ZOOM] BEFORE the xy correction is
 * computed, so the invariant holds exactly against whatever z the zoom
 * actually lands on (a factor that would overshoot the clamp still produces
 * a camera whose screenToWorld(screenPoint) is unchanged — it just zooms
 * less than `factor` nominally asked for).
 */
export function zoomAboutPoint(camera: Camera, screenPoint: { readonly x: number; readonly y: number }, factor: number): Camera {
  const newZ = clampZoom(camera.z * factor)
  return {
    x: camera.x + screenPoint.x / newZ - screenPoint.x / camera.z,
    y: camera.y + screenPoint.y / newZ - screenPoint.y / camera.z,
    z: newZ,
  }
}

// Plain-wheel pan speed and the per-tick zoom-delta clamp below both mirror
// tldraw's defaults (DEFAULT_CAMERA_OPTIONS: panSpeed: 1, zoomSpeed: 1 —
// node_modules/tldraw/src/lib/constants.ts) at speed 1 (i.e. these constants
// fold a speed multiplier of 1 into the formula rather than exposing a
// separate factor no caller here needs yet).
const PAN_SPEED = 1

// The per-tick zoom-delta magnitude clamp (max 0.1 of current z per wheel
// tick), reusing tldraw's own normalization constant: installed `tldraw`
// package, node_modules/tldraw/src/lib/editor/Editor.ts, the wheel handler's
// `wheelBehavior === 'zoom'` branch: `Math.abs(dy) > 10 ? (10 *
// Math.sign(dy)) / 100 : dy / 100`. SIGN CHOICE IS OURS, not tldraw's literal
// code: that branch computes `zoom = cz + delta*zoomSpeed*cz`, i.e. POSITIVE
// dy zooms IN in tldraw's source — but input.ts's own WheelInputEvent doc
// comment (this package's already-committed convention) says the opposite:
// "positive dy = wheel scrolled down/away from the user, which a camera
// consumer conventionally interprets as zoom OUT" (the Figma/Maps
// convention). We honor OUR OWN documented sign, inverting tldraw's literal
// formula here — reusing only its clamp magnitude, not its sign.
const ZOOM_DELTA_CLAMP = 0.1

function wheelZoomFactor(dy: number): number {
  const magnitude = Math.min(Math.abs(dy) / 100, ZOOM_DELTA_CLAMP)
  const delta = Math.sign(dy) * magnitude
  return 1 - delta // positive dy (scroll down/away) => factor < 1 => zoom OUT, per our documented convention
}

/**
 * The wheel policy shared by the hand tool (below) AND D2's renderer (which
 * wires wheel events globally, outside any tool) — defined ONCE here so
 * there is exactly one place a sign or curve disagreement could hide.
 * PLAIN wheel pans (dx/dy, screen-delta / z, matching the hand-drag pan
 * formula below); CTRL-OR-META+wheel zooms about the cursor via
 * zoomAboutPoint, with the factor curve documented on wheelZoomFactor/
 * ZOOM_DELTA_CLAMP above. ctrl OR meta (not just ctrl) triggers zoom — wider
 * than tldraw's literal `info.ctrlKey`-only check, which exists to catch a
 * browser quirk (trackpad pinch-zoom synthesizes ctrlKey:true wheel events)
 * we have no equivalent signal for; treating meta the same as ctrl is our
 * choice for a friendlier default across platforms (meta/Cmd+wheel zoom is a
 * common convention on macOS apps), not a claimed parity point.
 */
export function applyWheel(camera: Camera, event: WheelInputEvent): Camera {
  if (event.modifiers.ctrl || event.modifiers.meta) {
    return zoomAboutPoint(camera, { x: event.x, y: event.y }, wheelZoomFactor(event.dy))
  }
  return { x: camera.x + (event.dx * PAN_SPEED) / camera.z, y: camera.y + (event.dy * PAN_SPEED) / camera.z, z: camera.z }
}
