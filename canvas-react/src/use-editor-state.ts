// Hooks bridging canvas-editor's two independent state sources (editor-local
// EditorState — camera/selection/hover/editingId — and the CRDT-backed
// CanvasDocument the ToolContext maintains) into React's re-render cycle via
// useSyncExternalStore (uSES). Both hooks exist because the two sources have
// DIFFERENT snapshot-identity contracts (see each function's doc comment),
// and uSES requires getSnapshot to be well-behaved (same input state =>
// Object.is-equal output) or it re-renders in a tight loop — this module is
// where that requirement gets satisfied for each source.
import { useMemo, useSyncExternalStore } from 'react'
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import type { Editor, EditorState, ToolContext } from '@ensembleworks/canvas-editor'

export interface EditorStateStore {
  readonly subscribe: (onStoreChange: () => void) => () => void
  readonly getSnapshot: () => EditorState
}

/**
 * The cached-snapshot wrapper `useEditorState` rides on — factored out to a
 * plain (non-hook) function so its identity behavior is testable without
 * rendering anything (see use-editor-state.test.ts's "same ref between
 * notifications" probe).
 *
 * WHY editor.get() ALONE WOULD INFINITE-LOOP uSES: editor.ts's `get()` is
 * documented as building a FRESH snapshot object on every call ("two get()
 * calls never compare reference-equal, even with no state change in
 * between" — Object.freeze doesn't change that; a new object is still a new
 * reference). uSES calls `getSnapshot` on EVERY render — not only after a
 * `subscribe` notification — specifically to check, via `Object.is`,
 * whether the value actually changed since last render; if `getSnapshot`
 * returned `editor.get()` directly, that check would ALWAYS report "changed"
 * (a brand-new object, even when nothing moved), so React would re-render,
 * call getSnapshot again, see ANOTHER new object, and re-render again —
 * forever. This is not a performance nit, it's a hang.
 *
 * THE FIX: cache one `EditorState` reference and only replace it inside the
 * `editor.subscribe` listener — which editor.ts documents fires "at most
 * once per apply()/applyAll() call... PER-INTENT-TYPE" (i.e. only on an
 * ACTUAL view-intent, not on every render). Between two such fires,
 * `getSnapshot` keeps returning the SAME reference, satisfying uSES's
 * `Object.is` check and letting React bail out of re-rendering — this is
 * exactly the "cached snapshot strategy" the exit gate asks to be probed
 * (call getSnapshot twice with no intervening notification; same ref).
 */
export function createEditorStateStore(editor: Editor): EditorStateStore {
  let cached = editor.get()
  return {
    subscribe: (onStoreChange) =>
      editor.subscribe(() => {
        cached = editor.get()
        onStoreChange()
      }),
    getSnapshot: () => cached,
  }
}

/** React bridge for EditorState (camera/selection/hover/editingId). The
 * store is rebuilt (a fresh `cached` closure) only when `editor` itself
 * changes identity — the common case is one Editor for a component's whole
 * lifetime, so this typically builds once.
 *
 * THIRD ARGUMENT (getServerSnapshot): required by React whenever
 * useSyncExternalStore runs inside react-dom/server (renderToStaticMarkup/
 * renderToString) — omitting it THROWS there ("Missing getServerSnapshot"),
 * which is exactly how shape-layer.test.ts's renderToStaticMarkup calls
 * surfaced this. There is no server/client divergence for canvas-react's
 * state (no window/document read feeds it), so the server snapshot is
 * simply the same `getSnapshot` — this package has no actual SSR use today,
 * but the test rig's renderToStaticMarkup calls exercise the same code path
 * React's real server renderer would. */
export function useEditorState(editor: Editor): EditorState {
  const store = useMemo(() => createEditorStateStore(editor), [editor])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * React bridge for the CanvasDocument (the CRDT-backed doc, via the shared
 * ToolContext — canvas-react never touches CanvasDoc/loro-crdt directly,
 * per the boundary rule; it only ever sees the CanvasDocument type,
 * @ensembleworks/canvas-model's plain data shape).
 *
 * UNLIKE useEditorState, no caching wrapper is needed here: `subscribe` =
 * `editor.doc.subscribe` (the CanvasDoc contract's own listener — fires on
 * every commit(), local or remote) and `getSnapshot` = `toolContext.
 * snapshot` are used DIRECTLY, because tool-context.ts's own documented
 * IDENTITY SEMANTICS already give uSES exactly what it needs: `snapshot()`
 * "returns a stable (===) reference between REBUILDS" and only produces a
 * new reference "at the first snapshot()/hitTestTopmost()/queryMarquee()
 * call after a doc commit" — i.e. it is ALREADY a valid uSES getSnapshot on
 * its own (repeat calls with no intervening commit are reference-equal),
 * unlike editor.get() above. `editor.doc.subscribe` is wrapped in an arrow
 * function (not passed bare) because LoroCanvasDoc's `subscribe` is an
 * ordinary method reading `this.doc` internally — passed as a bare function
 * reference it would lose its receiver and throw; the wrapper preserves the
 * call as `toolContext.editor.doc.subscribe(...)`, not a detached call.
 *
 * `getServerSnapshot` (third argument): same reasoning as useEditorState's —
 * required by react-dom/server or useSyncExternalStore throws; `snapshot`
 * has no server/client divergence, so the server snapshot is the same
 * function.
 */
export function useDocSnapshot(toolContext: ToolContext): CanvasDocument {
  const subscribe = useMemo(
    () => (onStoreChange: () => void) => toolContext.editor.doc.subscribe(onStoreChange),
    [toolContext],
  )
  return useSyncExternalStore(subscribe, toolContext.snapshot, toolContext.snapshot)
}
