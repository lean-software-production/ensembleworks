// @ensembleworks/canvas-model — pure DFS paint-order for a shape set.
//
// orderForPaint answers "what order should these shapes be painted in, so
// DOM/canvas z-order matches the doc's z-order": a DFS PRE-ORDER traversal
// over the INPUT set, where at each level siblings are sorted by
// (index ASC lexical, id ASC lexical). Ascending index paints LATER, i.e.
// ON TOP (matches ShapeBody's flat-sibling DOM-order-is-paint-order
// convention — see canvas-react's ShapeLayer). The (index, id) tie-break is
// what makes this convergent: every existing shape carries index 'a1' (the
// D-2 legacy corpus, no migration performed), so without an id tie-break the
// paint order of an all-'a1' doc would depend on iteration/array order,
// which differs across peers holding the identical converged CRDT state.
// Breaking ties on id gives every peer the SAME total order regardless of
// merge order.
//
// WHY DFS, NOT A FLAT (index,id) OR (depth,index) SORT (the crux — see plan
// D-3): a flat sort does not GROUP a subtree. Example: root F (index 'a1')
// has child fc; root S (index 'a2') has no children. The correct paint order
// is [F, fc, S] — S, painted last, occludes ALL of F's subtree, not just F
// itself. A flat sort by (depth, index) yields [F, S, fc] (fc, painted
// after S, wrongly appears on top of S). DFS pre-order with a PER-PARENT
// (index, id) sibling sort is the only ordering that gives both
// parent-before-child (container occlusion) and correct cross-subtree z.
//
// Roots are defined relative to the INPUT set, not the full doc: a shape is
// a "forest root" if its parentId is NOT the id of another shape ALSO in the
// input set (mirrors editor.ts's orderParentBeforeChild "ancestor outside
// the set is a root for ordering" rule). This is what lets the renderer feed
// a CULLED (viewport-visible) subset straight through — a child whose parent
// fell outside the culled set is painted as its own root, never dropped.
//
// `byId` is accepted (not consulted for root/child grouping — that's
// membership in `shapes` only) purely so this is a drop-in replacement for
// orderParentBeforeChild's call signature (`orderForPaint(visibleShapes,
// snapshot.byId)` in ShapeLayer) — see the plan's Task R1.
//
// Cycle-safety: a malformed parentId cycle is repair.ts's job to prevent
// from ever reaching a doc that's rendered, but this function does not
// assume repair already ran (same discipline the sibling document module's
// descendantsOf documents for its own traversal). A `visited` set guards against
// re-entering an already-painted shape. A cycle entirely WITHIN the input
// set (every member's parentId also present in the set) has no member
// satisfying the "parentId not in set" root rule, so nothing above would
// ever reach it; a final sweep treats any shape DFS never visited as an
// additional root, so a doc-level cycle degrades to "some deterministic
// order, no shape dropped, no infinite loop" rather than an outage.
//
// Purity/determinism: a pure function of (index, id) only — never input
// array order, never Map/Set iteration order (both are looked up, not
// relied on for ordering; every level is explicitly re-sorted).
import type { Shape } from './shape.js'

function compareByIndexThenId(a: Shape, b: Shape): number {
  if (a.index < b.index) return -1
  if (a.index > b.index) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export function orderForPaint(shapes: Shape[], _byId: ReadonlyMap<string, Shape>): Shape[] {
  const inSet = new Set<string>(shapes.map((sh) => sh.id))
  const childrenByParent = new Map<string, Shape[]>()
  for (const sh of shapes) {
    const siblings = childrenByParent.get(sh.parentId)
    if (siblings) siblings.push(sh)
    else childrenByParent.set(sh.parentId, [sh])
  }

  const out: Shape[] = []
  const visited = new Set<string>()
  const visit = (sh: Shape): void => {
    if (visited.has(sh.id)) return // cycle guard
    visited.add(sh.id)
    out.push(sh)
    const children = childrenByParent.get(sh.id)
    if (!children) return
    for (const child of children.slice().sort(compareByIndexThenId)) visit(child)
  }

  const roots = shapes.filter((sh) => !inSet.has(sh.parentId)).sort(compareByIndexThenId)
  for (const root of roots) visit(root)

  // Sweep: shapes never reached above (parentId cycle entirely within the
  // input set — see module header) still get painted, deterministically.
  const leftover = shapes.filter((sh) => !visited.has(sh.id)).sort(compareByIndexThenId)
  for (const sh of leftover) visit(sh)

  return out
}
