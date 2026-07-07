# Bun runtime migration — design

- **Status:** Draft (2026-07-05)
- **Phase:** Unified architecture migration, **Phase 3 (the cutover), sub-project 1 of 8**
- **Parent:** [`../../unified-architecture-design.md`](../../unified-architecture-design.md) §2 (runtime decisions), §7 (roadmap)
- **Branch base:** `unified-architecture-migration`

## Where this sits

Phase 3 (THE CUTOVER RELEASE) decomposes into eight sub-projects:

1. **Bun runtime migration** ← *this spec*
2. Contracts tool spine (verb registry, shared `session-manager.ts`, `whoami.ts`)
3. Clean routes + auth plane (`/api/<plugin>/…`, `/api/whoami`, attribution)
4. The `ensembleworks` CLI
5. The connector (`terminal connect`)
6. Transcriber cutover (compiled under Bun)
7. Distribution + artifact-based `deploy.sh`
8. The cutover release (retirements, reseed, data-load check)

Sub-projects 1, 2, and 6 are behaviour-neutral and land incrementally on the
branch, shrinking the breaking surface of the eventual cutover — the same
posture that made Phases 1–2 pre-cutover restructures.

## Goal

Move the entire repo — dev servers, tests, and builds — onto **Bun as the only
JS runtime, run from source**, with a clean break from npm/Node. No user-facing
behaviour change. Contributor host requirement becomes **bun + docker**.

## Scope boundary (decided)

**In scope — run/build/test from source under Bun:**
- `bun install` + `bun.lock` replace npm + `package-lock.json`.
- All root and per-workspace scripts run under Bun (`bun`, `bun --watch`,
  `bun --bun vite`); the `tsx` dependency is removed (Bun runs `.ts` natively).
- A `bun:sqlite`-backed `DatabaseSync` adapter so the sync server runs under Bun
  (`node:sqlite` is absent in Bun even uncompiled).
- **node-pty → `Bun.Terminal`, in-place in `terminal-gateway.ts`**, so the
  terminal gateway runs under Bun (node-pty is a native Node addon Bun cannot
  load — the reason the `.nvmrc` pin exists).
- Delete the Node version pin and every reference to it (dev + deploy).
- Devcontainer, `bin/dev`, and contributor docs onto Bun.
- A single `bun run test` entrypoint; the ~31 `Run: npx tsx …` test headers
  updated to `bun`.

**Out of scope (later sub-projects):**
- `bun build --compile` standalone binaries, the `CLIENT_DIST` fix, CI compile
  jobs — **sub-project 7** (running from source uses the real
  `import.meta.dirname`, so neither is needed yet).
- Extracting the gateway's PTY code into the shared
  `contracts/session-manager.ts` used by the CLI connector — **sub-project 2**.
  This slice does the minimal in-place swap; the extraction is a later,
  separately-shippable refactor.
- The artifact-based `deploy.sh` rewrite (fetch-verify-swap) — **sub-project
  7**. This slice only updates the deploy scripts' *Node-pin references* so they
  don't break when `.nvmrc` is deleted; the deploy mechanism is untouched.
- The transcriber's `room.connect()` exercise — **sub-project 6**. This slice
  only ensures the transcriber runs under `bun` in dev (Phase-0 spike C proved
  import + runtime + compiled-addon).

## The changes

### 1. Package management

- `rm package-lock.json`; `bun install` generates `bun.lock` (committed).
- Root `package.json` scripts move to Bun workspace form:
  - `typecheck`: run each workspace's `tsc --noEmit` via `bun run --filter '*' typecheck`
    (or explicit per-workspace `bun run --filter <name> typecheck`) plus
    `bunx tsc -p bin/tsconfig.json`. The exact `--filter` invocation is verified
    in the plan against the installed Bun; the ordering (contracts first) is
    preserved so downstream workspaces typecheck against built contracts types.
  - `build`: `bun run --filter <name> build` for client → server → transcriber,
    order preserved.
  - `dev`: the `& … wait` fan-out stays; each arm calls the workspace's Bun
    `dev` script.
- Remove `tsx` from every workspace's `devDependencies`. Keep `typescript`
  (needed for `tsc` typecheck via `bunx`).

### 2. Per-workspace scripts

| Workspace | Script | Before | After |
|---|---|---|---|
| server | `dev` | `CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=500 tsx watch src/sync-server.ts` | `bun --watch src/sync-server.ts` |
| server | `dev:term` | `…tsx watch src/terminal-gateway.ts` | `bun --watch src/terminal-gateway.ts` |
| server | `start` / `start:term` | `tsx src/…` | `bun src/…` |
| server | `build` / `typecheck` | `tsc --noEmit` | `bunx tsc --noEmit` |
| transcriber | `dev` / `start` | `tsx [watch] src/transcriber.ts` | `bun [--watch] src/transcriber.ts` |
| transcriber | `build` / `typecheck` | `tsc --noEmit` | `bunx tsc --noEmit` |
| client | `dev` | `vite` | `bun --bun vite` |
| client | `build` | `tsc --noEmit && vite build` | `bunx tsc --noEmit && bun --bun vite build` |
| client | `preview` | `vite preview` | `bun --bun vite preview` |
| contracts | `typecheck` | `tsc --noEmit` | `bunx tsc --noEmit` |

The `CHOKIDAR_USEPOLLING`/`CHOKIDAR_INTERVAL` env vars are chokidar/tsx-specific
and are dropped. They existed because tsx's watcher missed edits over the
devcontainer bind mount; `bun --watch` uses its own watcher. **Risk R1** below
covers verifying hot-reload fires over the mount; if it does not, find Bun's
polling equivalent or accept a manual dev restart (documented).

### 3. The sqlite adapter

New `server/src/kernel/sqlite.ts`: a `DatabaseSync` class backed by
`bun:sqlite`'s `Database`, exposing exactly the surface sync-core uses —
`exec(sql)`, `prepare(sql)` returning a statement with `.all()`, `.run()`,
`.iterate()`. `server/src/kernel/rooms.ts:8` changes its import from
`node:sqlite` to `./sqlite.ts`; the `new DatabaseSync(path)` call site
(`rooms.ts:32`) is unchanged.

This is the production form of the Phase-0 throwaway shim
(`spikes/phase0/FINDINGS.md`), which proved these method shapes are compatible
(sync-core's `NodeSqliteWrapper` calls `db.exec`/`db.prepare`; `SQLiteSyncStorage`
calls `.all`/`.run`/`.iterate`). A new `server/src/kernel/sqlite.test.ts` opens
a temp db, creates a table, and exercises exec + prepared `all`/`run`/`iterate`
so the adapter's contract is locked independently of a running server.

### 4. node-pty → `Bun.Terminal` (in-place)

`server/src/terminal-gateway.ts` currently uses node-pty:
`import pty, { type IPty } from 'node-pty'`; `pty.spawn(spec.file, spec.args,
{ name, cols, rows, cwd, env })`; on the returned handle `.onData`, `.onExit`,
`.resize(cols, rows)`, `.write(data)`, `.kill()`; and the `IPty` type on the
`Session` record.

Replace the node-pty handle with a `Bun.Terminal` PTY (the `Bun.Terminal` /
`Bun.spawn(cmd, { terminal })` API validated in Phase-0 spike D: spawn `tmux new
-A` through a real PTY, write, read via data callback, resize 80×24→120×40, exit
clean). A small internal wrapper (`server/src/terminal/pty.ts`, name TBD in the
plan) presents the same `spawn/onData/onExit/resize/write/kill` surface the
gateway already consumes, so the gateway body changes minimally — only the
import, the `Session.pty` field type, and the spawn call. The relay WS protocol,
tmux session naming (`canvas-<id>`), privilege-drop launcher path, and fan-out
logic are all untouched.

**This is the minimal in-place swap.** Sub-project 2 extracts this wrapper into
`contracts/src/session-manager.ts` shared with the CLI connector; here it lives
in the server so this slice stays self-contained. `node-pty` is removed from
`server/package.json` dependencies.

The plan verifies the exact `Bun.Terminal` method names/shape against Bun
≥ 1.3.14 (the spike used it) and adapts the wrapper accordingly — no `any`
loosening.

### 5. Delete the Node pin and every reference

`.nvmrc` (pins Node `22.22.3`, rationale "node-pty ABI") is deleted. With
node-pty gone (§4) the pin has no remaining purpose. Every reader is updated:

**Dev-side (this slice owns fully):**
- `bin/dev-main.mjs:65-79` — the `wantedNode`/`parseNvmrc` enforcement and
  mise re-exec (the "node-pty ABI" gate). Replaced by a Bun-presence/floor
  check (bun ≥ 1.3.14) or removed if `bin/dev` now runs under Bun and Bun's own
  presence is implicit.
- `bin/dev-doctor.mjs:37,53-56` — the node-version check and the
  `require('node-pty')` doctor probe. The node-pty probe is deleted
  (`Bun.Terminal` is built in, nothing to check); the version check becomes a
  Bun floor check.
- `bin/dev-lib.mjs:146` (`parseNvmrc`) and `bin/dev.test.ts:52-53` — remove
  `parseNvmrc` and its tests, or repurpose to a Bun-version parse if a floor
  check keeps a parser.
- `.devcontainer/Dockerfile:28-36` — replace the Node tarball install with a
  pinned Bun install (≥ 1.3.14). The `COPY .nvmrc` line goes.

**Deploy-side (pin references only — mechanism stays sub-project 7):**
- `deploy/release.sh:38-41` — the `node -v` == `.nvmrc` preflight. Rewritten to
  check `bun --version` against the Bun floor (or the check is removed; the plan
  picks one and states why). Without this, deleting `.nvmrc` breaks `release.sh`.
- `deploy/runtime-requirements:7` — the `node exact 22.22.3` row becomes a
  `bun` minimum row.
- `deploy/bootstrap-debian-ash.sh:67,100` — `NODE_VERSION`/`node -v` install
  block becomes a Bun install block.
- `deploy/test/lib_test.sh` — version-check fixtures updated to Bun values.

### 6. Host setup & `bin/dev`

- `bin/dev` shebang `#!/usr/bin/env node` → `#!/usr/bin/env bun` (Bun runs the
  CJS shim and the `.mjs` implementation). The host controller and the in-
  container engine both now require Bun — already the contributor requirement.
- `bin/dev.test.ts` and any `bin/*.mjs` that shell out to `node`/`npm`/`tsx`
  (e.g. spawning the dev servers) switch to `bun`. The plan greps
  `bin/*.mjs` for `node`/`npm`/`npx`/`tsx` spawns and converts each.
- `CLAUDE.md` and `README.md`: contributor requirement Node → **bun + docker**;
  any `npm run …` in docs → `bun run …`.

### 7. Test runner

- Add a root `test` script that discovers `**/src/**/*.test.ts` (excluding
  `node_modules`) and runs each with `bun <file>`, failing on the first
  non-zero exit. One command for humans and for the CI smoke job that
  sub-project 7 will add.
- Update the **31** `Run: npx tsx src/….test.ts` header comments to
  `Run: bun src/….test.ts`.
- **One** file uses `node:test` style: `contracts/src/user-id.test.ts`
  (`import { test } from 'node:test'`, run with `--test`). The plan first checks
  whether Bun runs it as-is (Bun implements much of `node:test`); if not, it is
  converted to the plain top-level-`assert` self-running style the other ~30
  suites use (no `node:test` import, no `--test` flag) so `bun <file>` runs it
  uniformly. **Risk R2.**

## Behaviour equivalence

Nothing observable changes. Same routes, same wire protocols, same shape types,
same tmux session behaviour, same rendered client. The only substitutions are
runtime-internal: the sqlite driver (node:sqlite → bun:sqlite, identical SQL and
persistence), the PTY driver (node-pty → Bun.Terminal, identical spawn/resize/
write/data over the same relay protocol), and the process runtime (Node → Bun).

## Testing / verification

The slice is proven behaviour-neutral by, in order:

1. `bun install` completes; `bun.lock` committed; no `package-lock.json`.
2. `bun run typecheck` green across contracts, client, server, transcriber, bin.
3. `bun run test` — all suites pass under Bun (incl. the new `sqlite.test.ts`
   and the converted `user-id.test.ts` if converted).
4. `bun run build` — client (Vite under Bun), server, transcriber all build.
5. Server boots under Bun: `bun server/src/sync-server.ts` with a scratch
   `DATA_DIR` → `/api/health` 200; the Phase-0 `smoke-client.ts` round-trips a
   room sync (WS upgrade + sync-core + bun:sqlite persistence).
6. Terminal gateway boots under Bun: `bun server/src/terminal-gateway.ts`; a
   relay round-trip spawns a tmux client through `Bun.Terminal`, writes a
   command, reads output, resizes. (`relay-loopback.test.ts` is the automated
   guard; it must pass under Bun.)
7. `bin/dev up` brings the whole stack up under Bun; the live browser smoke
   (toolbar renders, session panel renders, create+delete a terminal shape
   raises the confirm dialog once) still passes.

## Risks & mitigations

- **R1 — file-watching over the devcontainer bind mount.** `bun --watch` may
  miss edits on the mount the way tsx did without `CHOKIDAR_USEPOLLING`.
  *Mitigation:* the plan verifies hot-reload in the container; if it fails,
  find Bun's polling knob (or `--watch` alternative) or document a manual dev
  restart. Does not affect correctness, only dev ergonomics.
- **R2 — `node:test` under Bun.** `contracts/src/user-id.test.ts` may not run
  under `bun <file>`. *Mitigation:* convert to the plain-`assert` self-running
  style (one small file).
- **R3 — `Bun.Terminal` API shape vs the spike.** The spike proved the
  capability; exact method names are pinned in the plan against Bun ≥ 1.3.14.
  *Mitigation:* the internal PTY wrapper isolates the gateway from the exact
  API; `relay-loopback.test.ts` is the behavioural guard.
- **R4 — `bun:sqlite` method parity.** Proven in Phase-0 for the methods
  sync-core uses; `sqlite.test.ts` locks the contract. If sync-core later calls
  a method bun:sqlite lacks, it surfaces as a test/boot failure, not silent
  corruption.
- **R5 — transcriber `@livekit/rtc-node` under `bun` in dev.** Phase-0 spike C
  passed import + runtime + compiled addon; only `room.connect()` is deferred
  (sub-project 6). *Mitigation:* verify the transcriber process starts under
  `bun` in this slice; the live-connect path is exercised in sub-project 6.
- **R6 — Bun ≥ 1.3.14 as a hard floor.** Default `bun` on some contributor
  hosts is older (the mise default was 1.3.4 during spikes). *Mitigation:* the
  devcontainer pins ≥ 1.3.14; `bin/dev`/doctor and `deploy` checks assert the
  floor with a clear remedy.

## File inventory (touched)

- **Delete:** `.nvmrc`, `package-lock.json`.
- **Add:** `bun.lock`, `server/src/kernel/sqlite.ts` (+ `.test.ts`),
  `server/src/terminal/pty.ts` (Bun.Terminal wrapper; name TBD in plan).
- **Modify:** root `package.json`; `server`/`client`/`transcriber`/`contracts`
  `package.json`; `server/src/kernel/rooms.ts`;
  `server/src/terminal-gateway.ts`; `.devcontainer/Dockerfile`; `bin/dev`,
  `bin/dev-main.mjs`, `bin/dev-doctor.mjs`, `bin/dev-lib.mjs`, `bin/dev.test.ts`;
  `deploy/release.sh`, `deploy/runtime-requirements`,
  `deploy/bootstrap-debian-ash.sh`, `deploy/test/lib_test.sh`; the 31
  `*.test.ts` header comments; `contracts/src/user-id.test.ts` (if converted);
  `CLAUDE.md`, `README.md`.
