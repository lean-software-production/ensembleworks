// The world container: a single div whose CSS transform derives from the
// camera triple (EditorState.camera — see editor.ts), positioning every
// shape body / grid dot that lives inside it in one place rather than each
// shape computing its own screen position.
//
// THE TRANSFORM STRING (pinned + cross-checked against worldToScreen by
// viewport.test.ts, not just eyeballed — see that file's "transform
// agrees with worldToScreen" case):
//
//   input.ts's NORMATIVE camera convention:  screen = (world + camera.xy) · z
//
// CSS combines a `transform` function LIST into one matrix by multiplying
// left-to-right, but APPLIES that matrix to a point right-to-left — i.e. for
// `transform: A B`, the rendered effect on a point p is A(B(p)): the
// RIGHTMOST function runs first. So `scale(z) translate(x, y)` runs
// translate FIRST (on the local/world-space point p, producing p + (x,y))
// and scale SECOND (producing z·(p + (x,y))) — exactly
// screen = (world + camera.xy) · z with (x, y) = camera.xy. Concretely: a
// shape body positioned at its own world (wx, wy) inside this container
// (untransformed local coordinates) lands, after this container's
// transform, at screen ((wx + camera.x) · camera.z, (wy + camera.y) ·
// camera.z) — the same point worldToScreen(camera, {x: wx, y: wy}) computes
// independently. transform-origin 0 0 is required for this to hold: any
// other origin would insert an additional origin-dependent offset term CSS
// applies before/after the listed functions.
import type { Camera } from '@ensembleworks/canvas-editor'
import type { ReactNode } from 'react'

export interface WorldLayerProps {
  readonly camera: Camera
  readonly children?: ReactNode
}

/** Pure — no DOM, no React — so viewport.test.ts can hand-check it against
 * worldToScreen without rendering anything. See the module header for the
 * derivation. */
export function cameraTransform(camera: Camera): string {
  return `scale(${camera.z}) translate(${camera.x}px, ${camera.y}px)`
}

export function WorldLayer({ camera, children }: WorldLayerProps): ReactNode {
  return (
    <div
      data-canvas-layer="world"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transformOrigin: '0 0',
        transform: cameraTransform(camera),
        // Rendering hints, stated rather than silent: `contain` isolates
        // this subtree's layout/style from the page; `will-change` asks
        // for a compositor layer so pan/zoom is a transform update, not a
        // repaint. H3 owns MEASURING whether either actually helps (and
        // removing them if not). `paint` is DELIBERATELY absent from the
        // contain list: paint containment clips descendants to the
        // element's border box, and this container's border box is 0x0
        // (auto-sized absolute div whose children are all absolutely
        // positioned) — `contain: paint` here would clip every shape
        // invisible, and no fixed container size can fix that for an
        // infinite canvas whose children live at unbounded world
        // coordinates in every direction. Viewport's own overflow:hidden
        // already provides the visible clipping boundary.
        contain: 'layout style',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  )
}
