# Shared tmux Session Manager Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the tmux-via-PTY session primitive out of `server/src/terminal-gateway.ts` into `@ensembleworks/contracts` (a `./session-manager` subpath), so the server gateway and the future CLI connector share one implementation — with zero behaviour change.

**Architecture:** Expand-then-contract refactor. Task 1 adds the primitive to contracts (TDD, purely additive — the server keeps working). Task 2 rewires the gateway onto it and removes the server-local copy. The primitive owns PTY spawn + resize clamps; the gateway keeps its spawn policy, scrollback, fan-out and HTTP/WS server. The 5-message WS protocol is already shared (`contracts/terminal-protocol.ts`).

**Tech Stack:** Bun ≥ 1.3.14 (`Bun.spawn` PTY), TypeScript, `@ensembleworks/contracts` (Bun workspace), `ws`, tmux.

Spec: `docs/superpowers/specs/2026-07-05-session-manager-extraction-design.md`.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default `bun` on PATH is 1.3.4 (too old). This repo pins 1.3.14 via `.tool-versions` (mise). Before any `bun` command, ensure the pin is active:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Per-task green + commit.** Every task ends by committing and must leave `bun run typecheck` green. `tmux` and `bash` must be on PATH for the tests. Commit trailer, exactly:
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```
   (This repo's `git` runs through a direnv wrapper — commit exactly as shown.)
3. **Indentation.** `server/src/terminal-gateway.ts` uses **tabs**. `contracts/src/*` uses **2 spaces** (see the existing contracts files). Match the file you're editing.
4. **Intra-contracts imports use the `.js` extension** (nodenext; resolves to the `.ts` source) — see `contracts/src/index.ts`.

---

## Task 1 — Add the `TmuxSession` primitive to contracts (TDD)

Purely additive. The server keeps its own `pty.ts` and keeps working; this task introduces `contracts/src/pty.ts` (a copy) + `contracts/src/session-manager.ts` + its test + the subpath export + `bun-types`. The temporary duplicate `pty.ts` (server + contracts) is removed in Task 2.

**Files:**
- Create: `contracts/src/session-manager.test.ts`
- Create: `contracts/src/pty.ts`
- Create: `contracts/src/session-manager.ts`
- Modify: `contracts/package.json`
- Modify: `contracts/tsconfig.json`

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `contracts/src/session-manager.test.ts`:
  ```ts
  // Run: bun contracts/src/session-manager.test.ts
  // Locks the TmuxSession primitive: resize clamp/changed logic + a real-PTY
  // round-trip (spawn a shell, read output, resize, kill, observe exit). No tmux
  // needed here — the tmux path stays covered by server/src/relay-loopback.test.ts.
  import assert from 'node:assert/strict'
  import os from 'node:os'
  import { openTmuxSession } from './session-manager.js'

  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>

  // A shell that emits output immediately, then stays alive so we can resize it.
  const s = openTmuxSession(
    { file: 'bash', args: ['--noprofile', '--norc', '-c', 'printf READY; sleep 2'], cwd: os.tmpdir(), env },
    80,
    24,
  )
  assert.equal(s.cols, 80, 'initial cols')
  assert.equal(s.rows, 24, 'initial rows')

  // Accumulate chunks (PTY output can arrive split) until we see the marker.
  let acc = ''
  const gotData = new Promise<string>((resolve) => {
    s.onData((d) => {
      acc += d
      if (acc.includes('READY')) resolve(acc)
    })
  })
  const exited = new Promise<void>((resolve) => s.onExit(() => resolve()))

  await Promise.race([
    gotData,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('no PTY "READY" in 2s')), 2000)),
  ])
  assert.ok(acc.includes('READY'), 'shell output round-trips through the PTY')

  // resize: clamp cols[20..500]/rows[5..200], integer-only, no-op when unchanged.
  assert.equal(s.resize(120, 40), true, 'a real change applies')
  assert.equal(s.cols, 120)
  assert.equal(s.rows, 40)
  assert.equal(s.resize(120, 40), false, 'unchanged size is a no-op')
  assert.equal(s.resize(5, 2), true, 'below-min applies (clamped)')
  assert.equal(s.cols, 20, 'cols clamps up to 20')
  assert.equal(s.rows, 5, 'rows clamps up to 5')
  assert.equal(s.resize(9999, 9999), true, 'above-max applies (clamped)')
  assert.equal(s.cols, 500, 'cols clamps down to 500')
  assert.equal(s.rows, 200, 'rows clamps down to 200')
  assert.equal(s.resize(80.5, 24), false, 'non-integer is rejected')
  assert.equal(s.cols, 500, 'rejected resize leaves size unchanged')

  // kill → onExit fires.
  s.kill()
  await Promise.race([
    exited,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('onExit did not fire in 2s')), 2000)),
  ])

  console.log('ok: TmuxSession primitive')
  process.exit(0)
  ```

- [ ] **Step 2: Run the test — expect failure** (module doesn't exist yet):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun contracts/src/session-manager.test.ts
  ```
  Expected: a resolution error, e.g. `Cannot find module './session-manager.js'` / `Could not resolve`.

- [ ] **Step 3: Create `contracts/src/pty.ts`** — the Bun PTY wrapper, copied from `server/src/terminal/pty.ts` with only the header comment updated to its new home (the body is byte-for-byte identical):
  ```ts
  /**
   * PTY wrapper backing the shared tmux session manager: presents the node-pty
   * surface (spawn/onData/onExit/resize/write/kill) over Bun's built-in PTY.
   * node-pty is a native Node addon Bun cannot load — this is the replacement.
   * Internal to @ensembleworks/contracts (imported by session-manager.ts); reached
   * only via the ./session-manager subpath, never the browser barrel (index.ts).
   *
   * Bun PTY API pinned against Bun >= 1.3.14: output is delivered via the
   * `terminal.data` callback as Uint8Array (decoded here to a string), NOT a
   * readable stream; process exit comes from `proc.exited`, never the terminal's
   * own `exit` callback (which is PTY-stream lifecycle and fires twice).
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
    const decoder = new TextDecoder()
    let dataCb: ((data: string) => void) | null = null
    let exitCb: (() => void) | null = null

    // Bun delivers PTY output through the terminal `data` callback as a
    // Uint8Array; decode (stream:true so multi-byte UTF-8 isn't split at chunk
    // boundaries) and hand the caller a string. Key is `name`, not `term`.
    const proc = Bun.spawn([file, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        name: opts.name,
        data: (_term, chunk) => {
          if (dataCb) dataCb(decoder.decode(chunk, { stream: true }))
        },
      },
    })
    const term = proc.terminal! // the PTY handle from the spawned process.

    // Real subprocess exit — NOT terminal.exit (PTY-stream lifecycle, fires
    // twice). Release the PTY fd once the child is truly gone (node-pty closed it
    // on exit too; skipping this leaks a descriptor per terminated session).
    proc.exited.then(() => {
      if (exitCb) exitCb()
      term.close()
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

- [ ] **Step 4: Create `contracts/src/session-manager.ts`** — the shared primitive:
  ```ts
  /**
   * Shared tmux session primitive — one implementation of "open a tmux client
   * through a PTY, write/resize/read it," used by the server terminal gateway and
   * (later) the CLI connector. Transport-agnostic: it deals in raw bytes + a
   * resize/exit lifecycle; callers translate to the 5-message WS protocol
   * (contracts/terminal-protocol.ts) and own their own scrollback/fan-out.
   *
   * Bun/server-only (spawns a PTY via Bun.spawn). Reachable only through the
   * `@ensembleworks/contracts/session-manager` subpath — never the browser barrel.
   */
  import { spawnPty, type Pty } from './pty.js'

  /** How to spawn the tmux client on this host (the caller's policy). */
  export interface SpawnSpec {
    file: string
    args: string[]
    cwd: string
    env: Record<string, string>
  }

  export interface TmuxSession {
    onData(cb: (data: string) => void): void
    onExit(cb: () => void): void
    write(data: string): void
    /** integer-check + clamp cols[20..500]/rows[5..200] + changed-check; applies
     *  to the PTY and updates cols/rows. Returns true iff the size actually changed. */
    resize(cols: number, rows: number): boolean
    kill(): void
    readonly cols: number
    readonly rows: number
  }

  const COLS_MIN = 20
  const COLS_MAX = 500
  const ROWS_MIN = 5
  const ROWS_MAX = 200
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

  export function openTmuxSession(spec: SpawnSpec, cols: number, rows: number): TmuxSession {
    const pty: Pty = spawnPty(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
    })
    let curCols = cols
    let curRows = rows

    return {
      onData: (cb) => pty.onData(cb),
      onExit: (cb) => pty.onExit(cb),
      write: (data) => pty.write(data),
      kill: () => pty.kill(),
      resize(cols, rows) {
        if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false
        const c = clamp(cols, COLS_MIN, COLS_MAX)
        const r = clamp(rows, ROWS_MIN, ROWS_MAX)
        if (c === curCols && r === curRows) return false
        curCols = c
        curRows = r
        pty.resize(c, r)
        return true
      },
      get cols() {
        return curCols
      },
      get rows() {
        return curRows
      },
    }
  }
  ```

- [ ] **Step 5: Add the subpath export + `bun-types`.** In `contracts/package.json`, change the `exports` block and add `bun-types` to `devDependencies`. Before:
  ```json
    "exports": {
      ".": "./src/index.ts"
    },
  ```
  After:
  ```json
    "exports": {
      ".": "./src/index.ts",
      "./session-manager": "./src/session-manager.ts"
    },
  ```
  And in `devDependencies`, before:
  ```json
      "@types/node": "^22.0.0",
      "typescript": "^5.7.0"
  ```
  After:
  ```json
      "@types/node": "^22.0.0",
      "bun-types": "1.3.14",
      "typescript": "^5.7.0"
  ```

- [ ] **Step 6: Add `bun-types` to the contracts tsconfig.** In `contracts/tsconfig.json`, add a `types` array to `compilerOptions` (currently absent, so TS auto-includes every `@types` package; `zod`/`@tldraw/validate` ship their own types, so restricting to `node`+`bun-types` is safe and is what lets `Bun.spawn` typecheck). Before:
  ```json
    "compilerOptions": {
      "target": "es2023",
      "module": "nodenext",
      "moduleResolution": "nodenext",
      "strict": true,
      "noEmit": true,
      "skipLibCheck": true
    },
  ```
  After:
  ```json
    "compilerOptions": {
      "target": "es2023",
      "module": "nodenext",
      "moduleResolution": "nodenext",
      "strict": true,
      "noEmit": true,
      "skipLibCheck": true,
      "types": ["node", "bun-types"]
    },
  ```

- [ ] **Step 7: Install and run the test — expect pass:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun contracts/src/session-manager.test.ts
  ```
  Expected: `bun install` resolves `bun-types`; the test ends with `ok: TmuxSession primitive`.

- [ ] **Step 8: Whole-repo typecheck stays green** (the server still uses its own `pty.ts` — that's fine this task):
  ```bash
  bun run typecheck
  ```
  Expected: exit 0 across contracts, client, server, transcriber, bin.

- [ ] **Step 9: Commit:**
  ```bash
  git add contracts/src/session-manager.ts contracts/src/session-manager.test.ts contracts/src/pty.ts contracts/package.json contracts/tsconfig.json bun.lock
  git commit -m "$(cat <<'EOF'
  feat(contracts): shared TmuxSession primitive + ./session-manager subpath

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — Rewire the gateway onto the shared primitive; remove the server copy

Behaviour-neutral swap. `terminal-gateway.ts` stops calling `spawnPty` directly and uses `openTmuxSession`; the redundant `cols`/`rows` state on `TermSession` is dropped (the `TmuxSession` owns it); the server's now-duplicate `pty.ts` is deleted. Guarded by the real-tmux integration tests.

**Files:**
- Modify: `server/src/terminal-gateway.ts`
- Delete: `server/src/terminal/pty.ts` (and the now-empty `server/src/terminal/`)

**Steps:**

- [ ] **Step 1: Swap the import.** In `server/src/terminal-gateway.ts` (~line 29), before:
  ```ts
  import { spawnPty, type Pty } from './terminal/pty.ts'
  ```
  After:
  ```ts
  import { openTmuxSession, type TmuxSession } from '@ensembleworks/contracts/session-manager'
  ```

- [ ] **Step 2: Retype the session + drop the redundant size fields.** The `TermSession` interface (~lines 119–127), before:
  ```ts
  interface TermSession {
  	id: string
  	pty: Pty
  	clients: Set<WebSocket>
  	scrollback: Buffer[]
  	scrollbackBytes: number
  	cols: number
  	rows: number
  }
  ```
  After (the `TmuxSession` is now the single source of truth for size):
  ```ts
  interface TermSession {
  	id: string
  	pty: TmuxSession
  	clients: Set<WebSocket>
  	scrollback: Buffer[]
  	scrollbackBytes: number
  }
  ```

- [ ] **Step 3: Open the session via the primitive.** In `getOrCreateSession` (~lines 139–156), before:
  ```ts
  	const spec = tmuxSpawnSpec(id)
  	const proc = spawnPty(spec.file, spec.args, {
  		name: 'xterm-256color',
  		cols,
  		rows,
  		cwd: spec.cwd,
  		env: spec.env,
  	})

  	const session: TermSession = {
  		id,
  		pty: proc,
  		clients: new Set(),
  		scrollback: [],
  		scrollbackBytes: 0,
  		cols,
  		rows,
  	}
  ```
  After (the `onData`/`onExit` blocks that follow are unchanged):
  ```ts
  	const proc = openTmuxSession(tmuxSpawnSpec(id), cols, rows)

  	const session: TermSession = {
  		id,
  		pty: proc,
  		clients: new Set(),
  		scrollback: [],
  		scrollbackBytes: 0,
  	}
  ```

- [ ] **Step 4: Collapse `resizeSession` onto the primitive.** The whole function (~lines 187–201), before:
  ```ts
  function resizeSession(session: TermSession, cols: number, rows: number) {
  	if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  	cols = Math.max(20, Math.min(500, cols))
  	rows = Math.max(5, Math.min(200, rows))
  	if (cols === session.cols && rows === session.rows) return
  	session.cols = cols
  	session.rows = rows
  	session.pty.resize(cols, rows)
  	// Authoritative size fan-out: every viewer converges on the same grid.
  	const resizeMsg: TermServerMessage = { type: 'resize', cols, rows }
  	const msg = JSON.stringify(resizeMsg)
  	for (const ws of session.clients) {
  		if (ws.readyState === ws.OPEN) ws.send(msg)
  	}
  }
  ```
  After (the integer/clamp/changed logic now lives in `TmuxSession.resize`; the authoritative fan-out stays, firing only on a real change, exactly as before):
  ```ts
  function resizeSession(session: TermSession, cols: number, rows: number) {
  	if (!session.pty.resize(cols, rows)) return
  	// Authoritative size fan-out: every viewer converges on the same grid.
  	const resizeMsg: TermServerMessage = { type: 'resize', cols: session.pty.cols, rows: session.pty.rows }
  	const msg = JSON.stringify(resizeMsg)
  	for (const ws of session.clients) {
  		if (ws.readyState === ws.OPEN) ws.send(msg)
  	}
  }
  ```

- [ ] **Step 5: Read size from the primitive in the `attached` message.** In the WS upgrade handler (~line 306), before:
  ```ts
  			const attachedMsg: TermServerMessage = { type: 'attached', cols: session.cols, rows: session.rows }
  ```
  After:
  ```ts
  			const attachedMsg: TermServerMessage = { type: 'attached', cols: session.pty.cols, rows: session.pty.rows }
  ```

- [ ] **Step 6: Delete the server's now-duplicate PTY wrapper + its empty dir:**
  ```bash
  git rm server/src/terminal/pty.ts
  rmdir server/src/terminal 2>/dev/null || true
  ```

- [ ] **Step 7: Typecheck + confirm no stale references.**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  grep -rn "terminal/pty\|spawnPty" server/src client/src transcriber/src | grep -v node_modules || echo "no stale pty references"
  ```
  Expected: typecheck exit 0; the grep prints `no stale pty references` (the gateway now uses `openTmuxSession`, and nothing else referenced `spawnPty`).

- [ ] **Step 8: Behavioural guards — real tmux IO through the gateway must still pass** (`tmux` required):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  PORT=18789 bun server/src/terminal-gateway.ts &
  sleep 1
  curl -sf http://localhost:18789/term/health && echo " TERM-OK"
  kill %1
  (cd server && bun src/relay-loopback.test.ts)
  (cd server && bun src/gateway-plane.test.ts)
  ```
  Expected: ` TERM-OK`; `relay-loopback.test.ts: all assertions passed`; `gateway-plane.test.ts: all assertions passed`. (These drive attach/echo/resize/scrollback over a real tmux via the gateway — the behaviour-neutrality proof.)

- [ ] **Step 9: Browser safety + full suite + build.**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  # The Bun-only session manager must never reach the client. Two guards:
  # (a) the barrel must NOT re-export it (the client imports the barrel), and
  # (b) no client file imports the subpath directly.
  grep -nE "session-manager|\./pty" contracts/src/index.ts \
    && echo "FAIL: barrel re-exports the session manager / pty" || echo "OK: barrel excludes the session manager"
  grep -rn "session-manager\|contracts/pty\|contracts/src/pty" client/src | grep -v node_modules \
    && echo "FAIL: client imports the session manager" || echo "OK: client never imports the session manager"
  bun run test     # all suites pass, incl. the new contracts/src/session-manager.test.ts
  bun run build    # client (Vite under Bun) + server + transcriber; proves the client bundles without the Bun-only module
  ```
  Expected: `OK: client never imports the session manager`; `bun run test` ends `all N suites passed`; `bun run build` exits 0.

- [ ] **Step 10: Commit:**
  ```bash
  git add server/src/terminal-gateway.ts
  git commit -m "$(cat <<'EOF'
  refactor(server): gateway uses the shared contracts TmuxSession; drop server pty

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```
  (`git rm` in Step 6 already staged the deletion; it's included in this commit.)

---

## Execution notes

_(Executors: record any deviation from the verbatim blocks above, and the final `bun run test` suite count.)_
