// The `draw` body (Task R1 — canvas-v2 freehand DRAW parity sub-cycle,
// D-4). Replaces `draw`'s BoxShape fallback with a real freehand-ink render:
// flatten `props.segments[].points` (the format the pen tool, T1, writes —
// canvas-editor/src/tools/draw.ts's buildShape) into one ordered point
// array, run it through canvas-model's G1-G3 outline algorithm
// (getStrokePath = getStrokePoints . getStrokeOutline . getSvgPathFromOutline,
// draw-geometry.ts), and paint the result as a FILLED <path> — the
// perfect-freehand model is a closed outline polygon, not a stroked
// centerline, so this renders `fill`, never `stroke`, on the path element.
//
// COORDINATES (load-bearing, D-4): unlike GeoShape.tsx (which scales a fixed
// `w x h` viewBox to the body's 100%x100% box), a draw shape's points are
// ALREADY in local (shape-space) coordinates — the pen tool normalizes
// `shape.x/y` to the point-cloud's min corner and stores every point
// relative to it (draw.ts's buildShape). ShapeBody.tsx sizes this body's
// wrapper div to `localBounds` in those SAME units, so shape-space
// coordinates are already screen pixels here with NO transform needed — the
// <svg> below carries no `viewBox` (a scaling viewBox on already-local
// points would double-transform them). `overflow:visible` lets a stroke
// that extends past the wrapper's bbox (always, by ~radius; ALWAYS for a
// synced v1 shape, which carries no normalized w/h — see the PATH-ONLY
// section below and canvas-model/src/shape.ts's Decision-1 coordinate note)
// still paint correctly instead of getting clipped.
//
// COLOR/SIZE: reuses GeoShape.tsx's EXPORTED `GEO_COLORS`/`colorEntry` (the
// same tolerant `typeof x === 'string' && x in GEO_COLORS` guard, same
// absent/unrecognized -> 'black' default) rather than duplicating a second
// color table — color/size are shared style axes (canvas-model's
// STYLE_ENUMS), not geo-specific, per GeoShape.tsx's own module header.
// `props.size` drives stroke WIDTH via canvas-model's `strokeOptionsForSize`
// (G3) — a completely different table from GeoShape's STROKE_WIDTH_PX
// (that's a stroked border's width; this is a filled ink body's base radius
// — draw-geometry.ts's SIZE_TO_BASE_PX documents why the two diverge).
//
// dash/fill are DELIBERATELY NOT read here (plan judgment call 3, owner
// OK'd): a freehand stroke IS a filled colored outline — `dash`/`fill` are
// typed on the schema for round-trip fidelity but are a documented visual
// no-op on ink, matching how most freehand renderers treat them.
//
// THE V1 BASE64 PATH CASE (M1's finding — canvas-model/src/shape.ts's
// `drawSegment` comment): the tlschema dependency actually installed here
// (5.1.0) migrated `segments` to carry a delta-encoded base64 `path: string`
// instead of `points` (this repo's own legacy write path,
// server/src/canvas/drawShapes.ts, emits exactly that format via
// compressLegacySegments) — so a SYNCED v1 draw shape's segment has `path`,
// no `points`. DEFERRED, not decoded, by design: decoding would need either
// an import from the tldraw org's packages (forbidden — this package's own
// boundary.test.ts) or a from-scratch base64/delta decoder, and the gap is
// rare/cosmetic (synced v1 draw shapes are not something this app's own
// pen tool ever produces). `flattenPoints` below simply skips any segment
// that has no `points` array — a path-only segment contributes zero points,
// so a fully-v1 shape renders its wrapper with NO <path> child (a documented
// degraded/empty render), and a MIXED shape (some segments `points`, some
// `path`) still renders whatever `points` segments it has. Either way: NO
// CRASH, no NaN — never throws on a path-only, empty, or malformed segment.
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { getStrokePath, strokeOptionsForSize, type DrawInputPoint } from '@ensembleworks/canvas-model'
import { colorEntry } from './GeoShape.js'

/** Flatten every segment's `points` into one ordered point array (the
 * geometry stage concatenates all segments, per the plan's D-1 note). A
 * segment with no `points` array (a v1 path-only segment, or any malformed
 * entry) contributes nothing; an individual point missing a finite x/y is
 * dropped rather than propagating a NaN into the outline math. */
export function flattenDrawPoints(shape: ShapeBodyProps['shape']): DrawInputPoint[] {
  const props = shape.props as Record<string, unknown>
  const segments = Array.isArray(props.segments) ? props.segments : []
  const out: DrawInputPoint[] = []
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue
    const points = (segment as Record<string, unknown>).points
    if (!Array.isArray(points)) continue // v1 path-only segment, or malformed — no points to contribute
    for (const p of points) {
      if (p === null || typeof p !== 'object') continue
      const x = (p as Record<string, unknown>).x
      const y = (p as Record<string, unknown>).y
      const z = (p as Record<string, unknown>).z
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) continue
      out.push(typeof z === 'number' && Number.isFinite(z) ? { x, y, z } : { x, y })
    }
  }
  return out
}

export function DrawShape({ shape }: ShapeBodyProps) {
  const props = shape.props as Record<string, unknown>
  const points = flattenDrawPoints(shape)
  const isPen = props.isPen === true
  const size = typeof props.size === 'string' ? props.size : 'm'
  const d = points.length > 0 ? getStrokePath(points, strokeOptionsForSize(size, isPen)) : ''
  const fill = colorEntry(props.color).solid

  return (
    <div data-shape-body="draw" style={{ width: '100%', height: '100%', position: 'relative' }}>
      {d.length > 0 && (
        <svg style={{ overflow: 'visible', position: 'absolute', inset: 0 }}>
          <path d={d} fill={fill} />
        </svg>
      )}
    </div>
  )
}
