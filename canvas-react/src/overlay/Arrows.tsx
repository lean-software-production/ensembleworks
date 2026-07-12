// Arrow rendering: every arrow-kind shape's routed WORLD-space path
// (canvas-model's `routeArrow`, arrow-route.ts) converted point-by-point to
// SCREEN space and drawn as an SVG path, plus a small arrowhead triangle at
// the end.
//
// WHY ARROWS LIVE IN THE OVERLAY, NOT AS SHAPE BODIES (ShapeBody.tsx/
// ShapeLayer.tsx): `routeArrow` reads a bound terminal's CURRENT anchor
// position off whatever shape it's bound to — "arrows are re-routed on every
// call, not cached from bind time" (arrow-route.ts's routeArrow doc comment).
// That is a CROSS-SHAPE read (an arrow shape's rendered geometry depends on
// some OTHER shape's current position/rotation, not just its own props), which
// ShapeBody's per-shape, `snapshot`-optional-by-convention memo model
// (ShapeBody.tsx's MEMO STRATEGY note) is not built for — a bound arrow would
// need to re-render on every OTHER shape's move, defeating exactly the
// content-memo win that model exists for. The overlay already re-renders
// wholesale on every doc commit (it reads the whole `snapshot`), so routing
// every arrow fresh here, on every render, is the natural place: no extra
// subscription wiring, and a moved target's next commit re-renders the
// overlay (and therefore re-routes every arrow) for free.
//
// CURVE RENDERING: `kind === 'straight'` -> `M start L end`; `kind ===
// 'curved'` (bend != 0) -> a quadratic Bézier `M start Q mid end`, using
// routeArrow's `mid` as the SVG `Q` command's single control point verbatim
// (arrow-route.ts documents `mid` as exactly a quadratic control point, in
// WORLD space — converted to screen here like every other point).
//
// ARROWHEAD ORIENTATION: a small triangle at the visible `end` point, aimed
// along the path's incoming tangent — for a straight path that's `end -
// start`; for a quadratic Bézier, the tangent at t=1 (the curve's END) is
// proportional to `end - mid` (the standard quadratic-Bézier derivative
// B'(1) = 2(P2 - P1) for control points P0=start, P1=mid, P2=end — the
// constant 2 doesn't matter, only the DIRECTION does here). Both cases
// therefore reduce to "the last segment's direction", computed directly from
// the already screen-converted points (worldToScreen is a translate+uniform
// scale, so direction angles survive the conversion unchanged in sign, only
// scaled in magnitude, which normalizing away here loses nothing).
//
// Ink (freehand drawing) is OUT of scope per the ratified Open Q3 answer —
// this file renders arrow-kind shapes ONLY; a hypothetical Ink.tsx is
// deferred, not stubbed.
import type { CanvasDocument, Point } from '@ensembleworks/canvas-model'
import { routeArrow } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'

export interface ArrowsProps {
  readonly snapshot: CanvasDocument
  readonly camera: Camera
}

const ARROW_STROKE = 'var(--canvas-arrow, #1a1a1a)'
const ARROWHEAD_LENGTH_PX = 10
const ARROWHEAD_HALF_WIDTH_PX = 4

function pathString(start: Point, end: Point, mid?: Point): string {
  if (!mid) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`
  return `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`
}

/** The triangle's 3 screen points for an arrowhead pointing FROM `tail`
 * TOWARD `tip` (i.e. oriented along `tip - tail`). Exported so overlay.test.ts
 * can hand-compute the same geometry independently rather than re-deriving
 * trig locally. Degenerate `tip === tail` (zero-length last segment — e.g. a
 * self-bound arrow whose two anchors coincide, arrow-route.test.ts's own
 * documented degenerate case): `Math.atan2(0, 0)` is well-defined (0, not
 * NaN), so this still returns a finite (if visually meaningless) triangle,
 * never throws or emits NaN into the SVG. */
export function arrowheadPoints(tail: Point, tip: Point): [Point, Point, Point] {
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const backX = tip.x - ARROWHEAD_LENGTH_PX * cos
  const backY = tip.y - ARROWHEAD_LENGTH_PX * sin
  // Perpendicular to the tangent, same 90°-rotation convention geometry.ts
  // documents ((x,y) -> (-y,x)) — screen space, not world space, since these
  // points are already converted; the convention is the same rotation either
  // way, just applied to a different vector.
  const perpX = -sin
  const perpY = cos
  const left: Point = { x: backX + ARROWHEAD_HALF_WIDTH_PX * perpX, y: backY + ARROWHEAD_HALF_WIDTH_PX * perpY }
  const right: Point = { x: backX - ARROWHEAD_HALF_WIDTH_PX * perpX, y: backY - ARROWHEAD_HALF_WIDTH_PX * perpY }
  return [tip, left, right]
}

export function Arrows({ snapshot, camera }: ArrowsProps) {
  const arrows = snapshot.shapes.filter((s) => s.kind === 'arrow')
  if (arrows.length === 0) return null

  return (
    <>
      {arrows.map((arrow) => {
        const route = routeArrow(snapshot, arrow, snapshot.bindings)
        const startScreen = worldToScreen(camera, route.start)
        const endScreen = worldToScreen(camera, route.end)
        const midScreen = route.mid ? worldToScreen(camera, route.mid) : undefined
        const tail = midScreen ?? startScreen // the tangent's "from" point at t=1 — see module header
        const [tip, left, right] = arrowheadPoints(tail, endScreen)
        return (
          <g key={arrow.id} data-overlay="arrow" data-shape-id={arrow.id}>
            <path
              d={pathString(startScreen, endScreen, midScreen)}
              fill="none"
              stroke={ARROW_STROKE}
              strokeWidth={1.5}
            />
            <polygon
              data-overlay="arrowhead"
              points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
              fill={ARROW_STROKE}
            />
          </g>
        )
      })}
    </>
  )
}
