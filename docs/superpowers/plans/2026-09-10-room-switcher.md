# Room switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the set of rooms visible and one click away — a `GET /api/rooms`
endpoint that enumerates rooms from disk with live participant counts, and a
dropdown on the side panel's existing room-id label that lists them and
navigates.

**Architecture:** Three layers, each independently testable. (1) `RoomHost`
gains `listRoomIds()` — the only place that knows the on-disk room layout — and
a thin `createRoomsRouter` joins that list against live presence. (2) Two pure
client modules: `buildRoomLink` in the existing `frameLink.ts`, and a new
`chrome/rooms.ts` that shapes an API payload into render rows. (3) One React
component, `RoomSwitcher.tsx`, which owns fetch/open/error state and renders the
popover; it replaces the static room-id `<span>` in `SidePanel.tsx` and holds no
decision logic of its own. Navigation is `window.location.assign` — a full page
load, deliberately (spec §3.3).

**Tech Stack:** TypeScript, Express (server routers), Zod (`ToolDef` contracts),
React 18 (client chrome), Bun test runner (`bun scripts/run-tests.ts`),
`node:assert/strict`.

**Source spec:** [`docs/superpowers/specs/2026-09-10-room-switcher-design.md`](../specs/2026-09-10-room-switcher-design.md).

## Global Constraints

- **No DOM in unit tests.** `scripts/run-tests.ts` spawns every
  `**/src/**/*.test.ts` under **bare `bun`** — no DOM, no bundler, no JSX
  transform. Any module with a `.test.ts` must therefore import no React and no
  tldraw. This is why `chrome/rooms.ts` exists as a separate module from
  `RoomSwitcher.tsx`; keep that split. (Same rule stated at the top of
  `client/src/chrome/framesDrawerLayout.ts`, `panelLayout.ts`, `frameLink.ts`.)
- **Indentation is tabs** throughout `client/src`, `server/src`, and
  `contracts/src`. Match the surrounding file.
- **No new room semantics.** Do not add a create-room path, room metadata,
  display names, archiving, or any ACL. Rooms remain conjured by URL exactly as
  today. (spec §2, §7)
- **No in-app room switching.** Do not attempt to re-key sync, LiveKit, presence,
  or engine selection at runtime. Navigation is a page load. (spec §3.3)
- **No confirmation dialog** on switch. (spec §3.3)
- **`sanitizeId` is the one validator.** Reuse `server/src/canvas/ids.ts`; do
  not re-inline the regex. `kernel/presence.ts:3` already imports from
  `../canvas/`, so this layering is established.
- **Contract gate:** `scripts/ux-contract-presence.test.ts` fails any diff
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/` without a contract declaration. **This plan touches
  none of those** — but the PR body must still carry
  `ux-contract: none — side-panel chrome, not a canvas interaction surface.`
  (a bare `ux-contract: none` with no reason is rejected).
- **Checks:** `bun run typecheck` and `bun run test` must pass at the end of
  every task. `bun install` first if this checkout has no `node_modules`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `contracts/src/tools/kernel.ts` | modify | `kernelRooms` ToolDef; append to `kernelTools`. |
| `server/src/kernel/rooms.ts` | modify | `listRoomIds()` on `RoomHost` — disk ∪ memory, filtered, sorted. |
| `server/src/kernel/rooms.test.ts` | create | Unit test for `listRoomIds()` over a temp dir. |
| `server/src/features/rooms.ts` | create | `createRoomsRouter(ctx)` — presence join, JSON response. |
| `server/src/app.ts` | modify (~line 355) | Mount the router after `createParticipantsRouter`. |
| `server/src/rooms-api.test.ts` | create | Endpoint test over a temp `databaseDir`. |
| `client/src/chrome/frameLink.ts` | modify | `buildRoomLink`; `buildFrameLink` delegates to it. |
| `client/src/chrome/frameLink.test.ts` | modify | Cover `buildRoomLink`; no regression on `buildFrameLink`. |
| `client/src/chrome/rooms.ts` | create | Pure payload → render rows. No React, no DOM, no tldraw. |
| `client/src/chrome/rooms.test.ts` | create | Unit test for the above. |
| `client/src/chrome/RoomSwitcher.tsx` | create | Trigger button, popover, fetch/loading/error states. |
| `client/src/chrome/SidePanel.tsx` | modify (~line 468-471) | Replace the static room-id span with `<RoomSwitcher />`. |
| `docs/superpowers/specs/2026-09-10-room-switcher-design.md` | modify (line 3) | Flip Status SPEC → IMPLEMENTED once smoke passes. |

---

### Task 1: The `kernelRooms` contract

Declare the route once, in the contracts package, so the server route, the
`/api/tools` manifest, and the CLI verb all derive from one definition.

**Files:**
- Modify: `contracts/src/tools/kernel.ts`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: `kernelRooms: ToolDef` with
  `http: { method: 'GET', path: '/api/rooms' }`, `zodInput: z.object({})`,
  `zodOutput: z.object({ rooms: z.array(z.object({ id: z.string(), participants: z.number() })) })`.

- [x] **Step 1: Add the ToolDef**

In `contracts/src/tools/kernel.ts`, after `kernelParticipants`:

```ts
export const kernelRooms: ToolDef = {
	plugin: 'kernel',
	id: 'rooms',
	http: { method: 'GET', path: '/api/rooms' },
	help: 'List every room that exists, with live participant counts.',
	zodInput: z.object({}),
	zodOutput: z.object({
		rooms: z.array(z.object({ id: z.string(), participants: z.number() })),
	}),
}
```

- [x] **Step 2: Register it**

Extend the export list: `export const kernelTools: ToolDef[] = [kernelWhoami, kernelParticipants, kernelRooms]`.

- [x] **Step 3: Verify**

Run `bun run typecheck`, then `bun run test`. If any existing suite asserts the
tool manifest's contents or count (check `e2e/tests/contracts.spec.ts` and
anything under `cli/`), update it to include the new verb. Confirm nothing else
needs changing for `ensembleworks kernel rooms` to exist — the CLI derives its
verbs from `kernelTools`; if it does not, note that as an as-built delta rather
than building a CLI feature here.

---

### Task 2: `RoomHost.listRoomIds()`

The one place that knows rooms live at `<roomsDir>/<id>.sqlite`. Returns the
union of what is on disk and what is open in memory.

**Files:**
- Modify: `server/src/kernel/rooms.ts`
- Test: `server/src/kernel/rooms.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RoomHost.listRoomIds(): string[]` — validated ids, de-duplicated,
  sorted ascending.

- [x] **Step 1: Write the failing test**

Create `server/src/kernel/rooms.test.ts`. Run with `bun src/kernel/rooms.test.ts`.
Cover, using `mkdtemp` for the rooms dir (the `server/src/database-dir.test.ts`
pattern) and writing files directly with `writeFileSync` where a real room is
not needed:

1. Empty dir → `[]`.
2. Files `beta.sqlite`, `alpha.sqlite` on disk → `['alpha', 'beta']` (sorted).
3. Non-`.sqlite` entries (`README.md`, `alpha.sqlite-wal`) → ignored.
4. An id failing `sanitizeId` (e.g. a file named `bad room.sqlite`, or one
   whose stem exceeds 64 chars) → dropped.
5. A room opened via `getOrCreateRoom('live')` appears exactly once, not twice,
   when its file also exists on disk.

Close any rooms you open (`room.close()`) so the test exits cleanly.

- [x] **Step 2: Implement**

Add `listRoomIds` to the `RoomHost` interface and its implementation in
`createRoomHost`:

- `readdirSync(roomsDir)` guarded by `existsSync` (same shape as the
  `EW_WARM_ROOMS` block at `server/src/app.ts:159`), keep entries ending
  `.sqlite`, strip the extension.
- Union with `rooms.keys()` via a `Set`.
- Map through `sanitizeId` (import from `../canvas/ids.ts`), drop nulls.
- Return sorted ascending.

- [x] **Step 3: Verify**

`bun src/kernel/rooms.test.ts` passes; `bun run typecheck` clean.

---

### Task 3: `GET /api/rooms`

A thin router: the list from Task 2, joined against live presence.

**Files:**
- Create: `server/src/features/rooms.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/rooms-api.test.ts`

**Interfaces:**
- Consumes: `kernelRooms` (Task 1), `ctx.rooms.listRoomIds()` (Task 2).
- Produces: `createRoomsRouter(ctx: PluginServerContext): express.Router`.

- [x] **Step 1: Write the failing test**

Create `server/src/rooms-api.test.ts`, following `server/src/database-dir.test.ts`
for boot and `server/src/canvas-api.test.ts` for HTTP calling convention. Over a
temp `databaseDir`:

1. Fresh server, no rooms → `{ rooms: [] }`.
2. After `getOrCreateRoom('beta')` and `getOrCreateRoom('alpha')` → ids come
   back `['alpha', 'beta']`, each with `participants: 0` (no presence records).
3. A stray non-`.sqlite` file in the rooms dir does not appear.
4. Response shape parses against `kernelRooms.zodOutput` — this is the drift
   anchor; assert it explicitly.

- [x] **Step 2: Implement the router**

Create `server/src/features/rooms.ts`, mirroring
`server/src/features/participants.ts`'s structure:

```ts
export function createRoomsRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()
	router.get(kernelRooms.http.path, (_req, res) => {
		const rooms = ctx.rooms.listRoomIds().map((id) => {
			const room = ctx.rooms.rooms.get(id)
			const refs = room && !room.isClosed() ? getCursorRefs(room) : []
			return {
				id,
				participants: buildParticipants(refs, ctx.sessions.identitiesByUser.get(id)).length,
			}
		})
		res.json({ rooms })
	})
	return router
}
```

**Use `buildParticipants(...).length`, not `refs.length`** — `buildParticipants`
de-duplicates by raw user id, so a teammate with two tabs counts once
(spec §3.1).

- [x] **Step 3: Mount it**

In `server/src/app.ts`, add `app.use(createRoomsRouter(ctx))` immediately after
the `createParticipantsRouter(ctx)` line (~355), with a matching
`// kernel-reserved: /api/rooms` comment, and add the new router to the ordered
list in the block comment above the mounts (~line 300).

- [x] **Step 4: Verify**

`bun src/rooms-api.test.ts` passes; `bun run typecheck` and `bun run test` clean.

---

### Task 4: `buildRoomLink`

The navigation primitive, pure and shared with the existing frame deep-link
builder so the two URL shapes cannot drift.

**Files:**
- Modify: `client/src/chrome/frameLink.ts`
- Test: `client/src/chrome/frameLink.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildRoomLink(origin: string, room: string): string` → `${origin}/?room=<encoded>`.

- [x] **Step 1: Write the failing test**

Extend `client/src/chrome/frameLink.test.ts`:

1. `buildRoomLink('https://x.test', 'team')` → `'https://x.test/?room=team'`.
2. A room id needing encoding round-trips through `URLSearchParams`.
3. **Regression:** the existing `buildFrameLink` assertions still hold verbatim
   after the refactor — same param order, same output string.

- [x] **Step 2: Implement**

Add `buildRoomLink` using `URLSearchParams`, and rewrite `buildFrameLink` to
build on it (append `frame`) — or, if delegating changes the emitted param
order, leave `buildFrameLink` as-is and simply place `buildRoomLink` beside it.
**The existing output string must not change**; the no-regression assertion
decides which form you keep. Keep the module free of React/DOM/tldraw imports.

- [x] **Step 3: Verify**

`bun client/src/chrome/frameLink.test.ts` passes.

---

### Task 5: The pure row-shaping module

Everything the popover decides, decided outside React so it can be tested.

**Files:**
- Create: `client/src/chrome/rooms.ts`
- Test: `client/src/chrome/rooms.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RoomSummary { id: string; participants: number }`
  - `interface RoomRow { id: string; participants: number; isCurrent: boolean; countLabel: string | null }`
  - `function toRoomRows(rooms: readonly RoomSummary[], currentRoomId: string): RoomRow[]`
  - `function parseRoomsPayload(raw: unknown): RoomSummary[]` — defensive
    narrowing of the fetch result; drop entries that are not
    `{ id: string, participants: number }`.

- [x] **Step 1: Write the failing test**

Create `client/src/chrome/rooms.test.ts`:

1. `toRoomRows` preserves the server's order (it is already sorted; the client
   must not re-sort — spec §3.1).
2. The row matching `currentRoomId` has `isCurrent: true`; all others `false`.
3. `countLabel` is `null` when `participants === 0`, and the number as a string
   otherwise (spec §3.2 — a zero count renders nothing at all).
4. `currentRoomId` absent from the list yields no `isCurrent` row and does not
   throw (a room whose sqlite has not been written yet).
5. `parseRoomsPayload` on `null`, `{}`, `{ rooms: 'x' }`, and an array with one
   good and one malformed entry → `[]`, `[]`, `[]`, and just the good entry.

- [x] **Step 2: Implement**

Write the module. No React import, no DOM, no tldraw — it runs under bare `bun`.

- [x] **Step 3: Verify**

`bun client/src/chrome/rooms.test.ts` passes.

---

### Task 6: `RoomSwitcher` and the SidePanel wiring

The only React in this plan. It owns open/loading/error state and renders; every
decision comes from Task 5.

**Files:**
- Create: `client/src/chrome/RoomSwitcher.tsx`
- Modify: `client/src/chrome/SidePanel.tsx`

**Interfaces:**
- Consumes: `buildRoomLink` (Task 4), `toRoomRows` / `parseRoomsPayload`
  (Task 5), `GET /api/rooms` (Task 3).
- Produces: `<RoomSwitcher />` — no props; reads `getRoomId()` itself, matching
  how the span it replaces worked.

- [x] **Step 1: Build the component**

`client/src/chrome/RoomSwitcher.tsx`:

- **Trigger** — a `<button>` carrying the *exact* type treatment of the span it
  replaces (`fontFamily: wm.mono, fontSize: 11, fontWeight: 700, textTransform:
  'uppercase', letterSpacing: 0.9, color: wm.ink`) plus a `▾`. Reset the button
  chrome (`background: 'none', border: 'none', padding: 0, cursor: 'pointer'`)
  so the header's height and alignment are unchanged. Give it
  `data-testid="ew-room-switcher"`.
- **Fetch on open, not on mount** (spec §3.2). On each open, `fetch('/api/rooms')`,
  run the body through `parseRoomsPayload`. Abort in-flight requests with an
  `AbortController` on close/unmount.
- **Popover** — `position: 'absolute'`, anchored below the trigger (the trigger's
  wrapper needs `position: 'relative'`), reusing `popoverBoxStyle` from
  `./popover`. Do **not** use `popoverPositionStyle` — that is command-bar
  dock-edge logic and does not apply.
- **Rows** — `toRoomRows(...)` output. Room id left, `countLabel` right in
  `wm.inkMuted` (render nothing when `null`). The `isCurrent` row is marked and
  is **not** a navigation target: clicking it only closes the popover.
- **Navigate** — `window.location.assign(buildRoomLink(window.location.origin, id))`.
  No confirmation.
- **States** — loading (`loading…`, `wm.inkSubtle`), empty (`no rooms`,
  `wm.inkSubtle`), error (one line in `wm.crit` with a retry that re-runs the
  fetch).
- **Dismissal** — close on Escape and on click outside; do not trap focus.

- [x] **Step 2: Wire it into the panel**

In `client/src/chrome/SidePanel.tsx`, replace the static room-id `<span>`
(~lines 468-471, the one rendering `{getRoomId()}`) with `<RoomSwitcher />`,
leaving the surrounding flex row and the participant-count span untouched. Do
**not** render it in the collapsed 32px rail branch (~line 368) — the rail keeps
its current content (spec §3.2).

- [x] **Step 3: Verify**

`bun run typecheck` and `bun run test` clean. There is no unit test for this
component by construction (Global Constraints); Task 7 is its verification.

---

### Task 7: Smoke and close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-room-switcher-design.md` (line 3)

- [x] **Step 1: Run it**

`bin/dev up` from the repo root, then drive the running app in a browser:

1. Open `/?room=team`. The header shows `TEAM ▾`; header height and alignment
   are visually unchanged from before.
2. Click it. The popover lists rooms alphabetically. Rooms with people show a
   count; empty rooms show none.
3. `curl` `/api/rooms` directly and confirm it agrees with what the popover
   rendered.
4. Click a different room. The URL becomes `/?room=<id>`, the page reloads, the
   header shows the new room, and audio/sync reconnect.
5. Click the *current* room. The popover closes; the page does not reload.
6. Collapse the panel to the rail. No trigger is rendered; nothing is broken.
7. Stop the server, reopen the popover, and confirm the error row and its retry.

Capture a screenshot of the open popover.

- [x] **Step 2: Close out**

- Flip the spec's Status line from SPEC to `IMPLEMENTED (2026-09-10)`.
- Confirm the PR body carries
  `ux-contract: none — side-panel chrome, not a canvas interaction surface.`
- Record any as-built delta (e.g. the CLI-verb question from Task 1 Step 3) in
  an Execution notes section at the foot of this plan.

---

## Execution notes (2026-09-10)

**CLI verb — no delta.** Task 1 Step 3's open question is answered: `ensembleworks
kernel rooms` exists purely from the `kernelTools` registration. `cli/src/render/
manifest.ts` builds its snapshot from `buildManifest(allTools, CLI_BUILD)` and
`cli/src/dispatch.ts` renders verbs generically, so no CLI change was needed.
`kernelRooms.http.path` also satisfies the registry's no-`/:param`
CLI-renderability rule.

**The plan under-counted the tool-count assertions.** Step 3 named
`e2e/tests/contracts.spec.ts` and "anything under `cli/`". In fact that spec
asserts nothing about the count, and four unit suites hardcode it:
`contracts/src/tools/tools.test.ts`, `cli/src/render/manifest.test.ts`,
`cli/src/cli-api.test.ts`, `server/src/tools-api.test.ts` (27 → 28). Unavoidable
collateral, not scope creep.

**`bun run test` cannot be green at the end of Tasks 1 and 2**, contrary to the
Global Constraints. `server/src/tools-api.test.ts` asserts bidirectionally that
every declared verb is mounted, so declaring `kernelRooms` in Task 1 without
mounting the route until Task 3 fails by construction. Correctly reported rather
than papered over (no stub router, no exemption-list edit). If green-per-task is
ever a hard requirement, Tasks 1 and 3 must be one commit.

**Two sandbox artefacts, not code failures.** `server/src/connector-loopback.test.ts`
and `relay-loopback.test.ts` fail under the tool sandbox with `error connecting
to /tmp/tmux-1000/default (Operation not permitted)`. Both pass outside it. Note
also that `scripts/run-tests.ts` exits on the first failing file, so one broken
suite masks everything alphabetically after it.

**Three defects the per-task reviews missed, caught by the whole-branch review.**
All in `RoomSwitcher.tsx`, all fixed in `9ef1b69`:
1. The popover had no `zIndex` and `popoverBoxStyle` supplies none, so
   participant tiles — positioned elements later in tree order in the same
   stacking context — painted over it whenever a room had occupants.
2. Its `minWidth: 180` matched the panel's own `MIN_WIDTH`, and the panel root is
   `overflowY: auto` (so overflow-x computes to `auto` and clips).
3. `toggle` called `load()` from inside the `setOpen` updater; updaters must be
   pure and StrictMode double-invokes them, firing two `/api/rooms` requests per
   open.

Fixes (1) and (2) by adopting the viewport-anchored `position: fixed` pattern
already documented at `SidePanel.tsx:137-141` for the device picker. **The plan
caused (1) and (2)** by instructing the implementer to use `popoverBoxStyle`
without pointing at that precedent — a plan-authoring lesson, not an implementer
error.

**As-built delta: `e2e/tests/room-switcher.spec.ts` was added**, which the File
Structure table does not list. Justified: `RoomSwitcher.tsx` has no unit test by
construction, so Task 7's manual smoke was its only verification — making that
smoke executable closes the gap permanently. It immediately earned its place by
catching a **fourth** defect the whole-branch review had not: the first fix
left-anchored the popover to the trigger, which overflowed the viewport's right
edge (1310 > 1280) at a 180px panel. Now right-anchored, like the device picker.
Five specs cover the list, the narrow-panel geometry (both clipping and
z-order, via `elementFromPoint`), navigate/inert-current-row, the
single-request-per-open guarantee, and the error+retry path.

**Spec §3.1's "known delta" confirmed in the wild.** The screenshot at a 180px
panel shows the header reading `2` (client-side `getCollaborators().length + 1`)
while the popover reads `1` (server-side deduped presence). Both honest, exactly
as documented; no action.

**Not verified:** the plan's smoke steps 6 (collapsed rail) and 7 (server
stopped) were covered by reasoning and a route-level 500 respectively, not by a
real rail interaction or a real server kill.
