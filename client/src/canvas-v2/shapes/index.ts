/**
 * REGISTRATION ARCHITECTURE (Unit 10 / Seam E, ratified deviation from the
 * phase-3 plan's literal text — recorded here per the controller's
 * instruction).
 *
 * The plan's literal text puts the six custom shape bodies in
 * `canvas-react/src/shapes/`. That is OVERRIDDEN: they live here, in
 * `client/src/canvas-v2/shapes/`, and are wired into canvas-react's
 * shapeRegistry by `registerCanvasV2Shapes()` below — a CLIENT-OWNED
 * function, not a canvas-react export, called out-of-package.
 *
 * WHY: the heavy bodies hold real client-owned session state: xterm.js + a
 * raw WebSocket to the terminal gateway (terminal), a LiveKit `Room`/`Track`
 * reached through client/src/screenshare/store.ts's module-level registry
 * (screenshare). None of that — xterm, livekit-client, the gateway WS
 * protocol, or this app's identity/presence modules — belongs in
 * canvas-react: that package's charter (see its package.json deps:
 * canvas-editor + canvas-model + react ONLY) is to stay a clean,
 * framework-shaped rendering substrate with NO knowledge of what a
 * "terminal" or "screen share" even is. Importing xterm/livekit/identity
 * into canvas-react to satisfy these shapes would drag heavy, app-specific
 * dependencies into a package every future canvas consumer (not just this
 * app) would inherit.
 *
 * The registry + `ShapeBodyProps` + `embedLifecycle.ts`'s
 * `createLifecycleRegistry` contracts exist EXACTLY for this: out-of-package
 * registration by a caller that owns the heavy dependencies. `registerShape`
 * doesn't care who calls it or from which package; `ShapeBodyProps` is a
 * closed, self-sufficient contract (`{ shape, snapshot, editorState }`) any
 * component can implement without canvas-react needing to know it exists.
 * This module is that caller.
 *
 * WHO CALLS `registerCanvasV2Shapes()`: nobody, yet, on any LIVE code path.
 * G3's `CanvasV2App` (a future seam) is the intended caller, once it exists
 * to mount canvas-react's `Viewport`/`ShapeLayer`/`EmbedLayer` at all. Until
 * then this module is inert, imported by nothing reachable from
 * `client/src/main.tsx` — see the ZERO EXPOSURE note in this unit's task
 * text and the exit-gate's `git diff --stat` check. `App.tsx`/`main.tsx`/
 * `plugins.ts` are untouched by this unit.
 *
 * ---------------------------------------------------------------------------
 * INTERACTIVE-CONTENT EVENT POLICY (decided once, here; applied identically
 * by every Seam-E body) — see interactionMode.ts for the full derivation and
 * the pure state machine. One-paragraph summary: a shape body has two
 * states, 'idle' (a single click selects the shape — events reach
 * Viewport/the canvas's own tools untouched) and 'focused' (entered via
 * double-click on the body; pointer/keyboard events are swallowed via
 * stopPropagation so typing/dragging/scrolling inside the body never also
 * drives canvas tools; Escape or a click outside the body's own DOM exits
 * back to 'idle'). This is a deliberately minimal v1 — no tldraw-editingId
 * equivalent exists for a shape body in this contract (`ShapeBodyProps` is
 * read-only: `{ shape, snapshot, editorState }`, no `editor`/`toolContext`
 * handle to call anything like `setEditingShape`), so "focus" here is
 * ENTIRELY LOCAL React state per body, independent of `editorState.editingId`
 * (which is a different, editor-level concept — e.g. a future dedicated
 * edit/text tool — out of this unit's scope). Full parity with the legacy
 * tldraw builds (double-Esc disambiguation, title-bar drag-to-move via
 * `editor.updateShape`, shared-doc mutations like renaming or bumping a
 * synced `rev`) is NOT reproduced here for the same structural reason: a
 * shape body in this contract cannot mutate the canvas document at all.
 * Every such gap is called out at its own shape body and summarized in this
 * unit's completion report. That parity work is G2-golden/Phase-4 territory.
 *
 * E2 (neko/roadmap/file-viewer) extends the registration below.
 */
import { registerShape, type ShapeBodyProps } from '@ensembleworks/canvas-react'
import { TerminalShape } from './TerminalShape.js'
import { ScreenshareShape } from './ScreenshareShape.js'
import { IframeShape } from './IframeShape.js'

export type { ShapeBodyProps }
export { canvasV2EmbedLifecycles } from './embedLifecycles.js'

let registered = false

/** Register the canvas-v2 shape bodies into canvas-react's shapeRegistry.
 * Idempotent (a second call is a silent no-op) — `registerShape` itself
 * tolerates repeat calls (replace semantics), but this module additionally
 * guards so a future caller (G3) invoking this more than once (e.g. across
 * hot-reload) doesn't matter either way. NOT CALLED from any live code path
 * in this unit — see REGISTRATION ARCHITECTURE above. */
export function registerCanvasV2Shapes(): void {
  if (registered) return
  registered = true
  registerShape('terminal', TerminalShape, { embed: true })
  registerShape('iframe', IframeShape, { embed: true })
  registerShape('screenshare', ScreenshareShape, { embed: true })
}
