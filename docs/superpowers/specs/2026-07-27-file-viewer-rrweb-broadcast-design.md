# File viewer: full-fidelity present mode via rrweb (v1 / tldraw engine)

**Date:** 2026-07-27 · **Status:** approved (design) · **Engine:** legacy v1 (tldraw) only

## Problem

The file viewer's present mode broadcasts only a scroll fraction. Followers
render their own copy of the document, so nothing else the presenter does —
hover, opening `<details>` sections, JS-driven DOM changes — reaches them.

We want "broadcast everything the presenter is seeing," built on a mature OSS
component rather than growing the bespoke bridge event-by-event.

**Feasibility was proven with a standalone demo** (scratchpad `rrweb-demo`):
rrweb 2.1.1 (MIT) records inside a `sandbox="allow-scripts"` iframe rendered
by our own `files-render.ts` pipeline and a live `Replayer` mirrors DOM
mutations, inline-style changes, `<details>` toggles, scroll, and cursor
position, at ~13 KB for the initial snapshot plus small incremental events.

## Goals (MVP)

- Presenter toggles the existing **Present** button; every follower's file
  viewer shows a live, full-fidelity mirror of the presenter's iframe:
  DOM mutations, scroll, mouse/hover, section open/close.
- Late joiners (viewer mounted mid-presentation) catch up via backlog.
- Present off (or presenter gone) → followers return to their own
  independently rendered iframe, exactly as today.

## Non-goals

- v2 (`canvas-v2`) engine — untouched. Its scroll-fraction present mode stays.
- Persistence or replay-after-the-fact. Events live in memory only, for the
  duration of a presentation.
- Follower interactivity during a presentation (mirror is read-only).
- Gesture-perfect fidelity guarantees for arbitrary third-party pages; the
  file viewer renders our own markdown pipeline output.

## Architecture

Presenter iframe (rrweb record) ──postMessage──▶ FileViewerShapeUtil
  ──HTTP POST batch (~150 ms)──▶ server relay
    ──TLSocketRoom.sendCustomMessage──▶ every other session
      ──onCustomMessageReceived──▶ follower FileViewerShapeUtil
        ──▶ rrweb Replayer (live mode, scale-to-fit) replacing the iframe

Who-is-presenting is unchanged: `presence.meta.fileViewerPresent`
(`client/src/file-viewer/presentStore.ts`, `followLogic.ts:presenterFor`).
rrweb events are the *content* channel only; presence remains the *signal*
channel.

## Components

### 1. Bridge extension — `server/src/files-render.ts`

- Rendered documents additionally load `/files-assets/rrweb.js` (served by
  the server from the vendored `rrweb` dist; new server dependency).
- `BRIDGE_SCRIPT` grows a dormant recorder: on parent `ew-present-start`,
  call `rrweb.record({emit})` posting `{type:'ew-rrweb-event', event}` to the
  parent (sampling: mousemove 40 ms, scroll 80 ms); on `ew-present-stop`,
  stop recording. Never records unless asked — zero cost for non-presenting
  viewers.
- Injection invariants preserved: single injection before the last real
  `</body>`, never a broken document.

### 2. Server relay — `server/src/features/file-viewer.ts` (extended)

- `POST /api/canvas/file-viewer/present-events`
  `{roomId, shapeId, presentId, entries: [{seq, event}]}` →
  append to the in-memory log for `(roomId, shapeId)`, then
  `sendCustomMessage(sessionId, {type:'ew-rrweb', shapeId, presentId, entries})`
  to every session in the room. (The HTTP POST carries no session identity,
  so the server cannot exclude the sender; the presenting client simply
  ignores `ew-rrweb` messages for shapes it is itself presenting.)
- `GET /api/canvas/file-viewer/present-events?roomId=&shapeId=` →
  `{presentId, entries}` full backlog (empty when nobody presents).
- `POST … /present-stop` `{roomId, shapeId, presentId}` → drop the log.
- `presentId` (random per presentation) guards against stale
  backlog/streams crossing presentations. Log capped (e.g. 5 000 events /
  ~5 MB per shape); on overflow the presentation degrades: log truncated-flag
  set, late joiners fall back to scroll-fraction-only following.

### 3. Presenter wiring — `client/src/file-viewer/FileViewerShapeUtil.tsx`

- Present toggled on: generate `presentId`, post `ew-present-start` into the
  iframe, buffer `ew-rrweb-event` messages, flush batches every ~150 ms to
  the relay endpoint. Toggled off (or unmount/shape delete): post
  `ew-present-stop`, call `present-stop`.
- Existing scroll-fraction publishing continues unchanged (harmless, keeps
  legacy followers working during mixed-version deploys).

### 4. Follower rendering — `client/src/file-viewer/`

- New module `rrwebFollow.ts`: client store receiving `ew-rrweb` custom
  messages (hooked in `App.tsx`'s `onCustomMessageReceived` beside the
  existing `'kicked'` case), keyed by shapeId; seq-ordered splice of backlog
  + live entries (drop `seq <= lastApplied`, buffer ahead-of-backlog arrivals).
- `FileViewerShapeUtil` while `presenterFor(shape)` resolves to a peer AND
  rrweb entries are flowing: render a `Replayer` container instead of the
  iframe (fetch backlog on mount, `liveMode: true`, `startLive()`, wrapper
  scaled to fit the shape box — transform-origin top-left, recompute on
  shape resize and replayer `resize` events). Presenter stops → tear down
  replayer, remount normal iframe.
- If no rrweb entries arrive within ~2 s of seeing a presenting peer (old
  server, overflow fallback), fall back to today's scroll-fraction follow.

## Error handling

- Relay POST failure: presenter retries next batch (events accumulate);
  after ~5 s of failures, silently stop recording and revert to
  scroll-fraction-only present (presence signal untouched).
- Replayer throw (malformed/missing events): tear down, fall back to
  scroll-fraction follow for that presentation.
- Server restart mid-presentation: log gone; followers' backlog fetch
  returns empty → scroll-fraction fallback until presenter re-toggles.

## Testing

- Unit (`bun test`): seq splice/dedup logic; relay endpoint append/fanout/
  backlog/stop + cap behaviour; `injectBridge` still single-injection with
  the extended script; recorder dormancy (no `rrweb.record` call without
  `ew-present-start`).
- Typecheck + build across workspaces.
- Manual smoke: two browsers, one room — present, interact (click/hover/
  details/scroll), verify mirror; late-join a third browser; stop → both
  followers back to own iframes.
- `ux-contract: none — client/src/file-viewer (legacy v1 engine) is not a
  contract-bearing surface (contracts cover canvas-editor/src/tools,
  canvas-react/src, client/src/canvas-v2)` recorded in the PR body.

## Dependencies

- `rrweb@2.1.1` added to `server` (serve dist asset) and `client`
  (`Replayer` import). MIT licensed.
