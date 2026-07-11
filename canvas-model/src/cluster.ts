import { type CanvasDocument } from './document.js'
import { type Shape } from './shape.js'
import { type Bounds, centroid, medianSize, pageBounds } from './geometry.js'
import { plainText } from './shape.js'

export type Arrangement = 'column' | 'grid' | 'loose'
export interface Cluster {
  members: string[]           // shape ids
  arrangement: Arrangement
  confidence: number          // 0..1
  label: string | null        // nearest heading-ish text, if any
  bounds: Bounds
}
export interface ClusterResult { clusters: Cluster[]; outliers: string[] }

// Gap between two axis-aligned rects (0 if they overlap).
function gap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX))
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY))
  return Math.hypot(dx, dy)
}

// k: gap threshold as a multiple of median size. Tunable; 0.9 groups adjacent
// stickies (a one-sticky gap) while keeping distant ones apart.
const GAP_K = 0.9

export function clusterShapes(doc: CanvasDocument, shapes: readonly Shape[], k = GAP_K): ClusterResult {
  const notes = shapes.filter((s) => s.kind === 'note')
  const threshold = medianSize(notes) * k
  const bounds = new Map<string, Bounds>(notes.map((s) => [s.id, pageBounds(doc, s)]))

  // Single-linkage union-find on gap ≤ threshold.
  const parent = new Map<string, string>(notes.map((s) => [s.id, s.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++)
      if (gap(bounds.get(notes[i]!.id)!, bounds.get(notes[j]!.id)!) <= threshold) union(notes[i]!.id, notes[j]!.id)

  const groups = new Map<string, string[]>()
  for (const s of notes) { const r = find(s.id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(s.id) }

  const clusters: Cluster[] = []
  const outliers: string[] = []
  // Deterministic order: sort groups by their first member id.
  for (const members of [...groups.values()].sort((a, b) => a[0]!.localeCompare(b[0]!))) {
    if (members.length === 1) { outliers.push(members[0]!); continue }
    const bs = members.map((id) => bounds.get(id)!)
    const cb: Bounds = {
      minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)),
      maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)),
    }
    clusters.push({
      members: [...members].sort((a, b) => a.localeCompare(b)),
      arrangement: classify(bs, medianSize(notes)),
      confidence: confidence(doc, members),
      label: nearestLabel(doc, shapes, centroid(cb)),
      bounds: cb,
    })
  }
  return { clusters, outliers }
}

// column: one vertical stack (x-centroids aligned within half a median).
// grid: multiple distinct rows AND columns. else loose.
function classify(bs: Bounds[], unit: number): Arrangement {
  const cx = bs.map((b) => (b.minX + b.maxX) / 2)
  const cy = bs.map((b) => (b.minY + b.maxY) / 2)
  const buckets = (vals: number[]) => new Set(vals.map((v) => Math.round(v / (unit * 0.75)))).size
  const cols = buckets(cx), rows = buckets(cy)
  if (cols === 1 && rows > 1) return 'column'
  if (cols > 1 && rows > 1 && bs.length >= cols * rows - 1) return 'grid'
  return 'loose'
}

// confidence = 0.5 * colour uniformity + 0.5 * axis alignment.
function confidence(doc: CanvasDocument, members: string[]): number {
  const shapes = members.map((id) => doc.byId.get(id)!)
  const colors = shapes.map((s) => String((s.props as any)?.color ?? ''))
  const modal = Math.max(...[...new Set(colors)].map((c) => colors.filter((x) => x === c).length))
  const colourUniformity = modal / members.length
  const cs = shapes.map((s) => centroid(pageBounds(doc, s)))
  const spread = (vals: number[]) => { const m = vals.reduce((a, b) => a + b, 0) / vals.length; return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) }
  const unit = medianSize(shapes) || 1
  const alignment = 1 - Math.min(1, Math.min(spread(cs.map((c) => c.x)), spread(cs.map((c) => c.y))) / unit)
  return Number((0.5 * colourUniformity + 0.5 * alignment).toFixed(3))
}

// Nearest text/geo-with-text shape to the cluster centroid (a "heading-ish"
// label), else null. Deterministic (nearest, ties by id).
function nearestLabel(doc: CanvasDocument, shapes: readonly Shape[], c: { x: number; y: number }): string | null {
  const candidates = shapes
    .filter((s) => (s.kind === 'text' || s.kind === 'geo') && plainText(s).trim().length > 0)
    .map((s) => { const cc = centroid(pageBounds(doc, s)); return { id: s.id, text: plainText(s), d: Math.hypot(cc.x - c.x, cc.y - c.y) } })
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
  return candidates[0]?.text ?? null
}
