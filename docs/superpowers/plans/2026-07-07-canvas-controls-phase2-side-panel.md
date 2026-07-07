# Canvas Controls Phase 2: Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The permanent right-hand side panel (spec §3, phasing §9 item 2): a true split pane holding room header + gauges, page sections with per-user video/initials tiles, "+ new page", the recording row, and a settings/help/about footer — replacing the floating SessionPanel + FacesRail and the pages-only top-left menu, and trimming ☰ to canvas verbs.

**Architecture:** The panel lives OUTSIDE the tldraw component (an App-level flex sibling), so it cannot use tldraw React context. Two bridges close the gap: (1) the `Editor` instance reaches App state via `onMount` and flows into the panel as a prop — tldraw's `useValue` works on any signal without context; (2) a module-level store `av/bridge.ts` (same `useSyncExternalStore` pattern as `screenshare/store.ts`) through which `AvOverlay` — which stays inside tldraw owning the LiveKit connection, spatial-audio loop, and leash overlay — publishes A/V state + actions, and through which panel tiles register their DOM elements so leashes keep anchoring to faces. `SessionPanel.tsx` and `rail.tsx` are deleted at cutover; `gauges.tsx` (VmStrip, LatencyPill) and `icons.tsx` (AvIconButton) are reused as-is. **Fixed panel width (280px) — resize/collapse/f2f reflow is Phase 3, not here.**

**Tech Stack:** React 19, tldraw 5.1.0, livekit-client 2.19.2 (track.attach pattern from `av/rail.tsx:79-90`), Bun plain-assert test scripts.

**Working rules:** repo root for all commands; gates are `bun run typecheck`, `bun scripts/run-tests.ts`, `bun run build`. Style: tabs, single quotes, no semicolons. NEVER import `client/src/plugins.ts` (or anything that pulls in `'tldraw'`) from a bare bun test — the tldraw module graph hangs the bun process on exit (verified Phase 1). Headless smoke runs against Caddy `:8080` per `docs/headless-browser.md`.

**Key existing interfaces (read the files; signatures verified 2026-07-07):**
- `av/useLiveKitRoom.ts`: `LiveKitState` = `{ status, room, peers: RemotePeer[], localParticipant, micEnabled, camEnabled, setMicEnabled, setCamEnabled, audioContext, localVideoTrack, localSpeaking, ... }`; `RemotePeer` = `{ identity, name, participant, videoTrack, gain, isSpeaking, readOnly }` (readOnly ⇒ scribe bot).
- `av/useSessionPulse.ts`: `SessionPulse` with `vm: VmStats | null`, `latencies: Record<string, LatencySample>`, `history: Record<string, number[]>`.
- `av/gauges.tsx`: `VmStrip({vm})`, `LatencyPill({latency, history})`.
- `av/icons.tsx`: `AvIconButton({kind: 'mic'|'camera'|'spatial', enabled, available, onClick})`.
- `av/SessionPanel.tsx` (dies at cutover, mine it first): roster-by-page grouping (lines 41-46), ColorDot palette picker incl. `retintLocalShares` (283-363), kick flow, ScribeRow, `data-roster-page`/`data-roster-scribes` test hooks.
- `av/rail.tsx` (dies at cutover): video `track.attach()` effect (79-90), speaking ring/pulse.
- `identity.ts`: `getRoomId()`, `setUserColor()`; `colors.ts`: `IDENTITY_COLORS`, `hexForColor`; contracts: `rawUserId`.
- `__APP_VERSION__` global (vite define).

---

### Task 1: The A/V bridge store

**Files:**
- Create: `client/src/av/bridge.ts`
- Test: `client/src/av/bridge.test.ts`
- Modify: `client/src/av/AvOverlay.tsx` (publish only — UI unchanged this task)

`bridge.ts` is a module-level store (pattern: `screenshare/store.ts` — listeners Set, version counter, `useSyncExternalStore`). It must NOT import `'tldraw'` or `'livekit-client'` runtime values (type-only imports fine) so the test can import it under bare bun.

- [ ] **Step 1: Write the failing test** `client/src/av/bridge.test.ts` (plain assert script): publishing a snapshot bumps subscribers exactly once per publish; `getAvSnapshot()` returns the last published object (reference equality); face-element registry set/get/delete round-trips; `setHoveredFace`/`getHoveredFace` round-trip and notify. Run `bun client/src/av/bridge.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `bridge.ts`**

```ts
/**
 * Bridge between AvOverlay (inside tldraw, owns the LiveKit connection,
 * spatial loop and leashes) and the side panel (an App-level flex sibling
 * outside tldraw context). Same module-store pattern as screenshare/store.ts.
 */
import { useSyncExternalStore } from 'react'
import type { LocalTrack, RemoteTrack } from 'livekit-client'
import type { LatencySample, VmStats } from './useSessionPulse'

export interface AvPanelPeer {
	id: string // raw user id
	name: string
	videoTrack: RemoteTrack | null
	isSpeaking: boolean
}

export interface AvPanelSnapshot {
	status: string
	micEnabled: boolean
	camEnabled: boolean
	standupMode: boolean
	localVideoTrack: LocalTrack | null
	localSpeaking: boolean
	peers: AvPanelPeer[]
	scribes: { id: string; name: string }[]
	vm: VmStats | null
	latencies: Record<string, LatencySample>
	latencyHistory: Record<string, number[]>
	kickingId: string | null
	kickError: string | null
	actions: {
		onMic: () => void
		onCam: () => void
		onStandup: () => void
		kick: (id: string, name: string) => void
	}
}
```

plus `publishAvSnapshot(snap: AvPanelSnapshot | null)`, `getAvSnapshot()`, `useAvSnapshot()` (useSyncExternalStore), a face-element registry (`registerFaceEl(id, el | null)`, `getFaceEl(id)`, backed by a Map — no notify needed, DOM reads are pull-based), and `setHoveredFace(id | null)` / `getHoveredFace()` / `useHoveredFace()` (notifies).

- [ ] **Step 3: AvOverlay publishes.** In `AvOverlay.tsx` add a `useEffect` that assembles the snapshot from existing state (`lk`, `pulse`, `standupMode`, `scribes`, kick state/handler — kick becomes `(id, name)` wrapping the existing `kickParticipant`) and calls `publishAvSnapshot(...)` on every relevant change, with a cleanup publishing `null` on unmount. Keep all existing rendering untouched this task. Note `RemotePeer.identity` is the prefixed user id — convert with `rawUserId` when building `AvPanelPeer.id`.

- [ ] **Step 4:** `bun client/src/av/bridge.test.ts && bun run typecheck` → green. Commit `feat(panel): av bridge store; AvOverlay publishes state`.

---

### Task 2: Split layout + panel skeleton

**Files:**
- Create: `client/src/chrome/SidePanel.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: App split.** In `App.tsx`, add `const [editor, setEditor] = useState<Editor | null>(null)`; in `handleMount` call `setEditor(editor)` (handleMount is a `useMemo` closure — move `setEditor` inside it; the memo deps stay `[]` because setState identity is stable). Replace the root `<div style={{ position: 'fixed', inset: 0 }}>` with a flex row: `<div style={{ position: 'fixed', inset: 0, display: 'flex' }}>`, first child `<div style={{ position: 'relative', flex: 1, minWidth: 0 }}>` wrapping `<Tldraw …>` (unchanged props), second child `{editor && <SidePanel editor={editor} />}`. The kicked overlay stays at root level.

- [ ] **Step 2: Panel skeleton.** `SidePanel.tsx`: `export function SidePanel({ editor }: { editor: Editor })`. Fixed `width: 280`, full-height flex column, `background: wm.panel` (warmer than canvas), `borderLeft: 1px solid ${wm.ruleStrong}`, `fontFamily: wm.sans`, `overflowY: 'auto'`, `data-testid="ew-side-panel"`. Contents this task: header row (room name from `getRoomId()` uppercase mono, participant count) + `<VmStrip vm={snap.vm} />` when present + connection-status line when `snap.status !== 'connected'` (mirror SessionPanel.tsx:161-170). Use `useAvSnapshot()`; render a quiet "connecting…" placeholder when the snapshot is null. Panel coexists with the old floating SessionPanel until Task 5 — expected, not a bug.

- [ ] **Step 3:** gates (`typecheck`, tests, `build`) green → commit `feat(panel): split layout + side panel skeleton`.

---

### Task 3: Page sections + user tiles

**Files:**
- Create: `client/src/chrome/PanelPages.tsx` (sections + tiles; split out `PanelTile.tsx` if it grows past ~250 lines)
- Modify: `client/src/chrome/SidePanel.tsx` (render sections)

- [ ] **Step 1: Roster derivation.** In `PanelPages.tsx`, derive with `useValue` on the editor (works outside context): pages via `editor.getPages()`, current page, self (`editor.user.getId/getName/getColor`), collaborators via `editor.getCollaborators()` — group participants by `currentPageId` exactly like `AvOverlay.tsx:32-57`. Merge A/V per participant by raw id: `videoTrack`/`isSpeaking` from `snap.peers` (self: `snap.localVideoTrack`/`localSpeaking`), latency from `snap.latencies`/`latencyHistory`.

- [ ] **Step 2: Sections.** Every page gets a section (even empty ones — the section list IS the page navigator). Header: page name (mono uppercase, `wm.sealBlue`), occupant count, `data-roster-page={pageName}` (keep the existing test hook). Current page's header gets an accent marker. Clicking a header → `editor.setCurrentPage(page.id)`. A `⋯` button per header opens a small popover (pattern: ColorDot's open-state div, `SessionPanel.tsx:308-361`) with **Rename** (inline `window.prompt` is fine for v1 → `editor.renamePage(page.id, name)`) and **Delete** (`window.confirm` then `editor.deletePage(page.id)`; disabled when it's the last page). Below all sections: a dashed **"+ new page"** button → `editor.createPage({ name: 'Page N' })` then `setCurrentPage` to it (`data-testid="ew-panel-new-page"`).

- [ ] **Step 3: Tiles.** Tile = rounded rect, height 84, `borderLeft: 4px solid <userColor>`, `data-testid={'ew-tile-' + rawId}`. Video: attach effect copied from `rail.tsx:79-90` (muted video, cover). No video → GitHub avatar `<img src={'https://github.com/' + handle + '.png'}>` if the LOCAL settings handle exists **for the local user only** (remote users' handles aren't synced — initials for them; note this in a comment), with `onError` falling back to initials; else big initials (first letters of first two words), tinted with the user colour on a soft tint background. Name bottom-left (+ " (you)"); speaking ⇒ ring (`outline: 2px solid ${wm.sealBlue}`). `LatencyPill` top-right. Own tile: `AvIconButton` mic/cam/spatial wired to `snap.actions`, plus the colour swatch + palette — port ColorDot from `SessionPanel.tsx:283-363` VERBATIM in behaviour (setUserColor → updateUserPreferences → setStyleForNextShapes → retintLocalShares), rendered as a swatch beside the name with a ▾ caret, `data-testid="ew-tile-color-swatch"`. Other tiles: mic/cam shown as static status icons if derivable (peer.videoTrack presence for cam; mic state isn't tracked per-peer today — omit mic status with a comment rather than invent state), click-anywhere → `editor.zoomToUser(prefixed id)` (check what id `zoomToUser` expects — AvOverlay passes `participant.id` which is the PREFIXED id), kick behind a hover-revealed button (reuse kick styling from `SessionPanel.tsx:253-273`, wired to `snap.actions.kick`).
- Leashes: on tile mount register the tile's face element via `registerFaceEl(rawId, el)` (cleanup with null); `onPointerEnter/Leave` → `setHoveredFace(rawId/null)`.

- [ ] **Step 4:** gates green; quick headless sanity (panel shows sections + own tile) → commit `feat(panel): page sections + user tiles`.

---

### Task 4: Recording row, footer, settings/help/about

**Files:**
- Create: `client/src/chrome/PanelFooter.tsx`, `client/src/chrome/settings.ts`
- Modify: `client/src/chrome/SidePanel.tsx`

- [ ] **Step 1: settings.ts** — tiny localStorage-backed store (module store + `useSyncExternalStore`, no tldraw imports): `{ githubHandle: string }` under key `ensembleworks.settings.v1`; `useSettings()`, `updateSettings(patch)`. Plain-bun test `settings.test.ts` (localStorage shim: `globalThis.localStorage ??= …` in-memory map) covering read/write/subscribe.

- [ ] **Step 2: Recording row.** In SidePanel below sections: when `snap.scribes.length > 0`, the blinking rec dot + scribe name + TRANSCRIPT button (port ScribeRow from `SessionPanel.tsx:368-422`, keep `data-roster-scribes` and the blink keyframes). Transcript button opens `TranscriptModal` (import from `../av/TranscriptModal` — it's a plain fixed overlay, works outside tldraw; verify by reading its imports, escalate if it uses tldraw context).

- [ ] **Step 3: Footer** (`PanelFooter.tsx`): top-bordered row pinned to the panel bottom (`marginTop: 'auto'`): **⚙ settings** → inline expanding section (not a tldraw dialog — we're outside that context) with a labelled "GitHub handle (avatar)" text input bound to settings; **? help** → expanding section listing the bar accelerators (S/V select · N note · T text · F frame · M terminal · C cast, plus "tldraw defaults: D draw · E eraser · A arrow · L line · R rectangle · K laser · H hand") — static text, keep it honest with `chrome/CommandBar.tsx`'s lists; **about** → one line "EnsembleWorks v{__APP_VERSION__}" (module: declare nothing, the global is typed in vite-env.d.ts; in the test-free component it's safe).

- [ ] **Step 4:** gates green → commit `feat(panel): recording row, settings, help, about footer`.

---

### Task 5: Cutover — old chrome dies

**Files:**
- Modify: `client/src/av/AvOverlay.tsx` (headless: leashes + spatial + publish only)
- Delete: `client/src/av/SessionPanel.tsx`, `client/src/av/rail.tsx`
- Modify: `client/src/ui.tsx` (MenuPanel → null), `client/src/chrome/MainMenu.tsx` (trim ☰)
- Modify: `client/src/av/plugin.ts` (keep SharePanel slot — AvOverlay must stay mounted inside tldraw; it just renders no panel UI)

- [ ] **Step 1: AvOverlay slims down.** Remove `<SessionPanel …>` and `<FacesRail …>` and the faces-rail derivation that only they used; KEEP: `useLiveKitRoom`, `useSessionPulse`, `useSpatialGainLoop`, `LeashOverlay` + `useLeashes`, the kicked/kick logic (actions still published), TranscriptModal ownership moves to the panel (remove here), and the bridge publish. `useLeashes` currently takes `hoveredId` + `faceRefs` from local state/refs — rewire to the bridge: hovered from `useHoveredFace()`, faceRefs adapted to read `getFaceEl` (read `av/leashes.tsx` first; adapt its inputs minimally, e.g. build a compatible `{ current: Map }` object from the bridge registry, or change its signature — smaller diff wins). Rail-face scoping logic ("only faces on my page leash") should carry over into the leash derivation.
- [ ] **Step 2: Delete** `SessionPanel.tsx` + `rail.tsx` (`git rm`); fix stragglers (`grep -rn "SessionPanel\|FacesRail\|rail'" client/src`). `retintLocalShares`/ColorDot/ScribeRow logic must already live in chrome/ from Tasks 3-4.
- [ ] **Step 3: ☰ trim.** In `MainMenu.tsx`, replace `<DefaultMainMenuContent />` with the canvas-verbs subset per spec §4: tldraw exports the composable pieces — check `node_modules/tldraw/src/lib/ui/components/MainMenu/DefaultMainMenuContent.tsx` for what it composes (expect `EditSubmenu`, `ViewSubmenu`, `ExportFileContentSubMenu`, `ExtrasGroup` (embed/upload), `PreferencesGroup`, `LanguageMenu`, keyboard-shortcuts item…) and keep ONLY: Edit, View, Export, embed/upload extras. Preferences/Language/Keyboard-shortcuts go — their duties now live in the panel footer (help lists shortcuts; colour scheme note: **keep PreferencesGroup if removing it would orphan dark-mode switching** — spec assigns Preferences to panel settings, but a colour-scheme toggle in panel settings is NOT in this phase; keeping PreferencesGroup temporarily with a code comment is the smaller honest step. Decide by what DefaultMainMenuContent actually contains and report the choice).
- [ ] **Step 4: ui.tsx**: `MenuPanel: null` (pages live in the panel now); delete `PagesMenuPanel` and its comment; `DefaultPageMenu` import goes.
- [ ] **Step 5:** full gates + `grep` gate from Step 2 → commit `feat(panel)!: side panel replaces session panel, rail and page menu; ☰ trimmed`.

---

### Task 6: End-to-end verification + final review

- [ ] **Step 1:** `bun run typecheck && bun scripts/run-tests.ts && bun run build` — green.
- [ ] **Step 2: Headless smoke** (Caddy :8080, fresh room, extend the Phase-1 harness in the scratchpad `canvas-probe/` dir if still present, else rebuild from `docs/headless-browser.md`):
  1. `ew-side-panel` present on the right; old SessionPanel markup absent (`[data-roster-page]` now inside the panel; no floating top-right panel).
  2. Command bar still fully functional (Phase-1 check 2 re-run: note/select/kbd).
  3. Page nav: `ew-panel-new-page` creates + switches page (`__ewEditor.getCurrentPageId()` changes); clicking the first section header switches back.
  4. Own tile present (`ew-tile-<id>`), colour swatch opens palette, mic/cam buttons render; settings input accepts a GitHub handle and persists across reload.
  5. ☰ opens and shows Edit/View/Export but NOT Language/Keyboard shortcuts.
  6. No page errors anywhere in the run.
- [ ] **Step 3:** Fix-loop anything found (implementer fixes, reviewer re-verifies), then final whole-phase code review, then update the spec's §9 item 2 with as-built notes and commit.

---

## Deviation policy

Same as Phase 1: tldraw/livekit internals may force adaptations — keep spec §3 behaviour authoritative, record every adaptation in reports. Two known sharp edges from Phase 1: never import the tldraw module graph in bare bun tests; anything rendering `TldrawUiToolbarButton`-based components needs a `TldrawUiToolbar` ancestor. New sharp edge to respect here: the panel is OUTSIDE tldraw context — no `useEditor`, no `useDialogs`, no tldraw CSS variables; use the `editor` prop, plain overlays, and `wm` tokens.
