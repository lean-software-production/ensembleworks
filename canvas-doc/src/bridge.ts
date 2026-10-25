import { type CanvasDocument, makeDocument } from '@ensembleworks/canvas-model'
import type { CanvasDoc } from './canvas-doc.js'

// Both functions here are typed against the CanvasDoc INTERFACE, not the
// concrete LoroCanvasDoc class — they only ever call interface methods
// (list*/put*/reparent). Interface typing (a) lets interface-typed holders
// (canvas-editor's Editor.doc is declared as CanvasDoc, per its
// engine-swappability test) pass their doc straight in, and (b) leaves this
// module dependent only on canvas-doc.ts's types, so loro-canvas-doc.ts can
// itself import dumpModel (its repair() does) without an import cycle.

// Load a pure model document into a CanvasDoc: put parents before children so
// reparent targets exist, then wire the tree edges, then carry pages and
// bindings into their own top-level maps (A1) so the full document —
// including binding endpoints and page metadata — round-trips through Loro.
// reparent() throws if a shape's parentId names an unknown shape —
// topoByDepth's ordering guarantees parents are put first, so this only fires
// on a genuinely orphaned shape in the input model, which is a fail-fast bug
// we want surfaced here.
export function loadModel(doc: CanvasDoc, model: CanvasDocument): void {
  const ordered = topoByDepth(model)
  for (const s of ordered) doc.putShape(s)
  for (const s of ordered) doc.reparent(s.id, s.parentId)
  for (const p of model.pages) doc.putPage(p)
  for (const b of model.bindings) doc.putBinding(b)
  for (const a of model.assets) doc.putAsset(a)
}

// Dump the CanvasDoc back to a pure model document, including pages, bindings
// and assets (A1). The output is only invariant-clean once all putShape+reparent
// pairs of a batch have completed: dumped mid-batch, transitional states may
// contain parentIds naming shapes not yet present.
//
// Wiring assets through here is load-bearing beyond this module:
// toolContext.snapshot() IS dumpModel(editor.doc), so every ShapeBody's
// snapshot prop carries assets/assetById once this line does — the
// ImageShape renderer (Task R1) resolves assetId -> src off it with no new
// prop-threading.
export function dumpModel(doc: CanvasDoc): CanvasDocument {
  return makeDocument({ pages: doc.listPages(), shapes: doc.listShapes(), bindings: doc.listBindings(), assets: doc.listAssets() })
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
