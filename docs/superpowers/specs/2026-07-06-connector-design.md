# The native connector — `ensembleworks terminal connect` fills the #4 slot

**Phase 3, sub-project #5 — the native Bun connector.** One TypeScript engine,
run by the `ensembleworks terminal connect` slot that #4 already ships, that
**replaces `gateway-go/` byte-for-byte on the wire**: it dials the single
outbound WS to `/api/terminal/connect`, demuxes relay channels onto tmux
sessions, and reconnects with the exact jittered backoff / ping / read-limit /
shed-queue contract the Go connector implemented. Sessions are tmux, so they
survive the connector, the browser, and the canvas link — a restart reattaches
via `new-session -A`.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) §"#5 — Connector / #6 —
Transcriber" (env mapping, the pinned relay parity contract, the shared
`canvasTmuxSpawnSpec` helper, single-binary packaging) and user decision 1
(the connector ships in the cutover as its own reviewed slice). It consumes the
#4 seam verbatim (`2026-07-06-ensembleworks-cli-design.md` §10, D9): the
resolved `ConnectConfig` object is this engine's exact input, so #5 changes no
dispatch, flag, or `--dry-run` code. House style follows the CLI design doc.

The behaviour under replacement is `gateway-go/relay/relay.go`,
`session/session.go` (the Manager: getOrCreate/Attach/Input/Resize/Detach/
DetachAll/readLoop), `session/tmux.go`, `main.go`; the validation contract is
`server/src/relay-loopback.test.ts`; the shared primitive the engine reuses is
`@ensembleworks/contracts/session-manager` (`openTmuxSession` over `pty.ts`).

---

## 1. Scope boundary — what #5 is and is not

**#5 IS:**

- The **connector engine** under `cli/src/connector/`, behind the existing
  `terminal connect` slot. #4's `connectSlot` calls it in one place (§9); no
  other CLI code changes.
- A faithful TS port of `gateway-go`'s three planes: the **reconnect/ping
  transport** (relay.go `Run`/`serveOnce`), the **relay mux with per-channel
  FIFO shed-queues** (relay.go `serveOnce`/`runChannel`), and the
  **multi-viewer tmux session manager** (session/session.go) built over the
  shared `openTmuxSession` primitive.
- The **relay parity contract as code**: pinned constants + a pure
  `computeBackoff` in a new `@ensembleworks/contracts/relay-parity` module,
  enforced by the transport and exercised by injectable-timer/seeded-rng unit
  tests (§7) — no wall-clock flakiness.
- The **shared `canvasTmuxSpawnSpec` helper** added to
  `@ensembleworks/contracts/session-manager`, consumed by BOTH the connector's
  session manager AND `server/src/terminal-gateway.ts`'s non-`RUN_AS` branch
  (the one server-side edit in this slice — behaviour-preserving; §5).
- **Validation**: a new booted e2e (`server/src/connector-loopback.test.ts`)
  that drives the *real* connector subprocess through the splice plane and
  reproduces `relay-loopback.test.ts`'s attached-handshake + echo + second-viewer
  assertions, plus four network-free unit suites. Suite count **52 → 57**.

**#5 is NOT:**

- **Retiring `gateway-go/`, `connect.sh`, or the standalone termgw artifact.**
  Those are deleted at the **cutover (#8)** (charter #7/#8). The connector lands
  *alongside* the Go code on `unified-architecture-migration`; both build.
- **The devcontainer feature rewrite / single-binary packaging.** The feature
  that installs `ensembleworks` and runs `terminal connect` (retiring
  `connect.sh` + the standalone artifact) is #8; the `bun build --compile`
  target is #7. #5 runs dev-style under `bun cli/src/main.ts terminal connect`
  (the `bin/ensembleworks` wrapper #4 shipped) and owes only compile
  compatibility (static imports, real-FS paths — §8).
- **A splicer change.** `server/src/gateway-registry.ts` (the relay splice
  core, its `resolveGatewayOwner` binding, the 4 MB browser-buffer limit, the
  20 s splicer heartbeat) is done and untouched. #5 dials into it exactly as
  `gateway-go` did.
- **A `terminal-gateway.ts` fan-out refactor.** The server gateway keeps its own
  multi-viewer manager; the *only* line #5 touches there is its non-`RUN_AS`
  spawn-spec branch, redirected to the shared `canvasTmuxSpawnSpec` (§5). The
  `RUN_AS`/privilege-separation branch, scrollback, and WS wiring are unchanged.
- **Privilege separation in the connector.** `gateway-go` had no `TERM_RUN_AS`;
  the connector runs as its devcontainer user, spawning tmux directly. The
  sudo-launcher path stays a server-gateway concern.
- **New CLI flags, resolution, or gateway-id policy.** #4 pinned `--label`
  (default hostname), `--gateway-id` (default the stable per-box id), the
  resolution chain, and `--dry-run`. #5 *consumes* them; it decides no new UX.

---

## 2. Decisions settled in this spec

| # | Decision | § |
|---|---|---|
| D1 | Engine lives in `cli/src/connector/` (`index.ts` entry `runConnector`, `relay-client.ts` transport, `mux.ts` relay demux + shed-queues, `session.ts` multi-viewer tmux manager, `frame.ts` binary framing). #4's `connect.ts` slot calls `runConnector` in one place. | 3 |
| D2 | Relay parity contract = a new **`@ensembleworks/contracts/relay-parity`** module: the 6 pinned constants + a pure `computeBackoff(attempt, rng)`. Subpath-exported (pure, but off the browser barrel — connector plane). Enforced in `relay-client.ts`/`mux.ts`. | 4 |
| D3 | `canvasTmuxSpawnSpec` added to **`contracts/src/session-manager.ts`** (already the Bun-only subpath; needs `node:fs`). It reproduces `terminal-gateway.ts`'s direct-spawn behaviour (`canvas-` prefix, `new-session -A`, `-f` iff conf exists, `TERM`/`COLORFGBG`/`ENSEMBLEWORKS_TMUX_CONF`). `terminal-gateway.ts`'s non-`RUN_AS` branch is redirected to it (behaviour-preserving); `session/tmux.go`'s `tmuxPrefix` copy retires at #8. | 5 |
| D4 | The connector's session manager is a **port of `gateway-go/session/session.go`'s Manager** over `openTmuxSession` (the shared primitive). Go's per-session mutex collapses to "one synchronous event-loop turn" in single-threaded Bun; the `Sink` interface (attached/resize/exit + binary output + close) is preserved verbatim on the wire. The **initial grid is clamped in getOrCreate before spawn** (session.go lines 82–87) via a new `clampTmuxGrid` export from `contracts/session-manager` — `openTmuxSession` stores its construction size unclamped, so the caller must clamp. | 6.1 |
| D5 | WS client = the **`ws`** package (added to `cli` deps), matching the server: it supports outbound `headers` (CF-Access pair), `maxPayload` (the 1 MiB read limit), manual `ws.ping()`, and binary frames — Bun's global `WebSocket` does not expose manual ping. Half-open detection uses the server's `alive`/`pong` heartbeat idiom at the pinned 20 s cadence. | 6.3 |
| D6 | Auth: the engine receives `authHeaders(conn.auth)` from the slot (already exported from `resolve.ts`) and sends the `CF-Access-Client-Id`/`-Secret` pair on the dial for `service-token` instances, nothing for `none`. `--dry-run` still prints `authMethod` only — **never the secret** (#4 behaviour, preserved). | 6.3 |
| D7 | Tests: 4 network-free unit suites (`backoff`, `session`, `mux`, `reconnect`) with injectable timers + seeded rng + a fake pty/socket — no wall-clock, no real tmux; **plus** 1 booted e2e (`connector-loopback.test.ts` in `server/`) that spawns the real connector subprocess and reruns the relay-loopback assertions against it. **52 → 57.** | 7 |

---

## 3. Module layout & the #4 seam

```
cli/src/connector/
  index.ts          # runConnector(cfg, headers, deps): the engine the slot calls
  relay-client.ts   # dial + serveOnce + the reconnect loop + ping heartbeat (relay.go Run/serveOnce)
  mux.ts            # RelayMux: parse Control frames, per-channel ChannelQueue (64, shed), dispatch (relay.go serveOnce/runChannel)
  session.ts        # ConnectorSessionManager: multi-viewer tmux over openTmuxSession (session.go's Manager)
  frame.ts          # encodeBinaryFrame — byte-identical mirror of gateway-registry.ts (4-byte BE channelId prefix)
  backoff.test.ts session.test.ts mux.test.ts reconnect.test.ts

contracts/src/
  relay-parity.ts   # NEW subpath ./relay-parity — parity constants + computeBackoff
  session-manager.ts# + canvasTmuxSpawnSpec + clampTmuxGrid (existing Bun-only subpath)

server/src/
  terminal-gateway.ts       # one edit: non-RUN_AS branch → canvasTmuxSpawnSpec
  connector-loopback.test.ts# NEW booted e2e driving the real connector
```

`cli/package.json` gains `ws` (runtime) + `@types/ws` (dev). `contracts/package.json`
`exports` gains `"./relay-parity": "./src/relay-parity.ts"`. No runner change —
`scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob discovers the new suites.

**The #4 seam (`cli/src/native/connect.ts`).** #4's `connectSlot` today is:

```ts
if (globals.dryRun) { emitJson(cfg); return 0 }
narrate('terminal connect: the connector engine ships in sub-project #5')
return 1
```

#5's only change is the else branch (dispatch/flags/`--dry-run` untouched):

```ts
import { authHeaders } from '../resolve.ts'
import { runConnector } from '../connector/index.ts'
// …
if (globals.dryRun) { emitJson(cfg); return 0 }
return runConnector(cfg, authHeaders(conn.auth))   // conn is already in scope
```

`runConnector` returns a promise resolving to the process exit code (0 on clean
`SIGINT`/`SIGTERM`), so `main.ts`'s existing `process.exit(await dispatch(...))`
path is unchanged. Signal wiring: `runConnector` installs a one-shot
`SIGINT`/`SIGTERM` handler that aborts an internal `AbortController` (mirroring
`main.go`'s `signal.NotifyContext`), then resolves 0.

---

## 4. The relay parity contract as code (`contracts/src/relay-parity.ts`)

Every number here is lifted from `relay.go`; the charter pins them and this is
the single place they live. Pure (no `node:` imports); reached via the
`./relay-parity` subpath (kept off the browser barrel — it is connector-plane).

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

**Where each constant is enforced** (all in `cli/src/connector/`):

| Constant | Enforced in | Mirrors relay.go |
|---|---|---|
| `computeBackoff` (base/cap/exponent/jitter) | `relay-client.ts` reconnect loop | `Run` lines 121–126 |
| `RELAY_HEALTHY_RESET_MS` | `relay-client.ts` reconnect loop (reset `attempt` if `now-start >` this) | `Run` lines 117–120 |
| `RELAY_PING_INTERVAL_MS` | `relay-client.ts` ping heartbeat interval | `serveOnce` ping loop lines 162–177 |
| `RELAY_READ_LIMIT_BYTES` | `relay-client.ts` `new WebSocket(url, { maxPayload })` | `serveOnce` `SetReadLimit` line 152 |
| `RELAY_CHANNEL_QUEUE_DEPTH` | `mux.ts` `ChannelQueue` capacity + shed | `serveOnce` `make(chan …, 64)` + `default:` shed line 201/210 |

---

## 5. The shared spawn helper (`canvasTmuxSpawnSpec`)

Added to `contracts/src/session-manager.ts` (already Bun-only, already imports
`node:` — the browser barrel never reaches it). It is the single source of the
tmux spawn policy the charter demands both sides share, killing the "must match
`terminal-gateway.ts`" comment class (`tmux.go` line 10) and its Go copy of the
prefix. It reproduces `terminal-gateway.ts`'s **direct** (non-`RUN_AS`) branch
verbatim, parameterised by conf path + home:

```ts
import { existsSync } from 'node:fs'
import { TMUX_SESSION_PREFIX } from './constants.js'
// (SpawnSpec is already declared in this file)

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
 *  direct branch (charter §"#5"). */
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

**Server edit (the one line #5 changes in `server/src/terminal-gateway.ts`).**
Its `tmuxSpawnSpec(id)` keeps the `RUN_AS` branch untouched; the `else` (direct)
branch becomes:

```ts
return canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: TMUX_CONF, home: process.env.HOME })
```

This is behaviour-preserving: `TMUX_CONF` is always a resolved path string, so
`ENSEMBLEWORKS_TMUX_CONF` is always set and `-f` still gates on `existsSync` —
identical env, args, and cwd to today. The existing `terminal-gateway` suites
must stay green on the merge (charter: full suite green on the merged result).

**Connector consumption.** `session.ts`'s spawn factory is
`(id, cols, rows) => openTmuxSession(canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: TMUX_CONF, home: process.env.HOME }), cols, rows)`,
where the connector reads its conf path from `ENSEMBLEWORKS_TMUX_CONF` (or the
`TMUX_CONF` the devcontainer feature sets, defaulting to the feature's installed
conf) — the clean-break env story. The connector adopts the richer env
(`COLORFGBG`, conf-reload) that `gateway-go` lacked; this is a strict
enhancement for a new component, not a change to any preserved server behaviour.

---

## 6. The engine

### 6.1 `ConnectorSessionManager` (`session.ts`) — port of `session.go`'s Manager

One tmux client (a `TmuxSession` from `openTmuxSession`) per session, fanned out
to every attached relay channel, with the resize-authority + scrollback replay +
exit-broadcast semantics of `session.go` (which itself mirrors
`terminal-gateway.ts`). Go's three mutex-protected invariants
(get-or-create-spawns-one, atomic attach+replay+subscribe, serialized
input/resize) hold **for free** in single-threaded Bun: `openTmuxSession` is
synchronous and the `onData` read-loop callback plus the mux handlers all run to
completion on one event loop, so attach's replay-then-subscribe cannot interleave
with live output. The `gone` flag is kept as a defensive mirror but is effectively
unreachable (onExit synchronously deletes the session before any later attach).

**The initial grid is clamped before spawn.** `session.go`'s `getOrCreate`
(lines 82–87) clamps cols/rows into [20..500]/[5..200] *before* spawning and
stores the clamped size, so `attached` reports the clamped grid.
`openTmuxSession` does NOT do this for the caller — it stores its construction
size unclamped (its clamp lives only in `resize()`), and the splicer passes
browser-supplied cols/rows through (`Number(…)||80/24` in
`gateway-registry.ts`, so e.g. `cols=10&rows=3` survives). The connector
therefore clamps at the top of `getOrCreate`, using the bounds' one exported
home — a small addition to `contracts/src/session-manager.ts` built from the
same private `COLS_MIN`/`COLS_MAX`/`ROWS_MIN`/`ROWS_MAX` constants that back
`TmuxSession.resize`:

```ts
// contracts/src/session-manager.ts — the grid bounds get one exported home
// (same literals resize() already clamps with; no second copy anywhere):
export function clampTmuxGrid(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: clamp(cols, COLS_MIN, COLS_MAX), rows: clamp(rows, ROWS_MIN, ROWS_MAX) }
}
```

```ts
import type { TermServerMessage } from '@ensembleworks/contracts'
import { clampTmuxGrid, openTmuxSession, type SpawnSpec, type TmuxSession } from '@ensembleworks/contracts/session-manager'

const SCROLLBACK_LIMIT = 256 * 1024 // bytes replayed to a newly attached channel (session.go)

/** One attached viewer (a relay channel). Down-messages are the inner terminal
 *  protocol (attached/resize/exit); output is raw pty bytes; close tears down. */
export interface ChannelSink {
  sendMsg(inner: TermServerMessage): void
  sendOutput(payload: Buffer): void
  close(): void
}

type SpawnFactory = (sessionId: string, cols: number, rows: number) => TmuxSession

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
      for (const sink of s.channels.values()) { sink.sendMsg({ type: 'exit' }); sink.close() }
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
   *  survive connector↔canvas link failures (session.go DetachAll). */
  detachAll(): void {
    for (const s of this.sessions.values()) {
      for (const sink of s.channels.values()) sink.close()
      s.channels.clear()
    }
  }
}
```

Clamping thus happens in exactly two places, both fed from the one set of
bounds in `contracts/session-manager`: the initial grid via `clampTmuxGrid` in
`getOrCreate` (mirroring session.go's pre-spawn clamp — without it, a
`cols=10&rows=3` open would spawn tmux at 10×3 and report `attached` 10×3
where Go reports 20×5), and every later resize via `TmuxSession.resize`'s own
clamp+dedup. On connector shutdown the ptys are deliberately left running:
they are tmux *clients*; the process exit sends `SIGHUP`, the clients detach,
and the tmux server keeps the sessions alive for the next connect (`-A`
reattaches).

**Trust boundary.** The connector deliberately does NOT re-validate
`sessionId` from relay frames: trust rests on the authenticated server — the
splicer's `ID_RE` gate (`gateway-registry.ts` line 271) rejects any session id
outside `[a-zA-Z0-9_-]{1,48}` before a `relay-open` can exist — plus tmux
exec-array semantics with the fixed `canvas-` prefix (argv array, no shell, no
flag-injection surface). This is parity with `gateway-go`, which also trusted
the splicer's ids.

### 6.2 `RelayMux` (`mux.ts`) — port of `serveOnce`/`runChannel`

Parses each canvas→connector text frame, runs a per-channel FIFO `ChannelQueue`
(depth 64, sheds rather than blocks), and dispatches into the session manager.
The per-channel sink writes back over the shared WS.

```ts
import { RELAY_CHANNEL_QUEUE_DEPTH } from '@ensembleworks/contracts/relay-parity'
import { encodeBinaryFrame } from './frame.ts'
import type { ChannelSink, ConnectorSessionManager } from './session.ts'

interface Control { type: string; channelId: number; sessionId?: string; cols?: number; rows?: number; msg?: unknown }

/** A per-channel FIFO with a hard depth cap. enqueue() returns false (sheds)
 *  when full — the shared read loop must never block on one slow channel
 *  (relay.go's `default:` on the 64-deep channel). */
class ChannelQueue {
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
  close(): void { this.closed = true; this.items = [] }
}

export class RelayMux {
  private workers = new Map<number, ChannelQueue>()
  constructor(private readonly ws: WsLike, private readonly mgr: ConnectorSessionManager) {}

  /** A canvas→connector frame. Binary frames are ignored (canvas→connector is
   *  all text); non-JSON is ignored — both mirror serveOnce. */
  handle(data: Buffer | string, isBinary: boolean): void {
    if (isBinary) return
    let ctl: Control
    try { ctl = JSON.parse(typeof data === 'string' ? data : data.toString()) } catch { return }
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

**Shed-queue honesty — structural, not behavioural, parity.** In Go the shed
branch is genuinely reachable: a slow `runChannel` goroutine plus a bursting
read loop can fill the 64-deep channel, and `default:` sheds to keep the
shared read loop unblocked. In single-threaded Bun the `ChannelQueue` drains
synchronously inside `enqueue`, so in the real dispatch path the queue never
holds more than the item being pumped — the depth-64 shed branch is
behaviourally unreachable except under reentrancy (an `onItem` that re-enters
`enqueue`). The connector therefore has *stronger* liveness than Go (nothing
can ever block the read loop) while keeping the charter-pinned mechanism and
cap: the FIFO + `RELAY_CHANNEL_QUEUE_DEPTH` + shed-on-full + shed-close
semantics exist as a guard rail (and would become load-bearing if dispatch
ever went async), not as a hot path. §7.3's shed test validates the data
structure under forced reentrancy, not a production-reachable path.

`frame.ts` is the byte-identical mirror of `gateway-registry.ts`'s
`encodeBinaryFrame` (4-byte big-endian channel id + payload). It is duplicated
rather than imported to keep #5 from touching the server workspace; deduping
both copies into `contracts` is a clean-up a later slice can take (flagged, not
done — R3).

### 6.3 `relay-client.ts` — the transport (port of `Run`/`serveOnce`)

Dial with CF-Access headers + the 1 MiB `maxPayload`; serve one connection;
reconnect with the parity backoff; a 20 s ping heartbeat forces a redial on a
half-open link. Timers and rng are injected so tests drive the whole loop on a
fake clock.

```ts
import WebSocket from 'ws'
import {
  RELAY_HEALTHY_RESET_MS, RELAY_PING_INTERVAL_MS, RELAY_READ_LIMIT_BYTES, computeBackoff,
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
export interface TransportDeps { timers: Timers; rng: () => number; WebSocketCtor: typeof WebSocket }

/** Dial once and serve until the socket closes/errors or the ping heartbeat
 *  forces a redial. Resolves when the connection ends; rejects only on dial
 *  failure (the reconnect loop treats both the same). */
export function serveOnce(wsUrl: string, headers: Record<string, string>, mgr: ConnectorSessionManager, deps: TransportDeps, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new deps.WebSocketCtor(wsUrl, { headers, maxPayload: RELAY_READ_LIMIT_BYTES })
    const mux = new RelayMux(ws, mgr)
    let alive = true
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const done = (err?: Error) => {
      if (heartbeat) deps.timers.clearInterval(heartbeat)
      try { ws.terminate() } catch { /* already closed */ }
      err ? reject(err) : resolve()
    }
    signal.addEventListener('abort', () => done(), { once: true })
    ws.on('open', () => {
      heartbeat = deps.timers.setInterval(() => {
        if (!alive) { done(); return }        // missed pong → half-open → redial
        alive = false; ws.ping()
      }, RELAY_PING_INTERVAL_MS)
    })
    ws.on('pong', () => { alive = true })
    ws.on('message', (data: Buffer, isBinary: boolean) => mux.handle(data, isBinary))
    ws.on('error', (err: Error) => done(err))
    ws.on('close', () => done())
  })
}

/** The reconnect loop: serve, drop viewers, back off (with the healthy-duration
 *  reset), redial — until aborted. tmux sessions survive every reconnect. */
export async function runTransport(wsUrl: string, headers: Record<string, string>, mgr: ConnectorSessionManager, deps: TransportDeps, signal: AbortSignal): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    const start = deps.timers.now()
    try { await serveOnce(wsUrl, headers, mgr, deps, signal) } catch { /* logged; reconnect */ }
    mgr.detachAll()
    if (signal.aborted) break
    if (deps.timers.now() - start > RELAY_HEALTHY_RESET_MS) attempt = 0
    attempt++
    await new Promise<void>((r) => {
      const h = deps.timers.setTimeout(r, computeBackoff(attempt, deps.rng))
      signal.addEventListener('abort', () => { deps.timers.clearTimeout(h); r() }, { once: true })
    })
  }
}
```

`index.ts`'s `runConnector(cfg, headers)` builds the manager with the
`canvasTmuxSpawnSpec` factory, installs the `SIGINT`/`SIGTERM`→abort handler,
`await runTransport(cfg.wsUrl, headers, mgr, defaultDeps, signal)`, and returns
`0`. `defaultDeps` wraps the global timers, `Math.random`, and the `ws`
constructor; tests pass fakes.

**Half-open detection choice.** `relay.go` used `conn.Ping` returning an error;
the connector uses the server's own `alive`/`pong` idiom
(`gateway-registry.ts` lines 193–204) at the same 20 s cadence. Both send a WS
ping every 20 s and force a redial when the peer stops answering — identical
effect, expressed in the Node/`ws` idiom the rest of the server already uses.

---

## 6.4 Full frame-handling table vs `gateway-go`

Canvas↔connector wire (`gateway-registry.ts` header / `protocol.go`) is
unchanged; the table shows the connector reproduces every action.

| Wire event | `gateway-go` | Connector (#5) | Parity note |
|---|---|---|---|
| **canvas→connector** `relay-open{channelId,sessionId,cols,rows}` | `serveOnce`: new `channelWorker{queue:64}` + goroutine; `queue<-open` | `mux.handle`: new `ChannelQueue(64)`; `enqueue(open)` → pump | open is the queue's first item, before any msg |
| `relay-msg{channelId,msg}` | enqueue; `default:` shed if full | `q.enqueue` → false sheds | 64-deep cap; structural parity — Bun's synchronous drain means the read loop never blocks and shed is reachable only under reentrancy (§6.2) |
| `relay-close{channelId}` | enqueue; `delete(workers)`; if shed `close(queue)` | same; `workers.delete`; if `!sent` `q.close()` | shed-close prevents a pump that nothing will drain |
| binary frame | `continue` (ignored) | `if (isBinary) return` | canvas→connector is all text |
| non-JSON text | `continue` | `try/catch` → return | ignored |
| **channel action** open | `mgr.Attach(sid,ch,cols,rows,sink)`; err→`RelayClosed` | `mgr.attach(...)`; false→send `relay-closed` | attach fan-out identical |
| action msg `input` | `mgr.Input(sid,ch,data)` (channel-gated) | `mgr.input(sid,ch,data)` | only if channel attached & not gone |
| action msg `resize` | `mgr.Resize(sid,cols,rows)` (session-wide) | `mgr.resize(sid,cols,rows)` | authoritative, dedup, fan-out |
| action close | `mgr.Detach`; return | `mgr.detach`; return | drops one viewer |
| **connector→canvas** pty output | `sink.SendOutput` → 4-byte BE + bytes | `sink.sendOutput` → `encodeBinaryFrame` | byte-identical framing |
| attached/resize/exit | `sink.SendMsg` → `relay-msg{msg:inner}` | `sink.sendMsg` → `relay-msg{msg:inner}` | inner = terminal-protocol.ts |
| channel teardown | `sink.Close` → `relay-closed` | `sink.close` → `relay-closed` | past-tense notify (asymmetric with `relay-close`) |
| **transport** dial | `websocket.Dial` + CF headers | `new WebSocket(url,{headers})` | same CF-Access pair |
| read limit | `SetReadLimit(1<<20)` | `maxPayload: RELAY_READ_LIMIT_BYTES` | 1 MiB |
| ping | `conn.Ping` every 20 s; err→redial | `alive`/`pong` heartbeat 20 s; miss→terminate→redial | same cadence, same effect |
| reconnect | jittered 1 s/30 s backoff; 30 s healthy-reset | `computeBackoff` + healthy-reset | exact curve |
| disconnect | `DetachAll` (ptys survive) | `mgr.detachAll()` | tmux survives |

---

## 7. Testing (52 → 57)

Five new self-running `*.test.ts` suites (house convention: `bun src/<x>.test.ts`,
ending `console.log('ok: …')`), auto-discovered by `scripts/run-tests.ts`.

### Unit — network-free, no real tmux, no wall-clock

1. **`cli/src/connector/backoff.test.ts`** — `computeBackoff` with a seeded/stubbed
   `rng`: the base curve at attempts 1,2,4,8,16 and the 30 s cap at ≥6; the
   exponent cap (`min(attempt-1,5)`); jitter bounds (rng=0 → 0.8×, rng→1 → <1.2×);
   the healthy-reset rule as a pure check (`now-start > RELAY_HEALTHY_RESET_MS`
   resets the counter).
2. **`cli/src/connector/session.test.ts`** — `ConnectorSessionManager` over a
   **fake `TmuxSession`** (records writes/resizes, drives `onData`/`onExit`):
   get-or-create spawns one pty for two attaches; `attached` carries the session
   size not the newcomer's; scrollback replay on a late attach; output fan-out to
   every channel; resize authority + dedup + fan-out (no `resize` when unchanged);
   `input` gated on attachment; **the initial-grid clamp** — attach with
   `cols=10, rows=3` asserts the spawn factory received **20×5** and `attached`
   reports **20×5** (session.go's pre-spawn clamp, the Go-parity case a raw
   pass-through would fail); `exit` broadcasts `{type:'exit'}` + closes +
   deletes; `detachAll` drops viewers but leaves the pty (no `kill`). Mirrors
   `gateway-go/session/session_test.go`.
3. **`cli/src/connector/mux.test.ts`** — `RelayMux` over a **fake WS** (captures
   sends) + fake manager: `relay-open`→attach with an `attached` reply; per-channel
   FIFO ordering (open before a same-turn resize); **the shed data structure**
   — because the synchronous drain makes depth-64 unreachable in the real
   dispatch path (§6.2), the shed cases drive `ChannelQueue` directly with a
   forced-reentrant `onItem` (one that re-enqueues) to fill it to 64, then
   assert the 65th `enqueue` returns false / is dropped and that a shed
   `relay-close` still `close()`s the queue — validating the guard-rail
   mechanism, not a production path; `input`/`resize` dispatch; attach failure
   emits `relay-closed`; binary + non-JSON frames ignored; output framing via
   `encodeBinaryFrame` (4-byte BE prefix asserted).
4. **`cli/src/connector/reconnect.test.ts`** — `runTransport`/`serveOnce` on a
   **fake clock + fake WS**: a missed pong at 20 s forces `serveOnce` to resolve
   (redial); the reconnect loop backs off by `computeBackoff` between attempts and
   resets the counter after a >30 s healthy connection; `abort` ends the loop
   promptly (no dangling timer); `maxPayload`/`headers` are passed to the WS
   constructor (assert the config the dial *would* use, incl. the CF-Access pair
   for a service-token instance and none for a `none` instance).

### Booted e2e — the validation contract

5. **`server/src/connector-loopback.test.ts`** — the `relay-loopback.test.ts`
   assertions, but driving the **real connector** instead of the test shim.
   Boot `createSyncApp({ dataDir })` on an ephemeral port (the splice plane under
   test); spawn the connector as a subprocess —
   `bun cli/src/main.ts terminal connect --url http://127.0.0.1:<port> --gateway-id loopback`
   (resolved relative to `import.meta.dir`, as relay-loopback resolves
   `terminal-gateway.ts`; a `none` instance, no auth); wait until
   `GET /api/terminal/list` shows the gateway; then a browser WS at
   `/api/terminal/relay?gateway=loopback&session=…` asserts: `attached`
   handshake, `echo relay-roundtrip-ok` round-trips through the real tmux client,
   a second viewer's `attached` carries the **session** size (not its request) and
   replays scrollback. Teardown kills the subprocess + `tmux kill-session -t
   canvas-<session>`. Precondition: tmux on PATH (same as relay-loopback).

   This is the parity gate: the identical assertions that pass against the Go
   connector's splice must pass against the Bun connector. The existing
   `relay-loopback.test.ts` (splice-core-via-shim) stays as-is — it validates a
   different seam and is not reparameterised.

### Manual smoke

`bin/dev up`; then against the local `none` instance:
`ensembleworks terminal connect --url http://localhost:8788 --gateway-id smoke-1 &`;
`ensembleworks terminal list` shows `smoke-1`; open a canvas terminal bound to it
and confirm keystrokes echo, a second browser mirrors the session, and killing +
restarting the connector reattaches the live tmux session (`-A`).

---

## 8. Compile compatibility (owed to #7)

The connector obeys the same three rules #4 pinned so #7's `bun build --compile`
is a no-op: **static imports only** (`ws`, the `@ensembleworks/contracts`
subpaths, the connector modules — no dynamic `import()`); **real-FS paths** for
the tmux conf (`ENSEMBLEWORKS_TMUX_CONF`/`TMUX_CONF` env, never
`import.meta`-relative); **no build-time config baked wrong**. `ws` is pure JS
(its native `bufferutil`/`utf-8-validate` are optional and absent), so it
compiles under `--compile`; flagged for the #7 compile check (R2).

---

## 9. Risks

- **R1 — parity drift under a different concurrency model.** Go's per-goroutine
  channel workers become single-threaded synchronous queues; a subtle ordering
  difference could diverge from the Go connector. The shed behaviour is
  *knowingly* different in reachability (§6.2): the connector keeps the pinned
  mechanism and cap but, being single-threaded, can never block the read loop
  and so never sheds in practice — a strict liveness improvement, stated
  honestly rather than claimed as behavioural parity. Ordering parity is
  pinned by the frame table (§6.4), the FIFO/shed unit tests (§7.3), and the
  booted parity gate (§7.5) running the *same* assertions that pass against Go.
- **R2 — `ws` in a soon-to-be-compiled binary.** A third-party runtime dep.
  Mitigated: pure JS, optional native addons absent, scope limited to the WS
  client; flagged for #7's `--compile` check. (Bun's global `WebSocket` was
  rejected: no manual `ping()` / `maxPayload` / outbound-header parity.)
- **R3 — `encodeBinaryFrame` duplicated** in `connector/frame.ts` and
  `gateway-registry.ts`. Byte-identical (4-byte BE prefix), pinned on both sides
  by tests; deliberately duplicated to keep #5 out of the server workspace.
  A later slice may lift both into `contracts`.
- **R4 — two live connectors, one gateway-id.** If an operator runs the Bun
  connector and the legacy Go `termgw` with the same id before #8, the splicer's
  `resolveGatewayOwner` binding replaces the older socket (`gateway-registry.ts`
  `connect`) — last-writer-wins, no corruption. The stable per-box gateway-id
  default (#4) already prevents cross-box collisions. Documented, not a #5 bug.
- **R5 — tmux conf path skew.** The connector reads its conf from env; if the
  devcontainer feature (#8) sets a different path than dev, `-f` silently
  degrades (missing-conf is a no-op by design). Mitigated by `canvasTmuxSpawnSpec`
  being the single policy and the `existsSync` gate; the feature wiring is #8.
