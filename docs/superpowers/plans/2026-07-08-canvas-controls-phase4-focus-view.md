# Canvas Controls Phase 4: Terminal Focus View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec §7: focus a terminal to fill the canvas region — camera zoom-to-bounds + lock (uniform scale, aspect preserved by construction; letterbox = surrounding canvas, dimmed), panel and bar stay, exit via a persistent ⛶ button or Ctrl+Shift+Enter (never bare Esc — focused terminals own the keyboard). Purely local. Mechanism shape-agnostic; v1 arms it for terminal shapes only.

**Architecture:** A `chrome/focus.ts` tldraw atom (`focusedShapeIdAtom`, precedent: `present.ts`) + a `FocusOverlay` component in the `InFrontOfTheCanvas` slot (rendered alongside ContextualStylePanel via a fragment wrapper) that owns the whole lifecycle: entering (zoomToBounds with inset + `setCameraOptions({ isLocked: true })`), the dim matte (four absolutely-positioned rectangles around the shape's screen bounds — recomputed reactively), the ⛶ enter affordance (shown when exactly one terminal shape is selected), the ⛶ exit button, the capture-phase Ctrl+Shift+Enter listener (capture so a focused xterm can't swallow it), and self-healing exits (shape deleted, page changed, someone starts presenting → exit focus first). CommandBar disables canvas tools while focused (new `disabled` prop on BarButton); SidePanel page-header clicks exit focus before navigating.

**Verified APIs (tldraw 5.1.0):** `editor.zoomToBounds(bounds, opts)`, `editor.setCameraOptions({...editor.getCameraOptions(), isLocked: true})` (TLCameraOptions.isLocked confirmed), `editor.getShapePageBounds(id)`, `editor.pageToScreen`. Precedents in-repo: `present.ts` atom pattern, SidePanel `forcedRail` override, popover/dismissal patterns.

**Working rules:** as phases 1-3 (repo root; gates `bun run typecheck && bun scripts/run-tests.ts && bun run build`; tabs/single-quotes/no-semicolons; no tldraw imports in bare-bun tests; headless via Caddy :8080, `window.__ewEditor`).

**Read first:** spec §7 + §9 item 4 of `docs/superpowers/specs/2026-07-07-canvas-controls-ux-design.md`; `client/src/chrome/present.ts`, `ContextualStylePanel.tsx`, `CommandBar.tsx`, `barButtons.tsx`, `SidePanel.tsx`, `PanelPages.tsx`, `client/src/ui.tsx`; `client/src/terminal/TerminalShapeUtil.tsx` (how the shape captures keys — read enough to confirm the capture-phase chord approach).

---

### Task 1: Focus store + camera engine + overlay — DONE when committed

**Files:** Create `client/src/chrome/focus.ts`, `client/src/chrome/FocusOverlay.tsx`; modify `client/src/ui.tsx`.

- [ ] `focus.ts`: `focusedShapeIdAtom = atom<TLShapeId | null>('ew focused shape', null)`; `useFocusedShapeId()`; `enterFocus(editor, shapeId)` — snapshot current camera options, `editor.zoomToBounds(editor.getShapePageBounds(shapeId), { inset: 16, animation: { duration: 220 } })` then lock via `setCameraOptions({ ...getCameraOptions(), isLocked: true })`, set atom; `exitFocus(editor)` — unlock (restore snapshotted isLocked false), clear atom (do NOT restore the previous camera — staying zoomed on the terminal you were working in is the less-jarring exit; comment this choice). Also export `FOCUSABLE_SHAPE_TYPES = new Set(['terminal'])` (v1; comment the shape-agnostic intent per spec §7).
- [ ] `FocusOverlay.tsx` (InFrontOfTheCanvas): three concerns —
  1. **Enter affordance**: when NOT focused and exactly one selected shape has `type` in FOCUSABLE_SHAPE_TYPES: a small ⛶ button (`data-testid="ew-focus-enter"`, title "Focus terminal (fills the canvas)") anchored top-right of the selection screen bounds (reuse ContextualStylePanel's bounds/mid-gesture patterns) → `enterFocus`.
  2. **Focused state**: dim matte — compute the shape's screen bounds reactively (`useValue`: `getShapePageBounds` → `pageToScreen` corners); render four divs (top/bottom/left/right strips, `background: rgba(238,233,221,0.82)` to match the mockups' paper matte, `pointerEvents: 'auto'` so clicks on the matte don't reach the canvas — clicking the matte does NOT exit, comment why: too easy to fat-finger next to a terminal you're typing in). Persistent exit button top-right of the canvas region (`data-testid="ew-focus-exit"`, label "⛶ exit focus · Ctrl+⇧+⏎") → `exitFocus`.
  3. **Chord + self-healing**: window keydown CAPTURE-phase listener for Ctrl+Shift+Enter (also Cmd+Shift+Enter; `e.stopPropagation()` + preventDefault before xterm sees it) → exit. Effects: focused shape deleted (`getShape(id)` null) → exit; `getCurrentPageId()` changed since entry → exit; a presenter appears (usePresenter) or local presenting starts → exit focus first (Present wins — comment the precedence decision).
- [ ] `ui.tsx`: `InFrontOfTheCanvas` becomes a small component rendering `<><ContextualStylePanel /><FocusOverlay /></>`.
- [ ] Gates + commit `feat(focus): terminal focus view — camera lock, matte, chord exit`.

### Task 2: Chrome integration — bar disabled, panel nav exits

**Files:** modify `client/src/chrome/barButtons.tsx`, `CommandBar.tsx`, `PanelPages.tsx` (and `SidePanel.tsx` if the prop path needs it).

- [ ] `barButtons.tsx`: `BarButton` gains `disabled?: boolean` (native button disabled + reduced opacity + cursor default; keep testids).
- [ ] `CommandBar.tsx`: while `useFocusedShapeId()` is non-null — disable native tool buttons, plugin bar items and the ⋯ trigger (Present button and zoom stay active per spec §7); the bar's plugin-accelerator keydown handler and the 'p' branch skip tool accelerators while focused (guard at the top: focused → only 'p' allowed). Comment: laser/note remain reachable by first exiting focus.
- [ ] `PanelPages.tsx`: page-header click and "+ new page" — when focused, call `exitFocus(editor)` before navigating (import from focus.ts; one-line guard each).
- [ ] Gates + commit `feat(focus): bar disabled + panel nav exits while focused`.

### Task 3: Verification + final review

- [ ] Static gates. Headless smoke (fresh room): create a terminal (M), select it → `ew-focus-enter` appears; click → camera zooms to the shape and locks (`__ewEditor.getCameraOptions().isLocked === true`), matte divs present, `ew-focus-exit` present; wheel/pan does not move the camera; bar tool buttons disabled (note button click is a no-op), zoom menu still opens; pressing 'n' does nothing; Ctrl+Shift+Enter exits (camera unlocked, matte gone); re-enter then click a page header → focus exits AND page changes; re-enter then delete the terminal via editor API → focus self-heals. Present-wins: enter focus, press P → focus exited, presenter strip shows. Zero page errors.
- [ ] Fix-loop, final whole-phase review, spec §9 item 4 as-built notes + memory update, commit.

## Deviation policy

As before. Terminal keyboard capture is the risk zone: if the capture-phase chord doesn't beat xterm in practice, try `keydown` on `document` with `capture: true` FIRST and report what the headless run shows; escalate rather than shipping an exit that only works when the terminal isn't focused (that's the one behaviour spec §7 explicitly forbids).
