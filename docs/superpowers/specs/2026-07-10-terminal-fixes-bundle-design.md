# Terminal fix-in-place bundle — design

**Date:** 2026-07-10
**Status:** approved (brainstorming session)
**Companion docs:**
[`docs/terminal-grid-sizing.md`](../../terminal-grid-sizing.md) (the sizing
invariants every item here must preserve),
[`docs/tldraw-replacement-analysis.md`](../../tldraw-replacement-analysis.md)
(§3: the ghostty-web assessment this design supersedes as a course of action).

## Context — why not ghostty-web

This work began as "start an alternative terminal implementation on
ghostty-web". Before designing that, we grilled the team's actual observed
problems with the current xterm.js terminal and traced each to its layer:

| # | Observed problem | Root cause layer | ghostty-web impact |
|---|---|---|---|
| 1 | Shift+Enter submits instead of newline in claude code (top priority); Alt+Enter does nothing | Key encoding (xterm.js) **and** a tmux binding that steals Alt+Enter | Maybe — unverified whether its input layer implements kitty protocol; a tiny in-place fix exists regardless |
| 2 | Characters render as boxes mid-session on one Linux/Wayland machine ("all n's become boxes"); refresh fixes it | xterm WebGL addon glyph-atlas corruption × Mesa driver | Yes — but disabling/healing WebGL is far cheaper |
| 3 | Content jumps and edges clip when toggling view/edit mode | `TerminalShapeUtil` border-width change (1px ↔ 2px) | None — shape-hosting code |
| 4 | Scroll wheel drops people into tmux copy-mode; they can't get out | tmux mouse config; any emulator forwards the same events | None |
| 5 | Nerd Font / powerline symbols always render as tofu | Webfont coverage (unpatched JetBrains Mono) | None — no renderer draws glyphs the font lacks |
| 6 | Box-drawing seams; drag-selection lands on wrong cells at some zooms | Fractional font sizes from `fontSize = 16 × zoom` | None — ghostty-web renders fixed cells under the same counter-scale |

Of nine grilled symptoms, a renderer swap definitively fixes two (which have
cheap in-place fixes), might help two, and is irrelevant to five — including
the team's #1 priority. Decision: **fix in place; shelve ghostty-web.** A
ghostty-web evaluation spike remains a valid future project *on its own
merits* (Unicode quality, escape-sequence fidelity, permanently removing the
WebGL failure mode), but it is not the lever for any problem listed here.

## Design

Six items, ordered by team value. Items 1–5 are small and independent; item 6
is investigation-grade and goes last.

### 1. Shift+Enter / Alt+Enter newline in claude code

Two confirmed root causes:

- `deploy/tmux-ensembleworks.conf` binds `M-Enter` / `M-S-Enter` in the root
  table to pane splits, so Alt+Enter never reaches the app inside tmux.
- xterm.js encodes Shift+Enter identically to Enter (`\r`); claude cannot
  distinguish them. (xterm.js has no kitty-keyboard-protocol support.)

Fix — no server work needed (`extended-keys on` + `extended-keys-format
csi-u` are already in the conf):

1. **tmux conf:** remove the root-table `M-Enter` and `M-S-Enter` split
   bindings. Prefix `h` / `v` already provide splits. Alt+Enter then flows
   through to claude, which treats `ESC CR` as newline by default.
2. **Client:** in the existing `attachCustomKeyEventHandler` in
   `client/src/terminal/TerminalShapeUtil.tsx`, intercept Shift+Enter and
   send `\x1b\r` as terminal input over the WS (the same `input` message the
   `onData` path uses), returning `false` so xterm does not also send `\r`.
   Shift+Enter thereby behaves exactly like Alt+Enter in native terminals.

Acceptance: in a live claude-code session in a canvas terminal, Shift+Enter
and Alt+Enter each insert a newline; plain Enter still submits; tmux pane
splitting still available via prefix `h` / `v`.

### 2. Glyph-atlas ("tofu") corruption on Linux/Wayland

The clean-loss path already exists (`webgl.onContextLoss` → dispose → DOM
fallback). The observed corruption is silent — the atlas rots without the
event firing. Two-pronged:

1. **Auto-heal:** call `Terminal.clearTextureAtlas()` (public xterm API;
   discards and re-rasterises all glyphs) on `visibilitychange → visible`
   and on entering edit mode. Turns "refresh the page" into "click the
   terminal", invisibly.
2. **Escape hatch:** a persisted per-machine flag —
   `localStorage['ensembleworks:webgl'] === 'off'` — that skips loading the
   WebGL addon entirely, leaving that machine on the DOM renderer.

Acceptance: with the flag set, terminals render and pass the existing smoke
flow with no WebGL context created; without it, entering edit mode after
corruption repaints correctly (verified manually on the affected machine —
the corruption is not reproducible on demand).

### 3. View/edit content jump + edge clipping

The border switches 1px ↔ 2px with edit state, shrinking the content box by
2px per axis; `TERMINAL_PAD` in `client/src/terminal/grid.ts` knows about
neither value. Fix:

1. Constant 1px border in both modes; draw the editing highlight as an outer
   `box-shadow` ring (zero layout impact).
2. Audit the remaining right/bottom clipping against
   `TERMINAL_PAD = { x: 32, y: 10 }` — bottom padding of 0 is the likely
   descender-clipping culprit in the last row. If padding constants change,
   `grid.ts` and the container CSS change **together** (they are one fact
   recorded twice; the grid.ts comment already says so).

Acceptance: headless-browser check — toggling edit mode produces zero pixel
shift of terminal content; a full-height TUI (e.g. htop) shows complete
glyphs in the last row and column in both modes. Changing `TERMINAL_PAD`
changes the derived grid, so expect existing terminals to re-grid once on
deploy (gateway dedup makes this a single authoritative resize, same as any
box resize — not a migration).

### 4. tmux copy-mode escape hatch

Scroll-wheel → copy-mode stays: it is the scrollback mechanism (tmux owns
history; `scrollback: 0` client-side is deliberate), and scrolling back to
the bottom already auto-exits. The fix is the "can't get out" half:

- `bind -T copy-mode-vi Escape send -X cancel` in
  `deploy/tmux-ensembleworks.conf` (and the mirrored conf under
  `deploy/features/ensembleworks-cli/`), so the universal panic key exits.
- The status bar's existing `COPY` flag remains the mode indicator.

Interaction to verify: Esc now cancels copy-mode *first*; the client's
double-Esc exit-editing gesture still works on the next two presses.
Accepted as reasonable ergonomics.

### 5. Nerd Font symbol coverage

`wm.mono` (`client/src/theme.ts`) is unpatched Google-Fonts JetBrains Mono.
Fix: self-host **Symbols Nerd Font Mono** (symbols-only fallback, MIT — the
nerd-fonts release LICENSE, vendored at
`client/public/fonts/LICENSE-SymbolsNerdFont.txt`, equally AGPL-compatible)
as the release TTF under `client/public/` (woff2 subsetting noted as
optional future polish), declare it with `@font-face`, and append it to
`wm.mono` after JetBrains Mono.

The primary font — and therefore the measured cell, its quantisation, and
the deterministic grid — is untouched; the fallback only supplies glyphs
JetBrains Mono lacks. Symbol glyphs wider than a cell clip at the cell
boundary exactly as they do in any terminal.

Acceptance: a Nerd-Font-using prompt (e.g. starship defaults) shows symbols
instead of tofu; `grid.test.ts` unchanged; measured cell value unchanged
before/after (spot-check via the quantised value in a headless run).

### 6. Fractional-font-size artifacts — bounded investigation

`fontSize = 16 × zoom` is fractional at most zooms — the prime suspect for
both box-drawing seams and off-by-one drag-selection. Investigation-grade:

1. Reproduce at fixed zooms (0.75 / 1.1 / 1.33) in a headless browser:
   render a box-drawing TUI, screenshot for seams; script a drag-selection
   and assert the selected text matches the intended cells.
2. If confirmed, evaluate quantising the rendered font to whole pixels with
   a compensating host scale so the net on-screen scale stays exactly 1.

Hard constraint — the four invariants in `docs/terminal-grid-sizing.md`:
the grid stays a pure function of shared state + the quantised base cell;
nothing proposed from live pixel measurements; zoom/selection geometry stays
orthogonal to grid sizing; the gateway stays authoritative with dedup. If a
candidate fix threatens an invariant, the item stops and reports findings
instead of shipping.

**Findings (investigated 2026-07-11), under headless Chromium (`client/e2e/terminal-zoom-probe.mjs`)
at zooms 0.75 / 1.1 / 1.33 against a live dev stack (room "probe", a real
tmux session rendering box-drawing content):**

- At these three zooms, effective `fontSize = BASE_FONT × zoom` is 12px
  (0.75 — integer by coincidence), 17.6px (1.1) and 21.28px (1.33) — the
  latter two are genuinely fractional, so the hypothesis had real cases to
  bite on.
- **Box-drawing seams: not reproduced.** Screenshots of a `┌─│└` rectangle
  at all three zooms, including a second pass at `deviceScaleFactor: 2`
  (magnified crops of the border), show continuous, unbroken lines — no
  horizontal/vertical gaps at any zoom.
- **Off-by-one drag-selection: not reproduced.** A scripted shift+drag
  across one row's vertical middle, screenshotted immediately after release,
  shows the selection highlight band confined to exactly the one dragged
  row at all three zooms — no bleed into the row above/below.
  (`window.getSelection()` was also read per the plan, but its content's
  provenance in this app is unclear — no `.xterm-accessibility` tree or any
  DOM text node was found matching the terminal's content, yet
  `toString()` sometimes returned terminal-glyph-shaped text anyway; it was
  treated as a secondary, not authoritative, signal. The selection
  screenshots are the reliable evidence.)
- Suspect: the WebGL glyph-atlas renderer (already in use here, see item 2)
  samples a texture atlas at the target scale rather than compositing
  sub-pixel DOM/canvas borders, which plausibly closes exactly this failure
  mode independent of whether the font-size math is integer or fractional —
  consistent with the earlier grilled-symptoms note that ghostty-web (a
  different fixed-cell GPU renderer) was also expected to close this one
  "for free." Could also be specific to this headless/DPR-1 and DPR-2
  Chromium environment rather than the reporting user's real machine/DPI.
- **Decision: candidate fix (rounding `fontSize` to whole px + compensating
  `fontFactor` host counter-scale) not applied** — neither symptom
  reproduced, so there is nothing to verify the fix against, and the plan's
  own bar for shipping this item is reproduction first.

## Sequencing & verification

Land order: **1 → 3 → 2 → 4 → 5 → 6**, each as its own commit(s) on a
feature branch. Per-item acceptance as above, plus for every item:
`bun run typecheck`, `grid.test.ts`, and the README smoke tests. Items 3 and
6 additionally verify via headless browser; item 1 verifies against a live
claude-code session.

## Out of scope

- ghostty-web evaluation spike (future project, own merits — see Context).
- Focus-handoff polish beyond what item 3 fixes incidentally.
- tmux `M-Escape` kill-pane binding (also steals a chord, but nobody has
  reported it; note for later).
- Any change to the terminal WS protocol, gateway, or relay plane.

## Addendum (2026-07-11) — renderer strategy & font size

Live testing on the affected Wayland machine (fractional DPR: 1.1 external
monitor, 2.2 laptop) after items 1–5 landed produced new evidence:

- Edit mode at 65% zoom: text blurrier than view mode; left/right margins
  drift with zoom (too much padding zoomed out, cutoff zoomed in).
- Edit mode at 379% zoom on the high-DPR screen: glyphs render as square
  boxes — deterministic, not random. Item 2's "random mid-session tofu" is
  now largely reattributed to this: zoom-scaled fonts (base × zoom × DPR ≈
  130+ device px) overflow the WebGL glyph atlas.
- Forcing the DOM renderer (item 2's escape-hatch flag) cured the blur, the
  side margins, and the boxes. Remaining: bottom edge drifts with zoom
  (DOM row heights quantise to whole px at fractional font sizes × ~25
  rows), and 1px seams between rows on box-drawing TUIs (DOM renders font
  glyphs; only atlas renderers draw box chars procedurally via customGlyphs).

Root cause: re-rasterising the editing terminal at `fontSize = base × zoom`
pushes any atlas renderer outside its envelope in both directions. Four
follow-up items, folded into this bundle:

### 7. Hybrid renderer — WebGL in view, DOM in edit (unconditional)

View mode keeps the WebGL addon: many terminals compositing while the
camera pans/zooms, glyphs at base font (atlas comfort zone). Entering edit
disposes the addon (xterm falls back to its DOM renderer: no atlas, crisp
at any fractional size); leaving edit loads a fresh addon instance.
**Supersedes item 2's `ensembleworks:webgl` escape hatch, which is removed**
(`webgl.ts` + test deleted) — everyone runs the same renderer strategy. The
visibility-return `clearTextureAtlas()` heal stays (protects view-mode
WebGL); the edit-enter heal is dropped (renderer swap makes it moot).
Context-loss fallback stays for view mode.

### 8. Integer-px font while editing

The item 6 candidate fix, now evidence-backed by the live machine, as
SHIPPED: rendered font is `max(1, floor(base × zoom))`; the host
counter-scale inverts the RAW zoom (not the font's own factor), so net
on-screen scale is exactly 1 — xterm's `getCoords` divides
transform-inclusive screen px by transform-independent CSS cell size, so
selection is exact only at net scale 1. Kills the bottom-edge drift
(stable DOM row heights) and reduces row seams. Flooring means the grid
under-fills the box by up to ~7.5% of width at fractional zooms (measured;
see item 10 findings) — it never clips. The four `terminal-grid-sizing.md`
invariants hold: the grid still derives from the shared box + base-font
cell; the flooring is render-only.

### 9. Per-terminal base font size (shared prop + keys)

`fontSize: T.number.optional()` on `terminalShapeProps` (contracts — single
definition; optional ⇒ no migration; absent = 16). SHARED semantics: one
PTY grid per terminal, so font size is a property of the terminal, not the
viewer — changing it re-grids for everyone (deterministic: the cell is
measured at the shared base font and quantised, so every client derives the
same grid). UI: Ctrl/Cmd +/− (and 0 to reset) while editing, clamped 8–32,
handled in the existing key handler so browser page-zoom never fires.

### 10. Verification & findings write-back

Headless probes at `PROBE_DPR` 1.1 and 2.2 (the real machine's values):
renderer actually swaps (canvas present in view, absent in edit), bottom
margin stable across zooms in edit (±2px), box-drawing seams screenshot at
integer fonts (accept or mitigate based on evidence), editpad + zoom probes
still pass. Findings appended here.

**Findings (verified 2026-07-11, HEAD f397898)** — headless Chromium at
`deviceScaleFactor` 1.1 and 2.2, live dev stack, room "probe" (720×440
terminal shape, real tmux session with box-drawing + known-text rows).
All checks were run at BOTH DPRs; results were identical unless noted.

1. **Renderer swap: PASS.** View mode: 2 `<canvas>` in `.xterm-screen`,
   0 `.xterm-rows`. Editing: 0 canvases, 1 `.xterm-rows` (DOM renderer).
   After Esc Esc: 2 canvases, 0 `.xterm-rows` again (fresh WebglAddon).
   Verified via `__ewEditor` edit-state assertions at each step.
2. **No boxes at extreme zoom: PASS.** editZoom 3.79 while editing, DPR
   2.2 (rendered font 60px, ≈132 device px): every glyph renders as a
   real crisp character — zero square boxes (`t11-dpr2.2-zoom3.79.png`).
3. **Bottom/right gap while editing** (gap = padded container edge −
   `.xterm-screen` edge, screen px, normalised by zoom to logical px;
   4px bottom / 20px right CSS padding subtracted to isolate under-fill):

   | zoom | bottom under-fill, logical px (DPR 1.1 / 2.2) | right under-fill (both) | right gap % of width |
   |---|---|---|---|
   | 0.65 | 25.5 / 39.4 | 29.2 | 6.9 |
   | 1.1 | 31.3 / 39.5 | 33.9 | 7.5 |
   | 1.33 | 34.5 / 34.5 | 10.7 | 4.3 |
   | 2.0 | 9.5 / 14.0 | 20.0 | 5.6 |

   Honest read: the strip is **not** within the hoped-for ±2px across
   zooms — it swings ~10–40 logical px (bottom) and ~11–34 px (right,
   4.3–7.5% of width, bracketing the predicted ~4–6%) as the floored
   font's fractional loss varies with zoom, compounded by DOM row-height
   device-px rounding (hence the DPR 1.1 vs 2.2 spread at z<1.33). What
   the fix actually guarantees held everywhere: the gap is **always an
   under-fill, never a clip** (all values positive at every zoom × DPR),
   and it is stable over time at a given zoom — this is the accepted
   under-fill-strip residual, larger than the ±2px hope but benign.
4. **Selection endpoint accuracy: PASS — regression guard clear.**
   Shift+drag from cell (row 2, col 5) centre to (last row, col cols−2)
   centre at editZoom 0.65, 3.79 AND 1 (control). Highlight geometry read
   from the DOM renderer's `.xterm-selection` divs: right-edge error vs
   the drag end point is **exactly −0.50 cells at all three zooms and
   both DPRs** (−3px at cellW 6, −5px at cellW 10, −18px at cellW 36).
   The z=1 control proves this constant is xterm's exclusive-end
   convention (drop at a cell's centre selects up to that cell's left
   boundary), not a zoom artifact: it is perfectly zoom- and
   DPR-invariant, within the ±half-cell tolerance, with no off-by-one
   drift. (No window-exposed Terminal handle exists, so
   `term.getSelectionPosition()` was not reachable; the highlight-rect
   assertion + screenshots `t11-dpr*-sel-z*.png` are the evidence.)
5. **Font-size keys e2e: PASS.** While editing: Ctrl+'=' ×2 →
   `props.fontSize` 16→17→18 and the deterministic grid re-derived
   (rows 19→18); Ctrl+'0' → 16, rows back to 19. Caveat: the custom key
   handler only sees keys while xterm's helper textarea has focus —
   probe drags can steal focus, so the check re-enters editing first.
6. **Seams at integer fonts (DOM renderer, editing): GONE.** DPR 2.2,
   z=1 (font 16) and z=0.65 (font 10), box-drawing rectangle,
   pixel-profiled with ImageMagick: horizontal borders ≥98% dark pixels
   along the line (the ~2% light pixels are corner/edge antialiasing,
   invisible at 1:1); the vertical border column is 100% continuous
   across all rows — zero between-row 1px seams.
7. **Editpad probe: PASS** (editShift 0, roundTrip 0).

Known-accepted residuals, restated with numbers: (a) *(resolved during
pre-merge review — the min-font clamp was `max(6, …)` at findings time,
which re-broke net-scale-1 below ~37.5% zoom at the new baseFont-8
minimum and could overflow the box; shipped as `max(1, …)`, whose only
job is fontSize ≥ 1, so this residual no longer applies)*; (b) the floor
under-fill strip above (item 3) — up to ~7.5% of width right, up to ~40
logical px bottom at the worst zoom × DPR combination measured.

### Deferred follow-up

**Cross-client cell-measurement divergence.** The `[baseFont]` re-measure
effect reads the cell from whichever renderer is active. The WebGL
renderer DPR-quantises its reported cell dimensions (`floor(width × DPR) /
DPR`), while the DOM renderer reports raw floats. Two viewers on different
DPRs (or different active renderers) can therefore quantise the same
logical cell into different 0.1px buckets and echo different grids on a
shared `fontSize` change. This is bounded by the gateway's authoritative
dedup and is partially pre-existing (not introduced by this branch), but
it is a known residual, not yet fixed. Proposed fix: capture the cell from
a renderer-independent source (e.g. xterm's `CharSizeService`), or only
re-measure in view-mode/base-font conditions, plus a two-DPR two-client
convergence probe to verify.
