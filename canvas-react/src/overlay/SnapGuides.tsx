// Snap-alignment guide lines: canvas-model's `snapCandidates` (snapping.ts)
// returns a `SnapResult.guides` array of `{ axis, at, kind }` — a guide with
// axis 'x' is a shared X COORDINATE (an alignment on the vertical axis, drawn
// as a VERTICAL line at screen-x = worldToScreen(at)); axis 'y' is a shared Y
// coordinate, drawn as a HORIZONTAL line. Guides render FULL-VIEWPORT-LENGTH
// (edge to edge of the current viewport, not clipped to the shapes involved)
// so the alignment is visible regardless of where the aligned shapes sit —
// exactly what a full-bleed rule line communicates ("everything currently on
// this line").
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import type { SnapResult } from '@ensembleworks/canvas-model'
import type { ViewportSize } from '../ShapeLayer.js'

export interface SnapGuidesProps {
  readonly snapResult?: SnapResult
  readonly camera: Camera
  readonly viewportSize: ViewportSize
}

const GUIDE_STROKE = 'var(--canvas-snap-guide, #ff5a5f)'

export function SnapGuides({ snapResult, camera, viewportSize }: SnapGuidesProps) {
  if (!snapResult || snapResult.guides.length === 0) return null

  return (
    <>
      {snapResult.guides.map((guide, i) => {
        if (guide.axis === 'x') {
          // A vertical line: every point on it shares the same WORLD x, so
          // one worldToScreen call at an arbitrary y (0) gives the screen-x
          // to draw at; the line itself spans the full viewport height.
          const screenX = worldToScreen(camera, { x: guide.at, y: 0 }).x
          return (
            <line
              key={`x-${i}`}
              data-overlay="snap-guide"
              data-snap-axis="x"
              data-snap-kind={guide.kind}
              x1={screenX}
              y1={0}
              x2={screenX}
              y2={viewportSize.height}
              stroke={GUIDE_STROKE}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          )
        }
        const screenY = worldToScreen(camera, { x: 0, y: guide.at }).y
        return (
          <line
            key={`y-${i}`}
            data-overlay="snap-guide"
            data-snap-axis="y"
            data-snap-kind={guide.kind}
            x1={0}
            y1={screenY}
            x2={viewportSize.width}
            y2={screenY}
            stroke={GUIDE_STROKE}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )
      })}
    </>
  )
}
