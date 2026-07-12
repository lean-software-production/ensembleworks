// Shared tool infrastructure (built once here in C4, reused by every tool
// factory in C4-C6, and meant to be reused again by the arrow/transform tools
// in C7/C8): a ToolContext closes over an Editor and maintains a
// CanvasDocument snapshot + SpatialIndex pair, refreshed AT MOST ONCE PER DOC
// COMMIT — never per pointer event. This is the cadence input.ts's Tool<S>
// doc comment mandates ("SPATIAL-INDEX CADENCE") and canvas-model's
// spatial-index.ts STALENESS CONTRACT costs against: rebuilding a grid index
// on every pointermove would be O(shapes) per mouse-move frame, which the
// staleness contract explicitly says is not the model — mid-drag correctness
// instead comes from the tool reading LIVE selection state and the editor's
// own tolerant apply (see select.ts's dragging state).
//
// LAZY REBUILD (load-bearing, not an optimization nicety): the commit
// listener does NOT rebuild — it only marks the pair dirty; the rebuild
// happens on the next snapshot()/hitTestTopmost()/queryMarquee() call that
// finds the flag set. Rationale: the hot drag paths (select.ts's
// drag-translate, create.ts's drag-to-size) COMMIT once per pointermove
// (script.ts's run() applies once per event) and never query the context
// mid-gesture — an eager rebuild-in-listener would therefore run
// dumpModel+buildSpatialIndex (both O(shapes)) once per mouse event for
// results nobody reads, exactly the per-pointermove cost the cadence rule
// exists to forbid. Lazily, a 50-move drag triggers ZERO rebuilds, and the
// first query after the gesture triggers exactly ONE (pinned by
// tool-context.test.ts via the injected builder below).
//
// IDENTITY SEMANTICS: snapshot() returns a stable (===) reference between
// REBUILDS — i.e. identity now changes at the first query AFTER a commit,
// not at the commit itself. Substance for a renderer memoizing on snapshot
// identity is unchanged: a new reference still appears iff the doc changed
// since the reference was handed out; the only shift is WHEN (pull, on next
// read, rather than push, at commit time).
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
  type Bounds,
  type CanvasDocument,
  type SpatialIndex,
} from '@ensembleworks/canvas-model'
import { dumpModel } from '@ensembleworks/canvas-doc'
import type { Editor } from '../editor.js'
import type { Point } from '../intents.js'

export interface ToolContext {
  readonly editor: Editor
  /** The CanvasDocument snapshot as of the last rebuild. Stable (===)
   * between rebuilds; a fresh reference appears at the first
   * snapshot()/hitTestTopmost()/queryMarquee() call after a doc commit (see
   * IDENTITY SEMANTICS in the module header). A tool holding one across a
   * single event's onEvent call sees a consistent view. */
  snapshot(): CanvasDocument
  /** hitTestTopmost against the current index+snapshot pair (see
   * canvas-model/spatial-index.ts) — `point` is WORLD space; the caller
   * (a tool) converts screen->world via screenToWorld before calling. */
  hitTestTopmost(point: Point): string | null
  /** queryMarquee against the current index+snapshot pair. `bounds` is WORLD
   * space. */
  queryMarquee(bounds: Bounds, mode: 'intersect' | 'contain'): string[]
  /** Unsubscribe the context's doc listener. MUST be called when the
   * context's owner is done with it — Seam D: on unmount (React
   * strict-mode's double-mount, room switches, and HMR all construct fresh
   * contexts, and every undisposed predecessor keeps its doc listener
   * registered forever, re-marking itself dirty on every commit and paying
   * an O(shapes) rebuild on any accidental later query). After dispose()
   * the context's queries still answer, but from the last-built snapshot —
   * permanently stale by design. Call it once; whether a second call is a
   * no-op is the underlying engine's unsubscribe contract, not promised
   * here. */
  dispose(): void
}

export interface ToolContextOpts {
  /** Test seam: replaces buildSpatialIndex so a test can count rebuilds
   * (asserting the lazy cadence: ZERO rebuilds during an unqueried
   * multi-commit drag, exactly ONE on the next query) or substitute a
   * canned index. Production callers omit it. */
  readonly buildIndex?: (doc: CanvasDocument) => SpatialIndex
}

/** Build a ToolContext for `editor`. Call ONCE per Editor instance (e.g. once
 * in canvas-react, Seam D, alongside the Editor itself) and pass the same
 * ToolContext into every tool factory (createSelectTool/createHandTool/
 * createCreateTool, …) — that sharing is the whole point: one snapshot/index
 * pair serving every tool, rather than each tool maintaining its own
 * redundant copy. Pair every createToolContext with a dispose() call (see
 * ToolContext.dispose). */
export function createToolContext(editor: Editor, opts: ToolContextOpts = {}): ToolContext {
  const buildIndex = opts.buildIndex ?? buildSpatialIndex
  let snap = dumpModel(editor.doc)
  let index = buildIndex(snap)
  let dirty = false
  const unsubscribe = editor.doc.subscribe(() => { dirty = true })

  function fresh(): { snap: CanvasDocument; index: SpatialIndex } {
    if (dirty) {
      dirty = false
      snap = dumpModel(editor.doc)
      index = buildIndex(snap)
    }
    return { snap, index }
  }

  return {
    editor,
    snapshot: () => fresh().snap,
    hitTestTopmost: (point) => {
      const { snap: s, index: i } = fresh()
      return hitTestTopmostIndexed(i, s, point)
    },
    queryMarquee: (bounds, mode) => {
      const { snap: s, index: i } = fresh()
      return queryMarqueeIndexed(i, s, bounds, mode)
    },
    dispose: unsubscribe,
  }
}
