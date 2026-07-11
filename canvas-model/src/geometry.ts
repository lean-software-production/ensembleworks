import { type CanvasDocument } from './document.js'
import { isPageId, type PageId } from './ids.js'
import { type Shape } from './shape.js'

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

const DEFAULTS: Partial<Record<Shape['kind'], { w: number; h: number }>> = {
  geo: { w: 220, h: 120 }, frame: { w: 800, h: 600 },
  text: { w: 200, h: 40 }, image: { w: 200, h: 200 },
}
// Rendered size, clamped to >= 0 so inverted bounds can never reach downstream
// rectangle math. Notes never store w/h in tldraw: their real rendered size is
// 200*scale × (200+growY)*scale. Geo stores w/h ALREADY scaled (GeoShapeUtil
// computes unscaledShapeW = w / scale — opposite convention from text) and
// renders height as h + growY, so no scale multiply there. Other kinds:
// props.w/h → per-kind default → 100, times props.scale (tldraw's uniform
// render multiplier) when present.
function size(s: Shape): { w: number; h: number } {
  const p = s.props as any
  const scale = typeof p?.scale === 'number' ? p.scale : 1
  if (s.kind === 'note') {
    const growY = typeof p?.growY === 'number' ? p.growY : 0
    return { w: Math.max(0, 200 * scale), h: Math.max(0, (200 + growY) * scale) }
  }
  const w = typeof p?.w === 'number' ? p.w : DEFAULTS[s.kind]?.w ?? 100
  const h = typeof p?.h === 'number' ? p.h : DEFAULTS[s.kind]?.h ?? 100
  if (s.kind === 'geo') {
    const growY = typeof p?.growY === 'number' ? p.growY : 0
    return { w: Math.max(0, w), h: Math.max(0, h + growY) }
  }
  return { w: Math.max(0, w * scale), h: Math.max(0, h * scale) }
}

// The page a shape ultimately lives on, walking parents with the same guard<50
// tolerance as pageOrigin (malformed trees yield undefined, not an error).
export function pageIdOf(doc: CanvasDocument, s: Shape): PageId | undefined {
  let cur: Shape | undefined = s
  let guard = 0
  while (cur && guard++ < 50) {
    if (isPageId(cur.parentId)) return cur.parentId
    cur = doc.byId.get(cur.parentId)
  }
  return undefined
}

// Page-space top-left: sum this shape's x/y with every ancestor shape's x/y.
// Rotation ignored (unrotated-parents-only, matching server geometry.pagePoint).
function pageOrigin(doc: CanvasDocument, s: Shape): { x: number; y: number } {
  let x = s.x, y = s.y, guard = 0
  let parent = doc.byId.get(s.parentId)
  while (parent && guard++ < 50) { x += parent.x; y += parent.y; parent = doc.byId.get(parent.parentId) }
  return { x, y }
}

export function pageBounds(doc: CanvasDocument, s: Shape): Bounds {
  const o = pageOrigin(doc, s)
  const { w, h } = size(s)
  return { minX: o.x, minY: o.y, maxX: o.x + w, maxY: o.y + h }
}

export const centroid = (b: Bounds) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })

// Median of max(w,h) over the given shapes — the scale-relative unit the semantic
// layer measures gaps against (design: "gaps relative to median sticky size").
export function medianSize(shapes: readonly Shape[]): number {
  const sizes = shapes.map((s) => { const { w, h } = size(s); return Math.max(w, h) }).sort((a, b) => a - b)
  if (sizes.length === 0) return 100
  const mid = Math.floor(sizes.length / 2)
  return sizes.length % 2 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2
}
