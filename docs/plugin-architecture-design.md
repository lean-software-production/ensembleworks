# Plugin architecture — kernel, capability registries, and project memory

- **Status:** Proposed (design, no implementation yet)
- **Date:** 2026-07-03
- **Motivation:** Rearchitect EnsembleWorks into a small core of "building
  block" components that can be extended and customised via config and
  plugins for specialist workflows — without giving up the properties that
  make the current system good (two-planes separation, one-box backup unity,
  the tmux/sandbox terminal model, the agent-first HTTP surface).
- **Companion docs:**
  - Reference architecture & seam table: [`architecture-spec.md`](./architecture-spec.md)
  - Canvas engine question: [`tldraw-replacement-analysis.md`](./tldraw-replacement-analysis.md)
  - Terminal fleet direction: [`distributed-terminals-design.md`](./distributed-terminals-design.md)
  - Deploy posture: [`deploy-orchestration-options.md`](./deploy-orchestration-options.md)

## Context

EnsembleWorks today is three npm workspaces (`client`, `server`,
`transcriber`) plus `bin/canvas` and the deploy scripts. The feature
*folders* are already well-separated — the pure logic (`terminal/grid.ts`,
`av/spatial.ts`, `screenshare/resolve.ts`, `roadmap/model.ts`, the VAD
segmenter) is dependency-free and unit-tested. The monolith is entirely in
the **wiring**:

- **Closed registries.** Adding a shape means editing `client/src/App.tsx`
  (shape-util list), `client/src/ui.tsx` (factory + tool + toolbar line +
  icon), `server/src/schema.ts` (validators), and usually
  `server/src/app.ts` (feature routes). Four files, two workspaces, per
  feature.
- **`server/src/app.ts` is a ~1,300-line closure** — room lifecycle, LiveKit
  tokens, kick, pulse, transcript stamping, sticky/shape/frame CRUD,
  roadmap, uploads and static serving all share module-level maps. No
  per-feature router.
- **No shared contracts.** Every wire shape exists 3–4 times, held together
  by "Keep in sync with…" comments: shape props (client `ShapeUtil` ↔ server
  schema), roadmap op semantics, terminal grid clamps, the terminal WS
  protocol (defined in a comment), and `bin/canvas` re-encoding JSON in
  bash.
- **Type-string switches in core code:** the terminal delete-veto in
  `App.tsx`, `record.type === 'screenshare'` store scans, `/api/frame`
  enumerating child shape types by literal.
- **Bespoke instances of a general pattern.** "Write to a server-side store,
  bump a `rev`/`status` prop on the shape so clients refetch" is implemented
  twice (roadmap, terminal status light), inline in `app.ts`.
- **`AvOverlay.tsx` (~1,300 lines)** owns the 150 ms cadence, so the
  screenshare subscription loop lives inside the A/V roster component just
  to borrow its timer.

Two invariants from `architecture-spec.md` are declared **non-seams** and
must be preserved by any redesign:

1. **Two-planes separation** — the CRDT canvas document holds only small
   references (a `sessionId`, a `trackName`, a `roadmapId + rev`); heavy
   content (terminal bytes, media, roadmap docs, transcripts) flows on its
   own channels.
2. **Identity coupling** — tldraw presence userId == LiveKit identity ==
   transcript speaker. It is what makes spatial audio, cursor leashes and
   place-stamped transcripts work.

---

## 1. Target architecture: small kernel + capability registries + plugin packages

```
┌─────────────────────────── plugins (one package each) ───────────────────────────┐
│  terminal   screenshare   shared-browser   roadmap   iframe   scribe   sessions  │
│  each = manifest + optional {client, server, worker, tools, contracts} entries   │
└──────┬─────────────┬──────────────┬─────────────┬───────────────┬────────────────┘
       │ client SPI  │ server SPI   │ storage SPI │ tools SPI     │ worker SPI
┌──────┴─────────────┴──────────────┴─────────────┴───────────────┴────────────────┐
│                                   KERNEL                                          │
│  Canvas host      — sync engine, schema assembly, room lifecycle, undo            │
│  Identity/presence— the one home for userId/colour/`user:`-prefix rules           │
│  Media service    — LiveKit room, token minting, track pub/sub policy hooks       │
│  Doc-store service— external docs + rev fan-out (generalised from roadmap)        │
│  Memory service   — ingest, index and search project context (§4)                 │
│  Scheduler        — the 150 ms / 30 s cadences as a service                       │
│  Agent gateway    — HTTP API + generated CLI + generated MCP server (§5)          │
└───────────────────────────────────────────────────────────────────────────────────┘
                     @ensembleworks/contracts  (single source of truth)
```

The kernel is deliberately boring: room + document + identity + media +
storage + memory + scheduling. **Everything users see is a plugin** —
including the five existing shapes. The acid test: terminal, screenshare,
neko, roadmap and iframe must each be expressible as a plugin package with
zero edits to kernel files. (The neko PoC already demonstrated the target
granularity — "three registrations + one module" to remove; the plugin
system makes those registrations declarative.)

### 1.1 The plugin manifest

A plugin is an npm workspace package exporting a manifest:

```ts
// packages/plugin-terminal/src/index.ts
import { definePlugin } from '@ensembleworks/plugin-api'

export default definePlugin({
  id: 'terminal',
  shapes: [terminalShapeSpec],       // props schema (Zod) + migrations — ONE definition
  client: () => import('./client'),  // ShapeUtil, toolbar item, icon, editor side-effects
  server: () => import('./server'),  // route mounter, room hooks, doc stores
  tools: terminalTools,              // typed verbs → HTTP + CLI + MCP (§5)
  worker: undefined,                 // the scribe uses this slot; terminal doesn't
})
```

### 1.2 Extension points

Each extension point directly generalises something that exists today:

| Extension point | Replaces |
|---|---|
| `shapes[]` — schema + migrations in the shared spec; client `ShapeUtil` and server validators derived from it | Hand-synced `schema.ts` ↔ `ShapeUtil` pairs |
| `toolbar[]` / `menu[]` — declarative tool entries with factory fns | Per-feature lines in `ui.tsx` |
| `routes(router, ctx)` — plugin mounts a sub-router under `/api/<plugin>/` with a capability context | Inline route blocks in `app.ts` |
| `roomHooks` — `onShapeDelete` (veto-able), `onUserJoin/Leave`, `onShapeChange(type, fn)` | Terminal delete-veto in `App.tsx`, screenshare after-delete, kick plumbing |
| `docStore(name, schema)` — versioned server-side JSON doc, atomic op batches, `ifRev` concurrency, **automatic rev fan-out to shapes referencing it** | Roadmap store + terminal status-light fan-out, unified |
| `scheduler.every(ms, fn)` | Loops squatting inside `AvOverlay` and `useSessionPulse` |
| `mediaHooks` — publish/subscribe policy, track naming, per-peer gain hook | Spatial audio and viewport-scoped screenshare subscription become *policies plugged into* the media service |
| `tools` — verbs declared once with Zod input/output schemas, exposed via HTTP, the `canvas` CLI **and** MCP (§5) | Hand-written bash subcommands in `bin/canvas` |
| `memoryHooks` — ingestion transforms/tags for the plugin's own content (§4) | (new) |

### 1.3 The capability context

Plugin server code never touches `TLSocketRoom` (or its successor)
directly. It receives:

```ts
interface PluginServerContext {
  canvas:   { getShapes(room, type), updateShape, createShape, findFrames, ... }
  presence: { participants(room), nearestCursor(room, point), identityOf(userId) }
  media:    { mintToken(room, identity, grants), removeParticipant }
  storage:  { docs: DocStore, blobs: BlobStore, appendLog: LogStore }
  memory:   { search(query, filters), ingest(items) }
  config:   PluginConfig   // from deployment config, validated by the plugin's schema
}
```

This one interface does three jobs: it quarantines the unstable
`room.getPresenceRecords?.()` dependency inside the presence service; it is
the seam that keeps the sync engine swappable (the
`tldraw-replacement-analysis.md` question); and it makes plugin server code
testable in isolation.

### 1.4 Deliberate non-goals

- **No client-side editor abstraction layer.** The terminal shape needs
  live zoom subscription, editing-focus handoff, batched undo and
  programmatic move — wrapping that surface would be a huge, leaky adapter.
  Plugins ship tldraw-native `ShapeUtil`s and keep their logic in pure
  modules (already the house style). If the Yjs/Hocuspocus migration
  happens, client `ShapeUtil`s are rewritten once against the new editor;
  the plugin structure, contracts, server code, workers and tools survive
  untouched. The plugin architecture is what makes that migration
  tractable, not a substitute for it.
- **No runtime dynamic plugin loading.** Composition is build-time: an
  `ensembleworks.config.ts` lists enabled plugins and is consumed by both
  the Vite build and the server boot. Full type safety, tree-shaking, one
  artifact per deployment flavour. "Specialist workflows" are **deployment
  profiles**: the same repo builds a mob-programming room (terminal +
  screenshare + roadmap) or a workshop room (sessions + minutes +
  conversation-map) from config.

### 1.5 Contracts as the spine

`@ensembleworks/contracts` (aggregating per-plugin contract entries):

- **Zod schemas** for every shape's props, every HTTP request/response, the
  terminal WS protocol, transcript entries, roadmap ops, memory queries.
  TypeScript types are inferred; the server validates with the same object
  the client types against. Deletes every "Keep in sync" comment.
- **JSON Schema export** (native to Zod) for non-TypeScript consumers —
  this is also what the MCP tool definitions are generated from (§5).
- **One home for the conventions that are currently protocol-by-naming:**
  the `canvas-` prefixes (tmux + LiveKit room names), `user:`-prefix
  stripping, `TERMINAL_STATUSES`, grid clamps, spatial-audio distances.

---

## 2. Component / language recommendations

| Component | Recommendation | Reasoning |
|---|---|---|
| Contracts + plugin API | **TypeScript + Zod** | The design hinges on client/server/CLI/MCP sharing one schema object. |
| Client | **TypeScript + React** (keep) | tldraw, LiveKit client and xterm.js are all TS-first. Keep tldraw for now; the Yjs+Hocuspocus question stays open behind the `canvas` capability seam. |
| Sync server / kernel | **TypeScript on Node** (keep, restructure) | Must execute the shared shape schemas and (if migrated) host a headless `Y.Doc` — both TS-native. A Go/Rust rewrite would force contract duplication back in. Express 5 + per-plugin routers is fine at this scale. |
| Terminal gateway | **Go** — when the distributed-terminals design is executed; keep Node until then | The fleet design wants the same gateway on every host: a single static binary with `creack/pty` and goroutine-per-viewer fan-out beats installing Node + node-pty on gVisor VMs / remote boxes. The WS protocol is five message types and already language-neutral. |
| Transcriber / workers | **TypeScript** (keep); **Python sanctioned for ML-heavy workers** | Today's pipeline (LiveKit → VAD → hosted Whisper) is fine in TS. Local Whisper / diarisation / embedding models live in Python. The worker SPI is therefore **process-level** (env in, HTTP/LiveKit out — exactly the scribe's current contract), not in-process, so worker plugins can be any language. |
| Agent CLI (`canvas`) | **TypeScript, generated from contracts**, compiled to a single file (`bun build --compile` or Node SEA), installed by `deploy.sh` as the bash script is today | 400 lines of bash with hand-rolled JSON escaping is the most fragile contract consumer in the repo, and it is the interface resident agents live on. Generation means the agent surface can never drift from the server again. |
| Memory store | **SQLite** (FTS5 + sqlite-vec) — see §4 | |
| Edge / infra | **Keep Caddy + systemd + Cloudflare Tunnel/Access; keep `deploy.sh`** | Per `deploy-orchestration-options.md` — k8s fights the tmux/sudo sandbox model. Plugin config slots into the existing `~/.config/ensembleworks/*.env` pattern plus `ensembleworks.config.ts`. |

---

## 3. Existing features re-expressed as plugins

| Plugin | shapes | server | worker | tools | Notes |
|---|---|---|---|---|---|
| `terminal` | `terminal` | gateway registration, status docStore | — | `status` | Delete-veto via `roomHooks.onShapeDelete` |
| `screenshare` | `screenshare` | — | — | — | Subscription loop via `scheduler` + `mediaHooks`; tombstone stills via `storage.blobs` |
| `shared-browser` | `neko` | health probe | — | — | Opt-in via deployment profile (replaces `SHARED_BROWSER=1`) |
| `roadmap` | `roadmap` | `docStore('roadmap', …)` | — | `roadmap list/read/push/ops` | The house template for plugin-owned content |
| `iframe` | `iframe` | — | — | — | Paste-URL interceptor via a client hook |
| `scribe` | — | transcript routes | LiveKit→STT worker | `transcript`, `say` | Transcript store feeds memory ingestion (§4) |
| `stickies/frames` | (default shapes) | sticky/shape/frame routes | — | `sticky`, `shape`, `frames`, `read`, `pull-images` | The core agent read/write surface |
| `sessions` | — | — | — | — | Seed layouts (demo, Liberating Structures) as client menu entries |
| `av` | — | token/kick/pulse routes | — | — | Spatial gain as a `mediaHooks` policy; roster UI stays a client module |

`AvOverlay` is dismembered in the process: roster, faces rail, transcript
modal, colour picker and VM stats become separate client modules; the two
polling loops move to the scheduler.

---

## 4. Project memory — a kernel service

### 4.1 Purpose

Ingest "messy" project context — transcripts, canvas shapes and stickies,
roadmap ops, frame snapshots, uploads — process, tag and index it, and
expose search for later agentic retrieval ("what did we decide about the
gateway port and where is it on the canvas?").

Memory is a **kernel service, not a plugin**, because its point is to be
fed by *every* plugin and queried by *every* agent.

### 4.2 Data store decision: SQLite

**Decision: SQLite — a dedicated memory database per room
(`DATA_DIR/memory/<room>.sqlite`) with FTS5 + sqlite-vec, behind a
`MemoryStore` interface. Postgres is a named seam, not a component.**

Why SQLite wins here:

- **The workload fits.** Ingestion is append-heavy, single-writer,
  read-many — WAL-mode SQLite's sweet spot. Even heavy use lands at
  hundreds of thousands to low millions of chunks over years. Small data.
- **Postgres breaks three deliberate deployment properties:**
  1. **Backup unity** — today one filesystem backup of `DATA_DIR`/home
     captures the instance (`canvas-on-cloudflare-design.md` lists losing
     this as a con of that proposal too). Postgres reintroduces `pg_dump`
     schedules and restore drills.
  2. **The inverted memory policy** (`memory-resource-policy.md`) — a
     resident Postgres taxes the headroom reserved for agent terminals.
  3. **Bootstrap simplicity** — a new host-provisioned service with
     credentials, initdb and migrations, owned ambiguously between this
     repo and laingville. Every reason k8s was rejected, in miniature.
- **Embedded covers both search modes:**

  | Need | SQLite answer |
  |---|---|
  | Lexical/keyword search | FTS5 — BM25 ranking, prefix/phrase queries |
  | Semantic/vector search | sqlite-vec — brute-force KNN, fine to ~1M vectors, int8/bit quantisation |
  | Tags/entities/provenance | Relational tables + JSON1 |
  | Transactional ingest | WAL mode, one writer process |

  At ~300k chunks × 1024-dim float32 (~1.2 GB, low-hundreds-of-ms per
  brute-force query; a quarter of that with int8 quantisation) there is no
  need for an ANN index. pgvector's HNSW starts mattering in the many
  millions, which a team room won't reach.

Constraints designed around:

- SQLite is single-writer-per-database → memory gets **its own DB files,
  separate from the room sync SQLite**. The ingestion worker is the sole
  writer; the API server opens read-only. Per-room files keep the
  backup/deletion story trivial ("forget this room" = delete one file).
- **Postgres triggers** (revisit if any occur): multiple VMs needing one
  shared memory, cross-room analytics with heavy joins at real volume, tens
  of millions of vectors, or adopting Postgres for another core need.
  `MemoryStore` is an interface and both stores speak SQL — migration is a
  data copy, not a redesign.
- **Ruled out:** a separate vector service (Qdrant/typesense — a new daemon
  for no gain at this scale), DuckDB (analytics-shaped, wrong for
  transactional ingest), LanceDB (plausible, but a second storage idiom
  when FTS5 + sqlite-vec covers both modes in one file).

### 4.3 Pipeline

```
sources (kernel hooks)             processing worker               retrieval
──────────────────────            ──────────────────             ─────────────────────
transcript appends        ──┐     chunk → tag/extract   ──┐      memory.search tool:
shape/sticky changes      ──┼──►  (LLM) → embed         ──┼──►     GET /api/memory/search
docStore op batches       ──┤     (OpenAI-compatible     ──┘        canvas memory search …
frame snapshots, uploads  ──┘      embeddings API)                  MCP tool (§5)
                                   │                                ctx.memory (plugins)
                             memory/<room>.sqlite
                             docs · chunks(FTS5) · vectors(sqlite-vec) · tags · provenance
```

- **Ingestion is event-driven, not scrape-based.** The memory service
  subscribes to the same `roomHooks`/`docStore` events plugins use, so
  plugins get ingestion for free by existing. Plugins may register
  `memoryHooks` to shape how their content is chunked/tagged. A backfill
  command handles historical JSONL/SQLite files.
- **Processing runs in a worker process** (the process-level worker SPI —
  same contract as the scribe). Tagging/entity extraction and summarisation
  are LLM calls; embeddings via any OpenAI-compatible endpoint, mirroring
  the STT pattern: `MEMORY_EMBED_URL`, `MEMORY_EMBED_MODEL`,
  `MEMORY_EMBED_API_KEY`. The worker could later be Python (local models)
  without touching the store.
- **Hybrid retrieval, fused.** FTS5 (BM25) and sqlite-vec (cosine) run in
  parallel, merged with reciprocal-rank fusion, filtered by tags / time /
  source / frame. Lexical search is not garnish: agents issue many
  exact-term queries ("gateway port 8789") where BM25 beats embeddings.
- **Provenance is the product.** Every result carries pointers back into
  the living system: transcript entry ids, shape ids, frame names,
  timestamps, deep links (`?d=…`). The transcript store's existing spatial
  frame-stamp is the natural join key — this is memory *of the canvas*, not
  a generic RAG bolt-on. A retrieving agent should be able to follow a
  result with `canvas read <frame>`.

### 4.4 Schema sketch

```
docs      (id, room, source, source_id, t, title, meta_json)
chunks    (id, doc_id, seq, text)             -- + chunks_fts (FTS5, content=chunks)
vectors   (chunk_id, embedding)               -- sqlite-vec virtual table
tags      (chunk_id, kind, value)             -- kind: entity|topic|decision|action|person
prov      (chunk_id, shape_id?, frame_name?, transcript_id?, t)
```

---

## 5. Agent access: HTTP + generated CLI + generated MCP

### 5.1 Decision: one tool registry, three generated facades

MCP is **not a substitution for the `canvas` CLI** — the two serve
different consumers, and replacing either with the other would be a
mistake. Plugins declare `tools` once — verbs with Zod input/output
schemas — and the agent gateway derives:

1. **HTTP routes** (`/api/…`) — the source of truth, as today.
2. **The `canvas` CLI** — for resident agents (§5.2).
3. **An MCP server (Streamable HTTP) at `/mcp`** — for external agentic
   systems (§5.3).

The three surfaces can never drift from each other because they *are* each
other: the MCP tool definitions are generated from the same Zod schemas
(Zod exports JSON Schema natively, which is exactly what MCP tools
consume). This also removes the temptation to hand external systems raw
`/api/*` plus prose documentation.

### 5.2 Why both: resident vs external consumers

| | Resident agent (canvas terminal on the box) | External agentic system (over the network) |
|---|---|---|
| Best interface | **`canvas` CLI** | **MCP over Streamable HTTP** |
| Setup | none beyond `CANVAS_URL`/`CANVAS_ROOM` env (already seeded) | a URL + service token; no install |
| Discovery | SKILL.md / `--help` — the idiom every skill already teaches | MCP `tools/list` — typed, self-describing |
| Composition | bash pipes, scripts, humans at the shell | MCP host orchestration (Claude, other MCP clients) |
| Session | stateless curl per call | MCP session over Streamable HTTP |
| Why not the other | MCP adds a session layer and host requirement for an agent that already has a shell — pure overhead | teaching an external system to install a CLI and learn `bin/canvas` conventions is friction MCP exists to remove |

### 5.3 The MCP surface

- **Transport:** Streamable HTTP at `/mcp` on the sync server, routed by
  Caddy like every other path. An external system connects with the public
  URL — nothing to install.
- **Tools:** the full registry. Read-heavy tools are the primary external
  use case — **`memory.search` is the killer tool** ("what has this project
  decided about X, and where on the canvas"), alongside `frames`, `read`,
  `transcript`. Write tools (`sticky`, `shape`, `roadmap.ops`,
  `terminal.status`) are available under scoped authorisation (§5.4).
- **Resources:** frames and transcripts can additionally be exposed as MCP
  *resources* for hosts that prefer resource semantics over tool calls —
  cheap, since they are reads over the same contracts.
- **Provenance in results:** MCP tool results carry the same provenance the
  memory service produces (§4.3) — shape ids, frame names, deep links
  (`?d=…`) — so an external agent can hand a human a clickable pointer into
  the live canvas.

### 5.4 Auth and attribution

Auth stays at the edge, consistent with the existing posture:

- `/mcp` sits behind Cloudflare Access like everything else. External
  systems authenticate with **CF Access service tokens**
  (`CF-Access-Client-Id`/`-Secret` headers) — the MCP OAuth flow does not
  need to be implemented; Access enforces before traffic reaches the box.
- `access-identity.ts` extends to map service tokens to **bot
  identities**, so external-agent writes are attributed. This turns the
  `--author` 🤖 convention from voluntary (resident agents choose to pass
  it) into enforced (the gateway stamps authorship from the token identity
  for external calls).
- **Write scoping starts deliberately small:** a per-token allowlist in
  config (read-only vs read-write). Per-tool role machinery is deferred
  until a real need appears — see Open questions.

---

## 6. Migration path

Each step ships independently on `main`:

1. **Extract `@ensembleworks/contracts`** — shape prop schemas, API types,
   WS protocol, shared constants; point client, server and transcriber at
   it. Deletes every "Keep in sync" comment. Highest value, zero behaviour
   change.
2. **Split `app.ts`** into kernel (rooms, WS upgrade, identity, uploads,
   static) + per-feature routers receiving a `PluginServerContext`.
   Quarantine `getPresenceRecords` inside the presence service.
3. **Client registries** — `App.tsx`/`ui.tsx` iterate a plugin list;
   delete-veto and after-delete become `roomHooks`; the 150 ms cadence
   becomes the scheduler service (this also dismembers `AvOverlay`).
4. **Generalise `docStore`** from the roadmap store; re-express the
   terminal status light on it. Introduce the tool registry; generate the
   TS `canvas` CLI and the MCP server from it; retire the bash CLI.
5. **Memory service** — store + ingestion hooks + backfill + worker +
   `memory.search` tool (lands late deliberately: it consumes the hooks and
   tool registry from steps 2–4).
6. **Restructure into plugin packages** (`packages/plugin-terminal`, …)
   with manifests + `ensembleworks.config.ts` deployment profiles. From
   here, a specialist workflow is a new package + a config line.
7. **(When motivated)** Go gateway per `distributed-terminals-design.md`;
   Yjs/Hocuspocus spike per `tldraw-replacement-analysis.md` — both land
   against stable seams instead of a monolith.

## 7. Compatibility & upgrade path for existing installations

Steps 1–6 roll out to existing boxes (ash, `ew-staging-001`, `ew-lsp-001`)
as **ordinary releases via `release.sh` + `deploy.sh`, with zero data
migration**. Two existing properties make this so:

- **Deploys are atomic, so client/server skew doesn't exist.** The client
  is a static build served by the sync server, and `deploy.sh` swaps one
  `current` symlink — client, server, contracts and the regenerated CLI
  ship as a single artifact. Internal interface changes between them are
  invisible to an installation. "Breaking" therefore only means: persistent
  state on disk, host-provisioned contracts, and conventions in agents'
  heads (SKILL.md).
- **Nearly all persistent state is untouched by the refactor:**

  | State | Fate through step 6 |
  |---|---|
  | `rooms/<room>.sqlite` | Loads unchanged — shape schemas *move* into contracts but type names and prop shapes stay identical, so old room files just open. Future prop changes go through tldraw's existing migration machinery. |
  | `transcripts/<room>.jsonl`, `uploads/` | Untouched; the memory service *reads* the JSONL for backfill. |
  | `roadmaps/<room>/<id>.json` | The generalised `docStore` keeps reading today's format (or stamps a version envelope). |
  | tmux sessions (`canvas-<id>`) | Survive everything, as they already survive deploys: naming convention and `KillMode=process` preserved; the gateway is untouched until the optional Go rewrite, which speaks the identical protocol (binary swap under the same unit). |
  | `memory/<room>.sqlite` | Purely additive — new directory, new systemd unit, one backfill command on first deploy. |
  | `~/.config/ensembleworks/*.env`, sudoers, launcher, agent-home | Unchanged. Host bootstrap (laingville) hears nothing until the Go gateway. |

### 7.1 Compatibility keels (acceptance criteria for steps 2–6)

1. **No existing `/api/*` route changes shape or path.** Plugin routers
   mounting under `/api/<plugin>/` must not rename today's routes — that
   would break the seeded skills, agent muscle-memory, and mid-upgrade
   `bin/canvas` calls from live tmux sessions (the one place old-CLI vs
   new-server skew *can* happen, since agent shells outlive deploys). The
   tool registry keeps today's paths as canonical names, or the kernel
   mounts aliases. Treat this as an acceptance test for step 2.
2. **`DATA_DIR` changes are additive-only.** This also preserves rollback:
   an older release from `~/releases/` must still run against data a newer
   one wrote. Holds automatically for steps 1–5 given keel 1 and the
   roadmap-format rule.
3. **The default deployment profile reproduces today's build exactly.**
   When `ensembleworks.config.ts` replaces `SHARED_BROWSER=1`-style flags
   in step 6, an unmodified `deploy.sh` run must be a no-op upgrade.

### 7.2 The one genuine breaking change

The step-7 sync-engine swap (tldraw → Yjs/Hocuspocus) changes the room
document format — a real data migration (a converter reading
`rooms/<room>.sqlite` snapshots and authoring an equivalent `Y.Doc`,
feasible since the server already reads full snapshots headlessly), or an
accepted per-room reset. It also breaks rollback across that boundary and
gets its own migration plan if/when decided. This is precisely why the
plugin architecture lands first: by then the cutover touches one kernel
service and the client `ShapeUtil`s, not fifteen features. The Go gateway
carries no such cost — protocol compatibility makes it non-breaking by
construction.

## Open questions

- Embedding model/provider choice and chunking granularity for transcript
  vs shape content (tune during §4 implementation; the seam is env-config).
- Whether `memoryHooks` need a re-index/versioning story when a plugin
  changes its tagging (likely: store a `pipeline_ver` per chunk and
  lazily re-process).
- MCP write-tool scoping granularity — per-token allowlist vs per-tool
  roles; start with the allowlist.
- Whether the sessions/seed-layouts plugin should become data
  (layout-as-docStore) rather than code.
