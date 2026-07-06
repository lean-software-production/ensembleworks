# Clean per-plugin routes — big-bang path rename (slice 3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate every HTTP/WS route onto its plugin's `/api/<plugin>/` prefix
in one atomic branch of commits — **no aliases, no back-compat shims**.
Behaviour-neutral apart from the path strings: same handlers, same payloads,
same status codes, same auth / write-scope behaviour. One structural change
rides along — `/api/participants` moves off the `av` router onto a new kernel
router, because it reads kernel presence, not AV state. After the slice every
route is reachable by exactly one path and `bun run typecheck`, `bun run build`
and the full `bun run test` suite (still **41 suites**, zero added/removed) are
green.

**Architecture:** The `:8788` sync app (`server/src/app.ts`) mounts the feature
routers; each router's internal path literals change. A second process, the
`:8789` terminal gateway (`server/src/terminal-gateway.ts`, kept separate for
`TERM_RUN_AS` privilege separation), relabels its own route strings. Caddy (prod
+ dev) and Vite split the single `/api/terminal/*` namespace across the two
ports: the **local plane** (`health` / `sessions[/:id]` / `ws`) to `:8789`, the
**relay plane** (`status` / `list` / `connect` / `relay`) to `:8788`. The
method-based write-scope guard and the header-based `resolveGatewayOwner` are
path-agnostic and are **not touched**.

**Tech Stack:** Bun 1.3.14, TypeScript, Express, `ws`, tldraw sync, Go
(`gateway-go` connector), Caddy, Vite.

**Spec:** `docs/superpowers/specs/2026-07-06-clean-routes-design.md` — implement
it exactly; its route table, caller inventory and test inventory are
authoritative. Charter: `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"3a — Clean per-plugin routes".

---

## The pinned route table (old → new)

| Plane / file (port) | Method | Old | New |
|---|---|---|---|
| `av` — `features/av.ts` (:8788) | GET | `/api/livekit-token` | `/api/av/token` |
| | POST | `/api/kick` | `/api/av/kick` |
| | POST | `/api/pulse` | `/api/av/pulse` |
| `canvas` — `sticky.ts`/`shape.ts`/`frames.ts` (:8788) | POST | `/api/sticky` | `/api/canvas/sticky` |
| | POST | `/api/shape` | `/api/canvas/shape` |
| | GET | `/api/frames` | `/api/canvas/frames` |
| | GET | `/api/frame` | `/api/canvas/frame` |
| `scribe` — `transcript.ts` (:8788) | POST/GET | `/api/transcript` | `/api/scribe/transcript` |
| `roadmap` — `roadmap.ts` (:8788) | GET/POST | `/api/roadmap` | `/api/roadmap/doc` |
| `terminal` relay — `terminal-status.ts`/`app.ts`/`gateway-registry.ts` (:8788) | POST | `/api/terminal-status` | `/api/terminal/status` |
| | GET | `/api/gateway/list` | `/api/terminal/list` |
| | WS | `/api/gateway/connect` | `/api/terminal/connect` |
| | WS | `/api/term/relay` | `/api/terminal/relay` |
| `terminal` local — `terminal-gateway.ts` (:8789) | GET | `/term/health` | `/api/terminal/health` |
| | GET | `/term/sessions` | `/api/terminal/sessions` |
| | DELETE | `/term/sessions/:id` | `/api/terminal/sessions/:id` |
| | WS | `/term/ws` | `/api/terminal/ws` |

**Unchanged (kernel-reserved / blob):** `/api/health`, `/api/whoami`,
`/api/participants` (path unchanged; only its module home moves — Task 2),
`WS /sync/:roomId`, `GET /*` static, `PUT/GET /uploads/:id`. The write-scope
guard, `whoami.ts`, `resolveGatewayOwner`, `resolveWriteScope` and all env var
names (`CANVAS_URL`, `CF_ACCESS_*`) are **out of scope**.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in all `server/src/*` files (and match each file's
   existing style elsewhere — the client/contracts files here are tab-indented
   too). Every verbatim block below is written with tabs; preserve them.
3. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper
   — commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```
4. **`tmux` + `bash`** must be on PATH for the full `bun run test` suite (it
   spawns real tmux sessions); it takes a few minutes — let it finish.

### Gating policy — which gates apply per task vs at the end

This is a big-bang rename decomposed **per plane**, and within each task the
route, **every one of its callers, and every test assertion of that route move
in lockstep**. That means:

- **Per task (Tasks 1–5): `bun run typecheck` MUST be green, and the specific
  edited test suite(s) named in that task MUST pass.** These are the only gates
  run mid-plan (the full suite spawns tmux and is slow, so it is deferred).
- **No task is permitted to leave a red suite.** Because callers + tests move
  with their route, the whole suite is expected to stay green after every task;
  a task's named suites failing is a stop-and-fix, not an accepted mid-plan
  window. (There is deliberately **no** sanctioned suite-red window in this
  plan.)
- **End only (Task 6): the full `bun run test` (`all 41 suites passed`),
  `bun run build`, and the grep backstop** proving no old-path literal survives
  in a live file.
- Where a test file carries assertions for routes owned by different tasks
  (`canvas-api.test.ts` has both av/canvas routes **and** terminal-status), each
  task edits **only its own route's lines**, leaving the other route's
  assertions pointing at their still-unrenamed paths — so that file stays green
  after each of the tasks that touch it.

---

## Task 1 — `av` (token/kick/pulse) + `canvas` + `scribe` + `roadmap` HTTP routes + callers + suites

Renames the four plain-HTTP `:8788` plugin planes and everything that calls
them, except `/api/participants` (Task 2), `/api/terminal-status` and
`/api/gateway/list` (Task 3). `app.ts` is **not** edited in this task.

**Server feature routers — path literals + their own doc comments:**

- [ ] **`server/src/features/av.ts`** — three route literals only (leave the
  `/api/participants` handler and its imports in place; they move in Task 2):
  ```ts
  	router.get('/api/av/token', async (req, res) => {     // was /api/livekit-token
  	router.post('/api/av/kick', async (req, res) => {     // was /api/kick
  	router.post('/api/av/pulse', (req, res) => {          // was /api/pulse
  ```

- [ ] **`server/src/features/sticky.ts`** — line 20 route + header comment
  (line 2 `POST /api/sticky` → `POST /api/canvas/sticky`):
  ```ts
  	router.post('/api/canvas/sticky', async (req, res) => {   // was /api/sticky
  ```

- [ ] **`server/src/features/shape.ts`** — line 27 route + header comment
  (line 2 `POST /api/shape:` → `POST /api/canvas/shape:`) + line 259 comment
  (`/api/sticky` → `/api/canvas/sticky`):
  ```ts
  	router.post('/api/canvas/shape', async (req, res) => {    // was /api/shape
  ```

- [ ] **`server/src/features/frames.ts`** — two route literals + header/inline
  comments. Replace-all in this file: `/api/frames` → `/api/canvas/frames`
  first, then `/api/frame` → `/api/canvas/frame` (order matters so `frames`
  isn't double-touched; after the first pass no `/api/frame` substring remains
  inside `/api/canvas/frames`). Also refresh the line 73 comment
  `POST /api/sticky` → `POST /api/canvas/sticky`. Net routes:
  ```ts
  	router.get('/api/canvas/frames', (req, res) => {   // was /api/frames
  	router.get('/api/canvas/frame', (req, res) => {    // was /api/frame
  ```

- [ ] **`server/src/features/transcript.ts`** — replace-all `/api/transcript`
  → `/api/scribe/transcript` (two route literals at lines 20 + 58, plus the
  header comment lines 2–3 and the line 55 inline comment).

- [ ] **`server/src/features/roadmap.ts`** — replace-all `/api/roadmap`
  → `/api/roadmap/doc` (two route literals at lines 19 + 43, plus header
  comment lines 2–3 and inline comments at lines 17–18 and 38). **Do NOT** touch
  the line 84 comment `the /api/terminal-status mechanism` — that terminal-plane
  comment is refreshed in Task 3.

**Client callers:**

- [ ] **`client/src/av/useLiveKitRoom.ts`** line 132:
  `` fetch(`/api/av/token?${params}`) `` (was `/api/livekit-token`).
- [ ] **`client/src/av/AvOverlay.tsx`** line 125:
  `fetch('/api/av/kick', {` (was `/api/kick`).
- [ ] **`client/src/av/useSessionPulse.ts`** — line 75 `fetch('/api/av/pulse', {`
  (was `/api/pulse`) **and** the header comment line 5 (`/api/pulse`
  → `/api/av/pulse`).
- [ ] **`client/src/av/TranscriptModal.tsx`** — line 29
  `` fetch(`/api/scribe/transcript?room=…`) `` (was `/api/transcript?…`) **and**
  the comment line 6 (`GET /api/transcript` → `GET /api/scribe/transcript`).
- [ ] **`client/src/roadmap/RoadmapShapeUtil.tsx`** — line 135 GET
  `` `/api/roadmap/doc?room=…&name=…` `` (was `/api/roadmap?…`), line 162 POST
  `fetch('/api/roadmap/doc', {` (was `/api/roadmap`), **and** the comment line 50
  (`POST /api/roadmap` → `POST /api/roadmap/doc`).

**Other callers:**

- [ ] **`transcriber/src/transcriber.ts`** — line 58
  `` fetch(`${CANVAS_URL}/api/av/token?${params}`) `` (was `/api/livekit-token`),
  line 69 `` fetch(`${CANVAS_URL}/api/scribe/transcript`, …) `` (was
  `/api/transcript`), **and** the header comment line 8 (`/api/transcript`
  → `/api/scribe/transcript`). Leave `CANVAS_URL` (env var) alone — slice #6.

- [ ] **`bin/canvas`** — path first-args (leave line 117 `/api/terminal-status`
  for Task 3; leave the `/uploads/` grep on line 202 alone):
  - line 174 `post_json /api/canvas/sticky` (was `/api/sticky`)
  - line 179 `get_query /api/canvas/frames` (was `/api/frames`)
  - lines 185 + 196 `get_query /api/canvas/frame` (was `/api/frame`)
  - lines 242 + 264 `/api/scribe/transcript` (was `/api/transcript`)
  - line 278 `post_json /api/canvas/shape` (was `/api/shape`)
  - lines 301 + 306 `get_query /api/roadmap/doc` (was `/api/roadmap`)
  - line 347 `post_json_body /api/roadmap/doc` (was `/api/roadmap`)
  - line 43 `--help` text: `POST /api/shape` → `POST /api/canvas/shape`

- [ ] **`.claude/skills/debugging-roadmap-control/probe.mjs`** — line 37
  `` fetch(`${URL_}/api/roadmap/doc?room=${ROOM}`) `` (was `/api/roadmap`), and
  **tighten** line 57 `String(a[0]).includes('/api/roadmap/doc')` (was
  `'/api/roadmap'`) so it can't false-match a future sibling leaf.

**Test suites (edit the path literals + their in-file comment/message strings
for these routes only):**

- [ ] **`server/src/canvas-api.test.ts`** — replace-all, in this order:
  `/api/sticky` → `/api/canvas/sticky`; `/api/frames` → `/api/canvas/frames`;
  `/api/frame` → `/api/canvas/frame`; `/api/kick` → `/api/av/kick`. **Leave
  `/api/terminal-status` (lines 3, 74, 90, 98, 105) and `/api/health` and the
  `src: '/uploads/whiteboard'` string untouched.**
- [ ] **`server/src/scribe-api.test.ts`** — replace-all `/api/transcript`
  → `/api/scribe/transcript`; `/api/shape` → `/api/canvas/shape`;
  `/api/livekit-token` → `/api/av/token` (covers routes + the header comment
  block lines 2–4).
- [ ] **`server/src/roadmap-api.test.ts`** — replace-all `/api/roadmap`
  → `/api/roadmap/doc` (~16 GET/POST sites + header comment line 3). No
  `/api/roadmap/doc` pre-exists, so the replace is idempotent-safe.
- [ ] **`server/src/write-scope-api.test.ts`** — line 39 `/api/sticky`
  → `/api/canvas/sticky`. (The `/api/whoami` read-passes assertion is
  unchanged.)
- [ ] **`server/src/vm-stats.test.ts`** — replace-all `/api/pulse`
  → `/api/av/pulse` (line 42 fetch + comment lines 1 and 33).

- [ ] **Gate — typecheck + the five edited suites:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd server && bun src/canvas-api.test.ts)
  (cd server && bun src/scribe-api.test.ts)
  (cd server && bun src/roadmap-api.test.ts)
  (cd server && bun src/write-scope-api.test.ts)
  (cd server && bun src/vm-stats.test.ts)
  ```
  Expected: `bun run typecheck` exits 0; each suite prints its `ok:` lines and
  exits 0 (e.g. `canvas-api.test.ts` ends with its `ok: /api/canvas/frame …`
  lines, `roadmap-api.test.ts` / `scribe-api.test.ts` end with their final
  `ok:`/passed line). Terminal-plane suites are untouched and still pass because
  their routes are unchanged in this task.

- [ ] **Commit:**
  ```bash
  git add server/src/features/av.ts server/src/features/sticky.ts \
    server/src/features/shape.ts server/src/features/frames.ts \
    server/src/features/transcript.ts server/src/features/roadmap.ts \
    client/src/av/useLiveKitRoom.ts client/src/av/AvOverlay.tsx \
    client/src/av/useSessionPulse.ts client/src/av/TranscriptModal.tsx \
    client/src/roadmap/RoadmapShapeUtil.tsx transcriber/src/transcriber.ts \
    bin/canvas .claude/skills/debugging-roadmap-control/probe.mjs \
    server/src/canvas-api.test.ts server/src/scribe-api.test.ts \
    server/src/roadmap-api.test.ts server/src/write-scope-api.test.ts \
    server/src/vm-stats.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(routes): move av/canvas/scribe/roadmap HTTP routes onto plugin prefixes

  /api/livekit-token|kick|pulse -> /api/av/*, /api/sticky|shape|frames|frame ->
  /api/canvas/*, /api/transcript -> /api/scribe/transcript, /api/roadmap ->
  /api/roadmap/doc, with every client/CLI/transcriber/probe caller and the
  HTTP test suites moved in lockstep. No handler/payload/auth change.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — lift `/api/participants` to a kernel router (path unchanged)

Structural move only: the handler is lifted **verbatim** from `av.ts` into a new
kernel router. The path (`/api/participants`) and payload are identical, so
`participants-api.test.ts` is the unchanged regression anchor — run it before
(green, proving current behaviour) and after (green, proving the move preserved
it).

**Files:** create `server/src/features/participants.ts`; modify
`server/src/features/av.ts`, `server/src/app.ts`.

- [ ] **Step 1: Anchor is green before the move:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/participants-api.test.ts)
  ```
  Expected: it passes on the current arrangement (handler still in `av.ts`).

- [ ] **Step 2: Create `server/src/features/participants.ts`** (verbatim from
  the spec — the handler body is byte-identical to the one being removed from
  `av.ts`):
  ```ts
  /**
   * Kernel participants route: GET /api/participants — live presence joined with
   * captured Cloudflare Access identities. Kernel-reserved (unprefixed): it reads
   * presence, not any plugin's state. Moved off the av router in sub-project 3a.
   */
  import express from 'express'
  import { sanitizeId } from '../canvas/ids.ts'
  import type { PluginServerContext } from '../kernel/context.ts'
  import { buildParticipants, getCursorRefs } from '../kernel/presence.ts'

  export function createParticipantsRouter(ctx: PluginServerContext): express.Router {
  	const router = express.Router()
  	router.get('/api/participants', (req, res) => {
  		const roomId = sanitizeId(String(req.query.room ?? 'team'))
  		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
  		const page = req.query.page ? String(req.query.page) : null
  		const room = ctx.rooms.rooms.get(roomId)
  		const refs = room && !room.isClosed() ? getCursorRefs(room) : []
  		res.json({
  			room: roomId,
  			page,
  			participants: buildParticipants(refs, ctx.sessions.identitiesByUser.get(roomId), page),
  		})
  	})
  	return router
  }
  ```

- [ ] **Step 3: Remove the handler from `server/src/features/av.ts`.** Delete
  the whole `/api/participants` block (the doc comment on lines 76–79 plus the
  `router.get('/api/participants', …)` handler on lines 80–91). Then **shrink
  the presence import** (line 8) so no unused import trips `noUnusedLocals`:
  ```ts
  import { rawUserId } from '../kernel/presence.ts'
  ```
  (was `import { buildParticipants, getCursorRefs, rawUserId } from '../kernel/presence.ts'`
  — both `buildParticipants` and `getCursorRefs` were used only by the lifted
  handler; `rawUserId` is still used by the pulse handler.) Finally refresh the
  file header comment (line 2) to drop the now-false "participants roster":
  ```ts
   * A/V feature — LiveKit token minting, kick, client pulse.
  ```

- [ ] **Step 4: Mount the kernel router in `server/src/app.ts`.** Add the import
  alongside the other feature imports:
  ```ts
  import { createParticipantsRouter } from './features/participants.ts'
  ```
  Mount it right after `createWhoamiRouter()` and before `createAvRouter(ctx)`:
  ```ts
  	app.use(createWhoamiRouter())

  	app.use(createParticipantsRouter(ctx))   // kernel-reserved: /api/participants

  	app.use(createAvRouter(ctx))
  ```
  Refresh the mount-order comment (lines 74–77) so it stops listing
  `participants` under `av` and names the new kernel route — e.g.:
  ```ts
  	// Feature routers mount here IN THIS ORDER (Express matches top-down and the
  	// static catch-all below must stay last): whoami → participants (kernel) → av
  	// (av/token, av/kick, av/pulse) → terminal-status → sticky → transcript →
  	// shape → frames → roadmap → uploads
  ```
  Leave the `export { buildParticipants, … } from './kernel/presence.ts'`
  re-export (line 44) and the line 155 `/api/participants` comment untouched
  (that path is unchanged).

- [ ] **Step 5: Gate — typecheck + the anchor suite:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd server && bun src/participants-api.test.ts)
  ```
  Expected: typecheck exits 0 (no unused-import error in `av.ts`);
  `participants-api.test.ts` still passes — same path, same payload, now served
  by the kernel router.

- [ ] **Step 6: Commit:**
  ```bash
  git add server/src/features/participants.ts server/src/features/av.ts server/src/app.ts
  git commit -m "$(cat <<'EOF'
  refactor(routes): lift /api/participants onto a kernel router

  It reads kernel presence, not AV state, so the handler moves verbatim from
  the av router into features/participants.ts, mounted kernel-reserved before
  the av router. Path and payload unchanged; av.ts drops its now-unused
  presence imports. participants-api.test.ts is the regression anchor.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — `terminal` plane: relay (:8788) + local (:8789) + WS callers + suites

Every remaining terminal route — the relay-plane HTTP + WS on `:8788` and the
local-plane routes on the separate `:8789` process — plus the browser WS URL
builder, the Go connector, the smoke tool, and the four terminal test suites.
No prefix is stripped anywhere: the `:8789` process now serves the literal
`/api/terminal/…` strings (Caddy/Vite forward them un-stripped — Task 4).

**Relay plane (:8788):**

- [ ] **`server/src/features/terminal-status.ts`** — line 14 route + header
  comment (line 2 `POST /api/terminal-status` → `POST /api/terminal/status`):
  ```ts
  	router.post('/api/terminal/status', async (req, res) => {   // was /api/terminal-status
  ```

- [ ] **`server/src/app.ts`** — the inline gateway-list mount (line 90) and the
  header comment (line 12):
  ```ts
  	app.get('/api/terminal/list', gatewayPlane.listHandler)   // was /api/gateway/list
  ```
  Header comment line 12: `GET  /api/gateway/list` → `GET  /api/terminal/list`.

- [ ] **`server/src/gateway-registry.ts`** — the two `url.pathname` WS-upgrade
  literals (lines 226 + 265) and the header-comment mention (lines 5–6):
  ```ts
  			if (url.pathname === '/api/terminal/connect') {   // was /api/gateway/connect
  			…
  			if (url.pathname === '/api/terminal/relay') {     // was /api/term/relay
  ```
  Header comment lines 5–6: `/api/gateway/connect` → `/api/terminal/connect`,
  `/api/term/relay` → `/api/terminal/relay`. (`resolveGatewayOwner` and
  `listHandler` are unchanged.)

- [ ] **`server/src/features/roadmap.ts`** — refresh the line 84 comment only:
  `the /api/terminal-status mechanism` → `the /api/terminal/status mechanism`.

**Local plane (:8789 — `server/src/terminal-gateway.ts`):**

- [ ] The four `url.pathname` comparisons + the DELETE regex + the header
  comment (lines 10–14):
  ```ts
  	if (req.method === 'GET' && url.pathname === '/api/terminal/health') {        // was /term/health
  	…
  	if (req.method === 'GET' && url.pathname === '/api/terminal/sessions') {      // was /term/sessions
  	…
  	const killMatch = url.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)$/)  // was /^\/term\/sessions\/([^/]+)$/
  	…
  	if (url.pathname !== '/api/terminal/ws') {                                    // was !== '/term/ws'
  ```
  Header comment lines 10–14: `Caddy proxies /term* here` → `Caddy proxies
  /api/terminal/* here`; `/term/health` → `/api/terminal/health`;
  `/term/sessions` → `/api/terminal/sessions`; `/term/sessions/:id`
  → `/api/terminal/sessions/:id`; `/term/ws?…` → `/api/terminal/ws?…`.

**Client + CLI + Go + smoke callers:**

- [ ] **`client/src/terminal/wsUrl.ts`** — the two returned URLs (lines 16 + 18)
  and the header comment (lines 3–4):
  ```ts
  		return `${proto}://${loc.host}/api/terminal/relay?session=${sessionId}&gateway=${encodeURIComponent(gateway)}&cols=${cols}&rows=${rows}`
  	}
  	return `${proto}://${loc.host}/api/terminal/ws?session=${sessionId}&cols=${cols}&rows=${rows}`
  ```
  (was `/api/term/relay?…` and `/term/ws?…`). Header comment lines 3–4:
  `/term/ws` → `/api/terminal/ws`, `/term*` → `/api/terminal/*`.

- [ ] **`client/src/terminal/TerminalToolbarItem.tsx`** — line 33
  `fetch('/api/terminal/list')` (was `/api/gateway/list`).

- [ ] **`server/src/smoke-terminal.ts`** — line 9:
  ```ts
  const BASE = 'ws://localhost:8789/api/terminal/ws'   // was ws://localhost:8789/term/ws
  ```

- [ ] **`bin/canvas`** — line 117 `post_json /api/terminal/status` (was
  `/api/terminal-status`).

- [ ] **`gateway-go/relay/relay.go`** — line 86 (charter's "gateway-go window":
  update the caller now, no server alias) and the package comment (line 2):
  ```go
  	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/terminal/connect"   // was /api/gateway/connect
  ```
  Line 2 comment: `/api/gateway/connect` → `/api/terminal/connect`.

- [ ] **`gateway-go/relay/relay_test.go`** — line 46 fake-server guard:
  ```go
  		if r.URL.Path != "/api/terminal/connect" {   // was /api/gateway/connect
  ```

**Terminal test suites — path literals only:**

- [ ] **`server/src/canvas-api.test.ts`** — replace-all `/api/terminal-status`
  → `/api/terminal/status` (lines 3, 74, 90, 98, 105). These are the assertions
  Task 1 deliberately left; the file is now fully on new paths.
- [ ] **`server/src/gateway-identity.test.ts`** — replace-all
  `/api/gateway/list` → `/api/terminal/list` (line 50) and
  `/api/gateway/connect` → `/api/terminal/connect` (lines 54, 92).
- [ ] **`server/src/gateway-plane.test.ts`** — replace-all `/api/gateway/list`
  → `/api/terminal/list` (52, 56, 95); `/api/gateway/connect`
  → `/api/terminal/connect` (55, 91, 105); `/api/term/relay`
  → `/api/terminal/relay` (62, 90, 102).
- [ ] **`server/src/relay-loopback.test.ts`** — `/api/gateway/connect`
  → `/api/terminal/connect` (line 53); `/api/term/relay`
  → `/api/terminal/relay` (line 135); and the **two `:8789` direct dials**
  `` `ws://127.0.0.1:${TERM_PORT}/term/ws?…` `` → `/api/terminal/ws` (lines 60
  and 162); plus the line 49 comment (`the real gateway's /term/ws`
  → `/api/terminal/ws`). This suite boots the real `terminal-gateway.ts`, so its
  dials must match the newly-relabelled `:8789` routes.
- [ ] **`client/src/terminal/wsUrl.test.ts`** — update the three expected
  strings (lines 10, 16, 22) to `/api/terminal/ws` and `/api/terminal/relay`,
  and the line 13 comment (`/term* elsewhere` → `/api/terminal/* elsewhere`).

- [ ] **Gate — typecheck + the terminal suites (Bun) + the Go suite:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd server && bun src/canvas-api.test.ts)
  (cd server && bun src/gateway-identity.test.ts)
  (cd server && bun src/gateway-plane.test.ts)
  (cd server && bun src/relay-loopback.test.ts)
  (cd client && bun src/terminal/wsUrl.test.ts)
  (cd gateway-go && go test ./...)
  ```
  Expected: typecheck 0; `gateway-identity.test.ts: all assertions passed`,
  `gateway-plane.test.ts: all assertions passed`, `relay-loopback.test.ts`
  passes end-to-end (it spawns tmux — allow a few seconds),
  `wsUrl.test.ts: all assertions passed`, `canvas-api.test.ts` `ok:` lines;
  `go test` prints `ok  …/gateway-go/relay`.

- [ ] **Commit:**
  ```bash
  git add server/src/features/terminal-status.ts server/src/app.ts \
    server/src/gateway-registry.ts server/src/features/roadmap.ts \
    server/src/terminal-gateway.ts server/src/smoke-terminal.ts \
    client/src/terminal/wsUrl.ts client/src/terminal/TerminalToolbarItem.tsx \
    bin/canvas gateway-go/relay/relay.go gateway-go/relay/relay_test.go \
    server/src/canvas-api.test.ts server/src/gateway-identity.test.ts \
    server/src/gateway-plane.test.ts server/src/relay-loopback.test.ts \
    client/src/terminal/wsUrl.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(routes): move the terminal plane onto /api/terminal/*

  Relay plane on :8788 (status/list/connect/relay) and local plane on :8789
  (health/sessions[/:id]/ws) relabel to /api/terminal/*; the browser wsUrl
  builder, the gateway-go connector + its test, the smoke tool, bin/canvas
  status, and the four terminal suites move in lockstep. No prefix is stripped;
  no server alias is introduced.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — edge configs: Caddy (prod + dev) + Vite proxy split

The one non-mechanical change: the edge must send the terminal **local plane** to
`:8789` and everything else — including the same-prefixed **relay plane** — to
`:8788`. Ordering matters (both Caddy matchers and Vite proxy keys are
first-match).

- [ ] **`client/vite.config.ts`** — replace the `'/term'` proxy entry (line 95)
  with a regex entry for the local-plane subset, ordered **before** `'/api'`:
  ```ts
  		proxy: {
  			'/sync': { target: 'ws://localhost:8788', ws: true },
  			'/uploads': 'http://localhost:8788',
  			// Terminal local plane (health/sessions/ws) is served by the :8789 gateway
  			// process; the relay plane (status/list/connect/relay) stays on :8788. Must
  			// precede the '/api' catch-all. The alternation also covers /sessions/:id.
  			'^/api/terminal/(health|sessions|ws)': { target: 'ws://localhost:8789', ws: true },
  			'/api': { target: 'http://localhost:8788', ws: true },
  		},
  ```

- [ ] **`deploy/Caddyfile.prod`** — replace the `handle /term* { … }` block
  (lines 36–39) with a named matcher for the local-plane subset; everything
  else keeps falling through to the `:8788` `handle {}`:
  ```caddy
  	# Terminal LOCAL plane (node-pty + tmux; WebSocket) — served by the separate
  	# gateway process on :8789. The RELAY plane (/api/terminal/{status,list,
  	# connect,relay}) stays on the sync server (:8788) via the handle{} below.
  	@term_local path /api/terminal/health /api/terminal/sessions /api/terminal/sessions/* /api/terminal/ws
  	handle @term_local {
  		reverse_proxy localhost:8789
  	}
  ```
  Also refresh the file header comment (lines 1–5): the `/term` split
  description becomes `/api/terminal/*` local plane on `:8789`, relay plane +
  everything else on `:8788`. (`reverse_proxy` upgrades the `/api/terminal/ws`
  WebSocket automatically, exactly as it did for `/term/ws`.)

- [ ] **`deploy/Caddyfile`** (dev) — **no directive change** (dev Caddy forwards
  everything non-`/livekit`/`/dev`/`/shared-browser` to Vite, which now owns the
  split). Refresh the two stale `/term` mentions in the header comments (line 13
  `/uploads, /term)` and line 71 `/uploads, /term to the sync server and
  terminal gateway`) to `/api/terminal` for accuracy.

- [ ] **Gate — typecheck (configs are not type-checked, but keep the invariant)
  + a manual read-through of matcher/key ordering:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  caddy validate --config deploy/Caddyfile.prod --adapter caddyfile   # if caddy is on PATH; else skip
  caddy validate --config deploy/Caddyfile --adapter caddyfile        # if caddy is on PATH; else skip
  ```
  Expected: typecheck 0; if `caddy` is available, both configs validate. Confirm
  by eye that the Vite `'^/api/terminal/(health|sessions|ws)'` key precedes
  `'/api'`, and that the Caddy `@term_local` matcher lists exactly
  `health`, `sessions`, `sessions/*`, `ws` (NOT `status`/`list`/`connect`/`relay`).

- [ ] **Commit:**
  ```bash
  git add client/vite.config.ts deploy/Caddyfile.prod deploy/Caddyfile
  git commit -m "$(cat <<'EOF'
  refactor(edge): split /api/terminal/* local plane to :8789 at Caddy + Vite

  Prod Caddy grows an @term_local matcher (health/sessions[/:id]/ws -> :8789);
  the relay plane and everything else fall through to :8788. Vite gains a regex
  proxy key for the same subset, ordered before the /api catch-all. Dev Caddy
  is comment-only (it forwards to Vite, which now owns the split).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — comment-only refresh sweep (live files)

Pure comment/description files that name an old path but have **no functional
edit** — refreshed so no live file carries a false path. (Historical docs/plans
and the one-shot `deploy/livekit-cutover-ash.sh` are **not** touched, per the
spec's "live files yes, history no" rule.)

- [ ] **`server/src/canvas/constants.ts`** line 1: `dropped from /api/pulse`
  → `dropped from /api/av/pulse`.
- [ ] **`server/src/canvas/frames-helper.ts`** line 4:
  `POST /api/sticky, POST /api/shape, and GET /api/frame`
  → `POST /api/canvas/sticky, POST /api/canvas/shape, and GET /api/canvas/frame`.
- [ ] **`server/src/kernel/media.ts`** line 33: `/api/kick's removeParticipant`
  → `/api/av/kick's removeParticipant`.
- [ ] **`server/src/kernel/sessions.ts`** line 17: `read back via POST /api/pulse`
  → `read back via POST /api/av/pulse`. (Leave line 13's `/api/participants` —
  path unchanged.)
- [ ] **`server/src/livekit-url.test.ts`** line 9: `so /api/kick keeps`
  → `so /api/av/kick keeps` (comment only — this file has **no** path literal,
  so it is NOT one of the ten re-pathed suites).
- [ ] **`client/src/terminal/TerminalShapeUtil.tsx`** — line 46
  `POST /api/terminal-status` → `POST /api/terminal/status`; line 49
  `See /api/gateway/list.` → `See /api/terminal/list.`.
- [ ] **`contracts/src/constants.ts`** line 7: `(POST /api/terminal-status)`
  → `(POST /api/terminal/status)`.
- [ ] **`contracts/src/shapes.ts`** — line 14 `set via POST /api/terminal-status`
  → `set via POST /api/terminal/status`; line 40 `Bumped by POST /api/roadmap`
  → `Bumped by POST /api/roadmap/doc`.
- [ ] **`deploy/systemd/ensembleworks-scribe.service`** line 2 and
  **`deploy/systemd/prod/ensembleworks-scribe.service`** line 7 — in each
  `Description=` change the trailing `-> /api/transcript` to
  `-> /api/scribe/transcript`.
- [ ] **`deploy/bootstrap-debian-ash.sh`** line 509 — `Description=` trailing
  `-> /api/transcript)` → `-> /api/scribe/transcript)`. (Leave the bare `/term`
  prose on lines 12/109/639 and every `term.env` reference — those are the
  gateway concept / a config filename, not moved route literals; see the
  Task 6 backstop note.)
- [ ] **`.claude/skills/debugging-roadmap-control/SKILL.md`** line 9:
  `` behind `GET/POST /api/roadmap` `` → `` behind `GET/POST /api/roadmap/doc` ``
  (path-accuracy touch-up only; the full four-file SKILL reseed is slice #4).

- [ ] **Gate — typecheck (these are comments, but the contracts/client/server
  files still compile) :**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  ```
  Expected: exits 0.

- [ ] **Commit:**
  ```bash
  git add server/src/canvas/constants.ts server/src/canvas/frames-helper.ts \
    server/src/kernel/media.ts server/src/kernel/sessions.ts \
    server/src/livekit-url.test.ts client/src/terminal/TerminalShapeUtil.tsx \
    contracts/src/constants.ts contracts/src/shapes.ts \
    deploy/systemd/ensembleworks-scribe.service \
    deploy/systemd/prod/ensembleworks-scribe.service \
    deploy/bootstrap-debian-ash.sh \
    .claude/skills/debugging-roadmap-control/SKILL.md
  git commit -m "$(cat <<'EOF'
  docs(routes): refresh stale route mentions in live comments/descriptions

  Comment-only touch-ups across canvas/kernel/contracts source, the terminal
  shape util, the scribe systemd units + bootstrap Description, and the
  debugging-roadmap-control SKILL one-liner, so no live file names an old path.
  History (docs/, livekit-cutover-ash.sh) is left as-is by design.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — full gate: typecheck + full suite + build + grep backstop

- [ ] **Step 1: Full gate:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  (cd gateway-go && go test ./...)
  ```
  Expected: typecheck 0; `bun run test` ends **`all 41 suites passed`** (same
  count as before — this slice adds and removes zero suites); `bun run build` 0;
  `go test` `ok`.

- [ ] **Step 2: Grep backstop — no old-path literal survives in a live file.**
  Run from the repo root:
  ```bash
  grep -rnE '/api/(livekit-token|kick|pulse|sticky|shape|frames?|transcript|roadmap|terminal-status|gateway/(list|connect)|term/relay)|/term/(health|sessions|ws)' \
    --include='*.ts' --include='*.tsx' --include='*.go' --include='*.mjs' \
    --include='*.sh' --include='*.service' --include='Caddyfile*' \
    server client contracts transcriber gateway-go deploy bin .claude \
    | grep -vE '/api/roadmap/doc' \
    | grep -vE 'deploy/livekit-cutover-ash\.sh'
  ```
  Expected: **no output.** Notes on why this pattern is exact:
  - `/api/roadmap/doc` (the new roadmap path) is filtered out, so only a
    surviving bare `/api/roadmap` would hit.
  - The alternation matches only the **moved** literals — `/term/(health|sessions|ws)`
    and `term/relay`, NOT bare `/term` — so `deploy/bootstrap-debian-ash.sh`'s
    prose `/term`, every `term.env` filename, and the `sync/term/scribe` unit-name
    references do **not** false-positive (they are not renamed routes).
  - `deploy/livekit-cutover-ash.sh` is a one-shot script run against past state;
    it is history, excluded here.
  - New paths never match the old-pattern (`/api/terminal/list|connect|relay`
    contains neither `gateway/` nor `term/relay`; `/api/terminal/{health,
    sessions,ws}` is not `/term/…`; `/api/canvas/frame(s)` is not `/api/frame(s)`
    with `/api/` immediately before `frame`).

  If any line appears, it is a missed edit — fix it, re-run typecheck + the
  relevant suite, and amend/append a commit before proceeding.

- [ ] **Step 3: Manual smoke (README "Development") — proves the edge split, not
  just the unit suites.** With `tmux` + `bash` available:
  ```bash
  bin/dev up
  curl -s 'http://localhost:8080/api/av/token?room=team&identity=x' | head -c 200 ; echo
  CANVAS_URL=http://localhost:8080 bin/canvas sticky 'clean-routes smoke' --author bot
  # In the browser at :8080: open a LOCAL terminal shape (direct /api/terminal/ws
  # via the :8789 split) and a RELAYED one (/api/terminal/relay via :8788), and
  # confirm a /uploads image round-trips.
  ```
  Expected: the token endpoint answers JSON (`{"enabled":…}`); the sticky posts
  (200); both a direct and a relayed terminal attach and echo; `/uploads` images
  still load. Optionally run the gateway smoke: `(cd server && bun src/smoke-terminal.ts)`
  → `ALL TERMINAL GATEWAY SMOKE TESTS PASSED`.

- [ ] **Step 4: Commit (only if Step 2 required a fix; otherwise nothing new to
  commit — the gate is verification):**
  ```bash
  git status   # expect clean if no backstop fix was needed
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all 41 suites passed` — and any deviation from the verbatim blocks above.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every route in the pinned table** appears in a task: av token/kick/pulse
  + canvas sticky/shape/frames/frame + scribe transcript + roadmap doc (Task 1);
  participants move (Task 2); terminal-status/list/connect/relay + local
  health/sessions[/:id]/ws (Task 3). Kernel-reserved paths and `/uploads` are
  explicitly left unchanged.
- **Every caller** in the spec's inventory is covered: client `av/*`,
  `roadmap/RoadmapShapeUtil`, `terminal/{wsUrl,TerminalToolbarItem}`;
  `bin/canvas` (all verbs, both terminal-status in Task 3 and the rest in
  Task 1); `transcriber.ts`; `gateway-go/relay/relay.go` (+ test); the two
  out-of-suite dev tools `smoke-terminal.ts` and `probe.mjs`; and the two edge
  configs + Vite.
- **All ten re-pathed suites** are edited with their route (canvas-api split
  across Tasks 1+3 by route; scribe-api, roadmap-api, write-scope-api, vm-stats
  in Task 1; gateway-identity, gateway-plane, relay-loopback, wsUrl.test.ts in
  Task 3; relay_test.go in Task 3). The regression anchors that need no path
  edit (participants-api, whoami-api, uploads-api, gateway-owner,
  gateway-registry, livekit-url) are respected — `livekit-url.test.ts` gets a
  comment-only touch in Task 5 and is correctly excluded from the ten.
- **Every comment file** in the spec's enumerated list is refreshed, in the
  same task as its file's functional edit where one exists (useSessionPulse,
  TranscriptModal, RoadmapShapeUtil, transcriber, the routers, gateway-registry,
  terminal-gateway, wsUrl, app.ts in Tasks 1–3) or in the Task 5 sweep
  (canvas/constants, frames-helper, media, sessions, livekit-url.test,
  TerminalShapeUtil, contracts/{constants,shapes}, scribe systemd ×2, bootstrap
  Description, SKILL.md line 9). `kernel/presence.ts:60` and `sessions.ts:13`
  are correctly left (they name the unchanged `/api/participants`).
- **Placeholder scan:** no "update paths as per spec" hand-waving remains —
  every step names exact files, exact old→new strings, and the gate command +
  expected output.
- **Type consistency:** the only signature-affecting change is the participants
  lift; `av.ts`'s presence import is shrunk to `rawUserId` in the same task so
  `noUnusedLocals` stays green, and `createParticipantsRouter` is mounted where
  it is imported — typecheck is green at the end of every task.
