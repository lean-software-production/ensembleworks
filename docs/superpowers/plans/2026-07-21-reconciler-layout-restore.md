# Reconciler + Layout Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EW Codespaces survive reboots and container stop/starts: `codespaces.json` grows a `desired: 'up' | 'stopped'` field (set by `up`/`stop`), `ew codespace reconcile` idempotently drives reality toward it (all desired-up codespaces supervised in one foreground process), `ew codespace boot-install` packages that as a systemd user service (Linux-only v1), and the pty-backend connector snapshots its session layout (`id`, `cwd`, scrollback tail) to the container disk on SIGTERM and pre-seeds it on start — so after any restart, terminals reappear in their last cwd with their history replayed, at a fresh prompt (design §5.3's honest promise).

**Architecture:** Sub-project 4 of `docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md` (§6.4), implementing design doc §5/§5.5/§5.6/§6 as scoped by the four binding SP4 decisions in `docs/superpowers/plans/2026-07-21-ew-codespaces-decision-log.md`. Builds directly on SP2's seams (`docs/superpowers/plans/2026-07-21-ew-codespace-up.md` — store, engine, `supervise`; SP2 is being implemented concurrently on this branch, so write against that plan's final signatures) and SP1's pty backend. Layout restore is state-B honest (design §5.2): `$HOME/.ensembleworks-layout.json` lives on the container disk — survives stop→start, dies on rebuild, by design. The reconciler is the design-§6 pattern (desired-state + boot-time drive-toward), not a daemon: one long-lived foreground `reconcile` process that systemd owns.

**Tech Stack:** Bun + TypeScript. Tests are plain `bun <file>` `node:assert/strict` scripts under the `**/src/**/*.test.ts` glob — every one docker- and external-network-free (the layout loopback test boots a local ephemeral `createSyncApp` + a real local connector, same in-glob pattern as the existing `server/src/connector-loopback.test.ts`). Anything needing a real container or systemd is a documented manual rehearsal (final task), not a glob test.

**Branch:** continue on `docs/ew-codespaces-design`.

ux-contract: none — CLI/connector host tooling; no interaction-bearing surface

**Fixed constants (stated once, used throughout):**
- `LAYOUT_TAIL_CAP = 64 * 1024` bytes of scrollback persisted per session (a quarter of the 256 KiB live ring — enough for meaningful history, small enough that a many-session snapshot stays trivially writable on SIGTERM).
- Layout file: `$HOME/.ensembleworks-layout.json` in-container (decision #4), overridable via `ENSEMBLEWORKS_LAYOUT_FILE` for tests.
- Pre-seeded sessions respawn eagerly at the clamped default grid 80×24; the first real viewer's resize takes over as usual.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `contracts/src/pty.ts` | Modify | Expose the child `pid` on `Pty` (the `/proc/<pid>/cwd` handle) |
| `contracts/src/session-manager.ts` | Modify | `pid?: number` passthrough on `TmuxSession` (optional — fakes stay valid) |
| `contracts/src/session-manager.test.ts` | Modify | Real-spawn pid + `/proc` cwd readlink proof |
| `cli/src/connector/layout.ts` | Create | Layout schema v1, serialize/parse, tail cap, `readProcCwd`, `layoutFilePath` |
| `cli/src/connector/layout.test.ts` | Create | Pure round-trip / corrupt-input / cap tests |
| `cli/src/connector/session.ts` | Modify | `SpawnFactory` cwd param; `snapshotLayout` / `preseedLayout` on the manager |
| `cli/src/connector/session.test.ts` | Modify | Snapshot/preseed over fakes: cap, gone-exclusion, seeded replay, cwd plumb |
| `cli/src/connector/index.ts` | Modify | `spawnSpecFor` cwd param; `runConnector` pty-backend layout read/preseed + SIGTERM/SIGINT snapshot |
| `cli/src/connector/spawn-spec.test.ts` | Modify | cwd-override selection tests |
| `server/src/connector-layout-loopback.test.ts` | Create | Booted end-to-end: pre-seeded history+cwd through the real relay; SIGTERM rewrites the layout file |
| `cli/src/codespace/store.ts` | Modify | `desired?: 'up' \| 'stopped'` + `setDesired` |
| `cli/src/codespace/store.test.ts` | Modify | Field round-trip + `setDesired` semantics |
| `cli/src/codespace/up.ts` | Modify | Engine refactor: `runCodespaceOnce` / `superviseCodespace` against an injected signal; live `up` sets `desired: 'up'` |
| `cli/src/codespace/stop.ts` | Modify | Live `stop` sets `desired: 'stopped'` |
| `cli/src/codespace/reconcile.ts` | Create | `planReconcile` + the `codespace reconcile` slot (dry-run + parallel live supervision) |
| `cli/src/codespace/reconcile.test.ts` | Create | Dry-run plan: desired filtering, missing-checkout skip, secret-free |
| `cli/src/codespace/boot-install.ts` | Create | Unit-file text/path/ExecStart generation + the `boot-install` slot |
| `cli/src/codespace/boot-install.test.ts` | Create | Pure unit-text tests + dry-run + platform guard (injected) |
| `cli/src/codespace/index.ts` | Modify | Wire `reconcile` / `boot-install` verbs |
| `cli/src/codespace/group.test.ts` | Modify | Verb-menu + dispatch coverage for the new verbs |
| `cli/src/dispatch.ts` | Modify | Top help line |

---

### Task 1: `pid` on the PTY primitives

The layout snapshot needs the shell's cwd at snapshot time, read from `/proc/<child pid>/cwd` (decision #4). Minimal contracts change: `Pty` gains a required `pid` (single implementation, `Bun.spawn`'s `proc.pid`); `TmuxSession` gains an **optional** `pid` passthrough so every existing fake (`cli/src/connector/session.test.ts`, the SP3 plan's fakes) stays valid without edits.

**Files:**
- Modify: `contracts/src/pty.ts`
- Modify: `contracts/src/session-manager.ts`
- Modify: `contracts/src/session-manager.test.ts` (append at end)

- [ ] **Step 1: Write the failing test**

Append to `contracts/src/session-manager.test.ts`:

```ts
// pid exposure (EW Codespaces SP4): openTmuxSession surfaces the child pid so
// the connector's layout snapshot can read /proc/<pid>/cwd at SIGTERM time.
// Spawn a real shell in a known cwd, assert the pid is live and (on Linux)
// that /proc/<pid>/cwd readlinks to that cwd, then kill and await exit.
{
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ew-pid-')))
  const spec = canvasShellSpawnSpec({ shell: 'bash', home: dir })
  const sh = openTmuxSession(spec, 80, 24)
  assert.ok(Number.isInteger(sh.pid) && (sh.pid as number) > 0, `pid is a live positive integer (got ${sh.pid})`)
  if (process.platform === 'linux') {
    assert.equal(readlinkSync(`/proc/${sh.pid}/cwd`), dir, '/proc/<pid>/cwd resolves to the spawn cwd')
  }
  const gone = new Promise<void>((resolve) => sh.onExit(() => resolve()))
  sh.kill()
  await Promise.race([
    gone,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('killed shell did not exit in 5s')), 5000)),
  ])
  console.log('ok: openTmuxSession exposes the child pid (and /proc cwd resolves on linux)')
}
```

Extend the imports at the top of the file: add `mkdtempSync`, `readlinkSync`, `realpathSync` to the `node:fs` import, and `path` / `os` imports if not already present:

```ts
import { mkdtempSync, readlinkSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
```

(merge into existing import lines if the file already imports from these modules).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun contracts/src/session-manager.test.ts`
Expected: FAIL — `sh.pid` is `undefined` (typecheck would flag it too: `pid` not on `TmuxSession`).

- [ ] **Step 3: Implement**

In `contracts/src/pty.ts`:

`Pty` gains the field:

```ts
export interface Pty {
  onData(cb: (data: string) => void): void
  onExit(cb: () => void): void
  resize(cols: number, rows: number): void
  write(data: string): void
  kill(): void
  /** OS pid of the spawned child — the /proc/<pid>/cwd handle for the
   *  connector's layout snapshot (EW Codespaces SP4). */
  readonly pid: number
}
```

and `spawnPty`'s returned object gains, after `kill() { … }`:

```ts
    pid: proc.pid,
```

In `contracts/src/session-manager.ts`:

`TmuxSession` gains an optional passthrough (optional so fakes in manager tests
need not provide it):

```ts
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
  /** OS pid of the underlying child, when known (real sessions always know it;
   *  test fakes may omit). Used by the SP4 layout snapshot to read /proc cwd. */
  readonly pid?: number
}
```

and `openTmuxSession`'s returned object gains, after the `rows` getter:

```ts
    get pid() {
      return pty.pid
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun contracts/src/session-manager.test.ts && bun cli/src/connector/session.test.ts`
Expected: both PASS — the new `ok:` line appears; the manager suite is untouched (optional `pid` breaks no fake).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/pty.ts contracts/src/session-manager.ts contracts/src/session-manager.test.ts
git commit -m "feat(contracts): expose child pid on Pty/TmuxSession for layout snapshots" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Layout schema + pure helpers

The persisted shape (decision #4): `{ version: 1, sessions: [{ id, cwd?, scrollbackTail }] }`, `scrollbackTail` base64 (raw terminal bytes are not JSON-safe), capped at `LAYOUT_TAIL_CAP`. Parsing is defensive: anything malformed → `null` (the connector simply starts cold — a corrupt layout must never break startup).

**Files:**
- Create: `cli/src/connector/layout.ts`
- Create: `cli/src/connector/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/connector/layout.test.ts`:

```ts
// Layout persistence helpers (SP4 decision #4): schema-v1 serialize/parse
// round-trip, defensive parsing (corrupt JSON / wrong version / bad entries →
// null — a broken layout must never break connector startup), the 64 KiB tail
// cap, layoutFilePath resolution, and readProcCwd's error-swallowing.
// Run with: bun src/connector/layout.test.ts
import assert from 'node:assert/strict'
import path from 'node:path'
import {
	capTail,
	LAYOUT_TAIL_CAP,
	layoutFilePath,
	parseLayout,
	readProcCwd,
	serializeLayout,
	type LayoutSnapshot,
} from './layout.ts'

// Round-trip, including raw non-UTF-8-safe bytes through base64.
{
	const rawTail = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0xfe, 0x0d, 0x0a]) // ANSI + invalid-UTF8 bytes
	const snap: LayoutSnapshot = {
		version: 1,
		sessions: [
			{ id: 'sess1', cwd: '/workspaces/myrepo', scrollbackTail: rawTail.toString('base64') },
			{ id: 'sess2', scrollbackTail: '' }, // cwd unknown is legal
		],
	}
	const parsed = parseLayout(serializeLayout(snap))
	assert.ok(parsed)
	assert.deepEqual(parsed, snap, 'serialize/parse round-trips losslessly')
	assert.deepEqual(
		Buffer.from(parsed.sessions[0]!.scrollbackTail, 'base64'),
		rawTail,
		'raw terminal bytes survive base64',
	)
}

// Defensive parse: null on anything malformed, never a throw.
assert.equal(parseLayout('not json {{{'), null, 'corrupt JSON → null')
assert.equal(parseLayout('{"version":2,"sessions":[]}'), null, 'unknown version → null')
assert.equal(parseLayout('{"version":1}'), null, 'missing sessions → null')
assert.equal(parseLayout('{"version":1,"sessions":[{"cwd":"/x","scrollbackTail":""}]}'), null, 'entry without id → null')
assert.equal(parseLayout('{"version":1,"sessions":[{"id":"a","scrollbackTail":42}]}'), null, 'non-string tail → null')
assert.equal(parseLayout(null), null, 'absent file (null read) → null')

// capTail: last N bytes win (history tail, not head).
{
	const big = Buffer.alloc(LAYOUT_TAIL_CAP + 1000, 0x61) // 'a' * (cap+1000)
	big.write('TAIL-MARKER', big.byteLength - 11)
	const capped = capTail([big])
	assert.equal(capped.byteLength, LAYOUT_TAIL_CAP, 'capped to LAYOUT_TAIL_CAP')
	assert.ok(capped.toString('utf8').endsWith('TAIL-MARKER'), 'keeps the TAIL, drops the head')
	const small = capTail([Buffer.from('ab'), Buffer.from('cd')])
	assert.equal(small.toString('utf8'), 'abcd', 'under-cap chunks concatenate untouched')
	assert.equal(capTail([]).byteLength, 0, 'empty ring → empty tail')
}

// layoutFilePath: env override wins; else $HOME/.ensembleworks-layout.json.
assert.equal(layoutFilePath({ ENSEMBLEWORKS_LAYOUT_FILE: '/tmp/custom.json' } as NodeJS.ProcessEnv), '/tmp/custom.json')
assert.equal(
	layoutFilePath({ HOME: '/home/u' } as NodeJS.ProcessEnv),
	path.join('/home/u', '.ensembleworks-layout.json'),
)

// readProcCwd: a live pid (our own) resolves on linux; garbage pids → undefined.
if (process.platform === 'linux') {
	assert.equal(readProcCwd(process.pid), process.cwd(), 'own /proc cwd resolves')
}
assert.equal(readProcCwd(999999999), undefined, 'dead pid → undefined, never a throw')
assert.equal(readProcCwd(undefined), undefined, 'unknown pid → undefined')

console.log('ok: layout helpers — round-trip, defensive parse, tail cap, paths, proc cwd')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/connector/layout.test.ts`
Expected: FAIL — cannot resolve `./layout.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/connector/layout.ts`:

```ts
/**
 * Session-layout persistence (SP4 decision #4, design §5.6 — recover INTENT,
 * not processes): on SIGTERM the pty-backend connector snapshots
 * { sessions: [{ id, cwd, scrollbackTail }] } to $HOME/.ensembleworks-layout.json
 * INSIDE the container (state B: survives stop→start, dies on rebuild —
 * honest per design §5.3); on start it pre-seeds the session manager so known
 * sessions respawn in their last cwd and replay the persisted tail as history.
 * Parsing is defensive: any malformed input → null (cold start, never a crash).
 */
import { readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bytes of scrollback persisted per session — a quarter of the live 256 KiB
 *  ring: enough history to be useful, small enough to write on SIGTERM. */
export const LAYOUT_TAIL_CAP = 64 * 1024

export interface LayoutSessionEntry {
	id: string
	/** last known cwd (from /proc/<pid>/cwd); absent when unreadable. */
	cwd?: string
	/** base64 of the capped scrollback tail (raw terminal bytes ≠ JSON-safe). */
	scrollbackTail: string
}

export interface LayoutSnapshot {
	version: 1
	sessions: LayoutSessionEntry[]
}

export function serializeLayout(snap: LayoutSnapshot): string {
	return `${JSON.stringify(snap)}\n`
}

/** null on ANY malformed input — a corrupt layout means a cold start. */
export function parseLayout(raw: string | null): LayoutSnapshot | null {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const obj = parsed as { version?: unknown; sessions?: unknown }
	if (obj.version !== 1 || !Array.isArray(obj.sessions)) return null
	const sessions: LayoutSessionEntry[] = []
	for (const e of obj.sessions) {
		if (typeof e !== 'object' || e === null) return null
		const { id, cwd, scrollbackTail } = e as { id?: unknown; cwd?: unknown; scrollbackTail?: unknown }
		if (typeof id !== 'string' || id.length === 0) return null
		if (cwd !== undefined && typeof cwd !== 'string') return null
		if (typeof scrollbackTail !== 'string') return null
		sessions.push(cwd === undefined ? { id, scrollbackTail } : { id, cwd, scrollbackTail })
	}
	return { version: 1, sessions }
}

/** Concatenate ring chunks and keep only the last `cap` bytes (the TAIL). */
export function capTail(ring: readonly Buffer[], cap: number = LAYOUT_TAIL_CAP): Buffer {
	const all = Buffer.concat(ring)
	return all.byteLength <= cap ? all : all.subarray(all.byteLength - cap)
}

/** ENSEMBLEWORKS_LAYOUT_FILE override (tests) → $HOME/.ensembleworks-layout.json. */
export function layoutFilePath(env: NodeJS.ProcessEnv): string {
	return env.ENSEMBLEWORKS_LAYOUT_FILE ?? path.join(env.HOME ?? os.homedir(), '.ensembleworks-layout.json')
}

/** Read a live child's cwd from /proc (Linux — which a devcontainer always is);
 *  undefined on any failure (dead pid, no /proc, no pid at all). */
export function readProcCwd(pid: number | undefined): string | undefined {
	if (!pid) return undefined
	try {
		return readlinkSync(`/proc/${pid}/cwd`)
	} catch {
		return undefined
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/connector/layout.test.ts`
Expected: PASS — `ok: layout helpers — round-trip, defensive parse, tail cap, paths, proc cwd`

- [ ] **Step 5: Commit**

```bash
git add cli/src/connector/layout.ts cli/src/connector/layout.test.ts
git commit -m "feat(cli): layout schema v1 + pure snapshot helpers (64KiB tail cap)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `snapshotLayout` / `preseedLayout` on the session manager

The manager side of decision #4, all testable over fakes. `SpawnFactory` gains an optional 4th `cwd` param (existing factories/fakes ignore it — no ripple); `snapshotLayout` takes the cwd reader as an argument (the impure `/proc` read stays injectable); `preseedLayout` records seeds and **eagerly respawns** each known session at 80×24 so it exists (in its last cwd, ring pre-seeded) before any viewer attaches — a bad seed (e.g. a cwd deleted since the snapshot) is skipped per-session, never fatal.

**Files:**
- Modify: `cli/src/connector/session.ts`
- Modify: `cli/src/connector/session.test.ts` (append at end; also extend the `Fake` fixture)

- [ ] **Step 1: Write the failing test**

In `cli/src/connector/session.test.ts`, add `pid` to the fake so snapshots can exercise the cwd reader — extend the `Fake` interface and `makeFake`:

```ts
interface Fake extends TmuxSession {
	writes: string[]
	emitData(s: string): void
	emitExit(): void
	killed: boolean
	pid: number
}
```

and in `makeFake`'s object literal add (next to `killed: false`):

```ts
		pid: 4242,
```

Add the layout import at the top:

```ts
import { LAYOUT_TAIL_CAP, type LayoutSnapshot } from './layout.ts'
```

Then append at the end of the file:

```ts
// --- SP4: snapshotLayout / preseedLayout ---------------------------------

// snapshotLayout: live sessions only, cwd via the injected reader, tail capped
// and base64'd; gone sessions excluded.
{
	const fakes = new Map<string, Fake>()
	const mgr = new ConnectorSessionManager((id, cols, rows) => {
		const f = makeFake(cols, rows)
		fakes.set(id, f)
		return f
	})
	const a = makeSink()
	const b = makeSink()
	mgr.attach('alpha', 1, 80, 24, a.sink)
	mgr.attach('beta', 2, 80, 24, b.sink)
	fakes.get('alpha')!.emitData('alpha-history\r\n')
	fakes.get('beta')!.emitData('x'.repeat(LAYOUT_TAIL_CAP + 500)) // overflow the cap
	fakes.get('beta')!.emitData('BETA-TAIL')

	const snap = mgr.snapshotLayout((pid) => (pid === 4242 ? '/workspaces/repo' : undefined))
	assert.equal(snap.version, 1)
	assert.equal(snap.sessions.length, 2)
	const alpha = snap.sessions.find((s) => s.id === 'alpha')!
	assert.equal(alpha.cwd, '/workspaces/repo', 'cwd comes from the injected reader (fake pid 4242)')
	assert.equal(Buffer.from(alpha.scrollbackTail, 'base64').toString('utf8'), 'alpha-history\r\n')
	const beta = snap.sessions.find((s) => s.id === 'beta')!
	const betaTail = Buffer.from(beta.scrollbackTail, 'base64')
	assert.ok(betaTail.byteLength <= LAYOUT_TAIL_CAP, 'persisted tail respects the cap')
	assert.ok(betaTail.toString('utf8').endsWith('BETA-TAIL'), 'the TAIL survives, the head is dropped')

	// A session whose shell exited is not part of the layout.
	fakes.get('alpha')!.emitExit()
	const snap2 = mgr.snapshotLayout(() => undefined)
	assert.deepEqual(snap2.sessions.map((s) => s.id), ['beta'], 'gone sessions excluded from the snapshot')
	assert.equal(snap2.sessions[0]!.cwd, undefined, 'unreadable cwd omitted, not empty-string')
	console.log('ok: snapshotLayout — live-only, injected cwd, capped base64 tail')
}

// preseedLayout: eager respawn in the seeded cwd at 80x24; a later attach
// replays the seeded history BEFORE live output; unknown sessions unaffected;
// a seed whose spawn throws is skipped without killing the rest.
{
	const spawns: Array<{ id: string; cols: number; rows: number; cwd?: string }> = []
	const fakes = new Map<string, Fake>()
	const mgr = new ConnectorSessionManager((id, cols, rows, cwd) => {
		if (id === 'badseed') throw new Error('cwd vanished')
		spawns.push({ id, cols, rows, cwd })
		const f = makeFake(cols, rows)
		fakes.set(id, f)
		return f
	})
	const layout: LayoutSnapshot = {
		version: 1,
		sessions: [
			{ id: 'restored', cwd: '/workspaces/repo/sub', scrollbackTail: Buffer.from('OLD-HISTORY\r\n').toString('base64') },
			{ id: 'badseed', cwd: '/gone', scrollbackTail: '' },
		],
	}
	mgr.preseedLayout(layout)

	// Eager respawn: 'restored' exists already, in its seeded cwd, at 80x24;
	// 'badseed' was skipped (its factory threw), the rest survived.
	assert.deepEqual(spawns, [{ id: 'restored', cols: 80, rows: 24, cwd: '/workspaces/repo/sub' }])

	// Live output after the respawn appends AFTER the seeded history.
	fakes.get('restored')!.emitData('fresh-prompt$ ')
	const v = makeSink()
	assert.equal(mgr.attach('restored', 7, 100, 30, v.sink), true)
	assert.equal(Buffer.concat(v.out).toString('utf8'), 'OLD-HISTORY\r\nfresh-prompt$ ', 'replay = seeded history, then live output')

	// A session NOT in the layout spawns fresh with no cwd override.
	const w = makeSink()
	mgr.attach('brandnew', 8, 90, 25, w.sink)
	const brandnew = spawns.find((s) => s.id === 'brandnew')!
	assert.equal(brandnew.cwd, undefined, 'unseeded sessions get no cwd override')
	assert.equal(w.out.length, 0, 'no phantom history on a fresh session')
	console.log('ok: preseedLayout — eager respawn in seeded cwd, history-then-live replay, bad seed skipped')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/connector/session.test.ts`
Expected: FAIL — `mgr.snapshotLayout is not a function` (existing assertions above it still pass).

- [ ] **Step 3: Implement**

In `cli/src/connector/session.ts`:

Add the layout import after the existing contracts import:

```ts
import { capTail, type LayoutSnapshot } from './layout.ts'
```

Widen `SpawnFactory` (existing 3-arg factories and fakes remain assignable):

```ts
export type SpawnFactory = (sessionId: string, cols: number, rows: number, cwd?: string) => TmuxSession
```

In the class, add the seed store as a field (next to `private sessions`):

```ts
	/** SP4 layout seeds, consumed by getOrCreate: last cwd + history to preload
	 *  into the ring. Entries are deleted once used. */
	private seeded = new Map<string, { cwd?: string; history: Buffer }>()
```

In `getOrCreate`, consume the seed — replace the two lines

```ts
		const pty = this.spawn(id, grid.cols, grid.rows) // canvasTmuxSpawnSpec inside; -A reattaches
		const s: SessionState = { pty, ring: [], ringBytes: 0, channels: new Map(), gone: false }
```

with:

```ts
		const seed = this.seeded.get(id)
		this.seeded.delete(id)
		const pty = this.spawn(id, grid.cols, grid.rows, seed?.cwd) // canvasTmuxSpawnSpec inside; -A reattaches
		const s: SessionState = {
			pty,
			ring: seed && seed.history.byteLength > 0 ? [seed.history] : [],
			ringBytes: seed?.history.byteLength ?? 0,
			channels: new Map(),
			gone: false,
		}
```

Append the two methods to the class (after `detachAll`):

```ts
	/** SP4 snapshot (decision #4): every LIVE session's id, cwd (via the
	 *  injected /proc reader — impure, so injected) and capped scrollback tail,
	 *  base64'd for JSON. Called from the connector's SIGTERM handler. */
	snapshotLayout(readCwd: (pid: number | undefined) => string | undefined): LayoutSnapshot {
		const sessions = [...this.sessions.entries()]
			.filter(([, s]) => !s.gone)
			.map(([id, s]) => {
				const cwd = readCwd(s.pty.pid)
				const scrollbackTail = capTail(s.ring).toString('base64')
				return cwd === undefined ? { id, scrollbackTail } : { id, cwd, scrollbackTail }
			})
		return { version: 1, sessions }
	}

	/** SP4 restore (decision #4): record each entry's cwd + history seed, then
	 *  eagerly respawn it at the default 80x24 grid so the session exists (in
	 *  its last cwd, ring pre-seeded) before any viewer attaches. A seed whose
	 *  spawn fails (e.g. its cwd was deleted) is dropped — the next attach
	 *  spawns it fresh with no override; the remaining seeds still restore. */
	preseedLayout(layout: LayoutSnapshot): void {
		for (const entry of layout.sessions) {
			this.seeded.set(entry.id, { cwd: entry.cwd, history: Buffer.from(entry.scrollbackTail, 'base64') })
			try {
				this.getOrCreate(entry.id, 80, 24)
			} catch {
				this.seeded.delete(entry.id) // consumed-or-dropped either way; never fatal
			}
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/connector/session.test.ts`
Expected: PASS — all previous `ok:` lines plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add cli/src/connector/session.ts cli/src/connector/session.test.ts
git commit -m "feat(cli): session-manager layout snapshot/preseed — cwd + capped history seeds" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `runConnector` wiring + booted layout loopback

Wire the layout into the pty backend only (tmux sessions survive by themselves — the tmux server IS their layout): on start, read+parse the layout file and preseed; on SIGINT/SIGTERM, snapshot BEFORE aborting the transport (decision #4 names SIGTERM; SIGINT gets the same treatment because both are the supervisor's graceful-stop signals — a Ctrl-C'd dev connector should restore too). `spawnSpecFor` gains the cwd passthrough. The proof is a booted end-to-end loopback (pattern: `server/src/connector-loopback.test.ts` — local ephemeral server + real connector, no docker, no external network): a pre-written layout file makes the restored session come up in its cwd with history replayed through the real relay, and SIGTERM rewrites the file with every live session.

**Files:**
- Modify: `cli/src/connector/index.ts`
- Modify: `cli/src/connector/spawn-spec.test.ts` (append)
- Create: `server/src/connector-layout-loopback.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/connector/spawn-spec.test.ts` (before the final `console.log`):

```ts
// SP4 cwd passthrough: a seeded cwd overrides HOME for the spawned shell/tmux;
// no cwd → the existing HOME default.
{
	const spec = spawnSpecFor('pty', 'abc', env, '/workspaces/repo/sub')
	assert.equal(spec.cwd, '/workspaces/repo/sub', 'seeded cwd wins for the pty backend')
	const tmuxSpec = spawnSpecFor('tmux', 'abc', env, '/workspaces/repo/sub')
	assert.equal(tmuxSpec.cwd, '/workspaces/repo/sub', 'seeded cwd wins for tmux too')
	assert.equal(spawnSpecFor('pty', 'abc', env).cwd, '/home/u', 'no seed → HOME default unchanged')
}
```

and update its final line to:

```ts
console.log('ok: spawnSpecFor — tmux vs pty spawn policy selection, seeded-cwd override')
```

Create `server/src/connector-layout-loopback.test.ts`:

```ts
// Layout restore loopback (SP4 decision #4): boot createSyncApp, pre-write a
// v1 layout file (one session with a known cwd + a history marker), spawn the
// REAL connector with --backend pty and ENSEMBLEWORKS_LAYOUT_FILE, then via
// the real relay assert: (1) the restored session's first bytes are the
// persisted history; (2) `pwd` lands in the seeded cwd; then SIGTERM the
// connector and assert the layout file was rewritten with every live session.
// No docker, no external network — same in-glob pattern as
// connector-loopback.test.ts. Precondition: bash on PATH; linux (/proc cwd).
// Run with: bun src/connector-layout-loopback.test.ts
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

const GATEWAY = 'layoutloop'
const RESTORED = 'layoutsess'

const openSocket = (url: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})

const firstText = (ws: WebSocket) =>
	new Promise<any>((resolve) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			ws.off('message', h)
			resolve(JSON.parse(data.toString()))
		}
		ws.on('message', h)
	})

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

async function waitForGateway(httpBase: string, id: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpBase}/api/terminal/list`)
			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
			if (body.gateways.some((g) => g.gatewayId === id)) return
		} catch {
			// server warming up — retry
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error(`gateway ${id} did not register within ${timeoutMs}ms`)
}

async function main() {
	let connector: ChildProcess | null = null
	let server: http.Server | null = null
	try {
		// 1. Boot the splice plane.
		const dataDir = mkdtempSync(path.join(os.tmpdir(), 'connector-layout-loopback-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const httpBase = `http://127.0.0.1:${port}`

		// 2. Pre-write a layout: one session, seeded cwd, a history marker.
		const seededCwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'layout-cwd-')))
		const layoutFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'layout-file-')), 'layout.json')
		writeFileSync(
			layoutFile,
			`${JSON.stringify({
				version: 1,
				sessions: [{ id: RESTORED, cwd: seededCwd, scrollbackTail: Buffer.from('=== RESTORED HISTORY ===\r\n').toString('base64') }],
			})}\n`,
		)

		// 3. Spawn the REAL connector: pty backend, layout file injected via env.
		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
		connector = spawn(
			'bun',
			[cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY, '--backend', 'pty'],
			{ env: { ...process.env, SHELL: 'bash', ENSEMBLEWORKS_LAYOUT_FILE: layoutFile }, stdio: ['ignore', 'inherit', 'inherit'] },
		)
		await waitForGateway(httpBase, GATEWAY)

		// 4. Attach to the RESTORED session: history replays first, and the
		// respawned shell is sitting in the seeded cwd.
		const relay = (session: string) =>
			`ws://127.0.0.1:${port}/api/terminal/relay?session=${session}&gateway=${GATEWAY}&cols=80&rows=24`
		const b1 = await openSocket(relay(RESTORED))
		assert.equal((await firstText(b1)).type, 'attached')
		await waitForOutput(b1, '=== RESTORED HISTORY ===') // the persisted tail, replayed as history
		const pwdOut = waitForOutput(b1, seededCwd)
		b1.send(JSON.stringify({ type: 'input', data: 'pwd\r' }))
		await pwdOut // pwd printed the seeded cwd → respawned in the right directory

		// 5. A second, brand-new session (proves the snapshot below covers all
		// live sessions, not just restored ones).
		const b2 = await openSocket(relay('freshsess'))
		assert.equal((await firstText(b2)).type, 'attached')
		const fresh = waitForOutput(b2, 'fresh-ok')
		b2.send(JSON.stringify({ type: 'input', data: 'echo fresh-ok\r' }))
		await fresh
		b1.close()
		b2.close()

		// 6. SIGTERM → the connector snapshots BEFORE exiting (exit 0 on clean
		// signal), and the file now holds BOTH live sessions with real cwds.
		const exited = new Promise<number | null>((resolve) => connector!.once('exit', (code) => resolve(code)))
		connector.kill('SIGTERM')
		assert.equal(await exited, 0, 'clean SIGTERM exit')
		const rewritten = JSON.parse(readFileSync(layoutFile, 'utf8')) as {
			version: number
			sessions: Array<{ id: string; cwd?: string; scrollbackTail: string }>
		}
		assert.equal(rewritten.version, 1)
		assert.deepEqual(rewritten.sessions.map((s) => s.id).sort(), ['freshsess', RESTORED].sort(), 'snapshot covers every live session')
		const restoredEntry = rewritten.sessions.find((s) => s.id === RESTORED)!
		assert.equal(restoredEntry.cwd, seededCwd, 'cwd re-captured from /proc at snapshot time')
		assert.ok(restoredEntry.scrollbackTail.length > 0, 'tail persisted')
		connector = null

		console.log('connector-layout-loopback.test.ts: all assertions passed')
		console.log('ok: layout loopback — restored history + cwd through the real relay; SIGTERM rewrites the snapshot')
	} finally {
		connector?.kill()
		server?.close()
	}
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun cli/src/connector/spawn-spec.test.ts`
Expected: FAIL — typecheck/arity: `spawnSpecFor` takes 3 arguments (cwd ignored → the cwd assertion fails with `/home/u`).

Run: `bun server/src/connector-layout-loopback.test.ts`
Expected: FAIL — timeout waiting for `=== RESTORED HISTORY ===` (the connector never reads the layout file).

- [ ] **Step 3: Implement**

In `cli/src/connector/index.ts`:

Add imports:

```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { layoutFilePath, parseLayout, readProcCwd, serializeLayout } from './layout.ts'
```

Widen `spawnSpecFor` with the cwd passthrough:

```ts
/** Per-session spawn policy behind the --backend flag: 'tmux' is the legacy
 *  default (sessions survive connector restarts via the tmux server); 'pty' is
 *  the connector-owned raw login shell (EW Codespaces coexistence spec §6.1 —
 *  accepted trade: shells die with the connector; host supervision mitigates).
 *  `cwd` is the SP4 layout seed: a restored session respawns in its last
 *  directory; absent → the HOME default. */
export function spawnSpecFor(backend: 'tmux' | 'pty', sessionId: string, env: NodeJS.ProcessEnv, cwd?: string): SpawnSpec {
	if (backend === 'pty') return canvasShellSpawnSpec({ shell: env.SHELL, home: cwd ?? env.HOME })
	return canvasTmuxSpawnSpec({ sessionId, tmuxConf: tmuxConfPath(env), home: cwd ?? env.HOME })
}
```

In `runConnector`, replace the manager construction + signal-handler block:

```ts
	const mgr = new ConnectorSessionManager((id, cols, rows) =>
		openTmuxSession(spawnSpecFor(cfg.backend, id, env), cols, rows),
	)
	const ac = new AbortController()
	const onSignal = () => ac.abort()
```

with:

```ts
	const mgr = new ConnectorSessionManager((id, cols, rows, cwd) =>
		openTmuxSession(spawnSpecFor(cfg.backend, id, env, cwd), cols, rows),
	)

	// SP4 layout restore (decision #4) — pty backend only: tmux sessions ARE
	// their own layout (the tmux server survives us). Read is defensive: a
	// missing/corrupt file is a cold start, never a crash.
	const layoutFile = layoutFilePath(env)
	if (cfg.backend === 'pty') {
		let raw: string | null = null
		try {
			raw = readFileSync(layoutFile, 'utf8')
		} catch {
			// no layout — cold start
		}
		const layout = parseLayout(raw)
		if (layout) mgr.preseedLayout(layout)
	}

	const ac = new AbortController()
	const onSignal = () => {
		// Snapshot BEFORE aborting the transport — the shells are still alive,
		// so /proc/<pid>/cwd is readable. SIGTERM per decision #4; SIGINT gets
		// the same treatment (both are the supervisor's graceful-stop signals).
		if (cfg.backend === 'pty') {
			try {
				writeFileSync(layoutFile, serializeLayout(mgr.snapshotLayout(readProcCwd)))
			} catch {
				// snapshot is best-effort — never block shutdown
			}
		}
		ac.abort()
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/connector/spawn-spec.test.ts && bun server/src/connector-layout-loopback.test.ts && bun server/src/connector-pty-loopback.test.ts`
Expected: all PASS — the new loopback ends with its two `ok:` lines; the SP1 pty loopback proves the no-layout path is byte-identical.

- [ ] **Step 5: Commit**

```bash
git add cli/src/connector/index.ts cli/src/connector/spawn-spec.test.ts server/src/connector-layout-loopback.test.ts
git commit -m "feat(cli): pty-backend layout restore — preseed on start, snapshot on SIGTERM/SIGINT" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `desired` on the store + `up`/`stop` set it

Decision #1: no second store — `codespaces.json` entries gain `desired?: 'up' | 'stopped'`. Optional so existing files parse unchanged; absent means "not managed by the reconciler" (a record created by an SP2-only build stays untouched until its next `up`). The live `up` engine sets `'up'`; the live `stop` sets `'stopped'` (before spawning `docker stop`, so an interrupted stop errs on the side of NOT resurrecting a codespace the owner asked to stop). `--dry-run` paths never mutate `desired`.

**Files:**
- Modify: `cli/src/codespace/store.ts`
- Modify: `cli/src/codespace/store.test.ts` (append)
- Modify: `cli/src/codespace/up.ts` (live engine only)
- Modify: `cli/src/codespace/stop.ts` (live path only)

- [ ] **Step 1: Write the failing test**

Append to `cli/src/codespace/store.test.ts` (before its final `console.log`; reuse the existing `file` binding):

```ts
// SP4 desired-state (decision #1): optional field, round-trips, setDesired
// flips it in place, missing records are a silent no-op, and ensure PRESERVES
// an existing desired (a re-up's metadata refresh must not undo a 'stopped').
{
	setDesired(file, '/home/u/work/ensembleworks', 'up')
	let rec = loadCodespaces(file).codespaces['/home/u/work/ensembleworks']!
	assert.equal(rec.desired, 'up')
	assert.equal(rec.containerId, 'deadbeef'.repeat(8), 'setDesired touches only desired')

	setDesired(file, '/home/u/work/ensembleworks', 'stopped')
	assert.equal(loadCodespaces(file).codespaces['/home/u/work/ensembleworks']!.desired, 'stopped')

	setDesired(file, '/no/such/checkout', 'up') // no record → no-op, no throw
	assert.equal(loadCodespaces(file).codespaces['/no/such/checkout'], undefined)

	const after = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
		repo: 'ensembleworks',
		branch: 'main',
		canvasUrl: 'http://localhost:8788',
	})
	assert.equal(after.desired, 'stopped', 'ensure (dry-run path) preserves desired — only the live engine flips it')
}
```

and add `setDesired` to the import from `./store.ts` at the top of the test file. Update the final `console.log` to:

```ts
console.log('ok: codespaces store — XDG path, mint format/stability, ensure/update round-trip, desired-state')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/store.test.ts`
Expected: FAIL — `setDesired` is not exported from `./store.ts`.

- [ ] **Step 3: Implement**

In `cli/src/codespace/store.ts`:

`CodespaceRecord` gains the field:

```ts
export interface CodespaceRecord {
	gatewayId: string
	containerId?: string
	repo: string
	branch: string
	canvasUrl: string
	/** SP4 desired-state (decision #1): what the reconciler drives toward.
	 *  Absent = not reconciler-managed (pre-SP4 record; next live `up` claims it). */
	desired?: 'up' | 'stopped'
}
```

Append next to `updateContainerId`:

```ts
/** Flip the reconciler's desired-state for a checkout. Set ONLY by the live
 *  `up`/`stop` engines — dry-run and plan paths never mutate desired. */
export function setDesired(file: string, realpathOfCheckout: string, desired: 'up' | 'stopped'): void {
	const store = loadCodespaces(file)
	const rec = store.codespaces[realpathOfCheckout]
	if (!rec) return
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: { ...rec, desired } } })
}
```

(`ensureCodespaceRecord` needs no change — its existing-record spread already preserves `desired`.)

In `cli/src/codespace/up.ts`, inside `runCodespace` immediately after the existing `updateContainerId(...)` line, add:

```ts
	setDesired(codespacesPath(env), plan.workspaceFolder, 'up') // decision #1: live up claims reconciler management
```

and add `setDesired` to the `./store.ts` import.

In `cli/src/codespace/stop.ts`, in `codespaceStop` immediately after the `narrate('ensembleworks: stopping container …')` line (i.e. after the dry-run early-return, before the `Bun.spawnSync` of docker), add:

```ts
	// desired flips BEFORE docker runs: an interrupted stop must never leave a
	// codespace the owner asked to stop marked desired-up for the reconciler.
	setDesired(codespacesPath(env), info.toplevel, 'stopped')
```

and add `setDesired` to its `./store.ts` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/codespace/store.test.ts && bun cli/src/codespace/up.test.ts && bun cli/src/codespace/stop-list.test.ts`
Expected: all PASS — the up/stop suites exercise only dry-run paths, which don't touch `desired`.

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/store.ts cli/src/codespace/store.test.ts cli/src/codespace/up.ts cli/src/codespace/stop.ts
git commit -m "feat(cli): desired-state field on codespaces.json — live up/stop set it" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Engine refactor — `runCodespaceOnce` / `superviseCodespace` against an injected signal

The reconciler needs the SP2 engine callable N times in one process under ONE AbortController (decision #2), so the engine splits at the natural seam: `runCodespaceOnce` = one full `devcontainer up → store containerId+desired → exec connector → await child` cycle against an injected signal (no `process.once` handlers of its own); `superviseCodespace` = that cycle under the Task-8-of-SP2 `supervise` loop; the `codespace up` verb keeps its exact behavior = install handlers + `superviseCodespace`.

**Deliberate behavior change (flagged as an SP4 deviation):** SP2 ran `devcontainer up` once and supervised only the exec. After this refactor every restart cycle re-runs `devcontainer up` first — idempotent and near-instant when the container is already running (design §5.4), and it HEALS a container that stopped underneath the supervisor (the exact reconcile case). The restart-with-backoff semantics are unchanged (`supervise` is untouched).

Refactor task: no new unit test (the engine's spawning branches remain conformance-covered per SP2 decisions #5/#9; every pure part is already tested). Verification = typecheck + the untouched suites.

**Files:**
- Modify: `cli/src/codespace/up.ts`

- [ ] **Step 1: Implement**

In `cli/src/codespace/up.ts`, replace the whole `runCodespace` function (keep its imports; `supervise`, `realTimers`, `narrate`, `stageRuntimeDir`, `updateContainerId`, `setDesired`, `ensureDevcontainersCli` are already imported) with:

```ts
/** One full engine cycle against an injected signal (SP4 decision #2): up →
 *  record containerId + desired → exec the connector → await it. Re-running
 *  `devcontainer up` each cycle is deliberate — idempotent when the container
 *  is live (design §5.4) and it heals one that stopped under the supervisor.
 *  Installs NO signal handlers: the caller owns the AbortController. */
export async function runCodespaceOnce(plan: UpPlan, conn: Conn, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
	const runner = await ensureDevcontainersCli(env)
	const childEnv = { ...env, ...plan.runnerEnv } as Record<string, string>

	narrate(`ensembleworks: devcontainer up — ${plan.branch ? `${plan.repo}@${plan.branch}` : plan.repo} (${plan.workspaceFolder})`)
	stageRuntimeDir(plan.runtimeDir, plan.connectorBin)
	const up = Bun.spawnSync(plan.upArgv, { env: childEnv, stdout: 'pipe', stderr: 'inherit' })
	if (up.exitCode !== 0) throw new CliError(`devcontainer up exited ${up.exitCode}`, 1)
	const result = parseUpResult(up.stdout.toString())
	updateContainerId(codespacesPath(env), plan.workspaceFolder, result.containerId)
	setDesired(codespacesPath(env), plan.workspaceFolder, 'up') // decision #1: live up claims reconciler management
	narrate(`ensembleworks: container ${result.containerId.slice(0, 12)} up; starting connector (gateway ${plan.gatewayId})`)

	const execArgv = buildExecArgv(runner, plan.workspaceFolder, conn, plan, { redact: false })
	const child = Bun.spawn(execArgv, { env: childEnv, stdout: 'inherit', stderr: 'inherit' })
	const onAbort = () => child.kill() // SIGTERM → the connector snapshots its layout, then exits
	signal.addEventListener('abort', onAbort)
	try {
		const code = await child.exited
		if (!signal.aborted) narrate(`ensembleworks: connector exec for ${plan.gatewayId} exited ${code}; restarting with backoff`)
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

/** The cycle under the restart loop, until the caller's signal aborts. */
export async function superviseCodespace(plan: UpPlan, conn: Conn, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
	await supervise(() => runCodespaceOnce(plan, conn, env, signal), { timers: realTimers, rng: Math.random }, signal)
}

/** The `codespace up` verb's live engine: own the signals, run one codespace. */
async function runCodespace(plan: UpPlan, conn: Conn, env: NodeJS.ProcessEnv): Promise<number> {
	const ac = new AbortController()
	const onSignal = () => ac.abort()
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	try {
		await superviseCodespace(plan, conn, env, ac.signal)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	narrate('ensembleworks: codespace connector stopped (container left running — `ew codespace stop` to stop it)')
	return 0
}
```

- [ ] **Step 2: Verify**

Run: `cd cli && bunx tsc --noEmit && cd .. && bun cli/src/codespace/up.test.ts && bun cli/src/codespace/supervise.test.ts`
Expected: typecheck exit 0; both suites PASS unchanged (the refactor moves only live-engine code).

- [ ] **Step 3: Commit**

```bash
git add cli/src/codespace/up.ts
git commit -m "refactor(cli): split engine into runCodespaceOnce/superviseCodespace on an injected signal" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `ew codespace reconcile`

Decision #2: idempotent, walks the store, and for every `desired: 'up'` entry resolves conn (pinned to the record's stored `canvasUrl` — creds overlay from `hosts.toml`/env exactly as everywhere else) + plan, then supervises ALL of them in one foreground process: parallel `superviseCodespace` loops under one AbortController. Resilience rules: a checkout directory that no longer exists is skipped with narration (never fatal); a per-entry plan-resolution failure is narrated and skipped; `supervise` already absorbs cycle failures with backoff. `--dry-run` prints the full per-entry plan set (UpPlans are already secret-REDACTED by construction — SP2 deviation (d) pays off here).

**Files:**
- Create: `cli/src/codespace/reconcile.ts`
- Create: `cli/src/codespace/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/reconcile.test.ts`:

```ts
// reconcile, the network-free half (SP4 decision #2): planning walks the
// store, targets ONLY desired-up entries, skips missing checkouts with a
// reason, ignores desired-stopped/unmanaged records, resolves each entry's
// conn from its OWN stored canvasUrl, and the printed --dry-run plan is
// secret-free. Live parallel supervision is covered by the manual rehearsal
// (spawns docker) — planning is the testable brain.
// Run with: bun src/codespace/reconcile.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codespaceReconcile, planReconcile } from './reconcile.ts'
import { codespacesPath, saveCodespaces, type CodespacesFile } from './store.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-reconcile-'))
const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(tmp, 'config'),
	XDG_DATA_HOME: path.join(tmp, 'data'),
	EW_CONNECTOR_BIN: path.join(tmp, 'stub-connector'),
	ENSEMBLEWORKS_TOKEN_ID: 'tid.access',
	ENSEMBLEWORKS_TOKEN_SECRET: 'sekrit-token-value',
} as NodeJS.ProcessEnv
writeFileSync(path.join(tmp, 'stub-connector'), '#!/bin/sh\n')

// A real checkout for the healthy desired-up entry.
const repoDir = path.join(tmp, 'liverepo')
mkdirSync(repoDir)
Bun.spawnSync(['git', 'init', '-b', 'main', repoDir])
Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x'], { cwd: repoDir })
const liveKey = realpathSync(repoDir)

const store: CodespacesFile = {
	codespaces: {
		[liveKey]: { gatewayId: 'cs-liverepo-aabbccdd', repo: 'liverepo', branch: 'main', canvasUrl: 'http://localhost:8788', desired: 'up' },
		'/gone/checkout': { gatewayId: 'cs-checkout-99887766', repo: 'checkout', branch: 'main', canvasUrl: 'http://localhost:8788', desired: 'up' },
		'/stopped/one': { gatewayId: 'cs-one-11223344', repo: 'one', branch: '', canvasUrl: 'http://localhost:8788', desired: 'stopped' },
		'/unmanaged/two': { gatewayId: 'cs-two-55667788', repo: 'two', branch: '', canvasUrl: 'http://localhost:8788' },
	},
}
saveCodespaces(codespacesPath(env), store)

// planReconcile: one target (with a full UpPlan), one skip, nothing else.
{
	const plan = await planReconcile(env)
	assert.equal(plan.targets.length, 1, 'only the live desired-up entry is a target')
	const t = plan.targets[0]!
	assert.equal(t.workspaceFolder, liveKey)
	assert.equal(t.plan.gatewayId, 'cs-liverepo-aabbccdd', 'reuses the stored id, never re-mints')
	assert.ok(t.plan.upArgv.includes('--workspace-folder'), 'carries the full SP2 UpPlan')
	// targets[].conn deliberately carries the LIVE token pair (the engine needs
	// it and it is never printed); every printable part must be secret-free.
	assert.ok(!JSON.stringify(plan.targets.map((x) => x.plan)).includes('sekrit-token-value'), 'the printable UpPlans are secret-free')
	assert.ok(!JSON.stringify(plan.skipped).includes('sekrit-token-value'))
	assert.deepEqual(plan.skipped, [{ workspaceFolder: '/gone/checkout', reason: 'checkout missing' }])
}

// The slot: --dry-run prints that plan as JSON, exit 0, no spawning.
{
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	let code: number
	try {
		code = await codespaceReconcile([], { refresh: false, json: false, dryRun: true, help: false }, env)
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(code, 0)
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.targets.length, 1)
	assert.equal(printed.targets[0].plan.gatewayId, 'cs-liverepo-aabbccdd')
	assert.equal(printed.skipped.length, 1)
	assert.ok(!outChunks.join('').includes('sekrit-token-value'), 'dry-run output is secret-free')
}

// Empty/no-target store: exit 0 quietly (idempotent no-op) — both dry and live
// (live with zero targets spawns nothing, so it is safe to call here).
{
	saveCodespaces(codespacesPath(env), { codespaces: {} })
	assert.equal(await codespaceReconcile([], { refresh: false, json: false, dryRun: true, help: false }, env), 0)
	assert.equal(await codespaceReconcile([], { refresh: false, json: false, dryRun: false, help: false }, env), 0, 'live no-op exits 0 without supervising')
}

// Unknown flags refused.
await assert.rejects(
	() => codespaceReconcile(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, env),
	/unknown codespace reconcile flag/,
)

console.log('ok: reconcile plan — desired filtering, missing-checkout skip, stored-id reuse, secret-free, no-op exit')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/reconcile.test.ts`
Expected: FAIL — cannot resolve `./reconcile.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/reconcile.ts`:

```ts
/**
 * `ew codespace reconcile` (SP4 decision #2, design §6): drive reality toward
 * codespaces.json's desired-state. Idempotent by construction: `devcontainer
 * up` is idempotent, gatewayIds are stable, and re-running reconcile
 * re-attaches rather than duplicating. Every desired-up entry gets its own
 * superviseCodespace loop; all loops run in ONE foreground process under ONE
 * AbortController — this process IS what the systemd unit (boot-install)
 * keeps alive. Resilience: missing checkouts and per-entry plan failures are
 * narrated and skipped, never fatal; cycle failures back off inside supervise.
 */
import { existsSync } from 'node:fs'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, narrate } from '../output.ts'
import { type Conn, readEnv, resolveConn } from '../resolve.ts'
import { codespacesPath, loadCodespaces } from './store.ts'
import { resolveUpPlan, superviseCodespace, type UpPlan } from './up.ts'

export interface ReconcilePlan {
	targets: Array<{ workspaceFolder: string; plan: UpPlan; conn: Conn }>
	skipped: Array<{ workspaceFolder: string; reason: string }>
}

/** Walk the store; resolve a full (conn, UpPlan) per healthy desired-up entry.
 *  Conn is pinned to each record's OWN canvasUrl (a boot-time reconcile has no
 *  flags/env url) — creds overlay from hosts.toml/env exactly as everywhere. */
export async function planReconcile(env: NodeJS.ProcessEnv): Promise<ReconcilePlan> {
	const store = loadCodespaces(codespacesPath(env))
	const targets: ReconcilePlan['targets'] = []
	const skipped: ReconcilePlan['skipped'] = []
	for (const [workspaceFolder, rec] of Object.entries(store.codespaces)) {
		if (rec.desired !== 'up') continue
		if (!existsSync(workspaceFolder)) {
			skipped.push({ workspaceFolder, reason: 'checkout missing' })
			continue
		}
		try {
			const conn = resolveConn({ url: rec.canvasUrl }, readEnv(env), loadHosts(hostsPath(env)))
			const plan = await resolveUpPlan(conn, workspaceFolder, env, { removeExisting: false })
			targets.push({ workspaceFolder, plan, conn })
		} catch (err) {
			skipped.push({ workspaceFolder, reason: (err as Error).message })
		}
	}
	return { targets, skipped }
}

export async function codespaceReconcile(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace reconcile flag: ${args[0]}`, 2)
	const plan = await planReconcile(env)
	if (globals.dryRun) {
		// conn carries the live token pair — print only the redacted parts.
		emitJson({ targets: plan.targets.map(({ workspaceFolder, plan }) => ({ workspaceFolder, plan })), skipped: plan.skipped })
		return 0
	}
	for (const s of plan.skipped) narrate(`ensembleworks: reconcile skipping ${s.workspaceFolder} — ${s.reason}`)
	if (plan.targets.length === 0) {
		narrate('ensembleworks: reconcile — nothing desired up; done')
		return 0
	}
	narrate(`ensembleworks: reconciling ${plan.targets.length} codespace(s): ${plan.targets.map((t) => t.plan.gatewayId).join(', ')}`)
	const ac = new AbortController()
	const onSignal = () => ac.abort()
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	try {
		// One loop per codespace, all under the one signal (decision #2). Each
		// supervise absorbs its own failures — one broken codespace must never
		// take the others down; catch is belt-and-braces for non-cycle throws.
		await Promise.all(
			plan.targets.map((t) =>
				superviseCodespace(t.plan, t.conn, env, ac.signal).catch((err) =>
					narrate(`ensembleworks: reconcile loop for ${t.plan.gatewayId} ended: ${(err as Error).message}`),
				),
			),
		)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	narrate('ensembleworks: reconcile stopped')
	return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/reconcile.test.ts`
Expected: PASS — `ok: reconcile plan — desired filtering, missing-checkout skip, stored-id reuse, secret-free, no-op exit`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/reconcile.ts cli/src/codespace/reconcile.test.ts
git commit -m "feat(cli): codespace reconcile — parallel supervision of all desired-up codespaces" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `ew codespace boot-install` — systemd user unit

Decision #3 (design open-decision 4 resolved): Linux-only v1, writes `~/.config/systemd/user/ensembleworks-codespaces.service` running `reconcile`, enables it. Unit tests cover the pure text/path/ExecStart generation and `--dry-run`; the actual `systemctl` invocations are two exact-argv spawns exercised by the manual rehearsal (Task 10). ExecStart resolution: compiled → `<execPath> codespace reconcile`; dev checkout → `<bun> <abs cli/src/main.ts> codespace reconcile` (systemd wants absolute paths; both are). `enable` only — NOT `--now`: starting reconcile during install while a foreground `ew codespace up` supervisor is running would race two connectors for one gateway; the narration tells the user how to start it now.

**Files:**
- Create: `cli/src/codespace/boot-install.ts`
- Create: `cli/src/codespace/boot-install.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/boot-install.test.ts`:

```ts
// boot-install (SP4 decision #3): pure unit-file generation (ExecStart for
// compiled vs dev, restart policy, default.target install), XDG-honoring unit
// path, the Linux-only guard (platform injected), and --dry-run printing
// { unitPath, unitText, enableArgv } without touching systemctl or the FS.
// Run with: bun src/codespace/boot-install.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import { bootExecStart, bootUnitText, codespaceBootInstall, unitPath } from './boot-install.ts'

// ExecStart: compiled → the ew binary itself; dev → bun + the abs main.ts.
{
	assert.equal(bootExecStart(true, '/usr/local/bin/ew', '/repo/cli/src/main.ts'), '/usr/local/bin/ew codespace reconcile')
	assert.equal(bootExecStart(false, '/usr/bin/bun', '/repo/cli/src/main.ts'), '/usr/bin/bun /repo/cli/src/main.ts codespace reconcile')
}

// Unit text: the full systemd contract, line-exact.
{
	const text = bootUnitText('/usr/local/bin/ew codespace reconcile')
	assert.equal(text, `[Unit]
Description=EnsembleWorks Codespaces reconciler
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/ew codespace reconcile
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`)
}

// Unit path: XDG_CONFIG_HOME honored; ~/.config fallback.
{
	assert.equal(
		unitPath({ XDG_CONFIG_HOME: '/tmp/cfg' } as NodeJS.ProcessEnv),
		path.join('/tmp/cfg', 'systemd', 'user', 'ensembleworks-codespaces.service'),
	)
	assert.ok(unitPath({} as NodeJS.ProcessEnv).endsWith(path.join('.config', 'systemd', 'user', 'ensembleworks-codespaces.service')))
}

// Linux-only guard (platform injected — testable on any host).
await assert.rejects(
	() => codespaceBootInstall([], { refresh: false, json: false, dryRun: true, help: false }, process.env, 'darwin'),
	(e: unknown) => e instanceof CliError && e.exitCode === 2 && /Linux-only/.test(e.message),
	'non-linux platforms are refused with the v1 boundary message',
)

// --dry-run: prints unitPath + unitText + the exact systemctl argvs; writes nothing.
{
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-boot-'))
	const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	let code: number
	try {
		code = await codespaceBootInstall([], { refresh: false, json: false, dryRun: true, help: false }, env, 'linux')
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(code, 0)
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.unitPath, path.join(tmp, 'systemd', 'user', 'ensembleworks-codespaces.service'))
	assert.ok(printed.unitText.includes('ExecStart='), 'full unit text in the plan')
	assert.ok(printed.unitText.includes('codespace reconcile'))
	assert.deepEqual(printed.daemonReloadArgv, ['systemctl', '--user', 'daemon-reload'])
	assert.deepEqual(printed.enableArgv, ['systemctl', '--user', 'enable', 'ensembleworks-codespaces.service'])
	assert.ok(!existsSync(printed.unitPath), 'dry-run writes nothing')
}

// Unknown flags refused.
await assert.rejects(
	() => codespaceBootInstall(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, process.env, 'linux'),
	/unknown codespace boot-install flag/,
)

console.log('ok: boot-install — ExecStart modes, exact unit text, XDG path, linux guard, dry-run')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/boot-install.test.ts`
Expected: FAIL — cannot resolve `./boot-install.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/boot-install.ts`:

```ts
/**
 * `ew codespace boot-install` (SP4 decision #3; design §5.5 / open decision 4
 * resolved): reboot survival for runtime-injected codespaces NEEDS a host-side
 * unit — docker restart policies cannot re-inject the connector. Linux-only
 * v1: write ~/.config/systemd/user/ensembleworks-codespaces.service running
 * `reconcile`, `systemctl --user daemon-reload` + `enable` it. Deliberately
 * NOT `enable --now`: starting reconcile mid-install would race a foreground
 * `ew codespace up` supervisor for the same gateway — the narration says how
 * to start it. Note systemd USER units run at login, not boot; the narration
 * also points at `loginctl enable-linger` for true boot-time start.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { emitJson, narrate } from '../output.ts'
import { runningCompiled } from './devcontainers-cli.ts'

export const BOOT_UNIT_NAME = 'ensembleworks-codespaces.service'

/** Pure: the ExecStart line. Compiled → the ew binary is the whole command;
 *  dev checkout → bun + the absolute main.ts (systemd wants absolute paths). */
export function bootExecStart(compiled: boolean, execPath: string, mainTsPath: string): string {
	return compiled ? `${execPath} codespace reconcile` : `${execPath} ${mainTsPath} codespace reconcile`
}

/** Pure: the full unit text (line-exact — the test pins it). */
export function bootUnitText(execStart: string): string {
	return `[Unit]
Description=EnsembleWorks Codespaces reconciler
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=${execStart}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

export function unitPath(env: NodeJS.ProcessEnv): string {
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(configHome, 'systemd', 'user', BOOT_UNIT_NAME)
}

export async function codespaceBootInstall(
	args: string[],
	globals: Globals,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace boot-install flag: ${args[0]}`, 2)
	if (platform !== 'linux') {
		throw new CliError('codespace boot-install is Linux-only in v1 (systemd user service); a macOS login item is deferred', 2)
	}
	const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url)) // dev-mode only; compiled never reads it
	const execStart = bootExecStart(runningCompiled(), process.execPath, mainTsPath)
	const file = unitPath(env)
	const unitText = bootUnitText(execStart)
	const daemonReloadArgv = ['systemctl', '--user', 'daemon-reload']
	const enableArgv = ['systemctl', '--user', 'enable', BOOT_UNIT_NAME]
	if (globals.dryRun) {
		emitJson({ unitPath: file, unitText, daemonReloadArgv, enableArgv })
		return 0
	}
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, unitText)
	for (const argv of [daemonReloadArgv, enableArgv]) {
		const res = Bun.spawnSync(argv, { stdout: 'inherit', stderr: 'inherit' })
		if (res.exitCode !== 0) throw new CliError(`${argv.join(' ')} exited ${res.exitCode}`, 1)
	}
	narrate(`ensembleworks: installed + enabled ${BOOT_UNIT_NAME} (${file})`)
	narrate('ensembleworks: it starts at your next login — start now with: systemctl --user start ensembleworks-codespaces.service')
	narrate('ensembleworks: to run before login after reboot, enable lingering: loginctl enable-linger $USER')
	return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/boot-install.test.ts`
Expected: PASS — `ok: boot-install — ExecStart modes, exact unit text, XDG path, linux guard, dry-run`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/boot-install.ts cli/src/codespace/boot-install.test.ts
git commit -m "feat(cli): codespace boot-install — systemd user unit for the reconciler (linux v1)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Dispatch wiring + help text

**Files:**
- Modify: `cli/src/codespace/index.ts`
- Modify: `cli/src/codespace/group.test.ts` (extend)
- Modify: `cli/src/dispatch.ts` (help line only)

- [ ] **Step 1: Write the failing tests**

In `cli/src/codespace/group.test.ts`, update the two verb-menu assertions to expect the widened menu:

```ts
	assert.match(r.err, /unknown codespace command: frobnicate .*up \| stop \| rebuild \| list \| reconcile \| boot-install/)
```

and

```ts
	assert.match(r.err, /unknown codespace command: \(none\) .*reconcile \| boot-install/)
```

Append before the final `console.log` (the empty isolated store makes reconcile's dry-run a pure no-op, so this is network-free):

```ts
// reconcile dispatches: --dry-run against the empty store prints the empty plan.
{
	const r = await captureStd(() => main(['codespace', 'reconcile', '--dry-run'], env))
	assert.equal(r.code, 0)
	assert.deepEqual(JSON.parse(r.out), { targets: [], skipped: [] }, 'reconcile wired through dispatch')
}
// boot-install dispatches: --dry-run emits the unit plan (linux CI; the verb
// guard is platform-injected and covered in boot-install.test.ts).
if (process.platform === 'linux') {
	const r = await captureStd(() => main(['codespace', 'boot-install', '--dry-run'], env))
	assert.equal(r.code, 0)
	assert.ok(JSON.parse(r.out).unitText.includes('codespace reconcile'), 'boot-install wired through dispatch')
}
```

Update its final line to:

```ts
console.log('ok: codespace group — verb menu, list --json end-to-end, reconcile/boot-install dispatch, top help')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/group.test.ts`
Expected: FAIL — the widened verb-menu regex does not match (the group still advertises only `up | stop | rebuild | list`).

- [ ] **Step 3: Implement**

In `cli/src/codespace/index.ts`, add the imports:

```ts
import { codespaceBootInstall } from './boot-install.ts'
import { codespaceReconcile } from './reconcile.ts'
```

add two cases before `default`:

```ts
		case 'reconcile':
			return codespaceReconcile(args.slice(1), globals, env)
		case 'boot-install':
			return codespaceBootInstall(args.slice(1), globals, env)
```

and widen the default's menu:

```ts
			throw new CliError(`unknown codespace command: ${verb ?? '(none)'} (expected up | stop | rebuild | list | reconcile | boot-install)`, 2)
```

In `cli/src/dispatch.ts`, update `printTopHelp()`'s native line to:

```ts
	emitLine('native: auth login|status|logout · codespace up|stop|rebuild|list|reconcile|boot-install · tools [refresh] · version · terminal connect · canvas pull-images · file open|refresh <path>')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/codespace/group.test.ts && bun cli/src/cli-api.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/index.ts cli/src/codespace/group.test.ts cli/src/dispatch.ts
git commit -m "feat(cli): wire codespace reconcile/boot-install into dispatch + help" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification + the manual rehearsal (documented)

- [ ] **Step 1: Typecheck everything**

Run: `bun run typecheck`
Expected: exit 0 across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: `all N suites passed` — the glob picks up `layout.test.ts`, `reconcile.test.ts`, `boot-install.test.ts`, `connector-layout-loopback.test.ts` and every modified suite automatically; nothing here needs docker or external network.

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short   # should be clean
```

- [ ] **Step 4: The manual rehearsal (spec §7 — "a real reboot-and-reconcile"; docker + systemd, NOT a glob test)**

Run once on a real Linux host with docker, during execution or at the owner's gate; paste the observed results into the Execution notes below. This is SP4's acceptance evidence, the analogue of SP2's conformance smoke:

1. **Desired-state + reconcile round-trip.** In a repo with a devcontainer:
   `ew codespace up` → Ctrl-C it → `ew codespace reconcile --dry-run` shows the
   entry as a target → `ew codespace reconcile` brings the terminal back on the
   canvas under the SAME gatewayId/shape (no duplicate). Then `ew codespace
   stop` from the checkout, `reconcile --dry-run` again → zero targets.
2. **Layout restore across a container stop/start.** With a codespace up:
   open two terminals on the canvas, `cd` one into a subdirectory, generate
   some output. `ew codespace stop`, then `ew codespace up` again. Both
   terminal shapes come back; the moved one is at a fresh prompt IN its
   subdirectory with the pre-stop output visible as replayed history.
   (This exercises SIGTERM-snapshot → container-disk survival → preseed.)
3. **Boot packaging.** `ew codespace boot-install` (using a compiled `ew` or
   the dev checkout), `systemctl --user start ensembleworks-codespaces.service`,
   `systemctl --user status` shows reconcile supervising; reboot the host (or
   `systemctl --user restart`), confirm the codespace terminal reappears
   without any manual command. Optionally verify `loginctl enable-linger`
   pre-login start.
4. **Rebuild honesty check.** `ew codespace rebuild`: terminals come back at
   fresh prompts WITHOUT history/cwd restore (the layout file lived on the
   container disk that rebuild discards) — this is the designed §5.3 behavior,
   not a bug.

Done. Hand off per superpowers:finishing-a-development-branch — PR body must include:
`ux-contract: none — CLI/connector host tooling; no interaction-bearing surface`

---

## Execution notes

*(filled during execution — paste the Task 10 manual-rehearsal observations here, dated)*

**2026-07-21 — Task 10, steps 1–3 (automated verification):**

- Step 1 (`bun run typecheck`): exit 0 across all 13 workspaces (contracts,
  interaction-contracts, canvas-model, canvas-doc, canvas-sync, canvas-editor,
  canvas-react, client, server, transcriber, cli, discord, e2e).
- Step 2 (`bun run test`): `all 230 suites passed`, including
  `cli/src/connector/layout.test.ts`, `cli/src/codespace/reconcile.test.ts`,
  `cli/src/codespace/boot-install.test.ts`, and
  `server/src/connector-layout-loopback.test.ts` picked up by the glob as
  expected — no docker, no external network.
- Step 3 (`git status --short`): clean modulo the pre-existing untracked
  `.superpowers/` directory (present before this task began; unrelated to
  this plan).
- Step 4 (the manual rehearsal — real docker + systemd, a real reboot) was
  **not** performed in this session: the executing environment's standing
  instructions forbid `systemctl`/`loginctl` mutations here (boot-install
  live steps are reserved for the owner's manual rehearsal; only `--dry-run`
  and pure unit-text tests run in this environment). This step remains
  outstanding — the owner should run the four numbered scenarios above on a
  real Linux host and paste the results here before treating SP4 as fully
  accepted.

---

## Out of scope for this plan (later work / deliberate v1 boundaries)

- macOS login-item boot packaging (decision #3: Linux-only v1).
- Layout survival across `rebuild` (state-B honesty, design §5.2/§5.3: the
  container disk is the storage; a named-volume story is a future extension).
- Scrollback beyond the 64 KiB per-session tail; any attempt at process
  restore (CRIU explicitly rejected, design §5.3).
- Layout restore for the tmux backend (the tmux server already is its layout).
- `clone-if-absent` in the reconciler (design §6 mentions it; v1 skips missing
  checkouts with narration — cloning needs remote-URL state the store does not
  yet hold).
- Any daemon beyond the systemd-owned foreground `reconcile` process; any
  change to the legacy `:8789` gateway or the SP2/SP3 surfaces beyond the
  seams named in the file map.
