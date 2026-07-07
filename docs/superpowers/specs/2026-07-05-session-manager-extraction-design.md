# Shared tmux session manager — extraction design

**Phase 3, sub-project 2 (retargeted).** Behaviour-neutral extraction of the
tmux-via-PTY *session primitive* out of `server/src/terminal-gateway.ts` into
`@ensembleworks/contracts`, so the server gateway and the future CLI connector
share one implementation of "open a tmux client through a PTY, write/resize/read
it." No behaviour change.

## Background

Phase 3's original "Contracts tool spine" slice is mostly hollow: the contracts
consolidation (shape schemas, the terminal WS protocol, constants, stamp/slug/
user-id) already landed in Phase 0/1, and `@ensembleworks/contracts` is already
imported across ~20 client/server files. The one piece of that slice that is
both **behaviour-neutral** and **foundational** is the shared session manager
the design calls for (`docs/unified-architecture-design.md` §1.5, §6.2):

> the tmux session manager (`Bun.Terminal`-based) used by the server terminal
> gateway *and* the CLI connector — one implementation of "attach tmux via a
> PTY, speak the 5-message protocol".

This slice extracts that primitive now, on safe ground (guarded by the existing
real-tmux integration tests), so the connector sub-project reuses it rather than
forking the session lifecycle across the gateway and the connector. The
tool-manifest portion of the old slice is deferred to the routes/CLI
sub-projects that serve and render it.

## Goal

Move the reusable PTY-backed tmux session primitive into contracts and rewrap
`terminal-gateway.ts`'s `getOrCreateSession`/`resizeSession` on top of it, with
**zero observable behaviour change** to the terminal gateway.

## Scope

**In scope**
- Move `server/src/terminal/pty.ts` → `contracts/src/pty.ts` (verbatim; the Bun
  `spawnPty`/`Pty`/`PtyOptions` wrapper).
- Add `contracts/src/session-manager.ts` — a `TmuxSession` primitive wrapping
  `spawnPty` with cols/rows state and resize clamps.
- Expose it via a **subpath export** `@ensembleworks/contracts/session-manager`
  (NOT the browser barrel `index.ts`).
- Add `bun-types` to contracts (devDep + tsconfig `types`) so `Bun.spawn`
  typechecks there.
- Rewire `server/src/terminal-gateway.ts` to consume the shared primitive; keep
  everything gateway-specific (spawn policy, scrollback, fan-out, HTTP/WS).
- Delete `server/src/terminal/pty.ts` and the now-empty `server/src/terminal/`.
- A focused `contracts/src/session-manager.test.ts`.

**Out of scope (deferred, do not build here)**
- The tool manifest (`tools/` verb-definition data model, `GET /api/tools`
  serving) — belongs with the routes/CLI sub-projects.
- The CLI connector itself — a later sub-project; it will *supply its own
  `SpawnSpec` and transport* and reuse this primitive.
- Any change to the spawn policy (`tmuxSpawnSpec`, privilege drop / `TERM_RUN_AS`
  / launcher), scrollback, multi-client fan-out, heartbeat, or the HTTP/WS
  surface. These stay in the gateway, unchanged.
- Parameterising the primitive beyond what the gateway needs today.

## Architecture

`terminal-gateway.ts` today interleaves three responsibilities. This slice
separates the first into contracts and leaves the other two in the gateway:

1. **Session primitive (→ contracts).** Spawn the tmux client through a PTY;
   expose `onData`/`onExit`; `write`; `resize` (integer-check + clamp +
   changed-check + apply); `kill`; hold the authoritative `cols`/`rows`.
2. **Spawn policy (stays in gateway).** `tmuxSpawnSpec(id)` — direct `tmux` vs
   the privilege-dropping sudo launcher, read from `TERM_RUN_AS`/`TERM_LAUNCHER`/
   `TMUX_CONF`/env. Host- and role-specific; the connector will not share it.
3. **Server transport (stays in gateway).** Scrollback ring, multi-client
   binary fan-out, the 5-message protocol translation (using the already-shared
   `contracts/terminal-protocol.ts`), heartbeat, HTTP routes, WS upgrade.

The connector (later) provides its own `SpawnSpec` and its own transport, reusing
(1) and the shared protocol.

## Components

### `contracts/src/pty.ts` (moved, verbatim)

Moved unchanged from `server/src/terminal/pty.ts`: the Bun-PTY wrapper
`spawnPty(file, args, opts): Pty` with `interface Pty { onData(cb:(d:string)=>void):void; onExit(cb:()=>void):void; resize(cols,rows):void; write(data:string):void; kill():void }` and `interface PtyOptions { name; cols; rows; cwd; env }`. Only its header
comment changes: the sub-project-1 note that said "Sub-project 2 extracts this
into contracts/src/session-manager.ts; for now it lives in the server" is updated
to reflect that it now lives in contracts and backs `session-manager.ts`. This is
an internal contracts module (imported by `session-manager.ts`), **not** exported
from the barrel and **not** given its own package subpath.

### `contracts/src/session-manager.ts` (new)

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

/** How to spawn the tmux client on this host (caller's policy). */
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
  /** integer-check + clamp cols[20..500]/rows[5..200] + changed-check; applies to
   *  the PTY and updates cols/rows. Returns true iff the size actually changed. */
  resize(cols: number, rows: number): boolean
  kill(): void
  readonly cols: number
  readonly rows: number
}

const COLS_MIN = 20, COLS_MAX = 500, ROWS_MIN = 5, ROWS_MAX = 200
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
    get cols() { return curCols },
    get rows() { return curRows },
  }
}
```

The clamp bounds (`20..500` × `5..200`), the integer guard, and the
changed-check are lifted **verbatim** from the current `resizeSession`, so the
gateway's resize semantics are preserved exactly. The `name: 'xterm-256color'`
literal is lifted verbatim from the current `getOrCreateSession` spawn call.

### `contracts/package.json` + `contracts/tsconfig.json`

- `package.json` `exports` gains a subpath:
  ```json
  "exports": {
    ".": "./src/index.ts",
    "./session-manager": "./src/session-manager.ts"
  }
  ```
  and `bun-types` (pinned `1.3.14`, matching the toolchain) is added to
  `devDependencies`.
- `tsconfig.json` gains `"types": ["node", "bun-types"]` (currently absent, so TS
  auto-includes all `@types`; `zod`/`@tldraw/validate` ship their own types, so
  restricting to `node`+`bun-types` is safe and is what lets `Bun.spawn`
  typecheck). Mirrors `server/tsconfig.json`.

### `server/src/terminal-gateway.ts` (rewired)

- Import changes:
  `import { spawnPty, type Pty } from './terminal/pty.ts'` →
  `import { openTmuxSession, type TmuxSession } from '@ensembleworks/contracts/session-manager'`.
- `interface TermSession`: field `pty: Pty` → `pty: TmuxSession`, and the
  redundant `cols`/`rows` fields are **removed** — the `TmuxSession` is now the
  single source of truth for size (read `session.pty.cols`/`session.pty.rows`).
- `getOrCreateSession`: the `spawnPty(spec.file, spec.args, {name,cols,rows,cwd,env})`
  call becomes `openTmuxSession(tmuxSpawnSpec(id), cols, rows)`. The `onData`
  (scrollback + fan-out) and `onExit` (exit msg + close + delete) callbacks are
  unchanged. Its `TermSession` literal drops the `cols`/`rows` fields.
- The WS `attached` message reads `session.pty.cols`/`session.pty.rows` instead
  of `session.cols`/`session.rows`.
- `resizeSession(session, cols, rows)` collapses to:
  ```ts
  function resizeSession(session: TermSession, cols: number, rows: number) {
    if (!session.pty.resize(cols, rows)) return
    const resizeMsg: TermServerMessage = { type: 'resize', cols: session.pty.cols, rows: session.pty.rows }
    const msg = JSON.stringify(resizeMsg)
    for (const ws of session.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }
  ```
  (The integer/clamp/changed logic now lives in `TmuxSession.resize`; the
  authoritative fan-out stays here and fires only on a real change, exactly as
  before.)
- Unchanged: `tmuxSpawnSpec`, `probeRunAs`, `sanitizeId`, `listTmuxSessions`,
  scrollback ring, binary fan-out, heartbeat, all HTTP routes, the WS upgrade
  path, `TERM_RUN_AS` privilege drop.

### Deletions

`server/src/terminal/pty.ts` is removed; `server/src/terminal/` (which holds only
that file) is removed with it.

## Browser safety (hard constraint)

`session-manager.ts` and `pty.ts` contain `Bun.spawn` and must never reach the
browser bundle. Enforcement:
- Neither is re-exported from `contracts/src/index.ts` (the barrel the client
  imports).
- They are reachable only through the `./session-manager` subpath, which only the
  server (and later the connector) import.
- Verification: after the change, `grep` confirms no `client/src` file imports
  `@ensembleworks/contracts/session-manager` (or `/pty`), and the client build
  (`bun run build`) succeeds without bundling Bun-runtime code.

## Behaviour-neutrality & testing

This is a pure move + rewrap; the resize/clamp/spawn constants are lifted
verbatim. Guards:

- **Existing integration tests must stay green** — they exercise real tmux IO
  through the whole gateway and are the primary behaviour-neutrality proof:
  - `server/src/relay-loopback.test.ts` (relay round-trip: attached handshake,
    echo, resize, scrollback, over a real tmux via the gateway).
  - `server/src/gateway-plane.test.ts` (gateway registry/relay plane).
  - `server/src/smoke-terminal.ts` (gateway IO, scrollback, resize, tmux
    survival), if run.
- **New `contracts/src/session-manager.test.ts`** (self-running, `bun`-run,
  matching the repo's test style) locks the primitive's contract:
  - `resize` clamp/changed logic (pure, no spawn): below-min clamps up, above-max
    clamps down, non-integer → `false`, unchanged size → `false`, real change →
    `true` and `cols`/`rows` reflect the clamped values.
  - a minimal real-PTY smoke: `openTmuxSession` spawning a cheap shell
    (`{ file: 'bash', args: ['--noprofile','--norc','-c','printf READY; sleep 1'], cwd, env }`),
    assert an `onData` chunk arrives (round-trip through the real PTY), then
    `kill()` and confirm `onExit` fires. (Uses a plain shell, not tmux, so the
    test needs no tmux server; the tmux-specific path stays covered by
    relay-loopback.)
- **Whole-suite gates**: `bun run typecheck` and `bun run test`
  (`all N suites passed`, now including the new session-manager suite) stay
  green; `bun run build` (client Vite-under-Bun) stays green, proving the client
  never pulls the Bun-only module.

## Risks

- **R1 — subpath export resolution.** The server must resolve
  `@ensembleworks/contracts/session-manager` to the `.ts` source. The existing
  `.` → `./src/index.ts` export already resolves `.ts` across the Bun workspace,
  so the subpath follows the same, proven pattern. Verified by server typecheck +
  the gateway booting under `bun`.
- **R2 — contracts gaining a Bun dependency.** Adding `bun-types` + the
  restricted `types` array must not break contracts' existing typecheck (shapes,
  zod, tldraw/validate). Verified by `bun run --filter '@ensembleworks/contracts'
  typecheck` staying green. `skipLibCheck` is already on.
- **R3 — accidental browser inclusion.** Mitigated by the barrel exclusion +
  subpath-only reachability + the post-change grep and client build check above.
