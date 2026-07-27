// The `line` body (Task R1 — canvas-v2 full-parity LINE sub-cycle, D-3).
// Replaces `line`'s BoxShape fallback with a real render: flatten
// `props.points` (M1's keyed map `{ [id]: { id, index, x, y } }` — the
// format the line tool, T1, writes, and the SAME shape a synced v1 line
// carries) into one ORDERED `{x,y}[]` array, run it through canvas-model's
// G1 pure geometry (`linePathData`, line-geometry.ts), and paint the result
// as a STROKED <path> — a line IS a stroked spline (`fill:none,
// stroke=color`), UNLIKE DrawShape's filled freehand outline (a
// perfect-freehand outline is a closed polygon; a line is an open
// centerline). Model the style resolver on Arrows.tsx's `arrowStyle`
// (stroked), NOT DrawShape's fill resolver.
//
// ORDERING (the convergence crux, D-3/plan's R1 charge): `props.points` is a
// KEYED MAP, so its enumeration order (`Object.values`) is INSERTION order,
// not necessarily the handles' intended sequence — a synced/authored line
// can have its map keys inserted in any order relative to each point's own
// `index` field. `flattenLinePoints` sorts by `index` (string compare,
// ascending) with `id` as the secondary tie-break (mirrors z-order's
// (index,id) tie-break convention elsewhere in this codebase), falling back
// to the array's own (stable-sort-preserved) position when `index`/`id` are
// absent on one or both sides. Two peers rendering the SAME `props.points`
// object therefore ALWAYS produce the SAME ordered array and the SAME path
// — deterministic, independent of map-literal insertion order.
//
// COORDINATES (load-bearing, same as DrawShape.tsx): a line's points are
// ALREADY in local (shape-space) coordinates — our own tool normalizes
// `shape.x/y` to the point-cloud's min corner and stores every handle
// relative to it (T1's buildShape); a synced v1 line follows the identical
// "X/Y relative to the shape's origin" convention. ShapeBody.tsx sizes this
// body's wrapper div to `localBounds` in those SAME units, so NO scaling
// `viewBox` is used here (a scaling viewBox on already-local points would
// double-transform them) — `overflow:visible` lets a stroke overflowing the
// wrapper box paint correctly (always true for a synced v1 line, which
// carries no normalized w/h and so gets the generic 100x100 selection box —
// see canvas-model/src/shape.ts's Decision-1 coordinate note).
//
// STYLING: reuses GeoShape.tsx's EXPORTED `GEO_COLORS`/`colorEntry`
// (color->hex, absent/unrecognized->'black'), `STROKE_WIDTH_PX`
// (size->px, absent/unrecognized->'m'/DEFAULT_SIZE), and
// `dashArray`/`DASH_VALUES` (dash->dasharray; 'draw'/'solid'/absent-> no
// dasharray attribute) — the SAME tables Arrows.tsx's `arrowStyle` and
// GeoShape.tsx's `geoStyle` already resolve through, not a second copy.
import type { ShapeBodyProps } from '../shapeRegistry.js'
import { linePathData, type Point } from '@ensembleworks/canvas-model'
import { colorEntry, DASH_VALUES, DEFAULT_DASH, DEFAULT_SIZE, dashArray, STROKE_WIDTH_PX } from './GeoShape.js'

interface RawLinePoint {
  readonly x: unknown
  readonly y: unknown
  readonly id: unknown
  readonly index: unknown
}

/** Flatten a line shape's `props.points` (M1's keyed map, or the array form
 * defensively) into an ORDERED `{x,y}[]`, sorted by `index` ascending with
 * `id` as the tie-break (deterministic — the convergence property; see
 * module header). Tolerant of a missing/non-object `points`, a non-object
 * entry, and a missing/non-finite x or y — such an entry is dropped rather
 * than propagating a NaN into `linePathData`. Never throws. */
export function flattenLinePoints(shape: ShapeBodyProps['shape']): Point[] {
  const props = shape.props as Record<string, unknown>
  const raw = props.points
  let entries: unknown[]
  if (Array.isArray(raw)) {
    entries = raw
  } else if (raw !== null && typeof raw === 'object') {
    entries = Object.values(raw as Record<string, unknown>)
  } else {
    entries = []
  }

  const valid: { x: number; y: number; index: string; id: string }[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const p = entry as RawLinePoint
    if (typeof p.x !== 'number' || !Number.isFinite(p.x)) continue
    if (typeof p.y !== 'number' || !Number.isFinite(p.y)) continue
    valid.push({
      x: p.x,
      y: p.y,
      index: typeof p.index === 'string' ? p.index : '',
      id: typeof p.id === 'string' ? p.id : '',
    })
  }

  // Stable sort (Array.prototype.sort is spec-guaranteed stable): ties on
  // BOTH index and id preserve the entries' original (array/insertion)
  // position, which is the documented "fall back to insertion order when
  // index is absent" behavior when several entries share no index.
  valid.sort((a, b) => {
    if (a.index < b.index) return -1
    if (a.index > b.index) return 1
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })

  return valid.map(({ x, y }) => ({ x, y }))
}

export function LineShape({ shape }: ShapeBodyProps) {
  const props = shape.props as Record<string, unknown>
  const points = flattenLinePoints(shape)
  const spline = props.spline === 'cubic' ? 'cubic' : 'line'
  const d = points.length >= 2 ? linePathData(points, spline) : ''

  const stroke = colorEntry(props.color).solid
  const size = typeof props.size === 'string' && props.size in STROKE_WIDTH_PX ? props.size : DEFAULT_SIZE
  const strokeWidth = STROKE_WIDTH_PX[size]
  const dash = typeof props.dash === 'string' && DASH_VALUES.has(props.dash) ? props.dash : DEFAULT_DASH
  const strokeDasharray = dashArray(dash, strokeWidth)

  return (
    <div data-shape-body="line" style={{ width: '100%', height: '100%', position: 'relative' }}>
      {d.length > 0 && (
        <svg style={{ overflow: 'visible', position: 'absolute', inset: 0 }}>
          <path
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            {...(strokeDasharray !== undefined ? { strokeDasharray } : {})}
          />
        </svg>
      )}
    </div>
  )
}
