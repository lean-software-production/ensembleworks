import { type CanvasDocument, makeDocument } from '@ensembleworks/canvas-model'
import type { LoroCanvasDoc } from './loro-canvas-doc.js'

// Load a pure model document into a CanvasDoc: put parents before children so
// reparent targets exist, then wire the tree edges. reparent() throws if a
// shape's parentId names an unknown shape — topoByDepth's ordering guarantees
// parents are put first, so this only fires on a genuinely orphaned shape in
// the input model, which is a fail-fast bug we want surfaced here in Phase 1.
export function loadModel(doc: LoroCanvasDoc, model: CanvasDocument): void {
  const ordered = topoByDepth(model)
  for (const s of ordered) doc.putShape(s)
  for (const s of ordered) doc.reparent(s.id, s.parentId)
}

// Dump the CanvasDoc back to a pure model document (pages/bindings are not held
// in the tree this phase — callers that need them keep them alongside).
export function dumpModel(doc: LoroCanvasDoc): CanvasDocument {
  return makeDocument({ pages: [], shapes: doc.listShapes(), bindings: [] })
}

// Shallowest-first so a child is never inserted before its parent. JS's Array
// sort is stable, so ties (e.g. multiple depth-0 roots) keep their input
// order — deterministic across runs.
function topoByDepth(model: CanvasDocument) {
  const depth = (id: string, guard = 0): number => {
    const s = model.byId.get(id)
    if (!s || !s.parentId.startsWith('shape:') || guard > 50) return 0
    return 1 + depth(s.parentId, guard + 1)
  }
  return [...model.shapes].sort((a, b) => depth(a.id) - depth(b.id))
}
