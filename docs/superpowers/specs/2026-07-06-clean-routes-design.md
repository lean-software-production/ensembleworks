# Clean per-plugin routes — big-bang path rename

**Phase 3, sub-project 3a.** Relocate every HTTP/WS route onto its plugin's
`/api/<plugin>/` prefix in one atomic change, with **no aliases and no
back-compat shims**. Behaviour-neutral apart from the paths: the same handlers,
the same request/response payloads, and the same auth / write-scope behaviour.
One structural change rides along — `/api/participants` moves off the `av`
router onto a kernel route — because it reads kernel presence, not AV state.

Conforms to the plugin-architecture track charter (`2026-07-06-plugin-architecture-track-charter.md`),
§"3a — Clean per-plugin routes", which pins the route table, the prefix rule,
`/uploads` staying top-level, the :8789 process staying separate behind
`/api/terminal/*`, and `/api/participants` moving to kernel-reserved.

## Background

Today the sync app (`server/src/app.ts`, port 8788) mounts nine feature routers
whose paths are historical nouns scattered flat under `/api` — `/api/sticky`,
`/api/livekit-token`, `/api/gateway/list`, `/api/terminal-status`,
`/api/transcript`, `/api/roadmap`, plus WS `/api/gateway/connect` and
`/api/term/relay`. A second process, the terminal gateway
(`server/src/terminal-gateway.ts`, port 8789, kept separate for TERM_RUN_AS
privilege separation — charter decision 2), serves `/term/health`,
`/term/sessions[/:id]` and WS `/term/ws`. Caddy splits the edge by proxying
`/term*` to :8789 and everything else to :8788; in dev, Vite's proxy does the
same split.

The design (`unified-architecture-design.md` §1.2, §3) makes each plugin own a
sub-router under `/api/<plugin>/`. §3 fixes the plugin ids: `av`, `canvas`
(stickies/frames/shape), `scribe` (transcript), `terminal` (status + gateway
registry + relay + the :8789 local plane), `roadmap`. This slice performs that
relocation as a rename-only, big-bang cut: nothing is renamed halfway, no alias
survives, so it must land atomically across the server, every caller, the two
edge configs, and the tests.

The auth-plane foundation and the write-scope guard already exist. The write
guard (`server/src/features/write-scope.ts`) is **method-based and
path-agnostic**: it 403s a read-only service token on any mutating method,
mounted app-wide before the routers. Renaming paths does not touch it — verified
below.

## Goal

Every route lives under its plugin prefix (or is explicitly kernel-reserved and
unprefixed), reachable by exactly one path. After this slice:

- No handler logic, payload shape, status code, query param, or auth check
  changes. `bun run typecheck`, `bun run build`, and the full `bun run test`
  suite are green, with the **same suite count (41) — this slice adds and
  removes zero suites**; only path string literals inside existing suites change.
- The client, `bin/canvas`, the transcriber, and the Go connector all reach the
  server through the new paths; the two edge configs route the split
  `/api/terminal/*` namespace correctly.

## Scope

**In scope**

- `server/src/app.ts` — remount every feature router / inline route on its new
  prefix; add the kernel participants route; update the header comment block.
- `server/src/features/av.ts` — `av` routes to `/api/av/*`; **remove** the
  `/api/participants` handler (it moves to the kernel route).
- `server/src/features/participants.ts` — **new** kernel router carrying the
  moved `/api/participants` handler verbatim.
- `server/src/features/sticky.ts`, `shape.ts`, `frames.ts` — `canvas` prefix.
- `server/src/features/terminal-status.ts` — `/api/terminal/status`.
- `server/src/features/transcript.ts` — `/api/scribe/transcript`.
- `server/src/features/roadmap.ts` — `/api/roadmap/doc`.
- `server/src/gateway-registry.ts` — WS upgrade path literals + the inline
  `list` handler's mount move (mount lives in app.ts; the literals for connect /
  relay live here).
- `server/src/terminal-gateway.ts` (:8789) — `/api/terminal/{health,sessions,ws}`.
- Callers: `client/src/**`, `client/vite.config.ts`, `bin/canvas`,
  `transcriber/src/transcriber.ts`, `gateway-go/relay/relay.go`, and two pieces
  of out-of-suite dev tooling that dial routes directly:
  `server/src/smoke-terminal.ts` (README line 149; dials the :8789 gateway —
  one string edit) and `.claude/skills/debugging-roadmap-control/probe.mjs`
  (fetches `GET /api/roadmap` — see Components).
- Edge: `deploy/Caddyfile.prod`, `deploy/Caddyfile`.
- Tests: the ten suites that embed a moving path (enumerated in Testing).
- **Comment-only refreshes — the rule: live files get them, history doesn't.**
  Every comment/description mention of an old path in a file the repo still
  builds, runs, or deploys is refreshed to the new spelling (one-line edits;
  stale comments at the exact seam being renamed are false documentation).
  Files already listed above refresh their comments as part of their edit
  (feature routers, `gateway-registry.ts`, `terminal-gateway.ts`, `app.ts`,
  `wsUrl.ts`, `RoadmapShapeUtil.tsx`, the re-pathed test suites). Additional
  comment-only files: `client/src/av/useSessionPulse.ts` (line 5),
  `client/src/av/TranscriptModal.tsx` (line 6),
  `client/src/terminal/TerminalShapeUtil.tsx` (lines 46, 49),
  `server/src/livekit-url.test.ts` (line 9 — comment only, so NOT in the
  ten-suite list), `server/src/canvas/frames-helper.ts` (line 4),
  `server/src/canvas/constants.ts` (line 1), `server/src/kernel/media.ts`
  (line 33), `server/src/kernel/sessions.ts` (line 17),
  `contracts/src/constants.ts` (line 7), `contracts/src/shapes.ts` (lines 14
  and 40), and the scribe `Description=` lines in
  `deploy/systemd/ensembleworks-scribe.service`,
  `deploy/systemd/prod/ensembleworks-scribe.service`, and
  `deploy/bootstrap-debian-ash.sh` (`/api/transcript` →
  `/api/scribe/transcript`), plus the one-line
  `GET/POST /api/roadmap` → `/api/roadmap/doc` mention in
  `.claude/skills/debugging-roadmap-control/SKILL.md` (line 9). This is a
  path-accuracy touch-up only — the charter's full SKILL.md reseed (all four
  skill files rewritten atomically with the new CLI) stays owned by slice #4.

**Out of scope (other slices / unchanged)**

- **Kernel-reserved paths keep their exact spelling** and are *not* touched:
  `/api/health`, `/api/whoami`, `/api/participants` (path unchanged; only its
  module home moves), `WS /sync/:roomId`, `GET /*` static, `/api/tools` + `/mcp`
  (Phase 4, don't exist yet).
- **`/uploads/:id` stays top-level** — the path is baked into persisted tldraw
  asset URLs, so moving it would break keel (existing rooms). `PUT` still carries
  its own `express.raw` and must keep dodging the `/api` JSON parser. No change.
- **The write-scope guard** (`features/write-scope.ts`) — untouched. It is
  method-based, so it keeps covering every renamed write route plus `/uploads`.
- **`whoami.ts`, `resolveGatewayOwner`, `resolveWriteScope`** — header-based,
  path-agnostic; unchanged.
- **Env var names** (`CANVAS_URL` → `ENSEMBLEWORKS_URL`, `CF_ACCESS_*`) — that
  is slice #5/#6, not 3a. This slice changes the transcriber's and the Go
  connector's **paths only**, leaving their env vars alone.
- **Attribution / `body.author`** — sub-project 3c, its own slice.
- **Tool manifest / docStore extraction** — Phase 4. The roadmap route keeps its
  current overloaded GET+POST handlers; this slice only relocates them.
- **Historical design docs and plans** under `docs/`, the README dev section,
  and one-shot cutover scripts already run against past state
  (`deploy/livekit-cutover-ash.sh`) mention old paths as historical record, not
  as functional callers or live documentation; per the comment-refresh rule
  above (live files yes, history no), they are not edited here.

## The pinned route table (old → new)

Every route, exhaustive. "plane" is the process/port that serves it.

### `av` plugin — `server/src/features/av.ts` (:8788)

| Method | Old | New |
|---|---|---|
| GET  | `/api/livekit-token` | `/api/av/token` |
| POST | `/api/kick`          | `/api/av/kick` |
| POST | `/api/pulse`         | `/api/av/pulse` |

### `canvas` plugin — `sticky.ts` / `shape.ts` / `frames.ts` (:8788)

| Method | Old | New |
|---|---|---|
| POST | `/api/sticky` | `/api/canvas/sticky` |
| POST | `/api/shape`  | `/api/canvas/shape` |
| GET  | `/api/frames` | `/api/canvas/frames` |
| GET  | `/api/frame`  | `/api/canvas/frame` |

### `scribe` plugin — `transcript.ts` (:8788)

| Method | Old | New |
|---|---|---|
| POST | `/api/transcript` | `/api/scribe/transcript` |
| GET  | `/api/transcript` | `/api/scribe/transcript` |

### `roadmap` plugin — `roadmap.ts` (:8788)

| Method | Old | New |
|---|---|---|
| GET  | `/api/roadmap` | `/api/roadmap/doc` |
| POST | `/api/roadmap` | `/api/roadmap/doc` |

**Leaf pin (charter delegates leaf naming to the slice plan):** the roadmap
plugin is a doc store — one GET (list when no `?name=`, read one when named) and
one POST (create / replace / ops) over roadmap documents. To stay
behaviour-neutral this slice keeps **exactly the two express routes that exist
today**, relocated onto a single resource leaf `doc`. Splitting the overload
into per-verb leaves would change the observable 404 surface, so it is
deliberately not done here (that is Phase 4 / the tool-manifest slice's call).
`doc` echoes the design's `docStore('roadmap', …)` concept.

### `terminal` plugin — relay plane, `app.ts` + `gateway-registry.ts` (:8788)

| Method | Old | New |
|---|---|---|
| POST | `/api/terminal-status` | `/api/terminal/status` |
| GET  | `/api/gateway/list`    | `/api/terminal/list` |
| WS   | `/api/gateway/connect` | `/api/terminal/connect` |
| WS   | `/api/term/relay`      | `/api/terminal/relay` |

### `terminal` plugin — local plane, `terminal-gateway.ts` (:8789, separate process)

| Method | Old | New |
|---|---|---|
| GET    | `/term/health`         | `/api/terminal/health` |
| GET    | `/term/sessions`       | `/api/terminal/sessions` |
| DELETE | `/term/sessions/:id`   | `/api/terminal/sessions/:id` |
| WS     | `/term/ws`             | `/api/terminal/ws` |

The :8789 process **stays separate** (charter decision 2 — TERM_RUN_AS
privilege separation, one-static-binary deploy). Only its route *strings* change;
no prefix is stripped anywhere (old `/term*` was proxied un-stripped, new
`/api/terminal/*` is too), so the process serves the literal `/api/terminal/…`
paths. Caddy/Vite split the one namespace across the two ports (below).

### Kernel-reserved (unprefixed) — unchanged paths

| Method | Path | Note |
|---|---|---|
| GET | `/api/health` | inline in app.ts, unchanged |
| GET | `/api/whoami` | `features/whoami.ts`, unchanged |
| GET | `/api/participants` | **path unchanged**; handler moves av → kernel (below) |
| WS  | `/sync/:roomId` | app.ts upgrade, unchanged |
| GET | `/*` static + SPA fallback | unchanged (still excludes `/api`) |
| PUT/GET | `/uploads/:id` | `features/uploads.ts`, top-level, unchanged |

### The prefix rule (charter)

`prefix = plugin id` from design §3 — `canvas`, `scribe`, `terminal`,
`roadmap`, `av`. The historical noun survives only as a **leaf** (`token`,
`status`, `sticky`, `transcript`, `doc`) or a CLI verb. Where id == noun
(`roadmap`) a leaf still disambiguates (`/api/roadmap/doc`), so no prefix
collides with a bare noun path.

## Components

### `server/src/app.ts` — remount + move participants to kernel

Change each `app.use(...)` router's internal path (in its feature file) and the
two inline routes here. Concretely in `app.ts`:

```ts
// was: app.get('/api/gateway/list', gatewayPlane.listHandler)
app.get('/api/terminal/list', gatewayPlane.listHandler)
```

Mount the new kernel participants router right after `createWhoamiRouter()` and
before `createAvRouter(ctx)` (kernel routes group together; order is otherwise
irrelevant — all paths are now disjoint prefixes):

```ts
app.use(createWhoamiRouter())
app.use(createParticipantsRouter(ctx))   // kernel-reserved: /api/participants
app.use(createAvRouter(ctx))
```

Update the file header comment (it currently lists `GET /api/gateway/list` as an
inline route) to name `/api/terminal/list` and the new participants route. The
`app.use('/api', express.json())` parser and `app.use(createWriteScopeGuard())`
lines are **unchanged** — every new route is still under `/api` (so bodies are
parsed) except `/uploads` (still raw), and the guard is method-based.

The static SPA fallback's `!req.path.startsWith('/api')` guard still correctly
excludes all new routes (`/api/av/*`, `/api/canvas/*`, `/api/scribe/*`,
`/api/terminal/*`, `/api/roadmap/*`) and still lets `/uploads` through to its
router (mounted before the fallback). No change.

### `server/src/features/participants.ts` — new kernel router

The `/api/participants` handler is lifted **verbatim** out of `av.ts` (it reads
`getCursorRefs`, `buildParticipants`, `ctx.rooms`, `ctx.sessions` — kernel
presence, no AV state), into its own router so the move is structurally honest.
Path and behaviour identical.

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

`av.ts` loses that handler and MUST drop **both** now-unused imports from
`../kernel/presence.ts` — `buildParticipants` **and** `getCursorRefs` — since
each is used only inside the lifted handler; a leftover import fails
`bun run typecheck` (noUnusedLocals). Its presence import line shrinks to
`import { rawUserId } from '../kernel/presence.ts'` (`rawUserId` is still used
by the pulse handler). The `app.ts` re-export of `buildParticipants` for tests
(line 44) is untouched — it imports from `kernel/presence.ts` directly, not via
`av.ts`.

### Feature routers — path-only edits

Each is a single string change per route. Examples:

```ts
// av.ts
router.get('/api/av/token', …)   // was /api/livekit-token
router.post('/api/av/kick', …)   // was /api/kick
router.post('/api/av/pulse', …)  // was /api/pulse

// sticky.ts   router.post('/api/canvas/sticky', …)
// shape.ts    router.post('/api/canvas/shape', …)
// frames.ts   router.get('/api/canvas/frames', …) ; router.get('/api/canvas/frame', …)
// terminal-status.ts  router.post('/api/terminal/status', …)
// transcript.ts  router.post('/api/scribe/transcript', …) ; router.get('/api/scribe/transcript', …)
// roadmap.ts  router.get('/api/roadmap/doc', …) ; router.post('/api/roadmap/doc', …)
```

Handler bodies, validation, status codes, and payloads are untouched. The
roadmap rev-fan-out comment referencing "the `/api/terminal-status` mechanism"
is refreshed to `/api/terminal/status` (comment only, non-functional).

### `server/src/gateway-registry.ts` — WS upgrade literals

```ts
if (url.pathname === '/api/terminal/connect') { … }   // was /api/gateway/connect
if (url.pathname === '/api/terminal/relay')   { … }   // was /api/term/relay
```

`resolveGatewayOwner(req.headers)` (the connect auth) is header-based and
unchanged. `listHandler` is unchanged; only its mount path in `app.ts` moved.

### `server/src/terminal-gateway.ts` (:8789) — local-plane literals

The HTTP router's four `url.pathname` comparisons and the DELETE regex, plus the
`/term/ws` upgrade check and the header-comment route list:

```ts
url.pathname === '/api/terminal/health'                       // was /term/health
url.pathname === '/api/terminal/sessions'                     // was /term/sessions
url.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)$/)    // was /^\/term\/sessions\/…$/
url.pathname !== '/api/terminal/ws'  → destroy                // was !== '/term/ws'
```

No prefix strip is introduced — the process serves the literal `/api/terminal/…`
paths, matching how Caddy/Vite forward them un-stripped.

### `server/src/smoke-terminal.ts` — dev smoke caller of the :8789 gateway

The gateway smoke (documented in README "Development": `bun src/smoke-terminal.ts`)
dials the gateway directly and moves with it — one string edit:

```ts
const BASE = 'ws://localhost:8789/api/terminal/ws'   // was ws://localhost:8789/term/ws
```

It is NOT part of the discovered `*.test.ts` suite (so no suite-count effect),
which also means a missed edit here fails **silently until someone next runs
the smoke** — it is therefore listed as a first-class caller, not left to the
grep sweep. (`smoke-client.ts` hits `/sync` only; unchanged.)

### `.claude/skills/debugging-roadmap-control/probe.mjs` — skill dev tooling

Same out-of-suite class. Line 37 fetches the roadmap list and must move:

```js
const list = (await (await fetch(`${URL_}/api/roadmap/doc?room=${ROOM}`)).json()).roadmaps  // was /api/roadmap
```

Line 57's fetch-interception check `String(a[0]).includes('/api/roadmap')`
still matches the new `/api/roadmap/doc` as a substring, but is tightened to
`'/api/roadmap/doc'` anyway so it can never false-match a future sibling leaf.

### `client/src/**` — caller path edits

| File | Old | New |
|---|---|---|
| `av/useLiveKitRoom.ts` | `/api/livekit-token?…` | `/api/av/token?…` |
| `av/AvOverlay.tsx` | `/api/kick` | `/api/av/kick` |
| `av/useSessionPulse.ts` | `/api/pulse` | `/api/av/pulse` |
| `av/TranscriptModal.tsx` | `/api/transcript?…` | `/api/scribe/transcript?…` |
| `roadmap/RoadmapShapeUtil.tsx` | `/api/roadmap` (GET + POST) | `/api/roadmap/doc` |
| `terminal/TerminalToolbarItem.tsx` | `/api/gateway/list` | `/api/terminal/list` |
| `terminal/wsUrl.ts` | `/api/term/relay?…` and `/term/ws?…` | `/api/terminal/relay?…` and `/api/terminal/ws?…` |

`assetStore.ts` and `screenshare/ScreenShareShapeUtil.tsx` (`/uploads/…`) and
`App.tsx` (`/sync/…`) are **unchanged**. `TerminalShapeUtil.tsx` has two
comments naming `/api/terminal-status` and `/api/gateway/list`; refresh them to
the new spellings (comment only).

### `client/vite.config.ts` — dev proxy split

Replace the `/term` entry with a regex entry for the local-plane subset,
ordered **before** `/api` (Vite picks the first matching context in insertion
order):

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

`/api/terminal/{status,list,connect,relay}` fall through to the `/api` → :8788
entry (correct — they are the relay plane on the sync app).

### `deploy/Caddyfile.prod` — edge split

Replace the `handle /term* { reverse_proxy localhost:8789 }` block with a named
matcher for the local-plane subset; everything else (including
`/api/terminal/{status,list,connect,relay}`) continues to the :8788 `handle {}`:

```caddy
	# Terminal LOCAL plane (node-pty + tmux; WebSocket) — served by the separate
	# gateway process on :8789. The RELAY plane (/api/terminal/{status,list,
	# connect,relay}) stays on the sync server (:8788) via the handle{} below.
	@term_local path /api/terminal/health /api/terminal/sessions /api/terminal/sessions/* /api/terminal/ws
	handle @term_local {
		reverse_proxy localhost:8789
	}

	# Everything else — app + static/SPA, /sync (WS), /api (incl. the terminal
	# relay plane), /uploads — served by the sync server.
	handle {
		reverse_proxy localhost:8788
	}
```

`reverse_proxy` upgrades the `/api/terminal/ws` WebSocket automatically (as
`/term/ws` did). Update the file's header comment (which describes the `/term`
split) to the new namespace.

### `deploy/Caddyfile` (dev) — no functional change

Dev Caddy only owns `/livekit`, `/dev/{port}`, `/shared-browser`, and forwards
everything else to Vite (which now does the `/api/terminal/*` split). The stale
`/term` mentions in its header comment are refreshed to `/api/terminal` for
accuracy; no directive changes.

### `transcriber/src/transcriber.ts` — path-only

```ts
fetch(`${CANVAS_URL}/api/av/token?${params}`)     // was /api/livekit-token
fetch(`${CANVAS_URL}/api/scribe/transcript`, …)   // was /api/transcript
```

`CANVAS_URL` (the env var) is **left alone** — its rename is slice #6.

### `gateway-go/relay/relay.go` — the connector's connect path

**This is the charter's "gateway-go window" call. Decision: update it now as a
caller, no breakage window, no server alias.**

`gateway-go` is a live caller of the connect WS, exactly like `bin/canvas` is a
live caller of the HTTP routes. The charter's big-bang / no-aliases posture
means the server grows no `/api/gateway/connect` alias; the way to honour "must
keep working until #8" without an alias is to update the one caller in lockstep —
the identical mechanic 3a already applies to `bin/canvas` (which also dies later,
at #4). The change is a single line plus its test string, behaviour-neutral
(path only):

```go
u.Path = strings.TrimSuffix(u.Path, "/") + "/api/terminal/connect"  // was /api/gateway/connect
```

Rationale it is **not** an escalation / product call: it is the same
"update-every-caller-of-the-moved-path" rule the charter already fixes for this
slice; gateway-go is enumerated among those callers. Leaving it broken until #5
would be a *choice to skip a listed caller*, which the no-aliases posture does
not require and "must keep working until then" forbids. So we update it. (It is
still retired wholesale at #8 per charter decision 1; #5's native `terminal
connect` will target the same new path.) `CANVAS_URL` / `CF_ACCESS_*` env vars
are untouched here (slice #5). The Go change is outside the Bun test suite
(`go test`), so it does not affect the suite count.

### `bin/canvas` — CLI caller paths

`bin/canvas` still exists until #4 (charter), so 3a updates its paths now (it
dies later). Every `post_json` / `get_query` first-arg path changes:

| Verb site | Old | New |
|---|---|---|
| terminal status | `/api/terminal-status` | `/api/terminal/status` |
| sticky | `/api/sticky` | `/api/canvas/sticky` |
| frames | `/api/frames` | `/api/canvas/frames` |
| frame (read + pull-images) | `/api/frame` | `/api/canvas/frame` |
| transcript (get + post) | `/api/transcript` | `/api/scribe/transcript` |
| shape | `/api/shape` | `/api/canvas/shape` |
| roadmap (get + post) | `/api/roadmap` | `/api/roadmap/doc` |

The `--help` text line mentioning `POST /api/shape` and the pull-images
`grep -oE '"url":"/uploads/…"'` filter: the help string updates to
`/api/canvas/shape`; the `/uploads/` grep is **unchanged** (uploads stays
top-level and the asset URLs in responses are still `/uploads/…`).

## Data flow

```
browser / bin/canvas / transcriber
   → GET /api/av/token, POST /api/canvas/sticky, /api/scribe/transcript, …
   → :8788 sync app  (express.json → writeScopeGuard → plugin router)

browser (relay) / gateway-go connector
   → WS /api/terminal/connect, /api/terminal/relay
   → :8788 sync app  (gateway-registry handleUpgrade; resolveGatewayOwner)

browser (direct terminal) / relay splice
   → WS /api/terminal/ws, GET /api/terminal/sessions, DELETE …/:id, GET …/health
   → edge split (Caddy @term_local / Vite regex) → :8789 gateway process

/api/participants  → :8788 kernel participants router (path unchanged)
/uploads/:id, /api/health, /api/whoami, /sync/:roomId, /*  → unchanged
```

The write-scope guard sits before all routers and matches on method, so it keeps
403-ing read-only tokens on every renamed write route and on `/uploads` with
zero edits. WS upgrades still bypass express and the guard, as before.

## Testing

Rename-only slice: **no suite added or removed; the count stays 41.** Ten
existing suites embed a moving path literal and get mechanical string edits; the
rest are unaffected. After the edits, `bun run typecheck`, `bun run build`, and
`bun run test` (`all 41 suites passed`) are green.

**Suites whose path literals change (server, :8788 unless noted):**

- `server/src/canvas-api.test.ts` — `/api/terminal-status`→`/api/terminal/status`,
  `/api/sticky`→`/api/canvas/sticky`, `/api/frames`→`/api/canvas/frames`,
  `/api/frame`→`/api/canvas/frame`, `/api/kick`→`/api/av/kick`. (`/api/health`
  and the `src: '/uploads/whiteboard'` asset-data string stay.)
- `server/src/scribe-api.test.ts` — `/api/transcript`→`/api/scribe/transcript`,
  `/api/shape`→`/api/canvas/shape`, `/api/livekit-token`→`/api/av/token`.
- `server/src/roadmap-api.test.ts` — `/api/roadmap`→`/api/roadmap/doc`
  (GET + POST, ~16 sites).
- `server/src/gateway-identity.test.ts` — `/api/gateway/list`→`/api/terminal/list`,
  `/api/gateway/connect`→`/api/terminal/connect`.
- `server/src/gateway-plane.test.ts` — `/api/gateway/list`,
  `/api/gateway/connect`, `/api/term/relay` → `/api/terminal/{list,connect,relay}`.
- `server/src/relay-loopback.test.ts` — `/api/gateway/connect`→`/api/terminal/connect`,
  `/api/term/relay`→`/api/terminal/relay`, and the **:8789** direct dials
  `/term/ws`→`/api/terminal/ws` (two sites; it spawns the real
  `terminal-gateway.ts`, which now serves the new path).
- `server/src/write-scope-api.test.ts` — `/api/sticky`→`/api/canvas/sticky`
  (the `/api/whoami` read-still-passes assertion is unchanged).
- `server/src/vm-stats.test.ts` — its second half boots the real app and POSTs
  the pulse contract: `/api/pulse`→`/api/av/pulse` (one fetch site, line 42,
  plus its comment lines).
- `client/src/terminal/wsUrl.test.ts` — asserts the two `buildTermWsUrl`
  outputs; update expected strings to `/api/terminal/relay` and
  `/api/terminal/ws`.
- `gateway-go/relay/relay_test.go` — the fake server's
  `r.URL.Path != "/api/gateway/connect"` guard → `/api/terminal/connect`
  (run via `go test`, outside the Bun suite count).

**Suites that touch routes but need NO functional edit (paths unchanged) —
regression anchors:** `participants-api.test.ts` (`/api/participants` — proves
the av→kernel move preserved the path and payload), `whoami-api.test.ts`
(`/api/whoami`), `uploads-api.test.ts` (`/uploads/:id`), `gateway-owner.test.ts`
/ `gateway-registry.test.ts` (pure, header/struct only), and
`livekit-url.test.ts` (comment-only refresh per the scope rule; no path
literal).

**Manual smoke (README "Development"):** `bin/dev up`, then exercise one route
per plugin end-to-end through the edge — `curl :8080/api/av/token?room=team&identity=x`,
`bin/canvas sticky …`, open a terminal shape (direct `/api/terminal/ws` via the
:8789 split) and a relayed one (`/api/terminal/relay` via :8788), and confirm
`/uploads` image round-trips. This proves the Caddy/Vite split, not just the
unit suites.

## Risks

- **R1 — the edge split is the only non-mechanical change.** A mis-scoped Caddy
  matcher or Vite key ordering sends terminal traffic to the wrong port. Mitigated:
  the `@term_local` / regex lists exactly the three local-plane leaves
  (`health`, `sessions[/:id]`, `ws`); everything else — including the
  same-prefixed relay plane — falls through to :8788. The manual smoke exercises
  both a direct and a relayed terminal, and `relay-loopback.test.ts` drives the
  real two-process path end-to-end.
- **R2 — a missed caller.** Because there are no aliases, any un-updated caller
  in the request path 404s immediately — loud for everything the suite or the
  app exercises (client, `bin/canvas`, transcriber, gateway-go). The exception
  class is **out-of-suite dev tooling**, which fails silently until next run:
  the two such callers found (`smoke-terminal.ts`,
  `debugging-roadmap-control/probe.mjs`) are in scope above. Backstop for both
  classes: after the edit, `grep -rn` for every old path literal across
  `*.ts`/`*.tsx`/`*.go`/`*.sh`/`*.mjs`, `bin/canvas`, `.claude/skills/`, and
  the vite/Caddy/systemd configs must return only historical docs/plans and
  the one-shot `deploy/livekit-cutover-ash.sh`; any other hit is a missed edit
  and blocks the merge.
- **R3 — write-scope / auth regression.** None expected: the guard is
  method-based and `resolveGatewayOwner` header-based, both path-agnostic.
  `write-scope-api.test.ts` (re-pathed) and `gateway-identity.test.ts` re-prove
  it on the new paths.
- **R4 — roadmap leaf choice.** `/api/roadmap/doc` is a slice-plan pin the
  charter delegates; it keeps today's overloaded GET+POST intact. If Phase 4's
  tool manifest later wants per-verb leaves, that is a separate, additive change —
  this slice deliberately does not pre-empt it.
- **R5 — gateway-go coupling.** Updating `relay.go`'s path keeps the connector
  working across the branch until #5 replaces it; it is retired at #8 regardless.
  No server alias is introduced, so the no-aliases posture holds.
