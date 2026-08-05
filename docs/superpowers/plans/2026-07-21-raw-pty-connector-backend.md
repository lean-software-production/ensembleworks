# Raw-PTY Connector Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `cli` connector a second, tmux-free spawn backend — the connector owns a raw PTY running the user's login shell — selected by `ew terminal connect --backend pty`, with the tmux path remaining the untouched default.

**Architecture:** Sub-project 1 of `docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md` (§6.1). The `ConnectorSessionManager` is already backend-agnostic via its `SpawnFactory` constructor arg (`cli/src/connector/session.ts:35`) — scrollback ring, fan-out, authoritative resize, exit broadcast all live there and need **zero changes**. The whole job is: (1) a new spawn *policy* in contracts (`canvasShellSpawnSpec` — the user's login shell instead of `tmux new-session`), (2) a `--backend tmux|pty` flag on `terminal connect`, (3) a pure `spawnSpecFor` selector wiring the flag to the factory, (4) an end-to-end loopback test proving a real shell round-trips through the real relay with **no tmux on the box**. Accepted trade (spec §6.1 / design doc §7): with `--backend pty` the shells die with the connector process; `detachAll` on link loss still keeps them (the connector survives link loss — only channels drop).

**Tech Stack:** Bun + TypeScript. Tests are plain `bun <file>` scripts using `node:assert/strict` (no test framework — see `scripts/run-tests.ts`). PTY via `contracts/src/pty.ts` (`Bun.spawn` terminal API).

**Branch:** start from a clean `main`: `git checkout main && git pull && git checkout -b feature/raw-pty-connector`.

**Interaction contracts:** this sub-project touches no interaction-bearing surface (CLI + contracts + a server-side test only; no client code). The PR body MUST record: `ux-contract: none — connector spawn backend + CLI flag; no interaction-bearing surface touched`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `contracts/src/session-manager.ts` | Modify | Add `canvasShellSpawnSpec` — the raw-login-shell spawn policy (env hygiene identical to `canvasTmuxSpawnSpec`) |
| `contracts/src/session-manager.test.ts` | Modify | Spec-shape tests + a real-shell PTY round-trip through the new spec |
| `cli/src/native/connect.ts` | Modify | `--backend tmux\|pty` flag; `ConnectConfig.backend` |
| `cli/src/native/connect.test.ts` | Modify | Flag parsing / default / validation / dry-run tests |
| `cli/src/connector/index.ts` | Modify | `spawnSpecFor(backend, sessionId, env)` selector; `runConnector` uses it |
| `cli/src/connector/spawn-spec.test.ts` | Create | Pure tests for `spawnSpecFor` |
| `server/src/connector-pty-loopback.test.ts` | Create | Booted end-to-end proof: real connector, `--backend pty`, real relay, no tmux |

---

### Task 1: `canvasShellSpawnSpec` in contracts

**Files:**
- Modify: `contracts/src/session-manager.ts` (append after `canvasTmuxSpawnSpec`, which ends at line 129)
- Test: `contracts/src/session-manager.test.ts` (append at end of file)

- [ ] **Step 1: Write the failing test**

Append to `contracts/src/session-manager.test.ts`:

```ts
// canvasShellSpawnSpec (EW Codespaces §6.1): the raw-login-shell spawn policy.
// Same env hygiene as canvasTmuxSpawnSpec (credential scrub, xterm-256color,
// C.UTF-8 guarantee), but the file is the user's shell and there is no tmux.
{
  const prev = {
    tokenId: process.env.ENSEMBLEWORKS_TOKEN_ID,
    tokenSecret: process.env.ENSEMBLEWORKS_TOKEN_SECRET,
    shell: process.env.SHELL,
    lang: process.env.LANG,
    lcAll: process.env.LC_ALL,
    lcCtype: process.env.LC_CTYPE,
  }
  try {
    process.env.ENSEMBLEWORKS_TOKEN_ID = 'tid'
    process.env.ENSEMBLEWORKS_TOKEN_SECRET = 'tsec'

    // Explicit opts win.
    const spec = canvasShellSpawnSpec({ shell: '/bin/bash', home: '/tmp' })
    assert.equal(spec.file, '/bin/bash', 'explicit shell wins')
    assert.deepEqual(spec.args, ['-l'], 'login shell, no tmux args')
    assert.equal(spec.cwd, '/tmp', 'explicit home wins')
    assert.equal(spec.env.TERM, 'xterm-256color')
    assert.equal(spec.env.COLORFGBG, '0;15')
    assert.ok(!('ENSEMBLEWORKS_TOKEN_ID' in spec.env), 'token id scrubbed')
    assert.ok(!('ENSEMBLEWORKS_TOKEN_SECRET' in spec.env), 'token secret scrubbed')

    // Shell default chain: $SHELL, then /bin/bash.
    process.env.SHELL = '/usr/bin/fish'
    assert.equal(canvasShellSpawnSpec().file, '/usr/bin/fish', 'defaults to $SHELL')
    delete process.env.SHELL
    assert.equal(canvasShellSpawnSpec().file, '/bin/bash', 'falls back to /bin/bash')

    // Locale guarantee (the LC_CTYPE foot-gun): no locale var → LANG=C.UTF-8;
    // an operator's own locale is never overridden.
    delete process.env.LANG
    delete process.env.LC_ALL
    delete process.env.LC_CTYPE
    assert.equal(canvasShellSpawnSpec().env.LANG, 'C.UTF-8', 'LANG guaranteed when no locale var set')
    process.env.LC_ALL = 'en_GB.UTF-8'
    assert.ok(!('LANG' in canvasShellSpawnSpec().env) || canvasShellSpawnSpec().env.LANG !== 'C.UTF-8', 'operator locale not overridden')
  } finally {
    for (const [k, v] of [
      ['ENSEMBLEWORKS_TOKEN_ID', prev.tokenId],
      ['ENSEMBLEWORKS_TOKEN_SECRET', prev.tokenSecret],
      ['SHELL', prev.shell],
      ['LANG', prev.lang],
      ['LC_ALL', prev.lcAll],
      ['LC_CTYPE', prev.lcCtype],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  console.log('ok: canvasShellSpawnSpec — shell resolution, env hygiene, locale guarantee')
}
```

Also add `canvasShellSpawnSpec` to the import at the top of the test file:

```ts
import { canvasShellSpawnSpec, canvasTmuxSpawnSpec, openTmuxSession } from './session-manager.js'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun contracts/src/session-manager.test.ts`
Expected: FAIL — `SyntaxError`/export error: `canvasShellSpawnSpec` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `contracts/src/session-manager.ts` (after `canvasTmuxSpawnSpec`):

```ts
export interface CanvasShellSpawnOptions {
	/** shell binary; defaults to $SHELL then /bin/bash. */
	shell?: string
	/** cwd for the shell; defaults to $HOME then process.cwd(). */
	home?: string
}

/** The raw-shell spawn policy for connector-owned PTYs (EW Codespaces
 *  coexistence spec §6.1 / design doc §7): the user's login shell directly on
 *  the PTY — no tmux anywhere. Env hygiene is identical to canvasTmuxSpawnSpec:
 *  credential scrub, xterm-256color, light-bg hint, and the C.UTF-8 locale
 *  guarantee (same LC_CTYPE foot-gun, same non-override rule). Trade-off owned
 *  by the caller: sessions spawned this way die with the spawning process. */
export function canvasShellSpawnSpec(opts: CanvasShellSpawnOptions = {}): SpawnSpec {
	const parentEnv = { ...(process.env as Record<string, string>) }
	for (const k of SPAWN_ENV_SCRUB) delete parentEnv[k]
	const env: Record<string, string> = {
		...parentEnv,
		TERM: 'xterm-256color',
		COLORFGBG: '0;15', // light-bg hint (same rationale as canvasTmuxSpawnSpec)
	}
	if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'C.UTF-8'
	return {
		file: opts.shell ?? process.env.SHELL ?? '/bin/bash',
		args: ['-l'], // login shell (bash/zsh/fish all accept -l) — profile loads, like a Codespaces terminal
		cwd: opts.home ?? process.env.HOME ?? process.cwd(),
		env,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun contracts/src/session-manager.test.ts`
Expected: PASS — all existing `ok:` lines plus `ok: canvasShellSpawnSpec — shell resolution, env hygiene, locale guarantee`.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/session-manager.ts contracts/src/session-manager.test.ts
git commit -m "feat(contracts): canvasShellSpawnSpec — raw login-shell spawn policy for connector-owned PTYs"
```

---

### Task 2: Real-shell round-trip through the new spec

Proves the new spec actually drives a live PTY end-to-end through the existing `openTmuxSession` primitive (which is spec-generic despite its name — it just spawns a `SpawnSpec` on a PTY): output round-trip, then a clean `exit` firing `onExit`. This is a test-only task (the code under test exists after Task 1).

**Files:**
- Test: `contracts/src/session-manager.test.ts` (append after the Task 1 block)

- [ ] **Step 1: Write the test**

```ts
// Round-trip a REAL shell through canvasShellSpawnSpec — no tmux involved:
// spawn, echo a marker, then `exit` and observe onExit. Shell is forced to
// bash for determinism (CI boxes may not set $SHELL).
{
  const spec = canvasShellSpawnSpec({ shell: 'bash', home: os.tmpdir() })
  const sh = openTmuxSession(spec, 80, 24)
  let acc = ''
  const ready = new Promise<void>((resolve) => {
    sh.onData((d) => {
      acc += d
      if (acc.includes('PTY_OK')) resolve()
    })
  })
  const gone = new Promise<void>((resolve) => sh.onExit(() => resolve()))
  sh.write('printf PTY_OK\r')
  await Promise.race([
    ready,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`no PTY_OK in 5s; got: ${acc.slice(-300)}`)), 5000)),
  ])
  sh.write('exit\r')
  await Promise.race([
    gone,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('shell did not exit in 5s')), 5000)),
  ])
  console.log('ok: raw shell round-trip through canvasShellSpawnSpec (no tmux)')
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun contracts/src/session-manager.test.ts`
Expected: PASS, ending with `ok: raw shell round-trip through canvasShellSpawnSpec (no tmux)`.

(If it fails, the spec is wrong — e.g. `-l` startup noise never delivering, or env scrub broke PATH. Fix `canvasShellSpawnSpec`, not the test.)

- [ ] **Step 3: Commit**

```bash
git add contracts/src/session-manager.test.ts
git commit -m "test(contracts): live PTY round-trip through canvasShellSpawnSpec"
```

---

### Task 3: `--backend tmux|pty` flag on `terminal connect`

**Files:**
- Modify: `cli/src/native/connect.ts` (`ConnectConfig` at line 21-28, `resolveConnectConfig` at 30-38, `parseConnectFlags` at 51-66)
- Test: `cli/src/native/connect.test.ts`

- [ ] **Step 1: Write the failing tests**

In `cli/src/native/connect.test.ts`, extend the first block (config resolution + defaults) with one line after the existing `authMethod` assertion:

```ts
	assert.equal(cfg.backend, 'tmux', 'backend defaults to tmux (legacy path unchanged)')
```

Extend the "Explicit flags win" block:

```ts
// Explicit flags win.
{
	const cfg = resolveConnectConfig(conn, { label: 'my-box', gatewayId: 'fixed-id', backend: 'pty' }, process.env)
	assert.equal(cfg.label, 'my-box')
	assert.equal(cfg.gatewayId, 'fixed-id')
	assert.equal(cfg.backend, 'pty', 'explicit --backend pty wins')
}
```

Append a flag-validation block before the final `console.log` (and add `CliError` plus `parseConnectFlags` coverage via the slot, keeping the test network-free — invalid flags throw before any dial):

```ts
// --backend parsing: valid values pass through --dry-run; invalid rejects (exit-2 CliError).
{
	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		const code = await connectSlot(['--backend', 'pty'], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
	}
	assert.equal(JSON.parse(outChunks.join('')).backend, 'pty', '--dry-run config carries the backend')

	await assert.rejects(
		() => connectSlot(['--backend', 'screen'], { refresh: false, json: false, dryRun: true, help: false }, env),
		/--backend must be tmux or pty/,
		'invalid backend value rejected',
	)
}
```

Update the final `console.log` line to mention the new coverage:

```ts
console.log('ok: connect — ws url + stable-gateway-id/hostname defaults, flags win, --backend default/validation, --dry-run config')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun cli/src/native/connect.test.ts`
Expected: FAIL — first at `cfg.backend` being `undefined` (typecheck would also flag `backend` not on the flags type).

- [ ] **Step 3: Implement**

In `cli/src/native/connect.ts`:

`ConnectConfig` gains a field:

```ts
export interface ConnectConfig {
	url: string
	wsUrl: string
	room: string
	gatewayId: string
	label: string
	authMethod: 'service-token' | 'none'
	backend: 'tmux' | 'pty'
}
```

`resolveConnectConfig` — widen the flags param and default the backend:

```ts
export function resolveConnectConfig(
	conn: Conn,
	flags: { label?: string; gatewayId?: string; backend?: 'tmux' | 'pty' },
	env: NodeJS.ProcessEnv,
): ConnectConfig {
	const label = flags.label ?? hostname()
	const gatewayId = flags.gatewayId ?? stableGatewayId(env)
	const backend = flags.backend ?? 'tmux' // legacy default — coexistence spec §3: tmux path unchanged
	const wsBase = conn.url.replace(/^http/, 'ws') // http→ws, https→wss
	const ws = new URL('/api/terminal/connect', wsBase.endsWith('/') ? wsBase : `${wsBase}/`)
	ws.searchParams.set('gatewayId', gatewayId)
	ws.searchParams.set('label', label)
	return { url: conn.url, wsUrl: ws.toString(), room: conn.room, gatewayId, label, authMethod: conn.auth.method, backend }
}
```

`parseConnectFlags` — new case + widened return type:

```ts
function parseConnectFlags(args: string[]): { label?: string; gatewayId?: string; backend?: 'tmux' | 'pty' } {
	const flags: { label?: string; gatewayId?: string; backend?: 'tmux' | 'pty' } = {}
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--label':
				flags.label = args[++i]
				break
			case '--gateway-id':
				flags.gatewayId = args[++i]
				break
			case '--backend': {
				const v = args[++i]
				if (v !== 'tmux' && v !== 'pty') throw new CliError(`--backend must be tmux or pty, got: ${v}`, 2)
				flags.backend = v
				break
			}
			default:
				throw new CliError(`unknown terminal connect flag: ${args[i]}`, 2)
		}
	}
	return flags
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/native/connect.test.ts`
Expected: PASS. (Task 4 wires `backend` into `runConnector`; until then the field is carried but unread — the dry-run tests here never dial.)

- [ ] **Step 5: Commit**

```bash
git add cli/src/native/connect.ts cli/src/native/connect.test.ts
git commit -m "feat(cli): --backend tmux|pty flag on terminal connect (default tmux)"
```

---

### Task 4: `spawnSpecFor` selector + `runConnector` wiring

**Files:**
- Modify: `cli/src/connector/index.ts`
- Create: `cli/src/connector/spawn-spec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/connector/spawn-spec.test.ts`:

```ts
// spawnSpecFor — the per-session backend selector runConnector feeds to
// ConnectorSessionManager: 'tmux' → canvasTmuxSpawnSpec (legacy, unchanged);
// 'pty' → canvasShellSpawnSpec (connector-owned PTY, EW Codespaces §6.1).
// Pure: asserts on the returned SpawnSpec, spawns nothing.
// Run with: bun src/connector/spawn-spec.test.ts
import assert from 'node:assert/strict'
import { spawnSpecFor } from './index.ts'

const env = { HOME: '/home/u', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv

// tmux backend: the existing canvas tmux policy, session name derived from id.
{
	const spec = spawnSpecFor('tmux', 'abc', env)
	assert.equal(spec.file, 'tmux')
	assert.ok(spec.args.includes('canvas-abc'), 'tmux session name carries the canvas- prefix + session id')
	assert.equal(spec.cwd, '/home/u')
}

// pty backend: the user's login shell, no tmux anywhere, id-independent.
{
	const spec = spawnSpecFor('pty', 'abc', env)
	assert.equal(spec.file, '/bin/zsh', 'shell comes from env.SHELL')
	assert.deepEqual(spec.args, ['-l'], 'login shell, no tmux args')
	assert.equal(spec.cwd, '/home/u')
	assert.ok(!spec.args.includes('abc'), 'raw shell has no session-name arg')
}

console.log('ok: spawnSpecFor — tmux vs pty spawn policy selection')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/connector/spawn-spec.test.ts`
Expected: FAIL — `spawnSpecFor` is not exported from `./index.ts`.

- [ ] **Step 3: Implement**

In `cli/src/connector/index.ts`:

Update the contracts import (line 12) and add the selector; rewrite `runConnector`'s manager construction (lines 37-40):

```ts
import { canvasShellSpawnSpec, canvasTmuxSpawnSpec, openTmuxSession, type SpawnSpec } from '@ensembleworks/contracts/session-manager'
```

Add after `tmuxConfPath`:

```ts
/** Per-session spawn policy behind the --backend flag: 'tmux' is the legacy
 *  default (sessions survive connector restarts via the tmux server); 'pty' is
 *  the connector-owned raw login shell (EW Codespaces coexistence spec §6.1 —
 *  accepted trade: shells die with the connector; host supervision mitigates). */
export function spawnSpecFor(backend: 'tmux' | 'pty', sessionId: string, env: NodeJS.ProcessEnv): SpawnSpec {
	if (backend === 'pty') return canvasShellSpawnSpec({ shell: env.SHELL, home: env.HOME })
	return canvasTmuxSpawnSpec({ sessionId, tmuxConf: tmuxConfPath(env), home: env.HOME })
}
```

In `runConnector`, replace:

```ts
	const conf = tmuxConfPath(env)
	const mgr = new ConnectorSessionManager((id, cols, rows) =>
		openTmuxSession(canvasTmuxSpawnSpec({ sessionId: id, tmuxConf: conf, home: env.HOME }), cols, rows),
	)
```

with:

```ts
	const mgr = new ConnectorSessionManager((id, cols, rows) =>
		openTmuxSession(spawnSpecFor(cfg.backend, id, env), cols, rows),
	)
```

(`tmuxConfPath` stays — `spawnSpecFor` calls it. `canvasShellSpawnSpec` reads `env.SHELL`/`env.HOME` via explicit opts so the selector test above is deterministic.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/connector/spawn-spec.test.ts && bun cli/src/native/connect.test.ts && bun cli/src/connector/session.test.ts`
Expected: all PASS (session.test.ts proves the manager is untouched).

- [ ] **Step 5: Commit**

```bash
git add cli/src/connector/index.ts cli/src/connector/spawn-spec.test.ts
git commit -m "feat(cli): spawnSpecFor selector — runConnector honors --backend pty"
```

---

### Task 5: Booted end-to-end loopback — real relay, real shell, no tmux

The integration proof mirroring `server/src/connector-loopback.test.ts`, but with `--backend pty` and **no tmux precondition**: attached handshake, echo round-trip through a real bash on a connector-owned PTY, second-viewer session-size + scrollback replay, and — new versus the tmux twin — the **exit broadcast** (`exit` in the shell → `{type:'exit'}` at the browser), which the tmux test can't cleanly assert.

**Files:**
- Create: `server/src/connector-pty-loopback.test.ts`

- [ ] **Step 1: Write the test**

```ts
// PTY-backend loopback (EW Codespaces coexistence spec §6.1/§7): the
// connector-loopback assertions, driving the REAL Bun connector with
// --backend pty — a raw login shell on a connector-owned PTY, NO tmux on the
// box. Boot createSyncApp on an ephemeral port, spawn
// `bun cli/src/main.ts terminal connect --url … --gateway-id ptyloop --backend pty`
// (a none instance, no auth), then through /api/terminal/relay assert:
// attached handshake, echo round-trip, second-viewer session-size + scrollback
// replay, and the exit broadcast ({type:'exit'} when the shell exits).
// Precondition: bash on PATH (tmux NOT required — that's the point).
// Run with: bun src/connector-pty-loopback.test.ts
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

const SESSION = `ptytest${Date.now().toString(36).slice(-4)}`
const GATEWAY = 'ptyloop'

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

/** Resolve when a control frame matching pred arrives. */
const waitForText = (ws: WebSocket, pred: (m: any) => boolean, what: string, timeoutMs = 15_000) =>
	new Promise<any>((resolve, reject) => {
		const h = (data: Buffer, isBinary: boolean) => {
			if (isBinary) return
			const m = JSON.parse(data.toString())
			if (!pred(m)) return
			clearTimeout(timer)
			ws.off('message', h)
			resolve(m)
		}
		const timer = setTimeout(() => {
			ws.off('message', h)
			reject(new Error(`timeout waiting for ${what}`))
		}, timeoutMs)
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
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connector-pty-loopback-test-'))
		const { server: appServer } = createSyncApp({ dataDir })
		server = appServer
		await new Promise<void>((resolve) => server!.listen(0, resolve))
		const port = (server.address() as { port: number }).port
		const httpBase = `http://127.0.0.1:${port}`
		const wsBase = `ws://127.0.0.1:${port}`

		// 2. Spawn the REAL connector with --backend pty. SHELL forced to bash so
		// the spawned login shell is deterministic on any CI box.
		const cliMain = path.join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts')
		connector = spawn(
			'bun',
			[cliMain, 'terminal', 'connect', '--url', httpBase, '--gateway-id', GATEWAY, '--backend', 'pty'],
			{ env: { ...process.env, SHELL: 'bash' }, stdio: ['ignore', 'inherit', 'inherit'] },
		)
		connector.once('exit', (code) => {
			if (code && code !== 0) console.error(`[connector] exited early with code ${code}`)
		})

		// 3. Wait until connect-equals-register lands in the registry.
		await waitForGateway(httpBase, GATEWAY)

		// 4. Browser through the relay: attached handshake + echo round-trip
		// through a raw bash on a connector-owned PTY.
		const relayUrl = `${wsBase}/api/terminal/relay?session=${SESSION}&gateway=${GATEWAY}&cols=80&rows=24`
		const b1 = await openSocket(relayUrl)
		const attached = await firstText(b1)
		assert.equal(attached.type, 'attached')
		const echoed = waitForOutput(b1, 'pty-roundtrip-ok')
		b1.send(JSON.stringify({ type: 'input', data: 'echo pty-roundtrip-ok\r' }))
		await echoed

		// 5. Second viewer: attached carries the SESSION size; replays scrollback.
		const b2 = await openSocket(relayUrl.replace('cols=80', 'cols=999'))
		const attached2 = await firstText(b2)
		assert.equal(attached2.type, 'attached')
		assert.equal(attached2.cols, 80, 'attached must carry session size, not the newcomer request')
		await waitForOutput(b2, 'pty-roundtrip-ok') // scrollback replay

		// 6. Exit broadcast: `exit` ends the raw shell (no tmux server behind it) →
		// every viewer gets {type:'exit'}.
		const exit1 = waitForText(b1, (m) => m.type === 'exit', 'exit broadcast on b1')
		const exit2 = waitForText(b2, (m) => m.type === 'exit', 'exit broadcast on b2')
		b1.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
		await Promise.all([exit1, exit2])
		b1.close()
		b2.close()

		console.log('connector-pty-loopback.test.ts: all assertions passed')
		console.log('ok: connector-pty-loopback — raw-PTY backend splice: attached handshake, echo round-trip, second-viewer replay, exit broadcast (no tmux)')
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

- [ ] **Step 2: Run the test end-to-end**

Run: `bun server/src/connector-pty-loopback.test.ts`
Expected: PASS — both `ok:` lines. If step 6 times out, the exit broadcast is broken in the pty path (most likely `proc.exited` handling in `contracts/src/pty.ts` vs. the login shell) — debug there, not in the test.

- [ ] **Step 3: Sanity-check the tmux twin still passes (coexistence)**

Run: `bun server/src/connector-loopback.test.ts`
Expected: PASS unchanged (precondition: tmux on PATH).

- [ ] **Step 4: Commit**

```bash
git add server/src/connector-pty-loopback.test.ts
git commit -m "test(server): booted pty-backend loopback — real shell through the relay, no tmux"
```

---

### Task 6: Full verification

- [ ] **Step 1: Typecheck everything**

Run: `bun run typecheck`
Expected: exit 0 across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: `all N suites passed` — the discovery glob (`**/src/**/*.test.ts`) picks up the two new test files automatically.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Against a running dev stack (`bin/dev up`):

```bash
bun cli/src/main.ts terminal connect --url http://localhost:8788 --backend pty --gateway-id pty-smoke
```

Then on the canvas: new terminal → pick gateway `pty-smoke` → confirm a live shell, a second browser view of the same terminal, and resize behaving. `Ctrl-C` the connector: the shell dies (accepted §7 trade) and viewers see the terminal drop.

- [ ] **Step 4: Commit any stragglers and stop**

```bash
git status --short   # should be clean
```

Done. Hand off per superpowers:finishing-a-development-branch — PR body must include:
`ux-contract: none — connector spawn backend + CLI flag; no interaction-bearing surface touched`

---

## Out of scope for this plan (later sub-projects)

- `ew codespace up` / devcontainer anything (sub-project 2).
- Codespace shape, input ACL, registration metadata (sub-project 3).
- Layout snapshot/replay on the pty backend (sub-project 4 — the scrollback ring it will persist already exists in `ConnectorSessionManager`).
- Changing the default backend away from tmux, or any change to `server/src/terminal-gateway.ts`.
