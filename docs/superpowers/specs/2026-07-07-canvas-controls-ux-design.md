# Canvas controls UX redesign — design spec

**Date:** 2026-07-07
**Status:** Approved design. Implementation deliberately deferred until the
plugin-architecture refactor lands; Section 8 records the code mapping as
designed against today's `client/src`, to be revalidated then.
**Mockups:** `.superpowers/brainstorm/266756-1783410227/content/` (gitignored,
local only) — `section1-anatomy-v3.html`, `section2-panel-behaviors.html` are
the approved end states.

## 1. Problem

The canvas chrome is stock tldraw plus bolted-on custom panels. In real
sessions this means:

- **Clutter** — style panel, session panel, toolbar, shape submenu and page
  menu all permanently visible, four corners occupied.
- **Wrong tool priorities** — drawing tools are prominent; the actions
  sessions actually live on (sticky notes, text, frames, terminals,
  screenshare) are not.
- **No situational range** — the same maximal chrome whether you're
  workshopping, presenting, or just talking.

## 2. Design principle

Exactly **two chrome regions**, each with one job:

> **Right panel = people · pages · the app. Bottom bar = verbs on the canvas.**

Everything else is contextual (appears when relevant) or demoted into a menu.
"Face-to-face" is not a mode — it's how wide you've dragged the panel.
The only named mode besides normal work is **Present**.

## 3. The right panel (permanent, resizable split)

A true split pane on the right edge (not an overlay): dragging the divider
resizes the canvas region. Width and collapsed state persist per user.

Top-to-bottom anatomy:

1. **Room header** — room name, VM load/mem gauges.
2. **Page sections** — one section per canvas page, header shows page name +
   occupant count. Clicking a header jumps to that page (replaces tldraw's
   page menu). Each header has a `⋯` menu: rename · delete · reorder · seed
   demo/session layout · export page.
3. **User tiles** — each participant appears under the page they're focused
   on. Tile anatomy:
   - Video when camera on; otherwise large initials tinted in the user's
     colour (optional avatar via GitHub handle — `github.com/<handle>.png`,
     no auth — set in settings; initials are the guaranteed fallback).
   - User colour = tile's left edge tint.
   - Latency pill + sparkline, top-right.
   - Name, bottom-left. Own tile reads "(you)" and carries a **colour swatch
     + ▾ caret** beside the name — the only tile with one; click opens the
     identity-colour palette (hover: ring + "Change your colour" tooltip).
   - Own tile: mic/cam are working toggle buttons. Others' tiles: mic/cam are
     status icons; kick stays behind a hover menu.
4. **"+ new page"** button.
5. **Recording row** — rec dot, scribe name, transcript link. Never hidden
   (even the collapsed rail keeps a rec dot).
6. **Footer** — ⚙ settings · ? help (keyboard shortcuts, docs) · about +
   version.

The panel absorbs from tldraw's stock menus: Preferences, Language, Keyboard
shortcuts, name/colour editing, About, and the EnsembleWorks seed-layout
items (which become page-section `⋯` items).

### Panel states

| State | Trigger | Behaviour |
|---|---|---|
| Collapsed rail (~32px) | drag below ~140px (snaps), or double-click grip | Avatar dots (colour + initial, ring = speaking), rec dot, expand chevron |
| Working width (default) | — | Full sections + tiles as above |
| Wide = face-to-face | drag past ~40% of window | Tiles reflow two-up per section and grow; canvas stays live in the remaining strip |
| Present | ▶ Present pressed (by anyone) | See §5; temporary override, prior width restored on exit |

## 4. The command bar

Single floating bar, default bottom-center. Contents, left to right:

- **☰ menu** — canvas verbs only: Edit (undo · redo · cut · copy · paste ·
  duplicate · delete · select all), View (zoom to fit · zoom to selection ·
  100% · grid), Export (selection / page as PNG·SVG), Insert embed, Upload
  media.
- **Priority tools with underlined accelerators** —
  s̲elect (S, new alias; tldraw's V kept) · n̲ote (N) · t̲ext (T) · f̲rame (F) ·
  term̲inal (M, new) · c̲ast (C, new — renamed from "screenshare" so the
  label carries its key) · **⋯ overflow**.
- **▶ P̲resent** (P, new) — visually set off.
- **Zoom** percentage ± .

Accelerator presentation: icon + text label with the shortcut letter
underlined (menu-accelerator style). No keycap badges. K stays reserved for
tldraw's laser pointer. Exact conflict check against tldraw's full keymap
happens at implementation time.

**⋯ overflow** — demoted tools, same underline treatment: d̲raw · e̲raser ·
a̲rrow · l̲ine · r̲ectangle + shape grid · h̲ighlighter · laser (k̲) · h̲and.
The ⋯ button adopts the icon of the last-used overflow tool (one-click
re-access without permanent promotion). All shortcuts work regardless.

**Docking** — v1 ships bottom-docked with a right-click "Dock to left / top /
right" setting, persisted per user; left/right render a vertical variant
(icon-first, popovers flip away from the docked edge). Drag-to-dock is a
later polish item, explicitly out of scope for v1.

## 5. Present

Personal-with-broadcast (hybrid): pressing ▶ Present broadcasts
"presenting" to the room; every client enters the Present chrome state with
per-user opt-out.

- **Everyone:** panel auto-collapses to the rail (presenter's dot ringed);
  prior width restored on exit.
- **Presenter:** bar becomes laser · note · **END PRESENTING** (+ rec dot).
- **Viewers:** viewport follows the presenter (tldraw follow); canvas dims
  slightly; bar becomes "Following ⟨name⟩ · **STOP FOLLOWING**". Esc or STOP
  opts out locally (chrome stays minimal until presenting ends or they exit).
- Esc always returns the presenter to Work chrome and ends the broadcast.

## 6. Contextual style panel

No fixed style panel. One component, two anchors:

- **Selection exists** → popover above the selection bounds (same position
  as tldraw's rich-text toolbar, keeping one consistent contextual spot).
- **Style-bearing tool armed, nothing selected** (e.g. just pressed d̲raw) →
  popover above the command bar, anchored to the active tool.

Shows today's style controls (colour, fill, dash, size, font…) filtered to
the selection; disappears on deselect/Esc. Undo/redo/delete/duplicate live in
☰ and on their keyboard shortcuts.

## 7. Focus view (full-screen terminal)

Any terminal can be expanded to fill the **canvas region** — the area between
the right panel and the command bar. The panel (presence, rec indicator) and
bar stay visible; collapse the panel to the rail for near-full-width. Focus
is **purely local** to the user, like panel width.

- **Enter:** ⛶ button on the terminal's shape chrome, or a keyboard shortcut
  while the terminal is selected (exact binding at implementation time).
- **Exit:** a persistent ⛶ exit button on the focused view's edge, plus a
  chord that terminals can't swallow (e.g. Ctrl+Shift+Enter). Plain Esc is
  deliberately NOT the exit — a focused terminal captures keys and Esc
  belongs to vim/tmux.
- **While focused:** the terminal owns the keyboard; canvas tools in the bar
  are disabled except Present and zoom-independent actions; clicking a page
  section header exits focus first, then navigates.
- **Aspect ratio is preserved — focus never resizes the terminal.** The
  cols×rows grid belongs to the shared tmux PTY, which has one size for all
  viewers, so a local focus must not reflow it. Focus scales the shape
  uniformly to the largest fit in the canvas region, centred, and mattes the
  leftover space (dimmed, like Present). Remote viewers see no change.
  Implementation note: this is naturally "zoom the tldraw camera to the
  shape's bounds and lock it" — uniform zoom preserves aspect by
  construction, and the letterbox is just the surrounding canvas, dimmed.
- **Mechanism is shape-agnostic** (a "focus this shape" chrome state), so
  cast tiles and iframes can adopt it later; v1 wires it for terminals only.

## 8. Code mapping (as designed 2026-07-07 — revalidate post-refactor)

Designed against `client/src` as of branch `unified-architecture-migration`;
the plugin-architecture refactor may move these seams. Treat as intent, not
letter.

- **Split layout** — `App.tsx` becomes a flex row: canvas region (tldraw) +
  `SidePanel`. The panel is not an overlay; resizing genuinely resizes the
  canvas.
- **Slot overrides** (`ui.tsx`) — `Toolbar` → custom `CommandBar` (no
  `DefaultToolbar`); `StylePanel` → null, replaced by `ContextualStylePanel`
  anchored via `getSelectionRotatedScreenBounds()`; `MenuPanel`/`PageMenu`/
  `NavigationPanel` → null; `SharePanel` → null (SessionPanel content
  decomposes into panel sections).
- **Plugin API evolution** — replace raw `ToolbarItems`/`MenuItems` JSX with
  declarative contributions: tool descriptors
  `{id, icon, label, accelerator, placement: priority | overflow}` and
  menu-target hints (`canvasMenu | pageMenu | settings`). This is the piece
  that must be co-designed with the plugin-architecture track.
- **Reuse** — tiles recompose `av/SessionPanel` (roster-by-page grouping,
  gauges, latency sparklines, colour picker, kick) + LiveKit video tracks.
  Keep/migrate the `data-roster-page` test hooks.
- **Present transport** — sync server custom messages (same channel as
  `kicked`) announce presenter start/stop; viewers use tldraw
  `startFollowingUser`. Opt-out is local.
- **Persistence** — dock edge, panel width, collapsed state in
  `localStorage` under `ensembleworks.*` keys (pattern:
  `COLOR_SCHEME_SEEDED_KEY`).

## 9. Phasing (post-refactor)

Each phase shippable alone:

1. **CommandBar** — priority tools, underlined accelerators, new bindings
   (S alias, M, C — the P binding lands with Present in phase 3), ⋯ overflow
   with last-used adoption, hide stock toolbar/menus, contextual style panel.
   *Shipped 2026-07-07 (branch canvas-controls-ux). As-built deltas: overflow
   carries rectangle + ellipse rather than the full shape grid; ☰ still shows
   tldraw's full default menu content — trimming it to canvas verbs moves to
   phase 2.*
2. **SidePanel** — split layout, page sections + navigation, user tiles
   (video/initials/avatar, colour swatch, mic-cam), recording row, footer,
   settings dialog (incl. GitHub handle, dock edge); trim ☰ to canvas verbs
   only (§4).
3. **Behaviours** — resize/collapse/f2f reflow, Present broadcast + follow,
   dock-edge vertical variant.
4. **Focus view** (§7) — independent of the others; can ship alongside any
   phase since it only needs the terminal plugin + a chrome state.

## 10. Out of scope

- Drag-to-dock for the command bar (dock setting only in v1).
- Auto-adaptive modes (chrome reacting to activity on its own).
- Any new auth for avatars (GitHub handle is a plain settings string).
- Touch/tablet-specific layouts (revisit after v1 feedback).

## 11. Decision log

| Decision | Choice | Rejected |
|---|---|---|
| Layout direction | Consolidated command bar | Tidy-corners evolution; left tool rail |
| Modes | Work + Present only | F2F as a mode (became panel width); density dial; auto-adaptive |
| Mode scope | Personal, presenter broadcasts with opt-out | Fully shared; fully personal |
| Present chrome | Slim strip stays (avatar rail + rec + explicit STOP) | Near-total vanish |
| Videos | Permanent resizable right panel | Video wall; centre stage; left panel |
| Panel contents | Everything non-canvas (roster, gauges, rec, settings, help, version) | Videos-only panel with separate top-right session panel |
| Roster/videos | Unified: tiles grouped under page sections | Separate roster + video strip |
| Shortcut display | Underlined accelerator in label | Keycap badges below icons |
| Docking v1 | Setting (right-click → dock edge) | Drag-to-dock in v1; bottom-only |
| Terminal focus view | Fills canvas region, local-only, non-Esc exit chord | Whole-window takeover; whole-window + rail |
