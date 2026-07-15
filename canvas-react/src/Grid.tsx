// Dotted background grid, rendered BENEATH the shape layer (Viewport.tsx
// stacks Grid before WorldLayer/ShapeLayer in DOM order). Deliberately NOT a
// <canvas> element and NOT a child of WorldLayer's transformed container —
// implemented as a single absolutely-positioned div whose CSS
// `background-image`/`background-size`/`background-position` are computed
// FROM the camera directly, so the browser tiles the dot pattern natively
// (cheap: one paint, no per-dot DOM node, no re-layout as the camera pans).
//
// The alternative (a child of WorldLayer, scaled by the same transform) was
// rejected: a background-image tiled through a `scale()` transform still
// looks fine but couples the grid's cost to WorldLayer's paint/composite
// layer for no benefit — the math below reproduces the identical visual
// position with a plain screen-space div instead.
//
// MATH: `background-position` is chosen so a dot lands exactly at the
// SCREEN position of world-space origin (0, 0) — i.e. worldToScreen(camera,
// {x:0, y:0}) = (camera.x · camera.z, camera.y · camera.z) (input.ts's
// NORMATIVE screen = (world + camera.xy) · z, world = (0,0)). `background-
// size` scales the dot pitch by camera.z the same way world-space distances
// scale under the camera, so the grid's world-space spacing (GRID_SPACING)
// stays visually constant across pans and zooms — i.e. this reproduces
// exactly what a dot rendered as a real shape at world-space grid points
// would look like, without any per-dot element.
//
// ZOOM / FADE POLICY (OURS, simple — no parity claim): tldraw's real grid
// adaptively snaps its step size to decade-ish increments (10/100/1000...)
// as you zoom so dot density stays roughly constant on screen. This unit
// ships a single fixed WORLD-space pitch (GRID_SPACING) that simply scales
// with zoom like everything else in the world — dots get visually denser
// zoomed in and sparser zoomed out, with no adaptive step or fade-out at
// extreme zoom. Deferred: a later seam can add step/fade policy without
// touching this component's contract (camera in, a div out).
import type { Camera } from '@ensembleworks/canvas-editor'

export interface GridProps {
  readonly camera: Camera
}

/** World-space spacing between dots, in world units (arbitrary — chosen for
 * a reasonable default visual density at camera.z = 1; see ZOOM/FADE POLICY
 * above for why this doesn't need to be configurable yet). */
const GRID_SPACING = 24
const DOT_RADIUS_PX = 1

export function Grid({ camera }: GridProps) {
  const size = GRID_SPACING * camera.z
  // worldToScreen(camera, {x: 0, y: 0}) inlined (see module header).
  const offsetX = camera.x * camera.z
  const offsetY = camera.y * camera.z
  return (
    <div
      data-canvas-layer="grid"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: `radial-gradient(circle, var(--canvas-grid-dot, rgba(128, 128, 128, 0.5)) ${DOT_RADIUS_PX}px, transparent ${DOT_RADIUS_PX}px)`,
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
      }}
    />
  )
}
