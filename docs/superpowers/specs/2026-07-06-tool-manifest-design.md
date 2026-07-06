# Tool manifest — declare the verbs, serve `GET /api/tools`

**Phase 3, sub-project 3b.** Declare every existing non-exempt HTTP verb as a
typed tool definition in `contracts/src/tools/<plugin>.ts` and serve a machine-
readable manifest (`GET /api/tools`, a kernel route) describing them. This is the
manifest that slice #4 (the `ensembleworks` CLI) renders into verb groups, and
that Phase 4 later backs `/mcp` from.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`): §"Phase 4 — Registry + MCP"
pins the tool-definition shape (`contracts/src/tools/<plugin>.ts`, each verb
`{ id, zodInput, zodOutput, http: {method, path}, help }`; exempt list: health,
static, uploads binary, WS upgrades, `/mcp`) and the §"#4 — CLI" manifest-cache
contract (fetch on cache-miss + explicit `--refresh`). Design references:
`unified-architecture-design.md` §5 (one tool registry, three facades), §6.3 (the
CLI as generic manifest renderer), §7 (Phase 3 vs Phase 4 rows).

## Scope boundary — 3b is MANIFEST-ONLY

State this up front because it is the whole shape of the slice. 3b **declares**
the tool defs and **serves** a read-only manifest of the routes that already
exist. It does **not**:

- **re-mount routes through a registry.** Every route stays a hand-mounted
  express handler in its feature router (`server/src/features/*.ts`), mounted by
  `app.ts` exactly as today. The tool registry is a *description* of those
  routes, never their dispatcher.
- **build `/mcp`.** That is Phase 4. 3b adds only `GET /api/tools`.
- **change any route's behaviour, payload, status code, validation, or auth.**
  The handlers are untouched. Every existing suite stays green with zero
  functional edits.
- **generalise `docStore` / extract the rev-fan-out.** Phase 4. The roadmap route
  keeps its overloaded GET+POST handlers; the manifest simply describes them.
- **split overloaded routes into per-verb leaves.** 3a deliberately kept the two
  overloaded roadmap routes and delegated any per-verb split to Phase 4; 3b
  honours that — one tool def per `(method, path)` that exists today, not one per
  CLI sub-verb (see the CLI-mapping table).

What 3b *is*: the tool defs become the single typed home for "what verbs this
server exposes over HTTP", and `/api/tools` is their JSON-Schema projection. The
verbs are declared once; the express routes remain the source of truth for
behaviour, and a bidirectional completeness test binds the two so they cannot
drift.

## Background

`contracts/` is the single source of truth for wire shapes
(`unified-architecture-design.md` §1.5), and already ships Zod schemas
(`whoami.ts` uses `import { z } from 'zod'` — **Zod v4.4.3**, confirmed in
`bun.lock`; `z.toJSONSchema(schema)` produces draft-2020-12 JSON Schema natively,
verified against the installed version). But the **request/response** shapes of
the HTTP API live only as inline `req.body`/`req.query` reads inside each feature
router (`String(body.room ?? 'team')`, `typeof body.text === 'string'`, …). There
is no declared inventory of verbs, no schema an agent can discover, and nothing
for a CLI to render.

After 3a the routes sit cleanly under their plugin prefixes
(`/api/av/*`, `/api/canvas/*`, `/api/scribe/transcript`, `/api/roadmap/doc`,
`/api/terminal/{status,list}`, kernel `/api/{health,whoami,participants}`). That
clean surface is exactly what 3b enumerates.

Existing tool-adjacent assets to reuse rather than re-invent:

- `contracts/src/whoami.ts` — `whoamiSchema` (Zod) is the ready-made `zodOutput`
  for the `whoami` tool.
- `contracts/src/constants.ts` — `TERMINAL_STATUSES` (drives the `terminal.status`
  input enum).
- `server/src/canvas/constants.ts` — `NOTE_COLORS`, `GEO_TYPES` (drive the canvas
  tools' colour/geo enums). These live in `server/`, not `contracts/`; 3b needs
  them in a browser-safe contract. **Decision:** move `NOTE_COLORS` and
  `GEO_TYPES` into `contracts/src/constants.ts` (re-export from the server module
  so `sticky.ts`/`shape.ts` keep their current import path) — they are pure
  protocol-by-naming lists, exactly what §1.5 says contracts owns. This is the
  one small pre-existing constant that must relocate; everything else is new.

Everything else — the per-verb input schemas — is **written fresh** in Zod.
(Shape *prop* validators in `contracts/src/shapes.ts` use `@tldraw/validate` `T`,
not Zod, and describe CRDT records, not HTTP requests; they are not reusable as
tool inputs.)

## Goal

- `contracts/src/tools/` declares **15 tool defs** — one per non-exempt HTTP verb
  the `:8788` kernel app serves today — each
  `{ id, plugin, http: {method, path}, help, zodInput, zodOutput }`.
- `GET /api/tools` returns a versioned manifest envelope: the JSON-Schema
  projection of the registry, grouped-by-plugin-consumable, stdout-clean JSON.
- A **bidirectional completeness test** proves the manifest and the booted app
  agree: every declared `{method, path}` responds non-404, and every non-exempt
  `/api` route the app mounts is declared. Drift is a test failure.
- `bun run typecheck`, `bun run build`, `bun run test` green. **Suite count:
  41 → 43** (this slice adds exactly two suites; see Testing).

## The tool-def shape

The five fields `{id, zodInput, zodOutput, http: {method, path}, help}` are
charter-pinned; the sixth field `plugin` (and the manifest envelope below) are
a **charter extension ratified by the user 2026-07-06** — see the charter's
"Ratified extensions" section. Expressed as a TypeScript type in
`contracts/src/tools/types.ts`:

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
	/** The one HTTP route that backs this verb — the drift anchor (see below). */
	http: { method: HttpMethod; path: string }
	/** One-line help, rendered by `ensembleworks <plugin> <id> --help`. */
	help: string
	/** Request schema. GET/DELETE ⇒ query string; POST/PUT ⇒ JSON body
	 *  (the method fixes the location — see "Request mapping"). */
	zodInput: z.ZodType
	/** Success (2xx) response body. The error envelope `{ error: string }` is a
	 *  kernel-wide convention, documented once, not repeated per tool. */
	zodOutput: z.ZodType
}
```

### Request mapping — where `zodInput` binds (settled)

Every current route reads its parameters from exactly one place, keyed by method:
**GET/DELETE handlers read `req.query`; POST/PUT handlers read `req.body`.** No
route mixes the two for meaningful input (e.g. `room` arrives as a query param on
GET routes and as a body field on POST routes). So the method *is* the binding
rule; the tool def needs no separate `in:` discriminator, and `zodInput`
describes that single input object. (If Phase 4 ever adds a route reading both,
that slice adds an explicit `http.in` field then — 3b does not pre-build it.)

### Path source — the drift anchor (settled)

The tool def's `http.path` is the **single literal** for that route. To make that
real rather than aspirational, the feature router imports the path from its tool
def instead of hard-coding a second copy:

```ts
// server/src/features/sticky.ts
import { canvasSticky } from '@ensembleworks/contracts'
router.post(canvasSticky.http.path, async (req, res) => { /* handler unchanged */ })
```

This is a one-line-per-route edit, not a re-mount: the handler body, its
registration call, and its behaviour are identical — only the path *string's
source* changes from a bare literal to `tool.http.path`. It keeps the route
hand-mounted (scope boundary honoured) while killing the "two copies of
`/api/canvas/sticky`" drift class at compile time. **One locus exception:**
`terminal.list` is mounted inline in `app.ts`
(`app.get('/api/terminal/list', gatewayPlane.listHandler)`), not in a feature
router — its one-line edit is
`app.get(terminalList.http.path, gatewayPlane.listHandler)` in `app.ts`. The bidirectional completeness
test (Testing) is the independent backstop that catches any route still using a
raw literal or any declared path the app never mounts.

## The verb inventory (all 15)

Exhaustive. Every non-exempt HTTP verb the `:8788` sync app serves after 3a. The
`id` is the bare verb; global identity (and the future MCP tool name) is
`${plugin}.${id}`.

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

### Exempt (declared by no tool def) — and why

| Route | Exempt class (charter) |
|---|---|
| `GET /api/health` | health |
| `GET /api/tools` | meta-endpoint — the manifest itself; same class as `/mcp`. It is a new route this slice adds, so the completeness test exempts it explicitly (rationale below). |
| `GET /*` static + SPA fallback | static (express middleware, not a `route` layer — never appears in introspection) |
| `PUT/GET /uploads/:id` | uploads binary (top-level, non-`/api`) |
| WS `/sync/:roomId`, `/api/terminal/connect`, `/api/terminal/relay` | WS upgrades (handled in `server.on('upgrade')`, not express routes) |
| `:8789` local plane: `/api/terminal/{health,sessions,ws}` | separate process — not served by the kernel that hosts `/api/tools`; `health`/`ws` are already exempt classes, and GET/DELETE `sessions` are relay-splice **infrastructure** consumed by the connector, not an agent tool. 3b's manifest scopes to the `:8788` kernel app. |
| `/mcp` | Phase 4 — does not exist yet |

**`/api/tools` exemption is a settled technical call, not a product decision.**
The charter's exempt list names `/mcp` (the *other* agent-gateway meta-route) but
predates `/api/tools` existing; a manifest that lists itself as a tool is
degenerate. Exempting the meta-endpoint is the faithful reading, and it is called
out here so the completeness test's exempt predicate is auditable.

**`kernel.whoami` / `kernel.participants` ARE declared — deliberately.** The
charter's exempt list is closed (health, static, uploads, WS, `/mcp`); whoami and
participants are non-exempt `/api` routes, so declaring them is the literal
charter reading and matches the task's "every non-exempt HTTP route" rule.
Grouping them under a `kernel` pseudo-plugin (a `contracts/src/tools/kernel.ts`)
is the natural extension of the per-plugin file convention to kernel-owned
routes — a technical grouping, not a new product surface. Note that the CLI's
native `auth status` (design §6.3 layer 3) will call `/api/whoami` directly;
`whoami` *also* appearing as a manifest verb is additive and harmless (an
`ensembleworks kernel whoami` read verb), and removes nothing. If the user later
wants whoami/participants out of the manifest, that is a one-line charter
amendment (add them to the exempt list) — flagged, not blocking.

## CLI verb mapping (what slice #4 renders onto these tools)

The manifest declares one tool per HTTP `(method, path)`. `bin/canvas`'s verb
surface — which #4 must reproduce 1:1 — maps onto them, several CLI verbs
collapsing onto the overloaded roadmap/scribe routes. This table is
informational (it belongs to #4's renderer), included so the reader can confirm
the manifest covers the whole `bin/canvas` surface:

| `bin/canvas` verb | manifest tool | note |
|---|---|---|
| `status <id> <s>` | `terminal.status` | |
| `sticky <text>` | `canvas.sticky` | |
| `frames` | `canvas.frames` | |
| `read <frame>` | `canvas.frame` | |
| `pull-images <frame>` | `canvas.frame` **(no own tool)** | CLI-composite: reads `canvas.frame`, then GETs the `/uploads/*` urls from the response (exempt binary). Not an HTTP verb of its own. |
| `transcript` | `scribe.transcript` | |
| `say <text>` | `scribe.say` | |
| `shape <json>` | `canvas.shape` | |
| `roadmap list` | `roadmap.read` | GET, no `name` |
| `roadmap read <name>` | `roadmap.read` | GET, with `name` |
| `roadmap push <name> <file>` | `roadmap.write` | POST, a `replace` op batch |
| `roadmap ops <name> <ops>` | `roadmap.write` | POST, an ops batch |

`pull-images` is the one CLI verb with no backing tool — correctly so, since it
is a client-side download loop over `/uploads` (exempt), not a server verb. Every
other `bin/canvas` verb resolves to a declared tool.

## The manifest envelope

Charter extension, ratified by the user 2026-07-06 (charter "Ratified
extensions" section).

```
GET /api/tools  →  200 application/json
{
  "version": 1,              // manifest FORMAT version (integer). Bumped only when
                             //   the envelope shape changes; the CLI cache keys on it.
  "server": "0.10.0",        // server build version — informational, for
                             //   `ensembleworks version`'s "connected server" line.
  "tools": [
    {
      "plugin": "canvas",
      "id": "sticky",
      "method": "POST",
      "path": "/api/canvas/sticky",
      "help": "Post a sticky note, optionally parented to a fuzzy-matched frame.",
      "input":  { "$schema": "…/2020-12/schema", "type": "object", "properties": { … }, "required": [ … ] },
      "output": { "$schema": "…", "type": "object", … }
    },
    …
  ]
}
```

Settled envelope decisions:

- **Flat `tools` array with a `plugin` field**, not an object keyed by plugin. A
  flat list is what a future MCP `tools/list` returns, the CLI groups by `plugin`
  client-side (§6.3 "verb groups"), and it is the simplest thing to iterate. `id`
  stays the bare verb (charter shape); `plugin` + `id` give global identity.
- **`version: 1`** is the *format* version — the field the CLI's manifest cache
  keys on to invalidate a stale-shaped cache (§"#4" cache-on-miss contract). It
  is distinct from `server` (the build string).
- **`server`** is informational. Sourcing: 3b reads the root `package.json`
  version under source-run (a tiny `server/src/version.ts` importing the JSON);
  compiled-binary version-stamping is already a Phase-3 build line-item on the
  server-runtime slice, so 3b does not solve it — the field is soft and its
  absence/`"0.0.0"` is non-fatal to the CLI.
- **`input`/`output` are JSON Schema**, produced by `z.toJSONSchema(zodInput)` /
  `z.toJSONSchema(zodOutput)` (Zod v4 native, draft-2020-12). This is the export
  §1.5 and §5 call for and what Phase-4 MCP tool defs regenerate from.
- **Stdout-clean JSON**, no narration — consistent with the agent-first surface.

## Code layout

```
contracts/src/tools/
  types.ts       # ToolDef, HttpMethod, toManifestEntry(), ManifestEnvelope
  kernel.ts      # whoami, participants
  av.ts          # token, kick, pulse
  terminal.ts    # status, list
  canvas.ts      # sticky, shape, frames, frame
  scribe.ts      # say, transcript
  roadmap.ts     # write, read
  index.ts       # allTools: ToolDef[]  — the registry
```

`contracts/src/index.ts` gains `export * from './tools/index.js'` (barrel; the
`.js`-extension convention this package uses). Server-side, a new
`server/src/features/tools.ts` mounts `GET /api/tools`.

### `contracts/src/tools/types.ts`

```ts
import { z } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ToolDef {
	id: string
	plugin: 'kernel' | 'av' | 'canvas' | 'scribe' | 'roadmap' | 'terminal'
	http: { method: HttpMethod; path: string }
	help: string
	zodInput: z.ZodType
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

### `contracts/src/tools/canvas.ts` (the fully-worked plugin)

Every field mirrors the handler **as it exists today** — `room` defaults to
`'team'`, `text` is 1–2000 chars, `color` is the `NOTE_COLORS` enum, etc. The
schemas are read straight off `sticky.ts` / `shape.ts` / `frames.ts`.

```ts
import { z } from 'zod'
import { NOTE_COLORS, GEO_TYPES } from '../constants.js'   // relocated per Background
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

### `contracts/src/tools/kernel.ts` (reusing an existing schema)

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

`av.ts`, `terminal.ts`, `scribe.ts`, `roadmap.ts` follow the same pattern
(`token` reads the `av.ts` query params: `room`, `identity`, `name`,
`role: z.enum(['member','scribe']).default('member')`; `terminal.status`'s
zodInput is `z.object({ room, sessionId: z.string().min(1), status:
z.enum(TERMINAL_STATUSES) })` — the handler requires a non-empty `sessionId`
alongside the enum, and the def must carry both; `roadmap.write` mirrors the
`name`/`ops`/`ifRev` body; etc.). Each router imports its def and mounts
`router.<method>(def.http.path, …)` — except `terminal.list`, whose edit lands
in `app.ts` (see "Path source" above).

### `contracts/src/tools/index.ts`

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

### `server/src/features/tools.ts` + `app.ts` wiring

```ts
// server/src/features/tools.ts
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

`app.ts` mounts it beside the other kernel routes (after whoami/participants,
before the plugin routers) and — for the completeness test — exposes the express
`app` on the returned `SyncApp`:

```ts
app.use(createWhoamiRouter())
app.use(createParticipantsRouter(ctx))
app.use(createToolsRouter())          // kernel-reserved: GET /api/tools
app.use(createAvRouter(ctx))
// …
return { server, getOrCreateRoom: roomHost.getOrCreateRoom, app }   // app added for tests
```

The corresponding type edit is load-bearing for the test to compile —
`interface SyncApp` in `app.ts` gains the field:

```ts
export interface SyncApp {
	server: http.Server
	getOrCreateRoom: (roomId: string) => Promise<...>   // unchanged
	app: express.Express   // NEW — read-only test seam for route introspection
}
```

Exposing `app` is a minimal testing seam (the interface already returns `server`
and `getOrCreateRoom` for tests). It is read-only and used only by the
completeness test's route introspection — nothing in production reads it.

## Data flow

```
agent / CLI (#4)                          server (:8788 kernel)
────────────────                          ─────────────────────
GET /api/tools  ───────────────────────►  createToolsRouter → buildManifest(allTools)
                                            → z.toJSONSchema per verb → { version, server, tools[] }
  ◄──────────────── stdout-clean JSON ────
CLI caches on miss, renders verb groups,
validates argv against each tool's input
schema, then calls the real route:
POST /api/canvas/sticky {room,text,…}  ──► features/sticky.ts (handler UNCHANGED;
                                            path == canvasSticky.http.path)
```

The manifest never dispatches — it only describes. The route a verb points at is
the same hand-mounted express handler that served it before 3b.

## Testing

**Suite count: 41 → 43.** This slice adds exactly two `*.test.ts` suites
(discovered by `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob), each ending
`console.log('ok: …')` per the house convention. No existing suite changes
(handlers and payloads are untouched).

### 1. `contracts/src/tools/tools.test.ts` — registry unit test (no server boot)

Pure, contracts-level. Asserts the *shape* of the registry:

- `allTools.length === 15`.
- Every def has non-empty `id`, a valid `plugin`, a `help` string, and an
  `http.method` ∈ the four methods.
- **`(plugin, id)` pairs are unique**, and **`(method, path)` pairs are unique**
  (two verbs may share a path only across different methods — the scribe and
  roadmap GET/POST overloads; assert no `(method, path)` collision).
- `z.toJSONSchema(zodInput)` and `z.toJSONSchema(zodOutput)` **succeed** for every
  def (this is the guard that catches an un-serialisable schema, e.g. a
  `z.custom()` with no JSON-Schema mapping, before it reaches the wire).
- `buildManifest(allTools, '0.0.0')` returns `version === MANIFEST_VERSION` and a
  `tools` array of length 15.

### 2. `server/src/tools-api.test.ts` — bidirectional completeness (boots the app)

Boots `createSyncApp({ dataDir })` on an ephemeral port (the standard pattern
from `canvas-api.test.ts`) and proves the manifest and the live app agree.
Introspection mechanism (verified against express 5.x under Bun 1.3.14): walk
`app.router.stack` recursively, collecting every `route` layer's
`{ method, path }`. WS upgrades and static/SPA middleware are not `route` layers,
so they are naturally excluded; only `/uploads/:id` and the two kernel meta-routes
need explicit exemption.

- **Envelope:** `GET /api/tools` → 200, body parses, `version === 1`, `tools`
  length 15, `server` is a string.
- **Direction A — every declared verb is reachable (declared ⊆ mounted).** For
  each tool def, fire a real request at `http://127.0.0.1:<port><path>` with the
  declared method (empty/minimal input — a `400 bad request` is fine; the
  assertion is **status !== 404**, i.e. the route exists and is wired). This
  catches a typo'd path or a verb whose route was never mounted.
- **Direction B — every mounted non-exempt `/api` route is declared
  (mounted ⊆ declared).** Collect `app.router.stack` route layers; keep those
  whose `path` starts with `/api`, excluding the exempt predicate
  `path === '/api/health' || path === '/api/tools'`. Assert this set equals the
  declared `{method, path}` set exactly. This catches a *new* route added to a
  feature router without a matching tool def — the drift that would otherwise let
  the manifest silently under-report the surface.

The two directions together are the anti-drift guarantee the scope boundary
leans on: the manifest is a *description* of the routes, and the test fails the
build the moment the description and the routes diverge in either direction.

### Manual smoke

`bin/dev up`, then `curl -s localhost:8080/api/tools | jq '.version, (.tools|length)'`
→ `1`, `15`; `jq '.tools[] | select(.plugin=="canvas" and .id=="sticky") | .input'`
shows the sticky JSON Schema. Confirms the edge passes `/api/tools` through
un-mangled (it is a plain `/api` GET — no Caddy/Vite special-casing needed).

## Risks

- **R1 — schema drift from handler reality.** A tool's `zodInput` could describe a
  field the handler doesn't read (or miss one it does). 3b's mitigation is scope:
  the schemas are transcribed field-for-field from the current handlers, and
  Direction-A sends real requests so a wildly wrong schema surfaces as unexpected
  4xx during review. Exhaustive input-validation *enforcement* (the server
  rejecting on `zodInput`) is **not** in 3b — handlers keep their own inline
  checks; the manifest only *describes*. Wiring `zodInput` as the actual request
  validator is a Phase-4 registry concern.
- **R2 — `z.toJSONSchema` on an exotic schema.** A future def using a Zod
  construct with no JSON-Schema projection would throw at manifest-build time. The
  unit test's per-def `toJSONSchema` assertion catches it at author time, before
  it can 500 `/api/tools`.
- **R3 — express-internal introspection brittleness.** Direction B reads
  `app.router.stack`, an express internal. Verified working on express 5.x under
  Bun (route layers expose `.route.path` / `.route.methods`). If a future express
  upgrade changes the stack shape, Direction B breaks loudly (a test failure, not
  a silent gap) and Direction A still independently guarantees declared⊆mounted.
- **R4 — the `NOTE_COLORS`/`GEO_TYPES` relocation.** Moving them to `contracts/`
  and re-exporting from `server/src/canvas/constants.ts` must keep `sticky.ts` /
  `shape.ts` compiling unchanged. Mitigation: re-export preserves the import path;
  `bun run typecheck` proves it; no behaviour change (same array values).
- **R5 — `body.author` (sub-project 3c) coordination.** 3c-enforcement adds an
  optional `body.author` field to the mutating canvas routes (sticky/shape/roadmap
  write). The tool def travels *with* the route: whichever of 3b/3c-enforcement
  lands second adds/omits `author` in the affected `zodInput` as part of its own
  change — the def always mirrors the live handler. 3b, matching today's handlers
  (which do **not** read `body.author`), declares no `author` field; this is
  correct-for-now and explicitly not speculative.
