# Acceptance walkthrough — Frames drawer

Agent-driven walkthrough of every item in [`frames-drawer.md`](./frames-drawer.md), run against
the **live app** on the final (post-review) code. This repo has no executable acceptance harness
(plain `node:assert` unit scripts; Playwright kept out-of-tree per `docs/headless-browser.md`), so
acceptance is a driven walkthrough with a DOM/store/editor observation recorded per line.

## Environment
- Stack run natively (Docker not up): sync server `:8788` + Vite `:5173`, room `?room=ew-frames-probe`.
- Driven via Playwright (MCP). Frames seeded through `window.__ewEditor.createShapes(...)`; camera,
  tool, page and drawer state read back through `window.__ewEditor` and the DOM.
- Seed set (Page 1): `Advice — Crew A`, `Brief lessons`, `Pair huddle 2`, `Pair huddle 10`, and one
  **blank-named** frame — chosen to exercise numeric-aware sort and the blank→"Frame" fallback.
- Screenshots referenced below are in the PR description / handoff (kept out of the repo tree).

## Results — 14 / 14 PASS

| AC | What was checked | Observation | Result |
|----|------------------|-------------|--------|
| **AC1** Caret placement | Count carets across the panel's page sections | `caretCount = 1` — only the current page's section shows `‹`; others stay aligned | ✅ |
| **AC2** Hover peek opens left | Hover the caret; check drawer present + left of panel | `peekOpened = true`, `pinned = false` (peek not pin), `drawer.right (920) ≤ panel.left (919)+1`, 5 rows | ✅ |
| **AC3** Peek retracts, no flicker | Move pointer off caret; wait past grace | `drawerRetractedAfterLeave = true`. Caret→drawer no-flicker is the 140ms grace timer (unit-tested in `framesDrawerLayout.test.ts`) | ✅ |
| **AC4** Click pins | Click caret; read pin state | `drawer present`, `aria-pressed = true`, header button reads **Pinned** | ✅ |
| **AC5** Pin persists | Reload the page | `drawerOpenAfterReload = true`, `pinned = true`, 5 rows (localStorage `ensembleworks.framesDrawer.v1`) | ✅ |
| **AC6** Unpin closes + persists | Click **Pinned** button, move pointer away | `pinned = false` persisted; after pointer-leave `drawerClosed = true` | ✅ |
| **AC7** Jump | Click the `Pair huddle 10` row (frame seeded at 100,600,300×200) | View center flew from ~(289,330) to exactly **(250,700)** — the frame's center; viewport `305×294` frames the 300×200 shape; `page` stayed `Page 1` (no page switch) | ✅ |
| **AC8** AV/tiles never reflow | Panel tile rect with drawer open vs closed | Identical both states: `x 932, y 120, w 256` — the drawer is an absolute overlay beside the panel, never in its layout | ✅ |
| **AC9** Rides the resize | Drawer right edge vs panel left edge | `drawer.right = 920`, `panel.left = 919` → flush (≤1px); tracks the live panel width via `drawerRightOffset` | ✅ |
| **AC10** Folds with collapse | Collapse panel to rail, then expand | While railed: `drawer` + `caret` both absent. After expand (pinned): both restored, `pinned = true` | ✅ |
| **AC11** `J` toggles; no collision; typing guard | Press `J` (×2), `F`, `G`; then `J` while editing a shape | `J` toggled drawer with tool staying `select`; `F`→`frame` tool and `G`→`geo` tool, drawer unaffected; `J` while `getEditingShapeId()` non-null left the drawer open (guard fired) | ✅ |
| **AC12** Sorted names | Read rendered row order | `Advice — Crew A`, `Brief lessons`, **`Frame`** (blank→fallback), `Pair huddle 2`, `Pair huddle 10` — case-insensitive, blank sorted as "Frame", numeric-aware (2 before 10) | ✅ |
| **AC13** Empty state | Switch to a page with no frames | `rowCount = 0`, drawer shows "No frames on this page." | ✅ |
| **AC14** Follows current page | Create + switch to "Empty page", then back | Drawer header followed to `Empty page`, caret moved to the now-current section; switching back re-listed Page 1's frames | ✅ |

## Notes
- **AC11 typing-guard nuance:** pressing `J` while a frame was in name-edit mode kept the drawer open
  (the `getEditingShapeId()`/contentEditable guard suppressed the toggle). tldraw's label editor grabs
  focus in edit mode, so the injected probe `<input>` didn't capture the keystroke — but the drawer NOT
  toggling is exactly what the guard guarantees.
- The `J` key was chosen because `F` (frame tool) and `G` (geo tool) are already bound by tldraw; the
  handler runs in the **capture phase** with `stopPropagation` so it wins ahead of tldraw's body-level
  tool shortcuts (the `FocusOverlay.tsx` idiom). Both were re-confirmed non-colliding above.
