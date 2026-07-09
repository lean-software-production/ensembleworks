# Acceptance checklist — Frames drawer (jump to a frame)

Feature: a caret on the LEFT of the **current page's** side-panel section flies a **Frames drawer**
out to the **left of the panel**; hover peeks, click pins (persists); clicking a frame flies the
camera there. Scope v1: current page only, names only.

This repo has no executable acceptance-test harness (plain `node:assert` unit scripts; Playwright
kept out-of-tree). So acceptance is **agent-driven**: an agent drives the live app and checks each
item, attaching a screenshot/log per line. Setup: `bin/dev up`, open a room, **Seed session layout**
(main menu) so several named frames exist, then drive `http://localhost:5173/?room=<room>`.

> **Status: 14 / 14 PASS** on the final code — see the driven-walkthrough evidence in
> [`frames-drawer-walkthrough.md`](./frames-drawer-walkthrough.md).

## Checklist

- [x] **AC1 — Caret placement.** The current page's section header (seal-blue dot) shows a small `‹`
      caret at its **left**, before the page name. Non-current sections show no caret but stay aligned.
- [x] **AC2 — Hover peek opens left.** Hovering the caret opens a drawer to the **left of the panel**
      (over the canvas), titled "Frames · <page>", listing the current page's frame names.
- [x] **AC3 — Peek retracts.** Moving the pointer off the caret/drawer (without pinning) retracts the
      drawer after a brief grace; moving caret→drawer does **not** flicker it shut.
- [x] **AC4 — Click pins.** Clicking the caret pins the drawer open (stays after the pointer leaves);
      the caret turns seal-blue and the header button reads **Pinned**.
- [x] **AC5 — Pin persists.** With the drawer pinned, reload the page → it is still open.
- [x] **AC6 — Unpin closes.** Clicking the caret again (or the **Pinned** button) closes the drawer,
      and that also persists across reload.
- [x] **AC7 — Jump.** Clicking a frame row animates the camera to that frame (zoom-to-bounds). The
      camera does not switch pages.
- [x] **AC8 — AV untouched.** Opening/closing the drawer never moves or reflows the participant/AV
      tiles in the right panel (the drawer opens beside them, not above/below).
- [x] **AC9 — Rides the resize.** Dragging the panel's resize grip wider/narrower keeps the drawer's
      right edge flush to the panel's left edge.
- [x] **AC10 — Folds with collapse.** Collapsing the panel to its 32px rail hides the drawer;
      expanding restores it when pinned.
- [x] **AC11 — Keyboard `J` toggles.** Pressing `J` toggles the drawer pinned/unpinned. `F` still arms
      tldraw's frame tool and `G` still arms the geo tool (no collision — `J` was chosen precisely
      because tldraw leaves it free). `J` does nothing while typing in an input or editing a shape's text.
- [x] **AC12 — Sorted names.** Frames are listed by name, case-insensitive and numeric-aware
      ("Pair huddle 2" before "Pair huddle 10"); a frame with no name shows "Frame".
- [x] **AC13 — Empty state.** On a page with no frames the drawer shows "No frames on this page."
- [x] **AC14 — Follows the current page.** Switching pages moves the caret to the new current
      section and the drawer lists that page's frames.

## Evidence
Per line: PASS/FAIL + a screenshot (before/after where it applies) or a console/store observation
(e.g. `window.__ewEditor.getCamera()` bounds changing on jump; the drawer DOM node present/absent).
