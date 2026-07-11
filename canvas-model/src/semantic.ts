import { type CanvasDocument } from './document.js'
import { type Shape } from './shape.js'
import { clusterShapes, type Cluster } from './cluster.js'

export interface Relation { arrowId: string; fromCluster: number; toCluster: number }
export interface SemanticView { clusters: Cluster[]; outliers: string[]; relations: Relation[] }

// The design's spatial-semantics view: clusters + outliers + arrow relations
// between clusters. `shapes` is the subset to analyse (a frame's descendants, or
// a whole page). Pure.
export function semanticView(doc: CanvasDocument, shapes: readonly Shape[]): SemanticView {
  const { clusters, outliers } = clusterShapes(doc, shapes)
  // member shape id → cluster index, built once (O(1) lookups instead of a
  // findIndex/includes scan per binding endpoint).
  const clusterIndex = new Map<string, number>()
  clusters.forEach((c, i) => { for (const id of c.members) clusterIndex.set(id, i) })

  const relations: Relation[] = []
  const inScope = new Set(shapes.map((s) => s.id))
  // Group bindings by arrow (fromId = the arrow shape), keeping each target's
  // terminal ('start' | 'end' — tldraw arrow bindings carry props.terminal) so
  // the relation is oriented by the arrow's real direction, not array order.
  const byArrow = new Map<string, { toId: string; terminal: unknown }[]>()
  for (const b of doc.bindings) {
    if (!inScope.has(b.fromId)) continue
    ;(byArrow.get(b.fromId) ?? byArrow.set(b.fromId, []).get(b.fromId)!)
      .push({ toId: b.toId, terminal: (b.props as any)?.terminal })
  }
  for (const [arrowId, targets] of byArrow) {
    if (targets.length < 2) continue
    // Orient by terminals when unambiguous (exactly one 'start' and one 'end');
    // otherwise fall back to deterministic binding array order.
    const starts = targets.filter((t) => t.terminal === 'start')
    const ends = targets.filter((t) => t.terminal === 'end')
    const [src, dst] = starts.length === 1 && ends.length === 1 ? [starts[0]!, ends[0]!] : [targets[0]!, targets[1]!]
    const c1 = clusterIndex.get(src.toId) ?? -1
    const c2 = clusterIndex.get(dst.toId) ?? -1
    // Cluster↔cluster relations only — a deliberate scope limit: arrows whose
    // endpoint is an outlier (or any unclustered shape) yield no relation.
    if (c1 >= 0 && c2 >= 0 && c1 !== c2) relations.push({ arrowId, fromCluster: c1, toCluster: c2 })
  }
  return { clusters, outliers, relations }
}
