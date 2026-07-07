# Canvas Controls Phase 3: Behaviours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec §9 item 3: the side panel becomes resizable (drag grip, collapsed rail, wide = face-to-face two-up reflow), **Present** ships (P binding, presenter broadcast via presence meta, viewer follow with opt-out), and the command bar gains the dock-edge setting with a vertical variant.

**Architecture:** Three independent tracks. (a) *Panel layout*: a `chrome/panelLayout.ts` module store (localStorage-persisted width + collapsed flag) drives `SidePanel`; a drag grip on the panel's left edge resizes; below a snap threshold the panel renders as a 32px rail. (b) *Present*: rides the EXISTING sync presence channel — `App.tsx`'s `getUserPresence` already publishes custom `meta` (the spatial stamp); a tldraw `atom` adds `presenting: true` to the local user's presence meta, every client derives "who is presenting" from collaborator presence (late joiners included, disconnects self-heal via presence expiry), viewers `editor.startFollowingUser(...)` with local opt-out. NO server changes. (c) *Dock*: `settings.ts` gains `dockEdge`; CommandBar renders a vertical icon-only variant for left/right and a right-click dock menu.

**Tech Stack:** tldraw 5.1.0 — verified: `atom` re-exported from 'tldraw' (runtime-checked), `editor.startFollowingUser/stopFollowingUser` exist, laser tool id is `'laser'`. React 19, bun plain-assert tests.

**Working rules:** repo root; gates `bun run typecheck && bun scripts/run-tests.ts && bun run build`; style tabs/single-quotes/no-semicolons; NEVER import the tldraw module graph in bare bun tests; headless smoke via Caddy :8080 per `docs/headless-browser.md` (`window.__ewEditor` hook). Panel components stay OUTSIDE tldraw context (editor prop + `useValue` only).

**Files to read first (any task):** spec §3-§5 + §9 item 3 of `docs/superpowers/specs/2026-07-07-canvas-controls-ux-design.md`; `client/src/chrome/SidePanel.tsx`, `PanelPages.tsx`, `PanelTile.tsx`, `settings.ts`, `CommandBar.tsx`; `client/src/App.tsx` (getUserPresence meta stamp); `client/src/av/bridge.ts`.

---

### Task 1: Panel layout store + resize grip + collapsed rail

**Files:** Create `client/src/chrome/panelLayout.ts` + `panelLayout.test.ts`; modify `chrome/SidePanel.tsx`, `chrome/PanelPages.tsx` (accept a `compact`/width hint if needed).

- [ ] `panelLayout.ts`: module store (pattern: `settings.ts`), localStorage key `ensembleworks.panelLayout.v1`, state `{ width: number; collapsed: boolean }`, default `{ width: 280, collapsed: false }`; clamp width to [180, min(720, 0.6 * innerWidth at read time — accept a `maxWidth` arg rather than reading window in the store, keep it pure)]; exports `usePanelLayout()`, `setPanelWidth(w)`, `setPanelCollapsed(b)`, `togglePanelCollapsed()`; defensive parse. TDD with a bare-bun test (localStorage shim before dynamic import): defaults, clamp, persist, subscribe, toggle.
- [ ] Resize grip in `SidePanel`: a 6px-wide vertical hit area on the panel's left edge (`cursor: ew-resize`, `data-testid="ew-panel-grip"`), pointer-capture drag (`setPointerCapture`, track `e.clientX`, width = `window.innerWidth - clientX` clamped); **below 140px during drag → snap**: `setPanelCollapsed(true)` (store width unchanged); dragging outward from the rail re-expands. Double-click grip → `togglePanelCollapsed()`. While dragging, disable text selection (`user-select: none` on body or overlay).
- [ ] Collapsed rail render mode in `SidePanel` (width 32, `data-testid="ew-panel-rail"`): avatar dots top-to-bottom — one per participant (self first), colour-tinted circle with initial, ring when `isSpeaking` (from the bridge snapshot; match tile ring colour semantics); blinking rec dot when scribes present; an expand chevron button at the bottom (`data-testid="ew-panel-expand"`) → `setPanelCollapsed(false)`. The rail keeps the grip (drag to expand).
- [ ] Gates + commit `feat(panel): resizable width, snap-to-rail, collapsed rail`.

### Task 2: Wide = face-to-face reflow

**Files:** modify `chrome/PanelPages.tsx` (and `PanelTile.tsx` only if tile internals need a size prop).

- [ ] When panel width ≥ 480px (constant `TWO_UP_MIN_WIDTH` with comment tying it to spec §3 "past ~40%"), each page section lays tiles in a 2-column grid (`display: grid; gridTemplateColumns: '1fr 1fr'; gap`) and tile height grows (e.g. 84 → `clamp` up to ~150 based on column width; keep it simple: two size steps, comment them). Below the threshold: existing single column. Pass the current width down from `SidePanel` (prop, not another store read, so the reflow logic is testable/obvious).
- [ ] Gates + a quick headless sanity (drag wide → two-up) + commit `feat(panel): two-up face-to-face reflow at wide widths`.

### Task 3: Presenting state over presence meta

**Files:** Create `client/src/chrome/present.ts`; modify `client/src/App.tsx`.

- [ ] `present.ts`: `export const presentingAtom = atom('ew presenting', false)` (import `atom` from 'tldraw' — this file IS tldraw-coupled, so no bare-bun test; keep it tiny), plus `usePresenter(editor)` helper: `useValue` deriving `{ userId, userName } | null` from `editor.getCollaborators().find(c => (c.meta as { presenting?: boolean } | undefined)?.presenting)`, and `useIsPresenting()` = `useValue` over the atom. Doc comment: why presence meta (no server changes, late joiners see it, presence expiry self-heals on disconnect).
- [ ] `App.tsx` `getUserPresence`: extend the returned meta to `{ stamp, presenting: presentingAtom.get() }` — reading the atom inside this reactive derivation makes presence republish when it flips (same mechanism as the stamp's reactive inputs; note this in the comment).
- [ ] Gates + commit `feat(present): presenting flag rides presence meta`.

### Task 4: Present UX — button, presenter strip, viewer follow

**Files:** modify `chrome/CommandBar.tsx`, `chrome/SidePanel.tsx`, `chrome/present.ts` (helpers as needed).

- [ ] **P̲resent button** in CommandBar between the ⋯ cluster and zoom (spec §4 placement; green accent `wm.ok` or `sealBlue`, `data-testid="ew-bar-present"`, accelerator 'p' — add to the bar's OWN keydown handler alongside plugin items, NOT a tldraw tool kbd; label rendered with the underline treatment). Hidden while someone ELSE is presenting.
- [ ] **Presenter mode** (local atom true): the bar's normal contents collapse to a slim strip: laser button (arms tools['laser']), n̲ote button, **END PRESENTING** (`data-testid="ew-bar-end-present"`), rec-dot indicator when scribes present. Esc (window keydown, guarded like the accelerators — not while typing/editing) OR the END button → atom false, restore bar.
- [ ] **Viewer mode** (a collaborator's presenting meta is set, and it's not me): auto `editor.startFollowingUser(presenterId)` once per presenter-session (track opt-out in local state so STOP doesn't re-trigger); bar contents replaced by "Following ⟨name⟩ · **STOP FOLLOWING**" (`data-testid="ew-bar-stop-following"`); STOP or Esc → `editor.stopFollowingUser()` + opted-out flag (chrome stays minimal per spec §5 until presenting ends). When presenting ends (meta gone): `stopFollowingUser()`, restore bar, clear opt-out.
- [ ] **Panel override**: while anyone presents (self or other), SidePanel renders the collapsed rail regardless of the layout store (temporary override — store untouched, restores on end; presenter's dot gets a ring). Canvas dim for viewers: skip actual dimming (tldraw's follow border already signals) — record as an as-built delta rather than adding an overlay.
- [ ] Gates + commit `feat(present): presenter strip, viewer follow with opt-out, panel rail override`.

### Task 5: Dock-edge setting + vertical bar

**Files:** modify `chrome/settings.ts` (+ test), `chrome/CommandBar.tsx`, `chrome/PanelFooter.tsx`, `client/src/ui.tsx` (only if slot placement needs a wrapper).

- [ ] `settings.ts`: add `dockEdge: 'bottom' | 'left' | 'right' | 'top'` (default 'bottom', defensive parse rejects unknown values → default). Extend the test.
- [ ] CommandBar: read dockEdge. 'bottom'/'top' → horizontal as today; 'left'/'right' → vertical column, icon-only (labels dropped; `title` carries "label (KEY)"), overflow menu + zoom dropdown open away from the docked edge (`bottom/top/left/right` CSS on the popover per edge). Positioning: the Toolbar slot is anchored bottom-center by tldraw's layout — for non-bottom edges render the bar via a `position: fixed` wrapper positioned per edge WITHIN the canvas region (remember the side panel occupies the right ~280px+: compute `right` offset from the panel's current width via `usePanelLayout` + collapsed flag; add a comment). Verify the slot approach actually works before fighting it: rendering a fixed-position child from the Toolbar slot is legitimate; the slot's own container just ends up empty.
- [ ] Right-click (`onContextMenu`, preventDefault) on the bar → small popover "Dock to: bottom · left · top · right" (`data-testid="ew-bar-dock-menu"`), current edge marked, persists via settings.
- [ ] PanelFooter settings section: a dock-edge selector row (four small buttons) mirroring the same setting (discoverable path; right-click stays the fast path).
- [ ] Gates + headless sanity (set dockEdge left via settings UI → bar renders vertical on the left; restore bottom) + commit `feat(chrome): dock-edge setting with vertical command bar`.

### Task 6: Verification + final review

- [ ] Static gates. Headless smoke (fresh room): (1) grip drag narrows/widens panel, width persists across reload; (2) drag below 140 snaps to rail; expand chevron restores; double-click grip toggles; (3) wide drag → two-up tiles; (4) P starts presenting: bar becomes presenter strip, panel → rail; Esc ends it (single-client — viewer follow needs two contexts: open TWO pages on the same room in the harness, present in one, assert the other auto-follows (`editor.getInstanceState().followingUserId`... check actual API: `editor.getCameraOptions`? — use `getInstanceState().followingUserId` if present, else assert the banner testid) and STOP works; (5) right-click bar → dock left → vertical bar; dock bottom restores; (6) zero page errors. Two-browser-context check is REQUIRED for follow — Playwright supports two contexts on one page URL.
- [ ] Fix-loop, then final whole-phase review, then spec §9 item 3 as-built notes + memory update, commit.

## Deviation policy

As before — spec behaviour is authoritative, adapt to tldraw internals, record everything. Known sharp edges: bare-bun/tldraw imports; TldrawUiToolbarButton needs TldrawUiToolbar; panel components outside tldraw context; presence meta must stay JSON-serializable and small (it's broadcast on every presence update).
