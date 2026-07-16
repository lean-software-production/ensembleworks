# Viewport-relative spatial audio + legibility layer — design

**Date:** 2026-07-16
**Status:** Approved in discussion; spec for review
**Builds on:** PR #29 (crosstalk) — `av/crosstalk.ts`, `av/useSpatialGainLoop.ts`

## Problem

Today a teammate's volume is a function of **page-unit** distance between my
viewport centre and their cursor (`av/spatial.ts`: full volume inside
`huddleRadius: 600`, linear falloff to `floor: 0.04` at `falloffEnd: 3500`).
Zoom level plays no part. Two consequences:

1. **Zoom doesn't mean anything acoustically.** Zooming into a corner of the
   page to pair with one person doesn't focus the audio on them; zooming all
   the way out to address the room doesn't widen your reach.
2. **Silence is illegible.** People "suddenly can no longer hear each other
   when they move their cursor to another area of the page" — while the video
   tile stays fully bright. The cause (spatial falloff) is invisible; the
   effect (silence) looks like a bug.

## Goals

- Zoomed in on an area → people working in that area (by cursor) are loudest;
  people outside the viewport are softer; people on other pages softest
  (crosstalk floor).
- Zoomed all the way out (all cursors visible) → everyone on the page is
  audible ≈ full: zoom-to-reach.
- Every surface that shows a person also shows *how audible they are*, so
  quiet is never a surprise.

## Non-goals (YAGNI)

- No symmetric / negotiated volumes (each listener computes their own mix —
  A may hear B louder than B hears A; that mirrors physical rooms with
  different-sized "ears" and needs no coordination).
- No new presence broadcast, no server or transcriber changes. Everything is
  computed client-side from data already replicated (peer cursors,
  `currentPageId`) plus purely local state (my camera).
- No per-person manual volume overrides, no persistence of any new state.

## Section 1 — Gain model: egocentric, screen-space radial

**Loudness of peer P, for me = `gainForDistance(screenDistance(P))`** where

```
screenDistance = pageDistance(myViewportCentre, P.cursor) × myZoom
```

and the huddle/falloff radii are re-expressed as **fractions of my viewport's
half-diagonal in screen pixels** (resolution-independent):

```
huddleRadius  = 0.45 × halfScreenDiagonal
falloffEnd    = 1.6  × halfScreenDiagonal
floor         = 0.04   (unchanged)
```

Properties:

- The falloff **curve** is untouched — same shape, same floor, same
  unit-tested function. Only the *input metric* changes from page units to
  screen pixels.
- **Zoom is reach.** Zoom in: the same page distance becomes more screen
  pixels → peers outside your focus fade. Zoom out: page distances shrink in
  screen pixels → at full zoom-out every on-page cursor lands inside the
  huddle radius → whole-page conversation, no mode switch.
- **Panning is handled for free**: a cursor far off-screen is far in screen
  pixels regardless of zoom.
- **No cliff at the viewport edge.** The radial falloff extends smoothly past
  the frame (falloffEnd ≈ 1.6× half-diagonal), so drifting out of view makes
  someone *quieter*, not silent — chosen over a viewport-rectangle
  containment model precisely because a hard frame-edge cliff would reproduce
  the "sudden silence" confusion.

### Composition with crosstalk (PR #29)

`gainTarget()` in `av/crosstalk.ts` is unchanged:

- `absent` → 0
- `other-page` → crosstalk bleed level (default 0)
- `my-page` → `standupMode ? 1 : pageGain`

Only the **`pageGain` input** becomes viewport-relative. Standup mode still
pins everyone on my page to full. A peer on my page with no cursor yet still
counts as full volume.

## Section 2 — Legibility layer

Four cues, all driven by the **same per-peer gain value** the audio loop is
applying — never a parallel computation, so what you see always matches what
you hear. Three ambient (always on) + one on-demand:

1. **Video tile dims with volume** (`chrome/PanelTile.tsx`). Tile opacity is
   a pure mapping of gain, floored at **0.35** — quiet peers look
   present-but-distant, never invisible. A near-floor gain also gets a
   non-opacity signal (e.g. a small "quiet" glyph on the tile) so the state
   is legible to users who can't perceive the dimming.
2. **Their canvas cursor fades/shrinks with gain** — the cause (distance) and
   the effect (volume) are shown in the same place.
3. **"Your audible zone" ring** on the canvas: a circle of radius
   `huddleRadius / zoom` (page units) centred on the viewport centre, with a
   fainter outer ring at the falloff end. It visibly **grows as you zoom
   out**, teaching the zoom-to-reach gesture without words.
4. **Per-peer % readout on hover/focus** of a video tile — the exact number,
   on demand only.

Motion: visual cues ease with roughly the same time constant as the audio
ramp (0.08 s `setTargetAtTime`), so eyes and ears agree. `prefers-reduced-motion`
disables the eased transitions (values still update, instantly).

## Section 3 — Architecture

### Pure core (bun-tested, no AudioContext / tldraw imports)

- **`av/spatial.ts`** — add `gainForScreenDistance(pageDistance, zoom,
  viewportHalfDiagonal, settings)` (or equivalent explicit conversion), with
  screen-space settings expressed as viewport fractions. Existing
  `gainForDistance` and its tests stay green.
- **`av/crosstalk.ts`** — no logic change; its tests pass verbatim.
- **New pure helper** `tileOpacityForGain(gain)` for the video-dim mapping.

### The loop — `av/useSpatialGainLoop.ts`

- Per 150 ms tick, read `editor.getZoomLevel()` and viewport bounds **once**,
  then compute each peer's gain in screen space. Same single per-participant
  `GainNode`, same 0.08 s ramp. Per-tick cost stays O(peers) with a handful
  of arithmetic ops — no new allocations of note, no extra tldraw queries per
  peer.
- **New output:** the loop publishes the per-peer gain map it just applied
  (via the existing `av/bridge.ts` snapshot path). This is the single source
  of truth all four cues subscribe to.

### Bridge & UI

- **`av/bridge.ts`** — extend the AV snapshot with per-peer gain; extend
  `avSnapshotsEqual` accordingly (mirror of how `crosstalkLevel` was
  threaded). To avoid re-rendering React 6–7×/second on micro-changes,
  snapshot gains are **quantised (e.g. to 0.05 steps)** before equality
  comparison; CSS transitions smooth between steps.
- **`chrome/PanelTile.tsx`** — tile dim + hover % readout, reading gain from
  the snapshot.
- **Canvas overlays** (cursor fade, audible-zone ring) — an `av/` overlay
  sibling to the existing leash rendering, derived from viewport bounds +
  settings; no new state.

### Server impact

**None.** No new messages, no presence schema change, no additional
replication traffic. The only new work is client-local: ~O(peers) arithmetic
per 150 ms tick and a quantised snapshot publish.

## Section 4 — Testing

RED → GREEN → WIRE, mirroring the crosstalk PR:

1. `spatial.test.ts` additions (RED first): same page distance at different
   zooms → different gains; zoom → 0 pulls all on-page peers toward full;
   screen-space radii scale with viewport size; finite-input guards.
2. Pure helpers GREEN: `gainForScreenDistance`, `tileOpacityForGain`
   (floor at 0.35, monotone, clamped).
3. `bridge` tests (WIRE): per-peer gain in snapshot; `avSnapshotsEqual`
   detects a quantised gain change and ignores sub-quantum jitter.
4. Manual: two sessions on the dev stack — zoom in/out and pan; confirm
   tiles, cursors, and the zone ring track volume; confirm video is never
   bright-but-silent.
5. Gates: `bun run typecheck` and `bun run build` green across workspaces.

## Open tunables (defaults chosen, adjustable after feel-testing)

- Huddle / falloff fractions: 0.45 / 1.6 of the half-diagonal.
- Tile opacity floor: 0.35.
- Gain quantisation step for snapshot publishing: 0.05.

## Amendment (2026-07-16, after first two-device feel-test)

Two changes from live testing:

1. **Gain model switched from screen-space radial to viewport-rect.** A peer
   whose cursor is anywhere INSIDE my viewport rectangle is at full volume —
   "if I can see their cursor, I can hear them". Beyond the edge, linear fade
   (of the screen-pixel shortfall to the nearest edge/corner, via
   `screenDistanceOutsideRect`) down to the floor at `falloffFraction: 1` ×
   half-diagonal past the edge. Continuous at the boundary — no cliff.
   Motivation: with the radial model (full volume only within 0.45 ×
   half-diagonal of centre), a cursor near the screen edge was already ~50%
   faded. In particular, moving your pointer into the side panel parks your
   tldraw cursor at the canvas edge, so panel use made you audibly "drift
   away" for everyone. Under the rect model an in-view cursor — including one
   parked at the edge — stays at 100%.
2. **The audible-zone ring (legibility cue #3) is removed** — it was visually
   irritating in practice. The remaining cues (tile dim + quiet glyph, cursor
   fade, hover % readout) carry the legibility load.
