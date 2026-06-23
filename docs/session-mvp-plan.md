# Augmented Session MVP — implementation plan

The tooling needed to run an augmented team session for real (see
`/sessions/` on the website and `../README.md` for the session design):

1. **Session layout seeding** — a "Seed session layout" menu action that lays
   out crew zones, benches, painted rings and shared frames at distances
   derived from the spatial-audio model.
2. **Canvas API + CLI** — HTTP endpoints on the sync server that let agents
   (via Claude Code hooks or in-prompt instructions) flip a status light on
   their terminal shape and post advice stickies; a `bin/canvas` CLI wrapper.

Out of scope for the MVP: timer shape, send-stickies-to-terminal button,
agent presence bubbles.

Process: red/green/refactor. A test-writer writes failing tests against the
contracts below; an implementer makes them pass without modifying the tests;
a refactor pass cleans up with tests staying green.

Existing test conventions: plain `tsx` scripts using `node:assert/strict`
(see `client/src/av/spatial.test.ts`, `server/src/smoke-client.ts`), run
directly with `npx tsx <file>`. Shell code is tested with shellspec from the
repo root (`spec/*_spec.sh`).

---

## Cycle 1 — session layout (client)

### Contract: `client/src/session/layout.ts`

Pure module. No tldraw imports except types; no randomness; no Date. Distances
derive from `DEFAULT_SPATIAL_SETTINGS` in `client/src/av/spatial.ts`
(`huddleRadius: 600`, `falloffEnd: 3500`).

```ts
export interface Vec { x: number; y: number }

export interface CrewZone {
	index: number               // 0-based
	name: string                // 'crew-a', 'crew-b', …
	center: Vec
	ringRadius: number          // painted ring radius == huddleRadius
	draftingTable: Vec          // top-left of the drafting frame
	launchPad: Vec              // top-left of the launch-pad frame
	terminal: Vec               // top-left of the terminal shape
	benchPreview: Vec           // top-left of the preview iframe
	benchAdvice: Vec            // top-left of the advice frame
	parkingSpot: Vec            // centre of the ⊗ client parking marker
}

export interface SessionLayout {
	crews: CrewZone[]
	briefLessons: Vec           // top-left of the shared Brief Lessons frame
	ranking: Vec                // top-left of the 25/10 ranking frame
	pairHuddles: Vec[]          // centres; one per crew, used in phases 1–2
}

export function computeSessionLayout(opts: {
	crews: number               // 2..4 inclusive, else throws RangeError
	center: Vec                 // layout is positioned around this point
}): SessionLayout
```

### Invariants (the tests)

`client/src/session/layout.test.ts`, runnable via `npx tsx`:

1. **Crew count**: works for 2, 3, 4 crews (returns that many zones);
   throws `RangeError` for 1 and 5.
2. **Murmur band**: pairwise distance between crew zone centres is
   `> 2 * huddleRadius` (rings never overlap → no accidental full-volume
   bleed) and `< falloffEnd` (you always hear the murmur).
3. **Out of earshot**: every pair-huddle centre is `> falloffEnd` away from
   every crew zone centre, from the Brief Lessons frame, and from every other
   pair huddle.
4. **Painted ring**: `ringRadius === huddleRadius` for every zone.
5. **Parking spot**: distance from zone centre is strictly between
   `huddleRadius` and `1.5 * huddleRadius` (just outside the ring).
6. **Sightline rule**: distance between `draftingTable` and `terminal` is
   `>= 800` page units (the agent's output stream is off-screen from the
   drafting table at working zoom), while both stay within
   `huddleRadius + 200` of the zone centre (the crew still shares one audio
   huddle).
7. **Shared frames central**: `briefLessons` and `ranking` are each within
   `2 * huddleRadius` of the centroid of crew zone centres.
8. **Determinism**: two calls with the same options return deeply equal
   results.
9. **Centering**: the centroid of crew zone centres is within `huddleRadius`
   of `opts.center`.

### Implementation notes

- `client/src/session/seedSessionCanvas.ts` consumes the layout and creates
  shapes inside one `editor.run()`: title text; per crew — drafting frame
  with Min Specs template stickies (green must / red must-not), launch-pad
  frame, terminal shape (`sessionId: zone.name`), preview iframe
  (`/dev/3000/`), advice frame, dashed ellipse geo shape for the painted
  ring, parking-spot text `⊗`; shared Brief Lessons + ranking frames; one
  frame per pair huddle; a reviewer-agent prompt-template text shape per
  bench. Mirrors the style of `demo.ts`. Ends with `zoomToFit`.
- `ui.tsx`: add "Seed session layout" menu item next to "Seed demo layout".
- The seeder stays a thin mapping from layout to `createShape` calls — all
  geometry decisions live (and are tested) in `layout.ts`.

---

## Cycle 2 — canvas API + CLI + status light

### Contract: server refactor

Extract the express app + websocket wiring from `server/src/sync-server.ts`
into `server/src/app.ts`:

```ts
export interface SyncApp {
	server: http.Server          // not yet listening
	getOrCreateRoom(roomId: string): TLSocketRoom
}
export function createSyncApp(opts: { dataDir: string; clientDist?: string }): SyncApp
```

`sync-server.ts` becomes a thin entry point (env parsing + `listen`).
Behaviour of all existing routes is unchanged.

### Contract: new endpoints

Both accept JSON (`express.json()`), both validate `room` with the existing
`sanitizeId`, and both operate via `getOrCreateRoom(room).updateStore(...)`
so they work whether or not the room is currently open.

`POST /api/terminal-status`
— body `{ room?: string = 'team', sessionId: string, status: string }`
— `status` must be one of `working | needs-you | done | idle` → else 400
— missing/invalid `sessionId` or `room` → 400
— sets `props.status = status` on every shape with `type === 'terminal'`
  and `props.sessionId === sessionId`
— responds `{ ok: true, updated: <count> }` (200 even when count is 0).

`POST /api/sticky`
— body `{ room?: string = 'team', text: string, frame?: string, color?: string }`
— `text` required, non-empty after trim, ≤ 2000 chars → else 400
— `color` one of tldraw note colours (default `'yellow'`); invalid → 400
— if `frame` given: parent the note to the first `frame` shape whose
  `props.name` contains `frame` case-insensitively; position it on a simple
  grid inside the frame based on how many notes the frame already contains;
  if no frame matches → 404 `{ error: 'frame not found' }`
— if no `frame`: place at the page origin area, offset by existing note
  count so stickies don't stack exactly
— responds `{ ok: true, id: <shape id> }`.

### Contract: terminal `status` prop

- `status?: string` added as an **optional** prop on the terminal shape in
  BOTH `client/src/terminal/TerminalShapeUtil.tsx` and
  `server/src/schema.ts` (they must stay in sync; optional avoids
  migrations for existing rooms).
- Header UI in the terminal shape renders a status chip when the prop is
  set: `working` green · `needs-you` amber, pulsing · `done` blue ·
  `idle` grey. Unset prop → no chip (current behaviour).

### Contract: `bin/canvas` CLI

Bash, in `ensembleworks/bin/canvas`, executable. `CANVAS_URL` env
overrides the base URL (default `http://localhost:8788`); `CANVAS_ROOM`
overrides the default room (`team`).

```
canvas status <session-id> <working|needs-you|done|idle>
canvas sticky <text> [--frame <name>] [--color <color>]
```

Exits non-zero with a usage message on missing/invalid args (validated
locally before any network call). Curls the matching endpoint with JSON.

### Tests

`server/src/canvas-api.test.ts` (tsx + node:assert, in-process — no child
processes):

1. Boot `createSyncApp` with a `fs.mkdtemp` data dir, `server.listen(0)`.
2. Seed a room: `getOrCreateRoom('test')`, then `updateStore` to put a
   terminal shape record (`sessionId: 'abc123'`) and a frame record
   (`props.name: 'Advice — crew-a'`).
3. `POST /api/terminal-status` `{room:'test', sessionId:'abc123', status:'needs-you'}`
   → 200 `{ok:true, updated:1}`; `getCurrentSnapshot()` shows the prop.
4. Unknown sessionId → 200 `{updated: 0}`. Bad status → 400. Missing
   sessionId → 400.
5. `POST /api/sticky` with `frame: 'advice'` → 200; snapshot contains a note
   whose `parentId` is the frame and whose rich text contains the text.
6. Sticky with unknown frame → 404. Empty text → 400.
7. Health check still works (`GET /api/health`) — guards the refactor.

`spec/canvas_cli_spec.sh` (shellspec, repo root, alongside
`announce_changes_spec.sh`): stub `curl` via PATH; assert `canvas status`
hits `/api/terminal-status` with the right JSON; assert bad status word and
missing args exit non-zero without calling curl.

---

## Definition of done

- `npm run typecheck` and `npm run build` pass in `ensembleworks`.
- `npx tsx client/src/session/layout.test.ts`,
  `npx tsx server/src/canvas-api.test.ts`,
  `npx tsx client/src/av/spatial.test.ts` all pass.
- `shellspec spec/canvas_cli_spec.sh` passes from the repo root.
- README updated: canvas CLI usage + new smoke-test commands.
