# Canvas Phase 3: Editor + Renderer, Dogfood Rooms — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the new engine *interactive* and put the team inside it. Turn
Phase 2's headless, shadow-only CRDT stack into a living canvas: a pure headless
`canvas-editor` (camera, selection, hit-testing, tools as replayable FSMs → model
ops), a thin `canvas-react` renderer (CSS-transform world + one SVG overlay +
ported custom HTML shapes), and a **per-room-flagged** client mount that dials
the Phase-2 `/sync/v2` WS with a real `SyncClientPeer` — so **dogfood rooms run
the new engine while the `team` room (and every unlisted room) stays on tldraw,
untouched, proven by a grep-level exposure audit.** First, close the named Phase-3
prerequisite: replace canvas-doc's O(n) `nodeByShapeId` scan (measured 7.36ms per
repair at 1k shapes, and the driver of the soak's superlinear RSS) with an
id→node index. Land the design's editor- and UI-layer test rigs (interaction
scripts, session replay, geometry property tests, component goldens, a
new-engine Playwright E2E, browser perf) against the dogfood surface.

**Architecture:** Two new clean-room Bun workspaces complete the design's
five-package set. `canvas-editor` depends only on `@ensembleworks/canvas-model` +
`@ensembleworks/canvas-doc` (no DOM, no `loro-crdt` sync, injected clock/PRNG):
its core is `(state, InputEvent) → (state', Intent[])` tool FSMs whose intents
become `canvas-model` ops applied to a `LoroCanvasDoc`, plus an editor-local
signals store (camera/selection/hover/editing — NOT in the CRDT). `canvas-react`
depends on `canvas-editor` + `canvas-model` + React: a viewport div with a single
CSS-`transform` world container, absolutely-positioned React shape bodies, one
full-viewport SVG overlay (arrows/selection/handles/snap-guides/cursors), a
dotted-grid layer, and an embed-lifecycle contract the six custom HTML shapes
(`terminal`, `iframe`, `neko`, `roadmap`, `screenshare`, `file-viewer`) plug
into — logic-free by policy, enforced by an ESLint boundary rule. Pure geometry
(world bounds incl. rotation, point hit-test, spatial index, snap/anchor
resolution) lands in `canvas-model` so the server reuses it for spatial
semantics. The `client` gains workspace deps on `canvas-doc`/`canvas-sync`/
`canvas-editor`/`canvas-react` and a `selectEngine(roomId)` gate; only
allowlisted dogfood rooms mount the new engine over a `SyncClientPeer`. The
`server` enables `/sync/v2` for dogfood (the `EW_CANVAS_SYNC` flag already exists)
and gains idle-actor eviction + an app shutdown hook. Nothing changes for the
`team` room or any tldraw room.

**Tech Stack:** Bun 1.3.14, Node 22.12.0 (asdf), TypeScript 5.7, `zod` ^4,
`loro-crdt` **1.13.6 (pin exact)**, React 19 + Vite 7 (client), the existing
`@tldraw/*` 5.1.0 (legacy engine, retained), `ws` 8, Playwright (e2e + perf
projects, `.github/workflows/e2e.yml` + a new browser-perf job). New browser deps
are decided by preflight probes, not assumed: `vite-plugin-wasm`/
`vite-plugin-top-level-await` (loro-in-Vite — Preflight P1), `loro-prosemirror`
(rich text — Preflight P3, gated on an Open Question), `perfect-freehand` (ink —
out of scope this phase, see Open Q3).

---

## House rules (read before Task 0 — these override habits)

- **bun is NOT on PATH in fresh shells.** Every `Bash` invocation must begin with
  `export PATH="$HOME/.bun/bin:$PATH"`. bun is 1.3.14; node 22.12.0 via asdf.
- **Run the suite with `bun run test`** (root → `scripts/run-tests.ts`), **never
  raw `bun test`.** Tests are plain self-executing scripts using
  `node:assert/strict` + a top-level body + `console.log('ok: …')`, run as
  `bun <file>`. A `bun:test` (`describe/it`) file run this way errors with
  "Cannot use test outside of the test runner." Match the house style exactly.
- **Any test that boots the app/server/a browser must end with `process.exit(0)`**
  (WASM ephemeral timers, ws handles, and Playwright contexts otherwise hold the
  process open — the Phase 2 `PresenceStore.destroy()` hang is the precedent).
- **Typecheck:** `bun run typecheck` from the repo root covers every workspace;
  new workspaces MUST be appended to its chain (see Task C1/D1) and to root
  `package.json` `workspaces` (after `canvas-sync`). `client` **build** is
  `bunx tsc --noEmit && vite build` — the loro-in-Vite fix (Seam G) must pass the
  `vite build`, not just tsc.
- **Determinism rule (design):** no `Date.now`/`Math.random`/I/O in
  `canvas-model`, `canvas-doc`, `canvas-sync` core, **or `canvas-editor` core.**
  Clocks, ids, PRNG, and input timestamps are injected. Every interaction is a
  replayable event sequence; the replay is the regression test. `canvas-react`
  may touch the DOM (it is the renderer) but holds no editor logic (ESLint
  boundary rule, Task D1).
- **`loro-crdt` is exact-pinned at 1.13.6.** `canvas-*` packages never import from
  `server` or `tldraw`. `canvas-editor` never imports `loro-crdt` or the DOM.
  `canvas-react` never imports `loro-crdt`, `ws`, `express`, `server`, or
  `tldraw`.
- **`CLAUDE.md` is a symlink to `AGENTS.md`** (`readlink CLAUDE.md` → `AGENTS.md`).
  Edit **`AGENTS.md`**. Task H1 registers `canvas-editor` + `canvas-react` there.
- **Commits:** small, frequent, conventional-commit style, each ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Tool-count assertions** live in FOUR lock-step files, all asserting **27**:
  `server/src/tools-api.test.ts`, `cli/src/cli-api.test.ts`,
  `cli/src/render/manifest.test.ts`, `contracts/src/tools/tools.test.ts`.
  **This phase adds NO agent tools** (editor/renderer/tools are client + pure
  packages; agent writes stay on the tldraw/v2-read path — Open Q13). If any task
  ever needs a new agent tool, it must edit all four sites in one commit. No task
  here should.
- **Zero-exposure rule (evolved for Phase 3):** the `team` room and every room not
  on the dogfood allowlist STAY on tldraw. The new engine mounts only for
  allowlisted dogfood rooms (Seam G, engine selector). Task G6 is a grep-level
  exposure audit that FAILS if the default room path can reach the new engine.
- **e2e rig facts:** ports 8788/5273 must be free; specs in `e2e/tests`
  (`canvas-v2.spec.ts` already exists as a Phase-2 stub); perf specs in `e2e/perf`;
  goldens in `e2e/goldens`; CI workflow `.github/workflows/e2e.yml`. The
  new-engine E2E extends `canvas-v2.spec.ts`; the browser-perf job is modeled on
  `e2e.yml` + the existing `.github/workflows/canvas-soak.yml`.

---

## Triage of Phase 2 execution-note deferrals (2026-07-12)

Every bullet from `2026-07-11-canvas-phase2-sync-shadow.md`'s "Execution notes"
is classified here. **P = Phase 3 prerequisite, I = Phase 3 in-scope,
D = deferred again (with destination).**

| Phase 2 note | Class | Where in this plan |
|---|---|---|
| O(n) `nodeByShapeId` scan → id→node index "before any renderer traffic" | **P** | **Seam A (the first unit)** |
| Idle actor eviction ("revisit before Phase 3 cutover") | **I** | Task F1 (dogfood rooms now hold real long-lived actors) |
| No app-wide shutdown hook (wire `canvasActors.close()`) | **I** | Task F2 |
| DocumentActor-backed compacting soak variant (prod-faithful growth) | **I** | Task H4 (extend the existing rig, after Seam A) — Open Q10 |
| `pendingImports` re-request (server→sender `SyncRequest` protocol extension) | **D → Phase 4** | Surfaced in the dogfood dev overlay (Task G5) so a real occurrence is visible; Open Q8 |
| `reconnect()` full-history backfill (since-acked-version delta optimization) | **D → Phase 4** | Reconnect-backfill byte counter added to the dev overlay (Task G5); Open Q9 |
| Presence: publishes not rate-limited; `all()` includes self | **I** | Task F4 wiring budgets both (throttle on publish; filter self on render) |
| Known-lossy repair edges (dedupe drops valid twin; reparent relocates winner) | **D → Phase 4** | Repair-firing telemetry surfaced in dogfood (Task G5); fix deferred; Open Q11 |
| `stableStringify` cross-representation risk (converter objects vs Loro round-trips) | **I (covered)** | Editor↔Loro round-trip tests (Task C2) exercise the new representation boundary |
| Bounded-growth K + flat-RSS tolerance calibrated only for chaos 0.3/0.5 | **D → Phase 4** | Re-calibrate when actor-backed soak (H4) lands a new growth curve |
| Fuzz corpus pin `malformedFrames=999/1000` coupled to loro-crdt 1.13.6 | **D (standing)** | Do not upgrade loro-crdt this phase |
| Zero-page docs: orphans deliberately unrepairable | **D (standing)** | No action |
| Phase-1 deferrals: `zodInput` middleware, O(n²) clustering cap, run-tests halt-on-first | **D (standing)** | Out of scope |

---

## Context you need (zero-assumption briefing)

Read this whole section before Task 0. Every signature below was read from source
in this worktree.

### What Phase 2 left you (the things you extend)

`canvas-model` (`canvas-model/src/*`, pure, zod-only) — `index.ts` re-exports
`ids`, `shape`, `document`, `invariants`, `repair`, `geometry`, `neighbors`,
`cluster`, `semantic`:
- `SHAPE_KINDS` (16): `note, text, geo, arrow, frame, group, line, draw,
  highlight, image, terminal, iframe, neko, roadmap, screenshare, file-viewer`.
  `Shape` envelope (`id, kind, parentId, index, x, y, rotation, isLocked,
  opacity, meta, props`). `Binding`, `Page`, `CanvasDocument`, `makeDocument`,
  accessors (`shapeById`, `childrenOf`, `rootShapes`, `frames`, `descendantsOf`,
  `pageIdOf`), `byId`.
- `checkInvariants`, `repairPlan`/`applyRepairToModel`/`cascadeDropSet`/
  `canonicalPageId`, `stableStringify`.
- **geometry.ts is THIN**: `Bounds`, `pageIdOf`, `pageBounds`, `centroid`,
  `medianSize`. **There is NO hit-testing, NO rotation-aware world bounds, NO
  spatial index.** Seam B adds them (the editor's geometry floor).
- `neighbors`, `clusterShapes`, `semanticView` (spatial-semantics read side).

`canvas-doc` (`canvas-doc/src/*`, depends canvas-model + loro-crdt):
- `LoroCanvasDoc implements CanvasDoc`: Loro movable tree `getTree('shapes')` is
  the hierarchy source of truth; node `data` is a flat `LoroMap` of the envelope,
  props under `'__props'`, text in per-shape `LoroText` keyed `text:<id>`;
  bindings/pages in top-level `LoroMap`s. `putShape/updateProps/deleteShape/
  reparent/get|setText/putBinding|deleteBinding|listBindings/putPage|deletePage|
  listPages`, `exportSnapshot/exportUpdate(sinceVersion?)/versionBytes/import→
  ImportResult{pending,changed}/subscribe/subscribeLocalUpdates/commit/repair`.
- **`nodeByShapeId(id)` (line 26) is `this.tree.nodes().find(...)` — O(n), called
  by nearly every mutator and N× inside `repair()` (→ O(n²)).** `nodesByShapeId`
  (line 40) is the all-duplicates variant repair() uses under churn. Seam A
  indexes both without changing their duplicate-tolerant contract.
- `repair()` (line 278) measured 7.36ms/call @1k shapes even on a clean doc
  (~70% in the three `list*()` WASM marshals); sync peers gate it on
  `ImportResult.changed`.

`canvas-sync` (`canvas-sync/src/*`, clean-room, depends canvas-model +
canvas-doc + loro-crdt):
- `Frame{Update,Presence,SyncRequest}`, `Transport`, `encode/decode`, `makePair`
  (in-memory transport pair).
- `SyncClientPeer` (`client-peer.ts`): owns a `LoroCanvasDoc`, forwards committed
  local updates, applies remote (repair gated on `changed`), `requestSync()`
  handshake, `reconnect(transport)` (closes old, re-wires, re-handshakes, pushes
  full history), `close()` idempotent, optional injected `PresenceStore`
  (`Frame.Presence` both ways). **This is the client's doc engine for Phase 3.**
- `SyncServerPeer` (`server-peer.ts`): authoritative room peer; `onUpdatePayload`
  durable-first hook (fires on `changed || pending` before repair/commit/relay);
  `pendingImports`/`malformedFrames` counters (D3 metrics); fuzz-guarded
  `onFrame`.
- `PresenceStore` (`presence.ts`): one `EphemeralStore`; `publish(p)` (**NOT
  rate-limited — every set() hits the wire uncoalesced; the renderer MUST
  throttle** — Task F4), `all()` (**includes self under `selfKey` — the renderer
  MUST filter it** — Task F4), `onLocalUpdate`, `apply`, `encodeAll`,
  `destroy()` (releases the WASM expiry timer; long-lived owners must call it).
  `Presence = { cursor, viewport, stamp, presenting[] }`.

`server` (`server/src/*`):
- `canvas-v2/actors.ts`: `createCanvasActors(databaseDir) → CanvasActors`
  (`getOrCreate/entries/evictions/close`). Constructed by `createSyncApp` ONLY
  when `EW_CANVAS_SYNC=1`. **Idle eviction is explicitly deferred (line 49
  comment) — Task F1 adds it.** Fixed `SERVER_PEER_ID = 1n`.
- `canvas-v2/{actor,store,reconcile,shadow,ws-transport,convert}.ts` — the
  DocumentActor, per-room append-log SQLite, shadow mirror, ws Transport adapter.
- `app.ts`: `createSyncApp({dataDir, databaseDir, clientDist, shadowIntervalMs?})`.
  The `server.on('upgrade')` handler (line 331) matches `/sync/v2/:roomId` BEFORE
  `/sync/:roomId`, gated on `canvasActors` (non-null iff `EW_CANVAS_SYNC=1`);
  calls `canvasActors.getOrCreate(roomId).connect(wsTransport(ws))`. **No
  app-wide shutdown hook exists** (line 149 comment) — Task F2. `GET
  /api/canvas/metrics` exists (EXEMPT in tools-api.test.ts).

`client` (`client/src/*`, React 19 + Vite 7 + tldraw):
- `main.tsx` → `<App/>`. `App.tsx` mounts `<Tldraw store={useSync({uri:
  `${wsBase()}/sync/${roomId}?userId=…`})} …>` — the ENTIRE legacy engine. Custom
  shapes/overlays/hooks come from the `plugins` registry
  (`plugins.ts` + `kernel/plugin.ts`: `ClientPlugin{shapeUtils, icons, tools,
  barItems, MenuItems, Overlay, uiSlots, roomHooks}`). Sets `__ewEditor` debug
  hook.
- `identity.ts`: `getRoomId()` (line 61) reads `?room=` (default `'team'`,
  validated `^[a-zA-Z0-9_-]{1,64}$`); `getIdentity()`, `peekIdentity()`,
  `getFrameId()`.
- Six custom shapes are `client/src/{terminal,iframe,neko,roadmap,screenshare,
  file-viewer}/` — each a `BaseBoxShapeUtil` HTML box + a `plugin.tsx`. e.g.
  `iframe/IframeShapeUtil.tsx` (189 lines). These port to `canvas-react` shape
  bodies (Seam E).
- `vite.config.ts`: `@vitejs/plugin-react`, `manualChunks` (tldraw/livekit/xterm/
  react), proxies `/sync`,`/uploads`,`/files`,`/api` to the sync/gateway ports.
  **No wasm plugin** — the loro-in-Vite landmine (Preflight P1).

### The loro-crdt-in-Vite landmine (why Preflight P1 is non-negotiable)

`loro-crdt`'s package `exports["."]` resolves the `import` condition to
`bundler/index.js`, whose `loro_wasm.js` does
`import * as rawWasm from "./loro_wasm_bg.wasm"` — the wasm-bindgen **bundler
target**, a synchronous ESM `.wasm` import. **Vite 7 does not handle a bare
`import … from '*.wasm'` natively; `vite-plugin-wasm` is NOT installed.** There is
also a `loro-crdt/web` export (async `init()` before use) and a `browser` export.
`canvas-doc`/`canvas-sync` import bare `'loro-crdt'`, so whatever resolves in the
node test path must also resolve in the Vite browser build. **Do not guess which
fix works — P1 builds a minimal client entry importing `LoroCanvasDoc`, runs
`vite build`, and settles it empirically (candidate fixes: (a) add
`vite-plugin-wasm` + `vite-plugin-top-level-await`; (b) a Vite `resolve.alias`
mapping `loro-crdt` → `loro-crdt/web` plus a one-time async boot gate).** The
verdict is a recorded artifact the Seam G tasks implement.

### Test/house patterns to copy verbatim

- Pure-package house test: `canvas-doc/src/incremental.test.ts`,
  `canvas-model/src/repair.test.ts` (peerId bigints, `assert.deepEqual`,
  `console.log('ok: …')`, run as `bun src/<f>.test.ts`).
- Clean-room boundary test: `canvas-sync/src/boundary.test.ts` (Bun `Glob` over
  `src`, forbidden-import regexes) — Seam C/D copy-adapt it.
- Server integration test: `server/src/canvas-v2/actors.test.ts`,
  `crash-recovery.test.ts` (`mkdtempSync`, `process.exit(0)`).
- e2e: `e2e/tests/canvas-v2.spec.ts`, `e2e/perf/*`, `e2e/playwright.config.ts`.

---

## Task 0: Preflight baseline (no commit)

```bash
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase3
export PATH="$HOME/.bun/bin:$PATH"
git branch --show-current      # expect: canvas-phase3
bun --version                  # 1.3.14
node --version                 # v22.12.0
bun install
bun run typecheck              # expect exit 0, all workspaces
bun run test 2>&1 | tail -25   # ACCEPTED BASELINE — expected fully green (142/142 suites)
```

**Record the baseline.** If any suite fails, that failure (and only that) is your
accepted baseline. If typecheck fails, stop and report — the worktree is not
clean. No commit.

---

# Preflight probes (de-risk before seam work; each ends with a recorded verdict)

These settle unknowns the seams depend on. Each probe may commit a throwaway
scratch under `docs/plans/phase3-probes/` (deleted in Task H1) or leave no commit
and only record its verdict in the execution report — say which in the task.

## Task P1: loro-crdt in the Vite browser build

**Why:** the landmine above. Blocks all of Seam G.

**Steps:**
1. Create a scratch entry `client/src/__probe/loro-probe.ts`:
   ```ts
   import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
   const d = LoroCanvasDoc.create({ peerId: 1n })
   d.putShape({ id: 'shape:p', kind: 'note', parentId: 'page:p', index: 'a1',
     x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
   d.commit()
   ;(globalThis as any).__loroProbe = d.listShapes().length   // expect 1
   ```
   Temporarily add `@ensembleworks/canvas-doc: '*'` to `client/package.json`,
   `bun install`, and reference the probe from a temporary `<script type=module>`
   or an import in `main.tsx`.
2. `bun run --filter '@ensembleworks/client' build` — observe whether Vite
   fails on the `.wasm` import.
3. If it fails, try **candidate (a)**: `bun add -D vite-plugin-wasm
   vite-plugin-top-level-await` in `client`, add both to `vite.config.ts`
   `plugins`, rebuild.
4. If (a) is unsatisfactory, try **candidate (b)**: `resolve.alias` `'loro-crdt'`
   → `'loro-crdt/web'` in `vite.config.ts`, add a `await init()` boot gate in a
   new `client/src/canvas-v2/boot.ts`, rebuild.
5. Serve the build (or `vite preview`) and drive a headless browser
   (`docs/headless-browser.md` pattern / a Playwright one-off) to read
   `window.__loroProbe === 1` — proving the WASM actually instantiates in the
   browser, not just that the build passed.

**Verdict to record:** which candidate works, the exact `vite.config.ts` diff,
any new devDeps, and whether an async boot gate is required (candidate b needs
`await init()` before the first `LoroCanvasDoc.create` — Seam G must sequence the
mount after it). Remove the scratch probe files and the temp dep before leaving
(Seam G re-adds the dep deliberately). **No lasting commit.**

## Task P2: workspace-dep + boundary reality check

**Why:** `client` currently has zero canvas-* deps; adding four is itself risk
(tsc resolution of `.ts`-source `exports`, Vite dev-server transform of
`canvas-editor`/`canvas-react` sources).

**Steps:** in a scratch branch state, add `@ensembleworks/canvas-model`,
`@ensembleworks/canvas-doc`, `@ensembleworks/canvas-sync` as client deps;
`bun install`; `bun run --filter '@ensembleworks/client' typecheck`. Confirm the
`exports: { ".": "./src/index.ts" }` pattern (used by every canvas-* package)
resolves under the client's `tsconfig` without a build step. **Verdict:** any
tsconfig `paths`/`moduleResolution` adjustment the client needs. Revert. No
commit.

## Task P3: rich-text feasibility (gates Open Q4)

**Why:** the design wants note/text content in Loro rich text bound to ProseMirror
via `loro-prosemirror`. **`loro-prosemirror` is NOT installed.** Whether Phase 3
ships full rich text or plain-text editing (Open Q4) hinges on this probe.

**Steps:** `bun add loro-prosemirror` in a scratch state; check its peer-dep on
`loro-crdt` (must be compatible with the pinned 1.13.6 — read its
`package.json` peerDependencies); check it exposes a binding to a `LoroText`/
container we can reach from `LoroCanvasDoc` (which stores per-shape text as
`doc.getText('text:<id>')`). **Verdict:** compatible-and-ship-in-Phase-3, OR
incompatible/heavy → plain-text editing this phase, rich text to Phase 4. Feed
the verdict into Open Q4's ratification. Revert. No commit.

---

# Seam A — canvas-doc id→node index (the named prerequisite)

**Dependency:** none (first unit). **Blocks:** the editor's mutation rate, the
renderer's read rate, the actor-backed soak (H4). Everything downstream assumes
this is done.

## Task A1: id→node index in LoroCanvasDoc

**Why (measured, not speculative):** `nodeByShapeId` is `tree.nodes().find(...)`,
O(n), on the hot path of every mutator and O(n²) inside `repair()`; the Phase 2
soak traced 4.3GB peak RSS at 20k ops to it. The index must preserve the exact
duplicate-tolerant contract: `nodeByShapeId` returns the first match,
`nodesByShapeId` returns ALL non-deleted nodes sharing an id (real under
concurrent churn — see the class comment at lines 29-42).

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts`
- Create: `canvas-doc/src/node-index.test.ts`

**Step 1 — failing test `canvas-doc/src/node-index.test.ts`:**

```ts
// Run: bun src/node-index.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {}, ...over,
})

// --- correctness parity: index resolves the same node the scan would ---
const a = LoroCanvasDoc.create({ peerId: 1n })
for (let i = 0; i < 200; i++) { a.putShape(shape(`shape:s${i}`) as any) }
a.commit()
assert.equal(a.getShape('shape:s0')!.id, 'shape:s0')
assert.equal(a.getShape('shape:s199')!.id, 'shape:s199')
assert.equal(a.getShape('shape:missing'), undefined)

// --- mutators keep the index coherent ---
a.reparent('shape:s5', 'shape:s0'); a.commit()
assert.equal(a.getShape('shape:s5')!.parentId, 'shape:s0')
a.deleteShape('shape:s0'); a.commit()             // cascades s5
assert.equal(a.getShape('shape:s0'), undefined)
assert.equal(a.getShape('shape:s5'), undefined)

// --- index survives an import (rebuild on merge) ---
const b = LoroCanvasDoc.create({ peerId: 2n })
b.import(a.exportUpdate()); b.commit()
assert.equal(b.listShapes().length, a.listShapes().length)
assert.equal(b.getShape('shape:s1')!.id, 'shape:s1')

// --- duplicate-id contract preserved: repair still reconciles EVERY copy ---
// (Convergence rig in canvas-sync remains the exhaustive proof; this pins the
//  local invariant that a repaired doc is duplicate-free and query-coherent.)
const c = LoroCanvasDoc.create({ peerId: 3n })
c.putShape(shape('shape:dup') as any); c.commit()
c.repair(); c.commit()
assert.equal(c.getShape('shape:dup')!.id, 'shape:dup')

console.log('ok: node-index')
```

**Step 2 — run, expect PASS on the correctness assertions with the CURRENT scan**
(the index is a perf change, so the test is a *behavioral* guard, not a
red-first). Add a **microbenchmark assertion** in the same file that IS red-first:
build a 1k-shape doc, time 1000 `getShape` calls, assert the mean is under a
generous ceiling that the O(n) scan fails and the index passes (e.g.
`< 0.02ms/call`). Tune the ceiling from the P1/Phase-2 measurement so it is a
real regression gate, not flaky. If a wall-clock assertion proves flaky in CI,
downgrade it to an operation-count probe (assert the index path does not call
`tree.nodes()` per lookup — spy by wrapping).

**Step 3 — implement.** Add `private index = new Map<string, LoroTreeNode[]>()`
(id → all live nodes, first element = `nodeByShapeId`'s answer). Maintain it in
`putShape` (create/move), `reparent`, `deleteNode`/`deleteShape` (remove),
`dedupeShapeNodes` (collapse), and **rebuild wholesale in `import()` and
`fromSnapshot`** (a merge can restructure the tree arbitrarily; a full rebuild
from `tree.nodes()` after import is correct and still O(n) once per merge, not
O(n) per lookup). `nodeByShapeId(id)` returns `this.index.get(id)?.find(n =>
!n.isDeleted())`; `nodesByShapeId(id)` returns the live subset. **Guard against
staleness:** any code path that calls `this.tree.move`/`createNode`/`delete`
directly (notably inside `repair()` and `dedupeShapeNodes`) must update the index
or trigger a rebuild — the safest discipline is a `private reindex()` called at
the end of `repair()` and after `import()`. Keep the per-mutator incremental
updates for the hot single-shape path; use `reindex()` for the bulk paths.

**Step 4 — run PASS, then run the FULL downstream proof** (the index must not
break convergence under duplicates):
```bash
bun canvas-doc/src/node-index.test.ts
bun canvas-doc/src/repair.test.ts
bun canvas-sync/src/convergence.test.ts        # the duplicate-churn exhaustive proof
bun run --filter '@ensembleworks/canvas-doc' typecheck
```
All must pass. Commit:
```
perf(canvas-doc): id→node index replaces the O(n) nodeByShapeId scan (Phase 3 prereq)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## Task A2: confirm the repair-cost drop (measurement, may be same commit)

Add a repair microbench to `node-index.test.ts` (or a sibling
`repair-cost.test.ts`): 1k-shape clean doc, time `repair()`, assert it is now
well under the Phase-2 7.36ms floor (target order-of-magnitude better; set a
defensive ceiling e.g. `< 3ms` and record the actual number in the execution
report — it recalibrates H4's soak scale). Commit if separate:
```
test(canvas-doc): pin the post-index repair cost floor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

# Seam B — canvas-model geometry floor (pure, deterministic)

**Dependency:** none (parallelizable with Seam A). **Blocks:** the editor
(Seam C) — hit-testing, marquee, snapping, arrow anchors. Lives in `canvas-model`
(design: geometry is pure and reused server-side for spatial semantics; Open Q6).

## Task B1: rotation-aware world bounds + point hit-test

**Files:**
- Modify: `canvas-model/src/geometry.ts`, `canvas-model/src/index.ts` (already
  re-exports geometry — no change if you add to geometry.ts)
- Create: `canvas-model/src/hit-test.test.ts`

**Step 1 — failing test** (real code): assert `worldBounds(doc, shape)` returns
the axis-aligned bounds of a rotated box (a 100×100 box at origin rotated 45°
has bounds ≈ `{minX:-20.7, minY:0, maxX:120.7, maxY:141.4}` — compute the exact
expected from `w,h,rotation`); assert `hitTestPoint(doc, shape, {x,y})` is true
for a point inside the rotated quad and false just outside; assert a child
shape's world bounds compose its ancestors' transforms (parent at (50,50) →
child local (10,10) is world (60,60)). Determinism: no `Math.random`; use fixed
inputs.

**Step 2 — implement** in `geometry.ts`: `localBounds(shape)` (from
`props.w/h`, kind-defaults for note/text), `worldTransform(doc, shape)` (compose
`x,y,rotation` up the parent chain via `doc.byId`), `worldBounds`,
`hitTestPoint` (inverse-transform the point into local space, box test).
**Step 3 — run PASS, typecheck, commit** `feat(canvas-model): rotation-aware
world bounds + point hit-test`.

## Task B2: spatial index + marquee + nearest-anchor + geometry property tests

**Files:** Create `canvas-model/src/spatial-index.ts` +
`canvas-model/src/spatial-index.test.ts`.

- `buildSpatialIndex(doc): SpatialIndex` — a uniform grid keyed by cell (bucket
  size derived from `medianSize`), storing shape ids per cell from `worldBounds`.
- `queryViewport(index, bounds): string[]` (culling), `queryMarquee(index, doc,
  bounds, {intersect|contain}): string[]`, `hitTestTopmost(index, doc, point):
  string | null` (z-order via `index`/tree order — topmost wins).
- **Geometry property test** (design's "a point returned by hitTest is always
  inside the returned shape's geometry"): seeded PRNG (copy `canvas-sync/src/rig/
  prng.ts`'s `mulberry32`), generate random shape fields, assert the invariant
  over ~1000 cases. No `Math.random`.

Commit `feat(canvas-model): spatial index (cull/marquee/topmost) + geometry
property test`.

## Task B3: snap candidates + arrow anchor resolution (pure)

**Files:** Create `canvas-model/src/snapping.ts` + test.

- `snapCandidates(index, doc, movingIds, point): SnapResult` — edge/center
  alignment candidates (scale-relative thresholds à la the design's clustering
  calibration — gaps relative to `medianSize`, not pixels).
- `resolveArrowAnchor(doc, targetId, point): NormalizedAnchor` — normalized
  `(nx, ny)` in the target's local box (parity with what the conversation-map
  skill and users produce). Deterministic.

Commit `feat(canvas-model): snap candidates + normalized arrow anchor resolution`.

---

# Seam C — canvas-editor workspace (headless, clean-room)

**Dependency:** Seam A + Seam B. **Blocks:** Seam D (renderer consumes the editor)
and Seam G (client mount). Pure: injected clock/PRNG, no DOM, no loro-crdt sync,
no `ws`. Imports only `canvas-model` + `canvas-doc`.

## Task C1: scaffold `canvas-editor` + boundary test

**Files:** Create `canvas-editor/package.json`, `tsconfig.json`, `test.ts`,
`src/index.ts`, `src/version.test.ts`, `src/boundary.test.ts`. Modify root
`package.json` (`workspaces` after `canvas-sync`; `typecheck` chain after the
canvas-sync entry).

- `package.json` mirrors `canvas-sync/package.json` but deps are
  `@ensembleworks/canvas-model` + `@ensembleworks/canvas-doc` (NOT loro-crdt,
  NOT canvas-sync).
- `boundary.test.ts` copy-adapts `canvas-sync/src/boundary.test.ts` with
  FORBIDDEN = `[/from ['"]loro-crdt['"]/, /from ['"]ws['"]/, /@tldraw\//,
  /from ['"]react['"]/, /document\./, /window\./, /Date\.now\(/,
  /Math\.random\(/]` (no DOM, no React, no loro, determinism). Tests may inject.

Commit `feat(canvas-editor): scaffold headless clean-room editor workspace +
boundary test`.

## Task C2: editor state store + doc-op application + round-trip test

**Files:** Create `canvas-editor/src/editor.ts` + `editor.test.ts`.

The `Editor` holds editor-local state (**not CRDT**): `camera {x,y,z}`,
`selection: Set<id>`, `hover: id|null`, `editingId: id|null`, exposed via a tiny
signals store (`subscribe(fn)`; a `get()` snapshot). It holds a `LoroCanvasDoc`
reference and applies **Intents** to it via `canvas-model` ops. Inject `now: ()
=> number` and `random: () => number`.

- Define `Intent` union: `TranslateShapes`, `ResizeSelection`, `RotateSelection`,
  `CreateShape`, `ReparentShapes`, `SetText`, `StartArrow`/`CompleteArrow`
  (binding), `SetCamera`, `SetSelection`, `SetHover`, `BeginEdit`/`EndEdit`,
  `DeleteShapes`.
- `applyIntent(intent)`: mutation intents → `doc.putShape/reparent/updateProps/
  deleteShape/putBinding/setText` + `doc.commit()`; view intents → local store
  only.
- **Round-trip test (covers the Phase-2 `stableStringify` cross-representation
  note):** apply a `CreateShape` then `TranslateShapes`, `dumpModel(doc)` and
  assert the shape's world position matches the editor's intent — the editor's
  model representation and the Loro round-trip agree.

Commit `feat(canvas-editor): editor state store + intent→doc-op application`.

## Task C3: input normalization + interaction-script DSL

**Files:** Create `canvas-editor/src/input.ts`, `canvas-editor/src/script.ts` +
`script.test.ts`.

- `InputEvent` normalized union (pointer/key/wheel + modifiers + injected `t`).
- The DSL from the design: `down(10,10).move(50,50,{steps:8}).up()` producing an
  `InputEvent[]` with injected timestamps (deterministic). `run(editor, events)`
  dispatches to the active tool.
- Test: a script produces the exact expected `InputEvent[]` (drag thresholds,
  step interpolation) — tldraw's feel captured as goldens (drag threshold, etc.).

Commit `feat(canvas-editor): normalized input + interaction-script DSL`.

## Task C4: select tool FSM (pointing → dragging; marquee; translate)

**Files:** Create `canvas-editor/src/tools/select.ts` + `select.test.ts`.

Pure FSM `(state, event) → (state', Intent[])`: `idle → pointing →
dragging(translate) | marquee`. Uses `hitTestTopmost`/`queryMarquee` (Seam B).
Emits `SetSelection`, `TranslateShapes`, `SetHover`. **Interaction-script tests**
assert intents + resulting doc + selection + camera for: click-select,
shift-add, marquee, drag-translate (with the captured drag threshold). No DOM.

Commit `feat(canvas-editor): select tool FSM (select/marquee/translate)`.

## Task C5: hand tool + camera (pan / zoom)

**Files:** Create `canvas-editor/src/tools/hand.ts`, extend camera in `editor.ts`;
tests. Pan via drag → `SetCamera`; wheel-zoom about the cursor (screen↔world
transform lives here, pure). Script tests assert camera math (zoom preserves the
world point under the cursor). Commit `feat(canvas-editor): hand tool + camera
pan/zoom`.

## Task C6: create tools (note / text / geo / frame)

**Files:** `canvas-editor/src/tools/create.ts` + test. Each is a click/drag-to-
size FSM emitting `CreateShape` with kind-appropriate defaults (ids from the
injected id factory — reuse `canvas-model/src/ids.ts`; NO `Math.random`). Frame
reparents shapes dropped inside it (uses hit-test + `ReparentShapes`). Script
tests. Commit `feat(canvas-editor): create tools (note/text/geo/frame)`.

## Task C7: arrow tool FSM + binding + routing

**Files:** `canvas-editor/src/tools/arrow.ts` + test. Draw from an anchor:
`StartArrow` (optionally bound via `resolveArrowAnchor`, Seam B3) →
`CompleteArrow` (creates the arrow shape + `putBinding` for bound endpoints).
Straight + curved routing with shape-boundary clipping computed purely in
`canvas-model` (add `routeArrow(doc, arrow, bindings): Path` to geometry if not
already present). **Bindings now live in the CRDT (Phase 2 A1)** so this is the
first real consumer. Advanced re-routing/reflow parity is Phase 4; ship
straight + single-curve. Script tests assert the binding + routed path. Commit
`feat(canvas-editor): arrow tool + binding + straight/curved routing`.

## Task C8: resize + rotate selection

**Files:** `canvas-editor/src/tools/transform.ts` + test. Handle-drag → 
`ResizeSelection`/`RotateSelection` intents; corner/edge handles; rotation about
selection center (design: "rotation modeled from day one"). Uses Seam B world
bounds. Script tests. Commit `feat(canvas-editor): resize + rotate selection`.

## Task C9: session-replay artifacts

**Files:** `canvas-editor/src/replay.ts` + `replay.test.ts`. Record
`{ inputEvents, remoteUpdates }` and `replay(seed) → final state`; assert
bit-for-bit reproduction of a recorded session (design's "every QA session and
bug report is a replayable file → regression test"). This is the harness E2E
failures (Seam G) and dogfood bug reports serialize into. Commit
`feat(canvas-editor): session-replay record + deterministic replay`.

---

# Seam D — canvas-react renderer (thin, logic-free)

**Dependency:** Seam C. **Blocks:** Seam E (custom shapes) + Seam G (client
mount). React; may touch the DOM; holds NO editor logic (ESLint boundary rule).
Imports `canvas-editor` + `canvas-model` + React only.

## Task D1: scaffold `canvas-react` + logic-free ESLint boundary rule + policy test

**Files:** Create `canvas-react/package.json` (deps: `canvas-editor`,
`canvas-model`, `react`; peer `react`), `tsconfig.json`, `test.ts`,
`src/index.ts`, `src/boundary.test.ts`; root `package.json`
(`workspaces`/`typecheck`). Modify the client build's ESLint config OR add a
package-local boundary test (grep `src/**` for forbidden imports:
`loro-crdt`, `ws`, `express`, `@tldraw/`, `../server`, and — the logic-free
policy — no import from `canvas-editor/src/tools/*` internals except the public
`canvas-editor` entry; no `canvas-model` op application). The renderer READS
editor state and CALLS editor input dispatch; it never computes intents itself.

Commit `feat(canvas-react): scaffold renderer workspace + logic-free boundary`.

## Task D2: viewport + CSS-transform world container + dotted grid

**Files:** `canvas-react/src/Viewport.tsx`, `WorldLayer.tsx`, `Grid.tsx` +
a render smoke test. One viewport div; the camera is a single CSS `transform` on
the world container (design). Dotted-grid canvas layer below. Forwards
normalized pointer/wheel/key events to `canvas-editor` input dispatch. Test:
render into a JSDOM-free smoke (React Test Renderer or a Playwright component
golden — see G2) asserting the transform string tracks `camera`. Commit
`feat(canvas-react): viewport + CSS-transform world + dotted grid`.

## Task D3: shape-body host + generic box + viewport culling

**Files:** `canvas-react/src/ShapeLayer.tsx`, `ShapeBody.tsx`,
`shapeRegistry.ts`, `shapes/BoxShape.tsx` + test. Absolutely-positioned React
shape bodies from `editor.doc.listShapes()`, positioned by `worldBounds`; a
`shapeRegistry` maps `kind → React component` (custom shapes register here in
Seam E). Off-viewport culling via `queryViewport` (Seam B2). Commit
`feat(canvas-react): shape-body host + generic box + culling`.

## Task D4: SVG overlay (selection / handles / snap guides)

**Files:** `canvas-react/src/Overlay.tsx` + `overlay/{Selection,Handles,
SnapGuides}.tsx` + test. One full-viewport SVG above the world; draws selection
rects, resize/rotate handles (wired to Seam C8 intents), snap guides (Seam B3).
Commit `feat(canvas-react): SVG overlay — selection/handles/snap guides`.

## Task D5: arrows + ink rendering in the overlay

**Files:** `canvas-react/src/overlay/Arrows.tsx` (+ `Ink.tsx` ONLY if Open Q3
puts ink in scope — default: arrows only). Renders routed arrow paths (Seam C7)
in the SVG. Commit `feat(canvas-react): arrow rendering in SVG overlay`.

## Task D6: collaborator cursors (presence-driven, self-filtered)

**Files:** `canvas-react/src/overlay/Cursors.tsx` + test. Renders remote cursors
from a presence snapshot passed in as a prop (the client wires
`PresenceStore.all()` — Seam F4). **This component MUST filter the caller's own
`selfKey` entry** (PresenceStore.all() includes self — Phase 2 note). Test with a
fixture presence map incl. a self entry → assert self is not rendered. Commit
`feat(canvas-react): collaborator cursors (self-filtered)`.

## Task D7: text editing mount (plain-text default; rich text per Open Q4)

**Files:** `canvas-react/src/TextEditor.tsx` + test. Mounts ONLY for
`editor.editingId` (design: "ProseMirror mounts only for the shape being
edited"). **Default (Open Q4): a controlled `contentEditable`/textarea bound to
`doc.getText(id)`** — proves the editing state + the LoroText container. If Open
Q4 + Preflight P3 green-light rich text, this task instead mounts ProseMirror via
`loro-prosemirror` bound to the shape's `LoroText`. Commit
`feat(canvas-react): text-editing mount for the editing shape`.

## Task D8: embed-lifecycle contract (mount / suspend / unmount)

**Files:** `canvas-react/src/embed/EmbedHost.tsx` + `embedLifecycle.ts` + test.
The abstraction the heavy custom shapes need (design: "heavy embeds (terminals,
iframes, screenshare) get visibility lifecycle hooks"). A shape body declares
`onMount/onSuspend/onUnmount`; `EmbedHost` drives them off viewport-visibility
(from culling, D3) with a suspend delay. Test the lifecycle transitions with a
fake embed. **This is why custom shapes port in Phase 3 — they force this design
(design's explicit rationale).** Commit `feat(canvas-react): embed-lifecycle
contract for heavy shapes`.

---

# Seam E — port the six custom shapes

**Dependency:** Seam D (esp. D3 registry + D8 embed lifecycle). The six shapes are
all `BaseBoxShapeUtil` HTML boxes today (`client/src/{terminal,iframe,neko,
roadmap,screenshare,file-viewer}/`). Port each to a `canvas-react` shape body
registered in `shapeRegistry` (D3), reusing the existing HTML/React internals
where possible (the design's "custom HTML shapes port near-unchanged"). Heavy
ones (terminal, screenshare, iframe) use the embed lifecycle (D8).

## Task E1: port terminal + screenshare + iframe (heavy embeds)

**Files:** `canvas-react/src/shapes/{TerminalShape,ScreenshareShape,
IframeShape}.tsx` + tests. Extract the render-only bodies from the existing
`*ShapeUtil.tsx` files (the xterm mount, the screenshare video, the iframe) and
adapt them to the `ShapeBody` + `EmbedHost` contract. Keep the transport/session
wiring identical (these talk to the gateway/livekit exactly as before —
Electron-readiness rule: WS/HTTP the only seam). Commit per shape or as one:
`feat(canvas-react): port terminal/screenshare/iframe shapes with embed
lifecycle`.

## Task E2: port neko + roadmap + file-viewer

**Files:** `canvas-react/src/shapes/{NekoShape,RoadmapShape,FileViewerShape}.tsx`
+ tests. Lighter bodies; same pattern. `file-viewer` and `roadmap` have
interaction (scroll follow, drag-drop) — verify the debugging-roadmap-control
interactions still fire through the new event path. Commit
`feat(canvas-react): port neko/roadmap/file-viewer shapes`.

> Component goldens for every ported shape land in Task G2.

---

# Seam F — server enablement for dogfood

**Dependency:** Seam A (actors hold real docs now). Independent of the client
seams; can run in parallel with C/D/E.

## Task F1: idle-actor eviction in canvasActors

**Files:** Modify `server/src/canvas-v2/actors.ts`; extend
`server/src/canvas-v2/actors.test.ts`. Add TTL/idle eviction (the deferred line
49 note): track last-activity per actor (a connect / a peer update bumps it);
an injected-clock sweep closes + evicts actors idle past a threshold and with
zero connected transports, calling `DocumentActor.close()` (idempotent) and
persisting via the close-path compact. Keep eviction records (existing
`EvictionRecord`) distinct from taint evictions, or add an `idle` reason. **Test
with an injected clock** (no wall-clock sleep) — advance past the TTL, sweep,
assert the actor is gone and its data reloads on next `getOrCreate`. Commit
`feat(server): idle-actor eviction in the canvas-v2 registry`.

## Task F2: app shutdown hook wiring canvasActors.close()

**Files:** Modify `server/src/app.ts` (+ wherever the process entrypoint lives —
grep for `createSyncApp(` callers / `listen(`). Add a shutdown path (returned
from `createSyncApp` as `close()`, or a `SIGTERM`/`SIGINT` handler at the
entrypoint) that: stops the shadow interval, calls `canvasActors?.close()`, and
closes the http server. Honor the Phase-2 caveat (line comment): `http.Server.
close()` may hang with abruptly-terminated sockets — force-close ws clients
first. Test: construct the app in-process, call the shutdown path, assert
`canvasActors.entries()` is empty and no timer keeps the process open
(`process.exit(0)` at test end). Commit `feat(server): app shutdown hook —
close canvas actors + shadow driver`.

## Task F3: dogfood /sync/v2 enablement note (no code, or a small guard)

`/sync/v2` is already mounted behind `EW_CANVAS_SYNC=1`. Dogfood enablement is an
**operational** step (set the flag in the dogfood deployment) — NOT a code
change here, so the `team` room's server path is byte-identical. If Open Q1's
mechanism needs a server-side dogfood-room allowlist (it does NOT under the
recommended client-side selector), add it here. Default: **no server code
change**; document the flag in Task H1. If nothing to commit, fold into H2.

## Task F4: presence wiring budget (contract lands in the client — Seam G)

The presence rate-limit (throttle publishes) and self-filter (D6) are BUDGETED
here but WIRED in Seam G (Task G4), because presence needs the real client
camera/cursor. This task is a placeholder in the index; its work is in G4. (Kept
as a line item so the Phase-2 presence deferral is visibly closed.)

---

# Seam G — client integration behind the per-room flag

**Dependency:** Seams C, D, E, F + Preflight P1/P2 (and P3 for Open Q4). This is
where zero-exposure is enforced.

## Task G1: loro-in-Vite fix + client workspace deps (implements P1/P2 verdicts)

**Files:** Modify `client/package.json` (add `@ensembleworks/canvas-model`,
`canvas-doc`, `canvas-sync`, `canvas-editor`, `canvas-react` as deps; add the P1
devDeps if candidate (a) won), `client/vite.config.ts` (the P1 verdict diff),
optionally `client/src/canvas-v2/boot.ts` (async init gate if candidate (b)).
Root `bun install`. **Verify the client still builds AND the existing tldraw app
still runs:** `bun run --filter '@ensembleworks/client' build` passes and the
`team` room still loads (manual/e2e smoke). Commit `feat(client): loro-crdt Vite
support + canvas-* workspace deps`.

## Task G2: component goldens for renderer + ported shapes

**Files:** `e2e/goldens/` fixtures + a Playwright component-golden spec (or
extend the existing visual-golden harness). Fixture states per shape renderer
(BoxShape + all six custom shapes), screenshot-diffed in isolation (design's
UI-tier 1). Runs in the e2e project. Commit `test(e2e): component goldens for
canvas-react shapes`.

## Task G3: engine selector + the dogfood mount

**Files:** Create `client/src/engine.ts` (`selectEngine(roomId): 'tldraw' |
'v2'`), `client/src/canvas-v2/CanvasV2App.tsx` (mounts `SyncClientPeer` +
`canvas-react` for a dogfood room); modify `client/src/App.tsx` /`main.tsx` to
branch on `selectEngine(getRoomId())` — `'tldraw'` renders the existing
`<App/>` UNCHANGED; `'v2'` renders `CanvasV2App`. **Open Q1 mechanism (default):**
`selectEngine` returns `'v2'` iff the room id is in a build-time allowlist
(`import.meta.env.VITE_CANVAS_V2_ROOMS` comma-split) OR `?engine=v2` is in the
URL; else `'tldraw'`. **Ratified Q1 amendment: `team` is HARD-EXCLUDED — it
resolves to `'tldraw'` unconditionally, even if it appears in the allowlist or
`?engine=v2` is present.** The room the whole team lives in must be unreachable
by construction, not merely by configuration discipline. `CanvasV2App` dials `${wsBase()}/sync/v2/${roomId}` via
`wsTransport`-equivalent client transport → `SyncClientPeer` → `canvas-editor`
`Editor` → `canvas-react`. Set `window.__ew = { editor }` (the design's E2E hook)
for v2. Commit `feat(client): per-room engine selector + dogfood canvas-v2 mount`.

## Task G4: presence wiring (throttled publish, self-filtered render)

**Files:** Modify `client/src/canvas-v2/CanvasV2App.tsx`; create
`client/src/canvas-v2/presence.ts` + a small test. Construct a `PresenceStore`,
inject it into `SyncClientPeer`. **Throttle** cursor/viewport publishes (Phase 2
note: uncoalesced set() → wire) — e.g. rAF-coalesced or ~60ms leading-edge
throttle; publish `stamp`/`presenting` on change. Feed `PresenceStore.all()`
(minus self, D6) to `canvas-react` cursors. On unmount call
`presenceStore.destroy()` (WASM timer). Test the throttle collapses a burst of N
cursor moves into ≤K publishes. Commit `feat(client): throttled presence publish
+ self-filtered cursor render`.

## Task G5: dogfood dev overlay (metrics + repair/pending telemetry)

**Files:** `client/src/canvas-v2/DevOverlay.tsx` (v2-only, dev/flag-gated).
Surfaces the deferred-again anomalies so a real dogfood occurrence is VISIBLE:
`SyncServerPeer.pendingImports`/`malformedFrames` (scraped from
`/api/canvas/metrics`), repair-firing count (from the client peer's repair
calls — add a lightweight counter to `SyncClientPeer` or the editor), reconnect
backfill bytes. This is the safety net for Open Q8/Q9/Q11 (fix deferred; make it
observable). Commit `feat(client): canvas-v2 dogfood dev overlay (pending/
repair/reconnect telemetry)`.

## Task G6: exposure audit (grep-level proof the default path is untouched)

**Files:** Create `client/src/engine.test.ts` (house style) AND a repo-level
audit script `scripts/exposure-audit.ts` run by `bun run test`.

**The audit must FAIL if the default room path can reach the new engine:**
```ts
// scripts/exposure-audit.ts — Run: bun scripts/exposure-audit.ts
import assert from 'node:assert/strict'
import { selectEngine } from '../client/src/engine.ts'
// 1. team + arbitrary non-allowlisted rooms resolve to tldraw with NO env/URL.
for (const r of ['team', 'random', 'planning', 'x'.repeat(64)])
  assert.equal(selectEngine(r, { allowlist: [], engineParam: null }), 'tldraw')
// 2. Only an explicit allowlist or ?engine=v2 flips a room to v2.
assert.equal(selectEngine('dogfood', { allowlist: ['dogfood'], engineParam: null }), 'v2')
assert.equal(selectEngine('team', { allowlist: ['dogfood'], engineParam: null }), 'tldraw')
assert.equal(selectEngine('anything', { allowlist: [], engineParam: 'v2' }), 'v2')
// 2b. Ratified Q1 amendment: `team` is HARD-EXCLUDED — even a misconfigured
// allowlist or an explicit ?engine=v2 override never flips it.
assert.equal(selectEngine('team', { allowlist: ['team'], engineParam: 'v2' }), 'tldraw')
// 3. main.tsx/App.tsx: the v2 mount is reachable ONLY through selectEngine.
import { readFileSync } from 'node:fs'
const appEntry = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8')
  + readFileSync(new URL('../client/src/App.tsx', import.meta.url), 'utf8')
// CanvasV2App must never be imported/rendered without a selectEngine guard.
assert.ok(!/CanvasV2App/.test(appEntry) || /selectEngine/.test(appEntry),
  'CanvasV2App reachable without selectEngine guard')
console.log('ok: exposure-audit')
```
(Refactor `selectEngine` to take an injectable `{allowlist, engineParam}` so the
test is deterministic and the production call reads env/URL.) Commit
`test(client): exposure audit — default room path never reaches the new engine`.

---

# Seam H — test rigs, perf, docs, finalize

## Task H1: docs — register workspaces + dogfood runbook

**Files:** Modify `AGENTS.md` (NOT `CLAUDE.md`): add `canvas-editor` +
`canvas-react` to the Workspaces line with one sentence each (headless editor;
thin renderer). Add a short "Dogfood rooms" note: set `EW_CANVAS_SYNC=1` on the
deployment + `VITE_CANVAS_V2_ROOMS` allowlist; `team` stays tldraw. `README.md`
if it lists workspaces. Verify `readlink CLAUDE.md` → `AGENTS.md`. Delete any
Preflight scratch. Commit `docs: register canvas-editor + canvas-react; dogfood
runbook`.

## Task H2: new-engine Playwright E2E (extends canvas-v2.spec.ts)

**Files:** Extend `e2e/tests/canvas-v2.spec.ts`. Real browser + real sync server
(`EW_CANVAS_SYNC=1`) + a seeded dogfood room; real pointer events; assert DOM
state AND doc state via `window.__ew.editor` (design UI-tier 2). **Multi-client
test:** two contexts in the same dogfood room, one creates/moves a shape, assert
the other's RENDERED DOM converges (design: "convergence of what is rendered").
On failure, auto-save the session-replay artifact (Seam C9). Ensure the spec
does NOT touch the `team` room. Commit `test(e2e): new-engine dogfood room —
interaction + multi-client render convergence`.

## Task H3: browser perf rig (nightly + pre-merge for renderer changes)

**Files:** `e2e/perf/canvas-v2-perf.spec.ts` + a `.github/workflows/` job (model
on `e2e.yml` + `canvas-soak.yml`). Playwright + CDP tracing on scripted
scenarios (pan/zoom sweep, 50-shape marquee drag, rapid sticky creation,
two-client cursor storm) measuring p95 frame time, pointerdown→paint,
dropped frames. **Budget: 60fps interaction at 1k shapes** (design); document the
degradation curve at 5k/10k (not gated). Commit `test(e2e): browser perf rig for
the new engine (nightly + renderer-PR)`.

## Task H4: DocumentActor-backed compacting soak variant

**Files:** Extend `canvas-sync/src/soak.ts` (or a sibling in `server/src/
canvas-v2/`) with a variant that runs clients against a real `DocumentActor`
(compaction on) for the prod-faithful growth curve the Phase-2 note asked for;
add a smoke variant to the per-commit suite and wire the long run into
`canvas-soak.yml`. **Recalibrate** the bounded-growth K and flat-RSS tolerance
against the post-index (Seam A) curve; record the new numbers. Commit
`test(canvas-sync): actor-backed compacting soak variant (post-index
recalibration)`.

## Task H5: final full-suite + typecheck + build gate

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase3
bun install
bun run typecheck                    # exit 0, all workspaces incl. canvas-editor + canvas-react
bun run test 2>&1 | tail -40         # green except the Task-0 baseline (if any)
bun run build                        # client build passes WITH loro-in-Vite (Seam G) + team app intact
EW_CANVAS_SYNC=1 bun run --filter '@ensembleworks/server' typecheck
```
Confirm: (a) tool manifest still `=== 27` across all four sites (no agent tool
added); (b) exposure audit (G6) green; (c) both new boundary tests green;
(d) `bun run build` succeeds. Commit any fixups: `chore(canvas-phase3):
full-suite + typecheck + build green`.

---

## Done criteria (maps to Phase 3 scope)

- [ ] **id→node index** replaces the O(n) `nodeByShapeId` scan; repair cost drops
      below the 7.36ms floor; convergence + repair suites still green. [A1, A2]
- [ ] **canvas-model geometry floor**: rotation-aware world bounds, point
      hit-test, spatial index (cull/marquee/topmost), snap + arrow-anchor
      resolution, geometry property test. [B1–B3]
- [ ] **canvas-editor workspace** exists, clean-room (boundary test: no DOM/
      React/loro/`Date.now`/`Math.random`), registered. Camera, selection,
      hover, editing state; interaction-script DSL; tools select/hand/note/text/
      geo/frame/arrow(+binding)/resize/rotate as pure FSMs; session-replay
      artifacts. [C1–C9]
- [ ] **canvas-react workspace** exists, logic-free (boundary rule), registered.
      Viewport + CSS-transform world + grid; shape-body host + culling; SVG
      overlay (selection/handles/snap/arrows); self-filtered cursors; text-edit
      mount; embed-lifecycle contract. [D1–D8]
- [ ] **Six custom shapes ported** into `canvas-react` (terminal/screenshare/
      iframe via embed lifecycle; neko/roadmap/file-viewer), with component
      goldens. [E1–E2, G2]
- [ ] **Per-room engine selector**: dogfood rooms mount the new engine over a
      real `SyncClientPeer` on `/sync/v2`; the `team` room and every
      non-allowlisted room stay on tldraw. **Exposure audit proves the default
      path never reaches the new engine.** [G1, G3, G6]
- [ ] **Presence wired**: throttled publish, self-filtered render, `destroy()` on
      unmount — the Phase-2 presence deferrals closed. [G4, D6]
- [ ] **loro-crdt runs in the Vite browser build** (Preflight P1 verdict
      implemented); client `bun run build` passes; the tldraw app still runs. [G1]
- [ ] **Server dogfood readiness**: idle-actor eviction + app shutdown hook
      wiring `canvasActors.close()`. [F1, F2]
- [ ] **Dogfood observability**: dev overlay surfaces pending/malformed/repair/
      reconnect telemetry (the deferred-again anomalies are visible). [G5]
- [ ] **Test rigs**: interaction-script + session-replay (editor); geometry
      property test (model); component goldens + new-engine Playwright E2E with
      multi-client render convergence (UI); browser perf rig (60fps@1k);
      actor-backed compacting soak. [C, B2, G2, H2, H3, H4]
- [ ] `bun run typecheck`, `bun run test`, `bun run build` green (modulo the
      Task-0 baseline); tool manifest still 27. [H5]

---

## Seam / task index

- **Preflight — probes:** P1 loro-in-Vite, P2 workspace-dep check, P3 rich-text
  feasibility. (3 probes)
- **Seam A — id→node index (prereq):** A1 index, A2 repair-cost pin. (2)
- **Seam B — canvas-model geometry:** B1 world bounds + hit-test, B2 spatial
  index + property test, B3 snap + anchors. (3)
- **Seam C — canvas-editor:** C1 scaffold+boundary, C2 store+intents, C3 input+
  DSL, C4 select, C5 hand+camera, C6 create tools, C7 arrow+binding, C8 resize+
  rotate, C9 session replay. (9)
- **Seam D — canvas-react:** D1 scaffold+boundary, D2 viewport+world+grid, D3
  shape host+cull, D4 overlay selection/handles/snap, D5 arrows, D6 cursors, D7
  text edit, D8 embed lifecycle. (8)
- **Seam E — custom shapes:** E1 terminal/screenshare/iframe, E2 neko/roadmap/
  file-viewer. (2)
- **Seam F — server dogfood:** F1 idle eviction, F2 shutdown hook, F3 enablement
  note, F4 presence budget (→G4). (3 code + 1 pointer)
- **Seam G — client integration:** G1 loro-Vite+deps, G2 component goldens, G3
  engine selector+mount, G4 presence wiring, G5 dev overlay, G6 exposure audit.
  (6)
- **Seam H — finalize:** H1 docs, H2 E2E, H3 perf rig, H4 actor soak, H5 gate. (5)

Plus Task 0 (baseline). **Total: ~41 tasks + 3 probes + baseline.**

### Suggested unit grouping (~14 implementer units)

1. Preflight P1–P3 + Task 0. 2. Seam A (A1–A2). 3. Seam B (B1–B3).
4. C1–C3 (editor core). 5. C4–C6 (base tools). 6. C7–C9 (arrow/transform/replay).
7. D1–D3 (renderer core). 8. D4–D6 (overlay/cursors). 9. D7–D8 (text/embed).
10. Seam E (E1–E2). 11. Seam F (F1–F2). 12. G1 + G3 (mount). 13. G2, G4–G6
(goldens/presence/overlay/audit). 14. Seam H (H1–H5). Units 2 and 3 and 11 are
parallelizable early; the editor→renderer→client chain (4→…→13) is sequential.

---

## Open questions for the controller (ratify before execution)

Judgment calls the plan made where the design left room. Each has a chosen
default (what the tasks implement) and the alternative. **House standard: no
"probably/should be fine" — anything technical that isn't settled is a preflight
probe (P1–P3) or an item below.**

1. **Per-room flag mechanism.** *Default:* client-side `selectEngine(roomId)`
   using a build-time allowlist `VITE_CANVAS_V2_ROOMS` (comma-split) + a
   `?engine=v2` URL override; `team` and every unlisted room resolve to tldraw by
   construction; server sets `EW_CANVAS_SYNC=1` for dogfood and the client only
   dials `/sync/v2` for allowlisted rooms. *Alternative:* a room-id prefix
   convention (`v2-<name>`), or a server-side dogfood allowlist that rejects
   `/sync/v2` for non-dogfood rooms (defense-in-depth). [G3, G6]

2. **canvas-editor + canvas-react as two new clean-room workspaces** (completing
   the design's five-package set). *Default:* yes — preserves the swappable/
   testable/Electron-ready architecture and the boundary rules. *Alternative:*
   build the renderer directly inside `client` (faster, but forfeits the headless
   test rig, the logic-free boundary, and Electron readiness). [C1, D1]

3. **Tool set in scope for Phase 3.** *Default:* select/hand/note/text/geo/frame/
   arrow(+binding)/resize/rotate. **Defer draw/ink/eraser/line/highlight to
   Phase 4** (perfect-freehand + eraser interactions are heavy, not needed to
   dogfood, and `perfect-freehand` is not installed). *Alternative:* include ink
   now (adds a dep + a tool + overlay renderer D5's Ink.tsx). [C4–C8, D5]

4. **Rich text vs plain text (gated on Preflight P3).** *Default:* ship
   plain-text editing bound to the shape's `LoroText` container this phase; land
   full ProseMirror + `loro-prosemirror` rich text ONLY if P3 confirms
   compatibility with the pinned loro-crdt 1.13.6 — else defer rich text to
   Phase 4. *Alternative:* commit to full ProseMirror now regardless (risk: an
   incompatible/heavy dep on the critical path). [D7, P3]

5. **Which custom shapes port now.** *Default:* all six (design: they force the
   embed-lifecycle design). *Alternative:* port terminal + iframe now (the
   product-critical + the embed archetype), defer neko/roadmap/screenshare/
   file-viewer to Phase 4. [E1, E2]

6. **Geometry/hit-test location.** *Default:* `canvas-model` (pure; reused
   server-side for spatial semantics). *Alternative:* `canvas-editor` (keeps
   canvas-model free of interaction-shaped geometry). [B1–B3]

7. **Idle-actor eviction + app shutdown hook in Phase 3.** *Default:* both in
   scope (dogfood rooms now hold real long-lived actors + data). *Alternative:*
   defer eviction to Phase 5 cutover (only a handful of dogfood rooms exist in
   Phase 3, so unbounded actor accumulation is survivable). [F1, F2]

8. **pendingImports server→sender re-request (the C3-scope protocol extension).**
   *Default:* defer again to Phase 4; make it OBSERVABLE in the dogfood dev
   overlay (G5) so a real occurrence surfaces. *Alternative:* implement the
   `SyncServerPeer`→sender `SyncRequest` extension now (closes the "client
   connects during a pending window" residual edge). [G5]

9. **reconnect() full-history backfill.** *Default:* keep the correct-but-fat
   full-history push; add a reconnect-backfill byte counter to the dev overlay
   (G5) to decide in Phase 4 whether the since-acked-version delta is worth it.
   *Alternative:* implement the delta optimization now. [G5]

10. **DocumentActor-backed compacting soak variant.** *Default:* add it after the
    id→node index (H4) for a prod-faithful growth curve + recalibrate K/RSS.
    *Alternative:* keep the sync-rig-only soak (its no-compaction curve overstates
    prod, but it is cheaper). [H4]

11. **Known-lossy repair edges surfaced to dogfood users.** *Default:* add
    repair-firing telemetry (G5) so a real firing is visible, but do NOT fix the
    lossy dedupe/reparent edges this phase (Phase 4 parity). *Alternative:* fix
    the lossy edges now (design-quality, but scope creep into parity work). [G5]

12. **Browser perf rig cadence + gating.** *Default:* nightly + pre-merge for
    renderer-touching PRs; 60fps@1k is the gated budget; 5k/10k degradation
    documented, not gated. *Alternative:* gate 5k too (stricter, riskier for
    flaky CI). [H3]

13. **Agent writes stay on the tldraw/v2-read path in Phase 3.** *Default:* yes
    — agents never write to the dogfood Loro doc this phase; agent-write cutover
    to v2 is Phase 4 (design). Confirming so no task wires agent writes into the
    dogfood engine. *Alternative:* begin agent writes to v2 in dogfood rooms now
    (pulls Phase 4 forward; needs the validating semantic API, not built). [—]

---

## Ratification (2026-07-12, controller)

All 13 open questions ratified with the plan's defaults, with ONE amendment:

- **Q1 amended:** the `?engine=v2` URL override as originally specified could
  flip the `team` room to v2 for any user who typed the param. `team` is now
  HARD-EXCLUDED in `selectEngine` — it resolves to `'tldraw'` unconditionally,
  regardless of allowlist contents or URL override. G3's task text and G6's
  audit code were amended in place; G6 pins the exclusion with an explicit
  `selectEngine('team', { allowlist: ['team'], engineParam: 'v2' }) ===
  'tldraw'` assertion.
- **Q4 stays gated on P3's empirical verdict** (plain text unless
  `loro-prosemirror` proves compatible with the exact loro-crdt 1.13.6 pin);
  the default task text in D7 already encodes this.
- Preflight verdicts (P1–P3) must be recorded durably in this file under a
  `## Preflight verdicts` section (committed), not only in an agent's final
  message — Seam G implements from that record.
