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
  const clusterOf = (shapeId: string): number => clusters.findIndex((c) => c.members.includes(shapeId))

  const relations: Relation[] = []
  const inScope = new Set(shapes.map((s) => s.id))
  // Group bindings by arrow (fromId = the arrow shape), then relate the two
  // endpoints' clusters.
  const byArrow = new Map<string, string[]>()
  for (const b of doc.bindings) {
    if (!inScope.has(b.fromId)) continue
    ;(byArrow.get(b.fromId) ?? byArrow.set(b.fromId, []).get(b.fromId)!).push(b.toId)
  }
  for (const [arrowId, targets] of byArrow) {
    if (targets.length < 2) continue
    const [c1, c2] = [clusterOf(targets[0]!), clusterOf(targets[1]!)]
    if (c1 >= 0 && c2 >= 0 && c1 !== c2) relations.push({ arrowId, fromCluster: c1, toCluster: c2 })
  }
  return { clusters, outliers, relations }
}
