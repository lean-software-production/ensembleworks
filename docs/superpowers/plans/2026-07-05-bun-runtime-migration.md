# Bun Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the whole repo (dev servers, tests, builds) onto Bun as the only JS runtime, run from source, with a clean break from npm/Node and zero behaviour change.

**Architecture:** Clean-break runtime swap: bun install/bun.lock replace npm; a bun:sqlite-backed DatabaseSync adapter and an in-place node-pty→Bun.Terminal swap unblock the two server processes under Bun; all scripts go node-independent, then the Node pin and its ~6 reader sites are deleted. Compilation/artifacts/deploy-mechanism are explicitly deferred to Phase 3 sub-project 7.

**Tech Stack:** Bun ≥ 1.3.14, bun:sqlite, Bun.Terminal, Vite (under Bun), tldraw sync-core, express 5, ws.

---

## Environment & sequencing constraints (read before starting)

These are baked into the task order below; violating them breaks the branch mid-migration.

1. **Bun version gotcha.** The default `bun` on PATH is **1.3.4**. Bun.Terminal and the build floor need **≥ 1.3.14**, installed at `~/.local/share/mise/installs/bun/1.3.14/bin`. Task 1 pins Bun with a repo-root `.tool-versions` file containing `bun 1.3.14`, so mise resolves 1.3.14 inside the repo. **Every command in every task assumes `bun --version` reports `1.3.14` in-repo.** If mise is not auto-activating in your shell, run the fallback first:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14 before you run anything else
   ```

2. **Node-independence lands BEFORE Node removal.** Workspace scripts become node-independent (`bunx tsc`, `bun --bun vite`, `bun src/x.ts`) in **Task 5**, before the devcontainer/Dockerfile drops Node and `.nvmrc` is deleted in **Task 7**. Reason: the `tsc`/`vite` bins carry `#!/usr/bin/env node` shebangs, so a bare `tsc`/`vite` under `bun run` still needs Node on PATH; `bunx tsc` and `bun --bun vite` run them **under Bun** instead. Node stays present on the host through Tasks 1–6, which is why `tsc`-via-shebang keeps resolving there.

3. **The `.nvmrc` deletion cascades.** Do not delete `.nvmrc` until every reader stops needing it: `bin/dev` enforcement → Bun check; devcontainer → Bun install; `deploy/release.sh` preflight → Bun; `deploy/runtime-requirements` → Bun row; `deploy/bootstrap-debian-ash.sh` → Bun install; `deploy/test/lib_test.sh` fixtures. All of that is Tasks 7–8, and `.nvmrc` is deleted only inside Task 7 after its dev-side readers are converted.

4. **The local build gate moves to Bun; the deploy mechanism does not.** `deploy/release.sh`'s `npm ci && npm run typecheck && npm run build` gate becomes `bun install && bun run typecheck && bun run build` in Task 8. The fetch-verify-swap / artifact-based `deploy.sh` **rewrite stays sub-project 7** — this slice only touches the Node-pin references and that one local build gate.

5. **Per-task green + commits.** Every task ends by committing, and every task must leave `bun run typecheck` green. Each commit uses these trailer lines:
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```
   (Git wrapper note: this repo's `git` runs through a direnv wrapper — commit exactly as shown.)

---

## Task 1 — Bun toolchain pin + workspace install + root scripts

**Goal:** Pin Bun 1.3.14 for the repo, replace npm's lockfile with `bun.lock`, and move the root `package.json` scripts to Bun `--filter` form (preserving contracts-first typecheck order and client→server→transcriber build order). Node is still on the host, so `tsc`-via-shebang keeps resolving — node-independence is Task 5.

**Files:** `.tool-versions` (new), `package.json` (root), `package-lock.json` (delete), `bun.lock` (new).

**Steps:**

- [ ] **Create `.tool-versions`** at the repo root with exactly:
  ```
  bun 1.3.14
  ```

- [ ] **Confirm the pinned Bun is active** (see Environment constraint 1):
  ```bash
  bun --version
  ```
  Expected output:
  ```
  1.3.14
  ```
  If it prints `1.3.4`, apply the PATH fallback from constraint 1 and re-check before continuing.

- [ ] **Rewrite the root `package.json` `scripts` block.** Before:
  ```json
    "scripts": {
      "dev": "npm run dev --workspace=server & npm run dev:term --workspace=server & npm run dev --workspace=client & wait",
      "build": "npm run build --workspace=client && npm run build --workspace=server && npm run build --workspace=transcriber",
      "typecheck": "npm run typecheck --workspace=contracts && npm run typecheck --workspace=client && npm run typecheck --workspace=server && npm run typecheck --workspace=transcriber && tsc -p bin/tsconfig.json"
    }
  ```
  After:
  ```json
    "scripts": {
      "dev": "bun run --filter '@ensembleworks/server' dev & bun run --filter '@ensembleworks/server' dev:term & bun run --filter '@ensembleworks/client' dev & wait",
      "build": "bun run --filter '@ensembleworks/client' build && bun run --filter '@ensembleworks/server' build && bun run --filter '@ensembleworks/transcriber' build",
      "typecheck": "bun run --filter '@ensembleworks/contracts' typecheck && bun run --filter '@ensembleworks/client' typecheck && bun run --filter '@ensembleworks/server' typecheck && bun run --filter '@ensembleworks/transcriber' typecheck && bunx tsc -p bin/tsconfig.json"
    }
  ```
  (Ordering is explicit `&&` per-workspace rather than `--filter '*'` precisely so contracts typechecks first and `bunx tsc -p bin/tsconfig.json` runs last. `bunx tsc` runs the local TypeScript under whatever shebang while Node is present; it stays green here.)

- [ ] **Generate the Bun lockfile and drop npm's:**
  ```bash
  rm package-lock.json
  bun install
  ```
  Expected: `bun install` completes and writes `bun.lock` at the repo root; `git status` shows `bun.lock` new, `package-lock.json` deleted.

- [ ] **Verify (config-only task):**
  ```bash
  bun install          # clean, no changes on a second run
  bun run typecheck    # green across contracts, client, server, transcriber, bin
  ```
  Expected: `bun run typecheck` exits 0 (no diagnostics). Node is still resolving `tsc` via its shebang at this point — that is fine.

- [ ] **Commit:**
  ```bash
  git add .tool-versions package.json bun.lock
  git rm package-lock.json
  git commit -m "$(cat <<'EOF'
  build(bun): pin bun 1.3.14, bun.lock, root scripts to --filter form

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — bun:sqlite DatabaseSync adapter (TDD)

**Goal:** Give the sync server a `bun:sqlite`-backed `DatabaseSync` so `rooms.ts` runs under Bun (`node:sqlite` is absent in Bun even uncompiled). Lock the exact surface sync-core uses with a self-running test written first.

**Files:** `server/src/kernel/sqlite.test.ts` (new), `server/src/kernel/sqlite.ts` (new), `server/src/kernel/rooms.ts` (import swap).

**Surface to reproduce (what sync-core calls):** `NodeSqliteWrapper` calls `db.exec(sql)` and `db.prepare(sql)`; `SQLiteSyncStorage` calls the prepared statement's `.all()`, `.run()`, `.iterate()`. The `new DatabaseSync(path)` call site in `rooms.ts:32` must stay byte-for-byte identical.

**bun:sqlite API to verify while implementing (map to what `node:sqlite`'s `DatabaseSync` exposed, then lock it with the test):**
- `import { Database } from 'bun:sqlite'`; `new Database(path)`.
- Multi-statement DDL: `db.exec(sql)`.
- Prepared statement: `db.prepare(sql)` → statement with `.all(...params)`, `.run(...params)` (returns `{ changes, lastInsertRowid }`), `.values(...)`, and iteration via `.iterate(...params)`.
- Confirm `.iterate()` exists on Bun 1.3.14's `Statement` (it does on ≥ 1.1). If a method name differs, adapt the wrapper — **do not loosen types with `any`** — and let the test pin the mapping.

**Steps:**

- [ ] **Write the failing test first.** Create `server/src/kernel/sqlite.test.ts`:
  ```ts
  // Run: bun src/kernel/sqlite.test.ts
  // Locks the bun:sqlite-backed DatabaseSync adapter's contract (exec + prepared
  // all/run/iterate) independently of a running server. Mirrors the surface
  // sync-core's NodeSqliteWrapper / SQLiteSyncStorage consume.
  import assert from 'node:assert/strict'
  import { mkdtempSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { DatabaseSync } from './sqlite.ts'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-sqlite-test-'))
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'))

  // exec: multi-statement DDL, no result.
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)')

  // prepared run: reports one changed row.
  const insert = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)')
  const r = insert.run('a', 'alpha')
  assert.equal(Number(r.changes), 1, 'run reports one changed row')
  insert.run('b', 'beta')

  // prepared all: both rows, ordered.
  const rows = db.prepare('SELECT k, v FROM kv ORDER BY k').all() as { k: string; v: string }[]
  assert.deepEqual(rows, [{ k: 'a', v: 'alpha' }, { k: 'b', v: 'beta' }], 'all returns both rows')

  // prepared iterate: yields each row lazily.
  const seen: string[] = []
  for (const row of db.prepare('SELECT k FROM kv ORDER BY k').iterate() as IterableIterator<{ k: string }>) {
    seen.push(row.k)
  }
  assert.deepEqual(seen, ['a', 'b'], 'iterate yields each row')

  console.log('ok: bun:sqlite DatabaseSync adapter')
  ```

- [ ] **Run it — expect failure** (adapter does not exist yet):
  ```bash
  cd server && bun src/kernel/sqlite.test.ts; cd ..
  ```
  Expected: a resolution error, e.g. `Cannot find module './sqlite.ts'` / `error: Could not resolve`.

- [ ] **Implement the adapter.** Create `server/src/kernel/sqlite.ts`:
  ```ts
  /**
   * DatabaseSync — a bun:sqlite-backed drop-in for the surface node:sqlite's
   * DatabaseSync exposed, exactly what @tldraw/sync-core drives:
   * NodeSqliteWrapper calls exec()/prepare(); SQLiteSyncStorage calls the
   * prepared statement's all()/run()/iterate(). node:sqlite is absent under Bun,
   * so this adapter is what lets the sync server run from source on Bun.
   * Contract is locked by ./sqlite.test.ts.
   */
  import { Database } from 'bun:sqlite'

  export interface RunResult {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export interface StatementSync {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): RunResult
    iterate(...params: unknown[]): IterableIterator<unknown>
  }

  export class DatabaseSync {
    #db: Database

    constructor(filename: string) {
      this.#db = new Database(filename)
    }

    exec(sql: string): void {
      this.#db.exec(sql)
    }

    prepare(sql: string): StatementSync {
      const stmt = this.#db.prepare(sql)
      return {
        all: (...params) => stmt.all(...(params as never[])),
        run: (...params) => {
          const res = stmt.run(...(params as never[]))
          return { changes: res.changes, lastInsertRowid: res.lastInsertRowid }
        },
        iterate: (...params) => stmt.iterate(...(params as never[])),
      }
    }
  }
  ```
  (If Task-3-style API verification shows a different method name for lazy iteration, adjust the `iterate` line to the confirmed name — the test guards it.)

- [ ] **Run the test — expect pass:**
  ```bash
  cd server && bun src/kernel/sqlite.test.ts; cd ..
  ```
  Expected output ends with:
  ```
  ok: bun:sqlite DatabaseSync adapter
  ```

- [ ] **Swap the import in `server/src/kernel/rooms.ts`.** Line 8, before:
  ```ts
  import { DatabaseSync } from 'node:sqlite'
  ```
  After (server house style uses explicit `.ts` extensions — see the neighbouring `'../schema.ts'` import; `allowImportingTsExtensions` is on in `server/tsconfig.json`):
  ```ts
  import { DatabaseSync } from './sqlite.ts'
  ```
  The `new DatabaseSync(path.join(roomsDir, `${roomId}.sqlite`))` call at line 32 is unchanged.

- [ ] **Verify the server sqlite path boots under Bun (existing smoke):**
  ```bash
  DATA_DIR="$(mktemp -d)" PORT=8788 bun server/src/sync-server.ts &
  sleep 1
  curl -sf http://localhost:8788/api/health && echo " HEALTH-OK"
  kill %1
  ```
  Expected: a JSON health body followed by ` HEALTH-OK` (proves `rooms.ts` opened a room DB through the new adapter). Then:
  ```bash
  bun run typecheck    # still green
  ```

- [ ] **Commit:**
  ```bash
  git add server/src/kernel/sqlite.ts server/src/kernel/sqlite.test.ts server/src/kernel/rooms.ts
  git commit -m "$(cat <<'EOF'
  feat(server): bun:sqlite DatabaseSync adapter; rooms.ts off node:sqlite

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — Verify the Bun.Terminal API (throwaway spike)

**Goal:** The Phase-0 PTY spike code was never committed (only recorded in the design doc), so before the swap, pin the **exact** method names/shape of Bun 1.3.14's PTY API with a tiny throwaway script. **The script is discarded — not committed.** The deliverable is a `Bun.Terminal API notes` block appended to this plan's **Execution notes** section (and carried into the wrapper header comment in Task 4).

**node-pty surface the wrapper must reproduce (from `terminal-gateway.ts`):**
- `pty.spawn(file, args, { name, cols, rows, cwd, env })` → handle
- `handle.onData((data: string) => void)` — data delivered as a UTF-8 **string**
- `handle.onExit(() => void)`
- `handle.resize(cols, rows)`
- `handle.write(data: string)`
- `handle.kill()`

**Steps:**

- [ ] **Write a throwaway spike** at `server/src/terminal/_pty_spike.ts` (temporary — deleted at the end of this task). It must, under Bun ≥ 1.3.14:
  1. Spawn `tmux -V` (or `tmux new-session -A -s spike-<rand>`) through a real Bun PTY. Confirm the actual spawn form — likely `Bun.spawn([cmd, ...args], { terminal: { cols, rows, term } })` exposing a PTY handle, or a `Bun.Terminal` constructor. **Record which one it is.**
  2. Read output via the data callback / async stream — record the exact API (callback name vs `for await` over a readable) and whether chunks arrive as `string` or `Uint8Array` (the wrapper must hand the gateway a **string**).
  3. Write bytes to the PTY — record the write method (`.write(...)`).
  4. Resize 80×24 → 120×40 — record the resize method (`.resize(cols, rows)`).
  5. Observe exit — record how exit is signalled (`proc.exited` promise vs an `onExit`/close event).
  6. `.kill()` cleanly and exit the process.

  Run it under the pinned Bun:
  ```bash
  bun server/src/terminal/_pty_spike.ts
  ```
  Iterate until every one of the six surface points above is confirmed against real output.

- [ ] **Capture the findings.** Append a `## Bun.Terminal API notes` block to this plan's **Execution notes** section (bottom of this file) recording, verbatim, the confirmed:
  - spawn form and options object shape,
  - output-read mechanism + chunk type,
  - write / resize / exit / kill method names.

- [ ] **Delete the spike** (it must not be committed):
  ```bash
  rm server/src/terminal/_pty_spike.ts
  ```

- [ ] **Commit — only the captured notes** (docs-only; `bun run typecheck` is unaffected and stays green):
  ```bash
  git add docs/superpowers/plans/2026-07-05-bun-runtime-migration.md
  git commit -m "$(cat <<'EOF'
  docs(plan): record Bun.Terminal API surface from the 1.3.14 spike

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```
  (If for some reason no notes were captured, do not commit — the spike is throwaway.)

---

## Task 4 — PTY wrapper + terminal-gateway swap + drop node-pty

**Goal:** Replace the node-pty native addon (which Bun cannot load) with a small server-local wrapper backed by Bun's PTY, presenting the exact surface `terminal-gateway.ts` already consumes so the gateway body changes minimally. `relay-loopback.test.ts` is the behavioural guard and must pass under Bun.

**Files:** `server/src/terminal/pty.ts` (new), `server/src/terminal-gateway.ts` (import + field type + spawn call), `server/src/relay-loopback.test.ts` (child spawn), `server/package.json` (drop node-pty).

**Steps:**

- [ ] **Create the wrapper** `server/src/terminal/pty.ts`, reconciling the Bun-touching lines with the Task 3 `Bun.Terminal API notes`:
  ```ts
  /**
   * Server-local PTY wrapper presenting the exact node-pty surface the terminal
   * gateway consumes (spawn/onData/onExit/resize/write/kill), backed by Bun's
   * built-in PTY. node-pty is a native Node addon Bun cannot load — this is the
   * minimal in-place replacement. Sub-project 2 extracts this into
   * contracts/src/session-manager.ts shared with the CLI connector; for now it
   * lives in the server so this slice stays self-contained.
   *
   * Bun PTY API pinned against Bun >= 1.3.14 in the Task 3 spike — see the
   * "Bun.Terminal API notes" in the plan's Execution notes. The three lines that
   * touch Bun's API are marked below; keep them matching the spike findings.
   */
  export interface PtyOptions {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }

  export interface Pty {
    onData(cb: (data: string) => void): void
    onExit(cb: () => void): void
    resize(cols: number, rows: number): void
    write(data: string): void
    kill(): void
  }

  export function spawnPty(file: string, args: string[], opts: PtyOptions): Pty {
    // (A) spawn form — per Task 3 notes (Bun.spawn with a terminal descriptor).
    const proc = Bun.spawn([file, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: { cols: opts.cols, rows: opts.rows, term: opts.name },
    })
    const term = proc.terminal! // (B) the PTY handle from the spawned process.

    const decoder = new TextDecoder()
    let dataCb: ((data: string) => void) | null = null
    let exitCb: (() => void) | null = null

    // (C) output pump — per Task 3 notes: read the PTY as a byte stream and hand
    // the gateway UTF-8 strings (the gateway wraps them back into Buffers).
    ;(async () => {
      for await (const chunk of term.readable) {
        if (dataCb) dataCb(decoder.decode(chunk as Uint8Array, { stream: true }))
      }
    })()

    proc.exited.then(() => {
      if (exitCb) exitCb()
    })

    return {
      onData(cb) {
        dataCb = cb
      },
      onExit(cb) {
        exitCb = cb
      },
      resize(cols, rows) {
        term.resize(cols, rows)
      },
      write(data) {
        term.write(data)
      },
      kill() {
        proc.kill()
      },
    }
  }
  ```
  If the Task 3 notes named different members for `(A)`/`(B)`/`(C)`, adjust only those lines to the confirmed API — the exported `Pty` / `PtyOptions` / `spawnPty` shape stays exactly as above (it is what the gateway depends on). No `any` loosening.

- [ ] **Rewire `server/src/terminal-gateway.ts`.** Line 29, before:
  ```ts
  import pty, { type IPty } from 'node-pty'
  ```
  After:
  ```ts
  import { spawnPty, type Pty } from './terminal/pty.ts'
  ```
  The `TermSession.pty` field, line 121, before:
  ```ts
  	pty: IPty
  ```
  After:
  ```ts
  	pty: Pty
  ```
  The spawn call in `getOrCreateSession`, lines 140–146, before:
  ```ts
  	const proc = pty.spawn(spec.file, spec.args, {
  		name: 'xterm-256color',
  		cols,
  		rows,
  		cwd: spec.cwd,
  		env: spec.env,
  	})
  ```
  After:
  ```ts
  	const proc = spawnPty(spec.file, spec.args, {
  		name: 'xterm-256color',
  		cols,
  		rows,
  		cwd: spec.cwd,
  		env: spec.env,
  	})
  ```
  The `proc.onData(...)` (158), `proc.onExit(...)` (170), `session.pty.resize(...)` (194) and `session.pty.write(...)` (326) call sites are **unchanged** — the wrapper matches their surface. tmux naming (`canvas-<id>`), the privilege-drop launcher, and scrollback fan-out are all untouched.

- [ ] **Point the gateway's behavioural guard at Bun.** In `server/src/relay-loopback.test.ts`, the child-process spawn at line 108, before:
  ```ts
  			termGw = spawn('npx', ['tsx', 'src/terminal-gateway.ts'], {
  ```
  After:
  ```ts
  			termGw = spawn('bun', ['src/terminal-gateway.ts'], {
  ```

- [ ] **Drop node-pty from `server/package.json`.** Remove this dependency line:
  ```json
  		"node-pty": "^1.1.0",
  ```
  Then:
  ```bash
  bun install
  ```
  Expected: `bun.lock` updates; node-pty no longer resolved.

- [ ] **Verify — gateway boots and the relay round-trip passes under Bun** (precondition: `tmux` on PATH):
  ```bash
  PORT=18999 bun server/src/terminal-gateway.ts &
  sleep 1
  curl -sf http://localhost:18999/term/health && echo " TERM-OK"
  kill %1
  cd server && bun src/relay-loopback.test.ts; cd ..
  ```
  Expected: ` TERM-OK`, then the relay test ending with:
  ```
  relay-loopback.test.ts: all assertions passed
  ```
  Also:
  ```bash
  bun run typecheck    # green
  ```

- [ ] **Commit:**
  ```bash
  git add server/src/terminal/pty.ts server/src/terminal-gateway.ts server/src/relay-loopback.test.ts server/package.json bun.lock
  git commit -m "$(cat <<'EOF'
  feat(server): node-pty -> Bun.Terminal wrapper; drop node-pty dep

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — Per-workspace scripts → node-independent

**Goal:** Rewrite each workspace's scripts so nothing depends on Node: `tsx`→`bun`, `tsc`→`bunx tsc`, `vite`→`bun --bun vite`. Remove `tsx` from every workspace's deps (Bun runs `.ts` natively). This is the step that makes the tree runnable with no Node, which Task 7 then relies on.

**Files:** `server/package.json`, `client/package.json`, `transcriber/package.json`, `contracts/package.json`.

**Steps:**

- [ ] **`server/package.json`** — scripts, before:
  ```json
    "scripts": {
      "dev": "CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=500 tsx watch src/sync-server.ts",
      "dev:term": "CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=500 tsx watch src/terminal-gateway.ts",
      "start": "tsx src/sync-server.ts",
      "start:term": "tsx src/terminal-gateway.ts",
      "build": "tsc --noEmit",
      "typecheck": "tsc --noEmit"
    },
  ```
  After (the `CHOKIDAR_*` env vars were tsx/chokidar-specific — dropped; `bun --watch` uses its own watcher):
  ```json
    "scripts": {
      "dev": "bun --watch src/sync-server.ts",
      "dev:term": "bun --watch src/terminal-gateway.ts",
      "start": "bun src/sync-server.ts",
      "start:term": "bun src/terminal-gateway.ts",
      "build": "bunx tsc --noEmit",
      "typecheck": "bunx tsc --noEmit"
    },
  ```
  And remove `tsx` from `dependencies` (node-pty was already removed in Task 4). Before:
  ```json
      "livekit-server-sdk": "^2.15.4",
      "tsx": "^4.19.0",
      "ws": "^8.18.0"
  ```
  After:
  ```json
      "livekit-server-sdk": "^2.15.4",
      "ws": "^8.18.0"
  ```

- [ ] **`client/package.json`** — scripts, before:
  ```json
    "scripts": {
      "dev": "vite",
      "build": "tsc --noEmit && vite build",
      "typecheck": "tsc --noEmit",
      "preview": "vite preview"
    },
  ```
  After:
  ```json
    "scripts": {
      "dev": "bun --bun vite",
      "build": "bunx tsc --noEmit && bun --bun vite build",
      "typecheck": "bunx tsc --noEmit",
      "preview": "bun --bun vite preview"
    },
  ```
  (client has no `tsx` dependency — nothing to remove.)

- [ ] **`transcriber/package.json`** — scripts, before:
  ```json
    "scripts": {
      "dev": "tsx watch src/transcriber.ts",
      "start": "tsx src/transcriber.ts",
      "build": "tsc --noEmit",
      "typecheck": "tsc --noEmit"
    },
  ```
  After:
  ```json
    "scripts": {
      "dev": "bun --watch src/transcriber.ts",
      "start": "bun src/transcriber.ts",
      "build": "bunx tsc --noEmit",
      "typecheck": "bunx tsc --noEmit"
    },
  ```
  And remove `tsx` from `dependencies`. Before:
  ```json
    "dependencies": {
      "@livekit/rtc-node": "^0.13.29",
      "tsx": "^4.19.0"
    },
  ```
  After:
  ```json
    "dependencies": {
      "@livekit/rtc-node": "^0.13.29"
    },
  ```

- [ ] **`contracts/package.json`** — scripts, before:
  ```json
    "scripts": {
      "typecheck": "tsc --noEmit"
    },
  ```
  After:
  ```json
    "scripts": {
      "typecheck": "bunx tsc --noEmit"
    },
  ```
  (contracts has no `tsx` dependency.)

- [ ] **Reinstall and verify (config-only task):**
  ```bash
  bun install
  bun run typecheck    # green — every workspace now typechecks via bunx tsc
  bun run build        # green — client (Vite under Bun), server, transcriber build
  ```
  Expected: both exit 0. **Note risk R1** (does `bun --watch` fire hot-reload over the devcontainer bind mount?) — it cannot be verified from `build`/`typecheck`; it is checked when the stack runs in Task 9.

- [ ] **Commit:**
  ```bash
  git add server/package.json client/package.json transcriber/package.json contracts/package.json bun.lock
  git commit -m "$(cat <<'EOF'
  build(bun): workspace scripts node-independent (bun/--bun vite/bunx tsc), drop tsx

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — Single test runner + header sweep

**Goal:** One `bun run test` entrypoint that discovers and runs every `**/src/**/*.test.ts` under Bun, failing on the first non-zero exit; the 31 `Run: … npx tsx …` headers updated to `bun`; and `contracts/src/user-id.test.ts` (the one `node:test`-style suite) converted to the plain self-running style the other suites use so `bun <file>` runs it uniformly.

**Files:** `scripts/run-tests.ts` (new), `package.json` (root `test` script), the 31 test-header comments, `contracts/src/user-id.test.ts` (convert).

**Steps:**

- [ ] **Create the runner** `scripts/run-tests.ts`:
  ```ts
  // Run: bun scripts/run-tests.ts
  // Discovers every **/src/**/*.test.ts (excluding node_modules) and runs each
  // under bun, failing on the first non-zero exit. One command for humans and for
  // the CI smoke job sub-project 7 will add.
  import { Glob } from 'bun'

  const glob = new Glob('**/src/**/*.test.ts')
  const files: string[] = []
  for await (const f of glob.scan({ cwd: '.', onlyFiles: true })) {
    if (f.includes('node_modules')) continue
    files.push(f)
  }
  files.sort()

  for (const file of files) {
    console.log(`\n=== ${file} ===`)
    const proc = Bun.spawnSync(['bun', file], { stdout: 'inherit', stderr: 'inherit' })
    if (proc.exitCode !== 0) {
      console.error(`\nFAIL: ${file} (exit ${proc.exitCode})`)
      process.exit(1)
    }
  }
  console.log(`\nall ${files.length} suites passed`)
  ```

- [ ] **Add the root `test` script.** In `package.json`, the `scripts` block becomes (adding `test` to the Task-1 form):
  ```json
    "scripts": {
      "dev": "bun run --filter '@ensembleworks/server' dev & bun run --filter '@ensembleworks/server' dev:term & bun run --filter '@ensembleworks/client' dev & wait",
      "build": "bun run --filter '@ensembleworks/client' build && bun run --filter '@ensembleworks/server' build && bun run --filter '@ensembleworks/transcriber' build",
      "typecheck": "bun run --filter '@ensembleworks/contracts' typecheck && bun run --filter '@ensembleworks/client' typecheck && bun run --filter '@ensembleworks/server' typecheck && bun run --filter '@ensembleworks/transcriber' typecheck && bunx tsc -p bin/tsconfig.json",
      "test": "bun scripts/run-tests.ts"
    }
  ```

- [ ] **Convert `contracts/src/user-id.test.ts`** from `node:test` style. First check whether Bun runs it as-is:
  ```bash
  bun contracts/src/user-id.test.ts
  ```
  Regardless of the result, convert it to the uniform plain-`assert` self-running style (removes risk R2 and keeps the whole suite runnable by `bun <file>`). Before:
  ```ts
  /**
   * Run: npx tsx --test contracts/src/user-id.test.ts   (from the repo root)
   */
  import assert from 'node:assert/strict'
  import { test } from 'node:test'
  import { rawUserId } from './user-id.js'

  test('strips the tldraw presence prefix', () => {
  	assert.equal(rawUserId('user:abc123'), 'abc123')
  })

  test('raw ids pass through', () => {
  	assert.equal(rawUserId('abc123'), 'abc123')
  })

  test('only the leading prefix is stripped', () => {
  	assert.equal(rawUserId('user:user:x'), 'user:x')
  	assert.equal(rawUserId('xuser:y'), 'xuser:y')
  })

  test('null and undefined normalise to the empty string', () => {
  	assert.equal(rawUserId(null), '')
  	assert.equal(rawUserId(undefined), '')
  })
  ```
  After (keep the `./user-id.js` specifier — contracts' tsconfig is plain `nodenext` without `allowImportingTsExtensions`; Bun resolves the `.js` import to the sibling `.ts` at runtime, matching `slug.test.ts`/`stamp.test.ts`):
  ```ts
  /**
   * Run: bun contracts/src/user-id.test.ts   (from the repo root)
   */
  import assert from 'node:assert/strict'
  import { rawUserId } from './user-id.js'

  // strips the tldraw presence prefix
  assert.equal(rawUserId('user:abc123'), 'abc123')
  // raw ids pass through
  assert.equal(rawUserId('abc123'), 'abc123')
  // only the leading prefix is stripped
  assert.equal(rawUserId('user:user:x'), 'user:x')
  assert.equal(rawUserId('xuser:y'), 'xuser:y')
  // null and undefined normalise to the empty string
  assert.equal(rawUserId(null), '')
  assert.equal(rawUserId(undefined), '')

  console.log('ok: user-id rawUserId')
  ```

- [ ] **Sweep the remaining 30 headers** from `npx tsx …` to `bun …`. Every `*.test.ts` (both `Run:` and `Run with:` phrasings) drops `npx tsx` for `bun`. Apply mechanically, then confirm nothing remains:
  ```bash
  grep -rl 'npx tsx' --include='*.test.ts' . | grep -v node_modules \
    | xargs sed -i 's#npx tsx --test #bun #g; s#npx tsx #bun #g'
  grep -rn 'npx tsx' --include='*.test.ts' . | grep -v node_modules || echo "no npx tsx headers remain"
  ```
  This rewrites the header lines in these files (the `sqlite.test.ts` header from Task 2 is already `bun`; the `neko.test.ts` in-body comment "so `npx tsx` runs terminate" becomes "so `bun` runs terminate", still accurate):
  ```
  bin/dev.test.ts                            (Run with: bun bin/dev.test.ts — repurposed further in Task 7)
  client/src/av/spatial.test.ts
  client/src/colors.test.ts
  client/src/kernel/plugin.test.ts
  client/src/kernel/roomHooks.test.ts
  client/src/kernel/scheduler.test.ts
  client/src/neko/neko.test.ts
  client/src/roadmap/model.test.ts
  client/src/screenshare/resolve.test.ts
  client/src/screenshare/screenshare.test.ts
  client/src/screenshare/visibility.test.ts
  client/src/session/layout.test.ts
  client/src/terminal/grid.test.ts
  client/src/terminal/wsUrl.test.ts
  contracts/src/slug.test.ts
  contracts/src/stamp.test.ts
  server/src/canvas-api.test.ts
  server/src/gateway-plane.test.ts
  server/src/gateway-registry.test.ts
  server/src/livekit-url.test.ts
  server/src/participants-api.test.ts
  server/src/relay-loopback.test.ts
  server/src/roadmap-api.test.ts
  server/src/roadmap-store.test.ts
  server/src/scribe-api.test.ts
  server/src/uploads-api.test.ts
  server/src/vm-stats.test.ts
  transcriber/src/livekit-url.test.ts
  transcriber/src/segmenter.test.ts
  transcriber/src/wav.test.ts
  ```
  (`bin/dev.test.ts` is under `bin/`, not `src/`, so the runner does not pick it up — it is exercised directly in Tasks 7 and 9; its header is swept here for consistency.)

- [ ] **Verify — every `src` suite runs green under Bun:**
  ```bash
  bun run test
  ```
  Expected: each `=== <file> ===` block runs and the run ends with `all 31 suites passed` (the 30 pre-existing `src` suites plus the new `server/src/kernel/sqlite.test.ts`). `relay-loopback.test.ts` needs `tmux` on PATH. Then:
  ```bash
  bun run typecheck    # green
  ```

- [ ] **Commit:**
  ```bash
  git add scripts/run-tests.ts package.json contracts/src/user-id.test.ts $(grep -rl 'Run' --include='*.test.ts' . | grep -v node_modules)
  git commit -m "$(cat <<'EOF'
  test(bun): single bun run test entrypoint; headers npx tsx -> bun; convert user-id suite

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 7 — Node-pin removal: dev side

**Goal:** Move `bin/dev` and the devcontainer fully onto Bun, then delete `.nvmrc`. `bin/dev` runs under Bun, enforces a Bun floor (from `.tool-versions`), and forwards its service commands via `bun run --filter`; the doctor checks Bun and drops the node-pty probe; the Dockerfile installs pinned Bun instead of Node.

**Files:** `bin/dev`, `bin/dev-main.mjs`, `bin/dev-lib.mjs`, `bin/dev-doctor.mjs`, `bin/dev.test.ts`, `.devcontainer/Dockerfile`, `.nvmrc` (delete).

**Steps:**

- [ ] **`bin/dev` shebang.** Line 1, before:
  ```
  #!/usr/bin/env node
  ```
  After (Bun runs the CJS shim — the repo root has no `"type": "module"`, so this extensionless file still loads as CommonJS; `require`/`__dirname` work under Bun):
  ```
  #!/usr/bin/env bun
  ```

- [ ] **`bin/dev-lib.mjs` — replace `parseNvmrc` with a `.tool-versions` parser + a floor compare.** Before (lines 146–149):
  ```js
  /** @param {string} text  .nvmrc content, e.g. "22.22.3\n" or "v22.22.3" */
  export function parseNvmrc(text) {
  	return text.trim().replace(/^v/, '')
  }
  ```
  After:
  ```js
  /**
   * Read a tool's pinned version from `.tool-versions` (asdf/mise format:
   * `<tool> <version>` per line; `#` comments and blanks skipped). Returns the
   * version string, or '' if the tool is absent.
   * @param {string} text  .tool-versions content
   * @param {string} tool  e.g. 'bun'
   * @returns {string}
   */
  export function parseToolVersions(text, tool) {
  	for (const line of text.split('\n')) {
  		const m = /^\s*([^\s#]+)\s+([^\s#]+)/.exec(line)
  		if (m && m[1] === tool) return m[2].replace(/^v/, '')
  	}
  	return ''
  }

  /**
   * Floor compare for the Bun version check: true iff `have` >= `want`, comparing
   * dot-separated numeric parts (missing parts treated as 0).
   * @param {string} have
   * @param {string} want
   * @returns {boolean}
   */
  export function atLeast(have, want) {
  	const h = have.split('.').map(Number)
  	const w = want.split('.').map(Number)
  	for (let i = 0; i < Math.max(h.length, w.length); i++) {
  		const a = h[i] ?? 0
  		const b = w[i] ?? 0
  		if (a > b) return true
  		if (a < b) return false
  	}
  	return true
  }
  ```

- [ ] **`bin/dev-lib.mjs` — forward service commands via Bun.** The four `npm run … --workspace=…` service commands in `buildServices` become `bun run --filter …` (npm is gone once the Dockerfile drops Node). Line 236, before → after:
  ```js
  		cmd: `${syncEnv.join(' ')} npm run dev --workspace=server`,
  ```
  ```js
  		cmd: `${syncEnv.join(' ')} bun run --filter '@ensembleworks/server' dev`,
  ```
  Line 244:
  ```js
  		cmd: 'npm run dev:term --workspace=server',
  ```
  ```js
  		cmd: "bun run --filter '@ensembleworks/server' dev:term",
  ```
  Line 252:
  ```js
  		cmd: `${publicOriginStr ? `ENSEMBLEWORKS_PUBLIC_ORIGIN='${publicOriginStr}' ` : ''}npm run dev --workspace=client`,
  ```
  ```js
  		cmd: `${publicOriginStr ? `ENSEMBLEWORKS_PUBLIC_ORIGIN='${publicOriginStr}' ` : ''}bun run --filter '@ensembleworks/client' dev`,
  ```
  Line 338 (only the trailing command changes; the wait-gate is untouched):
  ```js
  		cmd: `${scribeExports.join('; ')}; until curl -fsS http://localhost:${PORTS.sync}/api/health >/dev/null 2>&1 && timeout 1 bash -c '</dev/tcp/localhost/${PORTS.livekit}' 2>/dev/null; do sleep 2; done; npm run dev --workspace=transcriber`,
  ```
  ```js
  		cmd: `${scribeExports.join('; ')}; until curl -fsS http://localhost:${PORTS.sync}/api/health >/dev/null 2>&1 && timeout 1 bash -c '</dev/tcp/localhost/${PORTS.livekit}' 2>/dev/null; do sleep 2; done; bun run --filter '@ensembleworks/transcriber' dev`,
  ```

- [ ] **`bin/dev-main.mjs` — imports.** Lines 20–29, before:
  ```js
  import {
  	PORTS,
  	buildServices,
  	hold,
  	originToString,
  	parseDotEnv,
  	parseNvmrc,
  	parsePublicOrigin,
  	resolveMode,
  } from './dev-lib.mjs'
  ```
  After:
  ```js
  import {
  	PORTS,
  	atLeast,
  	buildServices,
  	hold,
  	originToString,
  	parseDotEnv,
  	parseToolVersions,
  	parsePublicOrigin,
  	resolveMode,
  } from './dev-lib.mjs'
  ```

- [ ] **`bin/dev-main.mjs` — the version gate.** Replace the Node enforce/mise-re-exec block (lines 64–82). Before:
  ```js
  // ---- Node version: enforce, don't provide -----------------------------------
  // The pin exists for node-pty's prebuilt ABI. If mise is on PATH, re-exec
  // through it once (same trick the retired host launcher used); otherwise fail
  // with the exact remedy. .nvmrc is the single source of truth.
  export const wantedNode = parseNvmrc(readFileSync(path.join(repoDir, '.nvmrc'), 'utf8'))
  if (process.version !== `v${wantedNode}`) {
  	if (onPath('mise') && !process.env.ENSEMBLEWORKS_DEV_REEXEC) {
  		const r = spawnSync(
  			'mise',
  			['exec', `node@${wantedNode}`, '--', 'node', ...process.argv.slice(1)],
  			{ stdio: 'inherit', env: { ...process.env, ENSEMBLEWORKS_DEV_REEXEC: '1' } },
  		)
  		process.exit(r.status ?? 1)
  	}
  	die(
  		`running node ${process.version}, but .nvmrc pins v${wantedNode} (node-pty ABI).\n` +
  			`  fix: install it — e.g. \`mise use -g node@${wantedNode}\` or \`nvm install ${wantedNode}\` — and re-run.`,
  	)
  }
  ```
  After:
  ```js
  // ---- Bun version: enforce the floor, re-exec through mise if it can ----------
  // bin/dev runs under Bun (shebang). The floor exists because Bun.Terminal + the
  // build need >= 1.3.14 while the default mise bun was 1.3.4 during the
  // migration. .tool-versions is the single source of truth. If a too-old bun is
  // running and mise is on PATH, re-exec once through the pinned bun; else fail
  // with the exact remedy.
  export const wantedBun = parseToolVersions(readFileSync(path.join(repoDir, '.tool-versions'), 'utf8'), 'bun')
  const runningBun = process.versions.bun
  if (!runningBun) {
  	die(
  		`bin/dev must run under Bun, but it is running under Node ${process.version}.\n` +
  			`  fix: install Bun >= ${wantedBun} (\`mise use -g bun@${wantedBun}\` or https://bun.sh) and re-run.`,
  	)
  }
  if (!atLeast(runningBun, wantedBun)) {
  	if (onPath('mise') && !process.env.ENSEMBLEWORKS_DEV_REEXEC) {
  		const r = spawnSync(
  			'mise',
  			['exec', `bun@${wantedBun}`, '--', 'bun', ...process.argv.slice(1)],
  			{ stdio: 'inherit', env: { ...process.env, ENSEMBLEWORKS_DEV_REEXEC: '1' } },
  		)
  		process.exit(r.status ?? 1)
  	}
  	die(
  		`running bun ${runningBun}, but .tool-versions pins bun ${wantedBun} (Bun.Terminal + build floor).\n` +
  			`  fix: install it — e.g. \`mise use -g bun@${wantedBun}\` — and re-run.`,
  	)
  }
  ```

- [ ] **`bin/dev-main.mjs` — the install step in `up()`.** Lines 211–214, before:
  ```js
  		if (!flags.noInstall) {
  			console.log('==> npm ci (skip with --no-install)')
  			execFileSync('npm', ['ci'], { cwd: repoDir, stdio: 'inherit' })
  		}
  ```
  After:
  ```js
  		if (!flags.noInstall) {
  			console.log('==> bun install (skip with --no-install)')
  			execFileSync('bun', ['install'], { cwd: repoDir, stdio: 'inherit' })
  		}
  ```
  (The `--no-install` usage line in `usage()` still reads "bun install on fresh start" conceptually; update its inline text — line 338, before → after:)
  ```js
    bin/dev up [--attach] [--no-install]   start everything (idempotent; npm ci on fresh start)
  ```
  ```js
    bin/dev up [--attach] [--no-install]   start everything (idempotent; bun install on fresh start)
  ```

- [ ] **`bin/dev-doctor.mjs` — import.** Lines 10–18, before:
  ```js
  import {
  	devEnvPath,
  	makeCtx,
  	onPath,
  	probePort,
  	repoDir,
  	sessionRunning,
  	wantedNode,
  } from './dev-main.mjs'
  ```
  After:
  ```js
  import { atLeast } from './dev-lib.mjs'
  import {
  	devEnvPath,
  	makeCtx,
  	onPath,
  	probePort,
  	repoDir,
  	sessionRunning,
  	wantedBun,
  } from './dev-main.mjs'
  ```

- [ ] **`bin/dev-doctor.mjs` — the node check becomes a bun check.** Lines 31–39, before:
  ```js
  	// Node: if we're executing, the version gate in dev-main already passed
  	// (or re-exec'd via mise) — report it for completeness.
  	checks.push({
  		name: 'node',
  		level: 'required',
  		ok: process.version === `v${wantedNode}`,
  		detail: `${process.version} (want v${wantedNode} from .nvmrc — node-pty ABI pin)`,
  		remedy: `install Node ${wantedNode}: \`mise use -g node@${wantedNode}\` or \`nvm install ${wantedNode}\``,
  	})
  ```
  After:
  ```js
  	// Bun: if we're executing, the floor gate in dev-main already passed (or
  	// re-exec'd via mise) — report it for completeness.
  	const runningBun = process.versions.bun
  	checks.push({
  		name: 'bun',
  		level: 'required',
  		ok: runningBun !== undefined && atLeast(runningBun, wantedBun),
  		detail: runningBun
  			? `bun ${runningBun} (want >= ${wantedBun} from .tool-versions)`
  			: `not running under Bun (${process.version})`,
  		remedy: `install Bun >= ${wantedBun}: \`mise use -g bun@${wantedBun}\` or https://bun.sh`,
  	})
  ```

- [ ] **`bin/dev-doctor.mjs` — delete the node-pty probe entirely** (Bun.Terminal is built in — nothing to check). Remove lines 51–65:
  ```js
  	const nm = existsSync(`${repoDir}/node_modules`)
  	const pty = nm
  		? spawnSync('node', ['-e', "require('node-pty')"], { cwd: repoDir, stdio: 'ignore' }).status === 0
  		: false
  	checks.push({
  		name: 'node-pty',
  		level: 'required',
  		ok: pty,
  		detail: nm
  			? pty
  				? 'loads (ABI matches)'
  				: 'node_modules present but node-pty fails to load — Node/ABI mismatch at install time'
  			: 'node_modules missing',
  		remedy: nm ? 'reinstall with the pinned Node: `npm ci`' : 'run `npm ci` (or just `bin/dev up`)',
  	})
  ```
  (No replacement — the block is deleted. `spawnSync`/`existsSync` remain imported and used elsewhere in the file, so leave the imports.)

- [ ] **`bin/dev.test.ts` — swap the `parseNvmrc` test for `parseToolVersions` + `atLeast`.** Import list, before (lines 4–15):
  ```ts
  import {
  	PORTS,
  	attachInstructions,
  	buildServices,
  	forwardArgv,
  	hold,
  	parseDotEnv,
  	parseNvmrc,
  	parsePublicOrigin,
  	resolveMode,
  	workspaceDirFor,
  } from './dev-lib.mjs'
  ```
  After:
  ```ts
  import {
  	PORTS,
  	atLeast,
  	attachInstructions,
  	buildServices,
  	forwardArgv,
  	hold,
  	parseDotEnv,
  	parseToolVersions,
  	parsePublicOrigin,
  	resolveMode,
  	workspaceDirFor,
  } from './dev-lib.mjs'
  ```
  The `hold()` sample block, lines 41–48, before:
  ```ts
  {
  	const w = hold('npm run dev', 'client')
  	assert.ok(w.startsWith('trap ":" INT; '), 'SIGINT trap is first (load-bearing)')
  	assert.ok(w.includes('npm run dev'), 'command included')
  	assert.ok(w.includes('[client exited $code]'), 'label in the epilogue')
  	assert.ok(w.endsWith('exec bash'), 'drops to an interactive shell')
  	console.log('ok: hold() wrapper shape')
  }
  ```
  After:
  ```ts
  {
  	const w = hold('bun run dev', 'client')
  	assert.ok(w.startsWith('trap ":" INT; '), 'SIGINT trap is first (load-bearing)')
  	assert.ok(w.includes('bun run dev'), 'command included')
  	assert.ok(w.includes('[client exited $code]'), 'label in the epilogue')
  	assert.ok(w.endsWith('exec bash'), 'drops to an interactive shell')
  	console.log('ok: hold() wrapper shape')
  }
  ```
  The `parseNvmrc` block, lines 50–55, before:
  ```ts
  // parseNvmrc tolerates v-prefix and whitespace.
  {
  	assert.equal(parseNvmrc('22.22.3\n'), '22.22.3')
  	assert.equal(parseNvmrc('v22.22.3'), '22.22.3')
  	console.log('ok: parseNvmrc')
  }
  ```
  After:
  ```ts
  // parseToolVersions reads a tool's pin from .tool-versions; atLeast does the floor compare.
  {
  	assert.equal(parseToolVersions('bun 1.3.14\n', 'bun'), '1.3.14')
  	assert.equal(parseToolVersions('# comment\nbun v1.3.14\n', 'bun'), '1.3.14', 'v-prefix + comments tolerated')
  	assert.equal(parseToolVersions('node 22\n', 'bun'), '', 'absent tool -> empty')
  	assert.equal(atLeast('1.3.14', '1.3.14'), true, 'equal satisfies the floor')
  	assert.equal(atLeast('1.3.20', '1.3.14'), true)
  	assert.equal(atLeast('1.3.4', '1.3.14'), false, 'the 1.3.4 default is below the floor')
  	console.log('ok: parseToolVersions + atLeast')
  }
  ```
  (The `buildServices` assertions elsewhere in this file check env-var prefixes and the scribe wait-gate, not the `npm run`/`bun run` command prefix, so the Task-7 `dev-lib.mjs` service-command change does not break them.)

- [ ] **`.devcontainer/Dockerfile` — add `unzip` to the base packages** (Bun's installer unpacks a zip). Lines 14–18, before:
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends \
  		build-essential ca-certificates cmake curl git gh less locales \
  		pkg-config procps python3 sudo tmux xz-utils \
  	&& rm -rf /var/lib/apt/lists/* \
  	&& sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
  ```
  After:
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends \
  		build-essential ca-certificates cmake curl git gh less locales \
  		pkg-config procps python3 sudo tmux unzip xz-utils \
  	&& rm -rf /var/lib/apt/lists/* \
  	&& sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
  ```

- [ ] **`.devcontainer/Dockerfile` — top comment.** Lines 4–7, before:
  ```dockerfile
  # baked in: Node (exact version from .nvmrc), tmux, Caddy, the LiveKit OSS
  # SFU (voice/video via --dev keys) and whisper.cpp + a small model (keyless
  # transcription). Version pins follow deploy/runtime-requirements — bump them
  # together. The shared browser (neko) is deliberately absent: it needs
  ```
  After:
  ```dockerfile
  # baked in: Bun (pinned in .tool-versions), tmux, Caddy, the LiveKit OSS
  # SFU (voice/video via --dev keys) and whisper.cpp + a small model (keyless
  # transcription). Version pins follow deploy/runtime-requirements — bump them
  # together. The shared browser (neko) is deliberately absent: it needs
  ```
  (The `NODE_OPTIONS=--dns-result-order=ipv4first` ENV and its comment on lines 20–22 stay as-is — Vite under Bun still binds 127.0.0.1 and `probePort` checks both loopback families, so it remains a harmless belt-and-suspenders.)

- [ ] **`.devcontainer/Dockerfile` — replace the Node install with pinned Bun.** Lines 28–36, before:
  ```dockerfile
  # Node — exact version read from .nvmrc (single source of truth; bin/dev and
  # the deploy preflight enforce the same pin at runtime).
  COPY .nvmrc /tmp/.nvmrc
  RUN set -eux; \
  	ver="$(tr -d 'v[:space:]' < /tmp/.nvmrc)"; \
  	case "$(dpkg --print-architecture)" in amd64) a=x64;; arm64) a=arm64;; *) echo "unsupported arch" >&2; exit 1;; esac; \
  	curl -fsSL "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${a}.tar.xz" \
  		| tar -xJ -C /usr/local --strip-components=1; \
  	node -v
  ```
  After (installed system-wide to `/usr/local` via `BUN_INSTALL`; the official installer is arch-aware; version pinned to match `.tool-versions`):
  ```dockerfile
  # Bun — pinned to match .tool-versions (single source of truth; bin/dev and the
  # deploy preflight enforce the same floor at runtime). Installed system-wide to
  # /usr/local/bin via the official installer (BUN_INSTALL sets the prefix).
  ARG BUN_VERSION=1.3.14
  ENV BUN_INSTALL=/usr/local
  RUN set -eux; \
  	curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"; \
  	bun --version
  ```

- [ ] **Delete `.nvmrc`** (every dev-side reader is now on Bun; deploy-side readers are Task 8):
  ```bash
  git rm .nvmrc
  ```

- [ ] **Verify (bin/dev tests + bin typecheck):**
  ```bash
  bun bin/dev.test.ts
  bunx tsc -p bin/tsconfig.json
  bun run typecheck
  ```
  Expected: `bin/dev.test.ts` prints its `ok:` lines and ends `all dev-lib tests passed`; `bunx tsc -p bin/tsconfig.json` and `bun run typecheck` exit 0. (The devcontainer rebuild that proves no Node is required is the Task 9 gate.)

- [ ] **Commit:**
  ```bash
  git add bin/dev bin/dev-main.mjs bin/dev-lib.mjs bin/dev-doctor.mjs bin/dev.test.ts .devcontainer/Dockerfile
  git commit -m "$(cat <<'EOF'
  build(dev): bin/dev + devcontainer onto Bun; enforce bun floor; drop .nvmrc

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 8 — Node-pin removal: deploy side

**Goal:** Update every deploy-side reader of the deleted `.nvmrc` / Node pin so the scripts don't break, and move `release.sh`'s local build gate to Bun. **The fetch-verify-swap / artifact-based `deploy.sh` rewrite stays sub-project 7** — only the Node-pin references and that one build gate change here (`deploy/deploy.sh` is untouched).

**Files:** `deploy/release.sh`, `deploy/runtime-requirements`, `deploy/bootstrap-debian-ash.sh`, `deploy/test/lib_test.sh`.

**Steps:**

- [ ] **`deploy/release.sh` — the version preflight.** Lines 38–43, before:
  ```bash
  echo "==> preflight: node matches .nvmrc"
  wanted="v$(tr -d 'v[:space:]' <.nvmrc)"
  [ "$(node -v)" = "$wanted" ] || {
  	echo "node $(node -v) but .nvmrc pins $wanted (node-pty ABI) — install it and retry" >&2
  	exit 1
  }
  ```
  After (floor check against `.tool-versions`; `sort -V` gives "have >= floor"):
  ```bash
  echo "==> preflight: bun meets the .tool-versions floor"
  floor="$(awk '$1=="bun"{print $2}' .tool-versions)"
  have="$(bun --version)"
  [ "$(printf '%s\n%s\n' "$floor" "$have" | sort -V | head -1)" = "$floor" ] || {
  	echo "bun $have but .tool-versions floor is $floor — install it and retry" >&2
  	exit 1
  }
  ```

- [ ] **`deploy/release.sh` — the isolated build gate.** The comment (lines 45–50) and the gate (line 60). Before:
  ```bash
  # Validate in a throwaway worktree: `npm ci` DELETES node_modules, which used
  # to yank node-pty out from under the running dev services (tsx watch, vite,
  # the terminal gateway) when releasing from a live checkout. The worktree gets
  # its own fresh node_modules and is removed afterwards; the live tree is never
  # touched. The bump/tag below still happens here — a one-file commit that
  # watchers shrug at.
  echo "==> validating build before tagging (isolated worktree)"
  ```
  After:
  ```bash
  # Validate in a throwaway worktree: `bun install` rewrites node_modules, which
  # used to yank deps out from under the running dev services (the watchers, vite,
  # the terminal gateway) when releasing from a live checkout. The worktree gets
  # its own fresh node_modules and is removed afterwards; the live tree is never
  # touched. The bump/tag below still happens here — a one-file commit that
  # watchers shrug at. (The fetch-verify-swap artifact deploy is sub-project 7;
  # this gate only proves the tag builds under Bun.)
  echo "==> validating build before tagging (isolated worktree)"
  ```
  And line 60, before:
  ```bash
  (cd "$worktree" && npm ci && npm run typecheck && npm run build)
  ```
  After:
  ```bash
  (cd "$worktree" && bun install && bun run typecheck && bun run build)
  ```

- [ ] **`deploy/runtime-requirements` — replace the `node`/`npm` rows with a `bun` row.** Before (lines 7 and 11):
  ```
  node            exact    22.22.3    node -v
  livekit-server  exact    1.13.1     livekit-server --version
  caddy           min      2.7.0      caddy version
  cloudflared     min      2024.1.0   cloudflared --version
  npm             min      10.0.0     npm -v
  git             min      2.39.0     git --version
  ```
  After (one `bun` minimum row replaces both the `node exact` and `npm min` rows; `bun --version` prints a bare `MAJOR.MINOR.PATCH` that `extract_version` parses):
  ```
  bun             min      1.3.14     bun --version
  livekit-server  exact    1.13.1     livekit-server --version
  caddy           min      2.7.0      caddy version
  cloudflared     min      2024.1.0   cloudflared --version
  git             min      2.39.0     git --version
  ```
  (The `python3`, `cc`, and `pkg-config` rows below are left in place — out of scope here.)

- [ ] **`deploy/bootstrap-debian-ash.sh` — the Node vars.** Lines 66–68, before:
  ```bash
  # Node pinned to the devcontainer's version + amd64 checksum (Hetzner CPX/CCX are x86_64).
  NODE_VERSION="${NODE_VERSION:-22.22.3}"
  NODE_SHA256="${NODE_SHA256:-2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f}"
  ```
  After:
  ```bash
  # Bun pinned to match the devcontainer / .tool-versions (Hetzner CPX/CCX are x86_64).
  BUN_VERSION="${BUN_VERSION:-1.3.14}"
  ```

- [ ] **`deploy/bootstrap-debian-ash.sh` — the runtime bin path.** Line 75, before:
  ```bash
  NPM_BIN="/usr/local/bin/npm"
  ```
  After:
  ```bash
  BUN_BIN="/usr/local/bin/bun"
  ```

- [ ] **`deploy/bootstrap-debian-ash.sh` — base packages: drop node-pty's build deps.** The comment (lines 84–87) and the apt line (91–93). node-pty is gone, so `python3` and `pkg-config` (present solely for its native addon) are dropped; `build-essential` is kept (general toolchain, and the note is a standing caution that whisper.cpp builds need it). Before:
  ```bash
  # 1. Base packages (build-essential + python3 + pkg-config for node-pty's native
  #    addon; tmux backs the gateway terminals; sudo lets the mob redeploy).
  # -----------------------------------------------------------------------------
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
  	ca-certificates curl git build-essential python3 pkg-config tmux jq sudo \
  	gnupg debian-keyring debian-archive-keyring apt-transport-https
  ```
  After (add `unzip` for Bun's installer; drop `python3`/`pkg-config`; keep `build-essential`):
  ```bash
  # 1. Base packages (build-essential kept as a general toolchain; unzip for the
  #    Bun installer; tmux backs the gateway terminals; sudo lets the mob
  #    redeploy). node-pty is gone, so python3 + pkg-config are no longer needed.
  # -----------------------------------------------------------------------------
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
  	ca-certificates curl git build-essential unzip tmux jq sudo \
  	gnupg debian-keyring debian-archive-keyring apt-transport-https
  ```

- [ ] **`deploy/bootstrap-debian-ash.sh` — replace the Node install block with Bun.** Lines 96–109, before:
  ```bash
  # -----------------------------------------------------------------------------
  # 2. Node 22 — pinned tarball into /usr/local, checksum-verified (matches the
  #    devcontainer Dockerfile so host == dev).
  # -----------------------------------------------------------------------------
  if [[ "$(node -v 2>/dev/null || true)" != "v${NODE_VERSION}" ]]; then
  	log "Installing Node ${NODE_VERSION}"
  	archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
  	curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"
  	echo "${NODE_SHA256}  /tmp/${archive}" | sha256sum -c -
  	tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1
  	rm -f "/tmp/${archive}"
  else
  	log "Node ${NODE_VERSION} already present — skipping"
  fi
  ```
  After (official installer, pinned, system-wide to `/usr/local/bin` via `BUN_INSTALL`; matches the devcontainer so host == dev):
  ```bash
  # -----------------------------------------------------------------------------
  # 2. Bun — pinned install into /usr/local/bin (matches the devcontainer
  #    Dockerfile / .tool-versions so host == dev). The only JS runtime.
  # -----------------------------------------------------------------------------
  if [[ "$(bun --version 2>/dev/null || true)" != "${BUN_VERSION}" ]]; then
  	log "Installing Bun ${BUN_VERSION}"
  	BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"
  else
  	log "Bun ${BUN_VERSION} already present — skipping"
  fi
  ```

- [ ] **`deploy/bootstrap-debian-ash.sh` — the build step.** Lines 207–228 hold the stop-then-build sequence; only the `npm ci`/`npm run build` invocation and its watcher comment change (the unit-stop loop and `env PATH` wrapper are untouched). The comment at 208–212, before:
  ```bash
  # Stop the running watch-mode app units BEFORE npm ci — npm ci wipes node_modules,
  # and tsx watch/Vite import from it live; a mid-reinstall import races with the
  # unlink storm and crashes (Cannot find module '.../tsx/dist/preflight.cjs').
  ```
  After:
  ```bash
  # Stop the running watch-mode app units BEFORE bun install — it rewrites
  # node_modules, and bun --watch/Vite import from it live; a mid-reinstall import
  # can race with the rewrite. Record which were running so we restart exactly those.
  ```
  The build invocation, lines 223–228, before:
  ```bash
  runuser -u "${APP_USER}" -- env PATH="/usr/local/bin:${PATH}" bash -c "
    set -euo pipefail
    cd '${APP_DIR}'
    npm ci
    npm run build
  "
  ```
  After:
  ```bash
  runuser -u "${APP_USER}" -- env PATH="/usr/local/bin:${PATH}" bash -c "
    set -euo pipefail
    cd '${APP_DIR}'
    bun install
    bun run build
  "
  ```

- [ ] **`deploy/bootstrap-debian-ash.sh` — systemd `ExecStart` + comments.** The four unit `ExecStart=${NPM_BIN} run …` lines now reference the renamed `BUN_BIN`, and `bun run <script>` is valid. Change each:
  - `ensembleworks-sync.service` (line 465): `ExecStart=${NPM_BIN} run dev` → `ExecStart=${BUN_BIN} run dev`
  - `ensembleworks-term.service` (line 485): `ExecStart=${NPM_BIN} run dev:term` → `ExecStart=${BUN_BIN} run dev:term`
  - `ensembleworks-client.service` (line 504): `ExecStart=${NPM_BIN} run dev` → `ExecStart=${BUN_BIN} run dev`
  - `ensembleworks-scribe.service` (line 533): `ExecStart=${NPM_BIN} run dev` → `ExecStart=${BUN_BIN} run dev`

  And the two `node-pty`/`tsx` mentions in comments:
  - The term unit `Description` (line 475): `EnsembleWorks terminal gateway (node-pty + tmux)` → `EnsembleWorks terminal gateway (Bun.Terminal + tmux)`
  - The dogfooding comment (line 447): `the watch/dev npm scripts (tsx watch + Vite HMR)` → `the watch/dev bun scripts (bun --watch + Vite HMR)`
  - The term.env comment (line 358): `the\n# ensembleworks-term gateway: node-pty + tmux)` → `the\n# ensembleworks-term gateway: Bun.Terminal + tmux)`
  - The closing help note (line 673): `$EDITOR server/src/...    # tsx watch / Vite HMR pick it up automatically` → `$EDITOR server/src/...    # bun --watch / Vite HMR pick it up automatically`

  (`deploy/deploy.sh` and the systemd unit *files* under `deploy/systemd/` are the artifact-deploy mechanism — sub-project 7 — and are not touched here.)

- [ ] **`deploy/test/lib_test.sh` — retarget the version fixtures to Bun values.** Line 23, before:
  ```bash
  eq "$(extract_version 'v22.22.3')" "22.22.3" "node -v"
  ```
  After:
  ```bash
  eq "$(extract_version '1.3.14')" "1.3.14" "bun --version"
  ```
  Lines 31 and 34 (`version_ge`), before:
  ```bash
  yes version_ge 22.22.3 22.22.3
  ```
  ```bash
  no version_ge 22.21.0 22.22.3
  ```
  After (also encodes the R6 gotcha — the 1.3.4 default is below the floor):
  ```bash
  yes version_ge 1.3.14 1.3.14
  ```
  ```bash
  no version_ge 1.3.4 1.3.14
  ```
  Lines 37–38 (`check_constraint`), before:
  ```bash
  yes check_constraint node exact 22.22.3 22.22.3
  no check_constraint node exact 22.22.3 22.21.0
  ```
  After:
  ```bash
  yes check_constraint bun min 1.3.14 1.3.14
  no check_constraint bun min 1.3.14 1.3.4
  ```

- [ ] **Verify (deploy unit tests + repo typecheck):**
  ```bash
  bash deploy/test/lib_test.sh
  bun run typecheck
  ```
  Expected: `lib_test.sh` prints its `ok  :` lines and ends `ALL PASS` (exit 0); `bun run typecheck` exits 0. Optionally dry-run the release gate:
  ```bash
  RELEASE_DRY_RUN=1 deploy/release.sh patch    # runs the bun preflight + isolated bun build gate
  ```
  Expected: `==> dry run: validation passed; skipping version bump + push`.

- [ ] **Commit:**
  ```bash
  git add deploy/release.sh deploy/runtime-requirements deploy/bootstrap-debian-ash.sh deploy/test/lib_test.sh
  git commit -m "$(cat <<'EOF'
  build(deploy): drop Node pin references; release build gate + bootstrap onto Bun

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 9 — Docs + full behaviour-neutral verification

**Goal:** Update the contributor docs to Bun, then run the whole verification gate proving no Node is required and nothing observable changed. Document the R1 (bun `--watch` over the bind mount) result.

**Files:** `CLAUDE.md`, `README.md`, plus this plan's Execution notes for the final result.

**Steps:**

- [ ] **`CLAUDE.md` — npm → bun.** Line 33, before:
  ```
  `~/.config/ensembleworks/dev.env`. Verify changes with `npm run typecheck`
  ```
  After:
  ```
  `~/.config/ensembleworks/dev.env`. Verify changes with `bun run typecheck`
  ```
  Line 47, before:
  ```
  `npm ci && npm run typecheck && npm run build`, then `npm version <bump> -m "release: %s"`
  ```
  After:
  ```
  `bun install && bun run typecheck && bun run build`, then `npm version <bump> -m "release: %s"`
  ```
  (`npm version` is the version-bump/tag tool `release.sh` still calls — leave it.) Line 68, before:
  ```
  - `npm run typecheck` and `npm run build` cover all three workspaces.
  ```
  After:
  ```
  - `bun run typecheck` and `bun run build` cover all three workspaces.
  ```

- [ ] **`README.md` — contributor runtime + smoke commands.** Line 82, before:
  ```
  devcontainer CLI and it builds with everything baked in — Node from `.nvmrc`,
  ```
  After:
  ```
  devcontainer CLI and it builds with everything baked in — Bun (pinned in `.tool-versions`),
  ```
  Line 109, before:
  ```
  and `bin/dev doctor` tells you what's missing (Node 22.22.3 and tmux required;
  ```
  After:
  ```
  and `bin/dev doctor` tells you what's missing (Bun 1.3.14 and tmux required;
  ```
  The smoke-test block, lines 146–157, before:
  ```bash
  cd server
  npx tsx src/smoke-client.ts     # tldraw sync handshake
  npx tsx src/smoke-terminal.ts   # gateway: io, scrollback, resize, tmux survival
  npx tsx src/canvas-api.test.ts  # canvas API: terminal-status, sticky, frames + frame read
  npx tsx src/scribe-api.test.ts  # transcript + shape APIs, scribe tokens
  cd ../client && npx tsx src/av/spatial.test.ts        # spatial gain model
  npx tsx src/session/layout.test.ts                    # session layout invariants
  npx tsx src/neko/neko.test.ts                         # neko shared-browser URL + aspect lock
  cd ../transcriber && npx tsx src/segmenter.test.ts    # utterance VAD
  npx tsx src/wav.test.ts                               # WAV encoder
  ```
  After:
  ```bash
  cd server
  bun src/smoke-client.ts     # tldraw sync handshake
  bun src/smoke-terminal.ts   # gateway: io, scrollback, resize, tmux survival
  bun src/canvas-api.test.ts  # canvas API: terminal-status, sticky, frames + frame read
  bun src/scribe-api.test.ts  # transcript + shape APIs, scribe tokens
  cd ../client && bun src/av/spatial.test.ts        # spatial gain model
  bun src/session/layout.test.ts                    # session layout invariants
  bun src/neko/neko.test.ts                         # neko shared-browser URL + aspect lock
  cd ../transcriber && bun src/segmenter.test.ts    # utterance VAD
  bun src/wav.test.ts                               # WAV encoder
  ```
  Line 217, before:
  ```
  npm run start --workspace=transcriber   # env: CANVAS_URL, CANVAS_ROOM, STT_URL, STT_MODEL, STT_API_KEY
  ```
  After:
  ```
  bun run --filter '@ensembleworks/transcriber' start   # env: CANVAS_URL, CANVAS_ROOM, STT_URL, STT_MODEL, STT_API_KEY
  ```
  Line 310, before:
  ```
     checkout; `npm ci && npm run build`. The `ensemble` user owns it, so the mob can edit
  ```
  After:
  ```
     checkout; `bun install && bun run build`. The `ensemble` user owns it, so the mob can edit
  ```
  The two "host (Node, Caddy, …)" mentions, line 296 and line 401, before:
  ```
  (trixie)** box end to end (Node, Caddy, cloudflared, the `ensemble` user, the
  ```
  ```
  sync server serves the static client (Caddy proxies to it). The host (Node, Caddy,
  ```
  After:
  ```
  (trixie)** box end to end (Bun, Caddy, cloudflared, the `ensemble` user, the
  ```
  ```
  sync server serves the static client (Caddy proxies to it). The host (Bun, Caddy,
  ```

- [ ] **Final verification gate — run in order and capture results.** All must pass and none may require Node:
  ```bash
  # a) No Node required — rebuild the devcontainer (or, on the host engine, doctor)
  bin/dev doctor                 # 'bun' check green; no node/node-pty checks remain
  # (blessed proof: rebuild the devcontainer image and confirm it builds with Bun only)

  # b) Install + static gates
  bun install                    # clean
  bun run typecheck              # green (contracts, client, server, transcriber, bin)
  bun run test                   # all 31 src suites pass
  bun run build                  # client (Vite under Bun), server, transcriber
  bun bin/dev.test.ts            # dev-lib pure-logic suite
  bash deploy/test/lib_test.sh   # ALL PASS

  # c) Stack up under Bun + live smoke
  bin/dev up
  ```
  For (c), the live browser smoke (per the design's testing section): the toolbar renders, the session panel renders, and creating then deleting a terminal shape raises the confirm dialog exactly once. **While the stack is up, check risk R1:** edit a `server/src/*.ts` file and confirm `bun --watch` reloads the sync/term service over the devcontainer bind mount (watch `bin/dev logs sync`/`bin/dev logs term`). Record the outcome:
  - If hot-reload fires: note R1 resolved.
  - If it does not: find Bun's polling knob (or a `--watch` alternative) or document a manual `bin/dev restart <svc>` as the accepted dev-ergonomics fallback.

- [ ] **Record the R1 result and any smoke notes** in this plan's Execution notes, then commit the docs + notes:
  ```bash
  git add CLAUDE.md README.md docs/superpowers/plans/2026-07-05-bun-runtime-migration.md
  git commit -m "$(cat <<'EOF'
  docs(bun): contributor runtime Node -> bun; record migration verification + R1

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: fill this section as you go — capture the Task 3 `Bun.Terminal API notes`, the Task 9 R1 hot-reload result, and any deviations from the verbatim blocks above.)_

### Commit trailer (updated 2026-07-05)

All commit blocks originally specified a `Co-Authored-By: Claude Fable 5` trailer.
Fable is out of credits for this run, so **every commit uses the generic trailer**:
```
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
```

### Task 1 deviations (commit 3126094)

Two additions beyond the verbatim block, both to keep the runtime swap
behaviour-neutral (they made the task's own "typecheck green" gate meaningful):

1. **`bunfig.toml` (new)** — `[install] linker = "hoisted"`. Bun 1.3.14's default
   *isolated* linker does not hoist transitive deps into a flat `node_modules`,
   so the client's phantom `@tldraw/tlschema` module-augmentation
   (`declare module '@tldraw/tlschema'` in the five ShapeUtil files) failed to
   resolve. The hoisted linker restores npm-parity flat `node_modules`.

2. **tldraw family pinned to exact `5.1.0`** across `client/package.json`
   (`tldraw`, `@tldraw/sync`), `server/package.json` (`@tldraw/sync-core`,
   `@tldraw/tlschema`, `@tldraw/utils`, `@tldraw/validate`) and
   `contracts/package.json` (`@tldraw/validate`). The parent branch's
   `package-lock.json` locked the whole `@tldraw/*` scope at 5.1.0; dropping the
   lock let the `^5.1.0` ranges float to 5.2.2, which (a) tightened
   `Editor.zoomToUser()` to a branded `TLUserId` and (b) hoisted a 5.2.2
   `tlschema` to root (via the server's `@tldraw/sync-core`) that the client's
   5.1.0-based augmentation then bound to — breaking the custom-shape unions.
   Pinning reproduces the shipped 5.1.0 closure exactly (a single
   `@tldraw/tlschema@5.1.0` hoisted at root). A tldraw *upgrade* is deliberately
   left as separate future work — not part of a runtime migration.

3. **LiveKit runtime SDKs pinned to shipped versions** — `livekit-client`
   (`2.19.2`, client) and `livekit-server-sdk` (`2.15.4`, server). The lockfile
   regen also floated these two `^`-ranged runtime deps by a minor version
   (2.20.0 / 2.16.0); pinned to what the parent lock shipped so the migration
   swaps the runtime engine, not the AV dependency versions (same rationale as
   the tldraw pin). The other two minor drifts the review found are left on their
   ranges: `tsx` (removed entirely in Task 5) and `@types/node` (types-only).

## Bun.Terminal API notes

Confirmed against **Bun 1.3.14** (`bun --version` → `1.3.14`), via a throwaway
script at `server/src/terminal/_pty_spike.ts` (spawned `tmux -V` and an
interactive `bash --noprofile --norc` session, then deleted — not committed).
The project's own `node_modules/bun-types@1.3.14/bun.d.ts` ships full JSDoc for
this API and matches the runtime behaviour exactly; excerpts from it are
quoted below alongside the empirical confirmation.

**The plan's hypothesis was wrong on the read mechanism and partially wrong on
the handle shape.** Bun 1.3.14's PTY API is **callback-based**, not
`for await (const chunk of term.readable)` — there is no `.readable` stream on
the terminal object at all. Details:

1. **Spawn form — confirmed, close to hypothesis.**
   `Bun.spawn([cmd, ...args], { terminal: { cols, rows, name, data, exit, drain } })`.
   The option key is `terminal` (matches hypothesis) but its value is a
   `TerminalOptions` object whose *callbacks* (`data`, `exit`, `drain`) are how
   you read output — there is no separate "get a stream" step. Key name is
   `name` (not `term`) for the terminal type string (default
   `"xterm-256color"`). You may also pass a pre-built `new Bun.Terminal(opts)`
   instead of a plain options object, to reuse one PTY across multiple spawns.

2. **Handle location — confirmed.** `proc.terminal` is the PTY handle (a
   `Bun.Terminal` instance), exactly as hypothesized. `proc.stdin` /
   `proc.stdout` / `proc.stderr` are all `null` when `terminal` is used.
   `Object.keys(proc)` returns `[]` (all Subprocess members are prototype
   getters); `Terminal`'s own prototype methods are:
   `close, closed, controlFlags, inputFlags, localFlags, outputFlags, ref,
   resize, setRawMode, unref, write, constructor`.

3. **Output read — differs from hypothesis.** NOT `for await` over a
   `.readable`. It's the `data` **callback** passed in `TerminalOptions`:
   `data?: (terminal: Terminal, data: Uint8Array<ArrayBuffer>) => void`.
   Chunks arrive as **`Uint8Array`**, not `string` — confirmed empirically
   (`Object.prototype.toString.call(data)` → `"[object Uint8Array]"`,
   `data instanceof Uint8Array` → `true`). **The wrapper MUST decode with
   `TextDecoder` (`{ stream: true }` across calls, to not split multi-byte
   UTF-8 sequences at chunk boundaries) before handing a string to
   `handle.onData`.**

4. **Write — confirmed.** `terminal.write(data: string | BufferSource): number`
   — accepts a string directly (no manual encoding needed) and returns the
   number of bytes written. Confirmed: `term.write("echo SPIKE_MARKER_$((1+1))\n")`
   returned `27` and the shell echoed `SPIKE_MARKER_2` back through the `data`
   callback.

5. **Resize — confirmed.** `terminal.resize(cols: number, rows: number): void`.
   Confirmed by resizing 80×24 → 120×40 then running `stty size` inside the
   PTY'd bash session, which echoed back `40 120` (rows cols), matching the
   new size exactly.

6. **Exit — confirmed, with an important nuance.** The subprocess's real exit
   code/lifecycle comes from **`await proc.exited: Promise<number>`** (and the
   synchronous `proc.exitCode` once resolved) — this is what the wrapper's
   `onExit` should be driven from. There is *also* a `TerminalOptions.exit`
   callback (`(terminal, exitCode, signal) => void`), but per `bun.d.ts` its
   `exitCode` is "a PTY lifecycle status (0=clean EOF, 1=error), NOT the
   subprocess exit code" — confirmed empirically: in both the `tmux -V` and
   `bash` sub-experiments, this callback fired **twice** — once with
   `exitCode: 1` (when the child closed its end of the PTY, before
   `proc.exited` resolved) and again with `exitCode: 0` (when we explicitly
   called `terminal.close()`). **Do not wire the wrapper's `onExit` to
   `TerminalOptions.exit` — use `proc.exited` instead**; treat the terminal's
   own `exit` callback (if used at all) as an internal stream-lifecycle signal
   only.

7. **Kill — confirmed.** `proc.kill(exitCode?: number | NodeJS.Signals): void`
   on the `Subprocess`, same as normal (non-PTY) Bun subprocesses — there is no
   separate `terminal.kill()`. `Terminal` itself has `close(): void` (and
   `[Symbol.asyncDispose]` for `await using`) to release the PTY resource;
   calling `proc.kill()` after the child already exited was confirmed to be a
   safe no-throw no-op.

**Verbatim working shape** (spawn → read → write → resize → exit → kill), the
exact pattern Task 4 should reproduce:

```ts
const decoder = new TextDecoder();
let collected = "";

const proc = Bun.spawn(["bash", "--noprofile", "--norc"], {
  terminal: {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data: (term, data) => {
      collected += decoder.decode(data, { stream: true }); // Uint8Array -> string
    },
    exit: (term, exitCode, signal) => {
      // PTY stream lifecycle only — NOT the process exit code. Ignore for onExit.
    },
  },
});

const term = proc.terminal!;         // PTY handle lives at proc.terminal
term.write("echo hello\n");          // write(string | BufferSource): number
term.resize(120, 40);                // resize(cols, rows): void

const exitCode = await proc.exited;  // real subprocess exit code (Promise<number>)
proc.kill();                         // Subprocess.kill(), not Terminal.kill()
term.close();                        // release the PTY (Terminal.close(): void)
```

**Mapping to the node-pty surface `terminal-gateway.ts` expects:**
| node-pty (current)              | Bun 1.3.14 equivalent                                                        |
|----------------------------------|-------------------------------------------------------------------------------|
| `pty.spawn(file, args, opts)`     | `Bun.spawn([file, ...args], { terminal: { cols, rows, name } })`             |
| `handle.onData((s: string) => …)` | `TerminalOptions.data` callback, `Uint8Array` — decode with `TextDecoder` (`{ stream: true }`) before calling the wrapper's `onData(str)` |
| `handle.onExit(() => …)`          | `await proc.exited` (not `TerminalOptions.exit`, which is PTY-stream lifecycle, not process exit, and can fire twice) |
| `handle.resize(cols, rows)`       | `proc.terminal.resize(cols, rows)`                                            |
| `handle.write(data: string)`      | `proc.terminal.write(data)` (accepts string directly)                        |
| `handle.kill()`                   | `proc.kill()` (on the `Subprocess`, not the `Terminal`); call `proc.terminal.close()` afterward to release the PTY |
