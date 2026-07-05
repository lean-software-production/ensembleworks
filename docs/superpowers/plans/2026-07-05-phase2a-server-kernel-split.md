# Phase 2a — Server Kernel Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `server/src/app.ts` (~1,259 lines) into a small kernel (rooms, sessions, presence, media, WS upgrade, static) plus one router module per feature, each receiving a `PluginServerContext` — with zero route or wire behaviour change.

**Architecture:** Pure move-refactor toward `docs/unified-architecture-design.md` §1.3. Kernel services own the mutable state (`rooms` map + `getOrCreateRoom`, the session/identity/latency registries, LiveKit config); feature routers get them via one `PluginServerContext` and mount **at today's paths in today's registration order** (the Phase-3 cutover renames paths later, not now). `getCursorRefs`'s use of the private `room.getPresenceRecords?.()` API is quarantined in the presence service. All existing tests keep passing unmodified except where a task says otherwise.

**Tech Stack:** Express 5, `@tldraw/sync-core` TLSocketRoom, existing self-running tsx tests.

**Ground truth:** all line numbers below reference commit `b65e2c7` (current `main`). If a file drifted, re-locate with the greps given per task — the *code being moved* is authoritative, never retype it from this plan.

**Behaviour-preservation rules (apply to every task):**
- Move code verbatim; the only permitted edits are: closure/module references renamed to `ctx.*`/imported symbols, `export` keywords, and import lines.
- Route registration order after the split must be byte-for-byte the order listed in Task 2's `mountFeatureRouters` — which is today's order.
- After every task: `npm run typecheck` plus the task's named test files must pass before committing.
- `createSyncApp`'s signature and return value (`{ server, getOrCreateRoom }`) never change; `buildParticipants` and `CursorRef` stay importable from `./app.ts` (re-exports are fine) — tests depend on both.

---

## File structure (end state)

```
server/src/kernel/
  rooms.ts       — RoomHost: rooms map + getOrCreateRoom + roomsDir (from app.ts:316,329,341–357)
  sessions.ts    — SessionRegistry: sessionsByUser, identitiesByUser, latencyByUser + narrow accessors
  presence.ts    — CursorRef, getCursorRefs (quarantines getPresenceRecords), rawUserId,
                   Participant, buildParticipants, pickCursor
  media.ts       — MediaService: LiveKit env config + RoomServiceClient, created lazily
                   inside createSyncApp (kills the env-at-import-time fragility)
  context.ts     — PluginServerContext type + assembly
server/src/canvas/
  ids.ts         — sanitizeId, sanitizeAssetId
  geometry.ts    — pagePoint, pageIdOf, dist, sortPointOf, byProximity, richTextToPlainText
  constants.ts   — NOTE_COLORS, GEO_TYPES, STICKY_GRID_COLS, STICKY_GRID_STEP, PULSE_STALE_MS
server/src/features/
  av.ts          — GET /api/livekit-token, POST /api/kick, GET /api/participants, POST /api/pulse
  terminal-status.ts, sticky.ts, transcript.ts, shape.ts, frames.ts (frames+frame),
  roadmap.ts, uploads.ts
server/src/app.ts — thin assembler: creates stores + kernel services + context, mounts
                   express.json, health, gateway, feature routers (original order), static last,
                   attaches the WS upgrade handler. Re-exports buildParticipants/CursorRef.
```

`GET /api/health`, `GET /api/gateway/list`, static/SPA and the WS upgrade handler stay in `app.ts` — they ARE the kernel's own surface, not features.

---

### Task 1: Kernel services — rooms, sessions, presence + canvas helper modules

**Files:**
- Create: `server/src/kernel/rooms.ts`, `server/src/kernel/sessions.ts`, `server/src/kernel/presence.ts`
- Create: `server/src/canvas/ids.ts`, `server/src/canvas/geometry.ts`, `server/src/canvas/constants.ts`
- Modify: `server/src/app.ts`
- Test: existing `server/src/participants-api.test.ts`, `server/src/canvas-api.test.ts`

- [ ] **Step 1: Create `server/src/kernel/rooms.ts`**

```ts
/**
 * RoomHost — owns the TLSocketRoom registry and SQLite-backed room loading.
 * The one place that constructs rooms; every feature router reaches rooms
 * through this. (Moved from app.ts's closure: rooms map + getOrCreateRoom.)
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { schema } from '../schema.ts'

export interface RoomHost {
	rooms: Map<string, TLSocketRoom>
	getOrCreateRoom(roomId: string): TLSocketRoom
}

export function createRoomHost(dataDir: string): RoomHost {
	const roomsDir = path.join(dataDir, 'rooms')
	// ... move app.ts:316 (roomsDir mkdir logic, if any lives at 316–328), 329 (rooms map)
	// and 341–357 (getOrCreateRoom body) here VERBATIM, adjusting only closure refs.
	const rooms = new Map<string, TLSocketRoom>()
	function getOrCreateRoom(roomId: string): TLSocketRoom {
		/* body moved verbatim from app.ts:341–357 */
	}
	return { rooms, getOrCreateRoom }
}
```

Locate the exact code with `grep -n "roomsDir\|new Map<string, TLSocketRoom>\|function getOrCreateRoom" server/src/app.ts` and move it verbatim (including the `isClosed()` re-open logic and SQLite wiring). If `mkdirSync` for roomsDir happens elsewhere near line 316–328, move that too.

- [ ] **Step 2: Create `server/src/kernel/sessions.ts`**

```ts
/**
 * SessionRegistry — live sync-WS sessions, Cf Access identities and pulse
 * latency per room. Written by the kernel's WS upgrade handler and the pulse
 * route; read by kick and participants. (Moved from app.ts:330–339.)
 */
import type { AccessIdentity } from '../access-identity.ts'

export interface SessionRegistry {
	sessionsByUser: Map<string, Map<string, Set<string>>>
	identitiesByUser: Map<string, Map<string, AccessIdentity>>
	latencyByUser: Map<string, Map<string, { rtt: number; t: number }>>
}

export function createSessionRegistry(): SessionRegistry {
	return { sessionsByUser: new Map(), identitiesByUser: new Map(), latencyByUser: new Map() }
}
```

(Deliberately dumb: the maps move as-is, accessors can grow narrower in Phase 6. Copy the three maps' exact generic types from app.ts:330–339 — the sketch above must match the source; the source wins.)

- [ ] **Step 3: Create `server/src/kernel/presence.ts`** — move from app.ts VERBATIM: `CursorRef` (164–177), `rawUserId` (182–184), `getCursorRefs` (188–213, keep the try/catch and the `room.getPresenceRecords?.()` call — this file is that API's quarantine), `Participant` (219–225), `buildParticipants` (231–251), `pickCursor` (255–259). All exported. Header comment:

```ts
/**
 * Presence service — reads live cursor/selection state from a TLSocketRoom.
 * QUARANTINE: room.getPresenceRecords?.() is an untyped private sync-core
 * API; this module is the only place allowed to touch it (unified design
 * §1.3 / migration step "getPresenceRecords quarantined").
 */
```

- [ ] **Step 4: Create the three `server/src/canvas/` modules** — move VERBATIM: `ids.ts` ← `sanitizeId` (126–128) + `sanitizeAssetId` (134–136); `geometry.ts` ← `richTextToPlainText` (142–151), `pagePoint` (272–283), `pageIdOf` (262–269), `dist` (285–287), `sortPointOf` (293–295), `byProximity` (302–313); `constants.ts` ← `PULSE_STALE_MS` (79), `NOTE_COLORS` (82–96), `STICKY_GRID_COLS`/`STICKY_GRID_STEP` (99–100), `GEO_TYPES` (103–124). All exported, comments carried along.

- [ ] **Step 5: Rewire `app.ts`** — delete the moved code; import from the new modules; replace closure uses: `rooms`→`roomHost.rooms`, `getOrCreateRoom`→`roomHost.getOrCreateRoom` (add `const roomHost = createRoomHost(opts.dataDir)` where the old closure state was), `sessionsByUser` etc → `const registry = createSessionRegistry()` + `registry.sessionsByUser` etc. Keep the return value `{ server, getOrCreateRoom: roomHost.getOrCreateRoom }`. Add re-exports so tests keep working:

```ts
export { buildParticipants, type CursorRef, type Participant } from './kernel/presence.ts'
```

(Note: server tsconfig has `allowImportingTsExtensions`; keep the house `./x.ts` import style used by existing server files.)

- [ ] **Step 6: Verify**

Run: `npm run typecheck && cd server && npx tsx --test src/participants-api.test.ts src/canvas-api.test.ts src/scribe-api.test.ts src/vm-stats.test.ts`
Expected: PASS (participants-api imports buildParticipants/CursorRef through app.ts re-export).

- [ ] **Step 7: Commit**

```bash
git add server/src && git commit -m "refactor(server): extract kernel rooms/sessions/presence + canvas helper modules"
```

### Task 2: PluginServerContext + router mounting skeleton

**Files:**
- Create: `server/src/kernel/context.ts`
- Modify: `server/src/app.ts`

- [ ] **Step 1: Create `server/src/kernel/context.ts`**

```ts
/**
 * PluginServerContext — the capability surface feature routers receive
 * instead of reaching into app.ts closures (unified design §1.3, Phase-2
 * scope: only capabilities that exist today; media joins in Task 4).
 */
import type express from 'express'
import type { RoomHost } from './rooms.ts'
import type { SessionRegistry } from './sessions.ts'
import type { MediaService } from './media.ts'   // added in Task 4; declare then
import type { createRoadmapStore } from '../roadmap-store.ts'
import type { createTranscriptStore } from '../transcript-store.ts'

export interface PluginServerContext {
	rooms: RoomHost
	sessions: SessionRegistry
	media: MediaService
	storage: {
		transcripts: ReturnType<typeof createTranscriptStore>
		roadmaps: ReturnType<typeof createRoadmapStore>
		uploadsDir: string
	}
}

export type FeatureRouter = (ctx: PluginServerContext) => express.Router
```

(In THIS task, since `media.ts` doesn't exist yet, declare the interface without the `media` field and add it in Task 4 — do not create a stub MediaService now.)

- [ ] **Step 2: In `app.ts`, assemble the context** after the stores/services are created:

```ts
const ctx: PluginServerContext = {
	rooms: roomHost,
	sessions: registry,
	storage: { transcripts, roadmaps, uploadsDir },
}
```

and add the mounting point where routes are registered today (no routers exist yet — this is the seam Tasks 3–10 fill):

```ts
// Feature routers mount here IN THIS ORDER (today's registration order —
// Express matches top-down and the static catch-all below must stay last):
// av (livekit-token, kick, participants, pulse) → terminal-status → sticky
// → transcript → shape → frames → roadmap → uploads
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck && cd server && npx tsx --test src/canvas-api.test.ts`
Expected: PASS (no behaviour change — context is created but unused).

```bash
git add server/src && git commit -m "refactor(server): PluginServerContext seam for feature routers"
```

### Task 3: Extract the simplest routers — uploads, terminal-status

**Files:**
- Create: `server/src/features/uploads.ts`, `server/src/features/terminal-status.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/uploads-api.test.ts`, `server/src/canvas-api.test.ts`

- [ ] **Step 1: Create `server/src/features/uploads.ts`**

```ts
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { sanitizeAssetId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

export function createUploadsRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()
	// PUT /uploads/:id — move app.ts:1171–1176 verbatim, including its OWN
	// express.raw({ type: '*/*', limit: '100mb' }) middleware (the global
	// /api json parser never applied to /uploads; keep it that way).
	// GET /uploads/:id — move app.ts:1178–1186 verbatim.
	// Replace `uploadsDir` with ctx.storage.uploadsDir.
	return router
}
```

Register with `router.put('/uploads/:id', …)` / `router.get('/uploads/:id', …)` and mount in app.ts as `app.use(createUploadsRouter(ctx))` at the exact position the two routes occupied (between roadmap POST and the static block).

- [ ] **Step 2: Create `server/src/features/terminal-status.ts`** — same pattern: `createTerminalStatusRouter(ctx)`, move app.ts:487–513 verbatim (`router.post('/api/terminal-status', …)`), replacing `getOrCreateRoom` → `ctx.rooms.getOrCreateRoom`; imports: `sanitizeId` from `../canvas/ids.ts`, `isTerminalStatus, TERMINAL_STATUSES` from `@ensembleworks/contracts`. Mount at the old position (directly after the pulse route / before sticky).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && cd server && npx tsx --test src/uploads-api.test.ts src/canvas-api.test.ts`
Expected: PASS. Also confirm ordering: `grep -n "app.use\|app.get\|app.post\|app.put" server/src/app.ts` shows uploads mounted before the static block, terminal-status between pulse and sticky.

- [ ] **Step 4: Commit**

```bash
git add server/src && git commit -m "refactor(server): uploads + terminal-status feature routers"
```

### Task 4: Media service + av router (livekit-token, kick, participants, pulse)

**Files:**
- Create: `server/src/kernel/media.ts`, `server/src/features/av.ts`
- Modify: `server/src/kernel/context.ts` (add `media`), `server/src/app.ts`
- Test: `server/src/scribe-api.test.ts` (livekit-token), `server/src/canvas-api.test.ts` (kick), `server/src/participants-api.test.ts`, `server/src/vm-stats.test.ts` (pulse)

- [ ] **Step 1: Create `server/src/kernel/media.ts`** — the LiveKit module-level consts (app.ts:59–74) become a service whose config is read **when constructed, not at import time**:

```ts
/**
 * MediaService — LiveKit credentials/config + RoomServiceClient. Config is
 * captured at construction (inside createSyncApp), NOT at module import:
 * this removes the env-before-import ordering that scribe-api.test.ts
 * previously had to work around with a dynamic import.
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { resolveRoomServiceUrl } from '../livekit-url.ts'

export interface MediaService {
	apiKey: string | undefined
	apiSecret: string | undefined
	url: string | undefined
	roomService: RoomServiceClient | null
	// AccessToken minting stays in the av route (it's request-shaped);
	// the service owns config + the RoomServiceClient singleton.
}

export function createMediaService(env: NodeJS.ProcessEnv = process.env): MediaService {
	/* move the const-building logic from app.ts:59–74 verbatim into here,
	   replacing process.env reads with env.* — including resolveRoomServiceUrl
	   and the RoomServiceClient construction guard. */
}
```

- [ ] **Step 2: Create `server/src/features/av.ts`** — `createAvRouter(ctx)`; move verbatim: `GET /api/livekit-token` (376–407, `LIVEKIT_*` → `ctx.media.*`), `POST /api/kick` (409–435, `rooms`→`ctx.rooms.rooms`, `sessionsByUser`→`ctx.sessions.sessionsByUser`, `liveKitRoomService`→`ctx.media.roomService`), `GET /api/participants` (441–452, `identitiesByUser`→`ctx.sessions.identitiesByUser`, helpers from `../kernel/presence.ts`), `POST /api/pulse` (459–482, `latencyByUser`→`ctx.sessions.latencyByUser`, `PULSE_STALE_MS` from `../canvas/constants.ts`, `readVmStats` from `../vm-stats.ts`). Mount in the original slot (after the gateway list route, before terminal-status).

- [ ] **Step 3: Wire in app.ts + context** — `const media = createMediaService()` inside `createSyncApp`; add `media` to the ctx object and the `PluginServerContext` interface; delete the moved module-level consts (lines 59–74) from app.ts.

- [ ] **Step 4: Simplify `scribe-api.test.ts` env handling — DELIBERATE test change.** The test sets fake `LIVEKIT_*` env then dynamically imports app.ts (that ordering existed only because config was read at import time). With construction-time capture the dynamic import is no longer load-bearing, but it still works — so make **no change** to the test in this task; instead verify it passes unmodified, then ALSO verify construction-time capture with this one-liner check: `cd server && LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s LIVEKIT_URL=wss://x npx tsx -e "import('./src/app.ts').then(async m => { const a = m.createSyncApp({dataDir: '/tmp/mediacheck'}); await new Promise(r=>a.server.listen(0,r)); const p = a.server.address().port; const r = await fetch(\`http://localhost:\${p}/api/livekit-token?room=t&user=u\`); console.log('status', r.status); a.server.close(); process.exit(r.status===200?0:1) })"` — expected `status 200`, exit 0.

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && cd server && npx tsx --test src/scribe-api.test.ts src/participants-api.test.ts src/vm-stats.test.ts src/canvas-api.test.ts`
Expected: all PASS, tests unmodified.

```bash
git add server/src && git commit -m "refactor(server): media service + av feature router"
```

### Task 5: Transcript router

**Files:**
- Create: `server/src/features/transcript.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/scribe-api.test.ts`

- [ ] **Step 1:** `createTranscriptRouter(ctx)` — move verbatim `POST /api/transcript` (604–637: `getOrCreateRoom`→`ctx.rooms.getOrCreateRoom`, `transcripts`→`ctx.storage.transcripts`, `getCursorRefs`/`rawUserId` from `../kernel/presence.ts`) and `GET /api/transcript` (642–655). Mount in the original slot (after sticky, before shape).
- [ ] **Step 2:** Run: `npm run typecheck && cd server && npx tsx --test src/scribe-api.test.ts` — PASS.
- [ ] **Step 3:** `git add server/src && git commit -m "refactor(server): transcript feature router"`

### Task 6: Sticky router

**Files:**
- Create: `server/src/features/sticky.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/canvas-api.test.ts`

- [ ] **Step 1:** `createStickyRouter(ctx)` — move `POST /api/sticky` (515–596) verbatim. Imports: `sanitizeId` (canvas/ids), `NOTE_COLORS, STICKY_GRID_COLS, STICKY_GRID_STEP` (canvas/constants), `sortByIndex, getIndexAbove` (@tldraw/utils), `createShapeId, toRichText` (@tldraw/tlschema). The inline frame-fuzzy-match block (538–543) moves along with it UNCHANGED (dedupe is Task 10, not here). Mount between terminal-status and transcript (original order).
- [ ] **Step 2:** Run: `npm run typecheck && cd server && npx tsx --test src/canvas-api.test.ts` — PASS (covers sticky creation + frame parenting).
- [ ] **Step 3:** `git add server/src && git commit -m "refactor(server): sticky feature router"`

### Task 7: Shape router

**Files:**
- Create: `server/src/features/shape.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/canvas-api.test.ts`, `server/src/scribe-api.test.ts`

- [ ] **Step 1:** `createShapeRouter(ctx)` — move `POST /api/shape` (666–937) verbatim: the whole block including the arrow/geo/text/note record builders (793–926) stays one file this phase (it is the feature; splitting builders out is not this plan). Imports: `sanitizeId`, `NOTE_COLORS, GEO_TYPES` (canvas/constants), `pagePoint` (canvas/geometry), tldraw utils as used. Mount between transcript and frames.
- [ ] **Step 2:** Run: `npm run typecheck && cd server && npx tsx --test src/canvas-api.test.ts src/scribe-api.test.ts` — PASS.
- [ ] **Step 3:** `git add server/src && git commit -m "refactor(server): shape feature router"`

### Task 8: Frames router (frames + frame)

**Files:**
- Create: `server/src/features/frames.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/canvas-api.test.ts`

- [ ] **Step 1:** `createFramesRouter(ctx)` — move verbatim `GET /api/frames` (946–992) and `GET /api/frame` (997–1077). Imports: `getCursorRefs, pickCursor` (kernel/presence), `pagePoint, pageIdOf, byProximity, sortPointOf, richTextToPlainText` (canvas/geometry), `sanitizeId` (canvas/ids). Mount between shape and roadmap.
- [ ] **Step 2:** Run: `npm run typecheck && cd server && npx tsx --test src/canvas-api.test.ts` — PASS (frames/frame proximity + read coverage).
- [ ] **Step 3:** `git add server/src && git commit -m "refactor(server): frames feature router"`

### Task 9: Roadmap router + thin-app.ts checkpoint

**Files:**
- Create: `server/src/features/roadmap.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/roadmap-api.test.ts`, `server/src/roadmap-store.test.ts`

- [ ] **Step 1:** `createRoadmapRouter(ctx)` — move verbatim `GET /api/roadmap` (1083–1100) and `POST /api/roadmap` (1107–1169; note it uses `ctx.rooms.getOrCreateRoom` for the rev fan-out `updateStore` at old line 1152, plus `ctx.storage.roadmaps`, `slugify` from contracts, `applyOps, OpError` from `../roadmap-store.ts`). Mount between frames and uploads.
- [ ] **Step 2:** Run: `npm run typecheck && cd server && npx tsx --test src/roadmap-api.test.ts src/roadmap-store.test.ts` — PASS (fan-out test seeds a shape via getOrCreateRoom).
- [ ] **Step 3: Checkpoint — app.ts is now the kernel assembler.** Verify: `wc -l server/src/app.ts` (expect roughly 250–400 lines: imports, types, createSyncApp with stores/services/ctx, health + gateway-list routes, router mounts in order, static block, WS upgrade handler, re-exports). Confirm every `/api` feature route is gone from app.ts: `grep -n "app.post\|app.get\|app.put" server/src/app.ts` → only health, gateway/list, static/SPA remain.
- [ ] **Step 4:** `git add server/src && git commit -m "refactor(server): roadmap feature router — app.ts is now the kernel assembler"`

### Task 10: Frame fuzzy-match dedupe (conditional)

**Files:**
- Possibly create: `server/src/canvas/frames-helper.ts`
- Possibly modify: `server/src/features/sticky.ts`, `server/src/features/shape.ts`, `server/src/features/frames.ts`

The frame-name fuzzy-match logic is triplicated (was app.ts 538–543 sticky, 763–768 shape, 1006–1011 frame — now in the three routers).

- [ ] **Step 1: Compare the three blocks.** Extract each (now in features/sticky.ts, features/shape.ts, features/frames.ts) and diff them semantically: same matching rule (case-insensitive substring on frame name, exact-id first?), same tie-breaking, same miss behaviour?
- [ ] **Step 2 (only if all three are semantically IDENTICAL):** create `server/src/canvas/frames-helper.ts` exporting one `findFrameByName(store records, name)` (signature shaped by what the three sites actually share — derive it from the code, keep the return shape each site needs), replace the three inline blocks with calls, and state in the commit message that all three sites were verified identical first. If they differ in ANY way: leave all three in place and instead add a short comment at each site (`// NOTE: near-duplicate of <other two sites>; differs by <X> — see docs/superpowers/plans/2026-07-05-phase2a-server-kernel-split.md Task 10`), and report the differences.
- [ ] **Step 3:** Run: `npm run typecheck && cd server && npx tsx --test src/canvas-api.test.ts src/roadmap-api.test.ts` — PASS.
- [ ] **Step 4:** `git add server/src && git commit -m "refactor(server): dedupe frame fuzzy-match into canvas/frames-helper"` (or `docs(server): annotate frame-match near-duplicates` in the differ case).

### Task 11: Full verification battery + parity audit

**Files:** none (verification only; fixes only if something fails)

- [ ] **Step 1: Route-order parity audit.** `git show b65e2c7:server/src/app.ts | grep -n "app\.\(get\|post\|put\|use\)("` vs the effective mount order now (app.ts mounts + each feature router's registrations). Write the two ordered lists side by side in the task report; they must correspond 1:1 (json middleware first, …, static last).
- [ ] **Step 2: Full battery.**

```bash
npm run typecheck && npm run build
cd server && for t in src/*.test.ts; do echo "== $t"; npx tsx --test "$t" || exit 1; done
cd .. && DATA_DIR=$(mktemp -d) npx tsx server/src/sync-server.ts &
sleep 2
(cd server && npx tsx src/smoke-client.ts)
curl -fsS http://localhost:8788/api/health
kill %1
```

Expected: everything green; smoke prints `server replied: connect …`; health returns JSON.

- [ ] **Step 3: Line-count + import audit.** `wc -l server/src/app.ts server/src/features/*.ts server/src/kernel/*.ts` (report the numbers); `grep -rn "getPresenceRecords" server/src` → exactly one hit, in `kernel/presence.ts`.
- [ ] **Step 4:** Commit only if Steps 1–3 forced fixes: `git add server/src && git commit -m "refactor(server): kernel-split parity fixes"`.

---

## Execution postscript (2026-07-05) — deferred items for Phase 3+

Recorded at final review so they don't evaporate:

1. **av.ts cohesion** — `/api/participants` and `/api/pulse` are presence/
   heartbeat concerns, not A/V; move them to their own router when Phase 3
   renames route paths anyway.
2. **Typed store-walk helper** — six `store.getAll() as any[]` walks across
   terminal-status/shape/roadmap/sticky; give `PluginServerContext` a typed
   record-iteration capability to retire the casts (Phase 6 candidate).
3. **sticky.ts schema-direct import** — the one feature file reaching past
   ctx into `schema.ts` (`schema.types.shape.create`); route through a
   kernel shape-factory capability when one exists.

Also already recorded elsewhere: SessionRegistry accessors stay deliberately
dumb until Phase 6 (see Task 1); `sortPointOf`/`byProximity` moved to
kernel/presence.ts during Task 1 review (supersedes Task 8's import list).
