# Canvas Phase 2: Sync + Room Host + Shadow Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make CRDT merges *real*. Turn Phase 1's isolated `canvas-doc` into a
live, multi-peer document: a `canvas-sync` workspace (incremental Loro update
exchange + presence, clean-room), a room-host document actor in `server` (one
Loro doc per room, append-log + shallow-snapshot compaction into the per-room
SQLite pattern), a deterministic repair pass that runs identically on every peer
after every merge, and a shadow-mode mirror that continuously converts every
live tldraw room into a new-engine Loro document with divergence telemetry — all
at **zero user exposure**. Land the design's model/doc/stability test rigs
(property-based convergence, fuzzing, crash recovery, nightly soak) against real
traffic shapes.

**Architecture:** One new clean-room Bun workspace, `canvas-sync`, depending only
on `@ensembleworks/canvas-model` + `@ensembleworks/canvas-doc` + `loro-crdt`
(never `server`, never `tldraw`, no DOM). Its core is transport-agnostic: a
`SyncServerPeer` (authoritative room peer: ingests updates, rebroadcasts,
tracks per-peer version vectors) and a `SyncClientPeer` (headless: owns a
`LoroCanvasDoc`, forwards local updates, applies remote, reconnect/rebase),
plus presence over Loro's `EphemeralStore`. Both talk through an injected
`Transport` interface (in-memory pair for deterministic tests; a thin `ws`
adapter lives in `server`, the only place allowed to import `ws`). The `server`
workspace gains a `DocumentActor` (one Loro doc + append-log SQLite per room,
built on the existing `DatabaseSync`/storage-geometry pattern) and a
`ShadowMirror` (tldraw store change → `fromTldraw` → reconcile into the room's
Loro doc → periodic divergence check → metrics). The repair pass is a *pure*
`repairPlan(doc): RepairOp[]` in `canvas-model` (determinism rule) applied by
`canvas-doc.repair()`. Nothing in this phase is mounted for real users; the WS
endpoint is env-flag-gated off by default and exercised only by rigs.

**Tech Stack:** Bun 1.3.14, Node 22.12.0 (asdf), TypeScript 5.7, `zod` ^4,
`loro-crdt` **1.13.6 (pin exact)**, the existing `@tldraw/*` 5.1.0 server
packages, Express 5, `ws` 8, `bun:sqlite` (via `server/src/kernel/sqlite.ts`),
Playwright (nightly soak/crash workflow modeled on `.github/workflows/e2e.yml`).

---

## House rules (read before Task 0 — these override habits)

- **bun is NOT on PATH in fresh shells.** Every `Bash` invocation must begin with
  `export PATH="$HOME/.bun/bin:$PATH"`. bun is 1.3.14; node 22.12.0 via asdf.
- **Run the suite with `bun run test`** (root → `scripts/run-tests.ts`), **never
  raw `bun test`.** Tests are plain self-executing scripts using
  `node:assert/strict` + a top-level body + `console.log('ok: …')`, run as
  `bun <file>`. A `bun:test` (`describe/it`) file run this way errors with
  "Cannot use test outside of the test runner." Match the house style exactly.
- **Typecheck:** `bun run typecheck` from the repo root covers every workspace.
- **Determinism rule (design):** no `Date.now`/`Math.random`/I/O in
  `canvas-model`, `canvas-doc`, or `canvas-sync` *core* logic. Clocks, ids, PRNG,
  and transport are injected. Every bug is a replayable op sequence.
- **`loro-crdt` is exact-pinned at 1.13.6.** `canvas-*` packages never import
  from `server` or `tldraw`. `canvas-sync` core never imports `ws`.
- **`CLAUDE.md` is a symlink to `AGENTS.md`** (verified: `CLAUDE.md -> AGENTS.md`).
  Edit **`AGENTS.md`**. The plan includes a task adding `canvas-sync` to the
  workspace list there (and in `README.md` if it lists workspaces).
- **New workspaces must be registered** in root `package.json` `workspaces`
  (after `canvas-doc`) and its `typecheck` script chain. `scripts/run-tests.ts`
  auto-globs `**/src/**/*.test.ts`, so new house-style tests are discovered with
  no change there.
- **Commits:** small, frequent, conventional-commit style, each ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Tool-count assertions** live in FOUR lock-step files
  (`server/src/tools-api.test.ts`, `cli/src/cli-api.test.ts`,
  `cli/src/render/manifest.test.ts`, `contracts/src/tools/tools.test.ts`, plus
  the PLUGINS allow-list). **Current count: 27.** This phase adds **no agent
  tools.** The one internal HTTP endpoint we add (shadow metrics) is registered
  in the tools-api test's **EXEMPT** set (alongside `/api/health`, `/api/tools`,
  `/api/telemetry/connection`) — a single-file edit, NOT a tool-count bump.
- **e2e rig facts:** ports 8788/5273 must be free; specs in `e2e/tests`; CI
  workflow `.github/workflows/e2e.yml` runs the `e2e` project on PRs and the
  `perf` project nightly. The Phase 2 nightly soak job is modeled on that file.

---

## Open questions for the controller (ratify before execution)

These are judgment calls the plan made where the design left room. Each has a
chosen default (what the tasks below implement) and the alternative.

1. **Repair pass location.** The design says "deterministic repair pass *in
   canvas-doc*." To honor the determinism rule (canvas-model is the only place
   allowed to hold pure logic; canvas-doc holds Loro I/O) the plan **splits it**:
   a pure `repairPlan(doc): RepairOp[]` lands in **canvas-model**, and
   `canvas-doc.repair()` applies that plan to the Loro tree. Same guarantee
   (identical repair on every peer, because the plan is a pure function of the
   converged model), cleaner boundaries. Ratify or ask for it wholly inside
   canvas-doc.

2. **Bindings + pages must enter the CRDT this phase.** Phase 1's `canvas-doc`
   holds only *shapes* in the Loro tree; `dumpModel` returns `pages:[],
   bindings:[]`. Merges only become "real" (design) if the *whole*
   `CanvasDocument` converges — and `noDanglingBindings` repair has nothing to
   operate on until bindings live in the doc. The plan therefore adds
   `LoroMap`-backed bindings and pages to `LoroCanvasDoc` (Seam A1). This is
   in-scope groundwork implied by "sync + repair," but it is more than the design
   spells out — flagging it.

3. **No user-facing WS this phase.** "Zero user exposure" is explicit. The plan
   builds the room-host document actor and mounts a `/sync/v2/:roomId` WS
   **gated behind `EW_CANVAS_SYNC=1` (default off)**, exercised only by rigs and
   an integration test — never wired into the client. Real cutover is Phase 3.
   Alternative: don't mount it at all and drive the actor purely in-process.
   Default chosen because a real-`ws` round-trip is worth one integration test.

4. **Presence depth in Phase 2 (no renderer yet).** The plan builds the full
   presence *wire mechanism*: a typed `Presence` schema (cursor, viewport,
   stamp, presenting tokens) over `EphemeralStore`, LWW merge, timeout expiry,
   encode/apply, exercised headlessly with two peers. It **defers** binding
   presence to a live camera/selection and any ProseMirror/cursor rendering to
   Phase 3 (there is nothing to render). Ratify this line.

5. **Per-commit vs nightly scaling.** Convergence (small N, bounded op counts),
   fuzzing, and crash-recovery run **per-commit** via `bun run test`. The
   **soak** simulation (hours, RSS/growth trends, chaos proxy) runs **nightly**
   in a new `canvas-soak` GH workflow job modeled on `e2e.yml`, plus a fast
   smoke variant per-commit. Confirm the nightly cadence and that soak need not
   gate PRs.

6. **Append-log storage shape.** The actor persists to a **separate SQLite file
   per room** under `DATABASE_DIR/canvas-v2/<roomId>.sqlite` (an `updates`
   append table + a `snapshots` table), NOT inside the existing tldraw
   `<roomId>.sqlite`. This keeps the shadow/new-engine data physically separate
   from live tldraw rooms (safe to wipe, never risks the live DB — honoring the
   storage-geometry incident's lesson) and keeps Phase 5 cutover a clean file
   swap. Confirm the directory choice.

7. **Metrics surface.** Divergence/growth/repair counts are exposed at
   `GET /api/canvas/metrics` (internal, EXEMPT from the tools manifest) **and**
   logged. If the controller prefers a Prometheus text format or a different
   path, say so before Seam D.

---

## Context you need (zero-assumption briefing)

Read this whole section before Task 0. It replaces prior knowledge of the
codebase and of Loro's sync surface. Every signature below was read from the
installed source in this worktree.

### What Phase 1 left you (the things you extend)

`canvas-model` (`canvas-model/src/*`, pure, zod-only):
- `Shape` envelope + `SHAPE_KINDS` (15 kinds), `shapeSchema`, `validateShape`,
  `plainText(shape)`.
- `Binding` = `{ id: 'binding:…', fromId: 'shape:…', toId: 'shape:…', props, meta? }`;
  `Page` = `{ id: 'page:…', name, index? }` (`document.ts`).
- `CanvasDocument = { pages, shapes, bindings, byId }`; `makeDocument({pages,
  shapes, bindings})`; accessors `shapeById`, `childrenOf`, `rootShapes`,
  `frames`, `descendantsOf`, `pageIdOf`.
- `checkInvariants(doc): Violation[]` where
  `Violation = { rule: 'noOrphans'|'noCycles'|'noDanglingBindings'|'validProps', id, detail }`.
  **Detection only — no repair yet.** You add repair in Seam A4.
- geometry / neighbors / cluster / `semanticView(doc, shapes)`.

`canvas-doc` (`canvas-doc/src/*`, depends on canvas-model + loro-crdt):
- `interface CanvasDoc` (`canvas-doc.ts`) — the swappable contract.
- `class LoroCanvasDoc implements CanvasDoc` (`loro-canvas-doc.ts`): the Loro
  movable tree (`doc.getTree('shapes')`) is the single source of truth for
  hierarchy. Node `data` is a flat `LoroMap` of the envelope; props under key
  `'__props'`; text in a per-shape `LoroText` keyed `text:<shapeId>`.
  `putShape` (atomic, cycle-guarded), `updateProps`, `deleteShape` (cascade +
  text cleanup), `reparent`, `get/setText`, `exportSnapshot`, `exportUpdate`,
  `import`, `subscribe`, `commit`. `create({peerId})` / `fromSnapshot(bytes,
  {peerId})`.
- `bridge.ts`: `loadModel(doc, model)` (topo-ordered put+reparent),
  `dumpModel(doc)` → `makeDocument({pages:[], shapes, bindings:[]})`. **Only
  shapes round-trip today** — you fix this in A1.

Accepted Phase-1 deferrals this phase acts on (from that plan's "Execution
notes"): `exportUpdate()` has **no since-version parameter** — incremental sync
needs one (A2). The O(n²) clustering cap and zodInput middleware remain out of
scope.

`server` (`server/src/*`):
- `kernel/rooms.ts` — `createRoomHost(roomsDir): { rooms, getOrCreateRoom }`.
  Each room is a `TLSocketRoom` backed by `SQLiteSyncStorage(new
  NodeSqliteWrapper(new DatabaseSync(<roomsDir>/<roomId>.sqlite)))`.
- `kernel/sqlite.ts` — `DatabaseSync` (a `bun:sqlite` adapter; WAL +
  `synchronous=NORMAL`). Reuse it for the actor's own DB.
- `kernel/storage-geometry.ts` — `resolveStorageGeometry(env)` requires the
  `DATA_DIR`/`DATABASE_DIR`/`DATABASE_BACKUPS_DIR` triple and refuses collisions.
  New per-room canvas-v2 DBs go under `DATABASE_DIR/canvas-v2/`.
- `canvas-v2/convert.ts` — `fromTldraw(records): CanvasDocument` /
  `toTldraw(doc): records[]` (lossless, props by reference — **clone before
  mutating**). Shadow mode consumes `fromTldraw`.
- `features/canvas-v2.ts` — Agent API v2 **read** router (unchanged this phase).
- `app.ts` — `createSyncApp({dataDir, databaseDir, clientDist})`. Mounts routers,
  builds `ctx: PluginServerContext` (`{ rooms: roomHost, … }`), and owns the
  `server.on('upgrade')` handler that routes `/sync/:roomId` to
  `attachSyncSocket`. Your `/sync/v2/:roomId` branch and shadow wiring hook here.
- `TLSocketRoom` exposes `getCurrentSnapshot()`, `getCurrentDocumentClock():
  number` (monotonic — cheap change detection), `getNumActiveSessions()`, and a
  storage `onChange`/`onDataChange` hook. Shadow mode uses **clock polling** (see
  Seam D) to avoid coupling to a deprecated callback.

Test/house patterns to copy verbatim: `canvas-doc/src/crud.test.ts`,
`text.test.ts` (peerId bigints, `assert.deepEqual`, `console.log('ok: …')`),
`server/src/kernel/storage-geometry.test.ts` (server-side, `.ts` relative
imports, `assert.throws` with regex).

### Loro 1.13.6 sync API — verified against the installed typings

Types: `node_modules/loro-crdt/nodejs/loro_wasm.d.ts` and `index.d.ts`. **Open
them when in doubt; do not guess.** Confirmed primitives this phase uses:

```ts
import { LoroDoc, VersionVector, EphemeralStore, decodeImportBlobMeta } from 'loro-crdt'

// --- incremental export / import ---
doc.export({ mode: 'update', from?: VersionVector }): Uint8Array   // from omitted ⇒ whole history
doc.export({ mode: 'snapshot' }): Uint8Array
doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() }): Uint8Array  // GC compaction
doc.import(bytes): ImportStatus                    // { success: Map<PeerID,CounterSpan>, pending: Map|null }
doc.importBatch(bytes[]): ImportStatus
doc.oplogVersion(): VersionVector                  // current version — track "what I've sent"
doc.oplogFrontiers(): { peer: PeerID, counter: number }[]
doc.version(): VersionVector

// --- version vectors on the wire ---
new VersionVector(undefined)                       // empty (from-scratch)
VersionVector.decode(bytes): VersionVector
vv.encode(): Uint8Array
vv.compare(other): number | undefined              // undefined ⇒ concurrent/non-comparable

// --- the sync hook ---
doc.subscribeLocalUpdates((bytes: Uint8Array) => void): () => void  // fires with exact bytes to send
doc.subscribe((e: LoroEventBatch) => void): () => void             // e.by: 'local'|'import'|'checkout'

// --- presence ---
const store = new EphemeralStore(timeoutMs)        // default 30000; LWW per key, timeout expiry
store.set(key, value); store.get(key); store.delete(key)
store.getAllStates(): Record<string, Value>; store.keys(): string[]
store.encode(key): Uint8Array; store.encodeAll(): Uint8Array; store.apply(bytes): void
store.subscribe((e) => void): () => void           // e.by: 'local'|'import'|'timeout'; e.added/updated/removed
store.subscribeLocalUpdates((bytes) => void): () => void

// --- fuzzing guardrail ---
decodeImportBlobMeta(blob, checkChecksum): ImportBlobMetadata      // inspect before import
```

Notes that bite: `setPeerId` takes a **bigint**. `VersionVector` round-trips as
bytes via `encode`/`decode`. `import` **never throws on well-formed-but-stale**
input (returns `pending`); it **can throw on garbage** — Seam E2 pins that
behavior. `EphemeralStore` timeout is wall-clock inside WASM; in deterministic
tests either use a large timeout and assert LWW/merge (not expiry), or test
expiry in a dedicated non-deterministic-tagged case. `subscribeLocalUpdates`
returns bytes only for **committed local** ops — call `doc.commit()` first.

### The single boundary rule that keeps this clean

`canvas-sync` core imports only `canvas-model`, `canvas-doc`, `loro-crdt`. It
must be usable with an in-memory transport and no network. The `ws` dependency
and Express wiring live in `server`. Enforced by: `canvas-sync/package.json`
has no `ws`/`express`/`@tldraw/*` dep; a boundary test (Task B1) greps its `src`
for forbidden imports.

---

## Task 0: Preflight (no commit)

```bash
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase2
export PATH="$HOME/.bun/bin:$PATH"
git branch --show-current      # expect: canvas-phase2
bun --version                  # 1.3.14
node --version                 # v22.12.0
bun install
bun run typecheck              # expect exit 0, all workspaces
bun run test 2>&1 | tail -25   # establish the ACCEPTED BASELINE
```

**Record the baseline.** On this branch (off main, which now wires `discordTools`
into `allTools`) the Phase-1 `GET /api/discord/bindings` failure is expected to
be resolved and `bun run test` should be **fully green**. If any suite fails,
capture the exact failure — that failure, and only that failure, is your
accepted baseline for the rest of the phase. If typecheck fails, stop and report;
the worktree is not clean. No commit.

---

# Seam A — canvas-doc: full-document sync primitives + repair

Everything downstream (sync, actor, convergence rig) needs: (1) the *whole*
`CanvasDocument` — pages + bindings, not just shapes — inside the CRDT; (2)
incremental export/import keyed by version vectors; (3) a local-update hook; (4)
a deterministic repair pass. All four land here, TDD, in `canvas-model` /
`canvas-doc` only.

## Task A1: bindings + pages containers in LoroCanvasDoc

**Why:** merges only become "real" when the full document converges, and
`noDanglingBindings` repair needs bindings *in the doc*. Store bindings in a
top-level `LoroMap` keyed by binding id (design: "Bindings … a top-level map
keyed by binding id"); store pages in a top-level `LoroMap` keyed by page id.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (extend the interface)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (implement)
- Modify: `canvas-doc/src/bridge.ts` (`loadModel`/`dumpModel` carry pages+bindings)
- Create: `canvas-doc/src/bindings-pages.test.ts`

**Step 1 — failing test `canvas-doc/src/bindings-pages.test.ts`:**

```ts
// Run: bun src/bindings-pages.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { loadModel, dumpModel } from './bridge.js'
import { makeDocument } from '@ensembleworks/canvas-model'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const model = makeDocument({
  pages: [{ id: 'page:p', name: 'Page', index: 'a0' }],
  shapes: [
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:t', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [{ id: 'binding:1', fromId: 'shape:ar', toId: 'shape:t', props: { terminal: 'end' } }],
})

// --- loadModel round-trips pages + bindings, not just shapes ---
const doc = LoroCanvasDoc.create({ peerId: 1n })
loadModel(doc, model)
doc.commit()
const out = dumpModel(doc)
assert.deepEqual(out.pages.map((p) => p.id), ['page:p'])
assert.deepEqual(out.bindings.map((b) => b.id), ['binding:1'])
assert.equal(out.bindings[0]!.toId, 'shape:t')

// --- direct binding CRUD ---
doc.putBinding({ id: 'binding:2', fromId: 'shape:ar', toId: 'shape:t', props: {} })
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id).sort(), ['binding:1', 'binding:2'])
doc.deleteBinding('binding:1')
doc.commit()
assert.deepEqual(doc.listBindings().map((b) => b.id), ['binding:2'])

// --- pages + bindings survive a snapshot round-trip ---
const dst = LoroCanvasDoc.fromSnapshot(doc.exportSnapshot(), { peerId: 2n })
assert.deepEqual(dst.listPages().map((p) => p.id), ['page:p'])
assert.deepEqual(dst.listBindings().map((b) => b.id), ['binding:2'])

console.log('ok: bindings-pages')
```

**Step 2 — run, expect FAIL** (`doc.putBinding is not a function`):
```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase2
bun canvas-doc/src/bindings-pages.test.ts
```

**Step 3 — extend the interface** (`canvas-doc/src/canvas-doc.ts`), add after
the shape methods, before `exportSnapshot`:

```ts
import type { Binding, Page, Shape } from '@ensembleworks/canvas-model'
// …existing shape/text methods…
  /** Upsert a binding by id into the top-level bindings map. */
  putBinding(binding: Binding): void
  /** Silent no-op if the binding id is absent. */
  deleteBinding(id: string): void
  listBindings(): Binding[]
  /** Upsert a page by id into the top-level pages map. */
  putPage(page: Page): void
  deletePage(id: string): void
  listPages(): Page[]
```

**Step 4 — implement** in `canvas-doc/src/loro-canvas-doc.ts`. Add two container
accessors and the methods. Bindings/pages are plain `LoroMap`s (no tree
semantics). Store each record as a value under its id key.

```ts
import { LoroDoc, type LoroMap, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import type { Binding, Page, Shape } from '@ensembleworks/canvas-model'
// … in the class, alongside the tree:
  private bindings(): LoroMap { return this.doc.getMap('bindings') }
  private pages(): LoroMap { return this.doc.getMap('pages') }

  putBinding(b: Binding): void { this.bindings().set(b.id, b as any) }
  deleteBinding(id: string): void {
    const m = this.bindings()
    if (m.get(id) !== undefined) m.delete(id)
  }
  listBindings(): Binding[] {
    const m = this.bindings()
    return m.keys().map((k) => m.get(k) as Binding).filter(Boolean)
  }
  putPage(p: Page): void { this.pages().set(p.id, p as any) }
  deletePage(id: string): void {
    const m = this.pages()
    if (m.get(id) !== undefined) m.delete(id)
  }
  listPages(): Page[] {
    const m = this.pages()
    return m.keys().map((k) => m.get(k) as Page).filter(Boolean)
  }
```

> Loro `LoroMap.set` stores a deep-cloned plain value (verified by crud.test.ts's
> deep meta/props round-trip). Bindings/pages are plain data, so a whole-record
> `set` is correct and lossless. Keep `deleteBinding`/`deletePage` guarded
> (interface contract: silent no-op on absent id).

**Step 5 — update `bridge.ts`** so the full document round-trips:

```ts
export function loadModel(doc: LoroCanvasDoc, model: CanvasDocument): void {
  const ordered = topoByDepth(model)
  for (const s of ordered) doc.putShape(s)
  for (const s of ordered) doc.reparent(s.id, s.parentId)
  for (const p of model.pages) doc.putPage(p)
  for (const b of model.bindings) doc.putBinding(b)
}

export function dumpModel(doc: LoroCanvasDoc): CanvasDocument {
  return makeDocument({ pages: doc.listPages(), shapes: doc.listShapes(), bindings: doc.listBindings() })
}
```

**Step 6 — run (expect PASS), typecheck, commit:**
```bash
bun canvas-doc/src/bindings-pages.test.ts
bun run --filter '@ensembleworks/canvas-doc' typecheck
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/bridge.ts canvas-doc/src/bindings-pages.test.ts
git commit -m "$(cat <<'EOF'
feat(canvas-doc): bindings + pages containers so the full document round-trips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

## Task A2: incremental export/import keyed by version vectors

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (widen `exportUpdate`, add `version` +
  VV codec helpers)
- Modify: `canvas-doc/src/loro-canvas-doc.ts`
- Create: `canvas-doc/src/incremental.test.ts`

**Step 1 — failing test `canvas-doc/src/incremental.test.ts`:**

```ts
// Run: bun src/incremental.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
})

// Two peers converge via incremental updates, not full snapshots.
const a = LoroCanvasDoc.create({ peerId: 1n })
const b = LoroCanvasDoc.create({ peerId: 2n })

a.putShape(shape('shape:a1') as any); a.commit()
// b imports a's full history the first time (from = empty).
b.import(a.exportUpdate())
assert.deepEqual(b.listShapes().map((s) => s.id), ['shape:a1'])

// Capture b's version, then a makes a change; a exports ONLY the delta since b.
const bVersion = b.versionBytes()
a.putShape(shape('shape:a2') as any); a.commit()
const delta = a.exportUpdate(bVersion)
const status = b.import(delta)
b.commit()
assert.equal(status.pending, null, 'delta applied cleanly, nothing pending')
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:a1', 'shape:a2'])

// A delta computed against a stale version is smaller than the full history.
assert.ok(delta.byteLength < a.exportUpdate().byteLength, 'incremental delta < full history')

console.log('ok: incremental')
```

**Step 2 — run, expect FAIL** (`a.exportUpdate(bVersion)` arity / `versionBytes`
missing).

**Step 3 — extend the interface** (`canvas-doc.ts`):

```ts
  /**
   * Ops delta. With `sinceVersion` (bytes from another peer's versionBytes()),
   * exports only ops that peer is missing; without it, the whole history.
   */
  exportUpdate(sinceVersion?: Uint8Array): Uint8Array
  /** This doc's current oplog version, encoded for the wire (feed to a peer's exportUpdate). */
  versionBytes(): Uint8Array
```

Change `import`'s return type from `void` to `ImportStatus`:

```ts
import type { ImportStatus } from 'loro-crdt'
  import(bytes: Uint8Array): ImportStatus
```

**Step 4 — implement** (`loro-canvas-doc.ts`):

```ts
import { LoroDoc, VersionVector, type ImportStatus /* …existing… */ } from 'loro-crdt'
  exportUpdate(sinceVersion?: Uint8Array): Uint8Array {
    if (!sinceVersion) return this.doc.export({ mode: 'update' })
    const from = VersionVector.decode(sinceVersion)
    return this.doc.export({ mode: 'update', from })
  }
  versionBytes(): Uint8Array { return this.doc.oplogVersion().encode() }
  import(bytes: Uint8Array): ImportStatus { return this.doc.import(bytes) }
```

**Step 5 — run (PASS), typecheck, commit:**
```bash
bun canvas-doc/src/incremental.test.ts && bun run --filter '@ensembleworks/canvas-doc' typecheck
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/incremental.test.ts
git commit -m "$(printf 'feat(canvas-doc): incremental exportUpdate(sinceVersion) + versionBytes + ImportStatus\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

## Task A3: local-update subscription (the sync hook)

`subscribe(() => …)` fires on any change; sync needs the exact *local* bytes to
forward. Expose `subscribeLocalUpdates`.

**Files:** Modify `canvas-doc.ts` + `loro-canvas-doc.ts`; create
`canvas-doc/src/local-updates.test.ts`.

**Step 1 — failing test:**

```ts
// Run: bun src/local-updates.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string) => ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} })

const a = LoroCanvasDoc.create({ peerId: 1n })
const b = LoroCanvasDoc.create({ peerId: 2n })

// Forward a's local updates straight into b.
const unsub = a.subscribeLocalUpdates((bytes) => { b.import(bytes) })
a.putShape(shape('shape:x') as any); a.commit()
assert.deepEqual(b.listShapes().map((s) => s.id), ['shape:x'], 'local update forwarded to b')

// b's own imports must NOT echo back as a's local updates (no loop).
let aLocalFires = 0
a.subscribeLocalUpdates(() => { aLocalFires++ })
b.putShape(shape('shape:y') as any); b.commit()
assert.equal(aLocalFires, 0, 'a sees no local update from b activity')

unsub()
a.putShape(shape('shape:z') as any); a.commit()
assert.deepEqual(b.listShapes().map((s) => s.id).sort(), ['shape:x'], 'no forwarding after unsub')

console.log('ok: local-updates')
```

**Step 2 — run, expect FAIL.** **Step 3 — interface:**
`subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void`.
**Implement:** `return this.doc.subscribeLocalUpdates(listener)`.

**Step 4 — run PASS, typecheck, commit:**
```bash
git commit -m "$(printf 'feat(canvas-doc): subscribeLocalUpdates — the local-bytes sync hook\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

## Task A4: deterministic repair pass

Pure `repairPlan(doc): RepairOp[]` in **canvas-model** (determinism rule);
`canvas-doc.repair()` applies it. Repair must be a *pure function of the
converged model* so every peer computes the identical plan → identical result.

Repair semantics (deterministic, input-order stable):
- `noOrphans` (parent id names nothing) → `reparentToRoot` (move to page root =
  Loro `undefined` parent). Do NOT invent a page.
- `noCycles`: Loro's movable tree resolves cycles natively at merge time, so the
  Loro-backed doc's tree cannot actually hold a cycle — but the *model* check
  can flag one during shadow conversion of malformed input. Repair =
  `reparentToRoot` the flagged shape. (Its presence in the plan is what the
  convergence rig asserts against post-repair.)
- `noDanglingBindings` (endpoint shape absent) → `deleteBinding`.
- `validProps` (envelope/props fail schema) → `dropShape` (quarantine: remove the
  invalid shape; log its id). Cascades via `deleteShape`.

**Files:**
- Create: `canvas-model/src/repair.ts` + `canvas-model/src/repair.test.ts`
- Modify: `canvas-model/src/index.ts` (`export * from './repair.js'`)
- Modify: `canvas-doc/src/canvas-doc.ts` + `loro-canvas-doc.ts` (`repair()`)
- Create: `canvas-doc/src/repair.test.ts`

**Step 1 — failing test `canvas-model/src/repair.test.ts`:**

```ts
// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { repairPlan } from './repair.js'
import { checkInvariants } from './invariants.js'
import { applyRepairToModel } from './repair.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })

// Orphan → reparentToRoot; dangling binding → deleteBinding; invalid → dropShape.
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:ok', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
    { id: 'shape:orphan', kind: 'note', parentId: 'shape:ghost', props: {}, ...base() } as any,
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any,
    { id: 'shape:bad', kind: 'note', parentId: 'page:p', opacity: 'no' as any, props: {}, ...base() } as any,
  ],
  bindings: [{ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {} }],
})

const plan = repairPlan(doc)
// Deterministic, sorted by (op, id): stable across peers.
assert.deepEqual(plan, [
  { op: 'deleteBinding', id: 'binding:d' },
  { op: 'dropShape', id: 'shape:bad' },
  { op: 'reparentToRoot', id: 'shape:orphan' },
])

// Applying the plan to the model yields an invariant-clean document (idempotent).
const repaired = applyRepairToModel(doc, plan)
assert.deepEqual(checkInvariants(repaired), [])
assert.deepEqual(repairPlan(repaired), [], 'repair is idempotent — a repaired doc needs no repair')

console.log('ok: repair (model)')
```

**Step 2 — run, expect FAIL.** **Step 3 — implement `canvas-model/src/repair.ts`:**

```ts
import { type CanvasDocument, makeDocument } from './document.js'
import { checkInvariants, type InvariantRule } from './invariants.js'

export type RepairOp =
  | { op: 'reparentToRoot'; id: string }   // orphan or cycle member → page root
  | { op: 'deleteBinding'; id: string }     // dangling binding
  | { op: 'dropShape'; id: string }         // invalid envelope/props (quarantine)

// Pure: identical input ⇒ identical plan on every peer. Sorted by (op,id) so the
// order is stable regardless of input order or which peer computes it.
export function repairPlan(doc: CanvasDocument): RepairOp[] {
  const seen = new Set<string>()
  const ops: RepairOp[] = []
  for (const v of checkInvariants(doc)) {
    const key = `${v.rule}:${v.id}`
    if (seen.has(key)) continue
    seen.add(key)
    ops.push(opFor(v.rule, v.id))
  }
  const rank: Record<RepairOp['op'], number> = { deleteBinding: 0, dropShape: 1, reparentToRoot: 2 }
  // Dedup: an invalid shape flagged both validProps and noOrphans drops (dropShape wins over reparent).
  const byId = new Map<string, RepairOp>()
  for (const o of ops) {
    const prev = byId.get(o.id)
    if (!prev || rank[o.op] < rank[prev.op]) byId.set(o.id, o)
  }
  return [...byId.values()].sort((a, b) => rank[a.op] - rank[b.op] || a.id.localeCompare(b.id))
}

function opFor(rule: InvariantRule, id: string): RepairOp {
  switch (rule) {
    case 'noOrphans':
    case 'noCycles': return { op: 'reparentToRoot', id }
    case 'noDanglingBindings': return { op: 'deleteBinding', id }
    case 'validProps': return { op: 'dropShape', id }
  }
}

// Reference application on the pure model (used by tests and the convergence rig
// to compute the expected post-repair state). canvas-doc applies the same plan
// to Loro; both must agree.
export function applyRepairToModel(doc: CanvasDocument, plan: RepairOp[]): CanvasDocument {
  const drop = new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id))
  const toRoot = new Set(plan.filter((o) => o.op === 'reparentToRoot').map((o) => o.id))
  const delBind = new Set(plan.filter((o) => o.op === 'deleteBinding').map((o) => o.id))
  // Drop invalid shapes AND their descendants (cascade).
  const dropAll = new Set(drop)
  let grew = true
  while (grew) {
    grew = false
    for (const s of doc.shapes) if (!dropAll.has(s.id) && dropAll.has(s.parentId)) { dropAll.add(s.id); grew = true }
  }
  const pageId = doc.pages[0]?.id ?? 'page:orphans'
  const shapes = doc.shapes
    .filter((s) => !dropAll.has(s.id))
    .map((s) => (toRoot.has(s.id) ? { ...s, parentId: pageId } : s))
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !dropAll.has(b.fromId) && !dropAll.has(b.toId))
  return makeDocument({ pages: doc.pages, shapes, bindings })
}
```

> `applyRepairToModel` re-roots to `doc.pages[0]` — the model's canonical page.
> In `canvas-doc.repair()` "root" is Loro's `undefined` parent (the tree root =
> the page), so the two representations agree after `dumpModel` fills `parentId`
> from `data.parentId`. The convergence rig (E1) asserts `dumpModel(repair(loro))`
> equals `applyRepairToModel(model, repairPlan(model))` up to page-root parentId.

**Step 4 — run PASS**, add `export * from './repair.js'` to
`canvas-model/src/index.ts`, `bun run --filter '@ensembleworks/canvas-model'
typecheck`, commit:
```bash
git commit -m "$(printf 'feat(canvas-model): deterministic repairPlan + reference model application\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

**Step 5 — canvas-doc `repair()`. Failing test `canvas-doc/src/repair.test.ts`:**

```ts
// Run: bun src/repair.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { checkInvariants } from '@ensembleworks/canvas-model'
import { dumpModel } from './bridge.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putPage({ id: 'page:p', name: 'P' })
doc.putShape({ id: 'shape:ar', kind: 'arrow', parentId: 'page:p', props: {}, ...base() } as any)
// A dangling binding: toId points at a shape that never existed.
doc.putBinding({ id: 'binding:d', fromId: 'shape:ar', toId: 'shape:gone', props: {} })
doc.commit()
assert.ok(checkInvariants(dumpModel(doc)).some((v) => v.rule === 'noDanglingBindings'))

const applied = doc.repair()   // returns the plan it applied
doc.commit()
assert.deepEqual(applied.map((o) => o.op), ['deleteBinding'])
assert.deepEqual(checkInvariants(dumpModel(doc)), [], 'doc is invariant-clean after repair')
assert.deepEqual(doc.repair(), [], 'repair is idempotent on a clean doc')

console.log('ok: repair (doc)')
```

**Step 6 — implement `repair()`** on `LoroCanvasDoc` (interface method returning
`RepairOp[]`):

```ts
import { repairPlan, type RepairOp } from '@ensembleworks/canvas-model'
import { dumpModel } from './bridge.js'   // NOTE: bridge imports loro-canvas-doc → put repair() logic to avoid a cycle
```

To avoid a bridge↔impl import cycle, compute the model inline from the doc's own
lists rather than importing `dumpModel`:

```ts
  repair(): RepairOp[] {
    const model = makeDocument({ pages: this.listPages(), shapes: this.listShapes(), bindings: this.listBindings() })
    const plan = repairPlan(model)
    for (const o of plan) {
      if (o.op === 'deleteBinding') this.deleteBinding(o.id)
      else if (o.op === 'dropShape') this.deleteShape(o.id)          // cascade + text cleanup
      else if (o.op === 'reparentToRoot') {
        const pageId = model.pages[0]?.id ?? 'page:orphans'
        this.reparent(o.id, pageId)                                   // page id ⇒ Loro root
      }
    }
    return plan
  }
```

(Import `makeDocument` from `@ensembleworks/canvas-model` at the top of
`loro-canvas-doc.ts`.) Add `repair(): RepairOp[]` to the `CanvasDoc` interface.

**Step 7 — run PASS, typecheck, commit:**
```bash
bun canvas-doc/src/repair.test.ts && bun run --filter '@ensembleworks/canvas-doc' typecheck
git commit -m "$(printf 'feat(canvas-doc): repair() applies the deterministic repairPlan to the Loro doc\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

# Seam B — the canvas-sync workspace (clean-room, transport-agnostic)

## Task B1: scaffold `canvas-sync` + boundary test

**Files:**
- Create: `canvas-sync/package.json`, `canvas-sync/tsconfig.json`,
  `canvas-sync/test.ts`, `canvas-sync/src/index.ts`,
  `canvas-sync/src/version.test.ts`, `canvas-sync/src/boundary.test.ts`
- Modify: root `package.json` (`workspaces` + `typecheck`)

**`canvas-sync/package.json`:**
```json
{
  "name": "@ensembleworks/canvas-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "bunx tsc --noEmit", "test": "bun test.ts" },
  "dependencies": {
    "@ensembleworks/canvas-model": "*",
    "@ensembleworks/canvas-doc": "*",
    "loro-crdt": "1.13.6"
  },
  "devDependencies": { "@types/node": "^22.0.0", "bun-types": "1.3.14", "typescript": "^5.7.0" }
}
```

`canvas-sync/tsconfig.json` — identical to `canvas-doc/tsconfig.json`.
`canvas-sync/test.ts` — copy `canvas-doc/test.ts` verbatim (the per-package
house runner). `canvas-sync/src/index.ts`:
```ts
// @ensembleworks/canvas-sync — Loro update exchange + presence over an injected
// transport. Clean-room: imports only canvas-model, canvas-doc, loro-crdt.
// Never imports ws/express/server/tldraw; no DOM. Determinism: no Date.now/
// Math.random — clock/ids/PRNG injected.
export const CANVAS_SYNC_VERSION = 1 as const
```
`canvas-sync/src/version.test.ts` — trivial (mirror canvas-model's).

**`canvas-sync/src/boundary.test.ts`** (enforces the design's one rule):
```ts
// Run: bun src/boundary.test.ts
import assert from 'node:assert/strict'
import { Glob } from 'bun'

const FORBIDDEN = [/from ['"]ws['"]/, /from ['"]express['"]/, /@tldraw\//, /from ['"](\.\.\/)*server/, /Date\.now\(/, /Math\.random\(/]
const glob = new Glob('src/**/*.ts')
for await (const f of glob.scan({ cwd: import.meta.dirname, onlyFiles: true })) {
  if (f.endsWith('.test.ts')) continue           // tests may inject/measure freely
  const text = await Bun.file(`${import.meta.dirname}/${f}`).text()
  for (const re of FORBIDDEN) assert.ok(!re.test(text), `${f} violates clean-room boundary: ${re}`)
}
console.log('ok: boundary')
```

**Wire root `package.json`:** add `"canvas-sync"` after `"canvas-doc"` in
`workspaces`; append to `typecheck`
`&& bun run --filter '@ensembleworks/canvas-sync' typecheck` right after the
canvas-doc entry.

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase2
bun install
bun run --filter '@ensembleworks/canvas-sync' typecheck   # exit 0
bun run --filter '@ensembleworks/canvas-sync' test        # "all N suites passed"
git add canvas-sync package.json bun.lock
git commit -m "$(printf 'feat(canvas-sync): scaffold clean-room sync workspace + boundary test\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

## Task B2: the wire protocol + Transport interface

Define the message frames and the transport seam. Keep it tiny: three message
kinds. Encode as tagged binary (1 tag byte + payload) so raw Loro bytes ride
without JSON base64 bloat.

**Files:** Create `canvas-sync/src/protocol.ts` + `canvas-sync/src/protocol.test.ts`.

**Protocol (`protocol.ts`):**
```ts
// Wire frames between a client peer and the room server peer. All payloads are
// raw bytes (Loro updates / version vectors / ephemeral encodings). Framing is a
// single tag byte + payload — no JSON, so Loro's binary rides intact.
export const enum Frame { Update = 1, Presence = 2, SyncRequest = 3 }

export interface Transport {
  send(bytes: Uint8Array): void
  onMessage(cb: (bytes: Uint8Array) => void): void
  onClose(cb: () => void): void
  close(): void
}

export function encode(tag: Frame, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1)
  out[0] = tag
  out.set(payload, 1)
  return out
}
export function decode(frame: Uint8Array): { tag: Frame; payload: Uint8Array } {
  if (frame.length < 1) throw new Error('empty frame')
  return { tag: frame[0] as Frame, payload: frame.subarray(1) }
}
```

**Test `protocol.test.ts`:** round-trip each `Frame` through `encode`/`decode`;
assert `decode(new Uint8Array(0))` throws; assert an empty-payload Update
round-trips (payload length 0). `console.log('ok: protocol')`. Commit
`feat(canvas-sync): wire protocol + Transport interface`.

Also create an **in-memory transport pair** for tests (deterministic, synchronous
delivery so no timers):

**`canvas-sync/src/memory-transport.ts`:**
```ts
import type { Transport } from './protocol.js'
// A synchronous, loss-free, in-order transport pair for deterministic tests.
// makePair() returns [a, b]; bytes sent on a arrive on b's onMessage, same tick.
export function makePair(): [Transport, Transport] {
  let aMsg: ((b: Uint8Array) => void) | null = null
  let bMsg: ((b: Uint8Array) => void) | null = null
  let aClose: (() => void) | null = null
  let bClose: (() => void) | null = null
  let open = true
  const a: Transport = {
    send: (bytes) => { if (open) bMsg?.(bytes) },
    onMessage: (cb) => { aMsg = cb }, onClose: (cb) => { aClose = cb },
    close: () => { if (open) { open = false; aClose?.(); bClose?.() } },
  }
  const b: Transport = {
    send: (bytes) => { if (open) aMsg?.(bytes) },
    onMessage: (cb) => { bMsg = cb }, onClose: (cb) => { bClose = cb },
    close: () => { if (open) { open = false; aClose?.(); bClose?.() } },
  }
  return [a, b]
}
```
Include a `memory-transport.test.ts` proving a→b and b→a delivery and that
`close()` fires both `onClose`s once. Commit with the protocol.

## Task B3: `SyncClientPeer` (headless client half)

Owns a `LoroCanvasDoc`, forwards committed local updates, applies remote updates,
and on (re)connect sends a `SyncRequest` (its `versionBytes`) so the server
replies with exactly the delta it's missing (rebase).

**Files:** Create `canvas-sync/src/client-peer.ts` + `client-peer.test.ts`.

**`client-peer.ts`:**
```ts
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import { Frame, type Transport, decode, encode } from './protocol.js'

export interface SyncClientOpts { peerId: bigint; transport: Transport }

// Headless sync client. No renderer (Phase 3): callers mutate via the doc and
// read listShapes()/dumpModel(). Repair runs after every remote merge so this
// peer converges to the same repaired state as every other.
export class SyncClientPeer {
  readonly doc: LoroCanvasDoc
  private unsubLocal: () => void
  constructor(private opts: SyncClientOpts) {
    this.doc = LoroCanvasDoc.create({ peerId: opts.peerId })
    // Forward committed local ops.
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => opts.transport.send(encode(Frame.Update, bytes)))
    opts.transport.onMessage((frame) => this.onFrame(frame))
    opts.transport.onClose(() => {})
    // Ask the server for anything we're missing.
    this.requestSync()
  }
  /** (Re)connect handshake: tell the server our version so it sends only the delta. */
  requestSync(): void { this.opts.transport.send(encode(Frame.SyncRequest, this.doc.versionBytes())) }
  private onFrame(frame: Uint8Array): void {
    const { tag, payload } = decode(frame)
    if (tag === Frame.Update) { this.doc.import(payload); this.doc.repair(); this.doc.commit() }
    // Presence handled in B5.
  }
  putShape(s: Shape): void { this.doc.putShape(s); this.doc.commit() }
  close(): void { this.unsubLocal(); this.opts.transport.close() }
}
```

**`client-peer.test.ts`:** wire two clients to a single `SyncServerPeer` (B4) via
two in-memory pairs; put a shape on client A; assert it appears on client B after
delivery; then disconnect B, mutate on A, reconnect B (new transport +
`requestSync`) and assert B catches up. (This test depends on B4 — write B4
first, or stub the server side; the plan orders B4 before finalizing this test.)

## Task B4: `SyncServerPeer` (authoritative room half)

Holds the room's `LoroCanvasDoc`, tracks each connected client, on `SyncRequest`
replies with `exportUpdate(theirVersion)`, and on a client `Update` imports it,
runs repair, then broadcasts the resulting local delta to *other* clients.

**Files:** Create `canvas-sync/src/server-peer.ts` + `server-peer.test.ts`.

**`server-peer.ts`:**
```ts
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { Frame, type Transport, decode, encode } from './protocol.js'

export interface SyncServerOpts { peerId: bigint; initialSnapshot?: Uint8Array }

// One authoritative peer per room. Transport-agnostic: server.connect(transport)
// registers a client; the server never imports ws. Every merge is followed by
// repair so the server's converged state is canonical.
export class SyncServerPeer {
  readonly doc: LoroCanvasDoc
  private clients = new Set<Transport>()
  private unsubLocal: () => void
  constructor(opts: SyncServerOpts) {
    this.doc = opts.initialSnapshot
      ? LoroCanvasDoc.fromSnapshot(opts.initialSnapshot, { peerId: opts.peerId })
      : LoroCanvasDoc.create({ peerId: opts.peerId })
    // When the server's own doc changes (e.g. repair, or an agent write), push
    // the delta to every client.
    this.unsubLocal = this.doc.subscribeLocalUpdates((bytes) => this.broadcast(encode(Frame.Update, bytes), null))
  }
  connect(t: Transport): void {
    this.clients.add(t)
    t.onMessage((frame) => this.onFrame(t, frame))
    t.onClose(() => this.clients.delete(t))
  }
  private onFrame(from: Transport, frame: Uint8Array): void {
    const { tag, payload } = decode(frame)
    if (tag === Frame.SyncRequest) {
      // Reply with exactly the delta this client is missing.
      from.send(encode(Frame.Update, this.doc.exportUpdate(payload)))
    } else if (tag === Frame.Update) {
      this.doc.import(payload)
      this.doc.repair()
      this.doc.commit()                 // fires subscribeLocalUpdates → broadcast to others
      // Also relay the raw client delta to peers other than the sender (so peers
      // converge even on ops that produced no server-local repair delta).
      this.broadcast(frame, from)
    }
  }
  private broadcast(frame: Uint8Array, except: Transport | null): void {
    for (const c of this.clients) if (c !== except) c.send(frame)
  }
  snapshot(): Uint8Array { return this.doc.exportSnapshot() }
}
```

**`server-peer.test.ts`:** two clients + one server, all via in-memory pairs.
Put on A → assert on server and on B (byte-identical `dumpModel`). Concurrent:
buffer A's and B's updates, deliver in *both* orders to two fresh server+client
sets, assert the two servers reach byte-identical snapshots (converge regardless
of delivery order). Assert repair leaves no violations. Commit
`feat(canvas-sync): server + client peers with sync-request rebase`.

> Convergence note: Loro is order-independent by construction, so importing the
> same set of updates in any order yields the same state; the tests *pin* that
> and pin that repair does not break it. The heavy randomized version is E1.

## Task B5: presence over EphemeralStore

**Files:** Create `canvas-sync/src/presence.ts` + `presence.test.ts`; wire a
`Frame.Presence` branch into both peers.

**`presence.ts`:**
```ts
import { EphemeralStore } from 'loro-crdt'

// The presence payload one peer publishes about itself. No renderer yet
// (Phase 3), so this is the wire contract, exercised headlessly. Values are
// plain JSON (EphemeralStore requires Loro Values).
export interface Presence {
  cursor: { x: number; y: number } | null
  viewport: { x: number; y: number; w: number; h: number; z: number } | null
  stamp: { at: { x: number; y: number } } | null   // the spatial stamp (see server presence.ts)
  presenting: string[]                              // shape ids this peer is presenting/holding
}

// Thin wrapper: one EphemeralStore, this peer writes its own key, reads all.
// LWW per key + timeout expiry are Loro's; we only encode/apply on the wire.
export class PresenceStore {
  private store: EphemeralStore
  constructor(private selfKey: string, timeoutMs = 30_000) { this.store = new EphemeralStore(timeoutMs) }
  publish(p: Presence): void { this.store.set(this.selfKey, p as any) }
  all(): Record<string, Presence> { return this.store.getAllStates() as any }
  /** Bytes to broadcast after a local publish (wire via Frame.Presence). */
  onLocalUpdate(cb: (bytes: Uint8Array) => void): () => void { return this.store.subscribeLocalUpdates(cb) }
  apply(bytes: Uint8Array): void { this.store.apply(bytes) }
  encodeAll(): Uint8Array { return this.store.encodeAll() }
}
```

**`presence.test.ts`:** two `PresenceStore`s; wire A's `onLocalUpdate` → B.apply
and vice versa. A publishes a cursor; assert `B.all()[aKey].cursor` matches.
Both publish under different keys → both see two entries (merge). Same key
published twice → LWW keeps the latest (assert value). **Do not assert timeout
expiry** in the deterministic suite (wall-clock); if you want an expiry test,
put it in a clearly-separated block with a tiny timeout and an `await
Bun.sleep`, and tag it in a comment as timing-dependent. Commit
`feat(canvas-sync): presence over Loro EphemeralStore (cursor/viewport/stamp/presenting)`.

Then extend `SyncClientPeer`/`SyncServerPeer`: on a local presence publish, send
`Frame.Presence`; on receiving one, `presence.apply(payload)` and re-broadcast
(server) — mirroring the Update path. Add a peer-level presence test.

---

# Seam C — room-host document actor in `server`

One Loro doc per room, persisted to its own SQLite (append-log + snapshots),
crash-recoverable, wrapped around a `SyncServerPeer`. Not user-facing.

## Task C1: append-log store (`CanvasV2Store`)

**Files:** Create `server/src/canvas-v2/store.ts` + `store.test.ts`.

Schema (one DB per room under `DATABASE_DIR/canvas-v2/<roomId>.sqlite`):
```
CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY CHECK (id = 0), bytes BLOB NOT NULL, upto_seq INTEGER NOT NULL);
```

**`store.ts`** (reuse `DatabaseSync` from `kernel/sqlite.ts` — WAL, crash-safe):
```ts
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from '../kernel/sqlite.ts'

export interface LoadedState { snapshot: Uint8Array | null; updates: Uint8Array[] }

export class CanvasV2Store {
  private db: DatabaseSync
  constructor(dir: string, roomId: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, `${roomId}.sqlite`))
    this.db.exec('CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, bytes BLOB NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY CHECK (id = 0), bytes BLOB NOT NULL, upto_seq INTEGER NOT NULL)')
  }
  appendUpdate(bytes: Uint8Array): void {
    this.db.prepare('INSERT INTO updates (bytes) VALUES (?)').run(bytes)
  }
  load(): LoadedState {
    const snapRow = this.db.prepare('SELECT bytes, upto_seq FROM snapshots WHERE id = 0').all()[0] as any
    const snapshot = snapRow ? new Uint8Array(snapRow.bytes) : null
    const uptoSeq = snapRow ? Number(snapRow.upto_seq) : 0
    const rows = this.db.prepare('SELECT bytes FROM updates WHERE seq > ? ORDER BY seq ASC').all(uptoSeq) as any[]
    return { snapshot, updates: rows.map((r) => new Uint8Array(r.bytes)) }
  }
  /** Compaction: persist a fresh snapshot and prune folded-in updates. */
  compact(snapshot: Uint8Array): void {
    const maxSeq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM updates').all()[0] as any).m)
    this.db.prepare('INSERT INTO snapshots (id, bytes, upto_seq) VALUES (0, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, upto_seq = excluded.upto_seq').run(snapshot, maxSeq)
    this.db.prepare('DELETE FROM updates WHERE seq <= ?').run(maxSeq)
  }
}
```

**`store.test.ts`:** create store in a `mkdtempSync` dir; append three updates;
`load()` returns null snapshot + 3 updates; `compact(snap)` then `load()`
returns the snapshot + 0 updates; append one more, `load()` returns snapshot + 1
update. Reopen the store on the same file (new instance) and assert `load()` is
identical (persistence). Set env `DATABASE_DIR` is not needed — pass the dir
directly. Clean up the temp dir. Commit
`feat(server): CanvasV2Store — per-room append-log + snapshot SQLite`.

## Task C2: `DocumentActor` (Loro doc + persistence + peer)

**Files:** Create `server/src/canvas-v2/actor.ts` + `actor.test.ts`.

The actor: loads state (snapshot + replay updates) into a `LoroCanvasDoc`, wraps
a `SyncServerPeer` around it, appends every committed local update to the store,
and compacts on a threshold (update count) — deterministic, no timers in core
(the caller drives compaction, or an injected interval in the server wiring).

```ts
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { SyncServerPeer } from '@ensembleworks/canvas-sync'
import type { Transport } from '@ensembleworks/canvas-sync'
import { CanvasV2Store } from './store.ts'

export interface ActorOpts { dir: string; roomId: string; peerId: bigint; compactEvery?: number }

export class DocumentActor {
  readonly peer: SyncServerPeer
  private store: CanvasV2Store
  private sinceCompaction = 0
  private compactEvery: number
  constructor(opts: ActorOpts) {
    this.store = new CanvasV2Store(opts.dir, opts.roomId)
    this.compactEvery = opts.compactEvery ?? 500
    const { snapshot, updates } = this.store.load()
    // Rebuild the peer's doc from persisted state.
    const doc = snapshot
      ? LoroCanvasDoc.fromSnapshot(snapshot, { peerId: opts.peerId })
      : LoroCanvasDoc.create({ peerId: opts.peerId })
    for (const u of updates) doc.import(u)
    doc.commit()
    this.peer = new SyncServerPeer({ peerId: opts.peerId, initialSnapshot: doc.exportSnapshot() })
    // Persist every committed local update; compact past the threshold.
    this.peer.doc.subscribeLocalUpdates((bytes) => {
      this.store.appendUpdate(bytes)
      if (++this.sinceCompaction >= this.compactEvery) this.compact()
    })
  }
  connect(t: Transport): void { this.peer.connect(t) }
  compact(): void { this.store.compact(this.peer.snapshot()); this.sinceCompaction = 0 }
}
```

**`actor.test.ts`:** in a temp dir, create actor, connect an in-memory client,
put shapes, assert they persist (open a second store on the same file →
`load()` non-empty). **Crash recovery within this test:** drop the actor
reference, create a *fresh* `DocumentActor` on the same dir/roomId, connect a
fresh client with `requestSync`, assert the client receives the shapes (state
replayed from the append-log). Assert compaction: set `compactEvery: 3`, push 3+
updates, assert `store.load().updates.length` is small and a snapshot exists.
Commit `feat(server): DocumentActor — persisted, crash-recoverable room doc`.

## Task C3: `ws` transport adapter + gated `/sync/v2` mount

**Files:** Create `server/src/canvas-v2/ws-transport.ts` + a small
`ws-transport.test.ts`; modify `server/src/app.ts` (gated branch) and add a
`DocumentActor` registry to the room host or a sibling.

**`ws-transport.ts`** (the ONLY place bridging `ws` ↔ the clean-room Transport):
```ts
import type { WebSocket } from 'ws'
import type { Transport } from '@ensembleworks/canvas-sync'

export function wsTransport(ws: WebSocket): Transport {
  return {
    send: (bytes) => { if (ws.readyState === ws.OPEN) ws.send(bytes) },
    onMessage: (cb) => ws.on('message', (data: Buffer) => cb(new Uint8Array(data))),
    onClose: (cb) => ws.once('close', cb),
    close: () => ws.close(),
  }
}
```

**`app.ts` mount** (inside `server.on('upgrade')`, add a branch BEFORE the
existing `/sync/:roomId` match, guarded by an env flag so real users never hit
it):
```ts
// Phase 2: new-engine sync, OFF by default (zero user exposure). Rigs set the flag.
if (process.env.EW_CANVAS_SYNC === '1') {
  const v2 = url.pathname.match(/^\/sync\/v2\/([^/]+)$/)
  if (v2) {
    const roomId = sanitizeId(v2[1]!)
    if (!roomId) { socket.destroy(); return }
    ;(socket as Socket).setNoDelay(true)
    wss.handleUpgrade(req, socket, head, (ws) => {
      canvasActors.getOrCreate(roomId).connect(wsTransport(ws))
    })
    return
  }
}
```
Create a `canvasActors` registry (`server/src/canvas-v2/actors.ts`:
`getOrCreate(roomId)` → memoized `DocumentActor` using
`path.join(databaseDir, 'canvas-v2')`, peerId derived deterministically e.g. a
fixed server peerId `1n` per process). Add it to `createSyncApp` next to
`roomHost`.

`ws-transport.test.ts`: a minimal fake `ws`-like object (an EventEmitter with
`send`/`readyState`/`close`) — assert `send` forwards, `onMessage` maps a Buffer
to `Uint8Array`, `onClose` fires once. Commit
`feat(server): ws Transport adapter + env-gated /sync/v2 mount (off by default)`.

> This branch is `EW_CANVAS_SYNC`-gated and never referenced by the client build,
> so it adds no user-facing surface. It is NOT an `/api` route, so the tools-api
> completeness test is unaffected.

---

# Seam D — shadow mode

Continuously mirror every live tldraw room into its new-engine Loro doc, detect
divergence, surface metrics. Zero user exposure.

## Task D1: reconcile — apply a `CanvasDocument` diff into a `LoroCanvasDoc`

Shadow mode converts the tldraw snapshot to a model each tick; applying the whole
model every time via `loadModel` would churn the CRDT. Add a pure-ish reconcile
that computes and applies only the diff.

**Files:** Create `server/src/canvas-v2/reconcile.ts` + `reconcile.test.ts`.

```ts
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import type { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { dumpModel } from '@ensembleworks/canvas-doc'

// Bring `doc` (Loro) into line with `target` (freshly converted from tldraw),
// touching only what changed. Returns a small change summary for metrics.
export function reconcile(doc: LoroCanvasDoc, target: CanvasDocument): { puts: number; deletes: number } {
  const current = dumpModel(doc)
  const curShapes = new Map(current.shapes.map((s) => [s.id, s]))
  const tgtShapes = new Map(target.shapes.map((s) => [s.id, s]))
  let puts = 0, deletes = 0
  // Deletes first (frees parents), then puts in topo order so parents exist.
  for (const id of curShapes.keys()) if (!tgtShapes.has(id)) { doc.deleteShape(id); deletes++ }
  const ordered = [...tgtShapes.values()].sort((a, b) => depth(target, a.id) - depth(target, b.id))
  for (const s of ordered) {
    const prev = curShapes.get(s.id)
    if (!prev || !shallowEqualShape(prev, s)) { doc.putShape(s); puts++ }
  }
  // Pages + bindings (whole-record upsert/delete; small sets).
  const curP = new Map(current.pages.map((p) => [p.id, p])), tgtP = new Map(target.pages.map((p) => [p.id, p]))
  for (const id of curP.keys()) if (!tgtP.has(id)) doc.deletePage(id)
  for (const p of tgtP.values()) doc.putPage(p)
  const curB = new Map(current.bindings.map((b) => [b.id, b])), tgtB = new Map(target.bindings.map((b) => [b.id, b]))
  for (const id of curB.keys()) if (!tgtB.has(id)) doc.deleteBinding(id)
  for (const b of tgtB.values()) doc.putBinding(b)
  doc.commit()
  return { puts, deletes }
}

function depth(doc: CanvasDocument, id: string, g = 0): number {
  const s = doc.byId.get(id)
  if (!s || !s.parentId.startsWith('shape:') || g > 50) return 0
  return 1 + depth(doc, s.parentId, g + 1)
}
function shallowEqualShape(a: any, b: any): boolean {
  return a.parentId === b.parentId && a.index === b.index && a.x === b.x && a.y === b.y &&
    a.rotation === b.rotation && a.isLocked === b.isLocked && a.opacity === b.opacity &&
    JSON.stringify(a.props) === JSON.stringify(b.props) && JSON.stringify(a.meta) === JSON.stringify(b.meta)
}
```

**`reconcile.test.ts`:** start with an empty Loro doc; reconcile a 3-shape+1-page
model → assert `dumpModel` matches and summary `{puts:3}`; reconcile the same
model again → `{puts:0, deletes:0}` (idempotent, the divergence-free steady
state); move a shape and add one → assert `{puts:2}` and the deleted-shape case.
Commit `feat(server): reconcile a converted CanvasDocument into a Loro doc (diff-only)`.

## Task D2: `ShadowMirror` + divergence detection

**Files:** Create `server/src/canvas-v2/shadow.ts` + `shadow.test.ts`.

Per room: keep a `LoroCanvasDoc`; on each tick (driven by clock change), convert
the tldraw snapshot and `reconcile`; every Nth tick, compare `dumpModel(loro)`
against `fromTldraw(snapshot)` and count divergences.

```ts
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { fromTldraw } from './convert.ts'
import { reconcile } from './reconcile.ts'
import { checkInvariants, type CanvasDocument } from '@ensembleworks/canvas-model'

export interface ShadowMetrics {
  ticks: number; puts: number; deletes: number
  divergences: number; lastDivergence: string | null
  shapeCount: number; snapshotBytes: number
}

// A room's shadow mirror. `getRecords` returns the live tldraw records
// (ctx.rooms.getOrCreateRoom(roomId).getCurrentSnapshot().documents.map(d => d.state)).
export class ShadowMirror {
  readonly doc: LoroCanvasDoc
  private m: ShadowMetrics = { ticks: 0, puts: 0, deletes: 0, divergences: 0, lastDivergence: null, shapeCount: 0, snapshotBytes: 0 }
  constructor(private roomId: string, peerId: bigint, private getRecords: () => any[], private checkEvery = 20) {
    this.doc = LoroCanvasDoc.create({ peerId })
  }
  tick(): void {
    const target = fromTldraw(this.getRecords())
    const { puts, deletes } = reconcile(this.doc, target)
    this.m.ticks++; this.m.puts += puts; this.m.deletes += deletes
    if (this.m.ticks % this.checkEvery === 0) this.checkDivergence(target)
    this.m.shapeCount = this.doc.listShapes().length
    this.m.snapshotBytes = this.doc.exportSnapshot().byteLength
  }
  private checkDivergence(target: CanvasDocument): void {
    const mirror = dumpModel(this.doc)
    const d = diverges(mirror, target)
    if (d) { this.m.divergences++; this.m.lastDivergence = d; console.warn(`[shadow ${this.roomId}] divergence: ${d}`) }
    // Repair-firing in the mirror is itself a signal (design: prod repair = escaped bug).
    const violations = checkInvariants(mirror)
    if (violations.length) console.warn(`[shadow ${this.roomId}] ${violations.length} invariant violations`)
  }
  metrics(): ShadowMetrics { return { ...this.m } }
}

// Structural comparison ignoring order; returns the first difference or null.
function diverges(a: CanvasDocument, b: CanvasDocument): string | null {
  const norm = (d: CanvasDocument) => ({
    shapes: [...d.shapes].sort((x, y) => x.id.localeCompare(y.id)).map((s) => ({ ...s })),
    bindings: [...d.bindings].sort((x, y) => x.id.localeCompare(y.id)),
    pages: [...d.pages].sort((x, y) => x.id.localeCompare(y.id)),
  })
  const na = JSON.stringify(norm(a)), nb = JSON.stringify(norm(b))
  return na === nb ? null : `mirror(${a.shapes.length} shapes) != source(${b.shapes.length} shapes)`
}
```

**`shadow.test.ts`:** build a fake `getRecords` returning a mutable array of
tldraw records; tick → assert mirror matches, no divergence; mutate the records
(move a shape) and tick → still no divergence; force a divergence by mutating the
mirror doc directly out-of-band, tick to the `checkEvery` boundary → assert
`divergences === 1`. Assert `metrics()` reports shapeCount and snapshotBytes.
Commit `feat(server): ShadowMirror — live tldraw→Loro mirror with divergence detection`.

## Task D3: wire shadow into the server (clock-polled, gated) + metrics endpoint

**Files:** Modify `server/src/app.ts`; create `server/src/features/canvas-metrics.ts`;
modify `server/src/tools-api.test.ts` (EXEMPT set only).

- **Driver:** a single `setInterval` in `createSyncApp` (gated by
  `EW_CANVAS_SHADOW === '1'`, `unref()`'d like the backpressure monitor) that,
  for each room in `roomHost.rooms`, compares `getCurrentDocumentClock()` to the
  last seen value and calls `mirror.tick()` only when it changed. A
  `Map<roomId, {mirror, lastClock}>` holds mirrors; `getRecords` closes over
  `roomHost.getOrCreateRoom(roomId)`. Interval ~1000ms.
- **Metrics endpoint** `GET /api/canvas/metrics` (internal): returns
  `{ ok: true, rooms: { [roomId]: ShadowMetrics } }`. Router in
  `features/canvas-metrics.ts`, mounted in `app.ts`. Because it is not an agent
  tool, add its path to the EXEMPT predicate in `tools-api.test.ts`:
  ```ts
  p === '/api/health' || p === '/api/tools' || p === '/api/telemetry/connection' || p === '/api/canvas/metrics'
  ```
- Update the tools-api test's human log line if it enumerates exempt paths (leave
  the `=== 27` assertion untouched — no tool added).

**Test:** add `server/src/features/canvas-metrics.test.ts` in house style if the
router has logic worth pinning (it mostly serializes the registry) — otherwise a
one-liner asserting the router returns `{ ok: true }` for an empty registry is
enough. Run `bun run test 2>&1 | grep -E "tools-api|canvas-metrics|FAIL"` to
confirm the completeness test still passes with the new exempt path.

Commit `feat(server): clock-polled shadow driver + internal /api/canvas/metrics (gated, exempt)`.

---

# Seam E — model/doc/stability test rigs

House-style, deterministic (injected seeded PRNG — no `Math.random`). Per-commit
rigs are bounded; the soak rig is nightly.

## Task E1: property-based convergence suite

**Files:** Create `canvas-sync/src/rig/prng.ts`, `canvas-sync/src/rig/ops.ts`,
`canvas-sync/src/convergence.test.ts`.

- **`prng.ts`** — `mulberry32(seed)` deterministic PRNG returning `() => number`
  in [0,1), plus `pick(rng, arr)` and `int(rng, n)`.
- **`ops.ts`** — `randomOps(rng, count): Op[]` generating a mix of
  `putShape/updateProps/reparent/deleteShape/putBinding/deleteBinding` over a
  small id pool, including **hostile** shapes: reparent-into-each-other,
  delete-then-bind, same-shape concurrent prop edits. An `applyOp(doc, op)`
  helper (guarded — reparent/putShape may throw on cycles; catch and continue,
  since Loro's guard is part of the behavior).
- **`convergence.test.ts`** — for each of ~50 seeds:
  1. Create N=3 `LoroCanvasDoc` peers (peerIds 1n,2n,3n).
  2. Generate an independent random op batch per peer; apply locally; `commit`.
  3. Exchange: collect each peer's `exportUpdate()`; import every other peer's
     updates into every peer, in a **PRNG-shuffled order**; `commit`.
  4. `repair()` on every peer; `commit`.
  5. Assert all peers' `exportSnapshot()`… no — snapshots include peer-local
     metadata; assert instead that **`dumpModel` normalized** (sorted shapes/
     bindings/pages, as in `diverges`) is **identical across all peers**, and
     `checkInvariants(dumpModel(peer)) === []` for each.
  6. On mismatch, **shrink**: re-run the same seed halving the op count until the
     failure disappears, printing the minimal failing `(seed, count)` — the
     replayable repro (design's "shrinking to minimal repros").

Keep N and op counts small (N=3, ≤40 ops/peer, ~50 seeds) so it runs in seconds
per-commit. Commit
`test(canvas-sync): property-based multi-replica convergence + repair (seeded, shrinking)`.

> The load-bearing assertion is byte-for-byte *model* equality after shuffled
> merges + repair — the design's deepest-leverage test. Because it runs under
> `bun run test`, a convergence regression fails CI on every commit.

## Task E2: fuzzing — garbage never crashes the peer

**Files:** Create `canvas-sync/src/fuzz.test.ts`.

For ~1000 PRNG-seeded inputs: random-length random bytes, truncated real updates
(export a real update, slice it at a random offset), and bit-flipped real
updates. Feed each to `SyncServerPeer` via an in-memory client `Frame.Update`.
**Assert the peer never throws out of `onFrame`** and the doc remains queryable
(`listShapes()` doesn't throw) afterward. Since Loro's `import` *can* throw on
malformed bytes, wrap `doc.import` in `server-peer.ts`'s `onFrame` in a
try/catch that logs and drops the frame — **write the failing fuzz test first**,
watch it throw, then add the guard to `server-peer.ts` (TDD). Also test
`decodeImportBlobMeta(bytes, true)` as an optional pre-validation gate. Commit
`fix(canvas-sync): server peer survives garbage/truncated updates (fuzz-guarded)`.

## Task E3: crash recovery rig

**Files:** Create `server/src/canvas-v2/crash-recovery.test.ts`.

Two levels:
1. **In-process replay** (fast, deterministic): build a `DocumentActor` in a temp
   dir, write shapes, then WITHOUT compacting, construct a fresh actor on the
   same file and assert the doc is fully recovered from the append-log (this is
   the C2 test hardened — include a mid-batch case: append an update, then
   simulate a "crash" by never calling compact, reopen, assert state).
2. **kill -9 subprocess** (the real thing): a helper script
   `server/src/canvas-v2/crash-writer.ts` that opens an actor, writes shapes in a
   loop, and prints `READY`; the test `Bun.spawn`s it, waits for a shape count on
   disk, `proc.kill(9)` mid-write, then opens a fresh actor and asserts the
   persisted shapes load and pass `checkInvariants`. Because WAL + per-INSERT
   transactions make each append atomic, the recovered doc must be a valid
   prefix. Use a temp dir; clean up.

Commit `test(server): crash-recovery — kill -9 mid-write, replay append-log, converge`.

## Task E4: soak simulation (nightly) + smoke variant (per-commit)

**Files:** Create `canvas-sync/src/soak.ts` (the simulation, parameterized),
`canvas-sync/src/soak-smoke.test.ts` (tiny, per-commit), and
`.github/workflows/canvas-soak.yml` (nightly).

- **`soak.ts`** — `runSoak({ clients, ops, seed, chaos })`: one `SyncServerPeer`,
  `clients` `SyncClientPeer`s over in-memory transports wrapped in a **chaos
  transport** (drops/reorders/delays frames per PRNG + a `chaos` intensity),
  plus "agent-API writers" (direct `putShape` bursts on the server doc). Runs
  `ops` weighted-random operations, periodically forcing full reconnect
  (`requestSync`) and compaction. Returns
  `{ converged: boolean, finalShapeCount, maxSnapshotBytes, repairFirings }`.
  Convergence check at the end: quiesce (deliver all buffered frames), assert all
  clients' normalized `dumpModel` equal the server's and invariants clean.
  **Bounded-growth assertion:** `maxSnapshotBytes` grows sub-linearly after
  compaction (assert final snapshot < K × live shape count).
- **`soak-smoke.test.ts`** — `runSoak({ clients: 3, ops: 500, seed: 1, chaos:
  0.3 })`; assert `converged === true` and invariants clean. Runs under `bun run
  test` in ~seconds.
- **`canvas-soak.yml`** — modeled on `e2e.yml`'s structure (checkout,
  `oven-sh/setup-bun@v2` bun 1.3.14, `setup-node@v4` 22.12.0, `bun install
  --frozen-lockfile`), a `schedule` cron (e.g. `'23 5 * * *'`) + `workflow_dispatch`,
  running `bun canvas-sync/src/soak.ts --clients 10 --ops 200000 --seed $RANDOM`
  as a long job (`timeout-minutes: 60`) with `process.memoryUsage().rss`
  sampled and asserted flat (fail on monotonic growth), uploading a metrics
  artifact. Do NOT run soak on PRs (the smoke test covers per-commit).

Commit `test(canvas-sync): soak simulation (nightly workflow) + per-commit smoke`.

---

# Seam F — docs, wiring finalization, full-suite gate

## Task F1: workspace list + README + AGENTS.md

**Files:** Modify `AGENTS.md` (NOT `CLAUDE.md` — it's the symlink) and `README.md`
if it lists workspaces.

- In `AGENTS.md`, add `canvas-sync` to the "Workspaces:" line and one sentence:
  "`canvas-sync` (Loro update exchange + presence over an injected transport;
  clean-room, never imports server/tldraw/ws)."
- If `README.md` enumerates workspaces, add `canvas-sync` there too. (Grep first:
  `grep -n "canvas-doc" README.md`.)
- Verify the symlink is intact: `readlink CLAUDE.md` → `AGENTS.md`.

Commit `docs: register canvas-sync workspace (AGENTS.md + README)`.

## Task F2: final full-suite + typecheck gate

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase2
bun install
bun run typecheck                         # exit 0, all workspaces incl. canvas-sync
bun run test 2>&1 | tail -30              # green except the pre-recorded Task-0 baseline (if any)
EW_CANVAS_SYNC=1 EW_CANVAS_SHADOW=1 bun run --filter '@ensembleworks/server' typecheck
```
Confirm: (a) `manifest.tools.length === 27` still holds (no agent tool added);
(b) the only non-passing suite, if any, is the exact one recorded at Task 0;
(c) `canvas-sync` boundary test passes (no forbidden imports). Commit any
lockfile/typecheck fixups: `chore(canvas-phase2): full-suite + typecheck green`.

---

## Done criteria (maps to Phase 2 scope)

- [ ] **`canvas-sync` workspace** exists, clean-room (boundary test green),
      registered in root `package.json` + typecheck + `AGENTS.md`. [B1, F1]
- [ ] **Loro update exchange protocol** (client + server halves) over an injected
      transport, with sync-request **rebase** on (re)connect. [B2–B4]
- [ ] **Presence** via `EphemeralStore` (cursor, viewport, stamp, presenting
      tokens) exercised headlessly; deeper presence deferred to Phase 3 (Open
      Q4). [B5]
- [ ] **Room host document actor** in `server`: one Loro doc per room, append-log
      + periodic **shallow-snapshot compaction** into per-room SQLite, under
      `DATABASE_DIR/canvas-v2/`. [C1–C2]
- [ ] **Incremental sync** (`exportUpdate(sinceVersion)` + `versionBytes`) —
      Phase-1 deferral closed. [A2]
- [ ] **Deterministic repair pass** (pure `repairPlan` + `canvas-doc.repair()`)
      run after every remote merge on every peer; idempotent. [A4]
- [ ] Full document — **pages + bindings**, not just shapes — round-trips through
      the CRDT (prereq for real merges + dangling-binding repair). [A1]
- [ ] **Shadow mode**: every live tldraw room clock-polled → `fromTldraw` →
      `reconcile` into a Loro doc, with periodic **divergence detection** and
      **metrics**, gated `EW_CANVAS_SHADOW`, **zero user exposure**. [D1–D3]
- [ ] **Test rigs:** property-based convergence (per-commit, shrinking) [E1];
      fuzzing (garbage never crashes the peer) [E2]; crash recovery (kill -9,
      replay, converge) [E3]; nightly soak + per-commit smoke, chaos proxy,
      flat-RSS + bounded-growth assertions [E4].
- [ ] `/sync/v2` WS mounted but `EW_CANVAS_SYNC`-gated off; no user-facing
      surface; tools manifest still 27. [C3, D3, F2]
- [ ] `bun run typecheck` and `bun run test` green (modulo the Task-0 baseline).

---

## Seam / task index

- **Seam A — canvas-doc full-document sync primitives + repair:** A1 bindings+pages,
  A2 incremental export/import, A3 local-update hook, A4 repair. (4 tasks)
- **Seam B — canvas-sync workspace:** B1 scaffold+boundary, B2 protocol+transport,
  B3 client peer, B4 server peer, B5 presence. (5 tasks)
- **Seam C — room-host actor:** C1 store, C2 actor, C3 ws adapter + gated mount. (3 tasks)
- **Seam D — shadow mode:** D1 reconcile, D2 mirror+divergence, D3 driver+metrics. (3 tasks)
- **Seam E — test rigs:** E1 convergence, E2 fuzz, E3 crash recovery, E4 soak. (4 tasks)
- **Seam F — finalize:** F1 docs, F2 full-suite gate. (2 tasks)

Plus Task 0 (preflight). **Total: 21 tasks + preflight.**

---

## Amendments (2026-07-11, post-review)

**Task C2's persistence design as written above has a proven crash-consistency
hole — do not implement it verbatim.** The actor sketch persists via
`peer.doc.subscribeLocalUpdates` only, but that hook fires exclusively for
committed LOCAL ops and never for imports (the exact no-echo property Unit 1
pinned). Client edits arrive at the server as imports, so they are NEVER
appended: probe-proven, two client edits through the planned wiring → zero
append-log rows → empty recovery. A crash between compactions loses all
client work.

**Ratified fix (implemented in Unit 4): durable-first via
`SyncServerOpts.onUpdatePayload`.**

- `SyncServerPeer` now accepts `onUpdatePayload?: (payload: Uint8Array) => void`,
  fired synchronously with the raw inbound Update payload BEFORE
  repair/commit/relay, gated on `changed || pending` — the same gate as the
  relay, deliberately: *persist and relay exactly the frames that may carry
  ops the server does not durably hold.* Pending payloads MUST be logged
  (changed-only would strand them: the ops exist nowhere durable and the later
  gap-filler frame carries only its own bytes); Loro replay handles the
  resulting out-of-order log. No-op imports (reconnect full-history backfills)
  do not fire it, so they don't bloat the log. Order inside the Update branch:
  persist → repair/commit (repair-delta broadcast) → raw-frame relay. This
  restores persist-before-broadcast parity with the prod tldraw stack.
- The payload aliases the frame buffer (zero-copy decode) — the persistence
  layer must copy (SQLite binding does implicitly).
- **C2 must persist via BOTH hooks:** `onUpdatePayload` (client-sourced ops) AND
  `peer.doc.subscribeLocalUpdates` (server-local ops: repair deltas, agent
  writes). Neither alone covers both directions.
- **C2 load path:** after snapshot + update replay, run `repair()` + `commit()`
  ONCE before serving — the log may end mid-merge (crash after append, before
  the repair commit landed in any persisted update).
- **C1 compaction order is load-bearing:** INSERT/UPSERT the snapshot, then
  DELETE the folded-in updates (as sketched). Never reverse it — a crash
  between the two statements must leave a recoverable superset, not a hole.
- **C2's test must drive edits through a CONNECTED CLIENT transport** (the
  plan's current actor test puts shapes via an in-memory client but should
  assert specifically that client-sourced ops survive a fresh-actor recovery).
  A test that mutates `actor.peer.doc` directly masks the hole this amendment
  fixes.
- Related Unit 4 deltas to the B3/B4 sketches: `ImportResult` is now
  `{ pending, changed }` (canvas-doc); repair/commit in both peers is gated on
  `changed`; the server relay fires on `changed || pending` (pending frames
  must reach observers or they strand); `SyncServerPeer.pendingImports`
  counter exposed for the D3 metrics endpoint (healthy ≈ 0); client
  `reconnect()` closes the old transport and pushes its full history as an
  Update (offline edits have no other path upstream; delta-since-acked-version
  is a deferred optimization); both peers have real idempotent `close()`
  semantics (server `connect()` after close throws).
