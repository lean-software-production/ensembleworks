import { type CanvasDocument } from './document.js'
import { centroid, pageBounds, pageIdOf } from './geometry.js'

export interface Neighbor { id: string; distance: number }

// Shapes on the SAME PAGE as the target whose centroid falls within `radius` of
// the target's centroid, nearest first, excluding the target. Shapes whose page
// can't be resolved (malformed tree) never match. Deterministic (ties break by id).
export function neighbors(doc: CanvasDocument, id: string, radius: number): Neighbor[] {
  const self = doc.byId.get(id)
  if (!self) return []
  const page = pageIdOf(doc, self)
  if (page === undefined) return []
  const c0 = centroid(pageBounds(doc, self))
  const out: Neighbor[] = []
  for (const s of doc.shapes) {
    if (s.id === id) continue
    if (pageIdOf(doc, s) !== page) continue
    const c = centroid(pageBounds(doc, s))
    const d = Math.hypot(c.x - c0.x, c.y - c0.y)
    if (d <= radius) out.push({ id: s.id, distance: d })
  }
  return out.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
}
