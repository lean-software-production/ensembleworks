# EnsembleWorks unified architecture — plugin kernel, Bun runtime, `ensembleworks` CLI, and the migration roadmap

- **Status:** Proposed (design; pty spike run and passed 2026-07-04, no other implementation yet)
- **Date:** 2026-07-05
- **Supersedes:**
  [`plugin-architecture-design.md`](./plugin-architecture-design.md) and
  [`superpowers/specs/2026-07-04-unified-cli-design.md`](./superpowers/specs/2026-07-04-unified-cli-design.md)
  — both now stubs pointing here. This document merges them, resolves
  their contradictions (Go gateway → Bun connector; Node → Bun runtime;
  generated-TS-CLI → manifest-rendered CLI) and owns the single migration
  sequence.
- **Motivation:** Rearchitect EnsembleWorks into a small core of building
  blocks extended via config and plugins; consolidate on Bun as the only
  JS runtime with CI-compiled binaries on servers; and ship one
  `ensembleworks` CLI that absorbs `bin/canvas`, the termgw connector and
  connect.sh — without giving up the properties that make the current
  system good (two-planes separation, one-box backup unity, the
  tmux/sandbox terminal model, the agent-first HTTP surface).
- **Companion docs:**
  - Reference architecture & seam table: [`architecture-spec.md`](./architecture-spec.md)
  - Canvas engine question: [`tldraw-replacement-analysis.md`](./tldraw-replacement-analysis.md)
  - Terminal fleet direction: [`distributed-terminals-design.md`](./distributed-terminals-design.md)
  - Deploy posture: [`deploy-orchestration-options.md`](./deploy-orchestration-options.md)
  - The retired Go connector spike: [`superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md`](./superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md)

## Context

EnsembleWorks today is three npm workspaces (`client`, `server`,
`transcriber`) plus `bin/canvas`, the `gateway-go/` termgw spike, and the
deploy scripts. The feature *folders* are well-separated — the pure logic
(`terminal/grid.ts`, `av/spatial.ts`, `screenshare/resolve.ts`,
`roadmap/model.ts`, the VAD segmenter) is dependency-free and unit-tested.
The monolith is entirely in the **wiring**:

- **Closed registries.** Adding a shape means editing `client/src/App.tsx`
  (shape-util list), `client/src/ui.tsx` (factory + tool + toolbar line +
  icon), `server/src/schema.ts` (validators), and usually
  `server/src/app.ts` (feature routes). Four files, two workspaces, per
  feature.
- **`server/src/app.ts` is a ~1,300-line closure** — room lifecycle,
  LiveKit tokens, kick, pulse, transcript stamping, sticky/shape/frame
  CRUD, roadmap, uploads and static serving all share module-level maps.
- **No shared contracts.** Every wire shape exists 3–4 times, held
  together by "Keep in sync with…" comments: shape props, roadmap op
  semantics, terminal grid clamps, the terminal WS protocol (a comment),
  and `bin/canvas` re-encoding JSON in bash.
- **Type-string switches in core code**, **bespoke instances of the
  rev-fan-out pattern** (roadmap, terminal status light), and
  **`AvOverlay.tsx` (~1,300 lines)** owning the 150 ms cadence.
- **Three disjoint agent/operator surfaces:** `bin/canvas` (400 lines of
  bash with hand-rolled JSON escaping), the Go termgw daemon (env-var
  config, no CLI), and `connect.sh` (bash setup UX for termgw).
- **Native-module fragility:** node-pty (no prebuilds, ABI-sensitive —
  see the "rebuild node-pty after npm ci" devcontainer fix) and pinned
  Node versions on every contributor host and prod box.

Two invariants from `architecture-spec.md` are declared **non-seams** and
must be preserved by everything below:

1. **Two-planes separation** — the CRDT canvas document holds only small
   references (a `sessionId`, a `trackName`, a `roadmapId + rev`); heavy
   content (terminal bytes, media, roadmap docs, transcripts) flows on its
   own channels.
2. **Identity coupling** — tldraw presence userId == LiveKit identity ==
   transcript speaker.

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
│  Agent gateway    — HTTP API + tool manifest → CLI renderer + MCP server (§5)     │
└───────────────────────────────────────────────────────────────────────────────────┘
                     @ensembleworks/contracts  (single source of truth)
```

The kernel is deliberately boring: room + document + identity + media +
storage + memory + scheduling. **Everything users see is a plugin** —
including the five existing shapes. The acid test: terminal, screenshare,
neko, roadmap and iframe must each be expressible as a plugin package with
zero edits to kernel files.

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

| Extension point | Replaces |
|---|---|
| `shapes[]` — schema + migrations in the shared spec; client `ShapeUtil` and server validators derived from it | Hand-synced `schema.ts` ↔ `ShapeUtil` pairs |
| `toolbar[]` / `menu[]` — declarative tool entries with factory fns | Per-feature lines in `ui.tsx` |
| `routes(router, ctx)` — plugin mounts a sub-router under `/api/<plugin>/` with a capability context | Inline route blocks in `app.ts` |
| `roomHooks` — `onShapeDelete` (veto-able), `onUserJoin/Leave`, `onShapeChange(type, fn)` | Terminal delete-veto in `App.tsx`, screenshare after-delete, kick plumbing |
| `docStore(name, schema)` — versioned server-side JSON doc, atomic op batches, `ifRev` concurrency, automatic rev fan-out to shapes referencing it | Roadmap store + terminal status-light fan-out, unified |
| `scheduler.every(ms, fn)` | Loops squatting inside `AvOverlay` and `useSessionPulse` |
| `mediaHooks` — publish/subscribe policy, track naming, per-peer gain hook | Spatial audio and viewport-scoped screenshare subscription become policies plugged into the media service |
| `tools` — verbs declared once with Zod input/output schemas, exposed via HTTP, the tool manifest (→ CLI) **and** MCP (§5) | Hand-written bash subcommands in `bin/canvas` |
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

This one interface quarantines the unstable `room.getPresenceRecords?.()`
dependency inside the presence service; it is the seam that keeps the sync
engine swappable; and it makes plugin server code testable in isolation.

### 1.4 Deliberate non-goals

- **No client-side editor abstraction layer.** Plugins ship tldraw-native
  `ShapeUtil`s and keep their logic in pure modules (the house style). If
  the Yjs/Hocuspocus migration happens, client `ShapeUtil`s are rewritten
  once against the new editor; the plugin structure, contracts, server
  code, workers and tools survive untouched.
- **No runtime dynamic plugin loading.** Composition is build-time: an
  `ensembleworks.config.ts` lists enabled plugins and is consumed by both
  the Vite build and the server boot. "Specialist workflows" are
  **deployment profiles**. (The CLI honours the same philosophy — §6.3.)

### 1.5 Contracts as the spine

`@ensembleworks/contracts` (aggregating per-plugin contract entries):

- **Zod schemas** for every shape's props, every HTTP request/response,
  the terminal WS protocol, transcript entries, roadmap ops, memory
  queries. The server validates with the same object the client types
  against and the CLI parses flags against.
- **JSON Schema export** (native to Zod) — this is what the tool manifest
  (§5) serves and what MCP tool definitions are generated from.
- **One home for protocol-by-naming conventions:** `canvas-` prefixes,
  `user:`-prefix stripping, `TERMINAL_STATUSES`, grid clamps,
  spatial-audio distances.
- **Shared executable code where both sides need it:** the tmux
  session manager (`Bun.Terminal`-based) used by the server terminal
  gateway *and* the CLI connector — one implementation of
  "attach tmux via a PTY, speak the 5-message protocol".

---

## 2. Runtime & component decisions

**The repo consolidates on Bun as its only JS runtime, with CI-compiled
binaries as the only thing installed on servers.** Contributor host
requirement becomes **bun + docker** (`bunx @devcontainers/cli`); Node
version pins are deleted; `bun install` + `bun.lock` replace npm.

### 2.1 Spike results (2026-07-04)

Bun ≥ 1.3.14 ships a native PTY API — `Bun.Terminal` /
`Bun.spawn(cmd, { terminal })` with write, resize, data callback, termios
flags and raw mode: a complete node-pty replacement. Verified:

- A `bun build --compile` standalone binary, copied to a clean directory
  and run with a scrubbed environment, spawned `tmux new -A` through a
  real PTY, wrote a command, read output, resized 80×24 → 120×40, exited
  cleanly.
- Cross-compile linux-x64 → linux-arm64 works with one `--target` flag;
  musl variants available. Binaries ~90 MB, link only glibc.
- The API is absent in Bun 1.3.4 — **Bun ≥ 1.3.14 is the build floor**
  (build-time only; compiled binaries embed the runtime).

Phase-0 battery results (2026-07-05, see `spikes/phase0/FINDINGS.md`):

- Spike A (compiled sync server): PASS with two Phase-3 work items — Bun
  lacks `node:sqlite` (a `bun:sqlite` adapter is needed; a throwaway shim
  proved express 5, the `ws` upgrade path, sync-core and sqlite persistence
  all work compiled), and the compiled binary needs an explicit
  `CLIENT_DIST` (the `import.meta.dirname` default resolves into the
  bundle's virtual filesystem).
- Spike B (Vite build under Bun): PASS — `bun --bun run build` works,
  output and timing equivalent to Node.
- Spike C (rtc-node under Bun): PASS — import, transcriber runtime, and
  compiled binary with the embedded `.node` addon all work; the LiveKit
  `room.connect()` path itself was not exercised (deferred to the Phase-3
  transcriber cutover checklist).

### 2.2 Component table

| Component | Decision | Reasoning |
|---|---|---|
| Contracts + plugin API | **TypeScript + Zod** | The design hinges on client/server/CLI/MCP sharing one schema object. |
| Client | **TypeScript + React** (keep) | tldraw, LiveKit client and xterm.js are TS-first. Keep tldraw for now; the Yjs+Hocuspocus question stays open behind the `canvas` capability seam. Vite build driven by Bun (Phase 0 spike line-item). |
| Sync server / kernel | **TypeScript on Bun** (restructure per §1; compiled in CI) | Must execute the shared shape schemas — TS-native. Express 5 + per-plugin routers is fine at this scale. Bun replaces Node after the Phase 0 compat spike (express 5, `ws` upgrade path under sync-core traffic, `node:sqlite`, static serving from a compiled bundle). Phase-0 found two cutover work items: a `bun:sqlite` adapter until Bun ships `node:sqlite`, and an explicit `CLIENT_DIST` for compiled binaries. |
| Terminal gateway / connector | **TypeScript on Bun, shared session manager** — the Go rewrite is retired | Supersedes the previous "Go when the fleet design executes" recommendation. `Bun.Terminal` removes node-pty; `bun build --compile` gives the same curl-one-static-binary property that motivated Go; and the server gateway + CLI connector share one session-manager implementation instead of forking it across languages. The Go termgw spike validated the relay protocol, which carries over message-for-message. |
| Transcriber / workers | **TypeScript** (keep); spiked under Bun; **Python sanctioned for ML-heavy workers** | `@livekit/rtc-node` (napi over LiveKit's Rust core) is the one native risk: Phase 0 spikes it compiled-under-Bun. Pass → compiled artifact like the rest; fail → contained Node exception (devcontainer + one prod unit). (Phase 0: passed — including the compiled-binary check; `room.connect()` exercise deferred to cutover.) The **Python + livekit-agents rewrite** is the transcriber's named future — most mature audio pipeline (AudioStream PCM, Silero VAD, STT plugins) — triggered by the first local-Whisper/diarisation feature, as its own spec. The worker SPI is process-level (env in, HTTP/LiveKit out), so worker language is invisible by construction. |
| Agent CLI | **One compiled Bun binary, `ensembleworks`** (§6) — generic renderer of the server tool manifest, plus native `auth`/`terminal connect` | Absorbs `bin/canvas`, termgw and connect.sh. Supersedes "TypeScript CLI generated from contracts at build time": rendering the manifest at runtime is stronger — no verb knowledge in the binary to drift, and new plugin tools appear in installed CLIs without a release. |
| Memory store | **SQLite** (FTS5 + sqlite-vec) — see §4 | |
| Edge / infra | **Keep Caddy + systemd + Cloudflare Tunnel/Access.** `deploy.sh` becomes artifact-based: fetch-verify-swap of CI-built binaries (§6.5); no JS runtime or build toolchain on prod hosts | k8s still rejected per `deploy-orchestration-options.md`. Plugin config slots into `~/.config/ensembleworks/*.env` plus `ensembleworks.config.ts`. |

---

## 3. Existing features re-expressed as plugins

| Plugin | shapes | server | worker | tools | Notes |
|---|---|---|---|---|---|
| `terminal` | `terminal` | gateway registration, status docStore | — | `terminal status` | Delete-veto via `roomHooks.onShapeDelete` |
| `screenshare` | `screenshare` | — | — | — | Subscription loop via `scheduler` + `mediaHooks`; tombstone stills via `storage.blobs` |
| `shared-browser` | `neko` | health probe | — | — | Opt-in via deployment profile (replaces `SHARED_BROWSER=1`) |
| `roadmap` | `roadmap` | `docStore('roadmap', …)` | — | `roadmap list/read/push/ops` | The house template for plugin-owned content |
| `iframe` | `iframe` | — | — | — | Paste-URL interceptor via a client hook |
| `scribe` | — | transcript routes | LiveKit→STT worker | `transcript`, `say` | Transcript store feeds memory ingestion (§4) |
| `stickies/frames` | (default shapes) | sticky/shape/frame routes | — | `canvas sticky/shape/frames/read/pull-images` | The core agent read/write surface |
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
gateway port and where is it on the canvas?"). Memory is a **kernel
service, not a plugin**, because its point is to be fed by *every* plugin
and queried by *every* agent.

### 4.2 Data store decision: SQLite

**Decision: SQLite — a dedicated memory database per room
(`DATA_DIR/memory/<room>.sqlite`) with FTS5 + sqlite-vec, behind a
`MemoryStore` interface. Postgres is a named seam, not a component.**

Why SQLite wins here:

- **The workload fits.** Append-heavy, single-writer, read-many —
  WAL-mode SQLite's sweet spot. Even heavy use lands at hundreds of
  thousands to low millions of chunks over years.
- **Postgres breaks three deliberate deployment properties:** backup
  unity (one filesystem backup captures the instance), the inverted
  memory policy (`memory-resource-policy.md` — a resident Postgres taxes
  agent-terminal headroom), and bootstrap simplicity.
- **Embedded covers both search modes:** FTS5 (BM25, prefix/phrase) for
  lexical; sqlite-vec (brute-force KNN, fine to ~1M vectors, int8/bit
  quantisation) for semantic; relational tables + JSON1 for
  tags/entities/provenance; WAL for transactional ingest. At ~300k
  chunks × 1024-dim float32 there is no need for an ANN index.

Constraints designed around:

- SQLite is single-writer-per-database → memory gets **its own DB files**,
  separate from room sync SQLite. The ingestion worker is the sole
  writer; the API server opens read-only. "Forget this room" = delete one
  file.
- **Postgres triggers** (revisit if any occur): multiple VMs needing one
  shared memory, cross-room analytics at real volume, tens of millions of
  vectors, or adopting Postgres for another core need. Both stores speak
  SQL — migration is a data copy, not a redesign.
- **Ruled out:** a separate vector service (a new daemon for no gain),
  DuckDB (analytics-shaped), LanceDB (a second storage idiom when FTS5 +
  sqlite-vec covers both modes in one file).

### 4.3 Pipeline

```
sources (kernel hooks)             processing worker               retrieval
──────────────────────            ──────────────────             ─────────────────────
transcript appends        ──┐     chunk → tag/extract   ──┐      memory search tool:
shape/sticky changes      ──┼──►  (LLM) → embed         ──┼──►     GET /api/memory/search
docStore op batches       ──┤     (OpenAI-compatible     ──┘        ew memory search …
frame snapshots, uploads  ──┘      embeddings API)                  MCP tool (§5)
                                   │                                ctx.memory (plugins)
                             memory/<room>.sqlite
                             docs · chunks(FTS5) · vectors(sqlite-vec) · tags · provenance
```

- **Ingestion is event-driven, not scrape-based** — the memory service
  subscribes to the same `roomHooks`/`docStore` events plugins use.
  Plugins may register `memoryHooks` to shape chunking/tagging. A
  backfill command handles historical JSONL/SQLite files.
- **Processing runs in a worker process** (the process-level worker SPI).
  Embeddings via any OpenAI-compatible endpoint (`MEMORY_EMBED_URL`,
  `MEMORY_EMBED_MODEL`, `MEMORY_EMBED_API_KEY`); the worker could later be
  Python without touching the store.
- **Hybrid retrieval, fused:** FTS5 (BM25) and sqlite-vec (cosine) run in
  parallel, merged with reciprocal-rank fusion, filtered by tags / time /
  source / frame. Agents issue many exact-term queries where BM25 beats
  embeddings.
- **Provenance is the product:** every result carries transcript entry
  ids, shape ids, frame names, timestamps, deep links (`?d=…`). A
  retrieving agent follows a result with `ew canvas read <frame>`.

### 4.4 Schema sketch

```
docs      (id, room, source, source_id, t, title, meta_json)
chunks    (id, doc_id, seq, text)             -- + chunks_fts (FTS5, content=chunks)
vectors   (chunk_id, embedding)               -- sqlite-vec virtual table
tags      (chunk_id, kind, value)             -- kind: entity|topic|decision|action|person
prov      (chunk_id, shape_id?, frame_name?, transcript_id?, t)
```

---

## 5. Agent access: one tool registry, three facades

Plugins declare `tools` once — verbs with Zod input/output schemas — and
the agent gateway derives:

1. **HTTP routes** (`/api/…`) — the source of truth, as today.
2. **The tool manifest** (`GET /api/tools`) — the JSON Schema export of
   the registry, rendered by the `ensembleworks` CLI (§6.3).
3. **An MCP server (Streamable HTTP) at `/mcp`** — for external agentic
   systems.

The three surfaces cannot drift because they *are* each other. MCP is not
a substitute for the CLI and vice versa:

| | Resident agent (canvas terminal on the box) | External agentic system (over the network) |
|---|---|---|
| Best interface | **`ensembleworks` CLI** | **MCP over Streamable HTTP** |
| Setup | none beyond seeded `ENSEMBLEWORKS_*` env | a URL + service token; no install |
| Discovery | SKILL.md / `--help` | MCP `tools/list` |
| Composition | bash pipes, scripts, humans at the shell | MCP host orchestration |
| Why not the other | MCP adds a session layer for an agent that already has a shell | teaching an external system to install a CLI is the friction MCP removes |

**The MCP surface:** Streamable HTTP at `/mcp`, routed by Caddy, behind
Cloudflare Access. The full registry; read-heavy tools are the primary
external use case — **`memory search` is the killer tool** — alongside
`frames`, `read`, `transcript`. Write tools under scoped authorisation
(§6.4). Frames and transcripts may also be exposed as MCP *resources*.
Tool results carry the same provenance the memory service produces.

---

## 6. The unified `ensembleworks` CLI

One compiled Bun binary absorbing `bin/canvas` (canvas verbs), the termgw
Go connector (remote terminal daemon) and `connect.sh` (setup UX).
Primary driver: **one artifact on remote boxes** — a
devcontainer/Codespace curls down a single file that both connects its
terminal to the canvas and gives resident agents the canvas verbs.

Decisions from the CLI brainstorming (2026-07-04):

1. **Clean break.** No `canvas` alias or shim; SKILL.md reseeded once;
   `CANVAS_URL`/`CANVAS_ROOM` are replaced by
   `ENSEMBLEWORKS_URL`/`ENSEMBLEWORKS_ROOM`.
2. **gh-style, auth-first UX** with an `ew` hardlink for daily typing.
3. **Auth methods v1: CF Access service-token pair + "none"** (localhost/
   tailnet instances). Human SSO deferred.
4. **All three extensibility layers ship in v1** (§6.3).

### 6.1 Command surface

```
ensembleworks auth login [--url <instance>]   # interactive: URL → method → verify → store
ensembleworks auth status                     # per instance: reachable + resolved identity
ensembleworks auth logout [--url <instance>]

ensembleworks canvas    sticky|shape|frames|read|pull-images
ensembleworks roadmap   list|read|push|ops
ensembleworks transcript read|say
ensembleworks terminal  connect|status

ensembleworks version                         # own build + connected server version
```

- Connection resolution for every command: flags → env → `hosts.toml`;
  failure says "run `ensembleworks auth login`".
- **Resident agents stay zero-interactive:** `ENSEMBLEWORKS_URL`, `_ROOM`,
  `_TOKEN_ID`, `_TOKEN_SECRET` bypass the config file (the `GH_TOKEN`
  pattern). `deploy.sh` seeds these in agent homes; on-box agents hit
  localhost with method "none".
- Rooms: default room stored per instance at login; `--room` overrides;
  `ENSEMBLEWORKS_ROOM` for agents.
- `terminal connect` absorbs the termgw daemon; connect.sh's setup flow
  is subsumed by `auth login`. `--dry-run` prints resolved config;
  `--label` defaults to hostname.
- Verb semantics carry over from `bin/canvas` 1:1 under the new
  namespaces; only the spelling changes.

### 6.2 CLI code layout

```
contracts/src/
  tools/…               # verb definitions: Zod input schema + HTTP mapping + help text
  terminal-protocol.ts  # the 5-message WS protocol (today: a comment in terminal-gateway.ts)
  session-manager.ts    # tmux-attach via Bun.Terminal — shared by server gateway and CLI connector
  whoami.ts             # identity envelope shared by /api/whoami and auth status
cli/src/
  main.ts               # dispatch: native → manifest groups → PATH extensions → error
  auth/                 # hosts.toml read/write, resolution chain, login/status/logout
  render/               # generic verb renderer: manifest entry → argv parser, --help, validation
  connector/            # relay WS client, backoff/ping — termgw port, protocol-identical
```

The connector speaks the Go termgw protocol message-for-message; the
server relay plane is untouched, so a half-migrated fleet (Go termgw still
connected while the CLI rolls out) keeps working.

### 6.3 CLI extensibility — three layers

**Layer 1 — the tool manifest (primary).** The CLI is a *generic
renderer* of `GET /api/tools`: verb groups, flags, `--help`, local
validation. The verbs baked into the binary are only an embedded snapshot
of the manifest (offline cache, refreshed into `~/.cache/ensembleworks/`).
Consequences: a new server plugin's tools appear in every installed CLI
with no CLI release; old binaries in long-lived agent tmux shells gain new
verbs; the CLI has no verb knowledge of its own to drift.

**Layer 2 — PATH extensions (gh's model).** An unmatched group
`ensembleworks foo` execs `ensembleworks-foo` from PATH or
`~/.config/ensembleworks/extensions/`, passing the resolved connection via
`ENSEMBLEWORKS_*` env. Process-level, any language — the worker-SPI
philosophy. No install/registry machinery in v1.

**Layer 3 — native commands.** Only `auth` and `terminal connect` are
hardcoded (credential storage and a PTY daemon cannot be data-driven).

No runtime loading of JS plugin code into the compiled binary — mirroring
§1.4's "no dynamic plugin loading" non-goal.

### 6.4 Auth & attribution

- `hosts.toml` (mode 0600, plaintext — headless boxes have no keychain):

  ```toml
  [instances."https://canvas.example.com"]
  method = "service-token"        # or "none"
  token_id = "…"
  token_secret = "…"
  default_room = "team"
  identity = "🤖 codespace-3"     # cached from last whoami
  ```

- `GET /api/whoami` → `{identity, kind: human|bot|anonymous,
  via: service-token|sso|none}`. `access-identity.ts` gains a config map
  from CF Access service-token client-IDs → bot identities.
- **Attribution enforced where a credential exists:** writes via a
  service token are stamped with the token's bot identity server-side
  (`--author` ignored or must match). Localhost/"none" instances keep the
  voluntary `--author` convention.
- Write scoping: per-token `read-only`/`read-write` in the same config
  map. Per-tool roles deferred until a real need appears.
- **Closes the termgw spike's accepted risk:** on authenticated
  instances, gateway registration requires a resolvable identity and a
  gateway id is bound to the identity that registered it —
  replace-on-reconnect only succeeds for the same identity. On "none"
  instances the open behaviour remains, documented as a property of
  no-auth instances.

### 6.5 Distribution: CI-compiled artifacts everywhere

**Release assets** (built by `release-cli.yml`, successor to
`release-termgw.yml`, on `v*` tags; `deploy/release.sh` flow unchanged):

```
ensembleworks-linux-x64        ensembleworks-linux-arm64
ensembleworks-darwin-arm64     ensembleworks-server-linux-x64
ensembleworks-server-linux-arm64
ensembleworks-transcriber-linux-{x64,arm64}   # if the rtc-node spike passes
client-dist.tar.gz             install.sh
ensembleworks-checksums.txt
```

**Remote-box bootstrap:**

```
curl -fsSL https://github.com/lean-software-production/ensembleworks/releases/latest/download/install.sh | bash
ensembleworks auth login
ensembleworks terminal connect --label $(hostname)
```

`install.sh` keeps connect.sh's habits: arch detect, checksum verify,
`ENSEMBLEWORKS_VERSION` pinning, installs to `~/.local/bin/` with the `ew`
hardlink. The devcontainer feature (`termgw-feature`) is repackaged as an
`ensembleworks-cli` feature — same entrypoint/supervisor pattern, exec'ing
`ensembleworks terminal connect`.

**Server deploys are artifact-based.** `deploy.sh` becomes
fetch-verify-swap: download the tag's artifacts into `~/releases/<ver>/`,
verify checksums, swap the `current` symlink, restart units. No `npm ci`,
no build toolchain, no JS runtime on prod hosts. A
`--build-from-source` escape hatch covers unpushed branches and dev boxes.

- Binaries embed sourcemaps (`--sourcemap`) so stack traces stay readable.
- Disk: ~90 MB × services × 3 retained releases ≈ 800 MB. Accepted.
- CI gains a smoke job that **boots the compiled binaries** (not
  source-under-Bun) and exercises `/api/whoami` + a room sync.
- Rollback strengthens: each release dir is self-contained. (Rollback
  across the Phase-3 cutover boundary is unsupported — keel 3, §7.1.)
- Version skew is tolerant by design: the manifest layer means an older
  binary renders newer server verbs; the binary only *must* update when
  native code changes. Self-update (`ensembleworks upgrade`) deferred.

---

## 7. Unified migration roadmap

**Compatibility posture: big-bang cutover (decided 2026-07-05).** One
designated release is allowed to break everything transient: `/api/*`
route shapes and paths, the CLI (`bin/canvas` → `ew`), env names, and
live connections — terminal agents are restarted and canvas users
hard-refresh. The only hard requirement is **data import**: existing
rooms, transcripts, roadmaps and uploads must load in the new world
(unchanged formats where that is free, one-shot converters where not).

**Big-bang is a compatibility posture, not a mega-branch.** Phases still
land incrementally on `main` with their own implementation plans; what
the posture buys is deleting coexistence scaffolding — no route aliases,
no dual-CLI window, no Go-connector overlap, no Node kept on hosts for
cross-boundary rollback. Breakage concentrates in Phase 3, the cutover
release.

| Phase | Delivers | Retires |
|---|---|---|
| **0. Spike battery** | Compiled server under Bun (express 5, `ws` upgrade path under sync-core traffic, `node:sqlite`, static serving from a bundle); Vite-driven-by-Bun build; compiled transcriber with embedded rtc-node addon. Pty spike already ✅ (§2.1) | — |
| **1. Contracts** | `contracts/` in full: shape prop schemas, API types, terminal WS protocol, shared constants, tool definitions. Client, server and transcriber consume it. Zero behaviour change | Every "Keep in sync with…" comment |
| **2. Kernel split + client registries** | `app.ts` → kernel (rooms, WS upgrade, identity, uploads, static) + per-feature routers receiving `PluginServerContext` (mounted at today's paths until Phase 3); `getPresenceRecords` quarantined; `App.tsx`/`ui.tsx` iterate a plugin list; delete-veto and after-delete become `roomHooks`; scheduler service; `AvOverlay` dismembered | The ~1,300-line closure; type-string switches in core code |
| **3. THE CUTOVER RELEASE** | Clean per-plugin route layout (`/api/<plugin>/…`, no aliases); the `ensembleworks` CLI (auth, whoami, attribution, write scoping, `/api/tools` manifest + renderer, canvas verbs); the connector (`terminal connect`, shared session manager, gateway-id identity binding, validated against `relay-loopback.test.ts`); server runtime → Bun; artifact-based `deploy.sh` (fetch-verify-swap); transcriber per spike result; `bin/dev` under Bun; `bun install` at the root. Rollout: deploy, restart terminal agents, reseed SKILL.md + `ENSEMBLEWORKS_*` env, users hard-refresh. A pre-deploy check confirms every room/roadmap/transcript file loads | `bin/canvas`; `gateway-go/`; `sample-remote-terminal/connect.sh`; `release-termgw.yml`; node-pty; `npm ci` on prod hosts; Node (hosts and engines pins); `CANVAS_URL`/`CANVAS_ROOM` |
| **4. Registry completion** | `docStore` generalised from the roadmap store (terminal status light re-expressed on it); *all* routes become registered tools; **MCP server at `/mcp` generated from the registry** | Remaining hand-mounted routes |
| **5. Memory service** | Store + ingestion hooks + backfill + worker + `memory search` (appears in every installed CLI via the manifest, for free; the killer MCP tool) | — |
| **6. Plugin packages** | `packages/plugin-*` with manifests + `ensembleworks.config.ts` deployment profiles; default profile reproduces the Phase-3 build exactly | `SHARED_BROWSER=1`-style flags |
| **7. When motivated** | Yjs/Hocuspocus spike per `tldraw-replacement-analysis.md`, landing against stable seams | (the former "Go gateway" line item is deleted — superseded by the Bun connector) |

Phases 1–2 are deliberately pre-cutover: they are behaviour-neutral
restructures that shrink the blast radius of Phase 3 to "new surfaces on
an already-modular core" rather than "restructure and break at once".

### 7.1 Keels (what survives the big bang)

1. **Data imports.** `rooms/<room>.sqlite` loads unchanged (shape type
   names and prop shapes stay identical through the refactor — this is
   free, so keep it); `transcripts/<room>.jsonl`, `uploads/` and
   `roadmaps/<room>/<id>.json` are read as-is. If any Phase-3 change
   makes a format diverge, that phase ships a one-shot converter and the
   pre-deploy check proves it against production copies.
2. **Identity coupling and two-planes separation** (the non-seams from
   `architecture-spec.md`) hold through every phase.
3. **Rollback works within a posture era** — among pre-cutover releases,
   and among post-cutover releases. Rollback *across* the Phase-3
   boundary is explicitly unsupported; the mitigation is the pre-deploy
   data check plus a filesystem backup of `DATA_DIR` taken by the cutover
   deploy before swapping.
4. **The default deployment profile (Phase 6) reproduces the Phase-3
   build exactly** — an unmodified `deploy.sh` run must be a no-op
   upgrade.

### 7.2 State through the migration

| State | Fate |
|---|---|
| `rooms/<room>.sqlite` | Loads unchanged (keel 1). Future prop changes go through tldraw's migration machinery. |
| `transcripts/<room>.jsonl`, `uploads/` | Untouched; the memory service *reads* the JSONL for backfill. |
| `roadmaps/<room>/<id>.json` | The generalised `docStore` keeps reading today's format (or stamps a version envelope). |
| tmux sessions (`canvas-<id>`) | Naming convention kept, but sessions are **restarted at the Phase-3 cutover** (accepted). Post-cutover they survive deploys as today. |
| `memory/<room>.sqlite` | Purely additive — new directory, new unit, one backfill command. |
| `~/.config/ensembleworks/*.env`, sudoers, launcher, agent-home | Env names change at Phase 3 (`ENSEMBLEWORKS_*`); host bootstrap (laingville) *shrinks* (no Node/npm needed). |

### 7.3 The one genuine breaking change

The Phase-7 sync-engine swap (tldraw → Yjs/Hocuspocus), if taken, changes
the room document format — a real data migration or an accepted per-room
reset, with its own plan. The plugin architecture landing first is what
makes that cutover touch one kernel service and the client `ShapeUtil`s,
not fifteen features.

## Open questions

- Whether `ew` should be the documented primary spelling (SKILL.md) with
  `ensembleworks` as the formal name, or vice versa.
- musl builds: add `bun-linux-{x64,arm64}-musl` targets only when an
  Alpine-family box appears.
- Manifest cache staleness policy: start with on-miss + `--refresh`, tune.
- Whether `auth login` should offer to mint/register the service token
  via a canvas-side admin flow (today: paste a pair created in the
  Cloudflare dashboard).
- Embedding model/provider choice and chunking granularity (tune during
  Phase 5; the seam is env-config).
- Whether `memoryHooks` need a re-index/versioning story when a plugin
  changes its tagging (likely: `pipeline_ver` per chunk, lazy re-process).
- MCP write-tool scoping granularity — per-token allowlist first.
- Whether the sessions/seed-layouts plugin should become data
  (layout-as-docStore) rather than code.
- Phase-0 spike outcomes may reshape Phase 3 (e.g. the transcriber
  Node-exception path) without changing the end state.
