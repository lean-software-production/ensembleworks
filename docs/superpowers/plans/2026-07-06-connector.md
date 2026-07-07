# The native connector — `ensembleworks terminal connect` fills the #4 slot (slice #5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One TypeScript engine under `cli/src/connector/`, run behind the
`terminal connect` slot #4 already ships, that **replaces `gateway-go/`
byte-for-byte on the wire**: it dials the single outbound WS to
`/api/terminal/connect`, demuxes relay channels onto tmux sessions, and
reconnects with the exact jittered-backoff / ping / read-limit / shed-queue
contract the Go connector implemented. Sessions are tmux, so they survive the
connector, the browser, and the canvas link — a restart reattaches via
`new-session -A`. After the slice `bun run typecheck`, `bun run test`, and
`bun run build` are green and the suite count is **prior + 5** (52 → **57** at
this plan's writing; if slice #6 merges first the base is 53 → **58** — state
the concrete number at execution time).

**Spec:** `docs/superpowers/specs/2026-07-06-connector-design.md` — panel r1+r2
approved; implement it exactly. Its module layout (§3), the relay-parity
contract as code (§4), the shared spawn helper (§5), the three-module engine
(§6.1 session, §6.2 mux, §6.3 transport), the full frame table (§6.4), and the
five test suites (§7) are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"#5 — Connector / #6 — Transcriber" + "Standing conventions".

**Scope boundary (spec §1 — do not cross it):** #5 builds the connector engine
only. It does **not** retire `gateway-go/`, `connect.sh`, or the standalone
termgw artifact (that is #8); it does **not** do the `bun build --compile`
target (#7 — #5 owes only *compile compatibility*: static imports, real-FS
config paths); it does **not** touch the splicer (`gateway-registry.ts`) or the
`terminal-gateway.ts` fan-out — the **only** server line #5 changes is
`terminal-gateway.ts`'s non-`RUN_AS` spawn-spec branch, redirected to the shared
`canvasTmuxSpawnSpec` (behaviour-preserving). The `RUN_AS`/privilege-separation
branch, scrollback, and WS wiring are unchanged. #5 introduces no CLI flags or
resolution — it *consumes* #4's resolved `ConnectConfig` verbatim.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in every `cli/src/*`, `contracts/src/*`, and
   `server/src/*` file (the whole repo is tab-indented; there is no
   biome/prettier/editorconfig). Every verbatim block below is written with tabs
   (the fenced code is indented two spaces for markdown; strip that two-space
   prefix and the code body is tabs). Preserve them.
3. **Import extensions.** Intra-`cli` imports use the `.ts` extension
   (`./session.ts`, `../resolve.ts`) — `allowImportingTsExtensions` permits it and
   Bun runs it natively. Contracts is imported by package name: the barrel
   `@ensembleworks/contracts`, the Bun-only subpath
   `@ensembleworks/contracts/session-manager`, and the new
   `@ensembleworks/contracts/relay-parity`. Intra-`contracts` imports use `.js`
   (nodenext-style, resolves to `.ts`). `zod` is v4; `ws` is added to `cli` in
   Task 4.
4. **Test convention.** Self-running `bun src/<x>.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob — it already matches
   `cli/src/connector/*.test.ts` and `server/src/*.test.ts` (verified), so **no
   runner change**. Each suite ends `console.log('ok: …')`.
5. **CRITICAL house convention — `process.exit(0)` after a booted/subprocess
   suite.** Any test that calls `createSyncApp` or spawns a subprocess MUST end
   `process.exit(0)` after its final `console.log(...)` — background intervals
   (and child processes) keep the event loop alive, so without the explicit exit
   the suite hangs and the runner stalls. Only Task 6's
   `server/src/connector-loopback.test.ts` boots an app + spawns the connector;
   the four connector unit suites (Tasks 1–4) are network-free (no
   `createSyncApp`, no subprocess, no real tmux, no wall-clock — injected
   timers/rng, fake pty/socket) and need no exit.
6. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task vs at the end

- **Per task (Tasks 1–5): `bun run typecheck` MUST be green, and the specific
  test suite(s) named in that task MUST be at the state the task declares** (RED
  at a written-test checkpoint, GREEN at the task's end). Task 1 additionally
  gates on the **behaviour-neutral guards** — `server/src/gateway-plane.test.ts`
  and `server/src/relay-loopback.test.ts` must stay green after the
  `terminal-gateway.ts` redirect (both exercise the real terminal gateway). Task
  5 adds no new suite (it is the entry point + one-line seam, pinned by Task 6's
  e2e); it gates on `typecheck` plus re-running the three already-green connector
  unit suites to prove no regression.
- **No task is permitted to leave a red suite at its end.**
- **End only (Task 6): the full `bun run test` (`all <N> suites passed`),
  `bun run build`, and the manual smoke.**

### Two arc reconciliations (documented, not escalated)

- **`backoff.test.ts` is Task 1's TDD driver, not Task 4's.** The suggested arc
  paired the backoff suite with the transport task, but `backoff.test.ts`
  depends only on the pure `@ensembleworks/contracts/relay-parity` module (no
  transport, no timers) — the module Task 1 creates. Placing it here makes Task 1
  a genuine RED→GREEN (and pins the parity constant *values* against `relay.go`
  the moment they land) without changing the five-suite budget. Task 4 keeps
  `reconnect.test.ts`.
- **The ID_RE citation.** The spec's trust-boundary note (§6.1) cites
  `gateway-registry.ts` line 271 (the `/api/terminal/relay` session-id
  *enforcement*); the canonical citation is line **184**, where `ID_RE` is
  *defined* (`/^[a-zA-Z0-9_-]{1,48}$/`). Comments in this plan's code cite `:184`.

---

## Task 1 — Contracts foundations: `relay-parity` subpath + `clampTmuxGrid` + `canvasTmuxSpawnSpec` + the behaviour-neutral server redirect (TDD: RED → GREEN)

Create the pure relay-parity module (constants + `computeBackoff`), add the two
`session-manager.ts` helpers the engine needs, and redirect
`terminal-gateway.ts`'s non-`RUN_AS` branch to the shared spawn helper. TDD is
driven by `backoff.test.ts` (relay-parity); the redirect is proven
behaviour-neutral by the two server guard suites staying green.

### Step 1 — Wire the new subpath + scaffold the connector dir

- [ ] **Add `./relay-parity` to `contracts/package.json` `exports`** — replace:
  ```json
    "exports": {
      ".": "./src/index.ts",
      "./session-manager": "./src/session-manager.ts"
    },
  ```
  with:
  ```json
    "exports": {
      ".": "./src/index.ts",
      "./session-manager": "./src/session-manager.ts",
      "./relay-parity": "./src/relay-parity.ts"
    },
  ```
  (No `paths` entry is needed in `cli/tsconfig.json`: `moduleResolution:
  bundler` honours package `exports` through the `node_modules` symlink, exactly
  as `server/src` already imports `@ensembleworks/contracts/session-manager`
  with only the barrel in its `paths`.)

- [ ] **Create the connector directory** (`cli/src/connector/`) — it is created
  implicitly by writing `backoff.test.ts` into it in Step 2.

### Step 2 — Write the failing suite (RED)

- [ ] **`cli/src/connector/backoff.test.ts`** (create it — network-free, no
  timers, no boot):
  ```ts
  // The relay parity contract (contracts/src/relay-parity.ts): the pinned
  // constant VALUES match gateway-go/relay/relay.go, computeBackoff reproduces
  // the 1s→30s jittered curve (relay.go lines 121–126) under a stubbed rng, and
  // the healthy-reset threshold is the pure check the reconnect loop uses.
  // Run with: bun src/connector/backoff.test.ts
  import assert from 'node:assert/strict'
  import {
  	computeBackoff,
  	RELAY_BACKOFF_BASE_MS,
  	RELAY_BACKOFF_CAP_MS,
  	RELAY_BACKOFF_EXPONENT_CAP,
  	RELAY_CHANNEL_QUEUE_DEPTH,
  	RELAY_HEALTHY_RESET_MS,
  	RELAY_JITTER_MAX,
  	RELAY_JITTER_MIN,
  	RELAY_PING_INTERVAL_MS,
  	RELAY_READ_LIMIT_BYTES,
  } from '@ensembleworks/contracts/relay-parity'

  // 1. Constant VALUES pinned against relay.go (the parity audit).
  assert.equal(RELAY_BACKOFF_BASE_MS, 1_000, 'base 1s — relay.go:122')
  assert.equal(RELAY_BACKOFF_CAP_MS, 30_000, 'cap 30s — relay.go:123–125')
  assert.equal(RELAY_BACKOFF_EXPONENT_CAP, 5, 'min(attempt-1,5) — relay.go:122')
  assert.equal(RELAY_JITTER_MIN, 0.8, 'jitter floor 0.8 — relay.go:126')
  assert.equal(RELAY_JITTER_MAX, 1.2, 'jitter ceil 1.2 — relay.go:126 (0.8+0.4)')
  assert.equal(RELAY_HEALTHY_RESET_MS, 30_000, 'healthyDuration 30s — relay.go:96')
  assert.equal(RELAY_PING_INTERVAL_MS, 20_000, 'pingInterval 20s — relay.go:137')
  assert.equal(RELAY_READ_LIMIT_BYTES, 1 << 20, 'SetReadLimit(1<<20) — relay.go:152')
  assert.equal(RELAY_CHANNEL_QUEUE_DEPTH, 64, 'make(chan …, 64) — relay.go:201')

  // 2. Base curve with jitter neutralised (rng=0.5 → factor 0.8+0.4*0.5 = 1.0).
  const mid = () => 0.5
  assert.equal(computeBackoff(1, mid), 1_000, 'attempt 1 → 1s')
  assert.equal(computeBackoff(2, mid), 2_000, 'attempt 2 → 2s')
  assert.equal(computeBackoff(3, mid), 4_000, 'attempt 3 → 4s')
  assert.equal(computeBackoff(4, mid), 8_000, 'attempt 4 → 8s')
  assert.equal(computeBackoff(5, mid), 16_000, 'attempt 5 → 16s')
  // 3. The cap: attempt 6's raw 32s clamps to 30s, and every later attempt too.
  assert.equal(computeBackoff(6, mid), 30_000, 'attempt 6 → 32s clamped to 30s')
  assert.equal(computeBackoff(7, mid), 30_000, 'attempt 7 → 30s (exponent capped)')
  assert.equal(computeBackoff(100, mid), 30_000, 'exponent cap holds far out')

  // 4. Jitter bounds: rng=0 → exactly 0.8×; rng→1 → strictly below 1.2×.
  assert.equal(computeBackoff(1, () => 0), 800, 'rng=0 → 0.8× base')
  assert.equal(computeBackoff(3, () => 0), 3_200, 'rng=0 → 0.8× (attempt 3)')
  {
  	const hi = computeBackoff(1, () => 0.999999)
  	assert.ok(hi < 1_200 && hi >= 1_000, `rng→1 stays below 1.2× (got ${hi})`)
  }

  // 5. Healthy-reset rule as a pure check (relay.go:118 — reset the counter when
  //    the last connection survived longer than RELAY_HEALTHY_RESET_MS).
  assert.equal(31_000 > RELAY_HEALTHY_RESET_MS, true, 'a >30s connection is healthy')
  assert.equal(30_000 > RELAY_HEALTHY_RESET_MS, false, 'exactly 30s is not (strict >)')

  console.log('ok: backoff — parity constant values, 1s→30s jittered curve, exponent cap, jitter bounds, healthy-reset threshold')
  ```

- [ ] **RED checkpoint — run it, expect failure (module does not exist yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/backoff.test.ts)
  ```
  Expected: **fails** — `Cannot find module '@ensembleworks/contracts/relay-parity'`.

### Step 3 — Write the contracts additions + the server redirect (GREEN)

- [ ] **`contracts/src/relay-parity.ts`** (create it — pure, no `node:` imports):
  ```ts
  /**
   * The relay parity contract (plugin-architecture track charter §"#5"): the
   * reconnect/ping/read-limit/shed constants the native connector reproduces from
   * gateway-go/relay/relay.go, plus the pure backoff curve. Enforced in
   * cli/src/connector/{relay-client,mux}.ts; pinned by connector/backoff.test.ts.
   */

  /** Exponential backoff base — the first reconnect waits ~1 s (× jitter). */
  export const RELAY_BACKOFF_BASE_MS = 1_000
  /** Backoff cap — no reconnect delay exceeds ~30 s (× jitter). */
  export const RELAY_BACKOFF_CAP_MS = 30_000
  /** The shift is min(attempt-1, 5): 1,2,4,8,16,32→cap at every later attempt. */
  export const RELAY_BACKOFF_EXPONENT_CAP = 5
  /** Multiplicative jitter window applied to the computed backoff (0.8–1.2×). */
  export const RELAY_JITTER_MIN = 0.8
  export const RELAY_JITTER_MAX = 1.2
  /** A connection that survives longer than this resets the backoff counter. */
  export const RELAY_HEALTHY_RESET_MS = 30_000
  /** Ping cadence — matches the splicer heartbeat (gateway-registry.ts). */
  export const RELAY_PING_INTERVAL_MS = 20_000
  /** Inbound frame ceiling — the ws client's maxPayload (coder SetReadLimit 1<<20). */
  export const RELAY_READ_LIMIT_BYTES = 1 << 20
  /** Per-channel FIFO depth; the 65th queued frame is shed, never blocks the read loop. */
  export const RELAY_CHANNEL_QUEUE_DEPTH = 64

  /**
   * The jittered exponential backoff for reconnect attempt `attempt` (1-based:
   * the first retry is attempt 1, matching relay.go's post-increment). Pure:
   * `rng` defaults to Math.random and is injected in tests for a deterministic
   * curve. Returns whole milliseconds.
   *
   * attempt: 1→~1s 2→~2s 3→~4s 4→~8s 5→~16s 6+→~30s (32s clamped to the cap),
   * each × a uniform [0.8, 1.2) factor — identical to relay.go lines 121–126.
   */
  export function computeBackoff(attempt: number, rng: () => number = Math.random): number {
  	const shift = Math.min(attempt - 1, RELAY_BACKOFF_EXPONENT_CAP)
  	const base = Math.min(RELAY_BACKOFF_BASE_MS * 2 ** shift, RELAY_BACKOFF_CAP_MS)
  	const jitter = RELAY_JITTER_MIN + (RELAY_JITTER_MAX - RELAY_JITTER_MIN) * rng()
  	return Math.round(base * jitter)
  }
  ```

- [ ] **`contracts/src/session-manager.ts`** — add `clampTmuxGrid` and
  `canvasTmuxSpawnSpec`. This file is the Bun-only subpath (never the browser
  barrel), so `node:fs` is safe. Two edits:

  - **Extend the top imports** (it currently imports only `./pty.js`). Add:
    ```ts
    import { existsSync } from 'node:fs'
    import { spawnPty, type Pty } from './pty.js'
    import { TMUX_SESSION_PREFIX } from './constants.js'
    ```
    (Keep the existing `spawnPty`/`Pty` import; add the `existsSync` and
    `TMUX_SESSION_PREFIX` lines.)

  - **Append these exports after `openTmuxSession`** (they reuse the file's
    existing private `clamp`, `COLS_MIN`, `COLS_MAX`, `ROWS_MIN`, `ROWS_MAX` — no
    second copy of the bounds anywhere):
    ```ts
    /** The tmux grid bounds get one exported home (the same literals resize()
     *  clamps with; no second copy anywhere). session.go's getOrCreate clamps the
     *  initial grid BEFORE spawn — openTmuxSession stores its construction size
     *  unclamped (its clamp lives only in resize()), so the connector's session
     *  manager clamps here first. */
    export function clampTmuxGrid(cols: number, rows: number): { cols: number; rows: number } {
    	return { cols: clamp(cols, COLS_MIN, COLS_MAX), rows: clamp(rows, ROWS_MIN, ROWS_MAX) }
    }

    export interface CanvasTmuxSpawnOptions {
    	sessionId: string
    	/** tmux config path; `-f` is applied only when the file exists (missing conf
    	 *  silently degrades clipboard/status-bar, never crashes — tmux.go semantics). */
    	tmuxConf?: string
    	/** cwd for the tmux client; defaults to $HOME then process.cwd(). */
    	home?: string
    }

    /** The canvas tmux spawn policy shared by the server gateway and the connector:
     *  `tmux [-f conf] new-session -A -s canvas-<id>` with the xterm-256color /
     *  light-bg / conf-reload env. Behaviour-identical to terminal-gateway.ts's
     *  direct (non-RUN_AS) branch (charter §"#5"). */
    export function canvasTmuxSpawnSpec(opts: CanvasTmuxSpawnOptions): SpawnSpec {
    	const sessionName = `${TMUX_SESSION_PREFIX}${opts.sessionId}`
    	const baseArgs = opts.tmuxConf && existsSync(opts.tmuxConf) ? ['-f', opts.tmuxConf] : []
    	const env: Record<string, string> = {
    		...(process.env as Record<string, string>),
    		TERM: 'xterm-256color',
    		COLORFGBG: '0;15', // light-bg hint for tmux < 3.4 (drops OSC 11 queries)
    	}
    	if (opts.tmuxConf) env.ENSEMBLEWORKS_TMUX_CONF = opts.tmuxConf // the `q` reload binding reads this
    	return {
    		file: 'tmux',
    		args: [...baseArgs, 'new-session', '-A', '-s', sessionName],
    		cwd: opts.home ?? process.env.HOME ?? process.cwd(),
    		env,
    	}
    }
    ```

- [ ] **`server/src/terminal-gateway.ts`** — the one server line #5 changes.

  - **Add `canvasTmuxSpawnSpec` to the existing session-manager import** — replace:
    ```ts
    import { openTmuxSession, type TmuxSession } from '@ensembleworks/contracts/session-manager'
    ```
    with:
    ```ts
    import { canvasTmuxSpawnSpec, openTmuxSession, type TmuxSession } from '@ensembleworks/contracts/session-manager'
    ```

  - **Redirect the non-`RUN_AS` branch of `tmuxSpawnSpec`** — replace the entire
    `else`/direct return (the block that today reads
    `return { file: 'tmux', args: [...TMUX_BASE_ARGS, 'new-session', '-A', '-s', sessionName], cwd: …, env: { …COLORFGBG…ENSEMBLEWORKS_TMUX_CONF… } }`)
    with:
    ```ts
    	return canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: TMUX_CONF, home: process.env.HOME })
    ```
    Leave the `RUN_AS` branch, `probeRunAs`, `TMUX_CONF`, `TMUX_BASE_ARGS`, and
    everything else untouched. This is behaviour-preserving: `TMUX_CONF` is always
    a resolved path string, so `ENSEMBLEWORKS_TMUX_CONF` is still always set and
    `-f` still gates on `existsSync` — identical env, args, and cwd to today.
    `TMUX_BASE_ARGS` becomes dead (the helper recomputes `-f` internally); leaving
    it in place is fine — it is still referenced by nothing else and typechecks
    (or remove it if the transcriber prefers a clean file; either is
    behaviour-neutral). **Do not touch** the `RUN_AS` return.

### Step 4 — GREEN gate + commit

- [ ] **Run the new suite, the behaviour-neutral guards, and typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/backoff.test.ts)
  bun run typecheck
  (cd server && bun src/gateway-plane.test.ts)     # spawns tmux — behaviour guard
  (cd server && bun src/relay-loopback.test.ts)    # spawns the real gateway — behaviour guard
  ```
  Expected: `backoff.test.ts` prints its `ok: backoff — …` line; `typecheck`
  exits 0; both server guards still print their existing `all assertions passed`
  / `ok: …` lines (the redirect is behaviour-neutral). Precondition for the two
  server suites: `tmux` on PATH.

- [ ] **Commit:**
  ```bash
  git add contracts/package.json contracts/src/relay-parity.ts contracts/src/session-manager.ts \
    server/src/terminal-gateway.ts cli/src/connector/backoff.test.ts
  git commit -m "$(cat <<'EOF'
  feat(contracts): relay-parity subpath + clampTmuxGrid + canvasTmuxSpawnSpec; redirect terminal-gateway direct branch (slice #5)

  New @ensembleworks/contracts/relay-parity: the 6+ pinned reconnect/ping/read-
  limit/shed constants lifted from gateway-go/relay/relay.go plus the pure
  computeBackoff (1s→30s jittered curve, lines 121–126). session-manager.ts gains
  clampTmuxGrid (one exported home for the [20..500]/[5..200] bounds resize()
  already uses) and canvasTmuxSpawnSpec (the canvas tmux policy shared by server
  and connector). terminal-gateway.ts's non-RUN_AS branch now calls the shared
  helper — behaviour-preserving (identical env/args/cwd); the RUN_AS branch is
  untouched. backoff.test.ts pins the parity constant VALUES against relay.go and
  the whole curve. gateway-plane + relay-loopback stay green.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — `ConnectorSessionManager` (`session.ts`) + `session.test.ts` (TDD: RED → GREEN)

Port `gateway-go/session/session.go`'s Manager over the shared `openTmuxSession`
primitive: one tmux client per session, fanned out to every attached channel,
with resize-authority + scrollback replay + exit-broadcast semantics, and the
**initial-grid clamp before spawn** (the Go-parity case a raw pass-through
fails). A fake `TmuxSession` drives it — no real tmux.

### Step 1 — Write the failing suite (RED)

- [ ] **`cli/src/connector/session.test.ts`** (create it — network-free, fake pty):
  ```ts
  // ConnectorSessionManager (port of session/session.go's Manager) over a fake
  // TmuxSession: one pty for two attaches; attached carries the SESSION size not
  // the newcomer's; scrollback replay on a late attach; output fan-out; resize
  // authority + dedup + fan-out; input gated on attachment; the initial-grid
  // clamp (10x3 → 20x5); exit broadcast + delete; detachAll drops viewers but
  // leaves the pty. Mirrors gateway-go/session/session_test.go.
  // Run with: bun src/connector/session.test.ts
  import assert from 'node:assert/strict'
  import type { TmuxSession } from '@ensembleworks/contracts/session-manager'
  import { ConnectorSessionManager, type ChannelSink } from './session.ts'

  // A fake TmuxSession mirroring openTmuxSession's clamp/dedup resize contract.
  const COLS_MIN = 20, COLS_MAX = 500, ROWS_MIN = 5, ROWS_MAX = 200
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
  interface Fake extends TmuxSession {
  	writes: string[]
  	emitData(s: string): void
  	emitExit(): void
  	killed: boolean
  }
  function makeFake(cols: number, rows: number): Fake {
  	let dataCb: ((d: string) => void) | null = null
  	let exitCb: (() => void) | null = null
  	let curCols = cols
  	let curRows = rows
  	const f: Fake = {
  		writes: [],
  		killed: false,
  		onData: (cb) => { dataCb = cb },
  		onExit: (cb) => { exitCb = cb },
  		write: (d) => { f.writes.push(d) },
  		kill: () => { f.killed = true },
  		resize(c, r) {
  			if (!Number.isInteger(c) || !Number.isInteger(r)) return false
  			const nc = clamp(c, COLS_MIN, COLS_MAX)
  			const nr = clamp(r, ROWS_MIN, ROWS_MAX)
  			if (nc === curCols && nr === curRows) return false
  			curCols = nc; curRows = nr
  			return true
  		},
  		get cols() { return curCols },
  		get rows() { return curRows },
  		emitData: (s) => dataCb?.(s),
  		emitExit: () => exitCb?.(),
  	}
  	return f
  }

  // A recording ChannelSink.
  function makeSink() {
  	const msgs: unknown[] = []
  	const out: Buffer[] = []
  	let closed = false
  	const sink: ChannelSink = {
  		sendMsg: (m) => msgs.push(m),
  		sendOutput: (p) => out.push(p),
  		close: () => { closed = true },
  	}
  	return { sink, msgs, out, isClosed: () => closed }
  }

  // Spawn factory records (id, cols, rows) and hands back a fake.
  function makeMgr() {
  	const spawns: Array<{ id: string; cols: number; rows: number; fake: Fake }> = []
  	const mgr = new ConnectorSessionManager((id, cols, rows) => {
  		const fake = makeFake(cols, rows)
  		spawns.push({ id, cols, rows, fake })
  		return fake
  	})
  	return { mgr, spawns }
  }

  // 1. get-or-create spawns ONE pty for two attaches; attached carries session size.
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	const b = makeSink()
  	assert.equal(mgr.attach('s', 1, 80, 24, a.sink), true)
  	assert.equal(mgr.attach('s', 2, 100, 40, b.sink), true) // newcomer wants 100x40…
  	assert.equal(spawns.length, 1, 'one pty for the session')
  	assert.deepEqual(a.msgs[0], { type: 'attached', cols: 80, rows: 24 })
  	assert.deepEqual(b.msgs[0], { type: 'attached', cols: 80, rows: 24 }, '…but attached carries the SESSION size')
  }

  // 2. scrollback replay on a late attach + live output fan-out.
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	mgr.attach('s', 1, 80, 24, a.sink)
  	spawns[0]!.fake.emitData('early')        // before b attaches
  	const b = makeSink()
  	mgr.attach('s', 2, 80, 24, b.sink)
  	assert.deepEqual(b.out.map((x) => x.toString()), ['early'], 'late attach replays scrollback')
  	spawns[0]!.fake.emitData('live')         // fan-out to both
  	assert.deepEqual(a.out.map((x) => x.toString()), ['early', 'live'])
  	assert.deepEqual(b.out.map((x) => x.toString()), ['early', 'live'])
  }

  // 3. resize authority + dedup + fan-out.
  {
  	const { mgr } = makeMgr()
  	const a = makeSink()
  	const b = makeSink()
  	mgr.attach('s', 1, 80, 24, a.sink)
  	mgr.attach('s', 2, 80, 24, b.sink)
  	a.msgs.length = 0; b.msgs.length = 0
  	mgr.resize('s', 120, 50)
  	assert.deepEqual(a.msgs, [{ type: 'resize', cols: 120, rows: 50 }])
  	assert.deepEqual(b.msgs, [{ type: 'resize', cols: 120, rows: 50 }])
  	a.msgs.length = 0; b.msgs.length = 0
  	mgr.resize('s', 120, 50) // unchanged → dedup: no fan-out
  	assert.deepEqual(a.msgs, [], 'no resize message when the grid is unchanged')
  }

  // 4. input gated on attachment.
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	mgr.attach('s', 1, 80, 24, a.sink)
  	mgr.input('s', 1, 'ls\r')
  	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'])
  	mgr.input('s', 99, 'nope')            // channel 99 not attached
  	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'], 'unattached channel cannot write')
  	mgr.detach('s', 1)
  	mgr.input('s', 1, 'after-detach')
  	assert.deepEqual(spawns[0]!.fake.writes, ['ls\r'], 'detached channel cannot write')
  }

  // 5. THE INITIAL-GRID CLAMP: attach 10x3 → spawn factory receives 20x5 and
  //    attached reports 20x5 (session.go's pre-spawn clamp; a raw pass-through
  //    would spawn/report 10x3 and diverge from Go).
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	mgr.attach('s', 1, 10, 3, a.sink)
  	assert.equal(spawns[0]!.cols, 20, 'cols clamped up to the minimum before spawn')
  	assert.equal(spawns[0]!.rows, 5, 'rows clamped up to the minimum before spawn')
  	assert.deepEqual(a.msgs[0], { type: 'attached', cols: 20, rows: 5 })
  }

  // 6. exit broadcasts {type:'exit'} + close + deletes the session (next attach
  //    spawns a fresh pty).
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	mgr.attach('s', 1, 80, 24, a.sink)
  	spawns[0]!.fake.emitExit()
  	assert.deepEqual(a.msgs.at(-1), { type: 'exit' })
  	assert.equal(a.isClosed(), true, 'exit closes the sink')
  	const b = makeSink()
  	mgr.attach('s', 2, 80, 24, b.sink)
  	assert.equal(spawns.length, 2, 'a post-exit attach spawns a new pty')
  }

  // 7. detachAll drops viewers but leaves the pty running (tmux survives).
  {
  	const { mgr, spawns } = makeMgr()
  	const a = makeSink()
  	mgr.attach('s', 1, 80, 24, a.sink)
  	mgr.detachAll()
  	assert.equal(a.isClosed(), true, 'detachAll closes viewers')
  	assert.equal(spawns[0]!.fake.killed, false, 'detachAll must NOT kill the pty')
  	mgr.input('s', 1, 'x')
  	assert.deepEqual(spawns[0]!.fake.writes, [], 'the viewer is gone, but the session/pty remains')
  }

  console.log('ok: session — one pty/two attaches, session-size attached, scrollback replay, fan-out, resize dedup, input gating, 10x3→20x5 clamp, exit broadcast+delete, detachAll keeps the pty')
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/session.test.ts)
  ```
  Expected: **fails** — `Cannot find module './session.ts'`.

### Step 2 — Write the module (GREEN)

- [ ] **`cli/src/connector/session.ts`** (create it — port of session.go's Manager):
  ```ts
  /**
   * ConnectorSessionManager — a faithful TypeScript port of
   * gateway-go/session/session.go's Manager over the shared openTmuxSession
   * primitive. One TmuxSession per canvas session, fanned out to every attached
   * relay channel, with the resize-authority + scrollback-replay + exit-broadcast
   * semantics of session.go (which itself mirrors terminal-gateway.ts).
   *
   * Go's three mutex-protected invariants (get-or-create spawns exactly one pty;
   * attach's attached→replay→subscribe is atomic; input/resize are serialized)
   * hold for free in single-threaded Bun: openTmuxSession is synchronous and the
   * onData read-loop callback plus the mux handlers all run to completion on one
   * event-loop turn, so replay can neither interleave with live output nor drop
   * bytes. The `gone` flag is a defensive mirror (onExit synchronously deletes the
   * session before any later attach), preserved for parity.
   *
   * Trust boundary: the connector deliberately does NOT re-validate sessionId from
   * relay frames — the splicer's ID_RE gate (gateway-registry.ts:184,
   * [a-zA-Z0-9_-]{1,48}) rejects any bad id before a relay-open can exist, and
   * tmux exec-array semantics with the fixed `canvas-` prefix leave no
   * flag-injection surface. This is parity with gateway-go.
   */
  import type { TermServerMessage } from '@ensembleworks/contracts'
  import { clampTmuxGrid, type TmuxSession } from '@ensembleworks/contracts/session-manager'

  const SCROLLBACK_LIMIT = 256 * 1024 // bytes replayed to a newly attached channel (session.go)

  /** One attached viewer (a relay channel). Down-messages are the inner terminal
   *  protocol (attached/resize/exit); output is raw pty bytes; close tears down. */
  export interface ChannelSink {
  	sendMsg(inner: TermServerMessage): void
  	sendOutput(payload: Buffer): void
  	close(): void
  }

  export type SpawnFactory = (sessionId: string, cols: number, rows: number) => TmuxSession

  interface SessionState {
  	pty: TmuxSession
  	ring: Buffer[]
  	ringBytes: number
  	channels: Map<number, ChannelSink>
  	gone: boolean
  }

  export class ConnectorSessionManager {
  	private sessions = new Map<string, SessionState>()
  	constructor(private readonly spawn: SpawnFactory) {}

  	private getOrCreate(id: string, cols: number, rows: number): SessionState {
  		const existing = this.sessions.get(id)
  		if (existing) return existing
  		const grid = clampTmuxGrid(cols, rows) // session.go getOrCreate clamps BEFORE spawn; attached reports the clamped grid
  		const pty = this.spawn(id, grid.cols, grid.rows) // canvasTmuxSpawnSpec inside; -A reattaches
  		const s: SessionState = { pty, ring: [], ringBytes: 0, channels: new Map(), gone: false }
  		pty.onData((data) => {
  			const buf = Buffer.from(data, 'utf8')
  			s.ring.push(buf)
  			s.ringBytes += buf.byteLength
  			while (s.ringBytes > SCROLLBACK_LIMIT && s.ring.length > 1) s.ringBytes -= s.ring.shift()!.byteLength
  			for (const sink of s.channels.values()) sink.sendOutput(buf)
  		})
  		pty.onExit(() => {
  			s.gone = true
  			for (const sink of s.channels.values()) {
  				sink.sendMsg({ type: 'exit' })
  				sink.close()
  			}
  			s.channels.clear()
  			if (this.sessions.get(id) === s) this.sessions.delete(id)
  		})
  		this.sessions.set(id, s)
  		return s
  	}

  	/** attached carries the SESSION's size (a newcomer's grid must not resize
  	 *  existing viewers), then the scrollback ring, then subscribe. */
  	attach(id: string, channelId: number, cols: number, rows: number, sink: ChannelSink): boolean {
  		const s = this.getOrCreate(id, cols, rows)
  		if (s.gone) return false
  		sink.sendMsg({ type: 'attached', cols: s.pty.cols, rows: s.pty.rows })
  		for (const chunk of s.ring) sink.sendOutput(chunk)
  		s.channels.set(channelId, sink)
  		return true
  	}

  	input(id: string, channelId: number, data: string): void {
  		const s = this.sessions.get(id)
  		if (s && !s.gone && s.channels.has(channelId)) s.pty.write(data)
  	}

  	/** Session-authoritative resize: TmuxSession.resize clamps+dedups and returns
  	 *  whether the grid changed; only then fan out the new size to every viewer. */
  	resize(id: string, cols: number, rows: number): void {
  		const s = this.sessions.get(id)
  		if (!s || s.gone) return
  		if (!s.pty.resize(cols, rows)) return
  		for (const sink of s.channels.values()) sink.sendMsg({ type: 'resize', cols: s.pty.cols, rows: s.pty.rows })
  	}

  	detach(id: string, channelId: number): void {
  		this.sessions.get(id)?.channels.delete(channelId)
  	}

  	/** Relay disconnect: drop every viewer, keep the ptys — tmux sessions must
  	 *  survive connector↔canvas link failures (session.go DetachAll). On process
  	 *  exit the ptys (tmux CLIENTS) get SIGHUP and detach; the tmux server keeps
  	 *  the sessions alive for the next connect (-A reattaches). */
  	detachAll(): void {
  		for (const s of this.sessions.values()) {
  			for (const sink of s.channels.values()) sink.close()
  			s.channels.clear()
  		}
  	}
  }
  ```

### Step 3 — GREEN gate + commit

- [ ] **Run + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/session.test.ts)
  bun run typecheck
  ```
  Expected: prints `ok: session — …`; typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/connector/session.ts cli/src/connector/session.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): ConnectorSessionManager — port of gateway-go session/session.go (slice #5)

  connector/session.ts: one TmuxSession per canvas session over the shared
  openTmuxSession, fanned out to every attached relay channel — attached carries
  the SESSION grid (not the newcomer's), scrollback replays before subscribe,
  resize is session-authoritative with clamp+dedup+fan-out, input is channel-gated,
  exit broadcasts {type:'exit'}+close+delete, and detachAll drops viewers but
  leaves the ptys so tmux survives link failures. The initial grid is clamped via
  clampTmuxGrid BEFORE spawn (session.go lines 82–87 parity). A fake-pty suite
  pins every branch incl. the 10x3→20x5 clamp case.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — `frame.ts` + `RelayMux` (`mux.ts`) + `mux.test.ts` (TDD: RED → GREEN)

Port `relay.go`'s `serveOnce`/`runChannel`: parse each canvas→connector text
frame, run a per-channel FIFO `ChannelQueue` (depth 64, sheds rather than
blocks), and dispatch into the session manager. The per-channel sink writes back
over the shared WS with byte-identical binary framing.

### Step 1 — Write the failing suite (RED)

- [ ] **`cli/src/connector/mux.test.ts`** (create it — network-free, fake WS +
  fake manager; drives `ChannelQueue` directly for the shed cases):
  ```ts
  // RelayMux (port of relay.go serveOnce/runChannel) over a fake WS + fake
  // manager: relay-open→attach with an attached reply; per-channel FIFO ordering
  // (open before a same-turn resize); the shed DATA STRUCTURE under forced
  // reentrancy (depth-64 cap + shed-on-full + shed-close) — unreachable in the
  // real synchronous-drain path (spec §6.2), so driven directly; input/resize
  // dispatch; attach failure → relay-closed; binary + non-JSON ignored; output
  // framing via the 4-byte BE encodeBinaryFrame prefix.
  // Run with: bun src/connector/mux.test.ts
  import assert from 'node:assert/strict'
  import { encodeBinaryFrame } from './frame.ts'
  import { ChannelQueue, RelayMux, type WsLike } from './mux.ts'
  import type { ChannelSink, ConnectorSessionManager } from './session.ts'

  // Fake WS: record every send with its binary flag.
  function makeWs() {
  	const sent: Array<{ data: string | Buffer; binary: boolean }> = []
  	const ws: WsLike = { send: (data, opts) => sent.push({ data, binary: opts?.binary === true }) }
  	return { ws, sent }
  }
  const texts = (sent: Array<{ data: string | Buffer; binary: boolean }>) =>
  	sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)))

  // Fake manager: records calls; attach can be steered to succeed/fail and can
  // simulate the session manager pushing down an attached message + one output.
  function makeMgr(opts: { attachOk?: boolean } = {}) {
  	const calls: string[] = []
  	const mgr = {
  		attach(id: string, ch: number, cols: number, rows: number, sink: ChannelSink): boolean {
  			calls.push(`attach ${id} ${ch} ${cols}x${rows}`)
  			if (opts.attachOk === false) return false
  			sink.sendMsg({ type: 'attached', cols, rows })
  			sink.sendOutput(Buffer.from('X'))
  			return true
  		},
  		input(id: string, ch: number, data: string) { calls.push(`input ${id} ${ch} ${data}`) },
  		resize(id: string, cols: number, rows: number) { calls.push(`resize ${id} ${cols}x${rows}`) },
  		detach(id: string, ch: number) { calls.push(`detach ${id} ${ch}`) },
  	} as unknown as ConnectorSessionManager
  	return { mgr, calls }
  }

  // 1. relay-open → attach + attached reply + binary output frame.
  {
  	const { ws, sent } = makeWs()
  	const { mgr, calls } = makeMgr()
  	const mux = new RelayMux(ws, mgr)
  	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 7, sessionId: 's', cols: 80, rows: 24 }), false)
  	assert.deepEqual(calls, ['attach s 7 80x24'])
  	const t = texts(sent)
  	assert.deepEqual(t[0], { type: 'relay-msg', channelId: 7, msg: { type: 'attached', cols: 80, rows: 24 } })
  	const bin = sent.find((s) => s.binary)!
  	assert.deepEqual(bin.data, encodeBinaryFrame(7, Buffer.from('X')), 'output uses the 4-byte BE frame')
  	assert.equal((bin.data as Buffer).readUInt32BE(0), 7, 'channel id in the BE prefix')
  }

  // 2. per-channel FIFO ordering: open, then a same-turn resize → attach BEFORE resize.
  {
  	const { ws } = makeWs()
  	const { mgr, calls } = makeMgr()
  	const mux = new RelayMux(ws, mgr)
  	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 1, sessionId: 's', cols: 80, rows: 24 }), false)
  	mux.handle(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'resize', cols: 120, rows: 50 } }), false)
  	assert.deepEqual(calls, ['attach s 1 80x24', 'resize s 120x50'])
  }

  // 3. input/resize dispatch through relay-msg.
  {
  	const { ws } = makeWs()
  	const { mgr, calls } = makeMgr()
  	const mux = new RelayMux(ws, mgr)
  	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 1, sessionId: 's', cols: 80, rows: 24 }), false)
  	mux.handle(JSON.stringify({ type: 'relay-msg', channelId: 1, msg: { type: 'input', data: 'hi' } }), false)
  	mux.handle(JSON.stringify({ type: 'relay-close', channelId: 1 }), false)
  	assert.deepEqual(calls, ['attach s 1 80x24', 'input s 1 hi', 'detach s 1'])
  }

  // 4. attach failure → relay-closed; binary + non-JSON ignored.
  {
  	const { ws, sent } = makeWs()
  	const { mgr } = makeMgr({ attachOk: false })
  	const mux = new RelayMux(ws, mgr)
  	mux.handle(JSON.stringify({ type: 'relay-open', channelId: 3, sessionId: 's', cols: 80, rows: 24 }), false)
  	assert.deepEqual(texts(sent).at(-1), { type: 'relay-closed', channelId: 3 })
  	const before = sent.length
  	mux.handle(Buffer.from([0, 0, 0, 1]), true) // binary → ignored
  	mux.handle('not json', false)               // non-JSON → ignored
  	assert.equal(sent.length, before, 'binary + non-JSON frames produce no output')
  }

  // 5. THE SHED DATA STRUCTURE (guard rail; unreachable in real dispatch — §6.2).
  //    Force reentrancy so the synchronous drain cannot empty the queue, fill it
  //    to 64, and assert the 65th enqueue sheds; then shed-close clears it.
  {
  	const results: boolean[] = []
  	let filled = false
  	const q = new ChannelQueue(() => {
  		if (filled) return
  		filled = true
  		// Re-enter from inside onItem while drain holds `draining` true: pushes
  		// accumulate instead of pumping, so the depth cap becomes observable.
  		for (let i = 0; i < 100; i++) results.push(q.enqueue({ type: 'relay-msg', channelId: 1 }))
  	})
  	q.enqueue({ type: 'relay-open', channelId: 1 })
  	assert.equal(results.slice(0, 64).every(Boolean), true, 'the first 64 enqueue')
  	assert.equal(results[64], false, 'the 65th sheds (depth-64 cap)')
  	assert.equal(results.filter((r) => !r).length, 100 - 64, 'everything past 64 sheds')
  	// shed-close: after close(), the queue is inert (drops further work) — this is
  	// what unblocks a queue nothing will drain when a relay-close is shed.
  	assert.equal(q.enqueue({ type: 'relay-close', channelId: 1 }), false, 'closed queue sheds')
  }

  console.log('ok: mux — open→attach+attached, BE output framing, FIFO ordering, input/resize/close dispatch, attach-fail→relay-closed, binary/non-JSON ignored, depth-64 shed + shed-close')
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/mux.test.ts)
  ```
  Expected: **fails** — `Cannot find module './frame.ts'` / `'./mux.ts'`.

### Step 2 — Write the two modules (GREEN)

- [ ] **`cli/src/connector/frame.ts`** (create it):
  ```ts
  /**
   * Byte-identical mirror of server/src/gateway-registry.ts's encodeBinaryFrame:
   * a 4-byte big-endian uint32 channelId prefix + the raw payload. Duplicated
   * (not imported) to keep the connector out of the server workspace; a later
   * slice may lift both copies into contracts (spec R3). Pinned on this side by
   * mux.test.ts, on the server side by gateway-registry.test.ts.
   */
  export function encodeBinaryFrame(channelId: number, payload: Buffer): Buffer {
  	const prefix = Buffer.allocUnsafe(4)
  	prefix.writeUInt32BE(channelId >>> 0, 0)
  	return Buffer.concat([prefix, payload])
  }
  ```

- [ ] **`cli/src/connector/mux.ts`** (create it — port of serveOnce/runChannel):
  ```ts
  /**
   * RelayMux — a port of gateway-go/relay/relay.go's serveOnce/runChannel. Parses
   * each canvas→connector text frame, runs a per-channel FIFO ChannelQueue (depth
   * RELAY_CHANNEL_QUEUE_DEPTH, sheds rather than blocks), and dispatches into the
   * session manager; the per-channel sink writes back over the shared WS.
   *
   * Shed honesty (spec §6.2): in Go the shed branch is genuinely reachable (a slow
   * runChannel goroutine + a bursting read loop fill the 64-deep channel). In
   * single-threaded Bun ChannelQueue drains synchronously inside enqueue(), so the
   * real dispatch path never holds more than the item being pumped — the depth-64
   * shed is behaviourally unreachable except under reentrancy. The connector thus
   * has STRONGER liveness than Go (nothing can block the read loop) while keeping
   * the charter-pinned mechanism + cap as a guard rail (load-bearing again the day
   * dispatch goes async). mux.test.ts validates the structure, not a hot path.
   */
  import { RELAY_CHANNEL_QUEUE_DEPTH } from '@ensembleworks/contracts/relay-parity'
  import { encodeBinaryFrame } from './frame.ts'
  import type { ChannelSink, ConnectorSessionManager } from './session.ts'

  /** The minimal shared-WS surface the mux writes to (ws.WebSocket satisfies it). */
  export interface WsLike {
  	send(data: string | Buffer, opts?: { binary?: boolean }): void
  }

  interface Control {
  	type: string
  	channelId: number
  	sessionId?: string
  	cols?: number
  	rows?: number
  	msg?: unknown
  }

  /** A per-channel FIFO with a hard depth cap. enqueue() returns false (sheds)
   *  when full — the shared read loop must never block on one slow channel
   *  (relay.go's `default:` on the 64-deep channel). */
  export class ChannelQueue {
  	private items: Control[] = []
  	private draining = false
  	private closed = false
  	constructor(private readonly onItem: (c: Control) => void, private readonly max = RELAY_CHANNEL_QUEUE_DEPTH) {}
  	enqueue(c: Control): boolean {
  		if (this.closed || this.items.length >= this.max) return false
  		this.items.push(c)
  		this.drain()
  		return true
  	}
  	private drain(): void {
  		if (this.draining) return
  		this.draining = true
  		while (this.items.length) this.onItem(this.items.shift()!)
  		this.draining = false
  	}
  	close(): void {
  		this.closed = true
  		this.items = []
  	}
  }

  export class RelayMux {
  	private workers = new Map<number, ChannelQueue>()
  	constructor(private readonly ws: WsLike, private readonly mgr: ConnectorSessionManager) {}

  	/** A canvas→connector frame. Binary frames are ignored (canvas→connector is
  	 *  all text); non-JSON is ignored — both mirror serveOnce. */
  	handle(data: Buffer | string, isBinary: boolean): void {
  		if (isBinary) return
  		let ctl: Control
  		try {
  			ctl = JSON.parse(typeof data === 'string' ? data : data.toString())
  		} catch {
  			return
  		}
  		switch (ctl.type) {
  			case 'relay-open': {
  				const q = new ChannelQueue((c) => this.run(ctl.sessionId!, ctl.channelId, c))
  				this.workers.set(ctl.channelId, q)
  				q.enqueue(ctl) // the open action is the queue's first item
  				return
  			}
  			case 'relay-msg':
  			case 'relay-close': {
  				const q = this.workers.get(ctl.channelId)
  				if (!q) return
  				const sent = q.enqueue(ctl)
  				if (ctl.type === 'relay-close') {
  					this.workers.delete(ctl.channelId)
  					if (!sent) q.close() // shed close: unblock a queue nothing will drain (relay.go 213–220)
  				}
  				return
  			}
  		}
  	}

  	private sink(channelId: number): ChannelSink {
  		return {
  			sendMsg: (inner) => this.ws.send(JSON.stringify({ type: 'relay-msg', channelId, msg: inner })),
  			sendOutput: (payload) => this.ws.send(encodeBinaryFrame(channelId, payload), { binary: true }),
  			close: () => this.ws.send(JSON.stringify({ type: 'relay-closed', channelId })),
  		}
  	}

  	private run(sessionId: string, channelId: number, c: Control): void {
  		switch (c.type) {
  			case 'relay-open': {
  				const sink = this.sink(channelId)
  				if (!this.mgr.attach(sessionId, channelId, c.cols ?? 80, c.rows ?? 24, sink)) {
  					this.ws.send(JSON.stringify({ type: 'relay-closed', channelId })) // attach failed
  				}
  				return
  			}
  			case 'relay-msg': {
  				const inner = c.msg as { type?: string; data?: string; cols?: number; rows?: number }
  				if (inner?.type === 'input') this.mgr.input(sessionId, channelId, inner.data ?? '')
  				else if (inner?.type === 'resize') this.mgr.resize(sessionId, inner.cols ?? 0, inner.rows ?? 0)
  				return
  			}
  			case 'relay-close':
  				this.mgr.detach(sessionId, channelId)
  				return
  		}
  	}
  }
  ```

### Step 3 — GREEN gate + commit

- [ ] **Run + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/mux.test.ts)
  bun run typecheck
  ```
  Expected: prints `ok: mux — …`; typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/connector/frame.ts cli/src/connector/mux.ts cli/src/connector/mux.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): RelayMux + binary framing — port of gateway-go relay serveOnce/runChannel (slice #5)

  connector/frame.ts: byte-identical mirror of gateway-registry.ts's
  encodeBinaryFrame (4-byte BE channelId prefix). connector/mux.ts: RelayMux parses
  canvas→connector control frames, runs a per-channel FIFO ChannelQueue (depth 64,
  shed-on-full + shed-close), and dispatches attach/input/resize/detach into the
  session manager; the per-channel sink writes attached/resize/exit as relay-msg,
  output as binary frames, teardown as relay-closed. Binary + non-JSON frames are
  ignored. The shed is a guard rail (Bun's synchronous drain never blocks the read
  loop); mux.test.ts drives ChannelQueue under forced reentrancy to pin the cap.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — `relay-client.ts` — the transport (port of `Run`/`serveOnce`) + `reconnect.test.ts` (TDD: RED → GREEN)

Dial with CF-Access headers + the 1 MiB `maxPayload`; serve one connection;
reconnect with the parity backoff + healthy-duration reset; a 20 s ping
heartbeat forces a redial on a half-open link. Timers and rng are injected so
the whole loop runs on a fake clock with no wall-clock flakiness. This task adds
the `ws` dependency.

### Step 1 — Add `ws` + write the failing suite (RED)

- [ ] **Add `ws` (runtime) + `@types/ws` (dev) to `cli`:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun add ws && bun add -d @types/ws)
  bun install
  ```
  Expected: `cli/package.json` gains a `ws` dependency + `@types/ws`
  devDependency; `bun install` exits 0. (`ws` is pure JS — its optional native
  `bufferutil`/`utf-8-validate` addons are absent — so it will compile under
  #7's `bun build --compile`; flagged there, spec R2.)

- [ ] **`cli/src/connector/reconnect.test.ts`** (create it — network-free, fake
  clock + fake WS, no real dial):
  ```ts
  // relay-client transport (port of relay.go Run/serveOnce) on a fake clock +
  // fake WS: the dial config (headers incl. the CF-Access pair vs none, plus the
  // 1 MiB maxPayload) is passed to the WS ctor; a missed pong at 20s forces
  // serveOnce to resolve (redial); runTransport backs off by computeBackoff
  // between attempts, resets the counter after a >30s healthy connection, and an
  // abort ends the loop promptly with no dangling timer.
  // Run with: bun src/connector/reconnect.test.ts
  import assert from 'node:assert/strict'
  import {
  	computeBackoff,
  	RELAY_PING_INTERVAL_MS,
  	RELAY_READ_LIMIT_BYTES,
  } from '@ensembleworks/contracts/relay-parity'
  import { runTransport, serveOnce, type Timers, type TransportDeps } from './relay-client.ts'

  // A controllable clock: records the last scheduled timeout, fires timeouts on
  // demand, and advances interval ticks. Injected only into relay-client; the
  // test's own awaits use real microtasks (flush()).
  class FakeClock implements Timers {
  	private t = 0
  	private timeouts = new Map<number, { fn: () => void; at: number }>()
  	private intervals = new Map<number, { fn: () => void; every: number; next: number }>()
  	private seq = 1
  	lastTimeoutMs = -1
  	now() { return this.t }
  	setTimeout(fn: () => void, ms: number) {
  		const h = this.seq++
  		this.timeouts.set(h, { fn, at: this.t + ms })
  		this.lastTimeoutMs = ms
  		return h as unknown as ReturnType<typeof setTimeout>
  	}
  	clearTimeout(h: ReturnType<typeof setTimeout>) { this.timeouts.delete(h as unknown as number) }
  	setInterval(fn: () => void, ms: number) {
  		const h = this.seq++
  		this.intervals.set(h, { fn, every: ms, next: this.t + ms })
  		return h as unknown as ReturnType<typeof setInterval>
  	}
  	clearInterval(h: ReturnType<typeof setInterval>) { this.intervals.delete(h as unknown as number) }
  	/** Fire the single pending backoff timeout (the loop has at most one). */
  	fireTimeout() {
  		const [h, entry] = [...this.timeouts.entries()][0] ?? []
  		if (!entry || h === undefined) throw new Error('no pending timeout')
  		this.timeouts.delete(h)
  		this.t = entry.at
  		entry.fn()
  	}
  	/** Advance `ms`, firing every interval tick that comes due. */
  	advance(ms: number) {
  		const target = this.t + ms
  		while (true) {
  			let next: { fn: () => void; key: number; at: number } | null = null
  			for (const [k, v] of this.intervals) if (v.next <= target && (!next || v.next < next.at)) next = { fn: v.fn, key: k, at: v.next }
  			if (!next) break
  			this.t = next.at
  			const iv = this.intervals.get(next.key)!
  			iv.next += iv.every
  			next.fn()
  		}
  		this.t = target
  	}
  	pendingTimeouts() { return this.timeouts.size }
  }

  // Fake WS: captures ctor args, exposes emit() + ping/terminate counters.
  class FakeWs {
  	static all: FakeWs[] = []
  	url: string
  	opts: { headers: Record<string, string>; maxPayload: number }
  	pings = 0
  	terminated = false
  	private handlers = new Map<string, (...a: unknown[]) => void>()
  	constructor(url: string, opts: FakeWs['opts']) {
  		this.url = url
  		this.opts = opts
  		FakeWs.all.push(this)
  	}
  	on(ev: string, fn: (...a: unknown[]) => void) { this.handlers.set(ev, fn) }
  	emit(ev: string, ...a: unknown[]) { this.handlers.get(ev)?.(...a) }
  	ping() { this.pings++ }
  	terminate() { this.terminated = true }
  	send() {}
  }
  const makeDeps = (clock: FakeClock): TransportDeps => ({
  	timers: clock,
  	rng: () => 0.5, // jitter factor 1.0 → computeBackoff returns the exact base
  	WebSocketCtor: FakeWs as unknown as TransportDeps['WebSocketCtor'],
  })
  const flush = () => new Promise((r) => setTimeout(r, 0)) // real microtask drain
  const stubMgr = { detachAll() {} } as unknown as Parameters<typeof serveOnce>[2]

  // 1. Dial config: the CF-Access pair + maxPayload reach the WS ctor; a none
  //    instance sends no auth headers.
  {
  	FakeWs.all = []
  	const clock = new FakeClock()
  	const headers = { 'CF-Access-Client-Id': 'i', 'CF-Access-Client-Secret': 's' }
  	const ac = new AbortController()
  	const p = serveOnce('wss://h/api/terminal/connect', headers, stubMgr, makeDeps(clock), ac.signal)
  	await flush()
  	assert.equal(FakeWs.all[0]!.url, 'wss://h/api/terminal/connect')
  	assert.deepEqual(FakeWs.all[0]!.opts.headers, headers, 'CF-Access pair on the dial')
  	assert.equal(FakeWs.all[0]!.opts.maxPayload, RELAY_READ_LIMIT_BYTES, '1 MiB read limit')
  	ac.abort()
  	await p
  }
  {
  	FakeWs.all = []
  	const clock = new FakeClock()
  	const ac = new AbortController()
  	const p = serveOnce('ws://h/api/terminal/connect', {}, stubMgr, makeDeps(clock), ac.signal)
  	await flush()
  	assert.deepEqual(FakeWs.all[0]!.opts.headers, {}, 'a none instance dials with no auth headers')
  	ac.abort()
  	await p
  }

  // 2. Missed pong → serveOnce resolves (forces a redial).
  {
  	FakeWs.all = []
  	const clock = new FakeClock()
  	const p = serveOnce('ws://h', {}, stubMgr, makeDeps(clock), new AbortController().signal)
  	await flush()
  	const ws = FakeWs.all[0]!
  	ws.emit('open')                       // starts the heartbeat interval
  	clock.advance(RELAY_PING_INTERVAL_MS) // 1st tick: alive → ping, alive=false
  	assert.equal(ws.pings, 1, 'a ping is sent on the first tick')
  	clock.advance(RELAY_PING_INTERVAL_MS) // 2nd tick: still !alive → done()
  	await p                               // resolves → the loop would redial
  	assert.equal(ws.terminated, true, 'the half-open socket is terminated')
  }

  // 3. The reconnect loop: backoff between attempts, then a healthy reset.
  {
  	FakeWs.all = []
  	const clock = new FakeClock()
  	const ac = new AbortController()
  	const loop = runTransport('ws://h', {}, stubMgr, makeDeps(clock), ac.signal)
  	await flush()
  	assert.equal(FakeWs.all.length, 1, 'first dial')
  	FakeWs.all[0]!.emit('close')          // connection 1 ends
  	await flush()
  	assert.equal(clock.lastTimeoutMs, computeBackoff(1, () => 0.5), 'attempt 1 → 1s')
  	clock.fireTimeout()
  	await flush()
  	assert.equal(FakeWs.all.length, 2, 'redial after the backoff')
  	FakeWs.all[1]!.emit('close')          // connection 2 ends
  	await flush()
  	assert.equal(clock.lastTimeoutMs, computeBackoff(2, () => 0.5), 'attempt 2 → 2s')
  	clock.fireTimeout()
  	await flush()
  	// connection 3 stays up longer than the healthy threshold, then drops → reset.
  	clock.advance(31_000)
  	FakeWs.all[2]!.emit('close')
  	await flush()
  	assert.equal(clock.lastTimeoutMs, computeBackoff(1, () => 0.5), 'a >30s healthy connection resets the counter to attempt 1')
  	// 4. abort ends the loop promptly with no dangling timer.
  	ac.abort()
  	await loop
  	assert.equal(clock.pendingTimeouts(), 0, 'abort clears the pending backoff timer')
  }

  console.log('ok: reconnect — dial config (CF-Access pair vs none + 1 MiB maxPayload), missed-pong redial, backoff curve between attempts, healthy-duration reset, prompt abort')
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/reconnect.test.ts)
  ```
  Expected: **fails** — `Cannot find module './relay-client.ts'`.

### Step 2 — Write the module (GREEN)

- [ ] **`cli/src/connector/relay-client.ts`** (create it — port of Run/serveOnce):
  ```ts
  /**
   * The connector transport — a port of gateway-go/relay/relay.go's Run/serveOnce.
   * Dial the single outbound WS to /api/terminal/connect with the CF-Access header
   * pair (service-token instances) + the 1 MiB maxPayload read limit; serve one
   * connection; reconnect with the parity backoff (computeBackoff + the >30s
   * healthy-duration reset); a 20s ping heartbeat forces a redial on a half-open
   * link. Timers + rng are injected so tests drive the whole loop on a fake clock.
   *
   * Half-open detection (spec §6.3): relay.go used conn.Ping returning an error;
   * the connector uses the server's own alive/pong idiom (gateway-registry.ts
   * lines 193–204) at the same 20s cadence — both send a WS ping every 20s and
   * force a redial when the peer stops answering, identical effect in the ws idiom.
   */
  import WebSocket from 'ws'
  import {
  	computeBackoff,
  	RELAY_HEALTHY_RESET_MS,
  	RELAY_PING_INTERVAL_MS,
  	RELAY_READ_LIMIT_BYTES,
  } from '@ensembleworks/contracts/relay-parity'
  import { RelayMux } from './mux.ts'
  import type { ConnectorSessionManager } from './session.ts'

  export interface Timers {
  	now(): number
  	setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  	clearTimeout(h: ReturnType<typeof setTimeout>): void
  	setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>
  	clearInterval(h: ReturnType<typeof setInterval>): void
  }
  export interface TransportDeps {
  	timers: Timers
  	rng: () => number
  	WebSocketCtor: typeof WebSocket
  }

  /** Dial once and serve until the socket closes/errors or the ping heartbeat
   *  forces a redial. Resolves when the connection ends; rejects only on dial
   *  failure (the reconnect loop treats both the same). */
  export function serveOnce(
  	wsUrl: string,
  	headers: Record<string, string>,
  	mgr: ConnectorSessionManager,
  	deps: TransportDeps,
  	signal: AbortSignal,
  ): Promise<void> {
  	return new Promise((resolve, reject) => {
  		const ws = new deps.WebSocketCtor(wsUrl, { headers, maxPayload: RELAY_READ_LIMIT_BYTES })
  		const mux = new RelayMux(ws, mgr)
  		let alive = true
  		let heartbeat: ReturnType<typeof setInterval> | undefined
  		let settled = false
  		const done = (err?: Error) => {
  			if (settled) return
  			settled = true
  			if (heartbeat) deps.timers.clearInterval(heartbeat)
  			try {
  				ws.terminate()
  			} catch {
  				/* already closed */
  			}
  			err ? reject(err) : resolve()
  		}
  		signal.addEventListener('abort', () => done(), { once: true })
  		ws.on('open', () => {
  			heartbeat = deps.timers.setInterval(() => {
  				if (!alive) {
  					done() // missed pong → half-open → redial
  					return
  				}
  				alive = false
  				ws.ping()
  			}, RELAY_PING_INTERVAL_MS)
  		})
  		ws.on('pong', () => {
  			alive = true
  		})
  		ws.on('message', (data: Buffer, isBinary: boolean) => mux.handle(data, isBinary))
  		ws.on('error', (err: Error) => done(err))
  		ws.on('close', () => done())
  	})
  }

  /** The reconnect loop: serve, drop viewers, back off (with the healthy-duration
   *  reset), redial — until aborted. tmux sessions survive every reconnect. */
  export async function runTransport(
  	wsUrl: string,
  	headers: Record<string, string>,
  	mgr: ConnectorSessionManager,
  	deps: TransportDeps,
  	signal: AbortSignal,
  ): Promise<void> {
  	let attempt = 0
  	while (!signal.aborted) {
  		const start = deps.timers.now()
  		try {
  			await serveOnce(wsUrl, headers, mgr, deps, signal)
  		} catch {
  			/* logged; reconnect */
  		}
  		mgr.detachAll()
  		if (signal.aborted) break
  		if (deps.timers.now() - start > RELAY_HEALTHY_RESET_MS) attempt = 0
  		attempt++
  		await new Promise<void>((r) => {
  			const h = deps.timers.setTimeout(r, computeBackoff(attempt, deps.rng))
  			signal.addEventListener(
  				'abort',
  				() => {
  					deps.timers.clearTimeout(h)
  					r()
  				},
  				{ once: true },
  			)
  		})
  	}
  }
  ```

  (Note the one defensive addition over the spec skeleton: a `settled` guard in
  `done()` so an `error` immediately followed by `close`, or an abort racing a
  socket event, resolves/rejects the promise exactly once. Behaviour is otherwise
  identical to §6.3.)

### Step 3 — GREEN gate + commit

- [ ] **Run + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/connector/reconnect.test.ts)
  bun run typecheck
  ```
  Expected: prints `ok: reconnect — …`; typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/connector/relay-client.ts cli/src/connector/reconnect.test.ts cli/package.json bun.lock
  git commit -m "$(cat <<'EOF'
  feat(cli): relay-client transport — port of gateway-go relay Run/serveOnce (slice #5)

  connector/relay-client.ts: dial /api/terminal/connect with the CF-Access header
  pair + the 1 MiB maxPayload read limit (via the `ws` package — added here for
  manual ping()/maxPayload/outbound-header parity Bun's global WebSocket lacks);
  serveOnce serves one connection with a 20s alive/pong heartbeat that forces a
  redial on a half-open link; runTransport reconnects with computeBackoff and the
  >30s healthy-duration counter reset, detaching viewers (tmux survives) each
  cycle, until aborted. Timers + rng are injected; reconnect.test.ts drives the
  whole loop on a fake clock — dial config, missed-pong redial, backoff curve,
  healthy reset, prompt abort.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — `index.ts` entry (`runConnector`) + the one-line #4 seam in `native/connect.ts`

Assemble the engine: `runConnector` builds the session manager with the
`canvasTmuxSpawnSpec` factory, installs the `SIGINT`/`SIGTERM`→abort handler
(mirroring `main.go`'s `signal.NotifyContext`), awaits `runTransport`, and
resolves `0`. Then flip the #4 slot's else-branch to call it. **No new suite** —
this wiring is pinned end-to-end by Task 6's booted e2e (Coverage note).

### Step 1 — Write the engine entry

- [ ] **`cli/src/connector/index.ts`** (create it):
  ```ts
  /**
   * runConnector — the engine the #4 `terminal connect` slot calls. Builds the
   * ConnectorSessionManager with the shared canvasTmuxSpawnSpec factory (reading
   * the tmux conf from ENSEMBLEWORKS_TMUX_CONF / TMUX_CONF — real-FS paths only,
   * never import.meta-relative, so #7's `bun build --compile` is a no-op, spec §8),
   * installs a one-shot SIGINT/SIGTERM handler that aborts an internal
   * AbortController (mirroring main.go's signal.NotifyContext), awaits the
   * reconnect transport, and resolves the process exit code (0 on clean signal).
   * All imports are static (compile-safe).
   */
  import WebSocket from 'ws'
  import { canvasTmuxSpawnSpec, openTmuxSession } from '@ensembleworks/contracts/session-manager'
  import type { ConnectConfig } from '../native/connect.ts'
  import { runTransport, type Timers } from './relay-client.ts'
  import { ConnectorSessionManager } from './session.ts'

  const realTimers: Timers = {
  	now: () => Date.now(),
  	setTimeout: (fn, ms) => setTimeout(fn, ms),
  	clearTimeout: (h) => clearTimeout(h),
  	setInterval: (fn, ms) => setInterval(fn, ms),
  	clearInterval: (h) => clearInterval(h),
  }

  /** The tmux conf path is env-driven (the clean-break story #8 wires): the `q`
   *  reload binding + `-f` gate read it. Undefined → the helper skips `-f` and the
   *  session silently degrades clipboard/status-bar (never crashes). */
  function tmuxConfPath(env: NodeJS.ProcessEnv): string | undefined {
  	return env.ENSEMBLEWORKS_TMUX_CONF ?? env.TMUX_CONF
  }

  export async function runConnector(
  	cfg: ConnectConfig,
  	headers: Record<string, string>,
  	env: NodeJS.ProcessEnv = process.env,
  ): Promise<number> {
  	const conf = tmuxConfPath(env)
  	const mgr = new ConnectorSessionManager((id, cols, rows) =>
  		openTmuxSession(canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: conf, home: env.HOME }), cols, rows),
  	)
  	const ac = new AbortController()
  	const onSignal = () => ac.abort()
  	process.once('SIGINT', onSignal)
  	process.once('SIGTERM', onSignal)
  	try {
  		await runTransport(cfg.wsUrl, headers, mgr, { timers: realTimers, rng: Math.random, WebSocketCtor: WebSocket }, ac.signal)
  	} finally {
  		process.off('SIGINT', onSignal)
  		process.off('SIGTERM', onSignal)
  	}
  	return 0
  }
  ```

### Step 2 — Flip the #4 seam (`cli/src/native/connect.ts`)

- [ ] **Add the two imports** — `runConnector`, and `authHeaders` (already
  exported from `resolve.ts`). Replace:
  ```ts
  import { type Conn, readEnv, resolveConn } from '../resolve.ts'
  ```
  with:
  ```ts
  import { authHeaders, type Conn, readEnv, resolveConn } from '../resolve.ts'
  import { runConnector } from '../connector/index.ts'
  ```

- [ ] **Replace the else-branch of `connectSlot`** (dispatch, flags, and
  `--dry-run` are untouched) — replace:
  ```ts
  	if (globals.dryRun) {
  		emitJson(cfg)
  		return 0
  	}
  	narrate('terminal connect: the connector engine ships in sub-project #5')
  	return 1
  ```
  with:
  ```ts
  	if (globals.dryRun) {
  		emitJson(cfg)
  		return 0
  	}
  	return runConnector(cfg, authHeaders(conn.auth), env) // conn + env already in scope
  ```
  (`conn` is resolved at the top of `connectSlot`; `env` is its parameter.
  `runConnector` returns `Promise<number>`, so `main.ts`'s existing
  `process.exit(await dispatch(...))` path is unchanged. If the `narrate` import
  becomes unused after this edit, drop it from the `output.ts` import to keep
  typecheck clean.)

### Step 3 — Gate (no new suite) + commit

- [ ] **Typecheck + re-run the three connector unit suites (no regression):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd cli && bun src/connector/session.test.ts && bun src/connector/mux.test.ts && bun src/connector/reconnect.test.ts)
  ```
  Expected: typecheck 0; all three print their `ok: …` lines. Coverage note: the
  entry + seam are pinned end-to-end by Task 6's `connector-loopback.test.ts`
  (which spawns `bun cli/src/main.ts terminal connect` and exercises this exact
  path). A `--dry-run` sanity check still works:
  `bun cli/src/main.ts terminal connect --url http://localhost:8788 --gateway-id x --dry-run`
  prints the resolved config and exits 0 (unchanged #4 behaviour).

- [ ] **Commit:**
  ```bash
  git add cli/src/connector/index.ts cli/src/native/connect.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): runConnector engine entry + wire the #4 terminal-connect seam (slice #5)

  connector/index.ts: runConnector builds the ConnectorSessionManager with the
  shared canvasTmuxSpawnSpec factory (env-driven tmux conf, real-FS paths —
  compile-safe), installs a one-shot SIGINT/SIGTERM→AbortController handler
  (main.go signal.NotifyContext parity), awaits runTransport, and resolves 0.
  native/connect.ts: the slot's else-branch now returns
  runConnector(cfg, authHeaders(conn.auth), env) — the one-line seam; dispatch,
  flags, and --dry-run are untouched. Pinned end-to-end by the Task 6 e2e.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — `server/src/connector-loopback.test.ts` (booted e2e) + full gate + build

The parity gate: drive the **real connector subprocess** through the splice
plane and reproduce `relay-loopback.test.ts`'s attached-handshake + echo +
second-viewer assertions. Then run the full suite + build. The existing
`relay-loopback.test.ts` stays as-is (it validates a different seam — the
splice-core via the test shim — and is not reparameterised).

### Step 1 — Write the booted e2e

- [ ] **`server/src/connector-loopback.test.ts`** (create it — boots
  `createSyncApp`, spawns the connector; **MUST end `process.exit(0)`**):
  ```ts
  // Booted parity gate (connector spec §7.5): relay-loopback.test.ts's assertions,
  // but driving the REAL Bun connector subprocess instead of the test shim. Boot
  // createSyncApp on an ephemeral port (the splice plane under test), spawn
  // `bun cli/src/main.ts terminal connect --url … --gateway-id loopback` (a none
  // instance, no auth), wait until GET /api/terminal/list shows the gateway, then
  // a browser WS at /api/terminal/relay asserts: attached handshake, echo
  // round-trip through the real tmux client, and a second viewer whose attached
  // carries the SESSION size (not its request) + replays scrollback.
  // Precondition: tmux on PATH. Run with: bun src/connector-loopback.test.ts
  import assert from 'node:assert/strict'
  import { execFile, spawn, type ChildProcess } from 'node:child_process'
  import { mkdtemp } from 'node:fs/promises'
  import type http from 'node:http'
  import os from 'node:os'
  import path from 'node:path'
  import { promisify } from 'node:util'
  import WebSocket from 'ws'
  import { createSyncApp } from './app.ts'

  const execFileP = promisify(execFile)
  const SESSION = `cbtest${Date.now().toString(36).slice(-4)}`
  const GATEWAY = 'loopback'

  const openSocket = (url: string) =>
  	new Promise<WebSocket>((resolve, reject) => {
  		const ws = new WebSocket(url)
  		ws.once('open', () => resolve(ws))
  		ws.once('error', reject)
  	})

  /** First non-binary (control) frame, parsed. */
  const firstText = (ws: WebSocket) =>
  	new Promise<any>((resolve) => {
  		const h = (data: Buffer, isBinary: boolean) => {
  			if (isBinary) return
  			ws.off('message', h)
  			resolve(JSON.parse(data.toString()))
  		}
  		ws.on('message', h)
  	})

  /** Collect binary output until `needle` appears. */
  function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 15_000): Promise<string> {
  	return new Promise((resolve, reject) => {
  		let acc = ''
  		const handler = (data: Buffer, isBinary: boolean) => {
  			if (!isBinary) return
  			acc += data.toString()
  			if (acc.includes(needle)) {
  				clearTimeout(timer)
  				ws.off('message', handler)
  				resolve(acc)
  			}
  		}
  		const timer = setTimeout(() => {
  			ws.off('message', handler)
  			reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${acc.slice(-500)}`))
  		}, timeoutMs)
  		ws.on('message', handler)
  	})
  }

  /** Poll GET /api/terminal/list until the connector has registered. */
  async function waitForGateway(httpBase: string, id: string, timeoutMs = 15_000): Promise<void> {
  	const deadline = Date.now() + timeoutMs
  	while (Date.now() < deadline) {
  		try {
  			const res = await fetch(`${httpBase}/api/terminal/list`)
  			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
  			if (body.gateways.some((g) => g.gatewayId === id)) return
  		} catch {
  			// server not ready / transient — retry
  		}
  		await new Promise((r) => setTimeout(r, 150))
  	}
  	throw new Error(`connector did not register gateway ${id} within ${timeoutMs}ms`)
  }

  async function main() {
  	let connector: ChildProcess | null = null
  	let server: http.Server | null = null

  	try {
  		// 1. Boot the sync app (the splice plane) on an ephemeral port.
  		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connector-loopback-test-'))
  		const { server: appServer } = createSyncApp({ dataDir })
  		server = appServer
  		await new Promise<void>((resolve) => server!.listen(0, resolve))
  		const port = (server.address() as { port: number }).port
  		const httpBase = `http://127.0.0.1:${port}`
  		const wsBase = `ws://127.0.0.1:${port}`

  		// 2. Spawn the REAL connector. Resolve cli/src/main.ts relative to THIS
  		// file (the runner launches suites from the repo root). --url is a global
  		// flag (extractGlobals scans all argv); --gateway-id feeds the slot. A none
  		// instance → no auth headers, matching the shim's anonymous connect.
  		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
  		connector = spawn('bun', [cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY], {
  			env: { ...process.env },
  			stdio: ['ignore', 'inherit', 'inherit'],
  		})
  		connector.once('exit', (code) => {
  			if (code && code !== 0) console.error(`[connector] exited early with code ${code}`)
  		})

  		// 3. Wait until connect-equals-register lands in the registry.
  		await waitForGateway(httpBase, GATEWAY)

  		// 4. Browser through the relay: attached handshake + echo round-trip.
  		const relayUrl = `${wsBase}/api/terminal/relay?session=${SESSION}&gateway=${GATEWAY}&cols=80&rows=24`
  		const b1 = await openSocket(relayUrl)
  		const attached = await firstText(b1)
  		assert.equal(attached.type, 'attached')
  		const echoed = waitForOutput(b1, 'connector-roundtrip-ok')
  		b1.send(JSON.stringify({ type: 'input', data: 'echo connector-roundtrip-ok\r' }))
  		await echoed

  		// 5. Second viewer: attached carries the SESSION size; replays scrollback.
  		const b2 = await openSocket(relayUrl.replace('cols=80', 'cols=999'))
  		const attached2 = await firstText(b2)
  		assert.equal(attached2.type, 'attached')
  		assert.equal(attached2.cols, 80, 'attached must carry session size, not the newcomer request')
  		await waitForOutput(b2, 'connector-roundtrip-ok') // scrollback replay
  		b1.close()
  		b2.close()

  		console.log('connector-loopback.test.ts: all assertions passed')
  		console.log('ok: connector-loopback — real Bun connector splice: attached handshake, echo round-trip, second-viewer session-size + scrollback replay')
  	} finally {
  		connector?.kill()
  		server?.close()
  		await execFileP('tmux', ['kill-session', '-t', `canvas-${SESSION}`]).catch(() => {})
  	}
  	process.exit(0)
  }

  main().catch((err) => {
  	console.error(err)
  	process.exit(1)
  })
  ```

- [ ] **Run it standalone (RED→GREEN in one shot — the engine is complete):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/connector-loopback.test.ts)
  ```
  Expected: prints `connector-loopback.test.ts: all assertions passed` then
  `ok: connector-loopback — …` and exits 0. If it fails, treat the failure as the
  RED signal and fix the implicated connector module — do **not** weaken an
  assertion (this is the parity gate: the same shape that passes against the Go
  connector's splice must pass against the Bun connector). Precondition: `tmux` on
  PATH.

### Step 2 — Full gate

- [ ] **Run the full suite + build + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  ```
  Expected: typecheck 0; `bun run test` ends **`all <N> suites passed`** where
  `<N>` is the prior count + 5 (52 → **57** if #5 is first after #4; 53 → **58**
  if #6 landed first — the five new suites are `connector/backoff`,
  `connector/session`, `connector/mux`, `connector/reconnect`, and
  `connector-loopback`); `bun run build` 0 (it builds client/server/transcriber —
  cli is deliberately not compiled here; #7 adds `--compile`).

### Step 3 — Manual smoke (optional; needs `tmux` + `bin/dev`)

- [ ] Against the local none-instance:
  ```bash
  bin/dev up
  bin/ensembleworks terminal connect --url http://localhost:8788 --gateway-id smoke-1 &
  bin/ensembleworks terminal list        # shows smoke-1
  ```
  Then open a canvas terminal bound to `smoke-1`, confirm keystrokes echo, open a
  second browser and confirm it mirrors the session, and kill + restart the
  connector — the live tmux session reattaches via `-A`.

### Step 4 — Commit

- [ ] **Commit the e2e (the gate itself is the verification):**
  ```bash
  git add server/src/connector-loopback.test.ts
  git commit -m "$(cat <<'EOF'
  test(server): connector-loopback e2e — the Bun connector parity gate (slice #5)

  connector-loopback.test.ts boots createSyncApp on an ephemeral port, spawns the
  REAL connector subprocess (bun cli/src/main.ts terminal connect --url … 
  --gateway-id loopback, a none instance), waits until GET /api/terminal/list shows
  the gateway, then drives a browser WS through the splice and reruns
  relay-loopback's assertions against the Bun connector: attached handshake, echo
  round-trip through the real tmux client, and a second viewer whose attached
  carries the SESSION size + replays scrollback. Ends process.exit(0). Full suite
  green.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all <N> suites passed` for the prior-count + 5 — and any deviation from the
verbatim blocks above, especially the `settled` guard in `serveOnce`, whether
`TMUX_BASE_ARGS`/`narrate` were removed as dead after their redirects, and any
`@ensembleworks/server` devDependency you had to add for the Task 6
cross-workspace `createSyncApp` import — if `bun run typecheck` cannot resolve
the server's transitive types from `server/`'s own suite it will not, but note it
if the e2e import path needs one.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every spec §-component maps to a task.**
  - §4 relay-parity contract (6+ constants + pure `computeBackoff`, subpath off
    the browser barrel) — Task 1, pinned by `backoff.test.ts` (constant VALUES +
    the whole curve).
  - §5 shared `canvasTmuxSpawnSpec` + the `terminal-gateway.ts` non-`RUN_AS`
    redirect (behaviour-preserving) — Task 1, guarded green by
    `gateway-plane.test.ts` + `relay-loopback.test.ts`.
  - §6.1 `ConnectorSessionManager` (port of session.go's Manager) + the
    `clampTmuxGrid` pre-spawn clamp — Task 1 (`clampTmuxGrid`) + Task 2
    (`session.ts`), pinned by `session.test.ts` incl. the 10×3→20×5 attach case.
  - §6.2 `RelayMux`/`ChannelQueue` + `frame.ts` (port of serveOnce/runChannel) —
    Task 3, pinned by `mux.test.ts` incl. the forced-reentrancy shed structure.
  - §6.3 `relay-client.ts` transport (dial/serveOnce/reconnect/ping, injected
    timers+rng, the `ws` client) — Task 4, pinned by `reconnect.test.ts`.
  - §3 the #4 seam (one-line else-branch) + `runConnector` entry + signal wiring —
    Task 5, pinned end-to-end by Task 6.
  - §6.4 the full frame table (every canvas↔connector action) + §7.5 the booted
    parity gate — Task 6 `connector-loopback.test.ts`.
  - §8 compile compatibility — static imports only across every module;
    `index.ts`/`session-manager.ts` read the tmux conf from env (real-FS, never
    `import.meta`-relative); `ws` is pure JS (flagged for #7, R2).
- **Parity constant VALUES audited against relay.go** (the specific self-review
  ask): base `1<<… * time.Second` → `RELAY_BACKOFF_BASE_MS 1000` (relay.go:122);
  30 s cap → `RELAY_BACKOFF_CAP_MS 30000` (:123–125); `min(attempt-1,5)` →
  `RELAY_BACKOFF_EXPONENT_CAP 5` (:122); `0.8 + 0.4*rand` → `RELAY_JITTER_MIN 0.8`
  / `RELAY_JITTER_MAX 1.2` (:126); `healthyDuration 30s` →
  `RELAY_HEALTHY_RESET_MS 30000` (:96); `pingInterval 20s` →
  `RELAY_PING_INTERVAL_MS 20000` (:137); `SetReadLimit(1<<20)` →
  `RELAY_READ_LIMIT_BYTES 1<<20` (:152); `make(chan …, 64)` →
  `RELAY_CHANNEL_QUEUE_DEPTH 64` (:201). All eight match; `backoff.test.ts`
  asserts each literal so drift fails the suite.
- **TDD ordering honoured.** Tasks 1–4 write the test first and show RED (module
  missing) before implementing to GREEN. Task 5 is the wiring seam (Coverage note
  → Task 6). Task 6 is the booted parity gate.
- **Booted/subprocess convention enforced.** Only `connector-loopback.test.ts`
  boots `createSyncApp` + spawns the connector; it ends `process.exit(0)`. The
  four connector unit suites are network-free (injected timers/rng, fake
  pty/socket) and need no exit.
- **Placeholder scan:** no "as per spec"/skeleton hand-waving — every module and
  test is complete verbatim code, and every gate names its command + expected
  `ok:` line. The one intentional addition over the spec skeleton (the `settled`
  guard in `serveOnce`) is called out inline with its rationale.
- **Type consistency across tasks.** `ChannelSink`/`SpawnFactory` live once in
  `session.ts` and are imported by `mux.ts`; `WsLike` lives in `mux.ts` and is
  satisfied by both the fake WS and the real `ws` socket; `Timers`/`TransportDeps`
  live in `relay-client.ts` and are consumed by `index.ts` + the reconnect test;
  `TmuxSession`/`SpawnSpec`/`clampTmuxGrid`/`canvasTmuxSpawnSpec`/`openTmuxSession`
  come from `@ensembleworks/contracts/session-manager`; the parity constants +
  `computeBackoff` from `@ensembleworks/contracts/relay-parity`; `TermServerMessage`
  from the barrel; `ConnectConfig` from `native/connect.ts`. `session.ts` imports
  only `clampTmuxGrid` + `type TmuxSession` (the unused `SpawnSpec`/`openTmuxSession`
  the spec skeleton listed are dropped — the injected factory owns the spawn), so
  no unused-import noise.
