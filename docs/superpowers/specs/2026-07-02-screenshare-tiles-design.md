# Screen-share tiles on the canvas — design

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Parent spec:** "Live Screen Sharing on a Collaborative Canvas" (high-level design, reviewed 2026-07-02)

## Summary

Any member can share one or more desktop windows (or screens) into the room as
independent, movable, aspect-true tldraw tiles. Everyone sees the live stream,
can annotate around it with ordinary canvas shapes, and only receives video for
tiles currently in their viewport. No new services: the feature is a client
module plus a server schema entry, riding the already-deployed self-hosted
LiveKit SFU, the existing token endpoint, and tldraw sync.

## Decisions (settled during brainstorming)

1. **Multi-window from day one.** Each share is an independent
   `getDisplayMedia()` capture published as its own named LiveKit track. Never
   `setScreenShareEnabled()` (single-track assumption); tracks are routed by
   **name**, `screen:<uuid>`.
2. **Sharer's client owns the tile lifecycle.** It creates the shape on
   publish, deletes/unpublishes on stop. No webhooks, no derived-state races.
3. **Viewport scoping = adaptiveStream + dynacast + an explicit per-track
   subscription loop.** `autoSubscribe` stays on so the spatial-audio path is
   untouched.
4. **Simulcast on with capped layers.** Top layer ≈1080p @ 10–15 fps,
   ~2.5 Mbps, `contentHint: 'detail'`; one cheap low layer (~360p) for
   zoomed-out tiles.
5. **Aspect follows the source.** The tile is locked to the captured surface's
   real aspect ratio, and when the sharer resizes the shared window the tile's
   proportions follow (synced prop update from the sharer's client).
6. **Video only in v1.** No tab/system audio; voice is already covered by
   spatial mic audio.

## What already exists (reused, not built)

| Need | Existing machinery |
|---|---|
| SFU, auth, deploy | Self-hosted LiveKit (`deploy/systemd/ensembleworks-livekit.service`, cutover script, Caddy `/livekit` route, media UDP 50000–50300); token endpoint `server/src/app.ts` `GET /api/livekit-token` already grants `canPublish` to members |
| Room connection | `client/src/av/useLiveKitRoom.ts` (connect, publish, track events); LiveKit identity ≡ tldraw presence userId |
| Live-video-in-a-shape pattern | `client/src/neko/NekoShapeUtil.tsx` — aspect-locked `BaseBoxShapeUtil`, 28px header, inert-until-edit pointer events, shared-props / per-viewer-stream split |
| Viewport-reactive loop | Spatial-audio gain loop in `client/src/av/AvOverlay.tsx` (150 ms interval over `editor.getViewportPageBounds()`), pure logic in `client/src/av/spatial.ts` with unit tests |
| Multiplayer annotation | tldraw sync — shapes drawn over/around tiles sync for free |
| Shape registration pattern | `client/src/App.tsx` `customShapeUtils` + `server/src/schema.ts` validators |
| Graceful A/V absence | `{ enabled: false }` from the token endpoint hides all A/V UI |

## New components

All new client code lives in `client/src/screenshare/`.

### 1. Publishing — `useScreenShare.ts`

Hook (used from the toolbar/UI layer, with the LiveKit `Room` from
`useLiveKitRoom`):

- `startShare()`:
  1. `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })`.
     Rejection (picker cancelled) is a silent no-op.
  2. Read true dimensions from `track.getSettings()`.
  3. `localParticipant.publishTrack(track, { name: 'screen:<uuid>', source: Track.Source.ScreenShare, simulcast: true, screenShareEncoding: <capped 1080p layer>, screenShareSimulcastLayers: [<~360p layer>] })`
     with `contentHint = 'detail'` on the track.
  4. Create the shape (below) at the sharer's viewport center with the
     measured aspect.
- Listens for the track's `ended` event (browser "Stop sharing" bar) →
  unpublish, but KEEP the tile on the canvas as a frozen-last-frame tombstone
  (an annotatable artifact of what was shown). Deleting the tile is how a
  share is removed.
- Listens for track dimension changes (source window resized) → update the
  shape's `aspect` prop, keeping `w` fixed and adjusting `h`.
- If the shape is deleted on the canvas (by anyone) while the share is live,
  the sharer's client notices (store listener) and stops the capture.

Multiple concurrent shares are just multiple invocations; state is a map keyed
by track name.

### 2. Shape — `ScreenShareShapeUtil.tsx`

Type `screenshare`, cloned structurally from `NekoShapeUtil`:

- **Synced props:** `w, h, participantId, trackName, title, aspect`.
- `BaseBoxShapeUtil`, `isAspectRatioLocked() → true`, `hideRotateHandle`,
  `onResize` via `resizeBox()` + `lockAspect(w, h, prevW, prevH, aspect)` — a
  generalization of `lockNekoAspect` (same fixed 28 px header, parameterized
  ratio), unit-tested the same way.
- **Component:** 28 px header (title + status dot) over a `<video>` body with
  `object-fit: contain` (so mid-resize transitions letterbox rather than
  distort). Pointer events inert until the shape is in edit mode.
- **Track binding (per-viewer, not synced):** resolve the track by
  `participantId` + `trackName` — the sharer attaches their **Local** track
  (self-preview); viewers attach the **Remote** track when the subscription
  delivers it. Iterate all publications by name; never use the
  source-keyed single-screen-share getter.
- **States:** *connecting* (shape exists, track not yet attached), *live*,
  *ended* (track unpublished or participant left). Non-live tiles show a
  frozen still of the last frame that viewer saw (captured client-side when
  the track detaches), with a "share ended"/"paused" badge. When a share ends
  gracefully, the sharer's client uploads that final frame (≤1280w JPEG) via
  the existing `/uploads` asset path and stamps its URL into the synced
  `stillUrl` prop — so the tombstone survives viewer refreshes and reaches
  people who never saw the stream. Only if the sharer's tab dies before
  uploading does a refreshed viewer fall back to the text placeholder. The
  tombstone persists until someone deletes it.
- **Title:** baked into the synced props at share time as
  `<sharer name> · <window title>` (falling back to "screen share" when the
  browser's track label is an opaque id), so tombstones still say whose
  window they were.
- Registered in `client/src/App.tsx` `customShapeUtils` **and**
  `server/src/schema.ts` (both are required; missing the server entry breaks
  sync validation).
- Toolbar tool + icon following the neko tool pattern in `client/src/ui.tsx`;
  hidden when A/V is disabled or the participant lacks `canPublish`
  (scribe/read-only).

### 3. Viewport-scoped subscription — `visibility.ts` + a manager loop

- **Room options change** in `useLiveKitRoom.ts`:
  `new Room({ adaptiveStream: true, dynacast: true })`. Cameras in the faces
  rail benefit too; dynacast stops *encoding* layers nobody watches, saving
  the sharer's CPU/uplink.
- **Explicit loop** (same 150 ms cadence as the spatial-audio loop, living
  alongside it inside the tldraw component tree): for every remote publication
  named `screen:*`, find its shape, intersect the shape's page bounds with
  `editor.getViewportPageBounds()`, and call
  `publication.setSubscribed(visible)`.
- **Pure logic** in `visibility.ts`: intersection test with a margin band
  (hysteresis — subscribe when within one margin of the viewport, unsubscribe
  only when beyond a larger one) so panning along a tile edge doesn't flap.
  Unit-tested like `spatial.ts`.
- A publication with no corresponding shape on the current page is
  unsubscribed.

## Data flow

```
sharer: getDisplayMedia ──► LocalVideoTrack ──publishTrack(name)──► LiveKit SFU
sharer: editor.createShape({type:'screenshare', props:{participantId, trackName, aspect,…}})
                                    │ tldraw sync
viewer: shape appears ──► visibility loop: in viewport? ──setSubscribed──► SFU forwards
viewer: RemoteVideoTrack ──attach──► <video> in the shape
anyone: draws tldraw shapes over/around the tile ──► tldraw sync (annotation, free)
```

## Error handling

- **Picker cancelled** → no track, no shape, no error surfaced.
- **A/V disabled** (`enabled: false`) → share tool hidden entirely.
- **Sharer tab dies** → LiveKit unpublishes on disconnect; viewers render the
  *ended* overlay; tombstone shape is manually deletable by anyone.
- **Occluded/minimized source windows may freeze** (OS/browser-dependent) —
  noted in the tile header tooltip, not solved.
- **Cold-join over-subscription** — the explicit loop unsubscribes
  out-of-viewport tracks within one tick of joining, bounding the blip.

## Testing

- **Unit:** `lockAspect` and `visibility.ts` (intersection + hysteresis) as
  pure functions, following `neko.test.ts` / `spatial.ts` precedent.
- **Typecheck:** `npm run typecheck` (all three workspaces).
- **End-to-end (headless):** two Playwright Chromium contexts against the dev
  stack — the sharer launched with `--auto-select-desktop-capture-source` /
  fake-media flags publishes a share; assert the viewer's tile attaches and
  renders frames, the tile's aspect matches the fake source, and panning the
  viewer away flips the publication to unsubscribed (and back). Same headless
  driving approach as the roadmap debugging workflow.

## Out of scope (v1)

Remote control (the existing neko shared-browser module remains the future
"request control" vehicle), recording/persistence, tab/system audio, a native
multi-window capture agent (reserve option if per-window consent prompts prove
intolerable), annotations that track content inside the stream, mobile
capture, and any per-room cap enforcement on simultaneous shares (bandwidth
budget: ~770 Mbps measured uplink; a capped 2.5 Mbps top layer means dozens of
concurrent tiles before it matters — revisit with real usage).
