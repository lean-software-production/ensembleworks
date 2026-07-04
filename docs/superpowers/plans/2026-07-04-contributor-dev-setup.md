# Contributor Dev Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A contributor (usually driving a coding agent) opens the devcontainer and has a fully working local EnsembleWorks — canvas, terminals, voice, transcription — with zero accounts; `bin/dev` replaces the host-specific `~/Work/ensembleworks-devserver`, and `release.sh` stops destroying the running stack's `node_modules`.

**Architecture:** `bin/dev` is a dependency-free Node CLI (plain JS, `node:` builtins only) whose service table is pure, tested data (`bin/dev-lib.mjs`); tmux is the process engine (session `workspace`, one window per service, crash-surviving `hold()` wrapper). A Debian 13 devcontainer bakes in every binary (Node from `.nvmrc`, tmux, caddy, livekit-server, whisper.cpp) and symlinks home-dir state paths into a git-ignored `.local/` workspace folder. `release.sh` validates in a throwaway `git worktree`.

**Tech Stack:** Node 22.22.3 (plain JS + `// @ts-check`), tmux, Caddy, LiveKit OSS SFU (`--dev` keys), whisper.cpp `whisper-server`, devcontainer on `debian:trixie`.

**Spec:** `docs/superpowers/specs/2026-07-04-contributor-dev-setup-design.md`

## Global Constraints

- Node is **exactly 22.22.3** (`.nvmrc` is the single source of truth; node-pty ABI pin). `bin/dev` enforces, never provides — soft re-exec via mise when present.
- `bin/dev*` files use **`node:` builtins only** — no `node_modules` imports; they must run on a fresh clone before `npm ci`. Plain JS with `// @ts-check` + JSDoc, NOT TypeScript.
- Version pins follow `deploy/runtime-requirements`: livekit-server **exact 1.13.1**, caddy **min 2.7.0**, tmux **min 3.3**.
- The tmux session is named `workspace` (override: `WORKSPACE_TMUX_SESSION`) and uses `deploy/tmux-ensembleworks.conf` — same as the retired launcher, so canvas terminals keep working.
- Home-dir paths are the interface everywhere: `~/.local/share/ensembleworks` (DATA_DIR), `~/.config/ensembleworks/dev.env`. The devcontainer backs them with symlinks into `<repo>/.local/` — no path changes in services.
- Ports: sync 8788, term 8789, client 5173, caddy 8080, livekit 7880 (media TCP 7881 / UDP 7882 in dev mode), neko 8090, whisper 8091.
- No new npm dependencies anywhere in this plan.
- Repo test style: `npx tsx <file>.test.ts`, `node:assert/strict`, block-scoped cases, `console.log('ok: …')` per case (see `server/src/livekit-url.test.ts`).
- Commit after every task (steps include the commands). Work directly on `main` per repo convention.

---

### Task 1: `bin/dev-lib.mjs` — service table, gating, parsers (TDD)

**Files:**
- Create: `bin/dev-lib.mjs`
- Create: `bin/dev.test.ts`
- Create: `bin/tsconfig.json`
- Modify: `package.json` (root — typecheck script)
- Modify: `.gitignore` (add `.local/`)

**Interfaces:**
- Produces (consumed by Tasks 2 & 3):
  - `PORTS: { sync: 8788, term: 8789, client: 5173, caddy: 8080, livekit: 7880, whisper: 8091 }`
  - `hold(cmd: string, label: string): string`
  - `parseNvmrc(text: string): string` — `'22.22.3'`
  - `parseDotEnv(text: string): Record<string, string>`
  - `buildServices(ctx: ServiceCtx): Service[]` — `Service = { name, enabled, reason, cmd, health }`, `health` is `{kind:'http',url}` | `{kind:'port',port}` | `null`
  - `ServiceCtx = { repoDir, dataDir, publicHost, livekitConf, whisperModel, tailscaleIp, has: {caddy, livekit, whisper, docker}, env }`

- [ ] **Step 1: Write the failing test**

Create `bin/dev.test.ts`:

```typescript
// Tests for bin/dev's pure logic (service table gating, parsers).
// Run with: npx tsx bin/dev.test.ts
import assert from 'node:assert/strict'
import { PORTS, buildServices, hold, parseDotEnv, parseNvmrc } from './dev-lib.mjs'

// A baseline context: everything installed, no keys, no public host — what a
// fresh devcontainer looks like before dev.env exists.
function ctx(overrides: Record<string, unknown> = {}) {
	return {
		repoDir: '/repo',
		dataDir: '/home/u/.local/share/ensembleworks',
		publicHost: null,
		livekitConf: null,
		whisperModel: '/usr/local/share/whisper/ggml-base.bin',
		tailscaleIp: null,
		has: { caddy: true, livekit: true, whisper: true, docker: false },
		env: {},
		...overrides,
	} as Parameters<typeof buildServices>[0]
}

function svc(services: ReturnType<typeof buildServices>, name: string) {
	const s = services.find((x) => x.name === name)
	assert.ok(s, `service ${name} exists`)
	return s
}

// hold() wraps a command so the tmux window survives crash and Ctrl-C.
{
	const w = hold('npm run dev', 'client')
	assert.ok(w.startsWith('trap ":" INT; '), 'SIGINT trap is first (load-bearing)')
	assert.ok(w.includes('npm run dev'), 'command included')
	assert.ok(w.includes('[client exited $code]'), 'label in the epilogue')
	assert.ok(w.endsWith('exec bash'), 'drops to an interactive shell')
	console.log('ok: hold() wrapper shape')
}

// parseNvmrc tolerates v-prefix and whitespace.
{
	assert.equal(parseNvmrc('22.22.3\n'), '22.22.3')
	assert.equal(parseNvmrc('v22.22.3'), '22.22.3')
	console.log('ok: parseNvmrc')
}

// parseDotEnv: comments/blanks skipped, quotes stripped, export prefix ok,
// no interpolation.
{
	const got = parseDotEnv('# c\n\nA=1\nexport B="two"\nC=\'th ree\'\nbad line\n')
	assert.deepEqual(got, { A: '1', B: 'two', C: 'th ree' })
	console.log('ok: parseDotEnv')
}

// Baseline: core four + livekit + whisper enabled; scribe rides local whisper;
// shared-browser off (no docker).
{
	const s = buildServices(ctx())
	for (const name of ['sync', 'term', 'client', 'caddy', 'livekit', 'whisper']) {
		assert.equal(svc(s, name).enabled, true, `${name} enabled`)
	}
	assert.equal(svc(s, 'scribe').enabled, true, 'scribe enabled via local whisper')
	assert.equal(svc(s, 'shared-browser').enabled, false, 'no docker -> no neko')
	console.log('ok: baseline devcontainer gating')
}

// LiveKit dev mode: --dev command, devkey/secret inline on sync, loopback API
// url, browser URL via Caddy /livekit on plain localhost.
{
	const s = buildServices(ctx())
	const lk = svc(s, 'livekit')
	assert.ok(lk.cmd.includes('--dev'), 'dev mode')
	const sync = svc(s, 'sync')
	assert.ok(sync.cmd.includes(`LIVEKIT_URL='ws://localhost:${PORTS.caddy}/livekit'`), 'localhost ws url')
	assert.ok(sync.cmd.includes("LIVEKIT_API_KEY='devkey'"), 'dev key inline (not a secret)')
	assert.ok(sync.cmd.includes(`LIVEKIT_API_URL='http://localhost:${PORTS.livekit}'`), 'loopback RoomService')
	assert.ok(sync.cmd.includes(`DATA_DIR='/home/u/.local/share/ensembleworks'`), 'data dir inline')
	console.log('ok: livekit dev mode wiring')
}

// LiveKit config-file mode: real keys must come from the (inherited) env and
// never appear inline; missing keys disable livekit with a pointed reason.
{
	const withKeys = buildServices(
		ctx({ livekitConf: '/home/u/.config/ensembleworks/livekit-dev.yaml', env: { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' } }),
	)
	const lk = svc(withKeys, 'livekit')
	assert.equal(lk.enabled, true)
	assert.ok(lk.cmd.includes('--config'), 'config file wins over --dev')
	assert.ok(!svc(withKeys, 'sync').cmd.includes("LIVEKIT_API_KEY='k'"), 'real key NOT inline')

	const noKeys = buildServices(ctx({ livekitConf: '/x/livekit-dev.yaml' }))
	assert.equal(svc(noKeys, 'livekit').enabled, false)
	assert.match(svc(noKeys, 'livekit').reason, /LIVEKIT_API_KEY/, 'reason names the missing keys')
	console.log('ok: livekit config-file mode')
}

// livekit-server absent: voice off, scribe off (needs the SFU to hear).
{
	const s = buildServices(ctx({ has: { caddy: true, livekit: false, whisper: true, docker: false } }))
	assert.equal(svc(s, 'livekit').enabled, false)
	assert.equal(svc(s, 'scribe').enabled, false)
	assert.ok(!svc(s, 'sync').cmd.includes('LIVEKIT_URL'), 'sync starts without LIVEKIT_*')
	console.log('ok: no livekit binary degrades cleanly')
}

// Scribe STT resolution order: explicit STT_URL wins (no inline default);
// STT_API_KEY alone works (Groq default url inside the transcriber);
// otherwise local whisper's /v1 endpoint is exported inline.
{
	const local = buildServices(ctx())
	assert.ok(svc(local, 'scribe').cmd.includes(`export STT_URL='http://localhost:${PORTS.whisper}/v1'`), 'local whisper default')
	assert.ok(svc(local, 'scribe').cmd.includes("STT_MODEL='whisper-1'"), 'model name for local server')

	const explicit = buildServices(ctx({ env: { STT_URL: 'http://elsewhere/v1' } }))
	assert.ok(!svc(explicit, 'scribe').cmd.includes('export STT_URL'), 'explicit STT_URL rides the env, not argv')

	const groq = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: false, docker: false }, env: { STT_API_KEY: 'gsk_x' } }))
	assert.equal(svc(groq, 'scribe').enabled, true, 'hosted key alone enables scribe')
	assert.ok(!svc(groq, 'scribe').cmd.includes('STT_URL'), 'no url override for hosted default')

	const nothing = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: false, docker: false } }))
	assert.equal(svc(nothing, 'scribe').enabled, false)
	assert.match(svc(nothing, 'scribe').reason, /STT/, 'reason explains what to set')
	console.log('ok: scribe STT resolution')
}

// Scribe waits for sync AND the SFU before starting, and talks to the SFU on
// loopback (same as the retired launcher).
{
	const cmd = svc(buildServices(ctx()), 'scribe').cmd
	assert.ok(cmd.includes(`export LIVEKIT_URL='ws://localhost:${PORTS.livekit}'`), 'loopback SFU for the scribe')
	assert.ok(cmd.includes('until curl -fsS http://localhost:8788/api/health'), 'waits for sync')
	assert.ok(cmd.includes(`/dev/tcp/localhost/${PORTS.livekit}`), 'waits for the SFU port')
	console.log('ok: scribe startup gate')
}

// Public host (tailnet/tunnel): wss LiveKit url, Vite told the host.
{
	const s = buildServices(ctx({ publicHost: 'baljeet.cyprus-macaroni.ts.net' }))
	assert.ok(svc(s, 'sync').cmd.includes("LIVEKIT_URL='wss://baljeet.cyprus-macaroni.ts.net/livekit'"))
	assert.ok(svc(s, 'client').cmd.includes("ENSEMBLEWORKS_PUBLIC_HOST='baljeet.cyprus-macaroni.ts.net'"))
	console.log('ok: public host wiring')
}

// Shared browser: docker + default-on; SHARED_BROWSER_ENABLE=0 kills it;
// NAT1TO1 resolution env > tailscale ip > loopback.
{
	const on = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: true, docker: true }, tailscaleIp: '100.1.2.3' }))
	assert.equal(svc(on, 'shared-browser').enabled, true)
	assert.ok(svc(on, 'shared-browser').cmd.includes("NEKO_WEBRTC_NAT1TO1='100.1.2.3'"), 'tailscale ip fallback')
	const off = buildServices(ctx({ has: { caddy: true, livekit: true, whisper: true, docker: true }, env: { SHARED_BROWSER_ENABLE: '0' } }))
	assert.equal(svc(off, 'shared-browser').enabled, false)
	console.log('ok: shared-browser gating')
}

// Caddy absent: window disabled with a reason that names what breaks.
{
	const s = buildServices(ctx({ has: { caddy: false, livekit: true, whisper: true, docker: false } }))
	assert.equal(svc(s, 'caddy').enabled, false)
	assert.match(svc(s, 'caddy').reason, /dev\/\{port\}/, 'reason names the lost routes')
	console.log('ok: caddy gating')
}

console.log('all dev-lib tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx bin/dev.test.ts`
Expected: FAIL — `Cannot find module '…/bin/dev-lib.mjs'`

- [ ] **Step 3: Write the implementation**

Create `bin/dev-lib.mjs`:

```javascript
// @ts-check
/**
 * Pure logic for bin/dev — the service table, gating rules and parsers. No
 * I/O here: everything takes a plain context object so it can be unit-tested
 * (bin/dev.test.ts) without tmux, sockets or a filesystem. The I/O side
 * (tmux, health polls, CLI) lives in bin/dev-main.mjs.
 */

export const PORTS = {
	sync: 8788,
	term: 8789,
	client: 5173,
	caddy: 8080,
	livekit: 7880,
	whisper: 8091, // 8090 is the shared browser (neko)
}

/**
 * Wrap a service command so its tmux window survives a crash OR a Ctrl-C: run
 * the command, then drop into an interactive shell with the exit code and
 * scrollback intact (instead of the window vanishing, which is what hid a
 * missing-deps failure — and what closes the window when you C-c a service to
 * restart it). The `trap ":" INT` is load-bearing: without it, a child killed
 * *by* SIGINT (e.g. vite under `npm run dev`) makes this non-interactive
 * wrapper shell abort the list before reaching `exec bash`, so the window
 * closes. tsx-based services hid this because tsx catches SIGINT and exits 0;
 * vite does not. The trap makes the wrapper survive the signal while the
 * child (which resets the trap on exec) still dies. This is race-free — no
 * reliance on remain-on-exit landing before a fast exit — and scoped to these
 * windows, so it never touches the human-facing canvas terminals that share
 * deploy/tmux-ensembleworks.conf. (Ported verbatim from the retired
 * ~/Work/ensembleworks-devserver launcher.)
 *
 * @param {string} cmd
 * @param {string} label
 */
export function hold(cmd, label) {
	return `trap ":" INT; ${cmd}; code=$?; echo; echo "[${label} exited $code] — shell follows, scrollback intact"; exec bash`
}

/** @param {string} text  .nvmrc content, e.g. "22.22.3\n" or "v22.22.3" */
export function parseNvmrc(text) {
	return text.trim().replace(/^v/, '')
}

/**
 * KEY=VALUE per line with `set -a` spirit: comments/blanks skipped, optional
 * `export ` prefix, surrounding single/double quotes stripped. Deliberately
 * NO interpolation or multi-line values — dev.env is data, not shell.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
	/** @type {Record<string, string>} */
	const out = {}
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
		if (!m) continue
		let v = m[2].trim()
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1)
		}
		out[m[1]] = v
	}
	return out
}

/**
 * @typedef {object} ServiceCtx
 * @property {string} repoDir
 * @property {string} dataDir              DATA_DIR for the sync server
 * @property {string | null} publicHost    ENSEMBLEWORKS_PUBLIC_HOST (tailnet/tunnel edge) or null = localhost
 * @property {string | null} livekitConf   path to livekit-dev.yaml IFF the file exists, else null
 * @property {string} whisperModel         ggml model path (existence pre-checked by the caller)
 * @property {string | null} tailscaleIp   first tailscale IPv4, for neko NAT1TO1
 * @property {{ caddy: boolean, livekit: boolean, whisper: boolean, docker: boolean }} has
 *           binary presence; `whisper` means binary AND model file present
 * @property {Record<string, string | undefined>} env  process env AFTER the dev.env merge
 */

/**
 * @typedef {object} Service
 * @property {string} name      tmux window name
 * @property {boolean} enabled
 * @property {string} reason    one line: why it will / won't run
 * @property {string} cmd       window command (pre-hold()). Inline env is
 *   non-secret only (dev-mode keys, urls, paths); real secrets from dev.env
 *   ride the inherited tmux-server environment and never appear in argv.
 * @property {{ kind: 'http', url: string } | { kind: 'port', port: number } | null} health
 */

/**
 * The service table. Window order matches the retired launcher: sync first.
 * @param {ServiceCtx} ctx
 * @returns {Service[]}
 */
export function buildServices(ctx) {
	/** @type {Service[]} */
	const services = []

	// LiveKit: config file (real deployment shape — needs real keys in the env)
	// wins over --dev mode (built-in devkey/secret; zero accounts).
	const livekitKeysOk = ctx.livekitConf
		? Boolean(ctx.env.LIVEKIT_API_KEY && ctx.env.LIVEKIT_API_SECRET)
		: true
	const livekitOn = ctx.has.livekit && livekitKeysOk

	// Browser-facing signaling URL goes through Caddy's /livekit route: wss
	// when a TLS edge fronts us (public host), plain ws for localhost.
	const livekitPublicUrl = ctx.publicHost
		? `wss://${ctx.publicHost}/livekit`
		: `ws://localhost:${PORTS.caddy}/livekit`

	const syncEnv = [`DATA_DIR='${ctx.dataDir}'`]
	if (livekitOn) {
		syncEnv.push(
			`LIVEKIT_URL='${livekitPublicUrl}'`,
			`LIVEKIT_API_URL='http://localhost:${PORTS.livekit}'`,
		)
		// --dev mode keys are public constants, safe inline. Config-file mode
		// keys come from dev.env via the inherited environment instead.
		if (!ctx.livekitConf) syncEnv.push(`LIVEKIT_API_KEY='devkey'`, `LIVEKIT_API_SECRET='secret'`)
	}
	services.push({
		name: 'sync',
		enabled: true,
		reason: 'always',
		cmd: `${syncEnv.join(' ')} npm run dev --workspace=server`,
		health: { kind: 'http', url: `http://localhost:${PORTS.sync}/api/health` },
	})

	services.push({
		name: 'term',
		enabled: true,
		reason: 'always',
		cmd: 'npm run dev:term --workspace=server',
		health: { kind: 'port', port: PORTS.term },
	})

	services.push({
		name: 'client',
		enabled: true,
		reason: 'always',
		cmd: `${ctx.publicHost ? `ENSEMBLEWORKS_PUBLIC_HOST='${ctx.publicHost}' ` : ''}npm run dev --workspace=client`,
		health: { kind: 'port', port: PORTS.client },
	})

	services.push({
		name: 'caddy',
		enabled: ctx.has.caddy,
		reason: ctx.has.caddy
			? 'edge on :8080'
			: 'caddy not on PATH — no :8080 edge (/dev/{port}, /livekit, /shared-browser routes)',
		cmd: `caddy run --config '${ctx.repoDir}/deploy/Caddyfile' --adapter caddyfile`,
		health: { kind: 'port', port: PORTS.caddy },
	})

	services.push({
		name: 'livekit',
		enabled: livekitOn,
		reason: !ctx.has.livekit
			? 'livekit-server not on PATH — voice/video disabled'
			: !livekitKeysOk
				? `${ctx.livekitConf} present but LIVEKIT_API_KEY/LIVEKIT_API_SECRET unset (put them in dev.env)`
				: ctx.livekitConf
					? `config ${ctx.livekitConf}`
					: 'dev mode (built-in devkey/secret)',
		cmd: ctx.livekitConf
			? `livekit-server --config '${ctx.livekitConf}'`
			: 'livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1',
		health: { kind: 'port', port: PORTS.livekit },
	})

	services.push({
		name: 'whisper',
		enabled: ctx.has.whisper,
		reason: ctx.has.whisper
			? `local STT on :${PORTS.whisper}`
			: 'whisper-server (or its model) missing — no keyless transcription',
		// --inference-path makes whisper.cpp serve the OpenAI-compatible path,
		// so STT_URL=http://localhost:8091/v1 satisfies the scribe's contract.
		cmd: `whisper-server --host 127.0.0.1 --port ${PORTS.whisper} -m '${ctx.whisperModel}' --inference-path /v1/audio/transcriptions`,
		health: { kind: 'port', port: PORTS.whisper },
	})

	// Scribe: needs the SFU (to hear the room) and an STT backend. Resolution:
	// explicit STT_URL (dev.env) > hosted STT_API_KEY (transcriber defaults to
	// Groq) > the local whisper window above.
	const whisperOn = services[services.length - 1].enabled
	const localSttUrl = whisperOn ? `http://localhost:${PORTS.whisper}/v1` : undefined
	const scribeOn = livekitOn && Boolean(ctx.env.STT_URL || ctx.env.STT_API_KEY || localSttUrl)
	const scribeExports = [`export LIVEKIT_URL='ws://localhost:${PORTS.livekit}'`]
	if (!ctx.env.STT_URL && !ctx.env.STT_API_KEY && localSttUrl) {
		scribeExports.push(`export STT_URL='${localSttUrl}' STT_MODEL='${ctx.env.STT_MODEL ?? 'whisper-1'}'`)
	}
	services.push({
		name: 'scribe',
		enabled: scribeOn,
		reason: !livekitOn
			? 'needs LiveKit running (it subscribes to the room audio)'
			: scribeOn
				? ctx.env.STT_URL
					? `STT at ${ctx.env.STT_URL}`
					: ctx.env.STT_API_KEY
						? 'hosted STT (STT_API_KEY set)'
						: `local whisper at ${localSttUrl}`
				: 'no STT backend — set STT_API_KEY (e.g. Groq) or STT_URL in dev.env, or install whisper-server',
		// Waits for BOTH the sync server (its token fetch) and the SFU's
		// signaling port so its startup doesn't race the others.
		cmd: `${scribeExports.join('; ')}; until curl -fsS http://localhost:${PORTS.sync}/api/health >/dev/null 2>&1 && timeout 1 bash -c '</dev/tcp/localhost/${PORTS.livekit}' 2>/dev/null; do sleep 2; done; npm run dev --workspace=transcriber`,
		health: null,
	})

	// Shared browser: a neko container (real Firefox streamed over WebRTC),
	// proxied by Caddy's /shared-browser route. Native hosts with docker only —
	// the devcontainer deliberately excludes it (docker-in-docker).
	const nekoUdp = ctx.env.NEKO_UDPMUX ?? '52000'
	const nekoNat = ctx.env.NEKO_NAT1TO1 ?? ctx.tailscaleIp ?? '127.0.0.1'
	const sbOn = ctx.has.docker && ctx.env.SHARED_BROWSER_ENABLE !== '0'
	services.push({
		name: 'shared-browser',
		enabled: sbOn,
		reason: !ctx.has.docker
			? 'docker not on PATH — shared browser off (fine; it is optional)'
			: sbOn
				? `neko on :8090, WebRTC udp ${nekoUdp} at ${nekoNat}`
				: 'disabled by SHARED_BROWSER_ENABLE=0',
		cmd:
			'docker rm -f ensembleworks-shared-browser >/dev/null 2>&1; ' +
			'docker run --rm --name ensembleworks-shared-browser --shm-size=2g ' +
			`-p 127.0.0.1:8090:8080 -p ${nekoUdp}:${nekoUdp}/udp ` +
			`-e NEKO_DESKTOP_SCREEN='${ctx.env.NEKO_SCREEN ?? '1280x720@30'}' ` +
			'-e NEKO_MEMBER_PROVIDER=multiuser ' +
			`-e NEKO_MEMBER_MULTIUSER_USER_PASSWORD='${ctx.env.NEKO_USER_PASSWORD ?? 'neko'}' ` +
			`-e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD='${ctx.env.NEKO_ADMIN_PASSWORD ?? 'admin'}' ` +
			'-e NEKO_SESSION_IMPLICIT_HOSTING=true -e NEKO_SESSION_INACTIVE_CURSORS=true ' +
			`-e NEKO_WEBRTC_UDPMUX=${nekoUdp} -e NEKO_WEBRTC_NAT1TO1='${nekoNat}' ` +
			`'${ctx.env.NEKO_IMAGE ?? 'ghcr.io/m1k1o/neko/firefox:latest'}'`,
		health: null,
	})

	return services
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx bin/dev.test.ts`
Expected: PASS — every `ok: …` line then `all dev-lib tests passed`

- [ ] **Step 5: Wire typechecking and gitignore**

Create `bin/tsconfig.json`:

```json
{
	"compilerOptions": {
		"allowJs": true,
		"checkJs": true,
		"noEmit": true,
		"strict": true,
		"target": "es2022",
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"types": ["node"]
	},
	"include": ["dev-lib.mjs", "dev-main.mjs", "dev-doctor.mjs"]
}
```

(`dev-main.mjs` / `dev-doctor.mjs` arrive in Tasks 2–3; tsc ignores missing include entries.)

In root `package.json`, change the `typecheck` script line to:

```json
    "typecheck": "npm run typecheck --workspace=client && npm run typecheck --workspace=server && npm run typecheck --workspace=transcriber && tsc -p bin/tsconfig.json"
```

In `.gitignore`, after the `data/` line add:

```
.local/
```

- [ ] **Step 6: Run the typecheck**

Run: `npm run typecheck`
Expected: PASS (all three workspaces + `tsc -p bin/tsconfig.json` exit 0)

Run: `git check-ignore -v .local && echo IGNORED`
Expected: prints the `.gitignore` rule and `IGNORED`

- [ ] **Step 7: Commit**

```bash
git add bin/dev-lib.mjs bin/dev.test.ts bin/tsconfig.json package.json .gitignore
git commit -m "feat(dev): bin/dev core — tested service table, gating, parsers"
```

---

### Task 2: `bin/dev` CLI — up/down/status/logs/restart/attach

**Files:**
- Create: `bin/dev` (executable CJS shim)
- Create: `bin/dev-main.mjs`
- Test: manual verification commands (this is the I/O layer; logic was tested in Task 1)

**Interfaces:**
- Consumes: everything Task 1 produces from `./dev-lib.mjs`.
- Produces: `bin/dev <up|down|status|logs|restart|attach>` on disk; `makeCtx()` and the `usage()` text in `dev-main.mjs` (Task 3 extends both the dispatch and usage with `doctor`). `status --json` shape: `{ session, running, services: [{ name, enabled, reason, window, healthy, health }] }`.

> **Verification caveat:** on a host already running the dev stack (e.g. the
> baljeet `workspace` session), do NOT run `up`/`down` against the live
> session — set `WORKSPACE_TMUX_SESSION=devtest` for smoke-checks that don't
> need the real ports, and skip the full-cycle check if ports are occupied.

- [ ] **Step 1: Write the shim**

Create `bin/dev`:

```javascript
#!/usr/bin/env node
// CJS shim: the repo root has no "type": "module", so this extensionless
// entry loads as CommonJS; the implementation is ESM in dev-main.mjs.
const { pathToFileURL } = require('node:url')
import(pathToFileURL(`${__dirname}/dev-main.mjs`).href).catch((err) => {
	console.error(err)
	process.exit(1)
})
```

Run: `chmod +x bin/dev`

- [ ] **Step 2: Write dev-main.mjs**

Create `bin/dev-main.mjs`:

```javascript
// @ts-check
/**
 * bin/dev — the EnsembleWorks dev stack, one command. tmux is the engine:
 * each service runs in a window of the `workspace` session (the same shape
 * the Debian boxes run under systemd), wrapped by hold() so a crash leaves
 * exit code + scrollback + a live shell instead of a vanished window.
 *
 * Pure logic (service table, gating, parsing) lives in ./dev-lib.mjs and is
 * unit-tested; this file owns the I/O: process env, tmux, health polls, CLI.
 * Dependency-free on purpose — node: builtins only — so it runs on a fresh
 * clone before npm ci.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PORTS, buildServices, hold, parseDotEnv, parseNvmrc } from './dev-lib.mjs'

export const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const session = process.env.WORKSPACE_TMUX_SESSION ?? 'workspace'
const tmuxConf = path.join(repoDir, 'deploy', 'tmux-ensembleworks.conf')

/** @param {string} bin */
export const onPath = (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
/** @param {...string} args */
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' })
/** @param {...string} args */
const tmuxOk = (...args) => spawnSync('tmux', args, { stdio: 'ignore' }).status === 0
export const sessionRunning = () => tmuxOk('has-session', '-t', session)

/** @param {string} msg @returns {never} */
function die(msg) {
	console.error(`bin/dev: ${msg}`)
	process.exit(1)
}

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

// ---- config: dev.env (set -a semantics), data dir, optional livekit conf ----
export const devEnvPath =
	process.env.ENSEMBLEWORKS_DEV_ENV ?? path.join(homedir(), '.config', 'ensembleworks', 'dev.env')
if (existsSync(devEnvPath)) {
	for (const [k, v] of Object.entries(parseDotEnv(readFileSync(devEnvPath, 'utf8')))) {
		if (process.env[k] === undefined) process.env[k] = v // real env wins over dev.env
	}
}

const dataDir =
	process.env.ENSEMBLEWORKS_DATA_DIR ?? path.join(homedir(), '.local', 'share', 'ensembleworks')
const livekitConfPath =
	process.env.ENSEMBLEWORKS_LIVEKIT_CONF ??
	path.join(homedir(), '.config', 'ensembleworks', 'livekit-dev.yaml')
const whisperModel = process.env.WHISPER_MODEL ?? '/usr/local/share/whisper/ggml-base.bin'

function tailscaleIp() {
	try {
		const out = execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return out.split('\n')[0].trim() || null
	} catch {
		return null
	}
}

/** @returns {import('./dev-lib.mjs').ServiceCtx} */
export function makeCtx() {
	return {
		repoDir,
		dataDir,
		publicHost: process.env.ENSEMBLEWORKS_PUBLIC_HOST ?? null,
		livekitConf: existsSync(livekitConfPath) ? livekitConfPath : null,
		whisperModel,
		tailscaleIp: tailscaleIp(),
		has: {
			caddy: onPath('caddy'),
			livekit: onPath('livekit-server'),
			whisper: onPath('whisper-server') && existsSync(whisperModel),
			docker: onPath('docker'),
		},
		env: process.env,
	}
}

// ---- health ------------------------------------------------------------------
/** @param {number} port */
export function probePort(port, timeoutMs = 1000) {
	return new Promise((resolve) => {
		const sock = connect({ port, host: '127.0.0.1' })
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

/** @param {import('./dev-lib.mjs').Service['health']} health */
async function probe(health) {
	if (!health) return null
	if (health.kind === 'port') return probePort(health.port)
	try {
		const res = await fetch(health.url, { signal: AbortSignal.timeout(1000) })
		return res.ok
	} catch {
		return false
	}
}

/** @param {import('./dev-lib.mjs').Service[]} enabled */
async function waitHealthy(enabled, timeoutMs = 180_000) {
	const pending = new Set(enabled.filter((s) => s.health))
	const deadline = Date.now() + timeoutMs
	while (pending.size && Date.now() < deadline) {
		for (const svc of [...pending]) {
			if (await probe(svc.health)) {
				console.log(`  ✓ ${svc.name}`)
				pending.delete(svc)
			}
		}
		if (pending.size) await new Promise((r) => setTimeout(r, 1500))
	}
	if (pending.size) {
		const names = [...pending].map((s) => s.name).join(', ')
		die(`not healthy after ${timeoutMs / 1000}s: ${names} — check \`bin/dev logs <svc>\``)
	}
}

// ---- subcommands ---------------------------------------------------------------
/** @param {{ noInstall: boolean, attach: boolean }} flags */
async function up(flags) {
	mkdirSync(dataDir, { recursive: true })
	const services = buildServices(makeCtx())
	const enabled = services.filter((s) => s.enabled)
	if (sessionRunning()) {
		tmux('set-environment', '-g', 'ENSEMBLEWORKS_TMUX_CONF', tmuxConf)
		tmux('source-file', tmuxConf)
		console.log(`already running (tmux session '${session}').`)
	} else {
		if (!flags.noInstall) {
			console.log('==> npm ci (skip with --no-install)')
			execFileSync('npm', ['ci'], { cwd: repoDir, stdio: 'inherit' })
		}
		for (const s of services.filter((x) => !x.enabled)) console.log(`  - ${s.name} off: ${s.reason}`)
		const [first, ...rest] = enabled
		// Exported before the tmux SERVER starts, so canvas terminals inherit it.
		process.env.ENSEMBLEWORKS_TMUX_CONF = tmuxConf
		tmux('-f', tmuxConf, 'new-session', '-d', '-s', session, '-n', first.name, '-c', repoDir, hold(first.cmd, first.name))
		tmux('set-environment', '-g', 'ENSEMBLEWORKS_TMUX_CONF', tmuxConf)
		for (const s of rest) {
			tmux('new-window', '-t', session, '-n', s.name, '-c', repoDir, hold(s.cmd, s.name))
		}
		console.log('==> waiting for services')
		await waitHealthy(enabled)
	}
	cheatSheet(enabled)
	if (flags.attach) attach()
}

/** @param {import('./dev-lib.mjs').Service[]} enabled */
function cheatSheet(enabled) {
	const url = process.env.ENSEMBLEWORKS_PUBLIC_HOST
		? `https://${process.env.ENSEMBLEWORKS_PUBLIC_HOST}`
		: `http://localhost:${PORTS.caddy}`
	console.log(`
EnsembleWorks dev stack — ${url}
  windows: ${enabled.map((s) => s.name).join('  ')}
  bin/dev status | logs <svc> | restart <svc> | attach | down   (agents: status --json)
  tmux: prefix Ctrl-Space (Ctrl-b works too) — prefix+<n> switch window, prefix+d detach`)
}

function windowNames() {
	if (!sessionRunning()) return []
	return tmux('list-windows', '-t', session, '-F', '#{window_name}').trim().split('\n')
}

/** @param {{ json: boolean }} flags */
async function status(flags) {
	const services = buildServices(makeCtx())
	const windows = windowNames()
	const rows = []
	for (const s of services) {
		rows.push({
			name: s.name,
			enabled: s.enabled,
			reason: s.reason,
			window: windows.includes(s.name),
			healthy: s.enabled ? await probe(s.health) : null,
			health: s.health,
		})
	}
	if (flags.json) {
		console.log(JSON.stringify({ session, running: sessionRunning(), services: rows }, null, 2))
		return
	}
	console.log(`session '${session}': ${sessionRunning() ? 'running' : 'not running'}`)
	for (const r of rows) {
		const state = !r.enabled
			? `off — ${r.reason}`
			: r.healthy === true
				? 'healthy'
				: r.healthy === false
					? r.window
						? 'UNHEALTHY (window up, probe failing)'
						: 'not started'
					: r.window
						? 'running (no probe)'
						: 'not started'
		console.log(`  ${r.name.padEnd(15)} ${state}`)
	}
}

/** @param {string} name @param {number} tail */
function logs(name, tail) {
	if (!sessionRunning()) die(`session '${session}' is not running`)
	if (!windowNames().includes(name)) die(`no window '${name}' — bin/dev status lists services`)
	process.stdout.write(tmux('capture-pane', '-p', '-t', `${session}:${name}`, '-S', `-${tail}`))
}

/** @param {string} name */
function restart(name) {
	if (!sessionRunning()) die(`session '${session}' is not running — use bin/dev up`)
	const svc = buildServices(makeCtx()).find((s) => s.name === name)
	if (!svc) die(`unknown service '${name}' — bin/dev status lists services`)
	if (!svc.enabled) die(`'${name}' is disabled: ${svc.reason}`)
	if (windowNames().includes(name)) {
		tmux('respawn-window', '-k', '-t', `${session}:${name}`, hold(svc.cmd, svc.name))
	} else {
		tmux('new-window', '-t', session, '-n', svc.name, '-c', repoDir, hold(svc.cmd, svc.name))
	}
	console.log(`respawned ${name}`)
}

function down() {
	if (!sessionRunning()) {
		console.log(`session '${session}' is not running`)
		return
	}
	tmux('kill-session', '-t', session)
	console.log(`killed tmux session '${session}'`)
}

function attach() {
	if (!sessionRunning()) die(`session '${session}' is not running — use bin/dev up`)
	const args = process.env.TMUX ? ['switch-client', '-t', session] : ['attach', '-t', session]
	const r = spawnSync('tmux', args, { stdio: 'inherit' })
	process.exit(r.status ?? 0)
}

function usage() {
	console.log(`bin/dev — the EnsembleWorks dev stack (tmux session '${session}')

  bin/dev up [--attach] [--no-install]   start everything (idempotent; npm ci on fresh start)
  bin/dev down                           kill the session
  bin/dev status [--json]                per-service state (--json for agents)
  bin/dev logs <svc> [--tail N]          one service's scrollback (default 200 lines)
  bin/dev restart <svc>                  respawn one service window
  bin/dev attach                         enter the tmux session (prefix Ctrl-Space, prefix+d detaches)

Config: ~/.config/ensembleworks/dev.env (optional). Data: ~/.local/share/ensembleworks.
Optional binaries light up more services: caddy, livekit-server, whisper-server, docker.`)
}

// ---- dispatch ------------------------------------------------------------------
const { values: flags, positionals } = parseArgs({
	args: process.argv.slice(2),
	options: {
		json: { type: 'boolean', default: false },
		attach: { type: 'boolean', default: false },
		'no-install': { type: 'boolean', default: false },
		tail: { type: 'string', default: '200' },
	},
	allowPositionals: true,
})
const [cmd, arg] = positionals

switch (cmd) {
	case 'up':
		await up({ noInstall: flags['no-install'], attach: flags.attach })
		break
	case 'down':
		down()
		break
	case 'status':
		await status({ json: flags.json })
		break
	case 'logs':
		logs(arg ?? die('usage: bin/dev logs <svc> [--tail N]'), Number(flags.tail))
		break
	case 'restart':
		restart(arg ?? die('usage: bin/dev restart <svc>'))
		break
	case 'attach':
		attach()
		break
	case undefined:
		usage()
		break
	default:
		usage()
		process.exit(1)
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Verify the CLI cold paths**

```bash
bin/dev                                   # usage text, exit 0
WORKSPACE_TMUX_SESSION=devtest bin/dev status
WORKSPACE_TMUX_SESSION=devtest bin/dev status --json
```

Expected: usage prints; status shows `session 'devtest': not running` with every service listed (enabled/off with reasons matching this host's binaries); `--json` emits valid JSON (pipe through `python3 -m json.tool` to confirm).

- [ ] **Step 5: Verify a full up/down cycle (only if the host's ports are free)**

If `bin/dev status` shows nothing healthy (no live stack on 8788/5173/etc):

```bash
bin/dev up --no-install
bin/dev status --json
bin/dev logs sync --tail 40
bin/dev restart client
bin/dev status
bin/dev down
```

Expected: `up` prints `✓ sync` / `✓ term` / `✓ client` (+ caddy/livekit if installed) then the cheat-sheet; `status` healthy; `logs` shows the sync server's output; after `restart client`, client returns to healthy; `down` kills the session. If the live baljeet stack occupies the ports, defer this step to Task 7's migration and note that in the commit message.

- [ ] **Step 6: Commit**

```bash
git add bin/dev bin/dev-main.mjs
git commit -m "feat(dev): bin/dev CLI — up/down/status/logs/restart/attach on tmux"
```

---

### Task 3: `bin/dev doctor` — executable prerequisites

**Files:**
- Create: `bin/dev-doctor.mjs`
- Modify: `bin/dev-main.mjs` (dispatch + usage line)

**Interfaces:**
- Consumes from `dev-main.mjs`: `makeCtx()`, `onPath()`, `probePort()`, `sessionRunning()`, `repoDir`, `devEnvPath`, `wantedNode` (all already exported), and `PORTS` from `dev-lib.mjs`.
- Produces: `runDoctor(opts: { json: boolean }): Promise<number>` (exit code) exported from `dev-doctor.mjs`.

- [ ] **Step 1: Write dev-doctor.mjs**

Create `bin/dev-doctor.mjs`:

```javascript
// @ts-check
/**
 * bin/dev doctor — the prerequisites as executable checks instead of prose.
 * Every failing check prints its remedy; exit code 0 = ready to `bin/dev up`.
 * required = the stack can't run without it; optional = a service stays off.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PORTS } from './dev-lib.mjs'
import {
	devEnvPath,
	makeCtx,
	onPath,
	probePort,
	repoDir,
	sessionRunning,
	wantedNode,
} from './dev-main.mjs'

/**
 * @typedef {{ name: string, level: 'required' | 'optional' | 'info',
 *             ok: boolean, detail: string, remedy?: string }} Check
 */

/** @param {{ json: boolean }} opts @returns {Promise<number>} */
export async function runDoctor(opts) {
	const ctx = makeCtx()
	/** @type {Check[]} */
	const checks = []

	// Node: if we're executing, the version gate in dev-main already passed
	// (or re-exec'd via mise) — report it for completeness.
	checks.push({
		name: 'node',
		level: 'required',
		ok: process.version === `v${wantedNode}`,
		detail: `${process.version} (want v${wantedNode} from .nvmrc — node-pty ABI pin)`,
		remedy: `install Node ${wantedNode}: \`mise use -g node@${wantedNode}\` or \`nvm install ${wantedNode}\``,
	})

	const tmuxV = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
	const tmuxVer = tmuxV.status === 0 ? (tmuxV.stdout.match(/(\d+\.\d+)/)?.[1] ?? '0') : null
	checks.push({
		name: 'tmux',
		level: 'required',
		ok: tmuxVer !== null && Number.parseFloat(tmuxVer) >= 3.3,
		detail: tmuxVer ? `tmux ${tmuxVer} (min 3.3)` : 'not on PATH',
		remedy: 'apt install tmux (>= 3.3, per deploy/runtime-requirements)',
	})

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

	checks.push({
		name: '.local ignored',
		level: 'required',
		ok: spawnSync('git', ['-C', repoDir, 'check-ignore', '-q', '.local'], { stdio: 'ignore' }).status === 0,
		detail: 'the devcontainer keeps state+keys under <repo>/.local — it must never be committed',
		remedy: 'add a `.local/` line to .gitignore',
	})

	checks.push({
		name: 'caddy',
		level: 'optional',
		ok: ctx.has.caddy,
		detail: ctx.has.caddy ? 'on PATH' : 'missing — no :8080 edge (/dev/{port}, /livekit routes)',
		remedy: 'https://caddyserver.com/docs/install (min 2.7)',
	})
	checks.push({
		name: 'livekit-server',
		level: 'optional',
		ok: ctx.has.livekit,
		detail: ctx.has.livekit ? 'on PATH' : 'missing — voice/video stays disabled',
		remedy: 'install livekit-server 1.13.1 (deploy/runtime-requirements pin)',
	})
	checks.push({
		name: 'whisper-server',
		level: 'optional',
		ok: ctx.has.whisper,
		detail: ctx.has.whisper
			? `binary + model (${ctx.whisperModel})`
			: 'binary or model missing — no keyless transcription (a hosted STT_API_KEY also works)',
		remedy: `build whisper.cpp's whisper-server and put a ggml model at ${ctx.whisperModel} (or set WHISPER_MODEL)`,
	})
	checks.push({
		name: 'docker',
		level: 'optional',
		ok: ctx.has.docker,
		detail: ctx.has.docker ? 'on PATH (shared browser available)' : 'missing — shared browser off (optional)',
		remedy: 'install docker if you want the neko shared browser',
	})

	// Ports: only meaningful when OUR session isn't the thing holding them.
	if (!sessionRunning()) {
		const taken = []
		for (const [name, port] of Object.entries(PORTS)) {
			if (await probePort(port)) taken.push(`${name}:${port}`)
		}
		checks.push({
			name: 'ports free',
			level: 'required',
			ok: taken.length === 0,
			detail: taken.length ? `already bound: ${taken.join(', ')}` : 'all service ports free',
			remedy: 'stop whatever holds those ports (another checkout’s stack?)',
		})
	}

	checks.push({
		name: 'dev.env',
		level: 'info',
		ok: existsSync(devEnvPath),
		detail: existsSync(devEnvPath)
			? `present at ${devEnvPath}`
			: `absent (${devEnvPath}) — fine: defaults are keyless`,
	})

	if (opts.json) {
		console.log(JSON.stringify({ checks }, null, 2))
	} else {
		for (const c of checks) {
			const mark = c.ok ? '✓' : c.level === 'required' ? '✗' : c.level === 'optional' ? '–' : ' '
			console.log(`${mark} ${c.name.padEnd(15)} ${c.detail}`)
			if (!c.ok && c.remedy) console.log(`     fix: ${c.remedy}`)
		}
	}
	const failed = checks.filter((c) => c.level === 'required' && !c.ok)
	if (!opts.json) {
		console.log(failed.length ? `\nnot ready: ${failed.map((c) => c.name).join(', ')}` : '\nready — bin/dev up')
	}
	return failed.length ? 1 : 0
}
```

- [ ] **Step 2: Wire the dispatch**

In `bin/dev-main.mjs`, add a `doctor` case to the `switch` (before `case undefined:`):

```javascript
	case 'doctor': {
		const { runDoctor } = await import('./dev-doctor.mjs')
		process.exit(await runDoctor({ json: flags.json }))
	}
```

And in `usage()`, after the `attach` line add:

```
  bin/dev doctor [--json]                environment check — every failure prints its remedy
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
bin/dev doctor
bin/dev doctor --json | python3 -m json.tool > /dev/null && echo JSON-OK
```

Expected: typecheck passes; doctor prints one line per check with ✓/✗/– marks and remedies for anything missing on this host; exit code 0 iff all required checks pass (`echo $?` after); `JSON-OK`.

- [ ] **Step 4: Commit**

```bash
git add bin/dev-doctor.mjs bin/dev-main.mjs
git commit -m "feat(dev): bin/dev doctor — prerequisites as executable checks"
```

---

### Task 4: Devcontainer — Debian 13, everything baked in

**Files:**
- Create: `.devcontainer/devcontainer.json`
- Create: `.devcontainer/Dockerfile`
- Create: `.devcontainer/post-create.bash`

**Interfaces:**
- Consumes: `bin/dev` (Tasks 2–3), `.nvmrc`, `deploy/Caddyfile`, `deploy/runtime-requirements` pins.
- Produces: a devcontainer where `bin/dev up` brings up sync/term/client/caddy/livekit/whisper/scribe keylessly; `<repo>/.local/{share,config}/ensembleworks` backing the home-dir paths.

- [ ] **Step 1: Write the Dockerfile**

Create `.devcontainer/Dockerfile`:

```dockerfile
# EnsembleWorks devcontainer — Debian 13 (trixie), the same OS as the
# production and dogfood boxes. Everything a keyless contributor needs is
# baked in: Node (exact version from .nvmrc), tmux, Caddy, the LiveKit OSS
# SFU (voice/video via --dev keys) and whisper.cpp + a small model (keyless
# transcription). Version pins follow deploy/runtime-requirements — bump them
# together. The shared browser (neko) is deliberately absent: it needs
# docker-in-docker; use a native host for that.
FROM debian:trixie

ARG CADDY_VERSION=2.10.0
ARG LIVEKIT_VERSION=1.13.1
ARG WHISPER_TAG=v1.7.4

RUN apt-get update && apt-get install -y --no-install-recommends \
		build-essential ca-certificates cmake curl git gh less locales \
		pkg-config procps python3 sudo tmux xz-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8

# Node — exact version read from .nvmrc (single source of truth; bin/dev and
# the deploy preflight enforce the same pin at runtime).
COPY .nvmrc /tmp/.nvmrc
RUN set -eux; \
	ver="$(tr -d 'v[:space:]' < /tmp/.nvmrc)"; \
	case "$(dpkg --print-architecture)" in amd64) a=x64;; arm64) a=arm64;; *) echo "unsupported arch" >&2; exit 1;; esac; \
	curl -fsSL "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${a}.tar.xz" \
		| tar -xJ -C /usr/local --strip-components=1; \
	node -v

# Caddy — static binary (not packaged in Debian main).
RUN set -eux; \
	case "$(dpkg --print-architecture)" in amd64) a=amd64;; arm64) a=arm64;; esac; \
	curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${a}.tar.gz" \
		| tar -xz -C /usr/local/bin caddy; \
	caddy version

# LiveKit OSS SFU — exact pin per deploy/runtime-requirements.
RUN set -eux; \
	case "$(dpkg --print-architecture)" in amd64) a=amd64;; arm64) a=arm64;; esac; \
	curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${a}.tar.gz" \
		| tar -xz -C /usr/local/bin livekit-server; \
	livekit-server --version

# whisper.cpp server + a small multilingual model — keyless local STT. The
# scribe's contract is OpenAI's POST <STT_URL>/audio/transcriptions; served
# natively via whisper-server's --inference-path (see bin/dev-lib.mjs).
RUN set -eux; \
	git clone --depth 1 --branch "${WHISPER_TAG}" https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp; \
	cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF; \
	cmake --build /tmp/whisper.cpp/build -j"$(nproc)" --target whisper-server; \
	install -m 0755 /tmp/whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server; \
	rm -rf /tmp/whisper.cpp; \
	mkdir -p /usr/local/share/whisper; \
	curl -fsSL -o /usr/local/share/whisper/ggml-base.bin \
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

# Non-root user, uid 1000 — what VS Code / Codespaces expects.
RUN useradd -m -s /bin/bash -u 1000 dev \
	&& echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
USER dev
```

> **Implementation notes for this step:**
> - Verify the pinned tags exist before building: `WHISPER_TAG` should be the
>   latest whisper.cpp release tag (v1.7.4 was current at planning; bump if
>   newer), `CADDY_VERSION` any release ≥ 2.7.0.
> - Verify `whisper-server --help` lists `--inference-path`. If the pinned tag
>   lacks it, EITHER bump the tag (preferred) OR fall back to adding this
>   adapter route to `deploy/Caddyfile` (inside the `:8080` block, above the
>   final `handle`) and changing `dev-lib.mjs`'s `localSttUrl` to
>   `http://localhost:${PORTS.caddy}/stt/v1` with a matching test update:
>   ```
>   @stt path /stt/v1/audio/transcriptions
>   handle @stt {
>       rewrite * /inference
>       reverse_proxy localhost:8091
>   }
>   ```

- [ ] **Step 2: Write devcontainer.json**

Create `.devcontainer/devcontainer.json`:

```jsonc
// EnsembleWorks devcontainer. The canvas is on forwarded port 8080 (Caddy).
// Voice/video (LiveKit) needs UDP: works for LOCAL devcontainers via runArgs
// port mappings below; Codespaces forwards TCP only, so AV stays silent there
// — everything else works. State/keys live in the git-ignored .local/ folder
// (symlinked to the home-dir paths by post-create.bash) and survive rebuilds.
{
	"name": "EnsembleWorks",
	"build": { "dockerfile": "Dockerfile", "context": ".." },
	"remoteUser": "dev",
	"forwardPorts": [8080],
	"portsAttributes": {
		"8080": { "label": "EnsembleWorks (Caddy edge)", "onAutoForward": "openBrowserOnce" }
	},
	// LiveKit dev-mode media: TCP 7881 + UDP mux 7882, advertised at 127.0.0.1
	// (bin/dev passes --node-ip 127.0.0.1). Ignored by Codespaces — harmless.
	"runArgs": ["-p", "7881:7881", "-p", "7882:7882/udp"],
	"postCreateCommand": "bash .devcontainer/post-create.bash",
	"postStartCommand": "bin/dev up --no-install"
}
```

- [ ] **Step 3: Write post-create.bash**

Create `.devcontainer/post-create.bash`:

```bash
#!/usr/bin/env bash
# Devcontainer post-create: back the home-dir state/config paths (the
# interface every doc and server uses) with the git-ignored .local/ folder in
# the workspace, so canvas SQLite, uploads and dev.env survive container
# rebuilds — the workspace is the one thing local devcontainers AND
# Codespaces both persist. Then install deps.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$repo/.local/share/ensembleworks" "$repo/.local/config/ensembleworks"
mkdir -p "$HOME/.local/share" "$HOME/.config"
ln -sfn "$repo/.local/share/ensembleworks" "$HOME/.local/share/ensembleworks"
ln -sfn "$repo/.local/config/ensembleworks" "$HOME/.config/ensembleworks"

cd "$repo"
npm ci
bin/dev doctor || true   # informational on first build — shows what's lit up
```

Run: `chmod +x .devcontainer/post-create.bash`

- [ ] **Step 4: Build and verify (requires docker on the implementing host)**

```bash
docker build -f .devcontainer/Dockerfile -t ew-devcontainer .
```

Expected: image builds; the `node -v`, `caddy version`, `livekit-server --version` layer checks print the pinned versions.

```bash
docker run --rm -v "$PWD:/workspaces/ensembleworks" -w /workspaces/ensembleworks \
  ew-devcontainer bash -c '
    bash .devcontainer/post-create.bash &&
    readlink ~/.local/share/ensembleworks && readlink ~/.config/ensembleworks &&
    bin/dev doctor; echo "doctor exit: $?" &&
    bin/dev up --no-install &&
    bin/dev status --json &&
    cd server && npx tsx src/smoke-client.ts && npx tsx src/smoke-terminal.ts'
```

Expected: symlinks point into `/workspaces/ensembleworks/.local/…`; doctor exit 0 (all required ✓; caddy/livekit/whisper ✓, docker –); `up` reports every service healthy including livekit and whisper; both smoke tests pass.

> Note: the container mounts the host checkout, so `npm ci` inside it rebuilds
> `node_modules` for the container's platform. Afterwards, run `npm ci` again
> on the host (or let the next `bin/dev up` do it) before using the host stack.
> If the host checkout's stack is live, run this verification from a scratch
> clone instead: `git clone . /tmp/ew-verify && cd /tmp/ew-verify && docker build …`.

Also verify the whisper contract from inside the running check above (or a second `docker run`):

```bash
docker run --rm -v "$PWD:/workspaces/ensembleworks" -w /workspaces/ensembleworks ew-devcontainer bash -c '
  whisper-server --host 127.0.0.1 --port 8091 -m /usr/local/share/whisper/ggml-base.bin \
    --inference-path /v1/audio/transcriptions & sleep 3 &&
  python3 -c "import struct,wave; w=wave.open(\"/tmp/t.wav\",\"w\"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b\"\x00\x00\"*16000); w.close()" &&
  curl -fsS -F file=@/tmp/t.wav -F model=whisper-1 http://127.0.0.1:8091/v1/audio/transcriptions'
```

Expected: JSON with a `"text"` key (empty/blank text is fine — it's a second of silence). If `--inference-path` is unsupported, apply the Caddy fallback from Step 1's note and re-verify via `http://localhost:8080/stt/v1/audio/transcriptions` with caddy running.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/
git commit -m "feat(dev): Debian 13 devcontainer — keyless canvas+terminals+voice+STT"
```

---

### Task 5: `release.sh` — validate in an isolated worktree

**Files:**
- Modify: `deploy/release.sh`

**Interfaces:**
- Consumes: `.nvmrc`.
- Produces: `RELEASE_DRY_RUN=1 deploy/release.sh <bump>` — validation without bump/push (also the regression test for the live-stack clash).

- [ ] **Step 1: Rewrite the validation section**

In `deploy/release.sh`, replace everything from the `git fetch origin main` line through the `npm run build` line with:

```bash
# Dry run (RELEASE_DRY_RUN=1): run the full validation but skip the
# origin-sync requirement and stop before bump/push. Lets you test the
# release gate — including "does it disturb a running bin/dev stack?" — at
# any time. A real release still requires clean main == origin/main.
if [ -z "${RELEASE_DRY_RUN:-}" ]; then
	git fetch origin main
	[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
		echo "local main != origin/main" >&2
		exit 1
	}
fi

echo "==> preflight: node matches .nvmrc"
wanted="v$(tr -d 'v[:space:]' <.nvmrc)"
[ "$(node -v)" = "$wanted" ] || {
	echo "node $(node -v) but .nvmrc pins $wanted (node-pty ABI) — install it and retry" >&2
	exit 1
}

# Validate in a throwaway worktree: `npm ci` DELETES node_modules, which used
# to yank node-pty out from under the running dev services (tsx watch, vite,
# the terminal gateway) when releasing from a live checkout. The worktree gets
# its own fresh node_modules and is removed afterwards; the live tree is never
# touched. The bump/tag below still happens here — a one-file commit that
# watchers shrug at.
echo "==> validating build before tagging (isolated worktree)"
worktree_parent="$(mktemp -d /tmp/ensembleworks-release.XXXXXX)"
worktree="$worktree_parent/tree"
cleanup() {
	git worktree remove --force "$worktree" >/dev/null 2>&1 || true
	rm -rf "$worktree_parent"
}
trap cleanup EXIT
git worktree add --detach "$worktree" HEAD
(cd "$worktree" && npm ci && npm run typecheck && npm run build)

if [ -n "${RELEASE_DRY_RUN:-}" ]; then
	echo "==> dry run: validation passed; skipping version bump + push"
	exit 0
fi
```

(The `branch`/clean-tree checks above this section, and the `npm version` + push section below it, stay exactly as they are.)

- [ ] **Step 2: Syntax check**

Run: `bash -n deploy/release.sh && echo SYNTAX-OK`
Expected: `SYNTAX-OK`

- [ ] **Step 3: Regression-test the pain case**

With the dev stack running (`bin/dev status` healthy — on baljeet the live session counts; requires a clean working tree, so stash/commit first if needed):

```bash
RELEASE_DRY_RUN=1 deploy/release.sh patch
bin/dev status
```

Expected: dry run prints `==> dry run: validation passed…` and exits 0; `git worktree list` shows no leftover release worktree; `bin/dev status` (or the live tmux session) shows every service still healthy — the live `node_modules` was untouched. If no stack can run on this host right now, still run the dry run and verify the worktree cleanup + untouched `node_modules` mtime: `stat -c %y node_modules | tee /dev/stderr` before and after.

- [ ] **Step 4: Commit**

```bash
git add deploy/release.sh
git commit -m "fix(release): validate in an isolated git worktree — never touch the live node_modules"
```

---

### Task 6: Docs — README, AGENTS.md, CLAUDE.md, CONTRIBUTING.md

**Files:**
- Modify: `README.md` (the `## Development` section)
- Modify: `AGENTS.md`, `CLAUDE.md` (add a Local dev section)
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the `bin/dev` contract (Tasks 2–3), the devcontainer (Task 4).

- [ ] **Step 1: Rewrite README's Development section**

Replace the current `## Development` section body (the 5-line code block from `npm install` through `npm run build` — keep the "Smoke tests" paragraph and code block that follow) with:

```markdown
The blessed path is the **devcontainer** (`.devcontainer/`, Debian 13 — the
same OS as the production boxes): open the repo in VS Code, Codespaces or the
devcontainer CLI and it builds with everything baked in — Node from `.nvmrc`,
tmux, Caddy, a LiveKit SFU in dev mode, whisper.cpp for transcription. On
start it runs `bin/dev up`; open forwarded port 8080 and you have a working
canvas with terminals, voice and transcription, **zero accounts or keys**.
(Two devcontainer caveats: WebRTC voice needs UDP, so it works locally but
not over Codespaces port-forwarding; and the neko shared browser needs
docker-in-docker, so it's native-host only.)

Running natively instead: `bin/dev doctor` tells you exactly what's missing
and how to fix it (Node 22.22.3 and tmux are required; caddy, livekit-server,
whisper-server and docker each light up more services).

```bash
bin/dev up             # npm ci + every service in a tmux session; idempotent
bin/dev status --json  # per-service health, machine-readable (for agents)
bin/dev logs client    # one service's scrollback (--tail N)
bin/dev restart sync   # respawn one service, leave the rest alone
bin/dev attach         # enter the tmux session (prefix Ctrl-Space, prefix+d detaches)
bin/dev down           # stop everything
```

State lives at `~/.local/share/ensembleworks` (canvas SQLite, uploads,
transcripts); optional config at `~/.config/ensembleworks/dev.env`
(`STT_API_KEY` for hosted STT, `LIVEKIT_*` + `livekit-dev.yaml` for a real
SFU setup, `ENSEMBLEWORKS_PUBLIC_HOST` when serving over a tailnet/tunnel).
In the devcontainer both paths are symlinks into the git-ignored `.local/`
workspace folder, so they survive container rebuilds; `rm -rf .local` is a
factory reset.
```

- [ ] **Step 2: Add the Local dev section to AGENTS.md and CLAUDE.md**

Insert into **both** files, after the intro/workspaces line and before `## Releasing…`:

```markdown
## Local dev — bin/dev

`bin/dev up` runs the whole stack (sync :8788, terminal gateway :8789, Vite
:5173, Caddy :8080, plus livekit/whisper/scribe when their binaries are
present) in the `workspace` tmux session; the canvas is at
http://localhost:8080. It's idempotent. The commands you'll actually use:

- `bin/dev status --json` — per-service enabled/health, machine-readable
- `bin/dev logs <svc> --tail 500` — one service's scrollback (crashes keep
  their window: exit code + scrollback survive)
- `bin/dev restart <svc>` — respawn one service (after `npm install`, etc.)
- `bin/dev doctor` — environment check; every failure prints its remedy

State: `~/.local/share/ensembleworks`. Optional keys:
`~/.config/ensembleworks/dev.env`. Verify changes with `npm run typecheck`
and the smoke tests in README "Development".
```

- [ ] **Step 3: Create CONTRIBUTING.md**

```markdown
# Contributing to EnsembleWorks

## Get a dev environment

Open the repo in the devcontainer (VS Code, Codespaces, or `devcontainer
up`) — it builds Debian 13 with everything baked in and starts the stack via
`bin/dev up`; the canvas is on forwarded port 8080 with voice and
transcription working keylessly. Setting up natively instead: run
`bin/dev doctor` and follow its remedies. See README "Development" for the
`bin/dev` command reference.

Most contributors drive development with a coding agent (Claude Code &c.);
`AGENTS.md` / `CLAUDE.md` give agents the same contract in brief.

## Verify your changes

- `npm run typecheck` and `npm run build` must pass (three workspaces +
  `bin/`).
- Run the smoke tests listed in README "Development" for anything touching
  the sync server, terminal gateway, canvas API, spatial audio or the
  transcriber.

## Ground rules

- EnsembleWorks is AGPL-3.0; contributions are accepted under that license.
  The bundled tldraw SDK has its own license — see README "License".
- Releases are maintainer-cut via `deploy/release.sh`; don't bump versions
  or tags in PRs.
```

- [ ] **Step 4: Verify and commit**

Check the README claims against reality: every `bin/dev` subcommand named exists (`bin/dev` prints them), the devcontainer files referenced exist. Then:

```bash
git add README.md AGENTS.md CLAUDE.md CONTRIBUTING.md
git commit -m "docs: agent-first dev setup — devcontainer path, bin/dev contract, CONTRIBUTING"
```

---

### Task 7: Retire `~/Work/ensembleworks-devserver` (baljeet migration)

**Files:**
- Delete: `~/Work/ensembleworks-devserver` (host file, outside the repo)
- Create/modify: `~/.config/ensembleworks/dev.env` (host file, outside the repo)

This task runs on the baljeet host and touches the **live** dev stack — coordinate timing with the user if the room is in use.

- [ ] **Step 1: Carry the host config into dev.env**

The retired script defaulted `ENSEMBLEWORKS_PUBLIC_HOST` to the tailnet name; `bin/dev` must get it from `dev.env` instead:

```bash
mkdir -p ~/.config/ensembleworks
grep -q '^ENSEMBLEWORKS_PUBLIC_HOST=' ~/.config/ensembleworks/dev.env 2>/dev/null || \
  echo 'ENSEMBLEWORKS_PUBLIC_HOST=baljeet.cyprus-macaroni.ts.net' >> ~/.config/ensembleworks/dev.env
```

- [ ] **Step 2: Parity check**

```bash
cd ~/Work/ensembleworks
bin/dev doctor
tmux kill-session -t workspace 2>/dev/null; bin/dev up
bin/dev status --json
```

Expected: doctor ready (livekit/whisper may be `–` on this host — the old
launcher lacked LiveKit here too, so that's parity); `up` starts sync, term,
client, caddy (+ shared-browser if docker present); status healthy; the
canvas loads at `https://baljeet.cyprus-macaroni.ts.net` (tailscale serve
still fronts :8080 — unchanged, it's host config). Run the smoke tests:
`cd server && npx tsx src/smoke-client.ts && npx tsx src/smoke-terminal.ts`.

- [ ] **Step 3: Delete the old launcher**

```bash
rm ~/Work/ensembleworks-devserver
```

- [ ] **Step 4: Commit any stragglers & wrap up**

No repo files change in this task; confirm `git status` is clean. Report the
migration result (what's enabled on baljeet, anything that regressed) back to
the user.
```

## Self-Review

- **Spec coverage:** bin/dev CLI + service table (Tasks 1–3), devcontainer on trixie with keyless voice+STT (Task 4), `.local/` state symlinks + gitignore + doctor guard (Tasks 1, 3, 4), release.sh worktree + node preflight (Task 5), agent-first docs incl. true devcontainer claim (Task 6), devserver retirement (Task 7). Watcher-quietness concern from the spec: covered implicitly — DATA_DIR stays under `$HOME` natively; in the devcontainer the symlink keeps writes out of Vite's `client/` and tsx's module graph; Task 4's smoke-test step exercises canvas writes with the stack up.
- **Placeholders:** none — every code step carries complete content; the one deliberate contingency (whisper `--inference-path`) has its full fallback inline.
- **Type consistency:** `Service`/`ServiceCtx` shapes, `makeCtx`/`onPath`/`probePort`/`sessionRunning`/`repoDir`/`devEnvPath`/`wantedNode` exports match between Tasks 1–3; `PORTS.whisper=8091` used consistently; `status --json` shape stated in Task 2 and used in Tasks 4/7.
