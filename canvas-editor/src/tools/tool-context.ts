// Shared tool infrastructure (built once here in C4, reused by every tool
// factory in C4-C6, and meant to be reused again by the arrow/transform tools
// in C7/C8): a ToolContext closes over an Editor and maintains a
// CanvasDocument snapshot + SpatialIndex pair, refreshed ONCE PER DOC COMMIT
// — never per pointer event. This is the cadence input.ts's Tool<S> doc
// comment mandates ("SPATIAL-INDEX CADENCE") and canvas-model's
// spatial-index.ts STALENESS CONTRACT costs against: rebuilding a grid index
// on every pointermove would be O(shapes) per mouse-move frame, which the
// staleness contract explicitly says is not the model — mid-drag
// correctness instead comes from the tool reading LIVE selection state and
// the editor's own tolerant apply (see select.ts's dragging state).
//
// WHY NOT canvas-doc's dumpModel(): dumpModel(doc: LoroCanvasDoc) is typed
// against the CONCRETE class, not the CanvasDoc interface — and editor.ts
// deliberately types Editor.doc as the interface (see editor.test.ts's "works
// against the CanvasDoc interface" case), so a plain CanvasDoc-typed value
// is not assignable to LoroCanvasDoc even when the runtime object actually is
// one (LoroCanvasDoc has private fields, which makes the interface type
// structurally narrower). Rebuilding the same makeDocument({pages, shapes,
// bindings}) call directly against the three CanvasDoc list* methods gets an
// identical CanvasDocument without that type mismatch, and without adding a
// LoroCanvasDoc-specific import to this clean-room package.
//
// HOOK CHOICE: editor.doc.subscribe (NOT editor.subscribe). editor.subscribe
// is EditorState's own store (camera/selection/hover/editingId — see
// editor.ts) and never fires for a pure doc mutation (applyAll's "doc-only
// batch notifies zero times" rule). editor.doc.subscribe is the CanvasDoc
// contract's own listener, which LoroCanvasDoc wires straight to the
// underlying Loro doc's subscribe — firing on every commit(), local OR
// imported (remote peers' edits included), which is exactly "any mutation"
// per the staleness contract's REBUILD CADENCE note.
import {
  buildSpatialIndex,
  hitTestTopmost as hitTestTopmostIndexed,
  queryMarquee as queryMarqueeIndexed,
  makeDocument,
  type Bounds,
  type CanvasDocument,
} from '@ensembleworks/canvas-model'
import type { Editor } from '../editor.js'
import type { Point } from '../intents.js'

export interface ToolContext {
  readonly editor: Editor
  /** The CanvasDocument snapshot as of the last doc commit (or construction,
   * if nothing has committed yet). Fresh reference each commit, stable
   * (===) between commits — a tool holding onto one across a single event's
   * onEvent call sees a consistent view. */
  snapshot(): CanvasDocument
  /** hitTestTopmost against the current index+snapshot pair (see
   * canvas-model/spatial-index.ts) — `point` is WORLD space; the caller
   * (a tool) converts screen->world via screenToWorld before calling. */
  hitTestTopmost(point: Point): string | null
  /** queryMarquee against the current index+snapshot pair. `bounds` is WORLD
   * space. */
  queryMarquee(bounds: Bounds, mode: 'intersect' | 'contain'): string[]
}

function readSnapshot(editor: Editor): CanvasDocument {
  return makeDocument({
    pages: editor.doc.listPages(),
    shapes: editor.doc.listShapes(),
    bindings: editor.doc.listBindings(),
  })
}

/** Build a ToolContext for `editor`. Call ONCE per Editor instance (e.g. once
 * in canvas-react, Seam D, alongside the Editor itself) and pass the same
 * ToolContext into every tool factory (createSelectTool/createHandTool/
 * createCreateTool, …) — that sharing is the whole point: one snapshot/index
 * pair, rebuilt on commit, serving every tool, rather than each tool
 * maintaining its own redundant copy. */
export function createToolContext(editor: Editor): ToolContext {
  let snap = readSnapshot(editor)
  let index = buildSpatialIndex(snap)
  editor.doc.subscribe(() => {
    snap = readSnapshot(editor)
    index = buildSpatialIndex(snap)
  })
  return {
    editor,
    snapshot: () => snap,
    hitTestTopmost: (point) => hitTestTopmostIndexed(index, snap, point),
    queryMarquee: (bounds, mode) => queryMarqueeIndexed(index, snap, bounds, mode),
  }
}
