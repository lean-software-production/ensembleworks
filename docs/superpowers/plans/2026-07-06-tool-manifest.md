# Tool manifest — declare the verbs, serve `GET /api/tools` (slice 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare every non-exempt HTTP verb the `:8788` kernel app serves as a
typed tool def in `contracts/src/tools/<plugin>.ts` (**15 defs**), and serve a
read-only, machine-readable manifest at `GET /api/tools` (a kernel route). This
is **manifest-only**: no route is re-mounted through a registry, no handler
body, payload, status code, validation or auth changes. The tool registry is a
*description* of routes that already exist; a bidirectional completeness test
binds the two so they cannot drift. After the slice `bun run typecheck`,
`bun run build` and `bun run test` are green and the suite count is **41 → 43**
(this slice adds exactly two suites).

**Spec:** `docs/superpowers/specs/2026-07-06-tool-manifest-design.md` — implement
it exactly; its tool-def shape, verb inventory, manifest envelope, code layout
and test inventory are authoritative. **Charter:**
`docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"Phase 4 — Registry + MCP" (tool-def shape + exempt list) and its "Ratified
extensions" section (the `plugin` 6th field + the `/api/tools` envelope).

**Scope boundary (from the spec — do not cross it):** 3b does **not** re-mount
routes through a registry, does **not** build `/mcp`, does **not** change any
route's behaviour, does **not** generalise `docStore` / extract the rev-fan-out,
and does **not** split the overloaded scribe/roadmap GET+POST routes. One tool
def per `(method, path)` that exists today.

---

## The verb inventory (all 15 — the target state)

| plugin | id | method | path | source router | help |
|---|---|---|---|---|---|
| kernel | `whoami` | GET | `/api/whoami` | `features/whoami.ts` | Resolve the caller's identity envelope (human/bot/anonymous + via). |
| kernel | `participants` | GET | `/api/participants` | `features/participants.ts` | List live presence joined with captured Access identities. |
| av | `token` | GET | `/api/av/token` | `features/av.ts` | Mint a LiveKit join token for a room (role member or scribe). |
| av | `kick` | POST | `/api/av/kick` | `features/av.ts` | Disconnect a user from the room's canvas + media session. |
| av | `pulse` | POST | `/api/av/pulse` | `features/av.ts` | Session heartbeat: report RTT, read back latencies + VM pressure. |
| terminal | `status` | POST | `/api/terminal/status` | `features/terminal-status.ts` | Set the status light on the terminal shape(s) with a session id. |
| terminal | `list` | GET | `/api/terminal/list` | `gateway-registry.ts` (mounted in `app.ts`) | List registered remote terminal gateways. |
| canvas | `sticky` | POST | `/api/canvas/sticky` | `features/sticky.ts` | Post a sticky note, optionally parented to a fuzzy-matched frame. |
| canvas | `shape` | POST | `/api/canvas/shape` | `features/shape.ts` | Create/update/delete a diagram shape (geo, arrow, text, note). |
| canvas | `frames` | GET | `/api/canvas/frames` | `features/frames.ts` | List frames with child counts, nearest-cursor-first. |
| canvas | `frame` | GET | `/api/canvas/frame` | `features/frames.ts` | Read one frame's stickies, text, images, terminals, iframes. |
| scribe | `say` | POST | `/api/scribe/transcript` | `features/transcript.ts` | Append a transcript line (stamped with the speaker's cursor/frame). |
| scribe | `transcript` | GET | `/api/scribe/transcript` | `features/transcript.ts` | Read the room's transcript tail (`since`/`limit`, oldest first). |
| roadmap | `write` | POST | `/api/roadmap/doc` | `features/roadmap.ts` | Create/replace or apply targeted ops to a roadmap doc (`ifRev`). |
| roadmap | `read` | GET | `/api/roadmap/doc` | `features/roadmap.ts` | List roadmaps (no `name`) or read one (`name`) with its rev. |

**Exempt (declared by no tool def):** `GET /api/health` (health), `GET /api/tools`
(the manifest itself — meta-endpoint), static/SPA fallback, `PUT/GET /uploads/:id`
(binary, non-`/api`), all WS upgrades (`/sync/:roomId`, `/api/terminal/{connect,relay}`),
and the whole `:8789` local plane (separate process). The completeness test's
exempt predicate is exactly `path === '/api/health' || path === '/api/tools'`
(everything else that is exempt is not an express `route` layer, so it never
appears in introspection).

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in all `server/src/*` **and** `contracts/src/*` files
   (both packages are tab-indented). Every verbatim block below is written with
   tabs; preserve them.
3. **Intra-`contracts` imports use the `.js` extension** (nodenext-style;
   resolves to the `.ts` source). Server imports contracts through the package
   name `@ensembleworks/contracts`, and its own modules with `.ts` extensions.
4. **Zod is v4** (`contracts` depends on `zod ^4.0.0`, resolved 4.4.3): `z.enum`
   accepts a readonly tuple, `z.toJSONSchema(schema)` emits draft-2020-12 JSON
   Schema natively, `z.discriminatedUnion` and `z.union` both project cleanly.
5. **Test convention.** Self-running `bun src/x.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob, each ending
   `console.log('ok: …')`. The full `bun run test` spawns real tmux and takes a
   few minutes — let it finish.
6. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task vs at the end

- **Per task (Tasks 1–3): `bun run typecheck` MUST be green, and the specific
  test suite(s) named in that task MUST be at the state the task declares**
  (RED at a written-test checkpoint, GREEN at the task's end). These are the
  only gates run mid-plan; the full tmux-spawning suite is deferred to Task 4.
- **No task is permitted to leave a red suite at its end.** A RED checkpoint is
  an explicit, momentary TDD step within a task, immediately driven to GREEN by
  the same task.
- **End only (Task 4): the full `bun run test` (`all 43 suites passed`),
  `bun run build`, and the manual smoke.**

---

## Task 1 — Relocate `NOTE_COLORS` / `GEO_TYPES` into `contracts` (spec R4)

The canvas tool defs need the colour/geo enums in a browser-safe contract, but
they live in `server/src/canvas/constants.ts`. Move them to
`contracts/src/constants.ts` and **re-export** from the server module so
`sticky.ts` / `shape.ts` keep their current import path unchanged. Same array
values, no behaviour change — the only consumers are `sticky.ts` and `shape.ts`
(both via `../canvas/constants.ts`); there are no client consumers.

- [ ] **`contracts/src/constants.ts`** — append the two arrays (with their
  tldraw provenance comments), after the existing `TMUX_SESSION_PREFIX`:
  ```ts
  // The note colours tldraw's default schema accepts (see TLDefaultColorStyle).
  // Owned by contracts (protocol-by-naming); re-exported from the server's
  // canvas/constants.ts so its importers keep their path.
  export const NOTE_COLORS = [
  	'black',
  	'grey',
  	'light-violet',
  	'violet',
  	'blue',
  	'light-blue',
  	'yellow',
  	'orange',
  	'green',
  	'light-green',
  	'light-red',
  	'red',
  	'white',
  ]

  // The geo styles tldraw's default schema accepts (see GeoShapeGeoStyle).
  export const GEO_TYPES = [
  	'cloud',
  	'rectangle',
  	'ellipse',
  	'triangle',
  	'diamond',
  	'pentagon',
  	'hexagon',
  	'octagon',
  	'star',
  	'rhombus',
  	'rhombus-2',
  	'oval',
  	'trapezoid',
  	'arrow-right',
  	'arrow-left',
  	'arrow-up',
  	'arrow-down',
  	'x-box',
  	'check-box',
  	'heart',
  ]
  ```
  (`contracts/src/index.ts` already does `export * from './constants.js'`, so no
  barrel edit is needed for these.)

- [ ] **`server/src/canvas/constants.ts`** — delete the local `NOTE_COLORS` and
  `GEO_TYPES` array definitions (and their two comment blocks), and re-export
  them from contracts so the import path in `sticky.ts` / `shape.ts` is
  preserved. Keep `PULSE_STALE_MS`, `STICKY_GRID_COLS`, `STICKY_GRID_STEP` and
  the file header comment exactly as they are. Add at the top of the file (after
  the header comment):
  ```ts
  // Colour + geo enums are protocol-by-naming: they live in @ensembleworks/contracts
  // (browser-safe) and are re-exported here so sticky.ts/shape.ts keep their path.
  export { NOTE_COLORS, GEO_TYPES } from '@ensembleworks/contracts'
  ```
  After the edit the file exports exactly: `PULSE_STALE_MS`, `NOTE_COLORS`
  (re-export), `GEO_TYPES` (re-export), `STICKY_GRID_COLS`, `STICKY_GRID_STEP`.
  Do not add or remove anything else (there is no `TMUX_SESSION_PREFIX` in this
  server module — that constant already lives in contracts and is untouched).

- [ ] **Gate — typecheck (proves the re-export preserves `sticky.ts`/`shape.ts`):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  ```
  Expected: exits 0. `sticky.ts` (`import { NOTE_COLORS, STICKY_GRID_COLS,
  STICKY_GRID_STEP } from '../canvas/constants.ts'`) and `shape.ts`
  (`import { GEO_TYPES, NOTE_COLORS } from '../canvas/constants.ts'`) still
  resolve through the re-export.

- [ ] **Commit:**
  ```bash
  git add contracts/src/constants.ts server/src/canvas/constants.ts
  git commit -m "$(cat <<'EOF'
  refactor(contracts): relocate NOTE_COLORS/GEO_TYPES into contracts

  The canvas tool defs (slice 3b) need the colour/geo enums in a browser-safe
  contract. Move both arrays into contracts/src/constants.ts and re-export from
  server/src/canvas/constants.ts so sticky.ts/shape.ts keep their import path.
  Same values; no behaviour change.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — The tool defs + the contracts unit test (TDD: RED → GREEN)

Write the registry unit test **first** (it fails: no tools module), then author
the tool-def shape + all six plugin files + the barrel to green. All verbatim
blocks below are field-for-field transcriptions of the live handlers.

### Step 1 — Write the failing unit test

- [ ] **`contracts/src/tools/tools.test.ts`** (create the `tools/` directory with
  it):
  ```ts
  // Registry unit test (no server boot): asserts the SHAPE of the tool registry
  // — counts, uniqueness, and that every schema serialises to JSON Schema.
  // Run with: bun src/tools/tools.test.ts
  import assert from 'node:assert/strict'
  import { z } from 'zod'
  import {
  	allTools,
  	buildManifest,
  	MANIFEST_VERSION,
  	type HttpMethod,
  } from './index.js'

  const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE']
  const PLUGINS = ['kernel', 'av', 'canvas', 'scribe', 'roadmap', 'terminal']

  // 1. Exactly 15 declared verbs.
  assert.equal(allTools.length, 15, 'expected 15 tool defs')

  // 2. Every def is well-formed.
  for (const t of allTools) {
  	assert.ok(t.id.length > 0, `empty id on ${t.plugin}.${t.id}`)
  	assert.ok(PLUGINS.includes(t.plugin), `bad plugin '${t.plugin}'`)
  	assert.ok(typeof t.help === 'string' && t.help.length > 0, `no help on ${t.plugin}.${t.id}`)
  	assert.ok(METHODS.includes(t.http.method), `bad method on ${t.plugin}.${t.id}`)
  	assert.ok(t.http.path.startsWith('/api/'), `path must start /api/ on ${t.plugin}.${t.id}`)
  }

  // 3. (plugin, id) pairs unique; (method, path) pairs unique (GET+POST may share
  //    a path across methods — scribe/roadmap overloads — but never collide).
  const pluginIds = new Set(allTools.map((t) => `${t.plugin}.${t.id}`))
  assert.equal(pluginIds.size, allTools.length, 'duplicate (plugin, id)')
  const methodPaths = new Set(allTools.map((t) => `${t.http.method} ${t.http.path}`))
  assert.equal(methodPaths.size, allTools.length, 'duplicate (method, path)')

  // 4. Every schema projects to JSON Schema without throwing (guards against an
  //    un-serialisable Zod construct reaching the wire / 500-ing /api/tools).
  for (const t of allTools) {
  	assert.doesNotThrow(() => z.toJSONSchema(t.zodInput), `zodInput unserialisable: ${t.plugin}.${t.id}`)
  	assert.doesNotThrow(() => z.toJSONSchema(t.zodOutput), `zodOutput unserialisable: ${t.plugin}.${t.id}`)
  }

  // 5. buildManifest wraps them in the envelope.
  const manifest = buildManifest(allTools, '0.0.0')
  assert.equal(manifest.version, MANIFEST_VERSION, 'manifest.version')
  assert.equal(manifest.tools.length, 15, 'manifest.tools length')

  console.log('ok: tool registry — 15 defs, unique ids/paths, all schemas serialise')
  ```

- [ ] **RED checkpoint — run it, expect failure (no tools module yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd contracts && bun src/tools/tools.test.ts)
  ```
  Expected: **fails** — `Cannot find module './index.js'` (the `tools/` barrel
  and its defs don't exist yet). This is the RED state; Steps 2–9 turn it green.

### Step 2 — `contracts/src/tools/types.ts` (verbatim from spec)

- [ ] Create it:
  ```ts
  import { z } from 'zod'

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

  /** One agent-callable verb. Declared once; projected to HTTP (source of truth),
   *  the /api/tools manifest (→ CLI), and — Phase 4 — MCP. */
  export interface ToolDef {
  	/** Bare verb id, unique within its plugin (e.g. 'sticky', 'read'). */
  	id: string
  	/** Plugin group this verb belongs to (design §3 ids + 'kernel'). */
  	plugin: 'kernel' | 'av' | 'canvas' | 'scribe' | 'roadmap' | 'terminal'
  	/** The one HTTP route that backs this verb — the drift anchor. */
  	http: { method: HttpMethod; path: string }
  	/** One-line help, rendered by `ensembleworks <plugin> <id> --help`. */
  	help: string
  	/** Request schema. GET/DELETE ⇒ query string; POST/PUT ⇒ JSON body
  	 *  (the method fixes the location). */
  	zodInput: z.ZodType
  	/** Success (2xx) response body. The error envelope `{ error: string }` is a
  	 *  kernel-wide convention, documented once, not repeated per tool. */
  	zodOutput: z.ZodType
  }

  export interface ManifestEntry {
  	plugin: string
  	id: string
  	method: HttpMethod
  	path: string
  	help: string
  	input: unknown   // JSON Schema (draft 2020-12)
  	output: unknown
  }

  export interface ManifestEnvelope {
  	version: number
  	server: string
  	tools: ManifestEntry[]
  }

  export const MANIFEST_VERSION = 1

  export function toManifestEntry(t: ToolDef): ManifestEntry {
  	return {
  		plugin: t.plugin,
  		id: t.id,
  		method: t.http.method,
  		path: t.http.path,
  		help: t.help,
  		input: z.toJSONSchema(t.zodInput),
  		output: z.toJSONSchema(t.zodOutput),
  	}
  }

  export function buildManifest(tools: ToolDef[], server: string): ManifestEnvelope {
  	return { version: MANIFEST_VERSION, server, tools: tools.map(toManifestEntry) }
  }
  ```

### Step 3 — `contracts/src/tools/kernel.ts` (verbatim from spec)

- [ ] Create it:
  ```ts
  import { z } from 'zod'
  import { whoamiSchema } from '../whoami.js'
  import type { ToolDef } from './types.js'

  export const kernelWhoami: ToolDef = {
  	plugin: 'kernel',
  	id: 'whoami',
  	http: { method: 'GET', path: '/api/whoami' },
  	help: "Resolve the caller's identity envelope (human/bot/anonymous + via).",
  	zodInput: z.object({}),          // no params
  	zodOutput: whoamiSchema,         // reused from contracts/src/whoami.ts
  }

  export const kernelParticipants: ToolDef = {
  	plugin: 'kernel',
  	id: 'participants',
  	http: { method: 'GET', path: '/api/participants' },
  	help: 'List live presence joined with captured Access identities.',
  	zodInput: z.object({
  		room: z.string().default('team'),
  		page: z.string().optional().describe('restrict to one tldraw page'),
  	}),
  	zodOutput: z.object({
  		room: z.string(),
  		page: z.string().nullable(),
  		participants: z.array(z.object({}).loose()),   // shape owned by presence.ts; kept loose in 3b
  	}),
  }

  export const kernelTools: ToolDef[] = [kernelWhoami, kernelParticipants]
  ```

### Step 4 — `contracts/src/tools/av.ts` (transcribed from `features/av.ts`)

- [ ] Create it. `token` reads `req.query` (`room`+`identity` required, `name`
  default `'teammate'`, `role` default `'member'`); `kick`/`pulse` read
  `req.body`. Outputs mirror each handler's `res.json`, including `token`'s
  `enabled:false` short-circuit and `pulse`'s `vm` (`VmStats` from `vm-stats.ts`)
  + per-user `latencies` map.
  ```ts
  import { z } from 'zod'
  import type { ToolDef } from './types.js'

  const room = z.string().default('team')

  // Mirrors VmStats in server/src/vm-stats.ts (readVmStats return).
  const vmStats = z.object({
  	cpu: z.object({
  		load1: z.number(),
  		cores: z.number(),
  		pct: z.number(),
  		pressure: z.number().nullable(),
  	}),
  	mem: z.object({
  		usedBytes: z.number(),
  		limitBytes: z.number().nullable(),
  		highBytes: z.number().nullable(),
  		usedPct: z.number(),
  		pressure: z.number().nullable(),
  		source: z.enum(['cgroup', 'host']),
  	}),
  })

  export const avToken: ToolDef = {
  	plugin: 'av',
  	id: 'token',
  	http: { method: 'GET', path: '/api/av/token' },
  	help: 'Mint a LiveKit join token for a room (role member or scribe).',
  	zodInput: z.object({
  		room: z.string().min(1).describe('room id (required; sanitised server-side)'),
  		identity: z.string().min(1).max(128).describe('participant identity (required)'),
  		name: z.string().max(64).default('teammate').describe('display name'),
  		role: z.enum(['member', 'scribe']).default('member').describe('scribe ⇒ subscribe-only token'),
  	}),
  	// enabled:false when LiveKit isn't configured; else the minted token + url.
  	zodOutput: z.union([
  		z.object({ enabled: z.literal(false) }),
  		z.object({ enabled: z.literal(true), token: z.string(), url: z.string() }),
  	]),
  }

  export const avKick: ToolDef = {
  	plugin: 'av',
  	id: 'kick',
  	http: { method: 'POST', path: '/api/av/kick' },
  	help: "Disconnect a user from the room's canvas + media session.",
  	zodInput: z.object({
  		room: z.string().min(1).describe('room id (required)'),
  		userId: z.string().min(1).max(128).describe('presence userId to disconnect (required)'),
  	}),
  	zodOutput: z.object({ ok: z.literal(true), disconnected: z.number() }),
  }

  export const avPulse: ToolDef = {
  	plugin: 'av',
  	id: 'pulse',
  	http: { method: 'POST', path: '/api/av/pulse' },
  	help: 'Session heartbeat: report RTT, read back latencies + VM pressure.',
  	zodInput: z.object({
  		room,
  		userId: z.string().max(128).optional(),
  		rttMs: z.number().min(0).max(60_000).optional().describe('round-trip of the previous pulse, ms'),
  	}),
  	zodOutput: z.object({
  		ok: z.literal(true),
  		now: z.number(),
  		vm: vmStats,
  		latencies: z.record(z.string(), z.object({ rtt: z.number(), t: z.number() })),
  	}),
  }

  export const avTools: ToolDef[] = [avToken, avKick, avPulse]
  ```

### Step 5 — `contracts/src/tools/terminal.ts` (transcribed from `features/terminal-status.ts` + `gateway-registry.ts`)

- [ ] Create it. `status` body requires a non-empty `sessionId` **and** a
  `TERMINAL_STATUSES` enum `status` (both, per spec); `list` takes no params and
  returns the registry's `list()` envelope.
  ```ts
  import { z } from 'zod'
  import { TERMINAL_STATUSES } from '../constants.js'
  import type { ToolDef } from './types.js'

  const room = z.string().default('team')

  export const terminalStatus: ToolDef = {
  	plugin: 'terminal',
  	id: 'status',
  	http: { method: 'POST', path: '/api/terminal/status' },
  	help: 'Set the status light on the terminal shape(s) with a session id.',
  	zodInput: z.object({
  		room,
  		sessionId: z.string().min(1).describe('terminal shape sessionId prop (required)'),
  		status: z.enum(TERMINAL_STATUSES),
  	}),
  	zodOutput: z.object({ ok: z.literal(true), updated: z.number() }),
  }

  export const terminalList: ToolDef = {
  	plugin: 'terminal',
  	id: 'list',
  	http: { method: 'GET', path: '/api/terminal/list' },
  	help: 'List registered remote terminal gateways.',
  	zodInput: z.object({}),
  	zodOutput: z.object({
  		gateways: z.array(z.object({
  			gatewayId: z.string(),
  			label: z.string(),
  			relayOnly: z.literal(true),
  			connectedAt: z.number(),
  		})),
  	}),
  }

  export const terminalTools: ToolDef[] = [terminalStatus, terminalList]
  ```

### Step 6 — `contracts/src/tools/canvas.ts` (verbatim from spec)

- [ ] Create it (the spec's fully-worked plugin; `room` defaults to `'team'`,
  `text` 1–2000 chars, colour/geo enums from the relocated constants):
  ```ts
  import { z } from 'zod'
  import { NOTE_COLORS, GEO_TYPES } from '../constants.js'   // relocated in Task 1
  import type { ToolDef } from './types.js'

  const room = z.string().default('team')
  const okId = z.object({ ok: z.literal(true), id: z.string().nullable() })

  export const canvasSticky: ToolDef = {
  	plugin: 'canvas',
  	id: 'sticky',
  	http: { method: 'POST', path: '/api/canvas/sticky' },
  	help: 'Post a sticky note, optionally parented to a fuzzy-matched frame.',
  	zodInput: z.object({
  		room,
  		text: z.string().min(1).max(2000).describe('sticky body; trimmed, 1–2000 chars'),
  		frame: z.string().optional().describe('fuzzy (case-insensitive substring) frame name'),
  		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional().describe('defaults to yellow server-side'),
  	}),
  	zodOutput: okId,
  }

  export const canvasShape: ToolDef = {
  	plugin: 'canvas',
  	id: 'shape',
  	http: { method: 'POST', path: '/api/canvas/shape' },
  	help: 'Create/update/delete a diagram shape (geo, arrow, text, note).',
  	zodInput: z.object({
  		room,
  		op: z.enum(['create', 'update', 'delete']).default('create'),
  		// create
  		type: z.enum(['geo', 'text', 'note', 'arrow']).optional(),
  		frame: z.string().optional(),
  		geo: z.enum(GEO_TYPES as [string, ...string[]]).optional(),
  		fromId: z.string().optional().describe('arrow start shape id'),
  		toId: z.string().optional().describe('arrow end shape id'),
  		// update / delete
  		id: z.string().optional().describe('required for update/delete'),
  		// shared
  		text: z.string().optional(),
  		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional(),
  		fill: z.string().optional(),
  		x: z.number().optional(),
  		y: z.number().optional(),
  		w: z.number().optional(),
  		h: z.number().optional(),
  		props: z.record(z.string(), z.unknown()).optional().describe('raw prop merge (update)'),
  	}),
  	// create/update → { ok, id }; delete → { ok, deleted }. Union both success shapes.
  	zodOutput: z.union([okId, z.object({ ok: z.literal(true), deleted: z.number() })]),
  }

  export const canvasFrames: ToolDef = {
  	plugin: 'canvas',
  	id: 'frames',
  	http: { method: 'GET', path: '/api/canvas/frames' },
  	help: 'List frames with child counts, nearest-cursor-first.',
  	zodInput: z.object({ room }),
  	zodOutput: z.object({
  		ok: z.literal(true),
  		sortedBy: z.object({
  			userName: z.string(), page: z.string(), cursor: z.object({ x: z.number(), y: z.number() }),
  		}).nullable(),
  		frames: z.array(z.object({
  			id: z.string(), name: z.string(), page: z.string().nullable(),
  			x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(),
  			notes: z.number(), texts: z.number(), images: z.number(),
  			terminals: z.number(), iframes: z.number(), dist: z.number().nullable().optional(),
  		})),
  	}),
  }

  export const canvasFrame: ToolDef = {
  	plugin: 'canvas',
  	id: 'frame',
  	http: { method: 'GET', path: '/api/canvas/frame' },
  	help: "Read one frame's stickies, text, images, terminals, iframes.",
  	zodInput: z.object({ room, name: z.string().min(1).describe('fuzzy frame name') }),
  	zodOutput: z.object({
  		ok: z.literal(true),
  		frame: z.object({ id: z.string(), name: z.string().optional(), page: z.string().nullable() }),
  		sortedBy: z.object({ userName: z.string(), cursor: z.object({ x: z.number(), y: z.number() }) }).nullable(),
  		notes: z.array(z.object({ id: z.string(), text: z.string(), color: z.string().optional() })),
  		texts: z.array(z.object({ id: z.string(), text: z.string() })),
  		images: z.array(z.object({
  			id: z.string(), url: z.string().nullable(), name: z.string().nullable(),
  			w: z.number().optional(), h: z.number().optional(),
  		})),
  		terminals: z.array(z.object({ id: z.string(), sessionId: z.string().optional(), title: z.string().optional(), status: z.string().nullable() })),
  		iframes: z.array(z.object({ id: z.string(), url: z.string().optional(), title: z.string().optional() })),
  	}),
  }

  export const canvasTools: ToolDef[] = [canvasSticky, canvasShape, canvasFrames, canvasFrame]
  ```

### Step 7 — `contracts/src/tools/scribe.ts` (transcribed from `features/transcript.ts` + `transcript-store.ts`)

- [ ] Create it. `say` body: `identity`+`text` required (`text` trimmed,
  1–4000 chars), `name` optional (defaults to identity server-side), `t`
  optional; output carries the appended `TranscriptEntry`. `transcript` query:
  `since` (≥0, default 0), `limit` (≥1, default 1000); output is the entry tail
  plus the server clock `now`.
  ```ts
  import { z } from 'zod'
  import type { ToolDef } from './types.js'

  const room = z.string().default('team')

  // Mirrors TranscriptEntry in server/src/transcript-store.ts.
  const transcriptEntry = z.object({
  	id: z.string(),
  	t: z.number().describe('ms epoch, server-stamped on append'),
  	identity: z.string(),
  	name: z.string(),
  	text: z.string(),
  	page: z.string().nullable(),
  	cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  	frame: z.object({ name: z.string(), dist: z.number() }).nullable(),
  })

  export const scribeSay: ToolDef = {
  	plugin: 'scribe',
  	id: 'say',
  	http: { method: 'POST', path: '/api/scribe/transcript' },
  	help: "Append a transcript line (stamped with the speaker's cursor/frame).",
  	zodInput: z.object({
  		room,
  		identity: z.string().min(1).max(128).describe('LiveKit identity == tldraw presence userId (required)'),
  		name: z.string().max(64).optional().describe('display name; defaults to identity'),
  		text: z.string().min(1).max(4000).describe('utterance; trimmed server-side, 1–4000 chars'),
  		t: z.number().optional().describe('ms epoch; server-stamped when omitted'),
  	}),
  	zodOutput: z.object({ ok: z.literal(true), entry: transcriptEntry }),
  }

  export const scribeTranscript: ToolDef = {
  	plugin: 'scribe',
  	id: 'transcript',
  	http: { method: 'GET', path: '/api/scribe/transcript' },
  	help: "Read the room's transcript tail (since/limit, oldest first).",
  	zodInput: z.object({
  		room,
  		since: z.number().min(0).default(0).describe('ms epoch; entries with t > since'),
  		limit: z.number().min(1).default(1000),
  	}),
  	zodOutput: z.object({
  		ok: z.literal(true),
  		now: z.number(),
  		entries: z.array(transcriptEntry),
  	}),
  }

  export const scribeTools: ToolDef[] = [scribeSay, scribeTranscript]
  ```

### Step 8 — `contracts/src/tools/roadmap.ts` (transcribed from `features/roadmap.ts` + `roadmap-store.ts`)

- [ ] Create it. `write` body: `name` required (≤128), optional `ifRev`
  concurrency guard, and a non-empty `ops` batch (`replace | set | move`, the
  `RoadmapOp` vocabulary). `read` query: optional `name` — omit to list, provide
  (exact id or fuzzy name) to read one doc. The `RoadmapDoc` and op shapes mirror
  `roadmap-store.ts`.
  ```ts
  import { z } from 'zod'
  import type { ToolDef } from './types.js'

  const room = z.string().default('team')

  // Mirrors RoadmapDoc + its nested interfaces in server/src/roadmap-store.ts.
  // (The store validates structure/keys; the manifest only describes the shape.)
  const roadmapMetric = z.object({ key: z.string(), text: z.string(), done: z.boolean() })
  const roadmapFeature = z.object({ key: z.string(), text: z.string(), status: z.string() })
  const roadmapInitiative = z.object({
  	key: z.string(),
  	title: z.string(),
  	status: z.string(),
  	statement: z.string().optional(),
  	metrics: z.array(roadmapMetric).optional(),
  	features: z.array(roadmapFeature).optional(),
  })
  const roadmapOutcome = z.object({
  	key: z.string(),
  	zone: z.string(),
  	status: z.string(),
  	title: z.string(),
  	why: z.string().optional(),
  	initiatives: z.array(roadmapInitiative).optional(),
  })
  const roadmapDoc = z.object({
  	meta: z.object({
  		title: z.string(),
  		revision: z.string().optional(),
  		updated: z.string().optional(),
  	}),
  	outcomes: z.array(roadmapOutcome),
  })

  // RoadmapOp vocabulary (replace | set | move) — server/src/roadmap-store.ts.
  const roadmapOp = z.discriminatedUnion('op', [
  	z.object({ op: z.literal('replace'), data: roadmapDoc }),
  	z.object({ op: z.literal('set'), key: z.string(), fields: z.record(z.string(), z.unknown()) }),
  	z.object({ op: z.literal('move'), key: z.string(), zone: z.string().optional(), index: z.number().int().optional() }),
  ])

  export const roadmapWrite: ToolDef = {
  	plugin: 'roadmap',
  	id: 'write',
  	http: { method: 'POST', path: '/api/roadmap/doc' },
  	help: 'Create/replace or apply targeted ops to a roadmap doc (ifRev).',
  	zodInput: z.object({
  		room,
  		name: z.string().min(1).max(128).describe('roadmap name (required); a new doc must start with a replace op'),
  		ifRev: z.number().optional().describe('optimistic-concurrency guard; 409 on mismatch'),
  		ops: z.array(roadmapOp).min(1).describe('all-or-nothing op batch'),
  	}),
  	zodOutput: z.object({
  		ok: z.literal(true),
  		id: z.string(),
  		rev: z.number(),
  		shapesUpdated: z.number(),
  	}),
  }

  export const roadmapRead: ToolDef = {
  	plugin: 'roadmap',
  	id: 'read',
  	http: { method: 'GET', path: '/api/roadmap/doc' },
  	help: 'List roadmaps (no name) or read one (name) with its rev.',
  	zodInput: z.object({
  		room,
  		name: z.string().optional().describe('omit to list; provide (exact id or fuzzy name) to read one'),
  	}),
  	// No name → { ok, roadmaps: [...] }; with name → the full doc. Union both.
  	zodOutput: z.union([
  		z.object({
  			ok: z.literal(true),
  			roadmaps: z.array(z.object({
  				id: z.string(), name: z.string(), rev: z.number(), updated: z.string(),
  			})),
  		}),
  		z.object({
  			ok: z.literal(true),
  			id: z.string(),
  			name: z.string(),
  			rev: z.number(),
  			updated: z.string(),
  			data: roadmapDoc,
  		}),
  	]),
  }

  export const roadmapTools: ToolDef[] = [roadmapWrite, roadmapRead]
  ```

### Step 9 — `contracts/src/tools/index.ts` + barrel (verbatim from spec)

- [ ] Create `contracts/src/tools/index.ts`:
  ```ts
  export * from './types.js'
  import { kernelTools } from './kernel.js'
  import { avTools } from './av.js'
  import { terminalTools } from './terminal.js'
  import { canvasTools } from './canvas.js'
  import { scribeTools } from './scribe.js'
  import { roadmapTools } from './roadmap.js'
  export * from './kernel.js'; export * from './av.js'; export * from './terminal.js'
  export * from './canvas.js'; export * from './scribe.js'; export * from './roadmap.js'

  /** The tool registry — every declared verb, in a stable order. */
  export const allTools = [
  	...kernelTools, ...avTools, ...terminalTools, ...canvasTools, ...scribeTools, ...roadmapTools,
  ]
  ```

- [ ] **`contracts/src/index.ts`** — add the tools barrel export (keep the
  existing `.js`-extension convention), after the `whoami.js` line:
  ```ts
  export * from './tools/index.js'
  ```

### Step 10 — GREEN gate

- [ ] **Run the unit test + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd contracts && bun src/tools/tools.test.ts)
  bun run typecheck
  ```
  Expected: the test prints
  `ok: tool registry — 15 defs, unique ids/paths, all schemas serialise` and
  exits 0; `bun run typecheck` exits 0.

- [ ] **Commit:**
  ```bash
  git add contracts/src/tools contracts/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(contracts): declare the 15-verb tool registry (slice 3b)

  contracts/src/tools/{types,kernel,av,terminal,canvas,scribe,roadmap,index}.ts:
  one typed ToolDef per non-exempt :8788 HTTP verb, each { id, plugin, http,
  help, zodInput, zodOutput }, plus buildManifest/toManifestEntry and the
  ManifestEnvelope. Schemas transcribed field-for-field from the live handlers.
  A registry unit test asserts count/uniqueness and that every schema projects
  to JSON Schema. Manifest-only: no route behaviour touched.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — Serve `/api/tools` + bind routes to their defs (TDD: RED → GREEN)

Add the `SERVER_VERSION` source, expose the express `app` as a read-only test
seam, write the bidirectional completeness test (**RED**: no `/api/tools`
route), then add the router + the one-line path-source edits (**GREEN**).

### Step 1 — `server/src/version.ts`

- [ ] Create it. Reads the root `package.json` version at source-run.

  > **Deviation note (technical, non-product):** the spec sketches version.ts as
  > "importing the JSON". A static `import … from '../../package.json'` would
  > require turning on `resolveJsonModule` in `server/tsconfig.json` (its
  > `moduleResolution` is `bundler`) — an extra config edit outside 3b's surface.
  > A runtime read of the same file is behaviourally identical under source-run,
  > needs no tsconfig change, and matches the spec's own note that `server` is a
  > soft field whose absence/`"0.0.0"` is non-fatal. This is the settled reading.

  ```ts
  /**
   * SERVER_VERSION — the root package.json version, read at source-run. Feeds the
   * informational `server` field of the /api/tools manifest envelope (slice 3b).
   * Soft by design: on any read failure it is '0.0.0' (the CLI treats it as
   * non-fatal). Compiled-binary version-stamping is a separate Phase-3 line item.
   */
  import { readFileSync } from 'node:fs'
  import { fileURLToPath } from 'node:url'

  function readVersion(): string {
  	try {
  		const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  		return pkg.version ?? '0.0.0'
  	} catch {
  		return '0.0.0'
  	}
  }

  export const SERVER_VERSION: string = readVersion()
  ```

### Step 2 — Expose `app` on `SyncApp` (the read-only test seam)

- [ ] **`server/src/app.ts`** — two edits so the completeness test can introspect
  the router. First, add the field to the interface (the interface already
  returns `server`/`getOrCreateRoom` for tests):
  ```ts
  export interface SyncApp {
  	server: http.Server // not yet listening
  	getOrCreateRoom(roomId: string): TLSocketRoom
  	app: express.Express   // NEW — read-only test seam for route introspection
  }
  ```
  Then return it (the `app` local already exists at line 73):
  ```ts
  	return { server, getOrCreateRoom: roomHost.getOrCreateRoom, app }
  ```
  Nothing in production reads `app` off the return; it is used only by the
  completeness test. `bun run typecheck` stays green (an added field is
  backward-compatible; the extra return property is accepted).

### Step 3 — Write the failing completeness test

- [ ] **`server/src/tools-api.test.ts`**:
  ```ts
  // Bidirectional completeness: the /api/tools manifest and the booted app must
  // agree. Direction A — every declared verb is reachable (status !== 404).
  // Direction B — every mounted non-exempt /api route is declared. Boots the app
  // in-process on an ephemeral port (canvas-api.test.ts pattern).
  // Run with: bun src/tools-api.test.ts
  import assert from 'node:assert/strict'
  import { mkdtemp } from 'node:fs/promises'
  import os from 'node:os'
  import path from 'node:path'
  import { allTools } from '@ensembleworks/contracts'
  import { createSyncApp } from './app.ts'

  // Exempt predicate — the two kernel meta-routes (see spec "Exempt"). Every
  // other exempt thing (static, uploads, WS) is not an express `route` layer.
  const isExempt = (p: string) => p === '/api/health' || p === '/api/tools'

  async function main() {
  	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tools-api-test-'))
  	const { server, app } = createSyncApp({ dataDir })
  	await new Promise<void>((resolve) => server.listen(0, resolve))
  	const address = server.address()
  	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
  	const base = `http://127.0.0.1:${address.port}`

  	// --- Envelope --------------------------------------------------------------
  	const res = await fetch(`${base}/api/tools`)
  	assert.equal(res.status, 200, 'GET /api/tools should be 200')
  	const manifest = (await res.json()) as {
  		version: number
  		server: string
  		tools: Array<{ plugin: string; id: string; method: string; path: string }>
  	}
  	assert.equal(manifest.version, 1, 'manifest.version === 1')
  	assert.equal(manifest.tools.length, 15, 'manifest declares 15 tools')
  	assert.equal(typeof manifest.server, 'string', 'manifest.server is a string')

  	// --- Direction A: declared ⊆ mounted (every verb is reachable) -------------
  	for (const t of allTools) {
  		const r = await fetch(`${base}${t.http.path}`, {
  			method: t.http.method,
  			headers: t.http.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
  			body: t.http.method === 'POST' ? '{}' : undefined,
  		})
  		assert.notEqual(r.status, 404, `declared verb ${t.plugin}.${t.id} (${t.http.method} ${t.http.path}) must be mounted (got 404)`)
  	}

  	// --- Direction B: mounted ⊆ declared (no undeclared /api route) ------------
  	// Walk the express router stack, collecting every `route` layer's {method,path}.
  	const mounted = new Set<string>()
  	const walk = (stack: any[]) => {
  		for (const layer of stack) {
  			if (layer.route) {
  				const rp: string = layer.route.path
  				if (typeof rp === 'string' && rp.startsWith('/api') && !isExempt(rp)) {
  					for (const m of Object.keys(layer.route.methods ?? {})) {
  						if (layer.route.methods[m]) mounted.add(`${m.toUpperCase()} ${rp}`)
  					}
  				}
  			} else if (layer.handle?.stack) {
  				walk(layer.handle.stack)
  			}
  		}
  	}
  	walk((app as any).router?.stack ?? (app as any)._router?.stack ?? [])

  	const declared = new Set(allTools.map((t) => `${t.http.method} ${t.http.path}`))
  	// Every mounted non-exempt /api route is declared…
  	for (const m of mounted) assert.ok(declared.has(m), `mounted route not declared: ${m}`)
  	// …and every declared route is actually mounted (belt-and-braces with Dir A).
  	for (const d of declared) assert.ok(mounted.has(d), `declared route not mounted: ${d}`)
  	assert.equal(mounted.size, declared.size, 'mounted and declared /api route sets must match exactly')

  	server.close()
  	console.log(`ok: /api/tools manifest — envelope v1, 15 tools, ${mounted.size} routes match both directions`)
  }

  main().catch((err) => {
  	console.error(err)
  	process.exit(1)
  })
  ```

- [ ] **RED checkpoint — run it, expect failure (no `/api/tools` route yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/tools-api.test.ts)
  ```
  Expected: **fails** at the envelope assertion — `GET /api/tools` is not mounted
  yet, so it hits the SPA/404 path (`res.status` ≠ 200). This is the RED state
  (the exact "no /api/tools route" failure the spec calls for). Steps 4–5 make it
  green.

### Step 4 — `server/src/features/tools.ts` + mount it

- [ ] Create the router (verbatim from spec, `.ts` import extensions):
  ```ts
  // server/src/features/tools.ts
  // Kernel meta-route: GET /api/tools serves the tool manifest — the JSON-Schema
  // projection of the contracts tool registry. Read-only; static for the process
  // lifetime (the registry never changes at runtime). See slice 3b spec.
  import { allTools, buildManifest } from '@ensembleworks/contracts'
  import express from 'express'
  import { SERVER_VERSION } from '../version.ts'

  export function createToolsRouter(): express.Router {
  	const router = express.Router()
  	// Precompute once — the manifest is static for the process lifetime.
  	const manifest = buildManifest(allTools, SERVER_VERSION)
  	router.get('/api/tools', (_req, res) => res.json(manifest))
  	return router
  }
  ```

- [ ] **`server/src/app.ts`** — import and mount it kernel-side (after
  `createParticipantsRouter`, before `createAvRouter`). Add the import beside the
  other feature imports:
  ```ts
  import { createToolsRouter } from './features/tools.ts'
  ```
  Mount it:
  ```ts
  	app.use(createParticipantsRouter(ctx))   // kernel-reserved: /api/participants

  	app.use(createToolsRouter())             // kernel-reserved: GET /api/tools

  	app.use(createAvRouter(ctx))
  ```

### Step 5 — Path-source edits: each route imports its def's `http.path`

The drift anchor: every route's path string is sourced from its tool def, not a
second hand-typed literal. One-line-per-route change — handler bodies, their
registration calls and their behaviour are **identical**; only the path
*string's source* changes. The completeness test is the independent backstop.

- [ ] **`server/src/features/whoami.ts`** — import the def, use its path:
  ```ts
  import { kernelWhoami } from '@ensembleworks/contracts'
  ```
  `router.get('/api/whoami', …)` → `router.get(kernelWhoami.http.path, …)`.

- [ ] **`server/src/features/participants.ts`**:
  ```ts
  import { kernelParticipants } from '@ensembleworks/contracts'
  ```
  `router.get('/api/participants', …)` → `router.get(kernelParticipants.http.path, …)`.

- [ ] **`server/src/features/av.ts`**:
  ```ts
  import { avToken, avKick, avPulse } from '@ensembleworks/contracts'
  ```
  - `router.get('/api/av/token', …)` → `router.get(avToken.http.path, …)`
  - `router.post('/api/av/kick', …)` → `router.post(avKick.http.path, …)`
  - `router.post('/api/av/pulse', …)` → `router.post(avPulse.http.path, …)`

- [ ] **`server/src/features/terminal-status.ts`**:
  ```ts
  import { terminalStatus } from '@ensembleworks/contracts'
  ```
  `router.post('/api/terminal/status', …)` → `router.post(terminalStatus.http.path, …)`.
  (`isTerminalStatus` / `TERMINAL_STATUSES` imports stay.)

- [ ] **`server/src/features/sticky.ts`**:
  ```ts
  import { canvasSticky } from '@ensembleworks/contracts'
  ```
  `router.post('/api/canvas/sticky', …)` → `router.post(canvasSticky.http.path, …)`.

- [ ] **`server/src/features/shape.ts`**:
  ```ts
  import { canvasShape } from '@ensembleworks/contracts'
  ```
  `router.post('/api/canvas/shape', …)` → `router.post(canvasShape.http.path, …)`.

- [ ] **`server/src/features/frames.ts`**:
  ```ts
  import { canvasFrames, canvasFrame } from '@ensembleworks/contracts'
  ```
  - `router.get('/api/canvas/frames', …)` → `router.get(canvasFrames.http.path, …)`
  - `router.get('/api/canvas/frame', …)` → `router.get(canvasFrame.http.path, …)`

- [ ] **`server/src/features/transcript.ts`**:
  ```ts
  import { scribeSay, scribeTranscript } from '@ensembleworks/contracts'
  ```
  - `router.post('/api/scribe/transcript', …)` → `router.post(scribeSay.http.path, …)`
  - `router.get('/api/scribe/transcript', …)` → `router.get(scribeTranscript.http.path, …)`

- [ ] **`server/src/features/roadmap.ts`**:
  ```ts
  import { roadmapWrite, roadmapRead } from '@ensembleworks/contracts'
  ```
  - `router.get('/api/roadmap/doc', …)` → `router.get(roadmapRead.http.path, …)`
  - `router.post('/api/roadmap/doc', …)` → `router.post(roadmapWrite.http.path, …)`

  (`slugify` / `applyOps` / `OpError` imports stay; add `roadmapWrite`,
  `roadmapRead` to the existing `@ensembleworks/contracts` import line — it
  already imports `slugify` from there.)

- [ ] **`server/src/app.ts`** — the one locus exception (`terminal.list` is
  mounted inline, not in a feature router). Add to the import beside
  `createToolsRouter`:
  ```ts
  import { terminalList } from '@ensembleworks/contracts'
  ```
  Change the inline mount:
  ```ts
  	app.get(terminalList.http.path, gatewayPlane.listHandler)   // path from the tool def
  ```

### Step 6 — GREEN gate

- [ ] **Run the completeness test + the unit test + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd contracts && bun src/tools/tools.test.ts)
  (cd server && bun src/tools-api.test.ts)
  ```
  Expected: `bun run typecheck` exits 0; the unit test prints its `ok:` line;
  `tools-api.test.ts` prints
  `ok: /api/tools manifest — envelope v1, 15 tools, 15 routes match both directions`
  and exits 0.

- [ ] **Commit:**
  ```bash
  git add server/src/version.ts server/src/features/tools.ts server/src/app.ts \
    server/src/features/whoami.ts server/src/features/participants.ts \
    server/src/features/av.ts server/src/features/terminal-status.ts \
    server/src/features/sticky.ts server/src/features/shape.ts \
    server/src/features/frames.ts server/src/features/transcript.ts \
    server/src/features/roadmap.ts server/src/tools-api.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): serve GET /api/tools + bind routes to their tool defs

  createToolsRouter serves the buildManifest(allTools, SERVER_VERSION) envelope
  as a kernel-reserved meta-route. Every feature route now sources its path from
  its tool def (def.http.path) instead of a second literal — terminal.list's
  edit lands inline in app.ts. SyncApp exposes the express app as a read-only
  test seam. A bidirectional completeness test proves manifest and app agree in
  both directions. Handlers/payloads unchanged.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — Full gate: typecheck + full suite + build + manual smoke

- [ ] **Step 1: Full gate:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  ```
  Expected: typecheck 0; `bun run test` ends **`all 43 suites passed`** (41 + the
  two new suites: `contracts/src/tools/tools.test.ts` and
  `server/src/tools-api.test.ts`); `bun run build` 0. No existing suite changes
  (handlers and payloads are untouched).

- [ ] **Step 2: Manual smoke — proves the edge passes `/api/tools` un-mangled.**
  With `tmux` + `bash` available (see CLAUDE.md `bin/dev`):
  ```bash
  bin/dev up
  curl -s localhost:8080/api/tools | jq '.version, (.tools|length)'
  curl -s localhost:8080/api/tools | jq '.tools[] | select(.plugin=="canvas" and .id=="sticky") | .input'
  ```
  Expected: the first prints `1` then `15`; the second prints the sticky input
  JSON Schema (an `object` with `text` required, `room`/`frame`/`color`
  properties). `/api/tools` is a plain `/api` GET — no Caddy/Vite special-casing
  needed. Optionally spot-check a roadmap def:
  ```bash
  curl -s localhost:8080/api/tools | jq '.tools[] | select(.id=="write") | .input.properties.ops' >/dev/null
  ```

- [ ] **Step 3: Commit — nothing new to commit (the gate is verification):**
  ```bash
  git status   # expect clean
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all 43 suites passed` — and any deviation from the verbatim blocks above.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every spec component appears in a task.**
  - `contracts/src/tools/types.ts` (Task 2 Step 2, verbatim), `kernel.ts`
    (Step 3, verbatim), `canvas.ts` (Step 6, verbatim), `index.ts` (Step 9,
    verbatim), `buildManifest`/`toManifestEntry`/`ManifestEnvelope`
    (in types.ts).
  - `av.ts`, `terminal.ts`, `scribe.ts`, `roadmap.ts` (Steps 4/5/7/8) — the four
    the spec left in prose — are written out in full here, each transcribed
    field-for-field from its live handler (av.ts, terminal-status.ts +
    gateway-registry.ts `listHandler`, transcript.ts + transcript-store.ts,
    roadmap.ts + roadmap-store.ts). `terminal.status`'s zodInput is exactly
    `{ room, sessionId: z.string().min(1), status: z.enum(TERMINAL_STATUSES) }`;
    `terminal.list` is mounted in app.ts, not a feature router (locus exception,
    Task 3 Step 5).
  - `server/src/features/tools.ts` router (Task 3 Step 4, verbatim) + the app.ts
    mount + the `SyncApp` interface `app` field edit (Task 3 Steps 2, 4).
  - The `NOTE_COLORS`/`GEO_TYPES` relocation into contracts with server re-export
    (spec R4) is Task 1.
  - `SERVER_VERSION`/`version.ts` (Task 3 Step 1; the runtime-read deviation is
    flagged as a technical, non-product call).
  - The two test suites: contracts unit test (Task 2, RED→GREEN) and the
    bidirectional completeness test (Task 3, RED→GREEN). Suite count 41 → 43.
- **TDD ordering honoured.** Unit test written first and shown RED (no tools
  module), then defs to green (Task 2). Completeness test written and shown RED
  (no /api/tools route), then router + wiring + one-line path-source edits to
  green (Task 3). The `app` seam lands just before the test so it compiles; the
  RED is the intended "no /api/tools route" envelope failure.
- **Placeholder scan:** no "similar to canvas.ts" / "update as per spec"
  hand-waving remains — every def is written out in full, every edit names the
  exact file, exact old→new, and its gate command + expected output.
- **Type consistency:** the identifier names used in Task 3's imports
  (`kernelWhoami`, `kernelParticipants`, `avToken`, `avKick`, `avPulse`,
  `terminalStatus`, `terminalList`, `canvasSticky`, `canvasShape`,
  `canvasFrames`, `canvasFrame`, `scribeSay`, `scribeTranscript`,
  `roadmapWrite`, `roadmapRead`) are exactly the `export const` names defined in
  Task 2's plugin files; `allTools`/`buildManifest`/`MANIFEST_VERSION`/`HttpMethod`
  used by the tests are exported by `types.ts`/`index.ts`. `SERVER_VERSION` is
  the export consumed by `tools.ts`. The completeness test's exempt predicate
  (`/api/health`, `/api/tools`) matches the spec exactly, and the 15 declared
  `(method, path)` pairs match the 15 mounted non-exempt `/api` routes.
