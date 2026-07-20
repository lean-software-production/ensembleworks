# Panel Video Mosaic — Design

**Date:** 2026-07-19
**Status:** Approved (brainstormed with visual mockups; see `.superpowers/brainstorm/` sessions from this date)

## Problem

With ~25 participants on a canvas, the side panel's vertical stack of video tiles
forces scrolling to find whoever is talking. Widening the panel produces a grid
but eats the canvas. An earlier experiment attaching video circles to cursors was
confusing, especially with people spread across different pages.

Primary job of participant video (decided during brainstorm): **room awareness** —
an at-a-glance scan of everyone, not a hero view of the speaker.

## Design summary

Replace the per-page vertical tile stack with a **page-grouped video mosaic**:

- Every page section in the side panel shows its participants as a grid of
  uniform square-ish tiles. No hero/speaker tile. Empty pages render as today.
- **Tile size is derived, not chosen.** There is no slider or new control.
  Dragging the existing panel edge is the one gesture that changes face size.
- **Everyone on your current page is always visible** — no scrolling within a
  group, ever.

## Sizing rules

For the group of the page you are on:

- `columns = ceil(sqrt(N))` where N = number of participants on the page
  (square-ish grid).
- `tileEdge = floor(availablePanelWidth / columns)`, clamped to a legibility
  floor of **36px**. (If the floor forces overflow beyond the panel width the
  grid still lays out at 36px and wraps to more rows; it never scrolls
  horizontally and never hides anyone.)
- Worked example: 14 people → 4 columns; at the 280px default panel width
  that is ~70px tiles in a 4×4 block; panel dragged to 560px → ~140px tiles
  (expression-reading size). Name labels render when tiles are large enough
  (≥ ~64px).

For every **other** page's group:

- Tiles are pinned at a fixed ambient minimum (~40px chips) regardless of
  panel width, carrying live micro-video when the camera is on (initials
  otherwise). Speaking rings still render at chip size. Widening the panel
  enlarges *your room's* faces only. (Amended 2026-07-19: originally 22px
  initials-only; live video at 40px preferred after using it.)

The mosaic's controls row (under the current page's tiles) also carries a
**tile-size multiplier** (0.5×–3×, amended 2026-07-20) applied on top of the
width-derived size and re-clamped to the same floor/cap. Panel width remains
the baseline control; the multiplier is taste on top.

Persistence: the multiplier persists alongside panel width in `panelLayout.ts`
localStorage state. Collapsed-rail behaviour is unchanged.

## Ordering rules

Within your page's group:

- Tiles sort by each collaborator's cursor distance from **your viewport
  centre**, closest first, reading top-left → bottom-right. (Cursor positions
  and camera state are already available via `editor.getCollaborators()` and
  the editor camera.)
- **Manual re-sort** (amended 2026-07-20, was settle-after-pause): the order
  recomputes at mount and when the user presses the **Reorder** button in the
  mosaic's controls row; tiles animate to their new positions (FLIP-style) so
  moves are trackable. Panning, zooming and cursor movement never re-sort.
- Your own tile participates in the order (it will naturally be first when
  your cursor is near your viewport centre); it keeps its existing "you"
  affordances.

Other pages' groups:

- Proximity is meaningless cross-page, so those groups order by
  **most-recently-spoke** first, then join order.

## Speaking cue

- Green ring on the speaking participant's tile (existing `isSpeaking` from
  the AV snapshot in `client/src/av/bridge.ts`), optionally a subtle ≤1.05×
  pulse. No floating tiles, no sticky speaker chip: at default width everyone
  on your page is on screen, and other pages' chips still show rings.

## Video liveness / bandwidth

- Active speaker(s): normal-quality LiveKit subscription.
- Everyone else on your page: lowest simulcast layer; at minimum tile sizes a
  paused periodic still is acceptable.
- Other pages' chip-size tiles: always lowest layer (or stills).

## Components touched

- `client/src/chrome/PanelPages.tsx` — page-section rosters already built
  here; replace the vertical tile list with the mosaic grid per group.
- `client/src/chrome/PanelTile.tsx` — tile rendering at variable sizes;
  label visibility threshold.
- `client/src/chrome/panelLayout.ts` — pure sizing math (columns from N,
  tile edge from panel width) lives beside the existing width-clamp logic.
- `client/src/av/` — speaking state and per-peer subscription quality
  (existing bridge/snapshot machinery).
- New pure module for ordering: viewport-distance comparator,
  recently-spoke comparator, and the 1s settle debounce.

## Error handling / edge cases

- N = 0: page section renders header only (today's behaviour).
- N = 1: single tile at min(panel width, a sane max) — degenerate grid.
- Camera/cursor unavailable for a collaborator (e.g. never moved): sort
  those last within the group, stable by join order.
- Panel at collapsed rail: unchanged (existing dot rail).
- Participant joins/leaves mid-session: grid re-flows immediately (join/leave
  is not subject to the 1s settle debounce; only viewport-driven re-sorts are).

## Testing

Unit tests (bare-bun test scripts with `node:assert`, colocated as elsewhere
in `client/src`; auto-discovered by `scripts/run-tests.ts`):

- Sizing math: columns/tile-edge from (N, panelWidth), 36px floor, label
  threshold.
- Viewport-distance comparator incl. missing-cursor fallback.
- Recently-spoke comparator.
- Settle-debounce: no reorder while moving; single reorder ~1s after stop;
  join/leave bypasses debounce.

Manual/e2e: 25-participant session smoke via existing e2e harness — verify no
group scroll at default width and correct speaker rings.

## Out of scope

- On-canvas / cursor-attached video (tried previously; confusing across pages).
- Bottom filmstrip overlay (rejected in brainstorm).
- Click-to-promote hero tiles, per-group size controls, spatial-audio changes.
