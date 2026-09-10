# Room switcher — design

- **Status:** SPEC (2026-09-10). Plan:
  [`../plans/2026-09-10-room-switcher.md`](../plans/2026-09-10-room-switcher.md).
- **Date:** 2026-09-10
- **Motivation:** Rooms exist, but there is no way to reach one from inside the
  app. Switching means hand-editing the `?room=` query param in the address bar,
  and there is no way at all to find out which rooms exist or where people are.
- **Companion docs:** none.

---

## 1. Motivation

A room is identified entirely by the `?room=` query param
(`client/src/identity.ts:122`, default `team`, validated
`/^[a-zA-Z0-9_-]{1,64}$/`). The client has no router — `main.tsx` renders one
tree and `getRoomId()` is read ad-hoc at ~15 call sites. The only navigation
primitive in the codebase is `buildFrameLink()`
(`client/src/chrome/frameLink.ts:12`), used for copy-link and Discord posts.

Consequences today:

1. **Switching rooms is a URL-editing power move.** You must know the room id
   already and type it into the address bar.
2. **There is no discovery.** No room list exists anywhere — not in the client,
   not on the server. Rooms are created lazily on first WS connect
   (`server/src/kernel/rooms.ts:28`), backed by `<roomsDir>/<roomId>.sqlite`,
   with no registry, no metadata, and no create/delete API.
3. **You cannot tell where anyone is.** Presence is tracked per room
   (`server/src/kernel/presence.ts`, surfaced by `GET /api/participants`), but
   only for the room you are already in.

The closest thing to a room listing today is `GET /api/health`, which reports
`[...roomHost.rooms.keys()]` — only rooms currently loaded in memory, not the
rooms that exist on disk (`server/src/app.ts:322`).

## 2. Goal and scope

Make the set of rooms visible and one click away, from the place that already
names the current room.

**In scope**

- A `GET /api/rooms` endpoint that enumerates rooms from disk with live
  participant counts.
- A dropdown in the side panel header that lists them and navigates.

**Out of scope** (deliberate, see §7)

- Creating rooms from the UI.
- Room display names, descriptions, or any room metadata.
- Archiving, hiding, or deleting rooms.
- Per-room access control.
- In-app (no-reload) room switching.

## 3. The design

### 3.1 Server — `GET /api/rooms`

A new kernel-reserved route, declared as a `ToolDef` in
`contracts/src/tools/kernel.ts` alongside `kernelWhoami` / `kernelParticipants`,
and mounted as its own feature router next to `createParticipantsRouter`.

Response:

```json
{ "rooms": [ { "id": "design-review", "participants": 0 },
             { "id": "team",          "participants": 3 } ] }
```

- **Room set** = the union of the `*.sqlite` basenames in the rooms directory
  and the in-memory `roomHost.rooms` keys. The union matters: a room opened this
  process but not yet flushed, and a room that exists on disk but was never
  opened this boot, must both appear.
- **Validation.** Every id is filtered through `sanitizeId`
  (`server/src/canvas/ids.ts`) — the same `/^[a-zA-Z0-9_-]{1,64}$/` the client
  uses. A stray or hostile filename in the rooms directory can never reach the
  UI.
- **Ordering.** Alphabetical, sorted server-side, so every client agrees and the
  client needs no sort of its own.
- **Participant counts** come from the presence data already backing
  `/api/participants`: for each room currently open and not closed,
  `buildParticipants(getCursorRefs(room), …).length`. `buildParticipants`
  de-duplicates by raw user id, so a teammate with two tabs open counts once —
  counting `getCursorRefs(...).length` directly would over-report. A room not
  open in memory reports `0`, which is correct: nobody is connected to it.

  **Known delta.** The header's own count is client-side and different —
  `editor.getCollaborators().length + 1` (`SidePanel.tsx:320`), which counts
  *you* plus tldraw's collaborator set. The popover's count for the current room
  is the server's deduped presence figure. The two can disagree by one for a
  peer who is connected but has not yet published a cursor. Accepted: both are
  honest answers to "how many people are here", the window is brief, and
  reconciling them would mean either a server round-trip for the header or
  reimplementing presence in the client.

The enumeration itself lives on `RoomHost` as a new `listRoomIds(): string[]`,
not in the router. `RoomHost` is already the one module that knows the on-disk
layout (`path.join(roomsDir, '<id>.sqlite')`); putting the glob anywhere else
would duplicate that knowledge. The router stays a thin presence join.

### 3.2 Client — the switcher

The side panel header currently renders the room id as a static uppercase mono
`<span>` on the left, with the participant count on the right
(`client/src/chrome/SidePanel.tsx:470`).

That span becomes the trigger:

```
┌─────────────────────────────┐
│  TEAM ▾                  3  │   ← header row, unchanged layout
├─────────────────────────────┤
│  ┌───────────────────────┐  │
│  │ design-review       0 │  │   ← popover, flat alphabetical
│  │ dogfood             1 │  │
│  │ team              ✓ 3 │  │   ← current room, inert
│  └───────────────────────┘  │
```

- **Trigger.** Same type treatment as today (mono, 11px, 700, uppercase, 0.9
  letter-spacing) plus a `▾` chevron, wrapped in a `<button>`. No new chrome, no
  extra row: the header keeps its exact current height and layout.
- **Popover.** Absolutely positioned below the trigger, reusing
  `popoverBoxStyle` from `client/src/chrome/popover.ts`. (Only the box style is
  reused — `popoverPositionStyle` is dock-edge logic for the command bar and
  does not apply here.)
- **Rows.** Flat alphabetical list, one row per room: room id on the left,
  participant count on the right in `wm.inkMuted`. The count is omitted entirely
  when zero rather than rendering a `0`, so occupied rooms are the only thing
  carrying a number and read as such at a glance.
- **Current room** is marked and is not a navigation target — clicking it just
  closes the popover.
- **Fetch on open, not on mount.** The panel must not pay for a list nobody
  looked at. The result is held for the popover's lifetime and re-fetched on the
  next open, so counts are never stale-but-plausible.
- **States.** Loading row (`loading…`), empty row (`no rooms`), and an error row
  with a retry affordance. All are single lines in `wm.inkSubtle` / `wm.crit` —
  this is a 200px-wide popover, not a page.
- **Collapsed panel.** The side panel collapses to a 32px rail
  (`RAIL_WIDTH`, `SidePanel.tsx:368`) and force-collapses in Present mode. The
  trigger is simply not rendered in the rail — expand the panel to switch. No
  second rendering path.

### 3.3 Navigation — a full page load, deliberately

Selecting a room calls `window.location.assign(buildRoomLink(origin, roomId))`.

`buildRoomLink(origin, room)` is added to
`client/src/chrome/frameLink.ts`, which already constructs `/?room=…`;
`buildFrameLink` is refactored to call it so the two cannot drift.

**Why not an in-app switch.** The room id is bound to roughly a dozen subsystems
at runtime:

| Subsystem | Where the room id enters |
|---|---|
| tldraw sync WS | `client/src/App.tsx:91` |
| canvas-v2 sync WS | `client/src/canvas-v2/CanvasV2App.tsx:209` |
| LiveKit audio/video | `client/src/av/AvOverlay.tsx:26`, `av/useLiveKitRoom.ts:70,184,305` |
| Session pulse / presence | `client/src/av/useSessionPulse.ts` |
| Connection telemetry | `client/src/App.tsx:172` |
| Single-tab lock | `client/src/main.tsx:48`, lock name `ew-canvas-<room>/<user>` |
| Terminal status writes | `server/src/features/terminal-status.ts:16` |
| Discord bindings | `client/src/discord/BindingsPanel.tsx:42` |
| Transcript | `client/src/chrome/SidePanel.tsx:536` |
| Roadmap docs | `client/src/roadmap/RoadmapShapeUtil.tsx:135` |
| Web viewer / present relay | `client/src/web-viewer/WebViewerShapeUtil.tsx:168` |
| **Engine selection** | `client/src/main.tsx:36` |

The last one is decisive. `selectEngineFromEnvironment(getRoomId())` runs **once
at module evaluation, before render**, and the v2 module graph sits behind a
`React.lazy` dynamic import whose zero-exposure invariant assumes the branch is
picked once per page load (`client/src/engine.ts`, its `engine.test.ts`, and
`scripts/exposure-audit.ts`). An in-app switch would have to either re-run that
decision mid-session or refuse to cross the tldraw/v2 boundary.

A page load re-initialises every row of that table correctly and for free,
including engine selection, and requires no teardown code at all. It also makes
switching between a tldraw room and a canvas-v2 room work with no special
handling. The cost is a page load — which is exactly what switching rooms costs
today, via the address bar.

**No confirmation step.** Switching drops you out of the current room's audio.
That is inherent to leaving a room, the previous room is one click back, and a
confirm dialog would tax the common case (hopping between quiet rooms) to
protect the rare one. Explicit product decision, not an oversight.

## 4. Data flow

```
popover opens
   └─> GET /api/rooms
         └─> RoomHost.listRoomIds()          disk *.sqlite ∪ in-memory keys,
         │                                    sanitizeId-filtered, sorted
         └─> presence lookup per open room   live cursor refs -> count
   <── { rooms: [{ id, participants }] }
click row
   └─> window.location.assign('/?room=<id>')  full page load
```

## 5. Error handling

- **Endpoint unreachable / non-2xx** — the popover shows one error line with a
  retry. The header trigger still works; nothing else in the panel is affected.
- **Rooms directory missing** — `listRoomIds()` returns the in-memory keys only.
  Not an error: an empty rooms dir is the legitimate state of a fresh install.
- **Unreadable / non-`.sqlite` entries** — skipped silently. The directory is
  server-owned; a stray file is not a user-facing condition.
- **Ids failing `sanitizeId`** — dropped, never surfaced.

## 6. Security

`GET /api/rooms` exposes every room name to any caller past the deployment's
Cloudflare Access boundary (`server/src/access-identity.ts`).

This is a change in **discoverability, not access**. There is no per-room ACL
today: any authenticated user can enter any room by URL, and an unknown id
silently creates one. Room ids are short and guessable, and `/api/health`
already leaks the in-memory subset. Recording the change explicitly; not
solving it here. If per-room access control is ever introduced, this endpoint
is one of the surfaces it must cover.

The endpoint is read-only and sits behind the existing write-scope guard
(`server/src/features/write-scope.ts`) without needing a write scope.

## 7. Rejected alternatives

- **Type-to-filter combobox that creates rooms.** Would have surfaced the
  existing hidden capability (any URL conjures a room). Rejected to keep the
  first cut switch-only; creating a room stays a URL move.
- **Occupied-rooms-first sorting, or a recents section with "show all".**
  Better at answering "where is everyone" as the room count grows, at the cost
  of sorting surprise and extra state. Rejected for now in favour of a flat,
  predictable alphabetical list; revisit if the list actually gets long.
- **Client-side `localStorage` recents only.** No server change, but a new
  teammate's dropdown is empty and rooms other people made are undiscoverable.
- **Build-time `VITE_ROOMS` allowlist.** Trivial, but adding a room would need a
  rebuild and deploy.
- **A real rooms registry** (table, display names, explicit Create Room). The
  right end state if rooms ever need names or ownership; far too much for making
  a list visible.
- **An icon in the 32px collapsed rail.** One more rendering path and a cramped
  popover anchor, for a rare case.

## 8. canvas-v2 parity

Nothing to do. The switcher lives in `client/src/chrome/SidePanel.tsx`, which is
app chrome outside the canvas engine, and navigation is a page load — so a v2
room gets the same switcher and a switch *into* a v2 room re-runs engine
selection naturally.

## 9. Interaction contract

**`ux-contract: none — side-panel chrome, not a canvas interaction surface.`**

The contract gate (`scripts/ux-contract-presence.test.ts`) covers
`canvas-editor/src/tools/`, `canvas-react/src/`, and `client/src/canvas-v2/`.
This work touches `client/src/chrome/`, `client/src/identity.ts` (untouched),
`server/src/`, and `contracts/src/` — none of which are gated. The opt-out line
with its reason goes in the PR body.

## 10. Testing

The repo's unit harness (`scripts/run-tests.ts`) spawns every
`**/src/**/*.test.ts` under **bare `bun`** — no DOM, no bundler. So React
components get no unit test here by construction, and the design pushes every
decision worth testing into pure modules.

- `client/src/chrome/frameLink.test.ts` — extend for `buildRoomLink`, and assert
  `buildFrameLink` still produces its existing output after the refactor.
- `client/src/chrome/rooms.test.ts` — the pure client-side shaping of an
  `/api/rooms` payload into render rows (current-room marking, zero-count
  omission), with no React import.
- `server/src/rooms-api.test.ts` — boot `createSyncApp` over a temp
  `databaseDir` (the `server/src/database-dir.test.ts` pattern), create rooms,
  and assert the endpoint's set, sorting, id filtering, and counts.
- **Manual smoke:** with `bin/dev up`, open `/?room=team`, open the popover,
  confirm the list and counts, switch to another room, confirm the URL, the
  header, and that audio/sync reconnect.

## 11. Files

| File | Status | Responsibility |
|---|---|---|
| `contracts/src/tools/kernel.ts` | modify | `kernelRooms` ToolDef; add to `kernelTools`. |
| `server/src/kernel/rooms.ts` | modify | `RoomHost.listRoomIds()` — disk ∪ memory, filtered, sorted. |
| `server/src/features/rooms.ts` | create | `createRoomsRouter(ctx)` — presence join, JSON response. |
| `server/src/app.ts` | modify | Mount the router after `createParticipantsRouter`. |
| `server/src/rooms-api.test.ts` | create | Endpoint test over a temp `databaseDir`. |
| `client/src/chrome/frameLink.ts` | modify | `buildRoomLink`; `buildFrameLink` delegates to it. |
| `client/src/chrome/frameLink.test.ts` | modify | Cover `buildRoomLink` + no-regression on `buildFrameLink`. |
| `client/src/chrome/rooms.ts` | create | Pure payload → render-rows. No React, no DOM. |
| `client/src/chrome/rooms.test.ts` | create | Unit test for the above. |
| `client/src/chrome/RoomSwitcher.tsx` | create | Trigger button + popover + fetch/loading/error states. |
| `client/src/chrome/SidePanel.tsx` | modify (~line 470) | Replace the static room-id span with `<RoomSwitcher />`. |
