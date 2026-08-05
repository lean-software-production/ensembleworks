# `ew codespace up` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `ew` binary + Docker boots any repo's unmodified `devcontainer.json` as an EW Codespace: `ew codespace up` runs the vendored `@devcontainers/cli` (spike-verified under Bun, 2026-07-21: PASS), bind-mounts a staged connector at `/ew`, execs it inside the container with creds as exec-time env, and supervises it in the foreground until SIGINT/SIGTERM — plus `stop` / `rebuild` / `list` verbs and a stable per-checkout `gatewayId` persisted host-side.

**Architecture:** Sub-project 2 of `docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md` (§6.2), implementing design doc §2.1/§2.2 as amended by the ten binding orchestrator decisions in `docs/superpowers/plans/2026-07-21-ew-codespaces-decision-log.md`. SP1 (raw-PTY backend) is landed: `terminal connect --backend pty` exists and is what the exec'd connector runs. Everything here is host-side CLI plumbing: the relay plane, the connector, and the client are untouched. The upstream CLI is **vendored as a pinned two-file esbuild bundle** (never imported as a library — the stable CLI interface *is* the compatibility promise), run as `['bun', <vendor>]` in dev and `[process.execPath, <extracted>]` + `BUN_BE_BUN=1` when compiled. Secrets ride `devcontainer exec --remote-env` and are REDACTED in every `--dry-run` output. v1 boundary (decision #10): the staged connector is the glibc x64 bun-compiled build; a musl/arm64 container will fail to exec it — documented, not detected.

**Tech Stack:** Bun + TypeScript. Tests are plain `bun <file>` scripts using `node:assert/strict` discovered by `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob — so the docker/network conformance gate is deliberately named `scripts/codespace-conformance.ts` (no `.test.` infix; decision #9) and the re-vendoring script lives at `cli/scripts/vendor-devcontainers-cli.ts` (outside every glob).

**Branch:** continue on `docs/ew-codespaces-design`.

ux-contract: none — CLI + host tooling; no interaction-bearing surface

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `cli/src/codespace/devcontainers-cli-version.ts` | Create | The single version pin (`0.87.0`) — bumping it is the deliberate act gated by the conformance smoke |
| `cli/scripts/vendor-devcontainers-cli.ts` | Create | Manual-run, network: download the pinned npm tarball, refresh `cli/vendor/devcontainers-cli/` |
| `cli/vendor/devcontainers-cli/` | Generate + commit | `devcontainer.js` (423B require shim) + `dist/spec-node/devContainersSpecCLI.js` (1.7MB bundle) + `VERSION` |
| `cli/src/codespace/vendor.test.ts` | Create | Vendor files present, `VERSION` matches the pin, `--help` runs under plain bun (network-free) |
| `cli/src/codespace/vendor-assets.js` | Create | The `with { type: 'file' }` imports that make `bun build --compile` embed the bundle |
| `cli/src/codespace/vendor-assets.d.ts` | Create | Types for the runtime-only `.js` module |
| `cli/src/codespace/devcontainers-cli.ts` | Create | Runner resolution: pure `runnerFor` argv/env + impure detect/extract `ensureDevcontainersCli` |
| `cli/src/codespace/devcontainers-cli.test.ts` | Create | Pure runner tests + dev-mode `ensure` |
| `cli/src/codespace/store.ts` | Create | `~/.config/ensembleworks/codespaces.json` + `mintGatewayId` (`cs-<dirname>-<hash8>`) |
| `cli/src/codespace/store.test.ts` | Create | Store round-trip, mint format/stability, containerId update |
| `cli/src/codespace/repo-info.ts` | Create | `git rev-parse` repo/branch detection, non-git fallback |
| `cli/src/codespace/repo-info.test.ts` | Create | Detection in a temp git repo + non-git dir |
| `cli/src/native/connect.ts` | Modify (if absent) | `--repo` / `--branch` registration-metadata flags (SP3 coordination — see Task 5) |
| `cli/src/native/connect.test.ts` | Modify (if absent) | Flag default/explicit/dry-run coverage |
| `cli/src/codespace/runtime-dir.ts` | Create | Connector-bin resolution (`EW_CONNECTOR_BIN` → execPath → refuse) + `/ew` staging |
| `cli/src/codespace/runtime-dir.test.ts` | Create | Resolution chain + staging perms |
| `cli/src/codespace/up.ts` | Create | `buildUpArgv`/`buildExecArgv`/`parseUpResult`/`resolveUpPlan` + the `codespaceUp` slot + live engine |
| `cli/src/codespace/up.test.ts` | Create | Plan argv shapes, redaction, `parseUpResult`, `--dry-run` — all network-free |
| `cli/src/codespace/supervise.ts` | Create | Restart loop: parity backoff + healthy-duration reset, abortable |
| `cli/src/codespace/supervise.test.ts` | Create | Fake-clock backoff curve / reset / abort |
| `cli/src/connector/index.ts` | Modify | `export` the existing `realTimers` (reused by the engine) |
| `cli/src/codespace/stop.ts` | Create | `docker stop <exact stored containerId>` — never filters |
| `cli/src/codespace/list.ts` | Create | Store-backed table/JSON + optional `--live` registration probe |
| `cli/src/codespace/stop-list.test.ts` | Create | Stop argv/dry-run/missing-record, list rendering |
| `cli/src/codespace/index.ts` | Create | `codespaceGroup` verb dispatch (up/stop/rebuild/list) |
| `cli/src/codespace/group.test.ts` | Create | Group dispatch via `main()`, help text |
| `cli/src/dispatch.ts` | Modify | Wire the `codespace` group + top help line |
| `scripts/codespace-conformance.ts` | Create | The docker+network acceptance gate (manual/CI-opt-in; also the version-bump gate) |
| `scripts/fixtures/codespace-basic/.devcontainer/devcontainer.json` | Create | Fixture (a): plain image |
| `scripts/fixtures/codespace-features/.devcontainer/devcontainer.json` | Create | Fixture (b): image + a features entry |

---

### Task 1: Vendor the pinned `@devcontainers/cli`

The pin lives in one constant module (no asset imports, so the vendoring script can run before the vendor dir exists). The unit test is network-free: it asserts the *committed* vendor files, and that the bundle runs under plain bun.

**Files:**
- Create: `cli/src/codespace/devcontainers-cli-version.ts`
- Create: `cli/scripts/vendor-devcontainers-cli.ts`
- Create: `cli/src/codespace/vendor.test.ts`
- Generate + commit: `cli/vendor/devcontainers-cli/{devcontainer.js,dist/spec-node/devContainersSpecCLI.js,VERSION}`

- [ ] **Step 1: Write the pin constant**

Create `cli/src/codespace/devcontainers-cli-version.ts`:

```ts
/** The pinned upstream @devcontainers/cli (decision log #1). This CLI's
 *  behaviour IS the compatibility promise (design §2.2), so bumping the pin is
 *  a deliberate act: edit this constant, run
 *  `bun cli/scripts/vendor-devcontainers-cli.ts`, commit the refreshed
 *  cli/vendor/devcontainers-cli/, and re-run the gate —
 *  `bun scripts/codespace-conformance.ts` — before landing. */
export const DEVCONTAINERS_CLI_VERSION = '0.87.0'
```

- [ ] **Step 2: Write the failing test**

Create `cli/src/codespace/vendor.test.ts`:

```ts
// Vendored @devcontainers/cli (decision #1): the pinned two-file esbuild
// bundle is committed under cli/vendor/devcontainers-cli/ and runnable under
// plain bun (bun-compat spike verdict 2026-07-21: PASS — --help,
// read-configuration, up, exec, build all exit 0). Network-free: the
// re-vendoring script is manual-run and NOT exercised here.
// Run with: bun src/codespace/vendor.test.ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'

const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'devcontainers-cli')
const entry = path.join(vendorDir, 'devcontainer.js')
const bundle = path.join(vendorDir, 'dist', 'spec-node', 'devContainersSpecCLI.js')

assert.ok(existsSync(entry), `missing ${entry} — run: bun cli/scripts/vendor-devcontainers-cli.ts`)
assert.ok(existsSync(bundle), `missing ${bundle} — run: bun cli/scripts/vendor-devcontainers-cli.ts`)
assert.equal(
	readFileSync(path.join(vendorDir, 'VERSION'), 'utf8').trim(),
	DEVCONTAINERS_CLI_VERSION,
	'vendored VERSION matches the pin',
)
// The shim requires ./dist/spec-node/… relative to itself — layout must hold.
assert.ok(readFileSync(entry, 'utf8').includes('spec-node'), 'entry shim points at the spec-node bundle')

// The bundle actually runs under bun (no docker, no network): --help exits 0.
const res = Bun.spawnSync(['bun', entry, '--help'], { stdout: 'pipe', stderr: 'pipe' })
assert.equal(res.exitCode, 0, `devcontainer --help under bun failed: ${res.stderr.toString().slice(0, 400)}`)
assert.ok(res.stdout.toString().includes('devcontainer'), 'help text mentions devcontainer')

console.log('ok: vendored devcontainers-cli — files present, VERSION pinned, --help runs under bun')
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun cli/src/codespace/vendor.test.ts`
Expected: FAIL — `missing …/cli/vendor/devcontainers-cli/devcontainer.js — run: bun cli/scripts/vendor-devcontainers-cli.ts`

- [ ] **Step 4: Write the vendoring script**

Create `cli/scripts/vendor-devcontainers-cli.ts`:

```ts
// Re-vendor the pinned @devcontainers/cli into cli/vendor/devcontainers-cli/.
// NETWORK + MANUAL-RUN by design (decision #1): not named *.test.ts, so no
// test glob ever spawns it. Bump flow: edit devcontainers-cli-version.ts, run
// `bun cli/scripts/vendor-devcontainers-cli.ts`, commit the vendor dir, and
// re-run `bun scripts/codespace-conformance.ts` (the bump gate) before landing.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVCONTAINERS_CLI_VERSION } from '../src/codespace/devcontainers-cli-version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const vendorDir = path.join(here, '..', 'vendor', 'devcontainers-cli')
const url = `https://registry.npmjs.org/@devcontainers/cli/-/cli-${DEVCONTAINERS_CLI_VERSION}.tgz`

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-vendor-devcontainers-'))
try {
	console.error(`fetching ${url}`)
	const res = await fetch(url)
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
	const tarball = path.join(tmp, 'cli.tgz')
	await Bun.write(tarball, await res.arrayBuffer())
	const untar = Bun.spawnSync(['tar', '-xzf', tarball, '-C', tmp], { stdout: 'inherit', stderr: 'inherit' })
	if (untar.exitCode !== 0) throw new Error(`tar -xzf failed (exit ${untar.exitCode})`)

	// The runtime surface is exactly two files (spike-verified): the 423B
	// require shim and the 1.7MB esbuild bundle it loads at ./dist/spec-node/.
	// Zero runtime node_modules — proven by the spike's isolated-copy run.
	mkdirSync(path.join(vendorDir, 'dist', 'spec-node'), { recursive: true })
	copyFileSync(path.join(tmp, 'package', 'devcontainer.js'), path.join(vendorDir, 'devcontainer.js'))
	copyFileSync(
		path.join(tmp, 'package', 'dist', 'spec-node', 'devContainersSpecCLI.js'),
		path.join(vendorDir, 'dist', 'spec-node', 'devContainersSpecCLI.js'),
	)
	writeFileSync(path.join(vendorDir, 'VERSION'), `${DEVCONTAINERS_CLI_VERSION}\n`)
	console.error(`vendored @devcontainers/cli@${DEVCONTAINERS_CLI_VERSION} → ${vendorDir}`)
} finally {
	rmSync(tmp, { recursive: true, force: true })
}
```

- [ ] **Step 5: Run the vendoring script ONCE (the one network step in this plan)**

Run: `bun cli/scripts/vendor-devcontainers-cli.ts`
Expected: stderr narrates the fetch and ends `vendored @devcontainers/cli@0.87.0 → …/cli/vendor/devcontainers-cli`; the three files now exist.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun cli/src/codespace/vendor.test.ts`
Expected: PASS — `ok: vendored devcontainers-cli — files present, VERSION pinned, --help runs under bun`

- [ ] **Step 7: Commit (vendored files included — they are the point)**

```bash
git add cli/src/codespace/devcontainers-cli-version.ts cli/scripts/vendor-devcontainers-cli.ts cli/src/codespace/vendor.test.ts cli/vendor/devcontainers-cli
git commit -m "feat(cli): vendor pinned @devcontainers/cli 0.87.0 + re-vendoring script" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Runner resolution — dev `bun` vs compiled `BUN_BE_BUN`

Decision #2. The `with { type: 'file' }` imports live in a runtime-only `.js` module (typed by a sibling `.d.ts`) so `bun build --compile` embeds the bundle while `tsc` never parses the vendor JS. At runtime each import resolves to a path: the real vendor file in dev, the embedded (`/$bunfs/…`) path when compiled — which is exactly the mode detector.

**Files:**
- Create: `cli/src/codespace/vendor-assets.js`, `cli/src/codespace/vendor-assets.d.ts`
- Create: `cli/src/codespace/devcontainers-cli.ts`
- Create: `cli/src/codespace/devcontainers-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/devcontainers-cli.test.ts`:

```ts
// Runner resolution (decision #2): pure argv/env for both modes, XDG-honoring
// extraction dir, and ensureDevcontainersCli in a dev checkout returning
// ['bun', <real vendor path>] with no extraction. Network-free; the compiled
// branch's extraction is exercised by scripts/codespace-conformance.ts.
// Run with: bun src/codespace/devcontainers-cli.test.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'
import { ensureDevcontainersCli, extractionDir, runnerFor, runningCompiled } from './devcontainers-cli.ts'

// Pure argv/env computation.
{
	const dev = runnerFor('dev', '/repo/cli/vendor/devcontainers-cli/devcontainer.js', '/usr/bin/ew')
	assert.deepEqual(dev.argvPrefix, ['bun', '/repo/cli/vendor/devcontainers-cli/devcontainer.js'])
	assert.deepEqual(dev.env, {}, 'dev mode needs no env override')

	const compiled = runnerFor('compiled', '/home/u/.cache/ensembleworks/devcontainers-cli-0.87.0/devcontainer.js', '/usr/local/bin/ew')
	assert.deepEqual(compiled.argvPrefix, ['/usr/local/bin/ew', '/home/u/.cache/ensembleworks/devcontainers-cli-0.87.0/devcontainer.js'])
	assert.deepEqual(compiled.env, { BUN_BE_BUN: '1' }, 'compiled mode re-invokes the ew binary as the plain bun runtime')
}

// Extraction dir honors XDG_CACHE_HOME and is per-version (immutable bumps).
{
	const dir = extractionDir({ XDG_CACHE_HOME: '/tmp/cache' } as NodeJS.ProcessEnv)
	assert.equal(dir, path.join('/tmp/cache', 'ensembleworks', `devcontainers-cli-${DEVCONTAINERS_CLI_VERSION}`))
}

// In this dev checkout: not compiled; ensure returns bun + the real vendor entry.
{
	assert.equal(runningCompiled(), false, 'a source checkout is dev mode')
	const runner = await ensureDevcontainersCli(process.env)
	assert.equal(runner.argvPrefix[0], 'bun')
	assert.ok(existsSync(runner.argvPrefix[1] as string), 'dev entry is a real FS path')
	assert.ok((runner.argvPrefix[1] as string).endsWith(path.join('vendor', 'devcontainers-cli', 'devcontainer.js')))
}

console.log('ok: devcontainers-cli runner — dev/compiled argv+env, XDG extraction dir, dev-mode ensure')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/devcontainers-cli.test.ts`
Expected: FAIL — cannot resolve `./devcontainers-cli.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/vendor-assets.js`:

```js
// Runtime-only module (typed by vendor-assets.d.ts): `with { type: 'file' }`
// makes `bun build --compile` embed the vendored devcontainers-cli bundle in
// the single ew binary (design §2.2 approach B). At runtime each import is a
// PATH string — the real cli/vendor/… file in dev, the embedded /$bunfs/…
// blob when compiled (readable via Bun.file, not on the real FS — which is
// exactly how mode is detected). Kept as .js so tsc never type-checks the
// 1.7MB vendor bundle.
import devcontainerEntry from '../../vendor/devcontainers-cli/devcontainer.js' with { type: 'file' }
import specCliBundle from '../../vendor/devcontainers-cli/dist/spec-node/devContainersSpecCLI.js' with { type: 'file' }

export { devcontainerEntry, specCliBundle }
```

Create `cli/src/codespace/vendor-assets.d.ts`:

```ts
/** Types for vendor-assets.js — each export is the asset's resolved path. */
export const devcontainerEntry: string
export const specCliBundle: string
```

Create `cli/src/codespace/devcontainers-cli.ts`:

```ts
/**
 * How `ew` runs the vendored @devcontainers/cli (decision #2): always as a
 * SUBPROCESS against the stable CLI interface — never as a library — because
 * that interface is the surface the §1 compatibility promise is defined on.
 *   dev (source checkout): ['bun', <cli/vendor/.../devcontainer.js>]
 *   compiled binary:       [process.execPath, <extracted entry>] with
 *                          BUN_BE_BUN=1 (spike-verified: a bun-compiled binary
 *                          re-invoked with BUN_BE_BUN=1 acts as the plain bun
 *                          runtime and executes an arbitrary .js file)
 * Pure argv/env computation (runnerFor) is separated from the impure
 * detect/extract (ensureDevcontainersCli) so the former is unit-testable.
 */
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEVCONTAINERS_CLI_VERSION } from './devcontainers-cli-version.ts'
import { devcontainerEntry, specCliBundle } from './vendor-assets.js'

export interface DevcontainersCliRunner {
	/** argv prefix; append the subcommand, e.g. [...argvPrefix, 'up', …]. */
	argvPrefix: string[]
	/** extra child env (BUN_BE_BUN in compiled mode). */
	env: Record<string, string>
}

/** Pure: the argv/env for a mode + entry path. */
export function runnerFor(mode: 'dev' | 'compiled', entryPath: string, execPath: string): DevcontainersCliRunner {
	if (mode === 'dev') return { argvPrefix: ['bun', entryPath], env: {} }
	return { argvPrefix: [execPath, entryPath], env: { BUN_BE_BUN: '1' } }
}

/** Per-version extraction target for the compiled binary (immutable bumps). */
export function extractionDir(env: NodeJS.ProcessEnv): string {
	const cacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
	return path.join(cacheHome, 'ensembleworks', `devcontainers-cli-${DEVCONTAINERS_CLI_VERSION}`)
}

/** Compiled ⇔ the asset path is NOT on the real FS (it's /$bunfs/… inside the
 *  binary) — decision #2's detection rule. */
export function runningCompiled(): boolean {
	return !existsSync(devcontainerEntry)
}

/** Detect mode; in compiled mode extract the two-file bundle (preserving the
 *  shim's ./dist/spec-node relative layout) to the per-version cache dir. */
export async function ensureDevcontainersCli(env: NodeJS.ProcessEnv): Promise<DevcontainersCliRunner> {
	if (!runningCompiled()) return runnerFor('dev', devcontainerEntry, process.execPath)
	const dir = extractionDir(env)
	const entry = path.join(dir, 'devcontainer.js')
	const bundle = path.join(dir, 'dist', 'spec-node', 'devContainersSpecCLI.js')
	if (!existsSync(entry) || !existsSync(bundle)) {
		mkdirSync(path.join(dir, 'dist', 'spec-node'), { recursive: true })
		await Bun.write(entry, Bun.file(devcontainerEntry))
		await Bun.write(bundle, Bun.file(specCliBundle))
	}
	return runnerFor('compiled', entry, process.execPath)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/devcontainers-cli.test.ts`
Expected: PASS — `ok: devcontainers-cli runner — dev/compiled argv+env, XDG extraction dir, dev-mode ensure`

Also run: `cd cli && bunx tsc --noEmit`
Expected: exit 0 — the `.d.ts` satisfies the `.js` import.

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/vendor-assets.js cli/src/codespace/vendor-assets.d.ts cli/src/codespace/devcontainers-cli.ts cli/src/codespace/devcontainers-cli.test.ts
git commit -m "feat(cli): devcontainers-cli runner — dev bun / compiled BUN_BE_BUN argv resolution" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `codespaces.json` store + `gatewayId` minting

Decision #6. Keyed by the realpath of the checkout so two clones of the same repo never collide (design §2.1); no secrets, so no 0600 dance (unlike `hosts.toml`). This file grows into SP4's desired-state store.

**Files:**
- Create: `cli/src/codespace/store.ts`
- Create: `cli/src/codespace/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/store.test.ts`:

```ts
// codespaces.json store (decision #6): XDG-honoring path, JSON round-trip,
// cs-<dirname>-<hash8(realpath)> minting (stable per checkout, distinct per
// clone), ensure keeps an existing gatewayId/containerId across re-ups, and
// updateContainerId persists. Run with: bun src/codespace/store.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	codespacesPath,
	ensureCodespaceRecord,
	loadCodespaces,
	mintGatewayId,
	saveCodespaces,
	updateContainerId,
} from './store.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-codespaces-'))

// Path: XDG_CONFIG_HOME wins; falls back under ~/.config.
assert.equal(
	codespacesPath({ XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv),
	path.join(dir, 'ensembleworks', 'codespaces.json'),
)
assert.ok(codespacesPath({} as NodeJS.ProcessEnv).endsWith(path.join('.config', 'ensembleworks', 'codespaces.json')))

// Minting: cs-<dirname>-<8 hex>, deterministic, distinct per realpath.
{
	const a = mintGatewayId('/home/u/work/ensembleworks')
	assert.match(a, /^cs-ensembleworks-[0-9a-f]{8}$/)
	assert.equal(a, mintGatewayId('/home/u/work/ensembleworks'), 'deterministic')
	const b = mintGatewayId('/home/u/other/ensembleworks')
	assert.notEqual(a, b, 'two clones of the same repo get distinct ids')
}

// Absent file → empty store; round-trip; ensure mints once then reuses.
const file = path.join(dir, 'ensembleworks', 'codespaces.json')
assert.deepEqual(loadCodespaces(file), { codespaces: {} }, 'absent file is an empty store')

const first = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
	repo: 'ensembleworks',
	branch: 'main',
	canvasUrl: 'http://localhost:8788',
})
assert.match(first.gatewayId, /^cs-ensembleworks-[0-9a-f]{8}$/)
assert.equal(first.containerId, undefined)

updateContainerId(file, '/home/u/work/ensembleworks', 'deadbeef'.repeat(8))
const second = ensureCodespaceRecord(file, '/home/u/work/ensembleworks', {
	repo: 'ensembleworks',
	branch: 'feature/x', // branch moved — record follows, identity does not
	canvasUrl: 'http://localhost:8788',
})
assert.equal(second.gatewayId, first.gatewayId, 're-up reuses the minted id (reattach, never duplicate)')
assert.equal(second.containerId, 'deadbeef'.repeat(8), 'containerId survives ensure')
assert.equal(second.branch, 'feature/x', 'branch metadata refreshed')

const reloaded = loadCodespaces(file)
assert.deepEqual(reloaded.codespaces['/home/u/work/ensembleworks'], second, 'round-trips losslessly')

console.log('ok: codespaces store — XDG path, mint format/stability, ensure/update round-trip')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/store.test.ts`
Expected: FAIL — cannot resolve `./store.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/store.ts`:

```ts
/**
 * ~/.config/ensembleworks/codespaces.json (decision #6): a map keyed by the
 * REALPATH of the checkout → { gatewayId, containerId?, repo, branch,
 * canvasUrl }. gatewayId = cs-<dirname>-<first 8 hex of sha256(realpath)> —
 * stable across reboots (the shape reattaches instead of duplicating, design
 * §2.1), distinct across clones. No secrets → plain 0644 JSON (contrast
 * hosts.toml); mkdir -p + round-trip only. Grows into SP4's desired-state.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodespaceRecord {
	gatewayId: string
	containerId?: string
	repo: string
	branch: string
	canvasUrl: string
}

export interface CodespacesFile {
	codespaces: Record<string, CodespaceRecord>
}

export function codespacesPath(env: NodeJS.ProcessEnv = process.env): string {
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
	return path.join(configHome, 'ensembleworks', 'codespaces.json')
}

export function loadCodespaces(file: string): CodespacesFile {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as { codespaces?: unknown }
		return { codespaces: (parsed.codespaces ?? {}) as Record<string, CodespaceRecord> }
	} catch {
		return { codespaces: {} } // absent (or corrupt — we mint fresh) file is fine
	}
}

export function saveCodespaces(file: string, data: CodespacesFile): void {
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** cs-<dirname>-<hash8 of realpath> — decision #6's exact recipe. */
export function mintGatewayId(realpathOfCheckout: string): string {
	const hash8 = createHash('sha256').update(realpathOfCheckout).digest('hex').slice(0, 8)
	return `cs-${path.basename(realpathOfCheckout)}-${hash8}`
}

/** Existing record wins (stable gatewayId + containerId survive re-ups; the
 *  repo/branch/canvasUrl metadata refreshes); else mint and persist. */
export function ensureCodespaceRecord(
	file: string,
	realpathOfCheckout: string,
	info: { repo: string; branch: string; canvasUrl: string },
): CodespaceRecord {
	const store = loadCodespaces(file)
	const existing = store.codespaces[realpathOfCheckout]
	const rec: CodespaceRecord = existing
		? { ...existing, repo: info.repo, branch: info.branch, canvasUrl: info.canvasUrl }
		: { gatewayId: mintGatewayId(realpathOfCheckout), ...info }
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: rec } })
	return rec
}

export function updateContainerId(file: string, realpathOfCheckout: string, containerId: string): void {
	const store = loadCodespaces(file)
	const rec = store.codespaces[realpathOfCheckout]
	if (!rec) return
	saveCodespaces(file, { codespaces: { ...store.codespaces, [realpathOfCheckout]: { ...rec, containerId } } })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/store.test.ts`
Expected: PASS — `ok: codespaces store — XDG path, mint format/stability, ensure/update round-trip`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/store.ts cli/src/codespace/store.test.ts
git commit -m "feat(cli): codespaces.json store + stable cs-<dir>-<hash8> gateway ids" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Repo/branch detection

Decision #8: repo = basename of `git rev-parse --show-toplevel`, branch = `git rev-parse --abbrev-ref HEAD`; a non-git dir degrades to `basename(cwd)` + `''`. The realpath'd toplevel doubles as the store key and the `--workspace-folder`.

**Files:**
- Create: `cli/src/codespace/repo-info.ts`
- Create: `cli/src/codespace/repo-info.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/repo-info.test.ts`:

```ts
// Repo/branch detection (decision #8) in a REAL temp git repo (branch named at
// init, one commit so HEAD resolves) and the non-git fallback. realpath both
// sides — os.tmpdir() is a symlink on some hosts.
// Run with: bun src/codespace/repo-info.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectRepoInfo } from './repo-info.ts'

const run = (argv: string[], cwd: string) => {
	const res = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
	assert.equal(res.exitCode, 0, `${argv.join(' ')} failed: ${res.stderr.toString()}`)
}

// A git repo: repo = basename(toplevel), branch = current branch, toplevel
// detected from a SUBDIRECTORY (rev-parse walks up).
{
	const parent = mkdtempSync(path.join(os.tmpdir(), 'ew-repoinfo-'))
	const repoDir = path.join(parent, 'myrepo')
	mkdirSync(repoDir)
	run(['git', 'init', '-b', 'sp2-branch', repoDir], parent)
	run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], repoDir)
	const sub = path.join(repoDir, 'deep', 'inside')
	mkdirSync(sub, { recursive: true })

	const info = detectRepoInfo(sub)
	assert.equal(info.toplevel, realpathSync(repoDir), 'toplevel is the realpath of the checkout root')
	assert.equal(info.repo, 'myrepo', 'repo = basename of toplevel')
	assert.equal(info.branch, 'sp2-branch')
}

// Non-git dir: repo = basename(cwd), branch = ''.
{
	const parent = mkdtempSync(path.join(os.tmpdir(), 'ew-repoinfo-plain-'))
	const plain = path.join(parent, 'notarepo')
	mkdirSync(plain)
	const info = detectRepoInfo(plain)
	assert.equal(info.toplevel, realpathSync(plain))
	assert.equal(info.repo, 'notarepo')
	assert.equal(info.branch, '', 'non-git dir has no branch')
}

console.log('ok: repo-info — git toplevel/branch from a subdir, non-git fallback')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/repo-info.test.ts`
Expected: FAIL — cannot resolve `./repo-info.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/repo-info.ts`:

```ts
/**
 * Repo/branch detection (decision #8): repo = basename of `git rev-parse
 * --show-toplevel`, branch = `git rev-parse --abbrev-ref HEAD`; a non-git dir
 * degrades to repo = basename(cwd), branch = ''. The realpath'd toplevel is
 * the codespaces.json key AND the devcontainer --workspace-folder.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

export interface RepoInfo {
	/** realpath of the workspace folder (git toplevel, or cwd when not a repo) */
	toplevel: string
	repo: string
	branch: string
}

function git(args: string[], cwd: string): string | null {
	const res = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	if (res.exitCode !== 0) return null
	return res.stdout.toString().trim()
}

export function detectRepoInfo(cwd: string): RepoInfo {
	const top = git(['rev-parse', '--show-toplevel'], cwd)
	if (!top) {
		const real = realpathSync(cwd)
		return { toplevel: real, repo: path.basename(real), branch: '' }
	}
	const real = realpathSync(top)
	// A freshly-initted repo with no commits errors here → '' (still bootable).
	const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? ''
	return { toplevel: real, repo: path.basename(real), branch }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/repo-info.test.ts`
Expected: PASS — `ok: repo-info — git toplevel/branch from a subdir, non-git fallback`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/repo-info.ts cli/src/codespace/repo-info.test.ts
git commit -m "feat(cli): repo/branch detection for codespace identity" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `--repo` / `--branch` on `terminal connect` — ADD IF ABSENT

**Coordination (decision #3):** these registration-metadata flags belong to SP3's plan too; whichever plan executes first adds them. **At execution time, read `cli/src/native/connect.ts`: if `--repo`/`--branch` already parse there (SP3 landed first), skip Steps 1–3, run the existing test suite to confirm green, and move on.** As of this plan's authoring (2026-07-21) they are absent — `parseConnectFlags` knows only `--label`, `--gateway-id`, `--backend`.

Semantics here are deliberately minimal: parse, carry on `ConnectConfig`, append as `repo`/`branch` query params on the connect URL. The server ignores unknown params today; SP3's registration-metadata work consumes them.

**Files:**
- Modify: `cli/src/native/connect.ts`
- Modify: `cli/src/native/connect.test.ts`

- [ ] **Step 1: Write the failing tests**

In `cli/src/native/connect.test.ts`, extend the first block (config resolution + defaults) after the `backend` assertion:

```ts
	assert.equal(cfg.repo, undefined, 'repo metadata absent by default')
	assert.equal(cfg.branch, undefined, 'branch metadata absent by default')
	assert.ok(!cfg.wsUrl.includes('repo='), 'no repo param when unset')
```

Extend the "Explicit flags win" block:

```ts
	const meta = resolveConnectConfig(conn, { repo: 'ensembleworks', branch: 'main' }, process.env)
	assert.equal(meta.repo, 'ensembleworks')
	assert.equal(meta.branch, 'main')
	assert.ok(meta.wsUrl.includes('repo=ensembleworks'), 'repo rides the connect URL (SP3 registration metadata)')
	assert.ok(meta.wsUrl.includes('branch=main'), 'branch rides the connect URL')
```

Append a parse block before the final `console.log`:

```ts
// --repo/--branch parse through the slot (decision #3 — codespace exec passes them).
{
	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		const code = await connectSlot(['--repo', 'myrepo', '--branch', 'dev'], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.repo, 'myrepo', '--dry-run config carries repo')
	assert.equal(printed.branch, 'dev', '--dry-run config carries branch')
}
```

Update the final line:

```ts
console.log('ok: connect — ws url + stable-gateway-id/hostname defaults, flags win, --backend default/validation, --repo/--branch metadata, --dry-run config')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun cli/src/native/connect.test.ts`
Expected: FAIL — typecheck/parse: `repo` not on the flags type; at runtime, `unknown terminal connect flag: --repo`.

- [ ] **Step 3: Implement**

In `cli/src/native/connect.ts`:

`ConnectConfig` gains two optional fields:

```ts
export interface ConnectConfig {
	url: string
	wsUrl: string
	room: string
	gatewayId: string
	label: string
	authMethod: 'service-token' | 'none'
	backend: 'tmux' | 'pty'
	repo?: string
	branch?: string
}
```

In `resolveConnectConfig`, widen the flags param to `{ label?: string; gatewayId?: string; backend?: 'tmux' | 'pty'; repo?: string; branch?: string }`, and after the existing `ws.searchParams.set('label', label)` add:

```ts
	// Registration metadata (coexistence spec §4 / decision #3): carried on the
	// connect URL for SP3's server-side registration to consume; ignored today.
	if (flags.repo) ws.searchParams.set('repo', flags.repo)
	if (flags.branch) ws.searchParams.set('branch', flags.branch)
```

and extend the return to `{ …, backend, repo: flags.repo, branch: flags.branch }`.

In `parseConnectFlags`, widen the return/local type the same way and add two cases before `default`:

```ts
			case '--repo':
				flags.repo = args[++i]
				break
			case '--branch':
				flags.branch = args[++i]
				break
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/native/connect.test.ts`
Expected: PASS, ending with the updated `ok:` line.

- [ ] **Step 5: Commit**

```bash
git add cli/src/native/connect.ts cli/src/native/connect.test.ts
git commit -m "feat(cli): --repo/--branch registration metadata flags on terminal connect" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Connector-bin resolution + `/ew` runtime-dir staging

Decisions #3/#4. The staged dir is what `devcontainer up` bind-mounts at `/ew`; the binary inside is always named `ensembleworks` so the exec argv is invariant.

**Files:**
- Create: `cli/src/codespace/runtime-dir.ts`
- Create: `cli/src/codespace/runtime-dir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/runtime-dir.test.ts`:

```ts
// Connector staging (decisions #3/#4): EW_CONNECTOR_BIN override → compiled
// self (process.execPath) → CliError with the build hint; runtime dir honors
// XDG_DATA_HOME; staging copies the binary as `ensembleworks` with the exec
// bit. Run with: bun src/codespace/runtime-dir.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import { resolveConnectorBin, runtimeDir, stageRuntimeDir } from './runtime-dir.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-runtime-'))

// Resolution chain.
{
	const fake = path.join(tmp, 'fake-connector')
	writeFileSync(fake, '#!/bin/sh\n')
	assert.equal(resolveConnectorBin({ EW_CONNECTOR_BIN: fake } as NodeJS.ProcessEnv, false), fake, 'override wins')

	assert.throws(
		() => resolveConnectorBin({ EW_CONNECTOR_BIN: path.join(tmp, 'nope') } as NodeJS.ProcessEnv, false),
		(e: unknown) => e instanceof CliError && e.exitCode === 2 && /missing file/.test(e.message),
		'dangling override refused',
	)

	assert.equal(resolveConnectorBin({} as NodeJS.ProcessEnv, true), process.execPath, 'compiled: the ew binary IS the connector')

	assert.throws(
		() => resolveConnectorBin({} as NodeJS.ProcessEnv, false),
		(e: unknown) => e instanceof CliError && e.exitCode === 2 && /build:binary/.test(e.message) && /EW_CONNECTOR_BIN/.test(e.message),
		'source checkout without override refused, with the build hint',
	)
}

// Runtime dir: XDG_DATA_HOME honored (decision #3's ~/.local/share default).
assert.equal(
	runtimeDir({ XDG_DATA_HOME: '/tmp/data' } as NodeJS.ProcessEnv),
	path.join('/tmp/data', 'ensembleworks', 'ew-runtime'),
)
assert.ok(runtimeDir({} as NodeJS.ProcessEnv).endsWith(path.join('.local', 'share', 'ensembleworks', 'ew-runtime')))

// Staging: copy as `ensembleworks`, exec bit set, content intact, idempotent.
{
	const src = path.join(tmp, 'built-connector')
	writeFileSync(src, 'BINARY-BYTES-v1')
	const dir = path.join(tmp, 'stage', 'ew-runtime')
	const dest = stageRuntimeDir(dir, src)
	assert.equal(dest, path.join(dir, 'ensembleworks'))
	assert.equal(readFileSync(dest, 'utf8'), 'BINARY-BYTES-v1')
	assert.equal(statSync(dest).mode & 0o111, 0o111, 'exec bits set')
	writeFileSync(src, 'BINARY-BYTES-v2')
	stageRuntimeDir(dir, src) // upgrade = one-file swap (design §2.1)
	assert.equal(readFileSync(dest, 'utf8'), 'BINARY-BYTES-v2', 're-staging overwrites')
}

console.log('ok: runtime-dir — resolution chain, XDG dir, staged ensembleworks binary')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/runtime-dir.test.ts`
Expected: FAIL — cannot resolve `./runtime-dir.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/runtime-dir.ts`:

```ts
/**
 * Connector staging (decisions #3/#4): resolve the connector binary
 * (EW_CONNECTOR_BIN override → the running compiled ew binary itself → refuse
 * with the build hint), then stage it as
 * <XDG_DATA_HOME|~/.local/share>/ensembleworks/ew-runtime/ensembleworks — the
 * dir `devcontainer up` bind-mounts at /ew. Upgrading the connector is a
 * one-file swap host-side (design §2.1). v1 arch boundary (decision #10): the
 * staged binary is the bun-compiled glibc x64 build; a musl or arm64 container
 * will fail to exec /ew/ensembleworks — documented, not detected.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'

export function runtimeDir(env: NodeJS.ProcessEnv): string {
	const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
	return path.join(dataHome, 'ensembleworks', 'ew-runtime')
}

export function resolveConnectorBin(env: NodeJS.ProcessEnv, compiled: boolean): string {
	const override = env.EW_CONNECTOR_BIN
	if (override) {
		if (!existsSync(override)) throw new CliError(`EW_CONNECTOR_BIN points at a missing file: ${override}`, 2)
		return override
	}
	if (compiled) return process.execPath // the one ew binary is also the connector (design §2.2)
	throw new CliError(
		'no connector binary: running from source — build one with `bun run --filter @ensembleworks/cli build:binary` and/or set EW_CONNECTOR_BIN',
		2,
	)
}

/** Copy the connector into the runtime dir as `ensembleworks`, exec bit set. */
export function stageRuntimeDir(dir: string, connectorBin: string): string {
	mkdirSync(dir, { recursive: true })
	const dest = path.join(dir, 'ensembleworks')
	copyFileSync(connectorBin, dest)
	chmodSync(dest, 0o755)
	return dest
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/runtime-dir.test.ts`
Expected: PASS — `ok: runtime-dir — resolution chain, XDG dir, staged ensembleworks binary`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/runtime-dir.ts cli/src/codespace/runtime-dir.test.ts
git commit -m "feat(cli): connector binary resolution + /ew runtime-dir staging" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `codespace up` plan computation + `--dry-run` (secrets REDACTED)

Decision #5's network-free half: everything up to (but not including) spawning. `resolveUpPlan` touches only the store and local FS paths; `--dry-run` prints it as JSON with token values REDACTED (the live engine rebuilds the real exec argv via `buildExecArgv(…, { redact: false })`). `parseUpResult` pins the spike-verified `up` stdout JSON shape. Note: `--dry-run` persists the minted gatewayId — intentional, the id must be stable from the very first look.

**Files:**
- Create: `cli/src/codespace/up.ts` (plan half — the live engine is Task 9)
- Create: `cli/src/codespace/up.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/up.test.ts`:

```ts
// codespace up, the network-free half (decision #5): argv shapes for
// up/exec (mount string, --remove-existing-container on rebuild, --remote-env
// creds, the pty connector invocation), REDACTED secrets in the printable
// plan, parseUpResult against the spike-verified stdout shape, and the
// --dry-run slot. Run with: bun src/codespace/up.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from '../errors.ts'
import type { Conn } from '../resolve.ts'
import { runnerFor } from './devcontainers-cli.ts'
import { buildExecArgv, buildUpArgv, codespaceUp, parseUpResult, resolveUpPlan } from './up.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-up-'))
const conn: Conn = {
	url: 'http://localhost:8788',
	room: 'team',
	auth: { method: 'service-token', tokenId: 'tid.access', tokenSecret: 'sekrit-token-value' },
}
const runner = runnerFor('dev', '/v/devcontainer.js', '/usr/bin/ew')

// buildUpArgv: workspace + the /ew bind mount; rebuild appends the remove flag.
{
	const argv = buildUpArgv(runner, '/work/myrepo', '/data/ew-runtime', false)
	assert.deepEqual(argv, [
		'bun', '/v/devcontainer.js', 'up',
		'--workspace-folder', '/work/myrepo',
		'--mount', 'type=bind,source=/data/ew-runtime,target=/ew',
	])
	const rebuild = buildUpArgv(runner, '/work/myrepo', '/data/ew-runtime', true)
	assert.ok(rebuild.includes('--remove-existing-container'), 'rebuild = up + --remove-existing-container (decision #7)')
}

// buildExecArgv: remote-env creds, the pty connector invocation, redaction.
{
	const rec = { gatewayId: 'cs-myrepo-0a1b2c3d', repo: 'myrepo', branch: 'main' }
	const real = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: false })
	assert.deepEqual(real, [
		'bun', '/v/devcontainer.js', 'exec',
		'--workspace-folder', '/work/myrepo',
		'--remote-env', 'ENSEMBLEWORKS_URL=http://localhost:8788',
		'--remote-env', 'ENSEMBLEWORKS_TOKEN_ID=tid.access',
		'--remote-env', 'ENSEMBLEWORKS_TOKEN_SECRET=sekrit-token-value',
		'--', '/ew/ensembleworks', 'terminal', 'connect',
		'--backend', 'pty',
		'--gateway-id', 'cs-myrepo-0a1b2c3d',
		'--label', 'myrepo@main',
		'--repo', 'myrepo',
		'--branch', 'main',
	])
	const redacted = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: true })
	assert.ok(redacted.includes('ENSEMBLEWORKS_TOKEN_SECRET=REDACTED'), 'secret redacted')
	assert.ok(!JSON.stringify(redacted).includes('sekrit-token-value'), 'no secret leaks into the printable form')

	// A none-auth instance sends only the URL; branchless repos get a bare label.
	const none = buildExecArgv(runner, '/w', { url: 'http://x', room: 'team', auth: { method: 'none' } }, { gatewayId: 'g', repo: 'r', branch: '' }, { redact: false })
	assert.ok(!none.some((a) => a.includes('TOKEN')), 'none auth → no token remote-env')
	assert.ok(none.includes('--label') && none[none.indexOf('--label') + 1] === 'r', 'branchless label is just the repo')
	assert.ok(!none.includes('--branch'), 'no empty --branch flag')
}

// parseUpResult: the spike-verified shape, with progress noise above it.
{
	const ok = parseUpResult('pulling image…\nsome log line\n{"outcome":"success","containerId":"eff5bf192158","remoteUser":"root","remoteWorkspaceFolder":"/workspaces/testrepo"}\n')
	assert.equal(ok.containerId, 'eff5bf192158')
	assert.equal(ok.remoteUser, 'root')

	assert.throws(
		() => parseUpResult('{"outcome":"error","message":"Dockerfile exploded"}\n'),
		(e: unknown) => e instanceof CliError && /Dockerfile exploded/.test(e.message),
		'failure outcome surfaces the message',
	)
	assert.throws(
		() => parseUpResult('no json here at all\n'),
		(e: unknown) => e instanceof CliError && /no outcome JSON/.test(e.message),
		'garbage stdout refused',
	)
}

// resolveUpPlan + the --dry-run slot, end to end but network-free: temp git
// repo, isolated XDG dirs, EW_CONNECTOR_BIN pointing at a stub.
{
	const repoDir = path.join(tmp, 'planrepo')
	mkdirSync(repoDir)
	Bun.spawnSync(['git', 'init', '-b', 'main', repoDir])
	Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x'], { cwd: repoDir })
	const stub = path.join(tmp, 'stub-connector')
	writeFileSync(stub, '#!/bin/sh\n')
	const env = {
		...process.env,
		XDG_CONFIG_HOME: path.join(tmp, 'config'),
		XDG_DATA_HOME: path.join(tmp, 'data'),
		EW_CONNECTOR_BIN: stub,
		ENSEMBLEWORKS_URL: conn.url,
		ENSEMBLEWORKS_TOKEN_ID: conn.auth.method === 'service-token' ? conn.auth.tokenId : '',
		ENSEMBLEWORKS_TOKEN_SECRET: conn.auth.method === 'service-token' ? conn.auth.tokenSecret : '',
	} as NodeJS.ProcessEnv

	const plan = await resolveUpPlan(conn, repoDir, env, { removeExisting: false })
	assert.equal(plan.workspaceFolder, realpathSync(repoDir))
	assert.match(plan.gatewayId, /^cs-planrepo-[0-9a-f]{8}$/)
	assert.equal(plan.repo, 'planrepo')
	assert.equal(plan.branch, 'main')
	assert.equal(plan.connectorBin, stub)
	assert.equal(plan.runtimeDir, path.join(tmp, 'data', 'ensembleworks', 'ew-runtime'))
	assert.equal(plan.upArgv[0], 'bun', 'dev-mode runner')
	assert.ok(plan.upArgv.includes(`type=bind,source=${plan.runtimeDir},target=/ew`))
	assert.ok(plan.execArgv.includes('ENSEMBLEWORKS_TOKEN_SECRET=REDACTED'), 'plan.execArgv is the printable, redacted form')
	assert.ok(!JSON.stringify(plan).includes('sekrit-token-value'), 'the whole printable plan is secret-free')

	// The slot: --dry-run prints the plan JSON, exit 0, no spawning.
	const prevCwd = process.cwd()
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		process.chdir(repoDir)
		const code = await codespaceUp([], { refresh: false, json: false, dryRun: true, help: false }, env, { removeExisting: false })
		assert.equal(code, 0, '--dry-run exits 0')
	} finally {
		;(process.stdout as any).write = realOut
		process.chdir(prevCwd)
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.equal(printed.gatewayId, plan.gatewayId, 'dry-run reuses the persisted id (stable across runs)')
	assert.ok(!outChunks.join('').includes('sekrit-token-value'), 'dry-run output is secret-free')

	// Unknown own-flags refused (exit-2 CliError).
	await assert.rejects(
		() => codespaceUp(['--frobnicate'], { refresh: false, json: false, dryRun: true, help: false }, env, { removeExisting: false }),
		/unknown codespace up flag/,
	)
}

console.log('ok: codespace up plan — argv shapes, redaction, parseUpResult, --dry-run slot')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/up.test.ts`
Expected: FAIL — cannot resolve `./up.ts`.

- [ ] **Step 3: Implement (the plan half; `runCodespace` arrives in Task 9)**

Create `cli/src/codespace/up.ts`:

```ts
/**
 * `ew codespace up` (spec §6.2, decisions #3/#5): resolve conn + repo +
 * store record → ensure the vendored CLI is runnable → compute the full plan
 * (up argv with the /ew bind mount, exec argv with creds as --remote-env) →
 * --dry-run prints it (secrets REDACTED) or the live engine (Task 9) runs it.
 * Pure argv builders + parseUpResult are exported for tests; the engine stays
 * thin (decision #5 — the conformance smoke, not unit tests, covers it).
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson } from '../output.ts'
import { type Conn, readEnv, resolveConn } from '../resolve.ts'
import { type DevcontainersCliRunner, ensureDevcontainersCli, runningCompiled } from './devcontainers-cli.ts'
import { detectRepoInfo } from './repo-info.ts'
import { codespacesPath, ensureCodespaceRecord } from './store.ts'
import { resolveConnectorBin, runtimeDir } from './runtime-dir.ts'

export interface UpPlan {
	workspaceFolder: string
	gatewayId: string
	repo: string
	branch: string
	runtimeDir: string
	connectorBin: string
	/** full `devcontainer up` argv (runner prefix included) */
	upArgv: string[]
	/** extra env the runner subprocesses need (BUN_BE_BUN when compiled) */
	runnerEnv: Record<string, string>
	/** exec argv with secrets REDACTED — the printable form; the live engine
	 *  rebuilds the real one via buildExecArgv(…, { redact: false }). */
	execArgv: string[]
}

export function buildUpArgv(runner: DevcontainersCliRunner, workspaceFolder: string, rtDir: string, removeExisting: boolean): string[] {
	const argv = [
		...runner.argvPrefix, 'up',
		'--workspace-folder', workspaceFolder,
		// Injection (decision #3): read-only-by-role staging dir at /ew. The
		// upstream --mount syntax (spike-verified) has no ro knob; the dir holds
		// one host-owned binary, nothing secret.
		'--mount', `type=bind,source=${rtDir},target=/ew`,
	]
	if (removeExisting) argv.push('--remove-existing-container')
	return argv
}

export function buildExecArgv(
	runner: DevcontainersCliRunner,
	workspaceFolder: string,
	conn: Conn,
	rec: { gatewayId: string; repo: string; branch: string },
	opts: { redact: boolean },
): string[] {
	const secret = (v: string) => (opts.redact ? 'REDACTED' : v)
	const argv = [
		...runner.argvPrefix, 'exec',
		'--workspace-folder', workspaceFolder,
		// Creds as exec-time env — never in an image layer, never in the
		// workspace (design §2.1 step 3). The cli reads exactly these names
		// (cli/src/resolve.ts readEnv).
		'--remote-env', `ENSEMBLEWORKS_URL=${conn.url}`,
	]
	if (conn.auth.method === 'service-token') {
		argv.push('--remote-env', `ENSEMBLEWORKS_TOKEN_ID=${secret(conn.auth.tokenId)}`)
		argv.push('--remote-env', `ENSEMBLEWORKS_TOKEN_SECRET=${secret(conn.auth.tokenSecret)}`)
	}
	argv.push(
		'--', '/ew/ensembleworks', 'terminal', 'connect',
		'--backend', 'pty',
		'--gateway-id', rec.gatewayId,
		'--label', rec.branch ? `${rec.repo}@${rec.branch}` : rec.repo,
	)
	if (rec.repo) argv.push('--repo', rec.repo)
	if (rec.branch) argv.push('--branch', rec.branch)
	return argv
}

/** The `up` result is the LAST stdout line that parses as JSON with an
 *  `outcome` field (spike-verified: {"outcome":"success","containerId":…,
 *  "remoteUser":…,"remoteWorkspaceFolder":…}; progress noise may precede it —
 *  containerId comes from up's stdout ONLY, read-configuration has none). */
export function parseUpResult(stdout: string): { containerId: string; remoteUser?: string; remoteWorkspaceFolder?: string } {
	const lines = stdout.split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim()
		if (!line || !line.startsWith('{')) continue
		let parsed: { outcome?: string; containerId?: string; message?: string; description?: string; remoteUser?: string; remoteWorkspaceFolder?: string }
		try {
			parsed = JSON.parse(line)
		} catch {
			continue // not JSON after all — keep scanning up
		}
		if (!parsed.outcome) continue
		if (parsed.outcome !== 'success' || !parsed.containerId) {
			throw new CliError(`devcontainer up failed: ${parsed.message ?? parsed.description ?? line}`, 1)
		}
		return { containerId: parsed.containerId, remoteUser: parsed.remoteUser, remoteWorkspaceFolder: parsed.remoteWorkspaceFolder }
	}
	throw new CliError('devcontainer up produced no outcome JSON on stdout', 1)
}

export async function resolveUpPlan(conn: Conn, cwd: string, env: NodeJS.ProcessEnv, flags: { removeExisting: boolean }): Promise<UpPlan> {
	const info = detectRepoInfo(cwd)
	const rec = ensureCodespaceRecord(codespacesPath(env), info.toplevel, {
		repo: info.repo,
		branch: info.branch,
		canvasUrl: conn.url,
	})
	const runner = await ensureDevcontainersCli(env)
	const connectorBin = resolveConnectorBin(env, runningCompiled())
	const rtDir = runtimeDir(env)
	return {
		workspaceFolder: info.toplevel,
		gatewayId: rec.gatewayId,
		repo: rec.repo,
		branch: rec.branch,
		runtimeDir: rtDir,
		connectorBin,
		upArgv: buildUpArgv(runner, info.toplevel, rtDir, flags.removeExisting),
		runnerEnv: runner.env,
		execArgv: buildExecArgv(runner, info.toplevel, conn, rec, { redact: true }),
	}
}

export async function codespaceUp(args: string[], globals: Globals, env: NodeJS.ProcessEnv, opts: { removeExisting: boolean }): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace up flag: ${args[0]}`, 2) // v1: cwd is the workspace, no own flags
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
	const plan = await resolveUpPlan(conn, process.cwd(), env, { removeExisting: opts.removeExisting })
	if (globals.dryRun) {
		emitJson(plan)
		return 0
	}
	return runCodespace(plan, conn, env) // Task 9
}
```

Until Task 9 lands, add this temporary stub at the bottom of `up.ts` so the file compiles (the dry-run tests never reach it):

```ts
async function runCodespace(_plan: UpPlan, _conn: Conn, _env: NodeJS.ProcessEnv): Promise<number> {
	throw new CliError('codespace up live engine lands in Task 9 — use --dry-run', 1)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/up.test.ts`
Expected: PASS — `ok: codespace up plan — argv shapes, redaction, parseUpResult, --dry-run slot`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/up.ts cli/src/codespace/up.test.ts
git commit -m "feat(cli): codespace up plan computation + --dry-run (secrets redacted)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `supervise` — restart loop with parity backoff

Decision #5: restart the exec'd connector with the existing backoff pattern (`computeBackoff` + the >30s healthy-duration reset — the exact rule `runTransport` uses in `cli/src/connector/relay-client.ts:88-118`), until the signal aborts. Timers/rng injected so the test drives it on a fake clock.

**Files:**
- Create: `cli/src/codespace/supervise.ts`
- Create: `cli/src/codespace/supervise.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/supervise.test.ts`:

```ts
// supervise (decision #5): fast-crashing runOnce walks the 1s→2s→4s parity
// backoff (rng=0.5 neutralises jitter); a run outliving the 30s
// healthy-duration resets the curve; abort during backoff stops the loop.
// Fake clock throughout. Run with: bun src/codespace/supervise.test.ts
import assert from 'node:assert/strict'
import type { Timers } from '../connector/relay-client.ts'
import { supervise } from './supervise.ts'

class FakeTimers implements Timers {
	clock = 0
	nextId = 1
	pending: { at: number; fn: () => void; id: number }[] = []
	scheduled: number[] = [] // every setTimeout delay, in order
	now() { return this.clock }
	setTimeout(fn: () => void, ms: number) {
		this.scheduled.push(ms)
		const id = this.nextId++
		this.pending.push({ at: this.clock + ms, fn, id })
		return id as unknown as ReturnType<typeof setTimeout>
	}
	clearTimeout(h: ReturnType<typeof setTimeout>) {
		this.pending = this.pending.filter((p) => p.id !== (h as unknown as number))
	}
	setInterval(): ReturnType<typeof setInterval> { throw new Error('unused') }
	clearInterval(): void { throw new Error('unused') }
	async advance(ms: number) {
		this.clock += ms
		const due = this.pending.filter((p) => p.at <= this.clock)
		this.pending = this.pending.filter((p) => p.at > this.clock)
		for (const d of due) d.fn()
	}
}

const tick = () => new Promise<void>((r) => setImmediate(r))

const timers = new FakeTimers()
const ac = new AbortController()
let runs = 0
let healthyOnRun = -1
const done = supervise(async () => {
	runs++
	if (runs === healthyOnRun) timers.clock += 31_000 // this run "lived" 31s
}, { timers, rng: () => 0.5 }, ac.signal)

await tick()
assert.equal(runs, 1, 'first run starts immediately')
assert.deepEqual(timers.scheduled, [1_000], 'attempt 1 → 1s')

await timers.advance(1_000); await tick()
assert.equal(runs, 2)
assert.deepEqual(timers.scheduled, [1_000, 2_000], 'attempt 2 → 2s')

await timers.advance(2_000); await tick()
assert.equal(runs, 3)
assert.deepEqual(timers.scheduled, [1_000, 2_000, 4_000], 'attempt 3 → 4s')

// Run 4 lives >30s on the fake clock → the attempt counter resets to 1s.
healthyOnRun = 4
await timers.advance(4_000); await tick()
assert.equal(runs, 4)
assert.deepEqual(timers.scheduled, [1_000, 2_000, 4_000, 1_000], 'healthy run resets the curve')

// Abort during the pending backoff → the loop resolves, no run 5.
ac.abort()
await done
assert.equal(runs, 4, 'no run after abort')

// A pre-aborted signal never runs at all.
{
	const ac2 = new AbortController()
	ac2.abort()
	let ran = false
	await supervise(async () => { ran = true }, { timers: new FakeTimers(), rng: () => 0.5 }, ac2.signal)
	assert.equal(ran, false, 'pre-aborted signal short-circuits')
}

console.log('ok: supervise — backoff curve, healthy-duration reset, abort semantics')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/supervise.test.ts`
Expected: FAIL — cannot resolve `./supervise.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/supervise.ts`:

```ts
/**
 * Foreground supervision for the exec'd connector (decision #5): run, restart
 * on exit with the relay parity backoff — computeBackoff plus the >30s
 * healthy-duration reset, the same rule as the connector's own reconnect loop
 * (cli/src/connector/relay-client.ts runTransport) — until the signal aborts.
 * Timers/rng injected so tests drive the loop on a fake clock.
 */
import { computeBackoff, RELAY_HEALTHY_RESET_MS } from '@ensembleworks/contracts/relay-parity'
import type { Timers } from '../connector/relay-client.ts'

export interface SuperviseDeps {
	timers: Timers
	rng: () => number
}

/** Runs `runOnce` forever with backoff between exits; resolves once `signal`
 *  aborts (mid-run aborts resolve after the current runOnce settles — the
 *  caller kills its child on abort, so that settle is prompt). */
export async function supervise(runOnce: () => Promise<void>, deps: SuperviseDeps, signal: AbortSignal): Promise<void> {
	let attempt = 0
	while (!signal.aborted) {
		const start = deps.timers.now()
		try {
			await runOnce()
		} catch {
			/* child failure — the caller narrates; the loop only backs off */
		}
		if (signal.aborted) break
		if (deps.timers.now() - start > RELAY_HEALTHY_RESET_MS) attempt = 0
		attempt++
		await new Promise<void>((r) => {
			const settle = () => {
				deps.timers.clearTimeout(h)
				signal.removeEventListener('abort', onAbort)
				r()
			}
			const onAbort = () => settle()
			const h = deps.timers.setTimeout(settle, computeBackoff(attempt, deps.rng))
			signal.addEventListener('abort', onAbort)
		})
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/supervise.test.ts`
Expected: PASS — `ok: supervise — backoff curve, healthy-duration reset, abort semantics`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/supervise.ts cli/src/codespace/supervise.test.ts
git commit -m "feat(cli): supervise loop — parity backoff + healthy reset for the connector exec" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: The live engine — `devcontainer up` → stage → exec → supervise

Replaces Task 7's `runCodespace` stub. **Deliberately no unit test** (decision #5/#9): every branch below either spawns docker-touching subprocesses or was already unit-tested as a pure part (argv builders, `parseUpResult`, store update, staging, supervision) — the conformance smoke (Task 12) is the coverage. Verification for this task is typecheck + the untouched suite.

**Files:**
- Modify: `cli/src/codespace/up.ts` (replace the stub)
- Modify: `cli/src/connector/index.ts` (export `realTimers`)

- [ ] **Step 1: Export `realTimers`**

In `cli/src/connector/index.ts`, change line 17:

```ts
const realTimers: Timers = {
```

to:

```ts
export const realTimers: Timers = {
```

- [ ] **Step 2: Implement `runCodespace`**

In `cli/src/codespace/up.ts`, delete the Task 7 stub and add these imports:

```ts
import { realTimers } from '../connector/index.ts'
import { narrate } from '../output.ts'
import { stageRuntimeDir } from './runtime-dir.ts'
import { updateContainerId } from './store.ts'
import { supervise } from './supervise.ts'
```

(merge `narrate` into the existing `../output.ts` import and `stageRuntimeDir` into the existing `./runtime-dir.ts` import), then append:

```ts
/** The live engine (design §2.1 steps 1–4, decision #5): thin by design —
 *  every decision it strings together is a unit-tested pure part; the
 *  end-to-end proof is scripts/codespace-conformance.ts, not a unit test. */
async function runCodespace(plan: UpPlan, conn: Conn, env: NodeJS.ProcessEnv): Promise<number> {
	const runner = await ensureDevcontainersCli(env)
	const childEnv = { ...env, ...plan.runnerEnv } as Record<string, string>

	// 1+2. Build/start the unmodified repo, with the /ew injection mount added
	// at up time (repo-pristine). stderr streams through; stdout carries the
	// outcome JSON.
	narrate(`ensembleworks: devcontainer up — ${plan.branch ? `${plan.repo}@${plan.branch}` : plan.repo} (${plan.workspaceFolder})`)
	stageRuntimeDir(plan.runtimeDir, plan.connectorBin)
	const up = Bun.spawnSync(plan.upArgv, { env: childEnv, stdout: 'pipe', stderr: 'inherit' })
	if (up.exitCode !== 0) throw new CliError(`devcontainer up exited ${up.exitCode}`, 1)
	const result = parseUpResult(up.stdout.toString())
	updateContainerId(codespacesPath(env), plan.workspaceFolder, result.containerId)
	narrate(`ensembleworks: container ${result.containerId.slice(0, 12)} up; starting connector (gateway ${plan.gatewayId})`)

	// 3+4. Exec the connector inside the container (creds as exec-time env —
	// rebuilt UNredacted here; plan.execArgv stays the printable form) and
	// supervise it in the foreground until SIGINT/SIGTERM.
	const execArgv = buildExecArgv(runner, plan.workspaceFolder, conn, plan, { redact: false })
	const ac = new AbortController()
	const onSignal = () => ac.abort()
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)
	let child: ReturnType<typeof Bun.spawn> | null = null
	ac.signal.addEventListener('abort', () => child?.kill())
	try {
		await supervise(async () => {
			child = Bun.spawn(execArgv, { env: childEnv, stdout: 'inherit', stderr: 'inherit' })
			const code = await child.exited
			child = null
			if (!ac.signal.aborted) narrate(`ensembleworks: connector exec exited ${code}; restarting with backoff`)
		}, { timers: realTimers, rng: Math.random }, ac.signal)
	} finally {
		process.off('SIGINT', onSignal)
		process.off('SIGTERM', onSignal)
	}
	narrate('ensembleworks: codespace connector stopped (container left running — `ew codespace stop` to stop it)')
	return 0
}
```

- [ ] **Step 3: Verify**

Run: `cd cli && bunx tsc --noEmit && cd .. && bun cli/src/codespace/up.test.ts && bun cli/src/connector/reconnect.test.ts`
Expected: typecheck exit 0; both suites PASS (the `realTimers` export changes no behavior).

- [ ] **Step 4: Commit**

```bash
git add cli/src/codespace/up.ts cli/src/connector/index.ts
git commit -m "feat(cli): codespace up live engine — devcontainer up, stage /ew, exec connector, supervise" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `stop` and `list` verbs

Decision #7. `stop` = `docker stop <exact stored containerId>` — **never a name/label filter** (incident-derived policy); the record survives (it is SP4's desired-state seed). `list` = store entries, `--json` or table, plus the optional `--live` probe of the canvas's `GET /api/terminal/list` (the pure marking is unit-tested; the fetch itself is thin and exercised by the conformance smoke).

**Files:**
- Create: `cli/src/codespace/stop.ts`
- Create: `cli/src/codespace/list.ts`
- Create: `cli/src/codespace/stop-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/stop-list.test.ts`:

```ts
// stop/list (decision #7): stop's argv is docker stop <exact stored id> (never
// a filter), --dry-run prints it without spawning, a missing record refuses
// with exit 2; list renders the store as rows (LIVE column only when a live-id
// set is supplied) and --json emits the raw records. Network-free.
// Run with: bun src/codespace/stop-list.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderListRows } from './list.ts'
import { codespaceStop, buildStopArgv } from './stop.ts'
import { codespacesPath, saveCodespaces, type CodespacesFile } from './store.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-stoplist-'))
const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config') } as NodeJS.ProcessEnv

const workDir = path.join(tmp, 'stoprepo')
mkdirSync(workDir)
const realWork = realpathSync(workDir)
const store: CodespacesFile = {
	codespaces: {
		[realWork]: {
			gatewayId: 'cs-stoprepo-11223344',
			containerId: 'eff5bf19215854c3e8f20d46b787690f',
			repo: 'stoprepo',
			branch: 'main',
			canvasUrl: 'http://localhost:8788',
		},
		'/elsewhere/other': {
			gatewayId: 'cs-other-99887766',
			repo: 'other',
			branch: '',
			canvasUrl: 'http://localhost:8788',
		},
	},
}
saveCodespaces(codespacesPath(env), store)

// buildStopArgv: the exact stored id, nothing else.
assert.deepEqual(buildStopArgv('abc123'), ['docker', 'stop', 'abc123'])

// stop --dry-run from inside the checkout: prints the exact argv, exit 0.
{
	const prevCwd = process.cwd()
	const outChunks: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
	try {
		process.chdir(workDir)
		const code = await codespaceStop([], { refresh: false, json: false, dryRun: true, help: false }, env)
		assert.equal(code, 0)
	} finally {
		;(process.stdout as any).write = realOut
		process.chdir(prevCwd)
	}
	const printed = JSON.parse(outChunks.join(''))
	assert.deepEqual(printed.stopArgv, ['docker', 'stop', 'eff5bf19215854c3e8f20d46b787690f'], 'exact stored id — never a filter')
	assert.equal(printed.gatewayId, 'cs-stoprepo-11223344')
}

// stop with no record for the cwd: exit-2 CliError with the up hint.
{
	const bare = path.join(tmp, 'norecord')
	mkdirSync(bare)
	const prevCwd = process.cwd()
	try {
		process.chdir(bare)
		await assert.rejects(
			() => codespaceStop([], { refresh: false, json: false, dryRun: true, help: false }, env),
			/no known container .* ew codespace up/,
		)
	} finally {
		process.chdir(prevCwd)
	}
}

// renderListRows: one row per record; LIVE column only with a live-id set.
{
	const rows = renderListRows(store)
	assert.equal(rows.length, 2)
	const stopRow = rows.find((r) => r[0] === 'cs-stoprepo-11223344')
	assert.ok(stopRow)
	assert.equal(stopRow[1], 'stoprepo@main')
	assert.equal(stopRow[2], 'eff5bf192158', 'containerId shown short')
	const otherRow = rows.find((r) => r[0] === 'cs-other-99887766')
	assert.ok(otherRow)
	assert.equal(otherRow[1], 'other', 'branchless repo renders bare')
	assert.equal(otherRow[2], '-', 'no container yet')

	const live = renderListRows(store, new Set(['cs-stoprepo-11223344']))
	assert.equal(live.find((r) => r[0] === 'cs-stoprepo-11223344')?.at(-1), 'yes')
	assert.equal(live.find((r) => r[0] === 'cs-other-99887766')?.at(-1), 'no')
}

console.log('ok: stop/list — exact-id stop argv, dry-run, missing-record refusal, list rows')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/stop-list.test.ts`
Expected: FAIL — cannot resolve `./list.ts`.

- [ ] **Step 3: Implement**

Create `cli/src/codespace/stop.ts`:

```ts
/**
 * `ew codespace stop` (decision #7): docker stop by the EXACT stored
 * containerId — never a name/label filter (incident-derived policy). The
 * store record survives: it is SP4's desired-state seed; only the container's
 * processes die (design §5.1 event #3 — disk persists, prompt is fresh).
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { emitJson, narrate } from '../output.ts'
import { detectRepoInfo } from './repo-info.ts'
import { codespacesPath, loadCodespaces } from './store.ts'

export function buildStopArgv(containerId: string): string[] {
	return ['docker', 'stop', containerId]
}

export async function codespaceStop(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	if (args.length > 0) throw new CliError(`unknown codespace stop flag: ${args[0]}`, 2)
	const info = detectRepoInfo(process.cwd())
	const rec = loadCodespaces(codespacesPath(env)).codespaces[info.toplevel]
	if (!rec?.containerId) {
		throw new CliError(`no known container for ${info.toplevel} — run \`ew codespace up\` first`, 2)
	}
	const stopArgv = buildStopArgv(rec.containerId)
	if (globals.dryRun) {
		emitJson({ workspaceFolder: info.toplevel, gatewayId: rec.gatewayId, stopArgv })
		return 0
	}
	narrate(`ensembleworks: stopping container ${rec.containerId.slice(0, 12)} (${rec.gatewayId})`)
	const res = Bun.spawnSync(stopArgv, { stdout: 'inherit', stderr: 'inherit' })
	if (res.exitCode !== 0) throw new CliError(`docker stop exited ${res.exitCode}`, 1)
	return 0
}
```

Create `cli/src/codespace/list.ts`:

```ts
/**
 * `ew codespace list` (decision #7): the store's entries as a table (or raw
 * records under --json), with an optional --live probe of the canvas's
 * GET /api/terminal/list marking which gateways are currently registered.
 * The probe needs a resolvable instance; the plain listing never does.
 */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitJson, emitTable } from '../output.ts'
import { authHeaders, readEnv, resolveConn } from '../resolve.ts'
import { codespacesPath, loadCodespaces, type CodespacesFile } from './store.ts'

/** Pure row rendering; appends a LIVE column only when liveIds is supplied. */
export function renderListRows(store: CodespacesFile, liveIds?: Set<string>): string[][] {
	return Object.entries(store.codespaces).map(([dir, r]) => {
		const row = [
			r.gatewayId,
			r.branch ? `${r.repo}@${r.branch}` : r.repo,
			r.containerId?.slice(0, 12) ?? '-',
			r.canvasUrl,
			dir,
		]
		if (liveIds) row.push(liveIds.has(r.gatewayId) ? 'yes' : 'no')
		return row
	})
}

export async function codespaceList(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	let live = false
	for (const a of args) {
		if (a === '--live') live = true
		else throw new CliError(`unknown codespace list flag: ${a}`, 2)
	}
	const store = loadCodespaces(codespacesPath(env))
	let liveIds: Set<string> | undefined
	if (live) {
		const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
		const res = await fetch(new URL('/api/terminal/list', conn.url), { headers: authHeaders(conn.auth) })
		if (!res.ok) throw new CliError(`GET /api/terminal/list → ${res.status}`, 1)
		const body = (await res.json()) as { gateways?: Array<{ gatewayId: string }> }
		liveIds = new Set((body.gateways ?? []).map((g) => g.gatewayId))
	}
	if (globals.json) {
		emitJson(liveIds ? { codespaces: store.codespaces, live: [...liveIds] } : store.codespaces)
		return 0
	}
	const headers = ['GATEWAY', 'REPO', 'CONTAINER', 'CANVAS', 'DIR']
	if (liveIds) headers.push('LIVE')
	emitTable(headers, renderListRows(store, liveIds))
	return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/codespace/stop-list.test.ts`
Expected: PASS — `ok: stop/list — exact-id stop argv, dry-run, missing-record refusal, list rows`

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/stop.ts cli/src/codespace/list.ts cli/src/codespace/stop-list.test.ts
git commit -m "feat(cli): codespace stop/list — exact-id docker stop, store-backed list" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Dispatch wiring + help text

The `codespace` group is a native single-word group (like `auth`) — verbs dispatch inside it, `rebuild` = `up` with `removeExisting: true`.

**Files:**
- Create: `cli/src/codespace/index.ts`
- Create: `cli/src/codespace/group.test.ts`
- Modify: `cli/src/dispatch.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/codespace/group.test.ts`:

```ts
// codespace group dispatch through the real main(): unknown verb → exit 2
// with the verb menu; `codespace list --json` works end-to-end against an
// empty isolated store (no conn needed); top help advertises the group.
// Network-free. Run with: bun src/codespace/group.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../main.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-group-'))
const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config') } as NodeJS.ProcessEnv

const captureStd = async (fn: () => Promise<number>) => {
	const out: string[] = []
	const err: string[] = []
	const realOut = process.stdout.write.bind(process.stdout)
	const realErr = process.stderr.write.bind(process.stderr)
	;(process.stdout as any).write = (s: string) => { out.push(String(s)); return true }
	;(process.stderr as any).write = (s: string) => { err.push(String(s)); return true }
	let code: number
	try {
		code = await fn()
	} finally {
		;(process.stdout as any).write = realOut
		;(process.stderr as any).write = realErr
	}
	return { code, out: out.join(''), err: err.join('') }
}

// Unknown verb → exit 2 + the menu.
{
	const r = await captureStd(() => main(['codespace', 'frobnicate'], env))
	assert.equal(r.code, 2)
	assert.match(r.err, /unknown codespace command: frobnicate .*up \| stop \| rebuild \| list/)
}
// No verb at all → same shape.
{
	const r = await captureStd(() => main(['codespace'], env))
	assert.equal(r.code, 2)
	assert.match(r.err, /unknown codespace command: \(none\)/)
}
// list --json against the empty isolated store: exit 0, `{}` on stdout.
{
	const r = await captureStd(() => main(['codespace', 'list', '--json'], env))
	assert.equal(r.code, 0)
	assert.deepEqual(JSON.parse(r.out), {}, 'empty store lists as {}')
}
// Top help advertises the group.
{
	const r = await captureStd(() => main([], env))
	assert.equal(r.code, 0)
	assert.match(r.out, /codespace up\|stop\|rebuild\|list/)
}

console.log('ok: codespace group — verb menu, list --json end-to-end, top help')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/group.test.ts`
Expected: FAIL — first at the unknown-verb assertion: today `codespace frobnicate` falls through to manifest resolution and errors `no instance configured` (still exit 2, but the message regex does not match).

- [ ] **Step 3: Implement**

Create `cli/src/codespace/index.ts`:

```ts
/** The `codespace` group (coexistence spec §6.2): native verb dispatch,
 *  mirroring the auth group. up and rebuild share one engine — rebuild is up
 *  with --remove-existing-container (decision #7). */
import type { Globals } from '../dispatch.ts'
import { CliError } from '../errors.ts'
import { codespaceList } from './list.ts'
import { codespaceStop } from './stop.ts'
import { codespaceUp } from './up.ts'

export async function codespaceGroup(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
	const verb = args[0]
	switch (verb) {
		case 'up':
			return codespaceUp(args.slice(1), globals, env, { removeExisting: false })
		case 'rebuild':
			return codespaceUp(args.slice(1), globals, env, { removeExisting: true })
		case 'stop':
			return codespaceStop(args.slice(1), globals, env)
		case 'list':
			return codespaceList(args.slice(1), globals, env)
		default:
			throw new CliError(`unknown codespace command: ${verb ?? '(none)'} (expected up | stop | rebuild | list)`, 2)
	}
}
```

In `cli/src/dispatch.ts`:

Add the import (alphabetical with the others):

```ts
import { codespaceGroup } from './codespace/index.ts'
```

Add the group under "1. Native single-word groups." (after the `auth` line):

```ts
	if (group === 'codespace') return codespaceGroup(rest.slice(1), globals, env)
```

In `printTopHelp()`, replace the `native:` line with:

```ts
	emitLine('native: auth login|status|logout · codespace up|stop|rebuild|list · tools [refresh] · version · terminal connect · canvas pull-images · file open|refresh <path>')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/codespace/group.test.ts && bun cli/src/cli-api.test.ts`
Expected: both PASS (cli-api proves existing dispatch is untouched).

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/index.ts cli/src/codespace/group.test.ts cli/src/dispatch.ts
git commit -m "feat(cli): wire codespace group into dispatch + help" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Conformance smoke script + fixtures

Decision #9 and spec §7: **the acceptance test for this whole sub-project, and the permanent gate on embedded-CLI version bumps.** Needs docker + network, so it is deliberately named without `.test.` — no glob ever spawns it; it runs by hand (`bun scripts/codespace-conformance.ts`) or as a CI opt-in job. It drives the REAL `ew codespace up` (dev mode, `EW_CONNECTOR_BIN` pointing at a binary built once at script start) against a real ephemeral sync app, asserts an echo round-trip through the relay for each fixture, then `ew codespace stop` and container-not-running by exact id. Cleanup is by exact stored ids only — never a filter.

**Files:**
- Create: `scripts/fixtures/codespace-basic/.devcontainer/devcontainer.json`
- Create: `scripts/fixtures/codespace-features/.devcontainer/devcontainer.json`
- Create: `scripts/codespace-conformance.ts`

- [ ] **Step 1: Write the fixtures**

Create `scripts/fixtures/codespace-basic/.devcontainer/devcontainer.json`:

```json
{
	"image": "mcr.microsoft.com/devcontainers/base:debian"
}
```

Create `scripts/fixtures/codespace-features/.devcontainer/devcontainer.json`:

```json
{
	"image": "mcr.microsoft.com/devcontainers/base:debian",
	"features": {
		"ghcr.io/devcontainers/features/node:1": {}
	}
}
```

- [ ] **Step 2: Write the script**

Create `scripts/codespace-conformance.ts`:

```ts
// Codespace conformance smoke (coexistence spec §7 / decision #9): boots each
// fixture repo as a REAL EW Codespace via the real `ew codespace up` and
// asserts the interesting failure surface — repo → container → CONNECTOR →
// canvas — not repo → container alone (design §1). Also the permanent gate on
// bumping the vendored @devcontainers/cli pin.
//
// REQUIRES docker + network (image/feature pulls). Deliberately NOT *.test.ts:
// no test glob spawns it. Run by hand: bun scripts/codespace-conformance.ts
// Cleanup is by exact stored container ids only — never a filter.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from '../server/src/app.ts'

const repoRoot = path.join(import.meta.dir, '..')
const FIXTURES = ['codespace-basic', 'codespace-features']

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

function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 30_000): Promise<string> {
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

async function waitForGateway(httpBase: string, id: string, timeoutMs = 180_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${httpBase}/api/terminal/list`)
			const body = (await res.json()) as { gateways: Array<{ gatewayId: string }> }
			if (body.gateways.some((g) => g.gatewayId === id)) return
		} catch {
			// server warming up — retry
		}
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`gateway ${id} did not register within ${timeoutMs}ms`)
}

const run = (argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
	console.error(`\n$ ${argv.join(' ')}`)
	return Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'inherit' })
}

async function main() {
	// 0. Build the connector binary ONCE (decision #4: tests build once and set
	// the override). build:binary emits cli/dist/ensembleworks (glibc x64).
	{
		const build = Bun.spawnSync(['bun', 'run', '--filter', '@ensembleworks/cli', 'build:binary'], {
			cwd: repoRoot,
			stdout: 'inherit',
			stderr: 'inherit',
		})
		assert.equal(build.exitCode, 0, 'connector build:binary failed')
	}
	const connectorBin = path.join(repoRoot, 'cli', 'dist', 'ensembleworks')

	// 1. Boot the sync app (the splice plane) on an ephemeral port.
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'codespace-conformance-server-'))
	const { server } = createSyncApp({ dataDir }) as { server: http.Server }
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const port = (server.address() as { port: number }).port
	const httpBase = `http://127.0.0.1:${port}`
	const cliMain = path.join(repoRoot, 'cli', 'src', 'main.ts')

	const cleanupContainerIds: string[] = []
	let failed = false
	try {
		for (const fixture of FIXTURES) {
			console.error(`\n=== fixture: ${fixture} ===`)
			// 2. Copy the fixture to a fresh workspace (unique realpath → unique
			// gatewayId) with fully isolated XDG dirs per fixture.
			const workRoot = mkdtempSync(path.join(os.tmpdir(), `codespace-conformance-${fixture}-`))
			const workspace = path.join(workRoot, fixture)
			cpSync(path.join(repoRoot, 'scripts', 'fixtures', fixture), workspace, { recursive: true })
			run(['git', 'init', '-b', 'conformance', workspace])
			run(['git', '-c', 'user.email=c@c', '-c', 'user.name=c', 'commit', '--allow-empty', '-m', 'x'], { cwd: workspace })
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				XDG_CONFIG_HOME: path.join(workRoot, 'config'),
				XDG_DATA_HOME: path.join(workRoot, 'data'),
				XDG_CACHE_HOME: path.join(workRoot, 'cache'),
				EW_CONNECTOR_BIN: connectorBin,
				ENSEMBLEWORKS_URL: httpBase,
			}

			// 3. Read the plan (also proves --dry-run on a real repo) → gatewayId.
			const dry = run(['bun', cliMain, 'codespace', 'up', '--dry-run'], { cwd: workspace, env })
			assert.equal(dry.exitCode, 0, 'codespace up --dry-run failed')
			const plan = JSON.parse(dry.stdout.toString()) as { gatewayId: string; workspaceFolder: string }
			console.error(`gatewayId: ${plan.gatewayId}`)

			// 4. The real thing, in the background: up → inject → exec → supervise.
			const upProc = Bun.spawn(['bun', cliMain, 'codespace', 'up'], {
				cwd: workspace,
				env,
				stdout: 'inherit',
				stderr: 'inherit',
			})
			try {
				// 5. Terminal reaches the canvas: registration, then echo round-trip.
				await waitForGateway(httpBase, plan.gatewayId)
				const relayUrl = `ws://127.0.0.1:${port}/api/terminal/relay?session=conf${Date.now().toString(36)}&gateway=${plan.gatewayId}&cols=80&rows=24`
				const b = await openSocket(relayUrl)
				const attached = await firstText(b)
				assert.equal(attached.type, 'attached', 'relay attach handshake')
				const marker = `conformance-ok-${fixture}`
				const echoed = waitForOutput(b, marker)
				b.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }))
				await echoed
				b.close()
				console.error(`fixture ${fixture}: echo round-trip OK`)

				// 6. Stored containerId (written by the live engine) → exact-id checks.
				const store = JSON.parse(
					readFileSync(path.join(env.XDG_CONFIG_HOME, 'ensembleworks', 'codespaces.json'), 'utf8'),
				) as { codespaces: Record<string, { containerId?: string }> }
				const containerId = store.codespaces[plan.workspaceFolder]?.containerId
				assert.ok(containerId, 'live engine stored the containerId')
				cleanupContainerIds.push(containerId)
			} finally {
				upProc.kill('SIGINT') // foreground supervisor exits 0 on clean signal
				await upProc.exited
			}

			// 7. Stop by exact id and verify not running.
			const stop = run(['bun', cliMain, 'codespace', 'stop'], { cwd: workspace, env })
			assert.equal(stop.exitCode, 0, 'codespace stop failed')
			const inspect = run(['docker', 'inspect', '-f', '{{.State.Running}}', cleanupContainerIds.at(-1) as string])
			assert.equal(inspect.stdout.toString().trim(), 'false', 'container stopped (exact-id inspect)')
			console.error(`fixture ${fixture}: PASS`)
		}
	} catch (err) {
		failed = true
		console.error(err)
	} finally {
		// Cleanup by EXACT ids only (decision #9) — never a filter.
		for (const id of cleanupContainerIds) run(['docker', 'rm', '-f', id])
		server.close()
	}
	if (failed) process.exit(1)
	console.log(`codespace-conformance: all ${FIXTURES.length} fixtures passed (vendored @devcontainers/cli ${readFileSync(path.join(repoRoot, 'cli', 'vendor', 'devcontainers-cli', 'VERSION'), 'utf8').trim()})`)
	process.exit(0)
}

main()
```

- [ ] **Step 3: Verify the glob boundary (network-free)**

Run: `bun -e "const g=new Bun.Glob('**/src/**/*.test.ts'); const g2=new Bun.Glob('scripts/*.test.ts'); console.log([...g.scanSync('.')].concat([...g2.scanSync('.')]).filter(f=>f.includes('conformance')).length)"`
Expected: `0` — no test glob matches the conformance script.

- [ ] **Step 4: RUN THE SMOKE ONCE (docker + network — the acceptance gate)**

Run: `bun scripts/codespace-conformance.ts`
Expected: both fixtures narrate `up` progress, `echo round-trip OK`, `PASS`, and the script ends `codespace-conformance: all 2 fixtures passed (vendored @devcontainers/cli 0.87.0)` with exit 0.

**Paste the tail of the real output (the two `fixture …: PASS` lines and the final summary line) verbatim into this plan's Execution notes section.** If it fails, debug the engine/staging/exec — the conformance script is the spec here; fix the product, not the script.

- [ ] **Step 5: Commit**

```bash
git add scripts/codespace-conformance.ts scripts/fixtures/codespace-basic scripts/fixtures/codespace-features
git commit -m "test(scripts): codespace conformance smoke + devcontainer fixtures" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Full verification

- [ ] **Step 1: Typecheck everything**

Run: `bun run typecheck`
Expected: exit 0 across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: `all N suites passed` — the `**/src/**/*.test.ts` glob picks up the eight new `cli/src/codespace/*.test.ts` + the modified `connect.test.ts` automatically, and does NOT pick up `scripts/codespace-conformance.ts` (Task 12 Step 3 proved the boundary).

- [ ] **Step 3: Confirm clean tree and stop**

```bash
git status --short   # should be clean
```

Done. Hand off per superpowers:finishing-a-development-branch — PR body must include:
`ux-contract: none — CLI + host tooling; no interaction-bearing surface`

---

## Execution notes

**2026-07-21 — Task 12 conformance run (Sonnet implementer, verified by Opus
review + orchestrator): PASS, both fixtures.** Verbatim tail of the passing
run:

```
[gateway cs-codespace-features-d4251d23] connected (codespace-features@conformance) as dev
fixture codespace-features: echo round-trip OK
ensembleworks: codespace connector stopped (container left running — `ew codespace stop` to stop it)

$ bun /home/mrdavidlaing/Work/ensembleworks/cli/src/main.ts codespace stop
ensembleworks: stopping container ed80fb7d1e24 (cs-codespace-features-d4251d23)

$ docker inspect -f {{.State.Running}} ed80fb7d1e24ef5d28ac4743d81e21d9bb4210bff8ec2cc1a850d24c5c736746
fixture codespace-features: PASS

$ docker rm -f 1083e8d67db42fe7c0aea10d5c72a85d98ad398a8074a062a44e04712eb6c66d

$ docker rm -f ed80fb7d1e24ef5d28ac4743d81e21d9bb4210bff8ec2cc1a850d24c5c736746
codespace-conformance: all 2 fixtures passed (vendored @devcontainers/cli 0.87.0)
```

(`codespace-basic` passed identically earlier in the same run. All docker
stop/rm/inspect calls targeted exact container ids created by the run.)

---

## Out of scope for this plan (later sub-projects / deliberate v1 boundaries)

- Codespace shape, input ACL, registration-metadata consumption server-side (SP3 — this plan only *sends* `repo`/`branch` on the connect URL).
- Reconciler, boot-time bring-back, layout restore (SP4 — `codespaces.json` is deliberately its seed).
- Browser `ew auth login` (SP5 — service-token auth carries this plan).
- Non-glibc / non-x64 containers (decision #10: documented boundary, no runtime detection of exec-format failures).
- Podman/`--docker-path`, named-volume state B, multi-repo Codespaces (architecture-doc open decisions; none block this).
- Canvas-initiated lifecycle (`stop`/`rebuild` from a shape) — spec §8.
