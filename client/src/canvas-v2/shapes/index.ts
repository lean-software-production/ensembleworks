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
 * WHY: three of the six bodies (terminal, screenshare, and — this unit's own
 * finding, see NEKO/FILE-VIEWER EMBED RECLASSIFICATION below — neko and
 * file-viewer) hold real client-owned session state: xterm.js + a raw
 * WebSocket to the terminal gateway (terminal), a LiveKit `Room`/`Track`
 * reached through client/src/screenshare/store.ts's module-level registry
 * (screenshare), a same-origin iframe driving a neko WebRTC container plus
 * this client's own `identity.ts` (neko), and this client's own
 * presence/present-store plumbing (file-viewer). None of that — xterm,
 * livekit-client, the gateway WS protocol, or this app's identity/presence
 * modules — belongs in canvas-react: that package's charter (see its
 * package.json deps: canvas-editor + canvas-model + react ONLY) is to stay a
 * clean, framework-shaped rendering substrate with NO knowledge of what a
 * "terminal" or "screen share" even is. Importing xterm/livekit/identity
 * into canvas-react to satisfy these six shapes would drag heavy,
 * app-specific dependencies into a package every future canvas consumer
 * (not just this app) would inherit.
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
 * by every one of the six bodies) — see interactionMode.ts for the full
 * derivation and the pure state machine. One-paragraph summary: a shape body
 * has two states, 'idle' (a single click selects the shape — events reach
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
 * ---------------------------------------------------------------------------
 * NEKO/FILE-VIEWER EMBED RECLASSIFICATION (a Task-E2 finding, recorded here
 * because it changes which shapes register with `{ embed: true }` — the
 * plan's own task split lists these two under "Task E2: … light bodies" and
 * asks this unit to "confirm none holds a live session by reading the
 * existing code" before trusting that categorization; re-reading
 * NekoShapeUtil.tsx and FileViewerShapeUtil.tsx found that BOTH do):
 *   - neko (client/src/neko/NekoShapeUtil.tsx): a same-origin iframe driving
 *     a live neko WebRTC container, plus a 400ms polling interval that
 *     enforces the user's mute preference against neko's own auto-unmute
 *     behavior (`useEffect` with `setInterval(…, 400)`). Unmounting on cull
 *     would drop the WebRTC session exactly like the plain iframe/screenshare
 *     shapes this plan already treats as embeds — there is no principled
 *     reason to cull-unmount a neko tile but not an iframe tile.
 *   - file-viewer (client/src/file-viewer/FileViewerShapeUtil.tsx): a
 *     sandboxed iframe with a scroll-position bridge (postMessage) and a
 *     presenter/follower protocol built on top of it. Same iframe-document-
 *     loss risk the plan's own file-viewer parenthetical already flagged
 *     ("file-viewer file fetches?") — unmounting reloads the file and drops
 *     the in-progress scroll position/presentation state.
 * Both are therefore registered with `{ embed: true }` below, alongside
 * terminal/iframe/screenshare — five of the six kinds are embeds; only
 * roadmap (a plain `fetch` + local React state, no persistent connection or
 * iframe document — see RoadmapShape.tsx) is not.
 */
import { registerShape, type ShapeBodyProps } from '@ensembleworks/canvas-react'
import { TerminalShape } from './TerminalShape.js'
import { ScreenshareShape } from './ScreenshareShape.js'
import { IframeShape } from './IframeShape.js'
import { NekoShape } from './NekoShape.js'
import { RoadmapShape } from './RoadmapShape.js'
import { FileViewerShape } from './FileViewerShape.js'

export type { ShapeBodyProps }
export { canvasV2EmbedLifecycles } from './embedLifecycles.js'

let registered = false

/** Register all six canvas-v2 shape bodies into canvas-react's shapeRegistry.
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
  registerShape('neko', NekoShape, { embed: true })
  registerShape('screenshare', ScreenshareShape, { embed: true })
  registerShape('file-viewer', FileViewerShape, { embed: true })
  registerShape('roadmap', RoadmapShape) // not an embed — see module header
}
