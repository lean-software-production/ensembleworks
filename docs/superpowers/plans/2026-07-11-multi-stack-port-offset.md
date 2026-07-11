# Multi-Stack Port Offset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Run multiple EnsembleWorks dev stacks on one host via a single `ENSEMBLEWORKS_PORT_OFFSET` integer added to every dev port, with `bin/dev up` auto-picking a free offset when the defaults are taken.

**Architecture:** One offset value is resolved once (env `ENSEMBLEWORKS_PORT_OFFSET` → `.local/port-offset` file → `0`) and threaded everywhere: `bin/dev-lib.mjs` computes a `ports` map (`portsFor(offset)`) that drives every service command/health check; each service receives its port via inline env (`PORT=`, `SYNC_BASE=`, …) that the services already read; the Caddyfile gets env placeholders for its upstream targets; `vite.config.ts` computes its ports from the same env var; the devcontainer publishes host ports via `${localEnv:…:default}` substitution set by the host-side controller. LiveKit's `--dev` mode has fixed ports, so a nonzero offset switches it to a generated config yaml (dev keys + shifted ports) — the SFU's advertised media port must equal the real/published port or voice silently breaks.

**Tech Stack:** Bun-run `.mjs` (node builtins only), tmux, Caddy `{$VAR:default}` placeholders, devcontainer CLI `${localEnv:VAR:default}` substitution, LiveKit config yaml.

---

## Design reference

Offset semantics: a **raw integer added to every port**. Recommended stride is 100 (the four sync-family ports 8788–8791 are consecutive, and caddy 8080 + 10 would hit neko's 8090). Auto-pick tries 100, 200, … 900.

| service | base | +100 example |
|---|---|---|
| sync | 8788 | 8888 |
| term | 8789 | 8889 |
| discord | 8790 | 8890 |
| files | 8791 | 8891 |
| client (vite) | 5173 | 5273 |
| caddy (edge) | 8080 | 8180 |
| livekit signal | 7880 | 7980 |
| livekit ICE-TCP | 7881 | 7981 |
| livekit UDP mux | 7882 | 7982 |
| neko (shared browser) | 8090 | 8190 |
| whisper | 8091 | 8191 |

Resolution order (both engine and controller): `ENSEMBLEWORKS_PORT_OFFSET` env (empty string = unset) → `<repo>/.local/port-offset` file → `0`. The controller persists an auto-picked offset to `.local/port-offset` (git-ignored, bind-mounted, so the engine inside the container reads the same file). `containerEnv` also carries the offset for the env-only path (no file, explicit env), because `postStartCommand` runs `bin/dev up` inside the container where host env vars don't otherwise reach.

Per-offset isolation when offset ≠ 0: tmux session `workspace-<offset>`, data dir `~/.local/share/ensembleworks-<offset>` (two sync servers must not share a DATA_DIR).

Out of scope (all env-overridable already, documented in Task 9): `bin/canvas` (`CANVAS_URL`), the e2e rig (self-contained, own server on fixed 8788), Codespaces with nonzero offset, `cli/` defaults, native-mode auto-pick (native users set the offset explicitly).

---

### Task 1: Port arithmetic in dev-lib (`portsFor`, `parsePortOffset`)

**Files:**
- Modify: `bin/dev-lib.mjs:9-18` (the `PORTS` const)
- Test: `bin/dev.test.ts`

- [x] **Step 1: Write the failing tests**

Append to `bin/dev.test.ts` (imports go in the existing import block at the top — add `portsFor`, `parsePortOffset`):

```ts
// portsFor: every port shifted by the offset; 0 = the documented defaults.
{
	const base = portsFor(0)
	assert.equal(base.sync, 8788)
	assert.equal(base.caddy, 8080)
	assert.equal(base.livekit, 7880)
	assert.equal(base.livekitTcp, 7881)
	assert.equal(base.livekitUdp, 7882)
	assert.equal(base.neko, 8090)
	assert.equal(base.whisper, 8091)
	const off = portsFor(100)
	for (const [name, port] of Object.entries(base)) {
		assert.equal(off[name], port + 100, `${name} shifted by 100`)
	}
	assert.deepEqual(PORTS, base, 'PORTS stays the offset-0 map')
	console.log('ok: portsFor')
}

// parsePortOffset: unset/empty -> 0; a non-negative int string -> the int;
// anything else -> null (caller dies with the remedy).
{
	assert.equal(parsePortOffset(undefined), 0)
	assert.equal(parsePortOffset(''), 0)
	assert.equal(parsePortOffset('0'), 0)
	assert.equal(parsePortOffset('100'), 100)
	assert.equal(parsePortOffset('-1'), null)
	assert.equal(parsePortOffset('1.5'), null)
	assert.equal(parsePortOffset('abc'), null)
	assert.equal(parsePortOffset('60000'), null, 'ports must stay < 65536')
	console.log('ok: parsePortOffset')
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun bin/dev.test.ts`
Expected: FAIL — `portsFor` / `parsePortOffset` not exported.

- [x] **Step 3: Implement in `bin/dev-lib.mjs`**

Replace the `PORTS` const (lines 9–18) with:

```js
const BASE_PORTS = {
	sync: 8788,
	term: 8789,
	discord: 8790,
	files: 8791,
	client: 5173,
	caddy: 8080,
	livekit: 7880,
	livekitTcp: 7881, // ICE-TCP; published by the devcontainer
	livekitUdp: 7882, // UDP mux; published by the devcontainer. Advertised in
	// ICE candidates, so the real port MUST equal the published port.
	neko: 8090, // shared browser (native hosts with docker only)
	whisper: 8091,
}

/**
 * The dev stack's port map, shifted by ENSEMBLEWORKS_PORT_OFFSET. A raw
 * addend (recommend multiples of 100 — the sync family is 4 consecutive
 * ports, and +10 would land caddy on neko's 8090).
 * @param {number} offset
 * @returns {Record<keyof typeof BASE_PORTS, number>}
 */
export function portsFor(offset) {
	return /** @type {any} */ (
		Object.fromEntries(Object.entries(BASE_PORTS).map(([k, v]) => [k, v + offset]))
	)
}

/** The offset-0 defaults (docs, doctor, tests). */
export const PORTS = portsFor(0)

/**
 * Parse a port-offset value: unset/empty -> 0, a non-negative integer string
 * -> its value, anything else -> null (the caller dies with the remedy).
 * Capped so the largest base port stays under 65536.
 * @param {string | undefined | null} raw
 * @returns {number | null}
 */
export function parsePortOffset(raw) {
	if (raw === undefined || raw === null || raw === '') return 0
	const n = Number(raw)
	if (!Number.isInteger(n) || n < 0 || n > 57000) return null
	return n
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun bin/dev.test.ts`
Expected: all `ok:` lines including `ok: portsFor`, `ok: parsePortOffset`.

- [x] **Step 5: Typecheck and commit**

Run: `bun run typecheck` — expected clean.

```bash
git add bin/dev-lib.mjs bin/dev.test.ts
git commit -m "feat(dev): portsFor/parsePortOffset — offset-shifted dev port map"
```

---

### Task 2: Thread `ctx.ports` through the service table

**Files:**
- Modify: `bin/dev-lib.mjs` (`livekitBrowserUrl`, `attachInstructions`, `ServiceCtx` typedef, `buildServices`)
- Test: `bin/dev.test.ts`

- [x] **Step 1: Update the test baseline ctx and write failing tests**

In `bin/dev.test.ts`, extend the `ctx()` helper's object with three new properties (before `...overrides`):

```ts
		ports: portsFor(0),
		portOffset: 0,
		livekitGeneratedConf: '/home/u/.local/share/ensembleworks/livekit-dev.generated.yaml',
```

Append these tests:

```ts
// Offset ctx: every service cmd/health rides ctx.ports, and each service gets
// its port via inline env (the services read PORT etc. — see server/src).
{
	const p = portsFor(100)
	const s = buildServices(
		ctx({
			ports: p,
			portOffset: 100,
			livekitGeneratedConf: '/home/u/.local/share/ensembleworks-100/livekit-dev.generated.yaml',
		}),
	)
	const sync = svc(s, 'sync')
	assert.ok(sync.cmd.includes("PORT='8888'"), 'sync PORT shifted')
	assert.ok(sync.cmd.includes("ENSEMBLEWORKS_FILES_PORT='8891'"), 'files feature port')
	assert.ok(sync.cmd.includes("DISCORD_PORT='8890'"), 'discord feature port')
	assert.ok(sync.cmd.includes("LIVEKIT_API_URL='http://localhost:7980'"), 'RoomService port')
	assert.ok(sync.cmd.includes("LIVEKIT_URL='ws://localhost:8180/livekit'"), 'browser URL via shifted caddy')
	assert.deepEqual(sync.health, { kind: 'http', url: 'http://localhost:8888/api/health' })
	assert.ok(svc(s, 'term').cmd.includes("PORT='8889'"), 'term PORT shifted')
	assert.deepEqual(svc(s, 'term').health, { kind: 'port', port: 8889 })
	assert.ok(svc(s, 'files').cmd.includes("PORT='8891'"), 'files PORT shifted')
	assert.ok(svc(s, 'client').cmd.includes("ENSEMBLEWORKS_PORT_OFFSET='100'"), 'vite gets the offset')
	const caddy = svc(s, 'caddy')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_CADDY_SITE=':8180'"), 'edge on shifted port')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_PORT_SYNC='8888'"), 'caddy upstream: sync')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_PORT_TERM='8889'"), 'caddy upstream: term')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_PORT_CLIENT='5273'"), 'caddy upstream: client')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_PORT_LIVEKIT='7980'"), 'caddy upstream: livekit')
	assert.ok(caddy.cmd.includes("ENSEMBLEWORKS_PORT_NEKO='8190'"), 'caddy upstream: neko')
	const lk = svc(s, 'livekit')
	assert.ok(
		lk.cmd.includes("--config '/home/u/.local/share/ensembleworks-100/livekit-dev.generated.yaml'"),
		'offset livekit uses the generated config (dev mode has fixed ports)',
	)
	assert.ok(!lk.cmd.includes('--dev'), 'not dev mode when offset');
	const discord = svc(s, 'discord')
	assert.ok(discord.cmd.includes("PORT='8890'"), 'discord PORT shifted')
	assert.ok(discord.cmd.includes("SYNC_BASE='http://127.0.0.1:8888'"), 'discord dials shifted sync')
	assert.ok(svc(s, 'whisper').cmd.includes('--port 8191'), 'whisper port shifted')
	const scribe = svc(s, 'scribe')
	assert.ok(scribe.cmd.includes("export LIVEKIT_URL='ws://localhost:7980'"), 'scribe SFU port')
	assert.ok(scribe.cmd.includes("export ENSEMBLEWORKS_URL='http://localhost:8888'"), 'scribe sync port')
	assert.ok(scribe.cmd.includes('http://localhost:8888/api/health'), 'scribe waits on shifted sync')
	assert.ok(scribe.cmd.includes('/dev/tcp/localhost/7980'), 'scribe waits on shifted SFU')
	const neko = buildServices(
		ctx({ ports: p, portOffset: 100, has: { caddy: true, livekit: true, whisper: true, docker: true } }),
	)
	assert.ok(svc(neko, 'shared-browser').cmd.includes('-p 127.0.0.1:8190:8080'), 'neko publish shifted')
	console.log('ok: offset service table')
}

// Offset 0: livekit stays in --dev mode; a user livekit conf still wins over
// the generated one at any offset.
{
	const zero = svc(buildServices(ctx()), 'livekit')
	assert.ok(zero.cmd.includes('--dev'), 'offset 0 keeps dev mode')
	const userConf = svc(
		buildServices(
			ctx({
				ports: portsFor(100),
				portOffset: 100,
				livekitConf: '/home/u/.config/ensembleworks/livekit-dev.yaml',
				env: { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' },
			}),
		),
		'livekit',
	)
	assert.ok(userConf.cmd.includes("--config '/home/u/.config/ensembleworks/livekit-dev.yaml'"), 'user conf wins')
	console.log('ok: livekit config precedence')
}

// attachInstructions names the offset session.
{
	assert.ok(attachInstructions('abc', 'workspace').includes('tmux attach -t workspace'))
	assert.ok(attachInstructions('abc', 'workspace-100').includes('tmux attach -t workspace-100'))
	console.log('ok: attachInstructions session')
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun bin/dev.test.ts`
Expected: FAIL on the offset service-table assertions (e.g. `sync PORT shifted`).

- [x] **Step 3: Implement in `bin/dev-lib.mjs`**

3a. `livekitBrowserUrl` takes the caddy port (signature change):

```js
/**
 * Browser-facing LiveKit signaling URL (behind Caddy's /livekit route) for a
 * parsed origin: wss for https, ws otherwise; localhost caddy when null.
 * @param {{ scheme: string, host: string, port: number | null } | null} o
 * @param {number} caddyPort
 */
export function livekitBrowserUrl(o, caddyPort) {
	if (!o) return `ws://localhost:${caddyPort}/livekit`
	const ws = o.scheme === 'https' ? 'wss' : 'ws'
	return `${ws}://${o.host}${o.port ? `:${o.port}` : ''}/livekit`
}
```

3b. `attachInstructions` takes the session name:

```js
/**
 * What `bin/dev attach` prints on the host instead of nesting into the
 * container's tmux (which traps your prefix and strands you).
 * @param {string} container  container id or name
 * @param {string} session    tmux session name (workspace, or workspace-<offset>)
 */
export function attachInstructions(container, session) {
	return [
		"Attach to the devcontainer's tmux stack with:",
		'',
		`  docker exec -it ${container} tmux attach -t ${session}`,
		...
```
(only the two template lines change; the rest of the body stays).

3c. Extend the `ServiceCtx` typedef:

```js
 * @property {Record<string, number>} ports      portsFor(portOffset) — every cmd/health derives from this
 * @property {number} portOffset                 ENSEMBLEWORKS_PORT_OFFSET (0 = defaults)
 * @property {string} livekitGeneratedConf       path dev-main writes the offset LiveKit yaml to
```

3d. In `buildServices(ctx)`, add `const p = ctx.ports` at the top, then:

- `livekitBrowserUrl(ctx.publicOrigin)` → `livekitBrowserUrl(ctx.publicOrigin, p.caddy)`
- sync env block becomes:

```js
	const syncEnv = [
		`DATA_DIR='${ctx.dataDir}'`,
		`PORT='${p.sync}'`,
		`ENSEMBLEWORKS_FILES_PORT='${p.files}'`,
		`DISCORD_PORT='${p.discord}'`,
	]
```

and `LIVEKIT_API_URL='http://localhost:${p.livekit}'`; sync health url → `http://localhost:${p.sync}/api/health`.

- term: `cmd: \`PORT='${p.term}' bun run --filter '@ensembleworks/server' dev:term\``, health `p.term`.
- files: `reason: \`file portal on :${p.files}\``, `cmd: \`PORT='${p.files}' bun run --filter '@ensembleworks/server' dev:files\``, health `p.files`.
- client: `cmd: \`ENSEMBLEWORKS_PORT_OFFSET='${ctx.portOffset}' ${publicOriginStr ? …existing prefix… : ''}bun run --filter '@ensembleworks/client' dev\``, health `p.client`.
- caddy: `caddySite` fallback `:${p.caddy}` and `ctx.publicOrigin.port ?? p.caddy`; extend `caddyEnv`:

```js
	const caddyEnv =
		`ENSEMBLEWORKS_CADDY_SITE='${caddySite}' ENSEMBLEWORKS_CADDY_TLS_DIRECTIVE='${caddyTlsInternal ? 'tls internal' : ''}' ENSEMBLEWORKS_CADDY_GLOBAL='${caddyGlobal}' ` +
		`ENSEMBLEWORKS_PORT_SYNC='${p.sync}' ENSEMBLEWORKS_PORT_TERM='${p.term}' ENSEMBLEWORKS_PORT_CLIENT='${p.client}' ` +
		`ENSEMBLEWORKS_PORT_LIVEKIT='${p.livekit}' ENSEMBLEWORKS_PORT_NEKO='${p.neko}'`
```

caddy reason `:8080` strings → `:${p.caddy}`; health `p.caddy`.

- livekit: dev mode has fixed ports, so a nonzero offset switches to the generated config (user conf still wins; its key gate is unchanged because the generated conf embeds devkey/secret):

```js
	const livekitConf = ctx.livekitConf ?? (ctx.portOffset ? ctx.livekitGeneratedConf : null)
```

`cmd` uses `livekitConf` in place of `ctx.livekitConf`; the `reason` for the generated case: replace the final `'dev mode (built-in devkey/secret)'` with `` ctx.portOffset ? `generated config (dev keys, port offset ${ctx.portOffset})` : 'dev mode (built-in devkey/secret)' ``; health `p.livekit`. The sync inline-keys condition stays `!ctx.livekitConf` (generated conf keeps devkey/secret).

- discord: `cmd: \`PORT='${p.discord}' SYNC_BASE='http://127.0.0.1:${p.sync}' bun run --filter '@ensembleworks/discord' dev\``, health `p.discord`.
- whisper: reason/`--port`/health/`localSttUrl` → `p.whisper`.
- scribe: `scribeExports` starts as

```js
	const scribeExports = [
		`export LIVEKIT_URL='ws://localhost:${p.livekit}'`,
		`export ENSEMBLEWORKS_URL='http://localhost:${p.sync}'`,
	]
```

and the wait-loop URLs use `p.sync` / `p.livekit`.

- shared-browser: `-p 127.0.0.1:${p.neko}:8080` and reason `` `neko on :${p.neko}, …` ``.
- Any remaining `PORTS.` references inside `buildServices` are replaced by `p.` (grep to confirm none remain).

- [x] **Step 4: Run tests to verify they pass**

Run: `bun bin/dev.test.ts`
Expected: all `ok:` lines. Existing assertions (they use `PORTS.…` on an offset-0 ctx) still pass. If any old assertion fails, it is comparing a cmd string that gained inline env — update the assertion to the new string, never the code.

- [x] **Step 5: Fix remaining callers, typecheck, commit**

`livekitBrowserUrl`/`attachInstructions` callers outside dev-lib (`bin/dev-host.mjs:104` passes one arg) are updated in Tasks 3/7 — for this commit, make the minimal call-site fix so typecheck passes: in `dev-host.mjs` change to `attachInstructions(dc.id, 'workspace')` (Task 7 makes it offset-aware).

Run: `bun run typecheck` — expected clean.

```bash
git add bin/dev-lib.mjs bin/dev-host.mjs bin/dev.test.ts
git commit -m "feat(dev): thread ctx.ports through the service table"
```

---

### Task 3: Generated LiveKit config yaml (pure function)

**Files:**
- Modify: `bin/dev-lib.mjs`
- Test: `bin/dev.test.ts`
- Reference: `deploy/livekit-cutover-ash.sh:130-140` (a known-good config shape)

- [x] **Step 1: Write the failing test**

```ts
// livekitDevConfigYaml: shifted ports + dev keys; node_ip only when known.
{
	const y = livekitDevConfigYaml(portsFor(100), '192.168.1.194')
	assert.ok(y.includes('port: 7980'), 'signaling port')
	assert.ok(y.includes('tcp_port: 7981'), 'ICE-TCP port')
	assert.ok(y.includes('udp_port: 7982'), 'UDP mux — must match the published host port')
	assert.ok(y.includes('node_ip: 192.168.1.194'), 'advertised media IP')
	assert.ok(y.includes('devkey: secret'), 'dev keys inline (matches the sync env)')
	const local = livekitDevConfigYaml(portsFor(100), null)
	assert.ok(!local.includes('node_ip'), 'no node_ip line when unknown (localhost voice)')
	console.log('ok: livekitDevConfigYaml')
}
```

- [x] **Step 2: Run to verify it fails**

Run: `bun bin/dev.test.ts` — FAIL: `livekitDevConfigYaml` not exported.

- [x] **Step 3: Implement in `bin/dev-lib.mjs`** (near `livekitBrowserUrl`)

```js
/**
 * LiveKit config for a nonzero port offset. `--dev` mode has FIXED ports
 * (7880/7881/7882), so offset stacks run `--config` with this generated yaml
 * instead — same dev keys, shifted ports. udp_port is advertised in ICE
 * candidates, so it must equal the devcontainer-published host port (the
 * uniform offset guarantees that). Field names verified against
 * deploy/livekit-cutover-ash.sh's known-good config.
 * @param {Record<string, number>} ports  portsFor(offset)
 * @param {string | null} nodeIp  advertised media IP (null -> omit; localhost-only voice)
 */
export function livekitDevConfigYaml(ports, nodeIp) {
	return `# generated by bin/dev — do not edit (offset ports + LiveKit dev keys)
port: ${ports.livekit}
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: ${ports.livekitTcp}
  udp_port: ${ports.livekitUdp}
  use_external_ip: false
${nodeIp ? `  node_ip: ${nodeIp}\n` : ''}keys:
  devkey: secret
`
}
```

- [x] **Step 4: Run tests, typecheck**

Run: `bun bin/dev.test.ts` then `bun run typecheck` — expected pass/clean.

- [x] **Step 5: Commit**

```bash
git add bin/dev-lib.mjs bin/dev.test.ts
git commit -m "feat(dev): generated LiveKit config for offset stacks"
```

---

### Task 4: Shared TCP probe module (`bin/dev-net.mjs`)

The controller (Task 7) needs `probePort` for auto-pick, but it cannot import `dev-main.mjs` (whose module top-level runs the engine's Bun gate). Extract the probe.

**Files:**
- Create: `bin/dev-net.mjs`
- Modify: `bin/dev-main.mjs:150-177` (remove `probeAddr`/`probePort`), `bin/dev-doctor.mjs:10-18` (import path)

- [x] **Step 1: Create `bin/dev-net.mjs`**

```js
// @ts-check
/**
 * Loopback TCP probe, shared by the engine (health polls, doctor) and the
 * host controller (port-offset auto-pick). Kept out of dev-main.mjs because
 * that module's top level runs engine-only gates (Bun version, dev.env).
 */
import { connect } from 'node:net'

/** @param {string} host @param {number} port @param {number} timeoutMs */
function probeAddr(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const sock = connect({ port, host })
		/** @param {boolean} ok */
		const done = (ok) => {
			sock.destroy()
			resolve(ok)
		}
		sock.once('connect', () => done(true))
		sock.once('error', () => done(false))
		sock.setTimeout(timeoutMs, () => done(false))
	})
}

/**
 * Node 22 binds localhost-listening services (vite) to ::1 while others sit
 * on 127.0.0.1 — a port is "taken" when EITHER loopback family answers.
 * @param {number} port
 */
export async function probePort(port, timeoutMs = 1000) {
	const results = await Promise.all([
		probeAddr('127.0.0.1', port, timeoutMs),
		probeAddr('::1', port, timeoutMs),
	])
	return results.some(Boolean)
}
```

- [x] **Step 2: Rewire dev-main and dev-doctor**

In `bin/dev-main.mjs`: delete the `probeAddr`/`probePort` definitions (lines 151–177) and the now-unused `import { connect } from 'node:net'`; add `import { probePort } from './dev-net.mjs'` and re-export it (`export { probePort }`) so `dev-doctor`'s existing import keeps working — OR (preferred, one less indirection) change `bin/dev-doctor.mjs` to import `probePort` from `'./dev-net.mjs'` and drop it from the `dev-main` import list. Use the preferred form.

- [x] **Step 3: Verify**

Run: `bun bin/dev.test.ts && bun run typecheck` — expected pass/clean.
Run (inside the container or wherever the stack runs): `bin/dev doctor` — expected: same output shape as before.

- [x] **Step 4: Commit**

```bash
git add bin/dev-net.mjs bin/dev-main.mjs bin/dev-doctor.mjs
git commit -m "refactor(dev): extract loopback probe to dev-net.mjs"
```

---

### Task 5: Engine wiring in `bin/dev-main.mjs` + doctor

**Files:**
- Modify: `bin/dev-main.mjs`, `bin/dev-doctor.mjs`

No unit-test seam here (this file is the I/O side); verification is by running commands in Step 4.

- [x] **Step 1: Resolve the offset once, derive session/dataDir/ports**

In `bin/dev-main.mjs`, extend the dev-lib import with `parsePortOffset, portsFor, livekitDevConfigYaml`, add `writeFileSync` to the `node:fs` import, and replace line 35 (`const session = …`) with:

```js
// ---- port offset: env > .local/port-offset (written by the host controller's
// auto-pick; bind-mounted, so both sides read the same file) > 0. Everything
// per-stack hangs off it: the port map, the tmux session, the data dir.
function readLocalPortOffset() {
	const f = path.join(repoDir, '.local', 'port-offset')
	try {
		return readFileSync(f, 'utf8').trim() || undefined
	} catch {
		return undefined
	}
}
const rawOffset = process.env.ENSEMBLEWORKS_PORT_OFFSET || readLocalPortOffset()
const parsedOffset = parsePortOffset(rawOffset)
if (parsedOffset === null) {
	console.error(
		`bin/dev: invalid port offset '${rawOffset}' (ENSEMBLEWORKS_PORT_OFFSET or .local/port-offset) — use a non-negative integer, e.g. 100`,
	)
	process.exit(1)
}
export const portOffset = parsedOffset
// Windows inherit the tmux server env; inline env in each cmd is authoritative,
// this is belt-and-braces for anything spawned from a canvas terminal.
process.env.ENSEMBLEWORKS_PORT_OFFSET = String(portOffset)
export const ports = portsFor(portOffset)
const session = process.env.WORKSPACE_TMUX_SESSION ?? (portOffset ? `workspace-${portOffset}` : 'workspace')
```

(This sits before the controller dispatch — harmless there, and `die()` is defined later so it uses `console.error` + `process.exit` directly.)

Change the `dataDir` default (currently `…, 'ensembleworks')`) to:

```js
const dataDir =
	process.env.ENSEMBLEWORKS_DATA_DIR ??
	path.join(homedir(), '.local', 'share', portOffset ? `ensembleworks-${portOffset}` : 'ensembleworks')
```

- [x] **Step 2: Generated LiveKit conf + ctx fields**

Below `livekitConfPath` add:

```js
const livekitGeneratedConf = path.join(dataDir, 'livekit-dev.generated.yaml')
```

In `makeCtx()` return object add:

```js
		ports,
		portOffset,
		livekitGeneratedConf,
```

Add next to `makeCtx`:

```js
/**
 * Offset stacks run LiveKit from a generated config (dev mode's ports are
 * fixed). (Re)written on up/restart so a changed offset or LAN IP is picked up.
 * @param {import('./dev-lib.mjs').ServiceCtx} ctx
 */
function ensureLivekitGeneratedConf(ctx) {
	if (!ctx.portOffset || ctx.livekitConf || !ctx.has.livekit) return
	mkdirSync(dataDir, { recursive: true })
	writeFileSync(livekitGeneratedConf, livekitDevConfigYaml(ctx.ports, ctx.livekitNodeIp))
}
```

Call it in `up()` right after `const services = buildServices(makeCtx())` — restructure the first lines of `up()` to:

```js
	mkdirSync(dataDir, { recursive: true })
	const upCtx = makeCtx()
	ensureLivekitGeneratedConf(upCtx)
	const services = buildServices(upCtx)
```

and in `restart()` after building the ctx:

```js
	const rCtx = makeCtx()
	ensureLivekitGeneratedConf(rCtx)
	const svc = buildServices(rCtx).find((s) => s.name === name)
```

- [x] **Step 3: Offset-aware output**

- `cheatSheet()`: `const url = originToString(ctx.publicOrigin) ?? \`http://localhost:${ports.caddy}\`` and the voice line `` `(media udp mux ${ports.livekitUdp})` ``; when `portOffset` is nonzero append `` ` (port offset ${portOffset})` `` after the URL.
- `usage()`: add under the Config line: `Ports: ENSEMBLEWORKS_PORT_OFFSET=<n> (or .local/port-offset) shifts every service port by n — run parallel stacks with n=100, 200, …`
- `bin/dev-doctor.mjs`: `makeCtx()` now carries `ports` — replace the ports-free loop's `Object.entries(PORTS)` with `Object.entries(ctx.ports).filter(([name]) => name !== 'neko' || ctx.has.docker)` (8090 was never probed before; keep it unprobed unless docker makes neko possible), drop the now-unused `PORTS` import, and add an info check after `dev.env`:

```js
	checks.push({
		name: 'port offset',
		level: 'info',
		ok: true,
		detail: ctx.portOffset
			? `+${ctx.portOffset} (session workspace-${ctx.portOffset}, edge :${ctx.ports.caddy})`
			: 'none (default ports)',
	})
```

- [x] **Step 4: Verify by running the engine**

All from the host repo root (the controller forwards into the running container):

Run: `bun run typecheck && bun bin/dev.test.ts` — clean/pass.
Run: `bin/dev status --json 2>/dev/null` — default stack still reports its services on 8788/8789/… and healthy (offset 0 regression).
Run: `bin/dev doctor` — shows `port offset     none (default ports)`.

- [x] **Step 5: Commit**

```bash
git add bin/dev-main.mjs bin/dev-doctor.mjs
git commit -m "feat(dev): engine resolves ENSEMBLEWORKS_PORT_OFFSET (session/dataDir/livekit conf per offset)"
```

---

### Task 6: Vite + Caddyfile follow the offset

**Files:**
- Modify: `client/vite.config.ts`, `deploy/Caddyfile`

- [x] **Step 1: `client/vite.config.ts`**

Replace line 22 (`const CADDY_PORT = 8080`) with:

```ts
// The dev stack can run at a port offset (multiple stacks per host): bin/dev
// passes ENSEMBLEWORKS_PORT_OFFSET into this process. Mirror of portsFor() in
// bin/dev-lib.mjs — keep in sync.
const PORT_OFFSET = Number(process.env.ENSEMBLEWORKS_PORT_OFFSET || 0)
const CADDY_PORT = 8080 + PORT_OFFSET
const CLIENT_PORT = 5173 + PORT_OFFSET
const SYNC_PORT = 8788 + PORT_OFFSET
const TERM_PORT = 8789 + PORT_OFFSET
```

In the `server:` block add `port: CLIENT_PORT,` directly above `strictPort: true`, and update the proxy targets:

```ts
		proxy: {
			'/sync': { target: `ws://localhost:${SYNC_PORT}`, ws: true },
			'/uploads': `http://localhost:${SYNC_PORT}`,
			'/files': `http://localhost:${SYNC_PORT}`,
			// Terminal local plane (health/sessions/ws) is served by the gateway
			// process; the relay plane (status/list/connect/relay) stays on the sync
			// server. Must precede the '/api' catch-all. The alternation also covers
			// /sessions/:id.
			'^/api/terminal/(health|sessions|ws)': { target: `ws://localhost:${TERM_PORT}`, ws: true },
			'/api': { target: `http://localhost:${SYNC_PORT}`, ws: true },
		},
```

Also update the two comments that hardcode `127.0.0.1:5173` to say "the client port (5173 + offset)".

- [x] **Step 2: `deploy/Caddyfile`**

Caddy substitutes `{$VAR:default}` env placeholders anywhere in the file before parsing; the site address already works this way. bin/dev's caddy window exports the `ENSEMBLEWORKS_PORT_*` vars (Task 2); defaults keep the ash box (which copies this file, no env) on today's ports. Replace the four hardcoded upstreams:

- `reverse_proxy localhost:7880` → `reverse_proxy localhost:{$ENSEMBLEWORKS_PORT_LIVEKIT:7880}`
- `reverse_proxy localhost:8090` → `reverse_proxy localhost:{$ENSEMBLEWORKS_PORT_NEKO:8090}`
- `reverse_proxy 127.0.0.1:8789` → `reverse_proxy 127.0.0.1:{$ENSEMBLEWORKS_PORT_TERM:8789}`
- `reverse_proxy 127.0.0.1:8788` → `reverse_proxy 127.0.0.1:{$ENSEMBLEWORKS_PORT_SYNC:8788}`
- `reverse_proxy 127.0.0.1:5173` → `reverse_proxy 127.0.0.1:{$ENSEMBLEWORKS_PORT_CLIENT:5173}`

- [x] **Step 3: Verify the default stack still works end-to-end**

Run: `bin/dev restart caddy && bin/dev restart client` (forwards into the container), wait ~10s, then:
Run: `curl -fsS http://localhost:8080/api/health && curl -fsSo /dev/null -w '%{http_code}\n' http://localhost:8080/`
Expected: health JSON and `200` (Caddy → Vite unchanged at offset 0).

- [x] **Step 4: Commit**

```bash
git add client/vite.config.ts deploy/Caddyfile
git commit -m "feat(dev): vite + caddy derive ports from ENSEMBLEWORKS_PORT_OFFSET"
```

---

### Task 7: Host controller — offset resolution, auto-pick, devcontainer env

**Files:**
- Modify: `bin/dev-host.mjs`, `bin/dev-main.mjs:43-45` (async call site)

- [x] **Step 1: Imports and offset helpers in `bin/dev-host.mjs`**

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { attachInstructions, forwardArgv, parsePortOffset, portsFor, workspaceDirFor } from './dev-lib.mjs'
import { probePort } from './dev-net.mjs'
```

Add helpers (below `resolveMainRepoDir`):

```js
/**
 * The stack's port offset as configured on the host: env > .local/port-offset.
 * Returns null when neither is set (auto-pick may then choose one on `up`).
 * Dies on an invalid value.
 * @param {string} mainRepoDir
 * @returns {number | null}
 */
function configuredOffset(mainRepoDir) {
	const file = path.join(mainRepoDir, '.local', 'port-offset')
	const raw =
		process.env.ENSEMBLEWORKS_PORT_OFFSET ||
		(existsSync(file) ? readFileSync(file, 'utf8').trim() : '')
	if (!raw) return null
	const n = parsePortOffset(raw)
	if (n === null) die(`invalid port offset '${raw}' (ENSEMBLEWORKS_PORT_OFFSET or .local/port-offset) — use a non-negative integer, e.g. 100`)
	return n
}

/**
 * First free offset in {0, 100, …, 900}: free = neither the edge (caddy) nor
 * LiveKit's ICE-TCP host port answers on loopback. UDP isn't probed — it rides
 * the same offset. Used only when no offset is configured and no container is
 * already running for this checkout.
 * @returns {Promise<number | null>}
 */
async function pickFreeOffset() {
	for (const cand of [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
		const p = portsFor(cand)
		if (!(await probePort(p.caddy)) && !(await probePort(p.livekitTcp))) return cand
	}
	return null
}
```

- [x] **Step 2: Make `runController` async and wire `up`**

Change the signature to `export async function runController(repoDir, argv)` and in `bin/dev-main.mjs` change the dispatch to `await runController(repoDir, process.argv.slice(2))` (top-level await is fine; every controller path exits the process).

Replace the `up` branch body (keep the existing docker/devcontainer-CLI checks) with:

```js
	if (cmd === 'up') {
		if (!onPath('docker')) die('docker is not on PATH — install Docker to run the devcontainer')
		if (!onPath('devcontainer'))
			die('the devcontainer CLI is required — install it: npm i -g @devcontainers/cli')
		let offset = configuredOffset(mainRepoDir)
		if (dc) {
			narrate(`devcontainer '${dc.name}' already running — devcontainer up is idempotent`)
			offset ??= 0 // ports were published at create; never re-pick under a live container
		} else if (offset === null) {
			offset = await pickFreeOffset()
			if (offset === null)
				die('no free port offset in 0..900 (probed caddy + livekit-tcp) — set ENSEMBLEWORKS_PORT_OFFSET')
			if (offset !== 0) {
				const f = path.join(mainRepoDir, '.local', 'port-offset')
				mkdirSync(path.dirname(f), { recursive: true })
				writeFileSync(f, `${offset}\n`)
				narrate(`default ports busy — picked port offset ${offset} (persisted to .local/port-offset)`)
			}
		}
		const p = portsFor(offset)
		if (offset) narrate(`port offset ${offset} → edge http://localhost:${p.caddy}`)
		narrate(`starting → devcontainer up --workspace-folder ${mainRepoDir}`)
		const r = spawnSync('devcontainer', ['up', '--workspace-folder', mainRepoDir], {
			stdio: 'inherit',
			// Consumed by ${localEnv:…} substitutions in .devcontainer/devcontainer.json
			// (published host ports) and containerEnv (the engine's offset).
			env: {
				...process.env,
				ENSEMBLEWORKS_PORT_OFFSET: String(offset),
				ENSEMBLEWORKS_HOSTPORT_CADDY: String(p.caddy),
				ENSEMBLEWORKS_HOSTPORT_LIVEKIT_TCP: String(p.livekitTcp),
				ENSEMBLEWORKS_HOSTPORT_LIVEKIT_UDP: String(p.livekitUdp),
			},
		})
		process.exit(r.status ?? 0)
	}
```

- [x] **Step 3: Offset-aware attach**

In the `attach` branch:

```js
		const offset = configuredOffset(mainRepoDir) ?? 0
		process.stdout.write(`${attachInstructions(dc.id, offset ? `workspace-${offset}` : 'workspace')}\n`)
```

- [x] **Step 4: Verify**

Run: `bun run typecheck && bun bin/dev.test.ts` — clean/pass.
Run: `bin/dev up` (container already running) — narrates idempotent reuse, exits 0, no re-pick.
Run: `bin/dev attach` — prints `tmux attach -t workspace` (offset 0).

- [x] **Step 5: Commit**

```bash
git add bin/dev-host.mjs bin/dev-main.mjs
git commit -m "feat(dev): controller auto-picks a free port offset and threads it to devcontainer up"
```

---

### Task 8: Parameterize the devcontainer's published ports

**Files:**
- Modify: `.devcontainer/devcontainer.json`

- [x] **Step 1: Edit `runArgs` + add `containerEnv`**

Replace the `runArgs` line and add `containerEnv` (keep `forwardPorts`/`portsAttributes` at 8080 — they're Codespaces/VS Code cosmetics; offset stacks on Codespaces are out of scope):

```jsonc
	// Publish the Caddy edge and LiveKit dev-mode media (ICE-TCP + UDP mux) to
	// the host. The host ports come from bin/dev's controller via localEnv
	// (ENSEMBLEWORKS_PORT_OFFSET support — multiple stacks per host); defaults
	// keep `devcontainer up` / VS Code working without bin/dev. The container
	// port EQUALS the host port (uniform offset) because LiveKit advertises its
	// UDP port in ICE candidates — a remap would silently break voice.
	// Ignored by Codespaces — harmless.
	"runArgs": [
		"-p", "${localEnv:ENSEMBLEWORKS_HOSTPORT_CADDY:8080}:${localEnv:ENSEMBLEWORKS_HOSTPORT_CADDY:8080}",
		"-p", "${localEnv:ENSEMBLEWORKS_HOSTPORT_LIVEKIT_TCP:7881}:${localEnv:ENSEMBLEWORKS_HOSTPORT_LIVEKIT_TCP:7881}",
		"-p", "${localEnv:ENSEMBLEWORKS_HOSTPORT_LIVEKIT_UDP:7882}:${localEnv:ENSEMBLEWORKS_HOSTPORT_LIVEKIT_UDP:7882}/udp"
	],
	// The engine's offset for the env-only path (explicit ENSEMBLEWORKS_PORT_OFFSET
	// with no .local/port-offset file): postStartCommand runs inside the container
	// where host env doesn't otherwise reach. Empty when unset -> engine falls back
	// to .local/port-offset, then 0. Changing the offset requires a container
	// recreate anyway (ports are published at create time).
	"containerEnv": { "ENSEMBLEWORKS_PORT_OFFSET": "${localEnv:ENSEMBLEWORKS_PORT_OFFSET}" },
```

- [x] **Step 2: Verify the substitution syntax against this CLI version**

`${localEnv:VAR:default}` default-values are in the containers.dev spec, but confirm this installed CLI (0.80.x) honours them **before recreating anything**:

Run: `devcontainer read-configuration --workspace-folder . 2>/dev/null | head -c 2000`
Expected: the printed config shows `runArgs` with `8080`/`7881`/`7882` substituted in (NOT literal `${localEnv…}` text, NOT empty strings). If defaults are unsupported (empty strings appear), fall back: keep literal ports as today's `runArgs` in the file and have the controller pass `--override-config` instead — flag this to the human before proceeding.

- [x] **Step 3: Recreate the container on defaults (regression)**

Run: `bin/dev down && bin/dev up` — then `bin/dev status --json 2>/dev/null` (all healthy) and `docker ps --format '{{.Ports}}' --filter label=devcontainer.local_folder=$(pwd)` shows `8080->8080`, `7881->7881`, `7882->7882/udp`.

- [x] **Step 4: Commit**

```bash
git add .devcontainer/devcontainer.json
git commit -m "feat(dev): devcontainer publishes offset host ports via localEnv substitution"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (Local dev section), `README.md` (Development section), `AGENTS.md` (if it repeats the port list)

- [x] **Step 1: Document the offset**

Add to `CLAUDE.md`'s "Local dev — bin/dev" section (after the `bin/dev --help` bullet):

```markdown
- Multiple stacks per host: every dev port shifts by `ENSEMBLEWORKS_PORT_OFFSET`
  (persisted per-checkout in `.local/port-offset`; `bin/dev up` auto-picks
  100/200/… when the defaults are busy and narrates the edge URL). Offset
  stacks use tmux session `workspace-<offset>` and data dir
  `~/.local/share/ensembleworks-<offset>`. Use separate clones (not linked
  worktrees — the controller targets the main checkout). `bin/canvas` needs
  `CANVAS_URL=http://localhost:<8788+offset>` against an offset stack.
```

Add the equivalent prose to README's Development section (match its voice; mention that LiveKit runs from a generated config when offset ≠ 0, and that changing an offset requires `bin/dev down` + `up` since published ports are fixed at container create). Grep `AGENTS.md` for the port table and add one line pointing at the offset if it repeats the ports.

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md README.md AGENTS.md
git commit -m "docs(dev): ENSEMBLEWORKS_PORT_OFFSET multi-stack usage"
```

---

### Task 10: End-to-end verification (two stacks side by side)

No new files — this proves the feature. The cheapest true two-stack test runs the second (offset) engine inside the same container: it exercises port shifting, tmux/dataDir isolation, generated LiveKit config, Caddy env placeholders, and Vite's offset — everything except a second container's host-port publish (verified at offset 0 in Task 8; optionally with a second clone below).

- [x] **Step 1: Default stack healthy (stack A)**

Run: `bin/dev status --json 2>/dev/null` — every enabled service healthy; `curl -fsS http://localhost:8080/api/health` OK.

- [x] **Step 2: Bring up stack B at offset 100 inside the container**

```bash
CID=$(docker ps -q --filter label=devcontainer.local_folder=$(pwd))
docker exec -w /workspaces/ensembleworks-opencode-web -e ENSEMBLEWORKS_PORT_OFFSET=100 $CID bin/dev up --no-install
```

Expected: `- … off:` lines as usual, then `✓` for sync/term/files/client/caddy/livekit/whisper and a cheat-sheet URL `http://localhost:8180 (port offset 100)`.

- [x] **Step 3: Probe stack B and confirm stack A is untouched**

```bash
docker exec $CID curl -fsS http://localhost:8180/api/health          # B edge -> sync
docker exec $CID curl -fsSo /dev/null -w '%{http_code}\n' http://localhost:8180/   # B edge -> vite (expect 200)
docker exec $CID curl -fsS http://localhost:8888/api/health          # B sync direct
docker exec -w /workspaces/ensembleworks-opencode-web -e ENSEMBLEWORKS_PORT_OFFSET=100 $CID bin/dev status --json 2>/dev/null | grep -c '"healthy": true'
docker exec $CID tmux list-sessions                                   # expect: workspace AND workspace-100
docker exec $CID cat /home/dev/.local/share/ensembleworks-100/livekit-dev.generated.yaml  # ports 7980/7981/7982
curl -fsS http://localhost:8080/api/health                            # A still healthy from the host
bin/dev status --json 2>/dev/null | grep -c '"healthy": true'         # A count unchanged
```

- [x] **Step 4: Tear down stack B, confirm A survives**

```bash
docker exec -w /workspaces/ensembleworks-opencode-web -e ENSEMBLEWORKS_PORT_OFFSET=100 $CID bin/dev down
docker exec $CID tmux list-sessions            # only 'workspace'
curl -fsS http://localhost:8080/api/health     # A healthy
```

Note: stack B's `down` pkills by Caddyfile path, which would also hit stack A's caddy — check `bin/dev status` for A afterward and `bin/dev restart caddy` if its caddy was reaped. If it WAS reaped, add the offset to the pkill match in `down()` (`dev-main.mjs:333`): scope the pattern to the session's caddy by matching `ENSEMBLEWORKS_CADDY_SITE=':<port>'` instead — implement, retest, include in the fix commit.

- [x] **Step 5 (optional, needs a second clone): true host-level two-container test**

```bash
git clone <repo> ../ensembleworks-b && cd ../ensembleworks-b && bin/dev up
```

Expected: controller narrates `default ports busy — picked port offset 100`, `.local/port-offset` contains `100`, `docker ps` shows the second container publishing `8180/7981/7982`, and `curl -fsS http://localhost:8180/api/health` works from the host. `bin/dev down` in each clone stops only its own container.

- [x] **Step 6: Final checks + commit any fixes**

Run: `bun bin/dev.test.ts && bun run typecheck && bun run build` — all clean.

```bash
git add -A && git commit -m "test(dev): two-stack port-offset verification fixes"   # only if fixes were needed
```

---

## Self-review notes (already applied)

- LiveKit `udp_port` must equal the published host port — guaranteed by the uniform offset (container port == host port); called out in devcontainer.json and `livekitDevConfigYaml` comments.
- `parsePortOffset('')` → 0 lets the empty-string `containerEnv` fall through to the `.local/port-offset` file (`||` chains treat `''` as unset everywhere).
- Auto-pick never runs when a container already exists for the checkout (ports were bound at create).
- Sync's inline `devkey/secret` stays keyed off `ctx.livekitConf` (user conf), not the generated conf, which embeds the same dev keys.
- `down()`'s caddy pkill is repo-scoped but not offset-scoped — explicitly probed in Task 10 Step 4 with the fix path spelled out.

## Completion note (2026-07-11)

All tasks done. Three mid-review deviations from the plan as written:

- (a) The engine's offset resolution (`bin/dev-main.mjs`) moved to *below* the controller dispatch — the original placement defaulted an unset `ENSEMBLEWORKS_PORT_OFFSET` to `'0'` in `process.env` before the controller ran, poisoning its unset-vs-0 distinction and making auto-pick unreachable.
- (b) The controller (`bin/dev-host.mjs`) now adopts a stopped or running container's stamped port offset (`containerOffset`) rather than always defaulting to 0, and recreates the container via `--remove-existing-container` when the configured offset differs from what's running (published ports are fixed at create).
- (c) `down()`'s caddy reap (`bin/dev-main.mjs`) is environ-scoped per stack rather than a bare repo-scoped `pkill -f`, per the Task 10 Step 4 note.

Final-review fixes (one line each):

- Offset dataDirs (`ensembleworks-<offset>`) now get the same `.local/share` symlink persistence as the unsuffixed dataDir, so they survive container rebuilds (`.devcontainer/post-create.bash`).
- `bin/dev attach` now names the session from the running container's stamped offset (`containerOffset(dc.id)`), not `configuredOffset`, which is empty in the env-only workflow.
- `reapStrayCaddy()`'s stack discriminator switched from an `ENSEMBLEWORKS_CADDY_SITE` `endsWith(':<port>')` check (misses the TLS-internal/custom-origin-port shape) to an exact `ENSEMBLEWORKS_PORT_SYNC=<n>` environ match.
- `parsePortOffset`'s cap corrected from 57000 to 56744 (files:8791 is the largest base port; 8791 + 56744 = 65535), with two new boundary tests.
- `reapStrayCaddy()` falls back to a broad `pkill -f` when `/proc` doesn't exist (macOS native mode), restoring the old behavior lost when the environ-based reap was introduced.
- Doctor's ports-free loop now also excludes `livekitUdp` (a TCP probe can never detect a UDP squatter).
- `pickFreeOffset()` documents the accepted concurrent-`up` race (no locking) inline.
