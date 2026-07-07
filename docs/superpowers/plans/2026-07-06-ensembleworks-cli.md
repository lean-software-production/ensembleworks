# The `ensembleworks` CLI — one Bun program, a generic manifest renderer, auth, and the `terminal connect` slot (slice #4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `cli/` Bun workspace (`@ensembleworks/cli`) that builds one program,
run in dev as `bun cli/src/main.ts` behind a `bin/ensembleworks` wrapper (+ `ew`
hardlink). It is a **generic renderer of `GET /api/tools`** (the 3b manifest)
plus the small set of native commands that cannot be data-driven: the `auth`
credential store, `version`, the `tools` cache commands, `canvas pull-images`,
and the `terminal connect` **slot** (`--dry-run` only; the engine is #5).
Dispatch is three layers — native → manifest-rendered → trusted-dir extension →
error. It rewrites all four `SKILL.md` files atomically so the agent surface
moves from `canvas …` to `ensembleworks …` in the same merge. After the slice
`bun run typecheck`, `bun run test`, `bun run build` are green and the suite
count is **45 → 52** (this slice adds exactly seven suites).

**Spec:** `docs/superpowers/specs/2026-07-06-ensembleworks-cli-design.md` —
panel- and gate-approved; implement it exactly. Its command table (§6.4), the
resolution chain (§5.2), the arg model (§6.2), the manifest-cache flow (§6.3),
the auth flow (§8), the connect slot (§10), the reseed map (§11), and the seven
test suites (§13) are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"#4 — The `ensembleworks` CLI" + "#4 gate ratifications" + "Standing conventions".

**Scope boundary (from the spec §1 — do not cross it):** #4 builds the connect
**slot** (flags + `--dry-run` resolution), NOT the connector engine (#5). It does
**no** `bun build --compile` / `install.sh` / self-update (those are #7 — #4 only
owes *compile compatibility*: static imports, real-FS config paths, an injected
build version). It does **not** delete `bin/canvas` (that is the #8 cutover;
`bin/canvas` stays untouched and working). It does **not** change any
contracts/tool def, server route, write-scope guard, or attribution stamp — all
frozen by 3a/3b/3c; #4 consumes them read-only. No `/mcp` (Phase 4).

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in all `cli/src/*` files (matches `server/src/*`,
   `contracts/src/*`, and `transcriber/src/*` — the whole repo is tab-indented;
   there is no biome/prettier/editorconfig). Every verbatim block below is
   written with tabs; preserve them.
3. **Import extensions.** Intra-`cli` imports use the `.ts` extension
   (`./resolve.ts`, `../http.ts`) — the `allowImportingTsExtensions` config in
   Task 1's `cli/tsconfig.json` permits it and Bun runs it natively. Contracts is
   imported by package name `@ensembleworks/contracts` (the barrel), never by
   deep path. `zod` is v4.
4. **`smol-toml`** is the only new third-party runtime dep (parse+stringify for
   `hosts.toml`); it is added to `cli/package.json` in Task 1 via `bun add`.
5. **Test convention.** Self-running `bun src/<x>.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob — **verified to already
   match `cli/src/*.test.ts` and `cli/src/render/*.test.ts` and
   `cli/src/native/*.test.ts` (the glob's `**` matches zero-or-more segments;
   files directly under `src/` are discovered today), so no runner change.**
   Each suite ends `console.log('ok: …')`.
6. **CRITICAL house convention — `process.exit(0)` after a booted-app suite.**
   Any test that calls `createSyncApp` MUST end with `process.exit(0)` after its
   final `console.log(...)` — the app's background intervals keep the event loop
   alive, so without the explicit exit the suite hangs and the runner stalls.
   Only Task 8's `cli/src/cli-api.test.ts` boots an app; the six unit suites
   (Tasks 1/3/4/6) are network-free (no `createSyncApp`, only a stubbed
   `globalThis.fetch` at most) and need no exit.
7. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task vs at the end

- **Per task (Tasks 1–7): `bun run typecheck` MUST be green, and the specific
  test suite(s) named in that task MUST be at the state the task declares** (RED
  at a written-test checkpoint, GREEN at the task's end). Tasks 2, 5, and 7 add
  no new suite (they are infrastructure / renderer / wrappers whose behaviour is
  pinned by a later suite — see each task's "Coverage note"); they gate on
  `typecheck` plus re-running the already-green unit suites to prove no
  regression.
- **No task is permitted to leave a red suite at its end.**
- **End only (Task 8): the full `bun run test` (`all 52 suites passed`),
  `bun run build`, and the manual smoke.**

### One reconciled spec ambiguity — the positional-slot rule (pinned in Task 4)

Spec §6.2's code sketch derives positional slots from `schema.required` only, but
its own prose and the reseed (§11) both rely on `ensembleworks roadmap read
"Product Roadmap"` — and `roadmap.read`'s `name` is **optional**, so a
required-only rule cannot reach it positionally. Meanwhile `scribe say <identity>
<text>` needs `text` at slot 1, skipping the *optional* `name` declared between
them — which a naive "all scalars in declaration order" rule breaks. The single
rule that satisfies **every** documented example is: **required non-`room`
scalars first (in declaration order), then optional non-`room` scalars (in
declaration order).** This is the literal sketch (required scalars) with optional
scalars appended, and it is pinned by `args.test.ts` cases for both `scribe say`
(text→slot 1) and `roadmap read` (optional name→slot 0). Documented here, not
escalated — it is an implementation reconciliation of two spec statements, not a
new product choice.

---

## Task 1 — Workspace scaffold + root wiring + `errors`/`hosts`/`resolve` (TDD: RED → GREEN)

Stand up the `cli/` workspace, wire it into the root, and build the three
network-free foundations: the `CliError` type, the `hosts.toml` store (0600 on
write, warn-on-read), and the connection-resolution chain. Two suites drive it.

### Step 1 — Scaffold the workspace and wire the root

- [ ] **`cli/package.json`** (create it):
  ```json
  {
  	"name": "@ensembleworks/cli",
  	"private": true,
  	"version": "0.1.0",
  	"type": "module",
  	"bin": {
  		"ensembleworks": "src/main.ts",
  		"ew": "src/main.ts"
  	},
  	"scripts": {
  		"build": "bunx tsc --noEmit",
  		"typecheck": "bunx tsc --noEmit"
  	},
  	"dependencies": {
  		"@ensembleworks/contracts": "*"
  	},
  	"devDependencies": {
  		"@types/node": "^22.0.0",
  		"bun-types": "1.3.14",
  		"typescript": "^5.7.0"
  	}
  }
  ```

- [ ] **`cli/tsconfig.json`** (create it — mirrors the proven `transcriber`
  config: `moduleResolution: bundler` + `allowImportingTsExtensions` + a `paths`
  map for the contracts barrel and the server test seam Task 8 needs):
  ```json
  {
  	"compilerOptions": {
  		"target": "ES2022",
  		"module": "ESNext",
  		"moduleResolution": "bundler",
  		"lib": ["ES2022"],
  		"types": ["node", "bun-types"],
  		"strict": true,
  		"noEmit": true,
  		"allowImportingTsExtensions": true,
  		"skipLibCheck": true,
  		"esModuleInterop": true,
  		"forceConsistentCasingInFileNames": true,
  		"noUncheckedIndexedAccess": true,
  		"paths": {
  			"@ensembleworks/contracts": ["../contracts/src/index.ts"]
  		}
  	},
  	"include": ["src"]
  }
  ```
  (`noUncheckedIndexedAccess` matches transcriber; every `argv[i]` / `props[k]`
  access in the code below already treats results as possibly-`undefined`.)

- [ ] **Add `cli` to the root `package.json` `workspaces` array and the
  `typecheck` script** (NOT `build` — #4 ships no compiled artifact; §9.1 defers
  `bun build --compile` to #7, and `cli`'s `build` script is a bare typecheck
  wired only for symmetry). Replace:
  ```json
    "workspaces": [
      "contracts",
      "client",
      "server",
      "transcriber"
    ],
  ```
  with:
  ```json
    "workspaces": [
      "contracts",
      "client",
      "server",
      "transcriber",
      "cli"
    ],
  ```
  and replace:
  ```json
      "typecheck": "bun run --filter '@ensembleworks/contracts' typecheck && bun run --filter '@ensembleworks/client' typecheck && bun run --filter '@ensembleworks/server' typecheck && bun run --filter '@ensembleworks/transcriber' typecheck && bunx tsc -p bin/tsconfig.json",
  ```
  with:
  ```json
      "typecheck": "bun run --filter '@ensembleworks/contracts' typecheck && bun run --filter '@ensembleworks/client' typecheck && bun run --filter '@ensembleworks/server' typecheck && bun run --filter '@ensembleworks/transcriber' typecheck && bun run --filter '@ensembleworks/cli' typecheck && bunx tsc -p bin/tsconfig.json",
  ```

- [ ] **Add `smol-toml` and install:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun add smol-toml)   # pins the current version into cli/package.json
  bun install                     # links the new workspace + symlinks @ensembleworks/contracts
  ```
  Expected: `cli/package.json` gains a `smol-toml` dependency; `bun install`
  exits 0 and creates the `@ensembleworks/cli` and `@ensembleworks/contracts`
  symlinks under `node_modules`.

### Step 2 — Write the failing unit tests (RED)

- [ ] **`cli/src/hosts.test.ts`** (create it — network-free, no boot):
  ```ts
  // hosts.toml store: smol-toml round-trip (quoted-URL table keys survive),
  // setInstance sets default_instance, removeInstance reassigns/clears it, 0600
  // on write, and the read-side perm check warns on 0644 / is silent on 0600.
  // Run with: bun src/hosts.test.ts
  import assert from 'node:assert/strict'
  import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { loadHosts, removeInstance, saveHosts, setInstance, type HostsFile } from './hosts.ts'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-hosts-'))
  const file = path.join(dir, 'hosts.toml')

  // Round-trip: two instances, one service-token (quoted-URL key) and one none.
  let hosts: HostsFile = { instances: {} }
  hosts = setInstance(hosts, 'https://canvas.example.com', {
  	method: 'service-token',
  	token_id: '1a2b.access',
  	token_secret: 's3cr3t',
  	default_room: 'team',
  	identity: '🤖 codespace-3',
  })
  hosts = setInstance(hosts, 'http://localhost:8788', { method: 'none', default_room: 'team' })
  saveHosts(file, hosts)

  // 0600 asserted on write.
  assert.equal(statSync(file).mode & 0o777, 0o600, 'saveHosts writes mode 0600')

  const reloaded = loadHosts(file)
  assert.equal(reloaded.default_instance, 'http://localhost:8788', 'last setInstance is the default')
  assert.deepEqual(reloaded.instances['https://canvas.example.com'], {
  	method: 'service-token',
  	token_id: '1a2b.access',
  	token_secret: 's3cr3t',
  	default_room: 'team',
  	identity: '🤖 codespace-3',
  }, 'quoted-URL table key round-trips losslessly')

  // logout: remove the default, reassign to the remaining instance.
  const afterLogout = removeInstance(reloaded, 'http://localhost:8788')
  assert.equal(afterLogout.instances['http://localhost:8788'], undefined, 'record removed')
  assert.equal(afterLogout.default_instance, 'https://canvas.example.com', 'default reassigned to survivor')
  // logout the last one → default cleared.
  const empty = removeInstance(afterLogout, 'https://canvas.example.com')
  assert.equal(empty.default_instance, undefined, 'default cleared when no instances remain')

  // Read-side perm check: 0644 warns on stderr; 0600 is silent.
  const warnFile = path.join(dir, 'loose.toml')
  writeFileSync(warnFile, 'default_instance = "http://x"\n[instances."http://x"]\nmethod = "none"\n')
  chmodSync(warnFile, 0o644)
  const captured: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (s: string) => { captured.push(String(s)); return true }
  try {
  	loadHosts(warnFile)
  	chmodSync(warnFile, 0o600)
  	loadHosts(warnFile)
  } finally {
  	;(process.stderr as any).write = realWrite
  }
  assert.equal(captured.filter((l) => l.includes('should be 0600')).length, 1, 'warns once (the 0644 load), silent on 0600')

  console.log('ok: hosts — round-trip, default_instance set/reassign/clear, 0600 write, warn-on-loose-read')
  ```

- [ ] **`cli/src/resolve.test.ts`** (create it — network-free):
  ```ts
  // The connection-resolution chain (§5.2): flag>env>file per-variable merge,
  // the lone-URL case (keeps file creds), env token override, an unknown-instance
  // env-only case, default_instance fallback, the no-instance error, and
  // authHeaders emitting the pair only for service-token.
  // Run with: bun src/resolve.test.ts
  import assert from 'node:assert/strict'
  import { CliError } from './errors.ts'
  import type { HostsFile } from './hosts.ts'
  import { authHeaders, resolveConn } from './resolve.ts'

  const hosts: HostsFile = {
  	default_instance: 'https://prod.example.com',
  	instances: {
  		'https://prod.example.com': {
  			method: 'service-token',
  			token_id: 'file-id',
  			token_secret: 'file-secret',
  			default_room: 'prod-room',
  		},
  	},
  }

  // default_instance fallback + file creds/room.
  {
  	const c = resolveConn({}, {}, hosts)
  	assert.equal(c.url, 'https://prod.example.com')
  	assert.equal(c.room, 'prod-room')
  	assert.deepEqual(c.auth, { method: 'service-token', tokenId: 'file-id', tokenSecret: 'file-secret' })
  }

  // Lone ENSEMBLEWORKS_URL pointing at a KNOWN instance keeps the file's creds/room.
  {
  	const c = resolveConn({}, { ENSEMBLEWORKS_URL: 'https://prod.example.com' }, hosts)
  	assert.equal(c.room, 'prod-room', 'lone URL does not discard file room')
  	assert.equal(c.auth.method, 'service-token', 'lone URL keeps file creds')
  }

  // Env token pair overrides the file pair for the resolved URL (agent-seed case).
  {
  	const c = resolveConn({}, { ENSEMBLEWORKS_TOKEN_ID: 'env-id', ENSEMBLEWORKS_TOKEN_SECRET: 'env-secret' }, hosts)
  	assert.deepEqual(c.auth, { method: 'service-token', tokenId: 'env-id', tokenSecret: 'env-secret' })
  }

  // ENSEMBLEWORKS_URL to an instance ABSENT from the file → env-only, no error,
  // method 'none' when the pair is absent (fully env-driven agent, no file needed).
  {
  	const c = resolveConn({}, { ENSEMBLEWORKS_URL: 'http://unknown:8788' }, hosts)
  	assert.equal(c.url, 'http://unknown:8788')
  	assert.equal(c.room, 'team', 'unknown instance → default room')
  	assert.deepEqual(c.auth, { method: 'none' })
  }

  // flag > env > file precedence for url and room.
  {
  	const c = resolveConn({ url: 'http://flag:1', room: 'flag-room' }, { ENSEMBLEWORKS_URL: 'http://env:2', ENSEMBLEWORKS_ROOM: 'env-room' }, hosts)
  	assert.equal(c.url, 'http://flag:1')
  	assert.equal(c.room, 'flag-room')
  }

  // No instance anywhere → CliError (exit 2).
  {
  	assert.throws(() => resolveConn({}, {}, { instances: {} }), (e) => e instanceof CliError && (e as CliError).exitCode === 2)
  }

  // authHeaders: pair only for service-token; none → empty.
  assert.deepEqual(authHeaders({ method: 'service-token', tokenId: 'i', tokenSecret: 's' }), {
  	'CF-Access-Client-Id': 'i',
  	'CF-Access-Client-Secret': 's',
  })
  assert.deepEqual(authHeaders({ method: 'none' }), {})

  console.log('ok: resolve — per-variable merge, lone-URL, env override, unknown-instance, precedence, no-instance error, authHeaders')
  ```

- [ ] **RED checkpoint — run both, expect failure (modules do not exist yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/hosts.test.ts) ; (cd cli && bun src/resolve.test.ts)
  ```
  Expected: both **fail** — `Cannot find module './hosts.ts'` /
  `'./resolve.ts'` / `'./errors.ts'`. Step 3 turns them green.

### Step 3 — Write the three modules (GREEN)

- [ ] **`cli/src/errors.ts`** (create it):
  ```ts
  /**
   * A CLI error carrying the process exit code. Thrown anywhere; main.ts catches
   * it, prints `ensembleworks: <message>` to stderr, and exits with `exitCode`.
   * exitCode 2 = a local/structural refusal (bad args, unknown flag, no instance,
   * a poisoned manifest path); 1 = a runtime/transport failure or a non-2xx that
   * matters. Any non-CliError bubbles up as exit 1.
   */
  export class CliError extends Error {
  	readonly exitCode: number
  	constructor(message: string, exitCode = 1) {
  		super(message)
  		this.name = 'CliError'
  		this.exitCode = exitCode
  	}
  }
  ```

- [ ] **`cli/src/hosts.ts`** (create it):
  ```ts
  /**
   * The hosts.toml store (~/.config/ensembleworks/hosts.toml): an AUTH-ONLY file
   * (no gateway identity) of `default_instance` + `[instances."<url>"]` records.
   * Written 0600; every read stats it and warns (never blocks) on group/world
   * bits — the gh/ssh habit. smol-toml round-trips the quoted-URL table keys.
   */
  import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { parse, stringify } from 'smol-toml'

  export interface InstanceRecord {
  	method: 'service-token' | 'none'
  	token_id?: string
  	token_secret?: string
  	default_room?: string
  	identity?: string
  }

  export interface HostsFile {
  	default_instance?: string
  	instances: Record<string, InstanceRecord>
  }

  /** Real-FS config path (never import.meta-relative — compile-safe, §9.2). */
  export function hostsPath(env: NodeJS.ProcessEnv = process.env): string {
  	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  	return path.join(configHome, 'ensembleworks', 'hosts.toml')
  }

  export function loadHosts(file: string): HostsFile {
  	let raw: string
  	try {
  		raw = readFileSync(file, 'utf8')
  	} catch {
  		return { instances: {} } // absent file is fine — a fully env-driven agent needs none
  	}
  	warnOnLoosePerms(file)
  	const parsed = parse(raw) as { default_instance?: unknown; instances?: unknown }
  	return {
  		default_instance: typeof parsed.default_instance === 'string' ? parsed.default_instance : undefined,
  		instances: (parsed.instances ?? {}) as Record<string, InstanceRecord>,
  	}
  }

  export function saveHosts(file: string, hosts: HostsFile): void {
  	mkdirSync(path.dirname(file), { recursive: true })
  	const doc: Record<string, unknown> = {}
  	if (hosts.default_instance) doc.default_instance = hosts.default_instance
  	doc.instances = hosts.instances
  	writeFileSync(file, stringify(doc), { mode: 0o600 })
  	chmodSync(file, 0o600) // writeFileSync mode is masked by umask; force 0600 (headless boxes, §5.1)
  }

  /** Set (or replace) an instance record and make it the default (last login wins). */
  export function setInstance(hosts: HostsFile, url: string, rec: InstanceRecord): HostsFile {
  	return { default_instance: url, instances: { ...hosts.instances, [url]: rec } }
  }

  /** Remove an instance; if it was the default, reassign to the first survivor or clear. */
  export function removeInstance(hosts: HostsFile, url: string): HostsFile {
  	const instances = { ...hosts.instances }
  	delete instances[url]
  	let default_instance = hosts.default_instance
  	if (default_instance === url) default_instance = Object.keys(instances)[0]
  	return { default_instance, instances }
  }

  function warnOnLoosePerms(file: string): void {
  	try {
  		const mode = statSync(file).mode & 0o777
  		if (mode & 0o077) {
  			process.stderr.write(
  				`warning: ${file} has permissions 0${mode.toString(8).padStart(3, '0')} — should be 0600 (chmod 600 ${file})\n`,
  			)
  		}
  	} catch {
  		// stat failure is non-fatal — the caller already read the file
  	}
  }
  ```

- [ ] **`cli/src/resolve.ts`** (create it — the §5.2 chain + authHeaders):
  ```ts
  /**
   * The connection-resolution chain (spec §5.2): resolve the URL (flag → env →
   * default_instance), look up THAT url's file record, then overlay each env var
   * individually (the GH_TOKEN per-variable pattern — a lone ENSEMBLEWORKS_URL
   * keeps the file's creds/room). authHeaders emits the CF Access service-token
   * pair (exactly what gateway-go sends) only for a service-token instance.
   */
  import { CliError } from './errors.ts'
  import type { HostsFile } from './hosts.ts'

  export interface Flags {
  	url?: string
  	room?: string
  }

  export interface Env {
  	ENSEMBLEWORKS_URL?: string
  	ENSEMBLEWORKS_ROOM?: string
  	ENSEMBLEWORKS_TOKEN_ID?: string
  	ENSEMBLEWORKS_TOKEN_SECRET?: string
  }

  export type Auth =
  	| { method: 'service-token'; tokenId: string; tokenSecret: string }
  	| { method: 'none' }

  export interface Conn {
  	url: string
  	room: string
  	auth: Auth
  }

  export function readEnv(env: NodeJS.ProcessEnv): Env {
  	return {
  		ENSEMBLEWORKS_URL: env.ENSEMBLEWORKS_URL,
  		ENSEMBLEWORKS_ROOM: env.ENSEMBLEWORKS_ROOM,
  		ENSEMBLEWORKS_TOKEN_ID: env.ENSEMBLEWORKS_TOKEN_ID,
  		ENSEMBLEWORKS_TOKEN_SECRET: env.ENSEMBLEWORKS_TOKEN_SECRET,
  	}
  }

  export function resolveConn(flags: Flags, env: Env, hosts: HostsFile): Conn {
  	// 1. URL: flag → env → default_instance → error.
  	const url = flags.url ?? env.ENSEMBLEWORKS_URL ?? hosts.default_instance
  	if (!url) {
  		throw new CliError(
  			'no instance configured — pass --url, set ENSEMBLEWORKS_URL, or run `ensembleworks auth login`',
  			2,
  		)
  	}

  	// 2. The file record for THIS url (may be undefined for an env-only instance).
  	const rec = hosts.instances[url]

  	// 3. Per-variable overlay: a lone ENSEMBLEWORKS_URL keeps rec's creds/room.
  	const room = flags.room ?? env.ENSEMBLEWORKS_ROOM ?? rec?.default_room ?? 'team'
  	const tokenId = env.ENSEMBLEWORKS_TOKEN_ID ?? rec?.token_id
  	const tokenSecret = env.ENSEMBLEWORKS_TOKEN_SECRET ?? rec?.token_secret

  	const auth: Auth =
  		tokenId && tokenSecret
  			? { method: 'service-token', tokenId, tokenSecret }
  			: { method: 'none' }

  	return { url, room, auth }
  }

  export function authHeaders(auth: Auth): Record<string, string> {
  	if (auth.method === 'service-token') {
  		return {
  			'CF-Access-Client-Id': auth.tokenId,
  			'CF-Access-Client-Secret': auth.tokenSecret,
  		}
  	}
  	return {}
  }
  ```

### Step 4 — GREEN gate + commit

- [ ] **Run both suites + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/hosts.test.ts)
  (cd cli && bun src/resolve.test.ts)
  bun run typecheck
  ```
  Expected: `hosts.test.ts` prints
  `ok: hosts — round-trip, default_instance set/reassign/clear, 0600 write, warn-on-loose-read`;
  `resolve.test.ts` prints
  `ok: resolve — per-variable merge, lone-URL, env override, unknown-instance, precedence, no-instance error, authHeaders`;
  `bun run typecheck` exits 0 (now including `@ensembleworks/cli`).

- [ ] **Commit:**
  ```bash
  git add cli/package.json cli/tsconfig.json cli/src/errors.ts cli/src/hosts.ts \
    cli/src/resolve.ts cli/src/hosts.test.ts cli/src/resolve.test.ts package.json bun.lock
  git commit -m "$(cat <<'EOF'
  feat(cli): scaffold @ensembleworks/cli workspace + hosts.toml store + resolution chain (slice #4)

  New Bun workspace (bin ensembleworks/ew), wired into root workspaces + typecheck.
  errors.ts (CliError with exitCode); hosts.ts (auth-only hosts.toml via smol-toml,
  0600 on write, warn-on-loose-read, setInstance/removeInstance default handling);
  resolve.ts (the §5.2 per-variable flag→env→file chain + authHeaders CF Access
  pair). Two network-free unit suites pin the round-trip, the perm warning, and
  every merge/precedence case. Build stays #7's concern (no compile here).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — `http.ts` (fetch + same-origin guard) + `output.ts` + `build.ts`

The request transport and the output discipline. `http.ts`'s `toRequestUrl`
guard is the security seam (a poisoned manifest path can never receive the auth
headers); it is exercised network-free by Task 3's `manifest.test.ts` and
end-to-end by Task 8. `output.ts` centralises stdout-clean vs stderr-narration.
`build.ts` supplies the injected `CLI_BUILD` version (§9.2 rule 3).

**Coverage note:** this task adds **no new suite** — its guard is pinned by
`manifest.test.ts` (Task 3) and its output paths by `cli-api.test.ts` (Task 8).
It gates on `typecheck` + the two Task-1 suites staying green.

- [ ] **`cli/src/build.ts`** (create it):
  ```ts
  /**
   * The CLI build version. In dev (`bun cli/src/main.ts`) it is read soft from
   * cli/package.json — mirroring the server's SERVER_VERSION '0.0.0' fallback.
   * Sub-project #7's `bun build --compile` replaces this whole function with a
   * stamped literal (a compiled binary has no sibling package.json), so the
   * compiled path never touches import.meta or the filesystem.
   */
  import { readFileSync } from 'node:fs'
  import path from 'node:path'
  import { fileURLToPath } from 'node:url'

  function readCliBuild(): string {
  	try {
  		const here = path.dirname(fileURLToPath(import.meta.url))
  		const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: string }
  		return pkg.version ?? '0.0.0'
  	} catch {
  		return '0.0.0'
  	}
  }

  export const CLI_BUILD: string = readCliBuild()
  ```

- [ ] **`cli/src/http.ts`** (create it):
  ```ts
  /**
   * The HTTP transport: joins a request path onto the resolved instance URL,
   * attaches the CF Access pair for service-token instances, and returns the raw
   * status + body (never throwing on non-2xx — the caller decides, so a roadmap
   * 409 body reaches stdout). toRequestUrl is the security seam: it REFUSES any
   * path that is not a same-origin, /-rooted relative path, so a poisoned
   * manifest-cache entry (absolute URL, protocol-relative //host, or a non-rooted
   * path) can never be joined and thus never receive the auth headers (§8).
   */
  import { CliError } from './errors.ts'
  import { authHeaders, type Conn } from './resolve.ts'

  export interface Req {
  	method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  	path: string
  	query?: Record<string, unknown>
  	json?: Record<string, unknown>
  }

  export interface HttpResult {
  	status: number
  	body: string
  }

  /** Join `path` onto `base`, rejecting anything that is not a same-origin
   *  /-rooted relative path. `hint` (a cache-file path) is named in the error so a
   *  poisoned cache is diagnosable. Pure — throws BEFORE any request is built. */
  export function toRequestUrl(base: string, path: string, hint = ''): URL {
  	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
  		throw new CliError(
  			`refusing request to non-same-origin path ${JSON.stringify(path)}` +
  				(hint ? ` (poisoned manifest cache: ${hint})` : ''),
  			2,
  		)
  	}
  	return new URL(path, base.endsWith('/') ? base : `${base}/`)
  }

  export async function request(conn: Conn, req: Req, hint = ''): Promise<HttpResult> {
  	const url = toRequestUrl(conn.url, req.path, hint)
  	if (req.query) {
  		for (const [k, v] of Object.entries(req.query)) {
  			if (v === undefined || v === null) continue
  			url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  		}
  	}
  	const headers: Record<string, string> = { ...authHeaders(conn.auth) }
  	let body: string | undefined
  	if (req.json !== undefined) {
  		headers['Content-Type'] = 'application/json'
  		body = JSON.stringify(req.json)
  	}
  	let res: Response
  	try {
  		res = await fetch(url, { method: req.method, headers, body })
  	} catch (err) {
  		throw new CliError(`request to ${url.origin} failed: ${(err as Error).message}`)
  	}
  	return { status: res.status, body: await res.text() }
  }
  ```

- [ ] **`cli/src/output.ts`** (create it):
  ```ts
  /**
   * Output discipline (spec §7.1): stdout is ALWAYS clean — either a data verb's
   * verbatim server response, or an operator verb's requested human/JSON view.
   * Every diagnostic, prompt, warning and progress line goes to stderr via
   * narrate(). (Mirrors the `bin/dev … --json` convention in CLAUDE.md.)
   */
  export function emitData(body: string): void {
  	process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
  }

  export function emitJson(value: unknown): void {
  	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  }

  export function emitLine(line: string): void {
  	process.stdout.write(`${line}\n`)
  }

  export function narrate(line: string): void {
  	process.stderr.write(`${line}\n`)
  }

  export function emitTable(headers: string[], rows: string[][]): void {
  	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  	const fmt = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  	emitLine(fmt(headers))
  	for (const r of rows) emitLine(fmt(r))
  }
  ```

- [ ] **GREEN gate + commit:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd cli && bun src/hosts.test.ts && bun src/resolve.test.ts)   # still green — no regression
  git add cli/src/build.ts cli/src/http.ts cli/src/output.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): http transport (same-origin path guard) + output discipline + build version (slice #4)

  http.ts: toRequestUrl refuses any non-same-origin /-rooted path BEFORE building a
  request, so a poisoned manifest-cache path can never receive the CF Access pair;
  request() attaches the pair for service-token instances and returns raw
  status+body without throwing on non-2xx (roadmap 409 body reaches stdout).
  output.ts centralises stdout-clean (emitData/emitJson/emitTable) vs stderr
  narration. build.ts supplies CLI_BUILD (soft dev read; #7 stamps a literal).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — Manifest cache + embedded snapshot (TDD: RED → GREEN)

The cache/embedded-snapshot flow (spec §6.3): fetch-on-miss, never auto-refetch
on hit, `--refresh` forces, version-mismatch or offline falls back to the
compiled-in `allTools` snapshot, keying is per-instance, and the poisoned-path
guard is proven network-free.

### Step 1 — Write the failing suite (RED)

- [ ] **`cli/src/render/manifest.test.ts`** (create it — network-free; stubs
  `globalThis.fetch`, temp `XDG_CACHE_HOME`):
  ```ts
  // Manifest cache lifecycle (§6.3): on-miss fetch+write; on-hit no refetch;
  // --refresh forces; version mismatch ignores cache; offline → embedded snapshot;
  // per-instance keying; and the poisoned-path guard (toRequestUrl throws for the
  // three bad path forms BEFORE any fetch). Network is a stubbed globalThis.fetch.
  // Run with: bun src/render/manifest.test.ts
  import assert from 'node:assert/strict'
  import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { MANIFEST_VERSION } from '@ensembleworks/contracts'
  import { CliError } from '../errors.ts'
  import { toRequestUrl } from '../http.ts'
  import type { Conn } from '../resolve.ts'
  import { cachePath, embeddedManifest, loadManifest } from './manifest.ts'

  const cacheHome = mkdtempSync(path.join(os.tmpdir(), 'ew-cache-'))
  const env = { XDG_CACHE_HOME: cacheHome } as unknown as NodeJS.ProcessEnv
  const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }

  const envelope = (version: number) => ({
  	version,
  	server: 'test-1.2.3',
  	tools: [{ plugin: 'canvas', id: 'sticky', method: 'POST', path: '/api/canvas/sticky', help: 'h', input: {}, output: {} }],
  })

  let fetchCount = 0
  const realFetch = globalThis.fetch
  const stub = (ok: boolean, version = MANIFEST_VERSION) =>
  	((async () => {
  		fetchCount++
  		if (!ok) throw new Error('offline')
  		return new Response(JSON.stringify(envelope(version)), { status: 200 })
  	}) as unknown as typeof fetch)

  try {
  	// 1. on-miss → fetch + write cache.
  	globalThis.fetch = stub(true)
  	let r = await loadManifest(conn, { env })
  	assert.equal(r.source, 'network')
  	assert.equal(fetchCount, 1)
  	assert.ok(existsSync(cachePath(conn.url, env)), 'cache written on miss')
  	assert.equal(r.envelope.server, 'test-1.2.3')

  	// 2. on-hit → no refetch.
  	r = await loadManifest(conn, { env })
  	assert.equal(r.source, 'cache')
  	assert.equal(fetchCount, 1, 'a cache hit never refetches')

  	// 3. --refresh → forces a fetch.
  	r = await loadManifest(conn, { env, refresh: true })
  	assert.equal(r.source, 'network')
  	assert.equal(fetchCount, 2)

  	// 4. version mismatch on the cached file → ignore cache, fetch; if the fetch
  	//    also mismatches → embedded.
  	globalThis.fetch = stub(true, 999)
  	r = await loadManifest(conn, { env })
  	assert.equal(r.source, 'embedded', 'a version the CLI does not understand falls back to embedded')

  	// 5. offline (fetch throws) with no usable cache → embedded snapshot.
  	const offlineConn: Conn = { url: 'http://offline:9999', room: 'team', auth: { method: 'none' } }
  	globalThis.fetch = stub(false)
  	r = await loadManifest(offlineConn, { env })
  	assert.equal(r.source, 'embedded')
  	assert.equal(r.envelope.version, MANIFEST_VERSION)
  	assert.equal(r.envelope.tools.length, 15, 'embedded snapshot is the 15-def allTools')

  	// 6. per-instance keying: different urls → different cache files.
  	assert.notEqual(cachePath('http://a:1', env), cachePath('http://b:2', env))

  	// 7. poisoned-path guard: three bad forms all throw BEFORE any request builds.
  	const before = fetchCount
  	for (const bad of ['https://evil.example/x', '//evil.example/x', 'api/x']) {
  		assert.throws(() => toRequestUrl(conn.url, bad, cachePath(conn.url, env)), (e) => e instanceof CliError)
  	}
  	assert.ok(toRequestUrl(conn.url, '/api/tools').href.startsWith('http://localhost:8788/api/tools'), 'a /-rooted path is accepted')
  	assert.equal(fetchCount, before, 'the guard fired with no fetch')

  	// embeddedManifest is the compiled-in allTools (server field = CLI_BUILD).
  	assert.equal(embeddedManifest().tools.length, 15)

  	console.log('ok: manifest — on-miss fetch, on-hit no-refetch, --refresh, version-mismatch→embedded, offline→embedded, per-instance key, poisoned-path guard')
  } finally {
  	globalThis.fetch = realFetch
  }
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/render/manifest.test.ts)
  ```
  Expected: **fails** — `Cannot find module './manifest.ts'`.

### Step 2 — Write the module (GREEN)

- [ ] **`cli/src/render/manifest.ts`** (create it):
  ```ts
  /**
   * Manifest resolution (spec §6.3): a cache hit at
   * ~/.cache/ensembleworks/manifest-<key>.json whose format version matches is
   * USED AS-IS (never auto-refetched — charter). A miss / --refresh / version
   * mismatch tries GET <url>/api/tools and rewrites the cache. Offline or a
   * still-mismatched fetch falls back to the EMBEDDED SNAPSHOT — buildManifest
   * over the compiled-in allTools from @ensembleworks/contracts (static import;
   * compile-safe). The cache is data, not trust: http.toRequestUrl validates
   * every entry path same-origin at render time.
   */
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import {
  	allTools,
  	buildManifest,
  	MANIFEST_VERSION,
  	type ManifestEnvelope,
  } from '@ensembleworks/contracts'
  import { CLI_BUILD } from '../build.ts'
  import { authHeaders, type Conn } from '../resolve.ts'
  import { toRequestUrl } from '../http.ts'

  export interface ManifestSource {
  	envelope: ManifestEnvelope
  	source: 'cache' | 'network' | 'embedded'
  	/** The cache file backing this envelope, or '' for network/embedded — passed
  	 *  to http.request as the poisoned-cache hint when rendering a cached verb. */
  	cacheFile: string
  }

  export function cacheKey(url: string): string {
  	return url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  export function cachePath(url: string, env: NodeJS.ProcessEnv = process.env): string {
  	const cacheHome = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  	return path.join(cacheHome, 'ensembleworks', `manifest-${cacheKey(url)}.json`)
  }

  export function embeddedManifest(): ManifestEnvelope {
  	return buildManifest(allTools, CLI_BUILD)
  }

  export async function loadManifest(
  	conn: Conn,
  	opts: { refresh?: boolean; env?: NodeJS.ProcessEnv } = {},
  ): Promise<ManifestSource> {
  	const env = opts.env ?? process.env
  	const file = cachePath(conn.url, env)

  	if (!opts.refresh) {
  		const cached = readCache(file)
  		if (cached && cached.version === MANIFEST_VERSION) return { envelope: cached, source: 'cache', cacheFile: file }
  	}

  	try {
  		const fetched = await fetchManifest(conn)
  		if (fetched.version === MANIFEST_VERSION) {
  			writeCache(file, fetched)
  			return { envelope: fetched, source: 'network', cacheFile: '' }
  		}
  	} catch {
  		// offline / non-2xx → fall through to the embedded snapshot
  	}

  	return { envelope: embeddedManifest(), source: 'embedded', cacheFile: '' }
  }

  function readCache(file: string): ManifestEnvelope | null {
  	try {
  		const parsed = JSON.parse(readFileSync(file, 'utf8')) as ManifestEnvelope
  		if (parsed && typeof parsed.version === 'number' && Array.isArray(parsed.tools)) return parsed
  	} catch {
  		// miss / unreadable / malformed → treat as no cache
  	}
  	return null
  }

  function writeCache(file: string, envelope: ManifestEnvelope): void {
  	mkdirSync(path.dirname(file), { recursive: true })
  	writeFileSync(file, JSON.stringify(envelope))
  }

  async function fetchManifest(conn: Conn): Promise<ManifestEnvelope> {
  	const url = toRequestUrl(conn.url, '/api/tools')
  	const res = await fetch(url, { headers: authHeaders(conn.auth) })
  	if (!res.ok) throw new Error(`GET /api/tools → ${res.status}`)
  	return (await res.json()) as ManifestEnvelope
  }
  ```

### Step 3 — GREEN gate + commit

- [ ] **Run + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/render/manifest.test.ts)
  bun run typecheck
  ```
  Expected: prints `ok: manifest — on-miss fetch, on-hit no-refetch, --refresh,
  version-mismatch→embedded, offline→embedded, per-instance key, poisoned-path
  guard`; typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/render/manifest.ts cli/src/render/manifest.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): manifest cache + embedded-snapshot fallback (slice #4)

  render/manifest.ts: per-instance cache at ~/.cache/ensembleworks/manifest-<key>
  .json; a version-matched hit is used as-is (never auto-refetched); a miss /
  --refresh / version mismatch fetches GET /api/tools and rewrites; offline or a
  still-mismatched fetch falls back to the compiled-in allTools snapshot
  (buildManifest, static import — compile-safe). A network-free suite pins every
  branch plus the poisoned-path guard firing before any fetch.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — The generic renderer arg model: `args.ts` + `validate.ts` (TDD: RED → GREEN)

The heart of the renderer (spec §6.2 + §7.2): argv → typed request, with the
positional-slot rule reconciled (see the Environment note), flags/`@file`/JSON
spread, `room` injection, method-decides-location, and the
validate-structure-block / validate-values-warn (D4) posture. Two suites drive it.

### Step 1 — Write the two failing suites (RED)

- [ ] **`cli/src/render/args.test.ts`** (create it — network-free, builds
  `ManifestEntry` values by hand from the real tool defs via `allTools`):
  ```ts
  // argv → request (§6.2): positional primary args in the reconciled required-
  // first-then-optional slot order (sticky "hi"; terminal status a working;
  // scribe say <identity> <text> with text at slot 1 skipping optional `name`;
  // roadmap read <name> with OPTIONAL name at slot 0); the scalar-slot rule
  // (roadmap.write's required `ops` array claims no slot); JSON-body spread
  // (shape, roadmap write); kebab→camel flags; @file loader; room injection;
  // GET→query vs POST→body. Run with: bun src/render/args.test.ts
  import assert from 'node:assert/strict'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { allTools, type ManifestEntry, toManifestEntry } from '@ensembleworks/contracts'
  import type { Conn } from '../resolve.ts'
  import { buildRequest } from './args.ts'

  const entry = (plugin: string, id: string): ManifestEntry => {
  	const def = allTools.find((t) => t.plugin === plugin && t.id === id)
  	if (!def) throw new Error(`no such tool ${plugin}.${id}`)
  	return toManifestEntry(def)
  }
  const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }

  // sticky "hi" → text positional; room injected; POST→json.
  {
  	const req = buildRequest(entry('canvas', 'sticky'), ['hi'], conn)
  	assert.equal(req.method, 'POST')
  	assert.equal(req.path, '/api/canvas/sticky')
  	assert.deepEqual(req.json, { text: 'hi', room: 'team' })
  }

  // terminal status <session-id> <status> → both required scalars positional.
  {
  	const req = buildRequest(entry('terminal', 'status'), ['crew-a', 'working'], conn)
  	assert.deepEqual(req.json, { sessionId: 'crew-a', status: 'working', room: 'team' })
  }

  // scribe say <identity> <text> → required-first order puts text at slot 1,
  // SKIPPING the optional `name` declared between identity and text.
  {
  	const req = buildRequest(entry('scribe', 'say'), ['user-7', 'hello there'], conn)
  	assert.equal(req.json?.identity, 'user-7', 'slot 0 → identity')
  	assert.equal(req.json?.text, 'hello there', 'slot 1 → text, not the optional name')
  	assert.equal(req.json?.name, undefined, 'optional name is not positionally filled here')
  }

  // roadmap read <name> → OPTIONAL name reachable at slot 0; GET→query.
  {
  	const req = buildRequest(entry('roadmap', 'read'), ['Product Roadmap'], conn)
  	assert.equal(req.method, 'GET')
  	assert.deepEqual(req.query, { name: 'Product Roadmap', room: 'team' })
  }
  // roadmap read (no name) → list (only room).
  {
  	const req = buildRequest(entry('roadmap', 'read'), [], conn)
  	assert.deepEqual(req.query, { room: 'team' })
  }

  // roadmap write <name> --ops '<json>' → required `ops` array claims NO positional
  // slot: name is the only positional; --ops is a JSON-valued flag.
  {
  	const req = buildRequest(entry('roadmap', 'write'), ['My Roadmap', '--ops', '[{"op":"set","key":"O1","fields":{}}]'], conn)
  	assert.equal(req.json?.name, 'My Roadmap')
  	assert.deepEqual(req.json?.ops, [{ op: 'set', key: 'O1', fields: {} }])
  }

  // JSON-body spread: a lone JSON-object positional, no flags → spread as the body.
  {
  	const req = buildRequest(entry('canvas', 'shape'), ['{"type":"geo","text":"retry bug","x":100,"y":80}'], conn)
  	assert.deepEqual(req.json, { type: 'geo', text: 'retry bug', x: 100, y: 80, room: 'team' })
  }

  // kebab→camel: --if-rev → ifRev, --session-id → sessionId.
  {
  	const req = buildRequest(entry('roadmap', 'write'), ['R', '--ops', '[{"op":"set","key":"O1","fields":{}}]', '--if-rev', '4'], conn)
  	assert.equal(req.json?.ifRev, 4, '--if-rev coerced to number ifRev')
  }
  {
  	const req = buildRequest(entry('terminal', 'status'), ['--session-id', 's1', '--status', 'done'], conn)
  	assert.deepEqual(req.json, { sessionId: 's1', status: 'done', room: 'team' })
  }

  // --field @file loads a field from a file.
  {
  	const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-args-'))
  	const opsFile = path.join(dir, 'ops.json')
  	writeFileSync(opsFile, '[{"op":"replace","data":{"meta":{"title":"T"},"outcomes":[]}}]')
  	const req = buildRequest(entry('roadmap', 'write'), ['R', '--ops', `@${opsFile}`], conn)
  	assert.deepEqual((req.json?.ops as unknown[])[0], { op: 'replace', data: { meta: { title: 'T' }, outcomes: [] } })
  }

  // GET with query: kernel participants --page.
  {
  	const req = buildRequest(entry('kernel', 'participants'), ['--page', 'page:main'], conn)
  	assert.equal(req.method, 'GET')
  	assert.deepEqual(req.query, { page: 'page:main', room: 'team' })
  }

  console.log('ok: args — positional required-first order, scalar-slot rule, JSON spread, kebab→camel, @file, room inject, method→location')
  ```

- [ ] **`cli/src/render/validate.test.ts`** (create it — network-free; drives
  `buildRequest`, the observable D4 posture surface; captures stderr for warns):
  ```ts
  // D4 posture (§7.2): BLOCK (throw CliError exit 2) on unknown flag / missing
  // required / a value that cannot coerce to the schema type; WARN-and-send on
  // value constraints (enum / min / max). Run with: bun src/render/validate.test.ts
  import assert from 'node:assert/strict'
  import { allTools, type ManifestEntry, toManifestEntry } from '@ensembleworks/contracts'
  import { CliError } from '../errors.ts'
  import type { Conn } from '../resolve.ts'
  import { buildRequest } from './args.ts'

  const entry = (plugin: string, id: string): ManifestEntry =>
  	toManifestEntry(allTools.find((t) => t.plugin === plugin && t.id === id)!)
  const conn: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }
  const isBlock = (e: unknown) => e instanceof CliError && (e as CliError).exitCode === 2

  // BLOCK: unknown flag.
  assert.throws(() => buildRequest(entry('canvas', 'sticky'), ['hi', '--bogus', 'x'], conn), isBlock)

  // BLOCK: missing required (terminal status needs sessionId AND status).
  assert.throws(() => buildRequest(entry('terminal', 'status'), ['only-one'], conn), isBlock)

  // BLOCK: a non-numeric value for a number field (avPulse.rttMs is a number).
  assert.throws(() => buildRequest(entry('av', 'pulse'), ['--rtt-ms', 'not-a-number'], conn), isBlock)

  // WARN-and-send: an out-of-enum status is a value constraint — the request is
  // STILL built (server is the authority), and a warning is emitted to stderr.
  {
  	const captured: string[] = []
  	const realWrite = process.stderr.write.bind(process.stderr)
  	;(process.stderr as any).write = (s: string) => { captured.push(String(s)); return true }
  	let req: ReturnType<typeof buildRequest>
  	try {
  		req = buildRequest(entry('terminal', 'status'), ['s1', 'bogus-status'], conn)
  	} finally {
  		;(process.stderr as any).write = realWrite
  	}
  	assert.equal(req.json?.status, 'bogus-status', 'the request is still built with the value')
  	assert.ok(captured.some((l) => l.includes('warning') && l.includes('status')), 'a warning was emitted for the enum violation')
  }

  console.log('ok: validate — blocks unknown-flag/missing-required/bad-type, warns-and-sends on value constraints')
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/render/args.test.ts) ; (cd cli && bun src/render/validate.test.ts)
  ```
  Expected: both **fail** — `Cannot find module './args.ts'` / `'./validate.ts'`.

### Step 2 — Write `validate.ts` then `args.ts` (GREEN)

- [ ] **`cli/src/render/validate.ts`** (create it — schema helpers + the D4 posture):
  ```ts
  /**
   * JSON-Schema helpers shared with args.ts, and the D4 validation posture:
   * validate() BLOCKS on a missing required field or a value whose runtime type
   * does not match the schema type (structural — the request could not be
   * well-formed); it WARNS (still sends) on value-constraint failures
   * (enum/min/max/pattern) because the server handler is the authority and is
   * frequently looser than zodInput. Unknown-flag blocking happens earlier, in
   * args.parseArgv. See spec §7.2.
   */
  import { CliError } from '../errors.ts'
  import { narrate } from '../output.ts'

  export interface JsonSchema {
  	type?: string
  	properties?: Record<string, JsonSchemaProp>
  	required?: string[]
  }

  export interface JsonSchemaProp {
  	type?: string | string[]
  	anyOf?: Array<{ type?: string }>
  	enum?: unknown[]
  	description?: string
  	minLength?: number
  	maxLength?: number
  	minimum?: number
  	maximum?: number
  	pattern?: string
  }

  /** The primary scalar/complex type of a prop, tolerating unions and nullable. */
  export function propType(p: JsonSchemaProp | undefined): string | undefined {
  	if (!p) return undefined
  	if (typeof p.type === 'string') return p.type
  	if (Array.isArray(p.type)) return p.type.find((t) => t !== 'null')
  	if (Array.isArray(p.anyOf)) return p.anyOf.map((m) => m.type).find((t): t is string => typeof t === 'string')
  	return undefined
  }

  export function isScalar(p: JsonSchemaProp | undefined): boolean {
  	const t = propType(p)
  	return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean'
  }

  export function validate(schema: JsonSchema, body: Record<string, unknown>): void {
  	const props = schema.properties ?? {}
  	for (const key of schema.required ?? []) {
  		if (body[key] === undefined) throw new CliError(`missing required field: ${key}`, 2)
  	}
  	for (const [key, value] of Object.entries(body)) {
  		const p = props[key]
  		if (!p) continue // only known keys reach the body; unknown flags blocked in parseArgv
  		if (!typeMatches(p, value)) {
  			throw new CliError(`field ${key} must be ${propType(p) ?? 'the declared type'} (got ${JSON.stringify(value)})`, 2)
  		}
  		warnConstraints(key, p, value)
  	}
  }

  function typeMatches(p: JsonSchemaProp, value: unknown): boolean {
  	const t = propType(p)
  	if (!t) return true // untyped / complex union — let the server decide
  	switch (t) {
  		case 'string':
  			return typeof value === 'string'
  		case 'number':
  		case 'integer':
  			return typeof value === 'number' && Number.isFinite(value)
  		case 'boolean':
  			return typeof value === 'boolean'
  		case 'object':
  			return value !== null && typeof value === 'object' && !Array.isArray(value)
  		case 'array':
  			return Array.isArray(value)
  		default:
  			return true
  	}
  }

  function warnConstraints(key: string, p: JsonSchemaProp, value: unknown): void {
  	const warn = (why: string) => narrate(`warning: ${key} ${why} — sending anyway; server will validate`)
  	if (Array.isArray(p.enum) && !p.enum.includes(value)) warn(`not one of ${p.enum.join(' | ')}`)
  	if (typeof value === 'string') {
  		if (typeof p.minLength === 'number' && value.length < p.minLength) warn(`shorter than ${p.minLength}`)
  		if (typeof p.maxLength === 'number' && value.length > p.maxLength) warn(`longer than ${p.maxLength}`)
  		if (typeof p.pattern === 'string' && !new RegExp(p.pattern).test(value)) warn(`does not match /${p.pattern}/`)
  	}
  	if (typeof value === 'number') {
  		if (typeof p.minimum === 'number' && value < p.minimum) warn(`below ${p.minimum}`)
  		if (typeof p.maximum === 'number' && value > p.maximum) warn(`above ${p.maximum}`)
  	}
  }
  ```

- [ ] **`cli/src/render/args.ts`** (create it — the §6.2 arg model):
  ```ts
  /**
   * argv → typed request (spec §6.2). One ManifestEntry → one subcommand:
   *   - Flags: every property is --<kebab> (camelCase also accepted); booleans
   *     bare; object/array props take a JSON string or --<field> @file.
   *   - Positionals: required non-room scalars first (declaration order), then
   *     optional non-room scalars (the reconciliation that makes `scribe say
   *     <identity> <text>` and `roadmap read <name>` both work — see the plan's
   *     positional-slot note). An array/object required field (roadmap.write.ops)
   *     never takes a slot.
   *   - Raw-body spread: a lone JSON-object positional with no flags is spread as
   *     the body (carries `canvas shape '<json>'`, `roadmap write '<json>'`).
   *   - room is injected from the resolved connection unless the body set it.
   *   - Method fixes location: GET/DELETE → query, POST/PUT → json.
   */
  import { readFileSync } from 'node:fs'
  import type { ManifestEntry } from '@ensembleworks/contracts'
  import { CliError } from '../errors.ts'
  import type { Conn } from '../resolve.ts'
  import { isScalar, type JsonSchema, type JsonSchemaProp, propType, validate } from './validate.ts'

  export interface Req {
  	method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  	path: string
  	query?: Record<string, unknown>
  	json?: Record<string, unknown>
  }

  function kebabToCamel(s: string): string {
  	return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  }

  function isJsonObject(s: string): boolean {
  	const t = s.trim()
  	if (!t.startsWith('{')) return false
  	try {
  		const v = JSON.parse(t)
  		return v !== null && typeof v === 'object' && !Array.isArray(v)
  	} catch {
  		return false
  	}
  }

  /** Reconciled positional order: required scalars first, then optional scalars,
   *  each in declaration order; `room` never takes a slot. */
  function positionalSlots(schema: JsonSchema): string[] {
  	const props = schema.properties ?? {}
  	const required = new Set(schema.required ?? [])
  	const scalars = Object.keys(props).filter((k) => k !== 'room' && isScalar(props[k]))
  	return [...scalars.filter((k) => required.has(k)), ...scalars.filter((k) => !required.has(k))]
  }

  interface Parsed {
  	positionals: string[]
  	flags: Record<string, string>
  }

  function parseArgv(argv: string[], props: Record<string, JsonSchemaProp>): Parsed {
  	// Accept both kebab and camel spellings; map each to the canonical prop key.
  	const byFlag = new Map<string, string>()
  	for (const key of Object.keys(props)) {
  		byFlag.set(key, key)
  		byFlag.set(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), key)
  	}
  	const positionals: string[] = []
  	const flags: Record<string, string> = {}
  	for (let i = 0; i < argv.length; i++) {
  		const tok = argv[i] as string
  		if (tok.startsWith('--')) {
  			const raw = tok.slice(2)
  			const key = byFlag.get(raw) ?? byFlag.get(kebabToCamel(raw))
  			if (!key) throw new CliError(`unknown flag: --${raw}`, 2)
  			if (propType(props[key]) === 'boolean') {
  				flags[key] = 'true'
  				continue
  			}
  			const next = argv[i + 1]
  			if (next === undefined) throw new CliError(`--${raw} requires a value`, 2)
  			flags[key] = next.startsWith('@') ? readFileSync(next.slice(1), 'utf8') : next
  			i++
  		} else {
  			positionals.push(tok)
  		}
  	}
  	return { positionals, flags }
  }

  function coerce(p: JsonSchemaProp | undefined, raw: string): unknown {
  	const t = propType(p)
  	if (t === 'boolean') return raw === 'false' ? false : true
  	if (t === 'number' || t === 'integer') {
  		const n = Number(raw)
  		return Number.isNaN(n) ? raw : n // NaN-as-raw lets validate() block on the type mismatch
  	}
  	if (t === 'object' || t === 'array') {
  		try {
  			return JSON.parse(raw)
  		} catch {
  			return raw // a non-JSON string lets validate() block on the type mismatch
  		}
  	}
  	return raw
  }

  export function buildRequest(entry: ManifestEntry, argv: string[], conn: Conn): Req {
  	const schema = (entry.input ?? {}) as JsonSchema
  	const props = schema.properties ?? {}
  	const slots = positionalSlots(schema)
  	const { positionals, flags } = parseArgv(argv, props)

  	let body: Record<string, unknown>
  	if (positionals.length === 1 && Object.keys(flags).length === 0 && isJsonObject(positionals[0] as string)) {
  		body = JSON.parse(positionals[0] as string) as Record<string, unknown>
  	} else {
  		if (positionals.length > slots.length) {
  			throw new CliError(`too many positional arguments for ${entry.plugin} ${entry.id}`, 2)
  		}
  		body = {}
  		slots.forEach((k, i) => {
  			const v = positionals[i]
  			if (v !== undefined) body[k] = coerce(props[k], v)
  		})
  		for (const [k, v] of Object.entries(flags)) body[k] = coerce(props[k], v)
  	}

  	if ('room' in props && body.room === undefined) body.room = conn.room

  	validate(schema, body)

  	return entry.method === 'GET' || entry.method === 'DELETE'
  		? { method: entry.method, path: entry.path, query: body }
  		: { method: entry.method, path: entry.path, json: body }
  }
  ```

### Step 3 — GREEN gate + commit

- [ ] **Run both + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/render/args.test.ts)
  (cd cli && bun src/render/validate.test.ts)
  bun run typecheck
  ```
  Expected: `args.test.ts` prints
  `ok: args — positional required-first order, scalar-slot rule, JSON spread, kebab→camel, @file, room inject, method→location`;
  `validate.test.ts` prints
  `ok: validate — blocks unknown-flag/missing-required/bad-type, warns-and-sends on value constraints`;
  typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/render/args.ts cli/src/render/validate.ts \
    cli/src/render/args.test.ts cli/src/render/validate.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): generic renderer arg model + D4 validation posture (slice #4)

  render/args.ts: argv→typed request — positional slots in the reconciled
  required-first-then-optional scalar order (so `scribe say <identity> <text>`
  puts text at slot 1 and `roadmap read <name>` reaches the optional name at slot
  0, while roadmap.write's required `ops` array claims no slot); kebab→camel flags;
  --field @file; JSON-body spread; room injection; method fixes query-vs-body.
  render/validate.ts: blocks on unknown-flag/missing-required/bad-type, warns and
  still sends on value constraints (server is the authority). Two suites pin both.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — Renderer run + dispatch + main + native commands + Layer-2 extension

Wire the pieces into a runnable program: `render/run.ts` (verb → request → HTTP →
output), the `auth` group (`login`/`status`/`logout`), the `version` and `tools`
native commands, `canvas pull-images`, the three-layer `dispatch.ts` (with the
trusted-dir extension exec), and `main.ts` (global-flag extraction + error
mapping). `terminal connect`'s slot is a stub here (`import` placeholder) and
becomes real in Task 6.

**Coverage note:** no new unit suite — this task's behaviour (auth login/whoami,
sticky/frames/frame round-trip, roadmap write/read, tools cache, version, the
409/stdout discipline) is pinned end-to-end by `cli-api.test.ts` in Task 8. It
gates on `typecheck` + all five prior suites staying green.

- [ ] **`cli/src/render/run.ts`** (create it):
  ```ts
  /** Render one manifest verb: build the request, call it, print the server
   *  response verbatim to stdout (data-verb contract). A non-2xx body still prints
   *  to stdout (roadmap 409 carries the current rev) and the exit code is 1. */
  import type { ManifestEntry } from '@ensembleworks/contracts'
  import { request } from '../http.ts'
  import { emitData, emitLine } from '../output.ts'
  import type { Conn } from '../resolve.ts'
  import { buildRequest } from './args.ts'
  import type { JsonSchema, JsonSchemaProp } from './validate.ts'

  export async function runVerb(entry: ManifestEntry, argv: string[], conn: Conn, cacheHint = ''): Promise<number> {
  	const req = buildRequest(entry, argv, conn)
  	const res = await request(conn, req, cacheHint)
  	emitData(res.body)
  	return res.status >= 200 && res.status < 300 ? 0 : 1
  }

  /** Verb help (`ensembleworks <plugin> <id> --help`) — the requested content, so
   *  it goes to stdout. Lists each non-room field as its --kebab flag. */
  export function renderVerbHelp(entry: ManifestEntry): void {
  	const schema = (entry.input ?? {}) as JsonSchema
  	const props = schema.properties ?? {}
  	const required = new Set(schema.required ?? [])
  	emitLine(`ensembleworks ${entry.plugin} ${entry.id} — ${entry.help}`)
  	emitLine(`  ${entry.method} ${entry.path}`)
  	for (const [k, p] of Object.entries(props)) {
  		if (k === 'room') continue
  		const flag = `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`
  		const req = required.has(k) ? ' (required)' : ''
  		const desc = descriptionOf(p)
  		emitLine(`  ${flag}${req}${desc ? ` — ${desc}` : ''}`)
  	}
  }

  function descriptionOf(p: JsonSchemaProp): string {
  	return typeof p.description === 'string' ? p.description : ''
  }
  ```

- [ ] **`cli/src/auth/login.ts`** (create it):
  ```ts
  /**
   * `auth login` (spec §8.1): acquire url → method → (for service-token) the CF
   * dashboard token pair → verify via GET /api/whoami (expect a non-null identity)
   * → default room → store the [instances."<url>"] record 0600 and set it as
   * default_instance. Flags make it fully scriptable for CI; missing values are
   * prompted (secret without echo). credentialAcquire isolates the paste path so
   * a future --mint flow (charter seam) slots in without touching verify/store.
   */
  import type { Whoami } from '@ensembleworks/contracts'
  import { CliError } from '../errors.ts'
  import { hostsPath, type InstanceRecord, loadHosts, saveHosts, setInstance } from '../hosts.ts'
  import { toRequestUrl } from '../http.ts'
  import { narrate } from '../output.ts'
  import { ask, askSecret } from './prompt.ts'
  import { type Auth, authHeaders } from '../resolve.ts'

  export interface LoginFlags {
  	url?: string
  	room?: string
  	method?: 'service-token' | 'none'
  	tokenId?: string
  	tokenSecret?: string
  }

  export async function login(flags: LoginFlags, env: NodeJS.ProcessEnv): Promise<number> {
  	const url = flags.url ?? (await ask('instance url: '))
  	if (!url) throw new CliError('auth login requires a url (--url or the prompt)', 2)
  	const method = (flags.method ?? (await ask('method [service-token/none] (none): ', 'none'))) as 'service-token' | 'none'

  	const auth = await credentialAcquire(method, flags)
  	const who = await verifyWhoami(url, auth)
  	if (auth.method === 'service-token' && who.identity === null) {
  		narrate('warning: the token pair resolved to an anonymous identity — the pair may be wrong or the URL is a "none" instance')
  	}
  	narrate(`resolved identity: ${who.identity ?? '(anonymous)'} [${who.kind} via ${who.via}]`)

  	const defaultRoom = flags.room ?? (await ask('default room (team): ', 'team'))

  	const rec: InstanceRecord = { method, default_room: defaultRoom }
  	if (auth.method === 'service-token') {
  		rec.token_id = auth.tokenId
  		rec.token_secret = auth.tokenSecret
  	}
  	if (who.identity) rec.identity = who.identity

  	const file = hostsPath(env)
  	saveHosts(file, setInstance(loadHosts(file), url, rec))
  	narrate(`saved ${url} → ${file} (now the default instance)`)
  	return 0
  }

  async function credentialAcquire(method: 'service-token' | 'none', flags: LoginFlags): Promise<Auth> {
  	if (method !== 'service-token') return { method: 'none' }
  	const tokenId = flags.tokenId ?? (await ask('CF-Access-Client-Id: '))
  	const tokenSecret = flags.tokenSecret ?? (await askSecret('CF-Access-Client-Secret: '))
  	if (!tokenId || !tokenSecret) throw new CliError('service-token login needs both a token id and secret', 2)
  	return { method: 'service-token', tokenId, tokenSecret }
  }

  async function verifyWhoami(url: string, auth: Auth): Promise<Whoami> {
  	const target = toRequestUrl(url, '/api/whoami')
  	let res: Response
  	try {
  		res = await fetch(target, { headers: authHeaders(auth) })
  	} catch (err) {
  		throw new CliError(`could not reach ${target.origin}: ${(err as Error).message}`)
  	}
  	if (!res.ok) throw new CliError(`verify failed: GET /api/whoami → ${res.status}`)
  	return (await res.json()) as Whoami
  }
  ```

- [ ] **`cli/src/auth/prompt.ts`** (create it — stderr prompts, no-echo secret):
  ```ts
  /** Interactive prompts on stderr (stdout stays clean). askSecret reads without
   *  echo from a tty; on a non-tty (CI) it falls back to a plain line read. */
  import { createInterface } from 'node:readline'

  export async function ask(question: string, fallback = ''): Promise<string> {
  	const rl = createInterface({ input: process.stdin, output: process.stderr })
  	try {
  		const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
  		return answer.trim() || fallback
  	} finally {
  		rl.close()
  	}
  }

  export async function askSecret(question: string): Promise<string> {
  	const stdin = process.stdin
  	if (!stdin.isTTY) return ask(question)
  	process.stderr.write(question)
  	return new Promise<string>((resolve) => {
  		const chunks: string[] = []
  		const wasRaw = stdin.isRaw
  		stdin.setRawMode(true)
  		stdin.resume()
  		const onData = (buf: Buffer) => {
  			for (const ch of buf.toString('utf8')) {
  				if (ch === '\n' || ch === '\r' || ch === '\u0004') {
  					stdin.setRawMode(wasRaw)
  					stdin.pause()
  					stdin.removeListener('data', onData)
  					process.stderr.write('\n')
  					return resolve(chunks.join(''))
  				}
  				if (ch === '\u0003') process.exit(130) // Ctrl-C
  				else if (ch === '\u007f') chunks.pop() // backspace
  				else chunks.push(ch)
  			}
  		}
  		stdin.on('data', onData)
  	})
  }
  ```

- [ ] **`cli/src/auth/status.ts`** (create it):
  ```ts
  /** `auth status`: for the resolved instance (or every configured instance when
   *  no --url), GET /api/whoami and print a table (url · reachable · identity ·
   *  kind · via); --json emits the raw results array. */
  import type { Whoami } from '@ensembleworks/contracts'
  import { hostsPath, loadHosts } from '../hosts.ts'
  import { toRequestUrl } from '../http.ts'
  import { emitJson, emitTable } from '../output.ts'
  import { type Auth, authHeaders } from '../resolve.ts'

  export interface StatusFlags {
  	url?: string
  	json: boolean
  }

  interface Row {
  	url: string
  	reachable: boolean
  	whoami: Whoami | null
  }

  export async function status(flags: StatusFlags, env: NodeJS.ProcessEnv): Promise<number> {
  	const hosts = loadHosts(hostsPath(env))
  	const urls = flags.url ? [flags.url] : Object.keys(hosts.instances)
  	if (urls.length === 0) {
  		process.stderr.write('no instances configured — run `ensembleworks auth login`\n')
  		return 1
  	}
  	const rows: Row[] = []
  	for (const url of urls) {
  		const rec = hosts.instances[url]
  		const auth: Auth =
  			rec?.method === 'service-token' && rec.token_id && rec.token_secret
  				? { method: 'service-token', tokenId: rec.token_id, tokenSecret: rec.token_secret }
  				: { method: 'none' }
  		rows.push(await probe(url, auth))
  	}
  	if (flags.json) {
  		emitJson(rows.map((r) => ({ url: r.url, reachable: r.reachable, ...(r.whoami ?? {}) })))
  		return 0
  	}
  	emitTable(
  		['URL', 'REACHABLE', 'IDENTITY', 'KIND', 'VIA'],
  		rows.map((r) => [r.url, String(r.reachable), r.whoami?.identity ?? '—', r.whoami?.kind ?? '—', r.whoami?.via ?? '—']),
  	)
  	return rows.every((r) => r.reachable) ? 0 : 1
  }

  async function probe(url: string, auth: Auth): Promise<Row> {
  	try {
  		const res = await fetch(toRequestUrl(url, '/api/whoami'), { headers: authHeaders(auth) })
  		if (!res.ok) return { url, reachable: false, whoami: null }
  		return { url, reachable: true, whoami: (await res.json()) as Whoami }
  	} catch {
  		return { url, reachable: false, whoami: null }
  	}
  }
  ```

- [ ] **`cli/src/auth/logout.ts`** (create it):
  ```ts
  /** `auth logout --url <u>`: remove the [instances."<u>"] record; if it was
   *  default_instance, reassign to the first survivor or clear. Never touches
   *  other records. */
  import { CliError } from '../errors.ts'
  import { hostsPath, loadHosts, removeInstance, saveHosts } from '../hosts.ts'
  import { narrate } from '../output.ts'

  export async function logout(flags: { url?: string }, env: NodeJS.ProcessEnv): Promise<number> {
  	const url = flags.url
  	if (!url) throw new CliError('auth logout requires --url <instance>', 2)
  	const file = hostsPath(env)
  	const hosts = loadHosts(file)
  	if (!hosts.instances[url]) {
  		narrate(`no such instance: ${url}`)
  		return 1
  	}
  	const next = removeInstance(hosts, url)
  	saveHosts(file, next)
  	narrate(`removed ${url}${next.default_instance ? ` (default is now ${next.default_instance})` : ' (no default remains)'}`)
  	return 0
  }
  ```

- [ ] **`cli/src/native/version.ts`** (create it):
  ```ts
  /** `version`: the CLI build + the connected server's build string (from the
   *  manifest envelope's `.server`). --json emits { cli, server }. Never fails on
   *  a missing/unreachable instance — server falls back to a note. */
  import { CLI_BUILD } from '../build.ts'
  import { hostsPath, loadHosts } from '../hosts.ts'
  import { emitJson, emitLine } from '../output.ts'
  import { readEnv, resolveConn } from '../resolve.ts'
  import { loadManifest } from '../render/manifest.ts'

  export async function version(flags: { url?: string; room?: string; json: boolean }, env: NodeJS.ProcessEnv): Promise<number> {
  	let server = 'unknown (no reachable instance)'
  	try {
  		const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))
  		const { envelope } = await loadManifest(conn, { env })
  		server = envelope.server
  	} catch {
  		// leave the default note
  	}
  	if (flags.json) emitJson({ cli: CLI_BUILD, server })
  	else {
  		emitLine(`ensembleworks ${CLI_BUILD}`)
  		emitLine(`server ${server}`)
  	}
  	return 0
  }
  ```

- [ ] **`cli/src/native/tools.ts`** (create it):
  ```ts
  /** `tools` (list) / `tools refresh`. List reads the cache/embedded snapshot
   *  (no forced network) and prints a verb table or --json. refresh forces a
   *  GET /api/tools and rewrites the cache. */
  import { hostsPath, loadHosts } from '../hosts.ts'
  import { emitJson, emitTable, narrate } from '../output.ts'
  import { readEnv, resolveConn } from '../resolve.ts'
  import { embeddedManifest, loadManifest } from '../render/manifest.ts'

  export async function tools(args: string[], flags: { url?: string; room?: string; json: boolean }, env: NodeJS.ProcessEnv): Promise<number> {
  	const refresh = args[0] === 'refresh'
  	// list may run without a configured instance (embedded); refresh needs one.
  	let envelope
  	let source = 'embedded'
  	try {
  		const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))
  		const loaded = await loadManifest(conn, { env, refresh })
  		envelope = loaded.envelope
  		source = loaded.source
  	} catch (err) {
  		if (refresh) throw err // refresh genuinely needs a target
  		envelope = embeddedManifest()
  	}
  	if (refresh) {
  		narrate(`refreshed ${envelope.tools.length} tools from ${source === 'network' ? 'the server' : source}`)
  		return 0
  	}
  	if (flags.json) {
  		emitJson(envelope)
  		return 0
  	}
  	emitTable(
  		['COMMAND', 'METHOD', 'PATH', 'HELP'],
  		envelope.tools.map((t) => [`${t.plugin} ${t.id}`, t.method, t.path, t.help]),
  	)
  	return 0
  }
  ```

- [ ] **`cli/src/native/pull-images.ts`** (create it — ports `bin/canvas
  cmd_pull_images`: GET the frame, grep `/uploads/*`, download each, print one
  local path per line; `/dev/...` iframe urls are deliberately skipped):
  ```ts
  /** `canvas pull-images <frame> [dir]` (native composition, §6.4): GET the frame,
   *  download every /uploads/* asset to <dir> (a temp dir by default), print each
   *  local path one per line (its bin/canvas contract). /dev/... iframe urls are
   *  skipped — only stored uploads are downloadable. */
  import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { CliError } from '../errors.ts'
  import { hostsPath, loadHosts } from '../hosts.ts'
  import { request, toRequestUrl } from '../http.ts'
  import { emitData, emitLine, narrate } from '../output.ts'
  import { authHeaders, readEnv, resolveConn } from '../resolve.ts'

  export async function pullImages(args: string[], flags: { url?: string; room?: string }, env: NodeJS.ProcessEnv): Promise<number> {
  	const frame = args[0]
  	const dirArg = args[1]
  	if (!frame) throw new CliError('pull-images requires <frame> [dir]', 2)
  	const conn = resolveConn({ url: flags.url, room: flags.room }, readEnv(env), loadHosts(hostsPath(env)))

  	const res = await request(conn, { method: 'GET', path: '/api/canvas/frame', query: { room: conn.room, name: frame } })
  	if (res.status < 200 || res.status >= 300) {
  		emitData(res.body) // surface the server error body on stdout, exit non-zero
  		return 1
  	}

  	const dir = dirArg || mkdtempSync(path.join(os.tmpdir(), 'ew-frame-'))
  	mkdirSync(dir, { recursive: true })
  	const urls = [...res.body.matchAll(/"url":"(\/uploads\/[^"]+)"/g)].map((m) => m[1] as string)
  	if (urls.length === 0) {
  		narrate(`no images in frame ${frame}`)
  		return 0
  	}
  	for (const u of urls) {
  		const dest = path.join(dir, path.basename(u))
  		const dl = await fetch(toRequestUrl(conn.url, u), { headers: authHeaders(conn.auth) })
  		if (!dl.ok) {
  			narrate(`failed to download ${u}: ${dl.status}`)
  			continue
  		}
  		writeFileSync(dest, Buffer.from(await dl.arrayBuffer()))
  		emitLine(dest)
  	}
  	return 0
  }
  ```

- [ ] **`cli/src/native/connect.ts`** (create it — Task 6 fills the resolver +
  tests; this task ships a compiling stub so dispatch links):
  ```ts
  /** `terminal connect` — the native SLOT. Task 6 fills resolveConnectConfig and
   *  the --dry-run/notice behaviour; #5 fills the connector engine behind it. */
  import { CliError } from '../errors.ts'
  import type { Globals } from '../dispatch.ts'

  export async function connectSlot(_args: string[], _globals: Globals, _env: NodeJS.ProcessEnv): Promise<number> {
  	throw new CliError('terminal connect: not yet wired (filled in Task 6)', 1)
  }
  ```

- [ ] **`cli/src/dispatch.ts`** (create it — the three-layer router + globals):
  ```ts
  /**
   * Global-flag extraction + the three-layer dispatch (spec §6.1):
   *   1. native single-word groups: version, auth, tools, help
   *   2. native (group, verb) pairs: terminal connect, canvas pull-images
   *      (checked BEFORE the manifest so they win over like-named future verbs)
   *   3. manifest-rendered: <group> matches a plugin and <verb> a tool id
   *   4. extension (Layer 2): ensembleworks-<group> from the TRUSTED
   *      ~/.config/ensembleworks/extensions/ dir ONLY (never bare PATH — it
   *      inherits live credentials), exec'd with the resolved-connection env
   *   5. error: unknown group/verb → stderr + exit 2, with a did-you-mean.
   */
  import { realpathSync } from 'node:fs'
  import path from 'node:path'
  import { spawnSync } from 'node:child_process'
  import { login } from './auth/login.ts'
  import { logout } from './auth/logout.ts'
  import { status } from './auth/status.ts'
  import { CliError } from './errors.ts'
  import { hostsPath, loadHosts } from './hosts.ts'
  import { connectSlot } from './native/connect.ts'
  import { pullImages } from './native/pull-images.ts'
  import { tools } from './native/tools.ts'
  import { version } from './native/version.ts'
  import { emitLine, narrate } from './output.ts'
  import { type Conn, readEnv, resolveConn } from './resolve.ts'
  import { embeddedManifest, loadManifest } from './render/manifest.ts'
  import { renderVerbHelp, runVerb } from './render/run.ts'

  export interface Globals {
  	url?: string
  	room?: string
  	refresh: boolean
  	json: boolean
  	dryRun: boolean
  	help: boolean
  }

  export function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  	const g: Globals = { refresh: false, json: false, dryRun: false, help: false }
  	const rest: string[] = []
  	for (let i = 0; i < argv.length; i++) {
  		switch (argv[i]) {
  			case '--url':
  				g.url = argv[++i]
  				break
  			case '--room':
  				g.room = argv[++i]
  				break
  			case '--refresh':
  				g.refresh = true
  				break
  			case '--json':
  				g.json = true
  				break
  			case '--dry-run':
  				g.dryRun = true
  				break
  			case '-h':
  			case '--help':
  				g.help = true
  				break
  			default:
  				rest.push(argv[i] as string)
  		}
  	}
  	return { globals: g, rest }
  }

  export async function dispatch(rest: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
  	const group = rest[0]
  	const verb = rest[1]

  	// 1. Native single-word groups.
  	if (group === undefined || group === 'help') return printTopHelp()
  	if (group === 'version') return version({ url: globals.url, room: globals.room, json: globals.json }, env)
  	if (group === 'auth') return authGroup(rest.slice(1), globals, env)
  	if (group === 'tools') return tools(rest.slice(1), { url: globals.url, room: globals.room, json: globals.json }, env)

  	// 2. Native (group, verb) pairs — win over the manifest.
  	if (group === 'terminal' && verb === 'connect') return connectSlot(rest.slice(2), globals, env)
  	if (group === 'canvas' && verb === 'pull-images') return pullImages(rest.slice(2), { url: globals.url, room: globals.room }, env)

  	// Verb help works without a configured instance (embedded manifest).
  	if (globals.help) {
  		const e = embeddedManifest().tools.find((t) => t.plugin === group && t.id === verb)
  		if (e) {
  			renderVerbHelp(e)
  			return 0
  		}
  		return printTopHelp()
  	}

  	// 3. Manifest-rendered — needs a resolved connection (url/room/auth).
  	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
  	const { envelope, cacheFile } = await loadManifest(conn, { refresh: globals.refresh, env })
  	const entry = envelope.tools.find((t) => t.plugin === group && t.id === verb)
  	if (entry) return runVerb(entry, rest.slice(2), conn, cacheFile)

  	// 4. Extension (only when the group matches NO manifest plugin).
  	const groupVerbs = envelope.tools.filter((t) => t.plugin === group)
  	if (groupVerbs.length === 0) {
  		const code = tryExtension(group, rest.slice(1), conn, env)
  		if (code !== null) return code
  	}

  	// 5. Error with did-you-mean.
  	return unknownError(group, verb, envelope.tools, groupVerbs)
  }

  async function authGroup(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
  	const sub = args[0]
  	switch (sub) {
  		case 'login':
  			return login(parseLoginFlags(args.slice(1), globals), env)
  		case 'status':
  			return status({ url: globals.url, json: globals.json }, env)
  		case 'logout':
  			return logout({ url: globals.url }, env)
  		default:
  			throw new CliError(`unknown auth command: ${sub ?? '(none)'} (expected login | status | logout)`, 2)
  	}
  }

  function parseLoginFlags(args: string[], globals: Globals): import('./auth/login.ts').LoginFlags {
  	const flags: import('./auth/login.ts').LoginFlags = { url: globals.url, room: globals.room }
  	for (let i = 0; i < args.length; i++) {
  		switch (args[i]) {
  			case '--method':
  				flags.method = args[++i] as 'service-token' | 'none'
  				break
  			case '--token-id':
  				flags.tokenId = args[++i]
  				break
  			case '--token-secret':
  				flags.tokenSecret = args[++i]
  				break
  			default:
  				throw new CliError(`unknown auth login flag: ${args[i]}`, 2)
  		}
  	}
  	return flags
  }

  /** Layer 2: exec ensembleworks-<group> ONLY if it resolves inside the trusted
   *  extensions dir; hand it the resolved connection env (incl. live token pair).
   *  Returns the child exit code, or null when no such trusted extension exists. */
  function tryExtension(group: string, args: string[], conn: Conn, env: NodeJS.ProcessEnv): number | null {
  	const dir = path.join(path.dirname(hostsPath(env)), 'extensions')
  	const bin = path.join(dir, `ensembleworks-${group}`)
  	try {
  		realpathSync(bin) // must exist inside the trusted dir (symlinks followed)
  	} catch {
  		return null
  	}
  	const childEnv: NodeJS.ProcessEnv = {
  		...env,
  		ENSEMBLEWORKS_URL: conn.url,
  		ENSEMBLEWORKS_ROOM: conn.room,
  	}
  	if (conn.auth.method === 'service-token') {
  		childEnv.ENSEMBLEWORKS_TOKEN_ID = conn.auth.tokenId
  		childEnv.ENSEMBLEWORKS_TOKEN_SECRET = conn.auth.tokenSecret
  	}
  	const res = spawnSync(bin, args, { stdio: 'inherit', env: childEnv })
  	return res.status ?? 1
  }

  function unknownError(group: string, verb: string | undefined, all: { plugin: string; id: string }[], groupVerbs: { plugin: string; id: string }[]): number {
  	if (groupVerbs.length > 0) {
  		narrate(`ensembleworks: unknown verb '${verb ?? ''}' in group '${group}' — try: ${groupVerbs.map((t) => `${t.plugin} ${t.id}`).join(', ')}`)
  	} else {
  		const groups = [...new Set(all.map((t) => t.plugin))].sort()
  		narrate(`ensembleworks: unknown command '${group}${verb ? ` ${verb}` : ''}' — groups: ${groups.join(', ')}, auth, tools, version`)
  	}
  	return 2
  }

  function printTopHelp(): number {
  	emitLine('ensembleworks <group> <verb> [args] — a generic renderer of GET /api/tools')
  	emitLine('')
  	emitLine('native: auth login|status|logout · tools [refresh] · version · terminal connect · canvas pull-images')
  	emitLine('rendered: any verb from `ensembleworks tools` (canvas/roadmap/scribe/terminal/av/kernel)')
  	emitLine('global flags: --url --room --refresh --json --dry-run -h/--help')
  	return 0
  }
  ```

- [ ] **`cli/src/main.ts`** (create it — the entry):
  ```ts
  /** Entry: strip global flags, dispatch, map CliError → stderr + its exit code
   *  (any other error → exit 1). All narration/errors on stderr; stdout stays
   *  clean (spec §7.1). */
  import { dispatch, extractGlobals } from './dispatch.ts'
  import { CliError } from './errors.ts'

  export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  	const { globals, rest } = extractGlobals(argv)
  	try {
  		return await dispatch(rest, globals, env)
  	} catch (err) {
  		if (err instanceof CliError) {
  			process.stderr.write(`ensembleworks: ${err.message}\n`)
  			return err.exitCode
  		}
  		process.stderr.write(`ensembleworks: ${(err as Error).message}\n`)
  		return 1
  	}
  }

  if (import.meta.main) {
  	main(process.argv.slice(2), process.env).then((code) => process.exit(code))
  }
  ```

- [ ] **GREEN gate + commit:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd cli && bun src/hosts.test.ts && bun src/resolve.test.ts && bun src/render/manifest.test.ts && bun src/render/args.test.ts && bun src/render/validate.test.ts)
  # smoke: top help renders (no instance needed), exit 0
  (cd cli && bun src/main.ts --help)
  ```
  Expected: typecheck 0; all five prior suites still print their `ok:` lines;
  `bun src/main.ts --help` prints the top-help block to stdout and exits 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/render/run.ts cli/src/auth/login.ts cli/src/auth/prompt.ts \
    cli/src/auth/status.ts cli/src/auth/logout.ts cli/src/native/version.ts \
    cli/src/native/tools.ts cli/src/native/pull-images.ts cli/src/native/connect.ts \
    cli/src/dispatch.ts cli/src/main.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): renderer run + three-layer dispatch + native commands (auth/tools/version/pull-images) (slice #4)

  render/run.ts renders a manifest verb (verbatim stdout, 409-body-then-exit-1);
  dispatch.ts routes native → manifest → trusted-dir extension → error, extracting
  global flags and exec'ing ensembleworks-<group> only from
  ~/.config/ensembleworks/extensions/ with the resolved-connection env (live
  creds). auth login/status/logout (paste-from-CF, verify via /api/whoami, 0600
  store), tools list/refresh, version, canvas pull-images. terminal connect is a
  compiling stub (filled in Task 6). Behaviour pinned e2e by Task 8.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — The `terminal connect` slot + `--dry-run` (TDD: RED → GREEN)

Fill the connect slot (spec §10): full flag parsing, connection resolution
through the §5 chain, a stable per-box gateway-id default (not bare hostname),
`--dry-run` printing the resolved config, and the "#5 notice" for the real run.

### Step 1 — Write the failing suite (RED)

- [ ] **`cli/src/native/connect.test.ts`** (create it — network-free; builds a
  `Conn` directly and uses a temp config dir; no `createSyncApp`, no fetch):
  ```ts
  // terminal connect slot (§10): resolveConnectConfig builds the ws url + defaults
  // (gateway-id = a stable per-box id, NOT bare hostname; label = hostname); the
  // slot prints the config on --dry-run (exit 0) and the #5 notice otherwise
  // (exit non-zero). Network-free. Run with: bun src/native/connect.test.ts
  import assert from 'node:assert/strict'
  import { hostname } from 'node:os'
  import type { Conn } from '../resolve.ts'
  import { connectSlot, resolveConnectConfig } from './connect.ts'

  const conn: Conn = {
  	url: 'https://canvas.example.com',
  	room: 'team',
  	auth: { method: 'service-token', tokenId: 'i', tokenSecret: 's' },
  }

  // Config resolution + defaults.
  {
  	const cfg = resolveConnectConfig(conn, {}, process.env)
  	assert.equal(cfg.url, 'https://canvas.example.com')
  	assert.equal(cfg.room, 'team')
  	assert.equal(cfg.authMethod, 'service-token')
  	assert.equal(cfg.label, hostname(), 'label defaults to hostname')
  	assert.ok(cfg.gatewayId.startsWith(`${hostname()}-`), 'gateway-id is hostname + a stable per-box suffix')
  	assert.notEqual(cfg.gatewayId, hostname(), 'gateway-id is NOT the bare hostname (would collide, tripping resolveGatewayOwner)')
  	assert.ok(cfg.wsUrl.startsWith('wss://canvas.example.com/api/terminal/connect?'), 'wss ws url on the connect route')
  	assert.ok(cfg.wsUrl.includes(`gatewayId=${encodeURIComponent(cfg.gatewayId)}`))
  	assert.ok(cfg.wsUrl.includes(`label=${encodeURIComponent(cfg.label)}`))
  }

  // Explicit flags win.
  {
  	const cfg = resolveConnectConfig(conn, { label: 'my-box', gatewayId: 'fixed-id' }, process.env)
  	assert.equal(cfg.label, 'my-box')
  	assert.equal(cfg.gatewayId, 'fixed-id')
  }

  // http url → ws (not wss) for a none/localhost instance.
  {
  	const local: Conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'none' } }
  	const cfg = resolveConnectConfig(local, {}, process.env)
  	assert.ok(cfg.wsUrl.startsWith('ws://localhost:8788/api/terminal/connect?'))
  }

  // Slot behaviour: --dry-run prints JSON to stdout (exit 0); plain run → #5 notice, non-zero.
  {
  	const env = { ...process.env, ENSEMBLEWORKS_URL: 'http://localhost:8788' } as NodeJS.ProcessEnv
  	const outChunks: string[] = []
  	const realOut = process.stdout.write.bind(process.stdout)
  	;(process.stdout as any).write = (s: string) => { outChunks.push(String(s)); return true }
  	let dryCode: number
  	try {
  		dryCode = await connectSlot([], { refresh: false, json: false, dryRun: true, help: false }, env)
  	} finally {
  		;(process.stdout as any).write = realOut
  	}
  	assert.equal(dryCode, 0, '--dry-run exits 0')
  	const printed = JSON.parse(outChunks.join(''))
  	assert.equal(printed.url, 'http://localhost:8788')
  	assert.ok(printed.wsUrl.startsWith('ws://localhost:8788/api/terminal/connect?'))

  	const errChunks: string[] = []
  	const realErr = process.stderr.write.bind(process.stderr)
  	;(process.stderr as any).write = (s: string) => { errChunks.push(String(s)); return true }
  	let realCode: number
  	try {
  		realCode = await connectSlot([], { refresh: false, json: false, dryRun: false, help: false }, env)
  	} finally {
  		;(process.stderr as any).write = realErr
  	}
  	assert.notEqual(realCode, 0, 'a plain connect exits non-zero in #4')
  	assert.ok(errChunks.join('').includes('sub-project #5'), 'the #5 notice is printed to stderr')
  }

  console.log('ok: connect — ws url + stable-gateway-id/hostname defaults, flags win, --dry-run config, #5 notice')
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/native/connect.test.ts)
  ```
  Expected: **fails** — `resolveConnectConfig` is not exported (the Task-5 stub
  only exports `connectSlot`, which throws).

### Step 2 — Replace the stub (GREEN)

- [ ] **`cli/src/native/connect.ts`** (replace the whole file):
  ```ts
  /**
   * `terminal connect` — the native SLOT (spec §10). #4 delivers full flag
   * parsing, connection resolution (§5), a stable per-box gateway-id default (NOT
   * bare hostname — collisions would trip the server's resolveGatewayOwner
   * binding), and --dry-run (prints the config the connector WOULD use, exit 0).
   * A plain run prints a "#5" notice and exits non-zero. #5 fills the engine
   * behind resolveConnectConfig — this resolved object is its exact input, so #5
   * changes no dispatch or flag code.
   */
  import { randomBytes } from 'node:crypto'
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
  import { hostname } from 'node:os'
  import path from 'node:path'
  import type { Globals } from '../dispatch.ts'
  import { CliError } from '../errors.ts'
  import { hostsPath, loadHosts } from '../hosts.ts'
  import { emitJson, narrate } from '../output.ts'
  import { type Conn, readEnv, resolveConn } from '../resolve.ts'

  export interface ConnectConfig {
  	url: string
  	wsUrl: string
  	room: string
  	gatewayId: string
  	label: string
  	authMethod: 'service-token' | 'none'
  }

  export function resolveConnectConfig(conn: Conn, flags: { label?: string; gatewayId?: string }, env: NodeJS.ProcessEnv): ConnectConfig {
  	const label = flags.label ?? hostname()
  	const gatewayId = flags.gatewayId ?? stableGatewayId(env)
  	const wsBase = conn.url.replace(/^http/, 'ws') // http→ws, https→wss
  	const ws = new URL('/api/terminal/connect', wsBase.endsWith('/') ? wsBase : `${wsBase}/`)
  	ws.searchParams.set('gatewayId', gatewayId)
  	ws.searchParams.set('label', label)
  	return { url: conn.url, wsUrl: ws.toString(), room: conn.room, gatewayId, label, authMethod: conn.auth.method }
  }

  export async function connectSlot(args: string[], globals: Globals, env: NodeJS.ProcessEnv): Promise<number> {
  	const flags = parseConnectFlags(args)
  	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
  	const cfg = resolveConnectConfig(conn, flags, env)
  	if (globals.dryRun) {
  		emitJson(cfg)
  		return 0
  	}
  	narrate('terminal connect: the connector engine ships in sub-project #5')
  	return 1
  }

  function parseConnectFlags(args: string[]): { label?: string; gatewayId?: string } {
  	const flags: { label?: string; gatewayId?: string } = {}
  	for (let i = 0; i < args.length; i++) {
  		switch (args[i]) {
  			case '--label':
  				flags.label = args[++i]
  				break
  			case '--gateway-id':
  				flags.gatewayId = args[++i]
  				break
  			default:
  				throw new CliError(`unknown terminal connect flag: ${args[i]}`, 2)
  		}
  	}
  	return flags
  }

  /** A stable per-box gateway id: hostname + the OS machine-id (or a persisted
   *  random suffix). Two boxes sharing a hostname get distinct ids, so the
   *  server's gateway-owner identity binding never collides (charter #5). */
  function stableGatewayId(env: NodeJS.ProcessEnv): string {
  	const host = hostname()
  	const machine = readMachineId()
  	if (machine) return `${host}-${machine.slice(0, 12)}`
  	const idFile = path.join(path.dirname(hostsPath(env)), 'gateway-id')
  	try {
  		const existing = readFileSync(idFile, 'utf8').trim()
  		if (existing) return `${host}-${existing}`
  	} catch {
  		// fall through to mint one
  	}
  	const suffix = randomBytes(6).toString('hex')
  	try {
  		mkdirSync(path.dirname(idFile), { recursive: true })
  		writeFileSync(idFile, suffix)
  	} catch {
  		// best-effort persistence; the id is still stable within this process
  	}
  	return `${host}-${suffix}`
  }

  function readMachineId(): string | null {
  	for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
  		try {
  			const v = readFileSync(f, 'utf8').trim()
  			if (v) return v
  		} catch {
  			// try the next candidate
  		}
  	}
  	return null
  }
  ```

### Step 3 — GREEN gate + commit

- [ ] **Run + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/native/connect.test.ts)
  bun run typecheck
  ```
  Expected: prints `ok: connect — ws url + stable-gateway-id/hostname defaults,
  flags win, --dry-run config, #5 notice`; typecheck 0.

- [ ] **Commit:**
  ```bash
  git add cli/src/native/connect.ts cli/src/native/connect.test.ts
  git commit -m "$(cat <<'EOF'
  feat(cli): the terminal connect slot with --dry-run resolution (slice #4)

  native/connect.ts: full flag parsing (--label, --gateway-id), connection
  resolution through the §5 chain, a stable per-box gateway-id default
  (hostname + machine-id / persisted suffix, never bare hostname) and label
  default (hostname). --dry-run prints the resolved wss/ws config the connector
  would use (exit 0); a plain run prints the "ships in sub-project #5" notice and
  exits non-zero. The engine is #5's single-function fill behind this slot.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 7 — `bin/ensembleworks` + `bin/ew` wrappers + the four SKILL.md reseeds

Make `ensembleworks` real on the devcontainer PATH and move the agent surface off
`canvas …`. `bin/canvas` stays untouched (deleted at the #8 cutover, §9.4).

**Coverage note:** no new suite. The bin wrappers are bash (no TS impact); the
reseed is verified by the manual smoke in Task 8. Gate: `bash -n` + `typecheck`.

### Step 1 — Dev wrappers

- [ ] **`bin/ensembleworks`** (create it, then `chmod +x`):
  ```bash
  #!/usr/bin/env bash
  exec bun "$(dirname "$0")/../cli/src/main.ts" "$@"
  ```

- [ ] **`bin/ew`** — a hardlink to it, so `ew` runs the same program:
  ```bash
  chmod +x bin/ensembleworks
  ln -f bin/ensembleworks bin/ew
  ```
  (`bin/` is already on the agents' PATH — `bin/canvas` lives there — so the
  reseeded skills resolve `ensembleworks`/`ew` immediately in the devcontainer.)

### Step 2 — Reseed `.claude/skills/canvas/SKILL.md`

- [ ] **Overwrite `.claude/skills/canvas/SKILL.md`** with (note `ew` mentioned
  once, the env-var rename, `read`→`frame`, `status`→`terminal status`, explicit
  `--color light-blue`, and `roadmap read|write --ops`):
  ````markdown
  ---
  name: canvas
  description: Read and write the shared EnsembleWorks from a canvas terminal — see the stickies, text and images teammates have placed in a frame, then post a status light and a summary sticky back. Use whenever you are working in a canvas terminal and want to take instructions from, or report progress to, the humans watching the canvas.
  ---

  # Skill: Canvas

  You are running in a terminal that lives **on a shared multiplayer canvas**. The
  humans on the canvas drop stickies, notes and reference images into named
  frames; you can both **read** those and **write** back. Close the loop — don't
  work blind, and don't finish silently.

  The `ensembleworks` CLI (`ew` for short, usually on `PATH`) is your whole
  interface. It talks to the sync server over HTTP, so it works whether or not a
  browser is open. Two env vars target it: `ENSEMBLEWORKS_URL` (default
  `http://localhost:8788`) and `ENSEMBLEWORKS_ROOM` (default `team`).

  Your terminal's **session id is shown in its title bar** (`tmux: canvas-<id>`)
  and, in a seeded session, it equals your **crew name** (e.g. `crew-a`). Your
  crew has its own frames: a *drafting table* (your instructions) and an *advice*
  frame (where your summaries go).

  ## Reading the canvas

  ```bash
  ensembleworks canvas frames                 # discover: every frame + child counts (JSON)
  ensembleworks canvas frame <frame>          # one frame's stickies, text, images, embeds (JSON)
  ensembleworks canvas pull-images <frame> [dir]   # download the frame's images; prints local paths
  ```

  `<frame>` matches the first frame whose name *contains* it, case-insensitively
  (`drafting` matches `Drafting — crew-a`). `canvas frame` returns plain text
  recovered from each sticky, plus `/uploads/...` urls for images. To actually
  **see** an image, run `pull-images` and then open the printed path with your
  file-reading tool — you read images natively.

  **Proximity ordering.** When a teammate has a canvas tab open, `canvas frame`
  and `canvas frames` return results **nearest-their-cursor-first**, each item
  tagged with a `dist` (page units), and a top-level `sortedBy: { userName,
  cursor }`. So the sticky a human is hovering over is `notes[0]` — that's usually
  the one they want you to look at *right now*. When nobody is connected,
  `sortedBy` is `null` and you get plain document order. Mention the `sortedBy`
  user when you act on the top item ("picking up the note David's cursor is on").

  ## Writing to the canvas

  ```bash
  ensembleworks terminal status <session-id> <working|needs-you|done|idle>   # light on your terminal
  ensembleworks canvas sticky <text> --frame <name> --author <crew> --color light-blue
  ```

  `--author` tags the note `🤖 <crew>: …` (the server stamps the badge). Pass
  `--color light-blue` explicitly so humans can tell your stickies from their own
  at a glance — always pass both.

  ## Roadmap

  A room can hold named roadmap controls — zoned outcome boards (Done / Now /
  Next / Later) that humans re-prioritise by dragging and clicking status
  glyphs, and agents populate and read back:

  - `ensembleworks roadmap read` — the room's roadmaps (id, name, rev, updated).
  - `ensembleworks roadmap read <name>` — full document + `rev`. Fuzzy name
    match, exact id first. Read before you regenerate: human drags and status
    clicks live here and nowhere else.
  - `ensembleworks roadmap write <name> --ops '<ops-json>' [--if-rev <rev>]` —
    apply an op batch. To **wholesale-replace** a doc, wrap it in a replace op:
    `ensembleworks roadmap write <name> --ops '[{"op":"replace","data":<doc>}]'`
    (or `--ops @wrap.json` to load the batch from a file). A doc is
    `meta + outcomes[] → initiatives[] → metrics[]/features[]`; keys like
    `O3.I1.F2` must be unique. Use `--if-rev` with the rev you read; a 409 reply
    means someone edited meanwhile — re-read, merge, retry.
  - Targeted edits are just ops in the same `write`:
    `ensembleworks roadmap write <name> --ops '[{"op":"set","key":"O3.I1.F2","fields":{"status":"done"}}]'`
    `ensembleworks roadmap write <name> --ops '[{"op":"move","key":"O4","zone":"now","index":0}]'`
    `set` fields per kind — outcome: status/title/why; initiative:
    status/title/statement; feature: status/text; metric: done/text. Statuses:
    planned | in-progress | done | parked. `move` takes `zone` (outcomes only)
    and/or `index` (position within the zone or parent list).

  Structural changes (add/remove outcomes, initiatives, metrics, features) go
  through a replace op — regenerate the document and replace it.

  ## The loop

  1. **Look before you act.** `ensembleworks canvas frame <your-crew>` (the
     drafting table) to pick up the task, constraints and any reference images.
     `pull-images` and read anything visual.
  2. **Signal you're on it.** `ensembleworks terminal status <session-id> working`.
  3. Do the work in your terminal.
  4. **Report back.** Post a short summary into your crew's advice frame:
     `ensembleworks canvas sticky "what changed + anything risky" --frame advice --author <crew> --color light-blue`.
     One tight sticky beats a wall of text.
  5. **Flip the light.** `ensembleworks terminal status <session-id> done` when
     finished, or `needs-you` if you're blocked and want a human — that pulses
     amber on the canvas so someone comes over.

  ## Notes

  - Keep stickies short; they're read at a glance from across the room.
  - `canvas frame`/`canvas frames` are safe to run any time — they only read.
  - If a frame name doesn't match, run `ensembleworks canvas frames` to see the
    real names.
  - A Stop hook can automate step 5
    (`ensembleworks terminal status <id> needs-you`) so the drafting table always
    shows who wants attention.
  ````

### Step 3 — Reseed `.claude/skills/conversation-map/SKILL.md`

- [ ] **Overwrite `.claude/skills/conversation-map/SKILL.md`** with:
  ````markdown
  ---
  name: conversation-map
  description: Diagram the structure of the live conversation on the EnsembleWorks — poll the voice transcript and maintain a dialogue map (topics, ideas, pros/cons, links) as real tldraw shapes that humans can rearrange. Use when asked to map the discussion, diagram the conversation, or run a live dialogue map.
  ---

  # Skill: Conversation map

  Turn the room's voice transcript into a **live diagram** of the discussion:
  what questions are on the table, which ideas answer them, what supports or
  undercuts each idea. The map is made of real canvas shapes, so humans can
  drag nodes around, and arrows follow — you maintain *structure*, they own
  *layout*.

  You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
  `ENSEMBLEWORKS_ROOM` env as usual).

  ## The vocabulary (IBIS, loosely)

  | Node | Shape | Colour |
  |---|---|---|
  | Question / topic | `geo` rectangle | `violet` |
  | Idea / proposal | `geo` ellipse | `blue` |
  | Pro / support | `note` | `green` |
  | Con / risk | `note` | `light-red` |
  | Decision | `geo` rectangle | `green`, label prefixed `✓` |

  Links are arrows: idea → the question it answers, pro/con → the idea it
  weighs on, decision → the question it closes.

  ```bash
  # nodes — the response carries the shape id; SAVE IT
  ensembleworks canvas shape '{"type":"geo","geo":"rectangle","color":"violet","x":80,"y":80,"w":260,"h":90,"text":"How do we stop the retry storm?","frame":"map"}'
  ensembleworks canvas shape '{"type":"geo","geo":"ellipse","color":"blue","x":420,"y":60,"text":"exponential backoff"}'
  # links — bound at both ends, so they follow when humans drag nodes
  ensembleworks canvas shape '{"type":"arrow","fromId":"shape:<idea>","toId":"shape:<question>"}'
  # evolve — relabel, recolour, promote an idea to a decision
  ensembleworks canvas shape '{"op":"update","id":"shape:<idea>","text":"✓ exponential backoff + jitter","color":"green"}'
  ensembleworks canvas shape '{"op":"delete","id":"shape:<dead-end>"}'
  ```

  ## The loop

  1. **Set up once.** `ensembleworks canvas frames` — use a frame whose name
     contains `map` (ask a human to draw one, or place nodes on open canvas near
     the talkers' cursors). Keep a registry file (e.g. `map-registry.json`) of
     `node text → shape id` so you update nodes instead of duplicating them.
  2. **Poll.** `ensembleworks scribe transcript --since <last now>` every
     ~60–90s; save the returned `now` for the next poll.
  3. **Segment into threads.** Entries whose `frame.name` matches (or whose
     cursors are within ~600 page units — the huddle radius) belong to one
     conversation; parallel huddles are parallel threads. Don't merge them.
  4. **Extract structure, not transcript.** From each thread's new utterances:
     - a question worth mapping ("how should we…", "what if…") → question node
     - a proposal → idea node, arrow to its question
     - support/objection → green/red note, arrow to its idea
     - convergence ("ok let's do that") → recolour the idea green, `✓` prefix
     Map turning points, not every sentence. A 10-minute debate might be one
     question, three ideas, four notes.
  5. **Place sanely.** Question nodes in a column (x≈80, y step ≈260); ideas to
     the right of their question; pros/cons to the right of their idea. Offset
     each new node so nothing stacks. Humans will rearrange — that's fine,
     bound arrows survive; **never "tidy" positions of nodes you already
     created**, you'd fight the humans.
  6. **Decisions feed the record.** When a thread closes with a decision, also
     post it as a sticky:
     `ensembleworks canvas sticky "✓ <decision>" --frame map --author mapper --color light-blue`
     (the minutes scribe, if one is running, will pick it up too).

  ## Judgement calls

  - STT mangles words; `ensembleworks canvas frame <frame the speakers were in>`
    shows the stickies/code they were discussing — use it to decode jargon before
    labelling a node wrongly.
  - If the conversation outgrows the frame, grow the map rightwards, not
    denser; legibility-at-a-glance is the whole point.
  - When in doubt whether something was a decision or a musing, make it an
    idea node — a human will promote it by recolouring, or ask you to.
  ````

### Step 4 — Reseed `.claude/skills/minutes/SKILL.md`

- [ ] **Overwrite `.claude/skills/minutes/SKILL.md`** with:
  ````markdown
  ---
  name: minutes
  description: Act as the session-minutes scribe for the EnsembleWorks — poll the live voice transcript, distil it into running minutes (decisions, actions, topics, who said what and where), and keep both a markdown file and a Minutes frame on the canvas up to date. Use when asked to take minutes, summarise the session, or "be the scribe".
  ---

  # Skill: Session minutes

  The canvas transcribes everyone's voice: the scribe bot turns each utterance
  into a transcript entry, **stamped with the speaker's cursor position and the
  frame they were working in** when they said it. Your job is to turn that raw
  feed into minutes a teammate who missed the session would actually want to
  read.

  You need the `ensembleworks` CLI on PATH (`ENSEMBLEWORKS_URL`,
  `ENSEMBLEWORKS_ROOM` env as usual).

  ## Reading the transcript

  ```bash
  ensembleworks scribe transcript                    # everything so far (JSON, oldest first)
  ensembleworks scribe transcript --since 1750000000000   # only entries newer than that ms-epoch
  ```

  The response carries a top-level `now` (server clock). **Chain your polls with
  it**: save `now`, sleep, then `--since <saved now>`. Never trust your own
  clock. Each entry looks like:

  ```json
  { "t": 1750000012345, "name": "Alice", "text": "let's cap retries at three",
    "page": "page:page", "cursor": { "x": 1180, "y": 420 },
    "frame": { "name": "Drafting — crew-a", "dist": 0 } }
  ```

  `frame` is *where the speaker was* — `dist: 0` means inside that frame. With
  no tab open, `cursor`/`frame` are null; those lines still belong to the
  conversation, just without a place.

  ## The loop

  1. **Set up once.** `ensembleworks canvas frames` to find (or pick a spot for)
     a frame whose name contains `minutes`; humans usually seed one. Create the
     minutes file, e.g. `minutes-$(date +%F).md`, with the session name and start
     time. Post one sticky so the room knows minutes are running:
     `ensembleworks canvas sticky "minutes started" --frame minutes --author scribe --color light-blue`.
  2. **Poll.** Every 2–3 minutes (`sleep 150`), fetch the new tail with
     `--since`. No new entries → just sleep again.
  3. **Distil — don't transcribe.** Fold the new entries into the minutes:
     - **Decisions** ("we'll go with…", agreement after debate) — verbatim-ish,
       with who and when.
     - **Actions** (someone committed to doing something) — owner + thing.
     - **Topics** — one line per discussion thread, not per utterance.
     - **Open questions** — raised but not settled.
  4. **Use the places.** Group by `frame.name`: utterances inside
     `Drafting — crew-a` are crew-a's huddle; a cluster at the retro corner is
     its own thread. Two groups talking simultaneously in different frames are
     **parallel conversations — keep them as separate threads**, don't
     interleave them into nonsense.
  5. **Write back.**
     - Append the distilled section to the markdown file (keep raw quotes out;
       it's minutes, not a court record).
     - Keep the canvas summary fresh: maintain **one text shape** in the
       minutes frame — create it once and remember the id, then update in
       place so the frame doesn't fill with stale copies:
       ```bash
       ensembleworks canvas shape '{"type":"text","frame":"minutes","x":24,"y":24,"w":560,"text":"…"}'
       ensembleworks canvas shape '{"op":"update","id":"shape:<saved-id>","text":"…refreshed summary…"}'
       ```
       Keep it to ~15 lines: latest decisions + actions on top.
  6. **On "wrap up" / session end:** do a final pass over the whole transcript
     (`ensembleworks scribe transcript` with no `--since`), write the complete
     minutes — attendees (distinct `name`s), timeline of topics with rough times,
     decisions, actions, open questions — and post a closing sticky:
     `ensembleworks canvas sticky "minutes ready: <path>" --frame minutes --author scribe --color light-blue`.

  ## Judgement calls

  - Speech-to-text is imperfect: names and jargon arrive mangled. Use the
    canvas for context (`ensembleworks canvas frame <frame>` shows what the
    speakers were looking at) before guessing what a garbled term meant.
  - Standup mode produces one big room-wide conversation — frame stamps still
    tell you what people were *looking at* while speaking.
  - Don't editorialise; minutes record what the room decided, not what you
    would have decided.
  ````

### Step 5 — Reseed `.claude/skills/debugging-roadmap-control/SKILL.md`

- [ ] **Overwrite the "Data plane (no browser)" section** of
  `.claude/skills/debugging-roadmap-control/SKILL.md` (leave everything from
  `## UI plane (headless probe)` onward untouched — `probe.mjs` drives the
  browser, not the CLI, and its POST targets are already the
  `/api/roadmap/doc` route). Replace:
  ````markdown
  ## Data plane (no browser)

  ```bash
  export CANVAS_URL=http://localhost:5173   # vite proxies /api (sync server: :8788)
  export CANVAS_ROOM=debug-roadmap          # NEVER 'team' — that's the live roadmap
  bin/canvas roadmap list|read|push|ops ... # see canvas --help
  ```

  `roadmap read` first — the scratch room may already hold a usable doc. If
  seeding, use ≥2 initiatives in ONE outcome with mixed statuses — drag
  containers are per-parent, so one-initiative-per-outcome fixtures can't
  exercise initiative reorder at all.
  ````
  with:
  ````markdown
  ## Data plane (no browser)

  ```bash
  export ENSEMBLEWORKS_URL=http://localhost:5173   # vite proxies /api (sync server: :8788)
  export ENSEMBLEWORKS_ROOM=debug-roadmap          # NEVER 'team' — that's the live roadmap
  ensembleworks roadmap read [name]                # list (no name) or read one
  ensembleworks roadmap write <name> --ops '<ops-json>' [--if-rev <rev>]   # apply an op batch
  # (the old `push`/`ops` verbs are now both `write --ops`; wholesale-replace is
  #  --ops '[{"op":"replace","data":<doc>}]', or --ops @wrap.json from a file.)
  ```

  `ensembleworks roadmap read <name>` first — the scratch room may already hold a
  usable doc. If seeding, use ≥2 initiatives in ONE outcome with mixed statuses —
  drag containers are per-parent, so one-initiative-per-outcome fixtures can't
  exercise initiative reorder at all.
  ````

### Step 6 — Gate + commit

- [ ] **Gate — bash syntax + typecheck + a real reseeded command line:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bash -n bin/ensembleworks    # exits 0
  test -x bin/ensembleworks && test -x bin/ew && echo "wrappers executable"
  bun run typecheck
  # a reseeded command resolves + renders help without a live server:
  bin/ensembleworks canvas sticky --help
  bin/ensembleworks tools | head -3   # 15-verb table from the embedded snapshot
  ```
  Expected: `bash -n` exits 0; both wrappers are executable; typecheck 0;
  `canvas sticky --help` prints the rendered flag help; `tools` prints the verb
  table header + rows from the embedded snapshot.

- [ ] **Commit:**
  ```bash
  git add bin/ensembleworks bin/ew .claude/skills/canvas/SKILL.md \
    .claude/skills/conversation-map/SKILL.md .claude/skills/minutes/SKILL.md \
    .claude/skills/debugging-roadmap-control/SKILL.md
  git commit -m "$(cat <<'EOF'
  feat(cli): dev wrappers (bin/ensembleworks + ew) + reseed all four SKILL.md files (slice #4)

  bin/ensembleworks execs `bun cli/src/main.ts`; bin/ew is a hardlink — so the
  reseeded skills resolve on the devcontainer PATH before #7's compiled artifact.
  All four skills move canvas→ensembleworks, CANVAS_*→ENSEMBLEWORKS_*, and adopt
  the manifest spellings: read→frame, status→terminal status,
  transcript/say→scribe transcript/say, roadmap list/push/ops→read/write --ops,
  explicit --color light-blue for agent stickies, `ew` mentioned once. bin/canvas
  is untouched (deleted at the #8 cutover).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 8 — Booted e2e suite + full gate (TDD: RED → GREEN)

The one booted suite: run `main()` in-process against a real `createSyncApp`,
proving the CLI's exact wire shape end-to-end. Then the full gate.

### Step 1 — Write the failing e2e suite (RED)

- [ ] **`cli/src/cli-api.test.ts`** (create it — boots the server via a relative
  import of `../../server/src/app.ts`; a temp `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`
  so `hosts.toml`/cache are isolated; runs `main()` capturing stdout. **Ends with
  `process.exit(0)` — house convention, Environment note 6**):
  ```ts
  // Booted e2e: run main() in-process against createSyncApp on an ephemeral port,
  // with an isolated temp XDG config/cache. Pins auth login (none) → whoami,
  // sticky→frames→frame round-trip, anonymous --author badge (no meta.author),
  // roadmap write→read, tools cache (fetch once), version, and the stdout-clean /
  // 409-body-exit-1 discipline. Reuses the write-scope-api boot pattern.
  // Run with: bun src/cli-api.test.ts
  import assert from 'node:assert/strict'
  import { mkdtempSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'
  import { createSyncApp } from '../../server/src/app.ts'
  import { ROADMAP_FIXTURE } from '../../server/src/roadmap-fixture.ts'
  import { main } from './main.ts'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL
  delete process.env.ENSEMBLEWORKS_URL
  delete process.env.ENSEMBLEWORKS_ROOM
  delete process.env.ENSEMBLEWORKS_TOKEN_ID
  delete process.env.ENSEMBLEWORKS_TOKEN_SECRET

  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-api-'))
  const env: NodeJS.ProcessEnv = {
  	...process.env,
  	XDG_CONFIG_HOME: path.join(dir, 'config'),
  	XDG_CACHE_HOME: path.join(dir, 'cache'),
  }

  const { server } = createSyncApp({ dataDir: dir })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  // Capture stdout for one main() call; return what it wrote + the exit code.
  async function run(argv: string[]): Promise<{ out: string; code: number }> {
  	const chunks: string[] = []
  	const real = process.stdout.write.bind(process.stdout)
  	;(process.stdout as any).write = (s: string) => { chunks.push(String(s)); return true }
  	try {
  		const code = await main(argv, env)
  		return { out: chunks.join(''), code }
  	} finally {
  		;(process.stdout as any).write = real
  	}
  }

  // 1. auth login (none) writes the record + verifies via /api/whoami.
  {
  	const { code } = await run(['auth', 'login', '--url', base, '--method', 'none', '--room', 'team'])
  	assert.equal(code, 0, 'auth login (none) succeeds')
  }

  // 2. kernel whoami round-trips (anonymous on a none instance).
  {
  	const { out, code } = await run(['kernel', 'whoami'])
  	assert.equal(code, 0)
  	const who = JSON.parse(out)
  	assert.deepEqual(who, { identity: null, kind: 'anonymous', via: 'none' })
  }

  // 3. canvas sticky → frames → frame round-trip (the note appears).
  let stickyId: string
  {
  	const { out, code } = await run(['canvas', 'sticky', 'hello from the cli', '--frame', 'Advice'])
  	assert.equal(code, 0)
  	const res = JSON.parse(out) as { ok: true; id: string }
  	assert.equal(res.ok, true)
  	stickyId = res.id
  }
  {
  	const { out } = await run(['canvas', 'frames'])
  	assert.ok(JSON.parse(out).ok, 'frames returns ok JSON')
  }
  {
  	const { out } = await run(['canvas', 'frame', 'Advice'])
  	const frame = JSON.parse(out)
  	assert.ok(frame.notes.some((n: { text: string }) => n.text.includes('hello from the cli')), 'the note is in the frame')
  }

  // 4. anonymous --author dave → cosmetic badge, no structured meta.author
  //    (the 3c pass-through, exercised through the CLI's exact wire shape).
  {
  	const { out } = await run(['canvas', 'sticky', 'note', '--author', 'dave', '--frame', 'Advice', '--color', 'light-blue'])
  	const id = (JSON.parse(out) as { id: string }).id
  	const read = await fetch(`${base}/api/canvas/frame?room=team&name=Advice`)
  	const frame = (await read.json()) as { notes: { id: string; text: string }[] }
  	const note = frame.notes.find((n) => n.id === id)
  	assert.ok(note && note.text.includes('🤖 dave: note'), 'voluntary --author renders as a cosmetic badge')
  }

  // 5. roadmap write (a replace batch) → roadmap read.
  {
  	const ops = JSON.stringify([{ op: 'replace', data: ROADMAP_FIXTURE }])
  	const { out, code } = await run(['roadmap', 'write', 'cli-roadmap', '--ops', ops])
  	assert.equal(code, 0, 'roadmap write succeeds')
  	assert.ok((JSON.parse(out) as { ok: true }).ok)
  	const { out: readOut } = await run(['roadmap', 'read', 'cli-roadmap'])
  	assert.ok(JSON.parse(readOut).data, 'roadmap read returns the doc')
  }

  // 6. roadmap write with a stale ifRev → 409 body on stdout + exit 1.
  {
  	const ops = JSON.stringify([{ op: 'replace', data: ROADMAP_FIXTURE }])
  	const { out, code } = await run(['roadmap', 'write', 'cli-roadmap', '--ops', ops, '--if-rev', '0'])
  	assert.equal(code, 1, 'a 409 exits non-zero')
  	assert.ok(out.trim().length > 0 && out.includes('rev'), 'the 409 body (carrying the current rev) prints to stdout')
  }

  // 7. tools fetch populates the cache; a second call does not refetch.
  {
  	const { out, code } = await run(['tools', 'refresh'])
  	assert.equal(code, 0)
  	const { out: listOut } = await run(['tools', '--json'])
  	assert.equal(JSON.parse(listOut).tools.length, 15, 'the cached manifest has 15 verbs')
  }

  // 8. version prints the CLI + server strings.
  {
  	const { out, code } = await run(['version', '--json'])
  	assert.equal(code, 0)
  	const v = JSON.parse(out)
  	assert.equal(typeof v.cli, 'string')
  	assert.equal(typeof v.server, 'string')
  }

  server.close()
  console.log('ok: cli-api — login/whoami, sticky→frame round-trip, anonymous badge, roadmap write/read, 409-body-exit-1, tools cache, version')
  process.exit(0)
  ```

- [ ] **RED checkpoint:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd cli && bun src/cli-api.test.ts)
  ```
  Expected: with all of Tasks 1–7 in place this should already **pass** on the
  first run (the CLI is complete); it is written last only so the whole program
  exists to exercise. If it fails, treat the failure as the RED signal and fix the
  implicated module before proceeding — do **not** weaken an assertion. (A likely
  first-run snag is the cross-workspace `createSyncApp` import: if `bun run
  typecheck` cannot resolve the server's transitive types from `cli`, add
  `"@ensembleworks/server": "*"` to `cli/package.json` devDependencies, run `bun
  install`, and keep the relative import.)

### Step 2 — Full gate

- [ ] **Run the full suite + build + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  ```
  Expected: typecheck 0; `bun run test` ends **`all 52 suites passed`** (45 + the
  seven new: `resolve`, `hosts`, `render/manifest`, `render/args`,
  `render/validate`, `native/connect`, `cli-api`); `bun run build` 0 (it builds
  client/server/transcriber — cli is deliberately not built here; #7 adds
  compile).

- [ ] **Step 3: Manual smoke (optional; needs `tmux` + `bin/dev`).** Against the
  local none-instance, run one line from each reseeded skill:
  ```bash
  bin/dev up
  bin/ensembleworks auth login --url http://localhost:8788 --method none
  bin/ensembleworks canvas sticky "hello" --frame Advice --author crew-a --color light-blue
  bin/ensembleworks canvas frame Advice | jq '.notes'        # shows the note
  bin/ensembleworks roadmap read                             # lists roadmaps
  bin/ensembleworks tools | head                             # 15-verb table
  bin/ensembleworks scribe transcript --limit 5              # from minutes/conversation-map
  bin/ensembleworks terminal connect --dry-run               # resolved wss/ws config
  ```
  Expected: the sticky posts and reads back; `roadmap read`/`tools`/`scribe
  transcript` return JSON; `terminal connect --dry-run` prints the resolved
  config and exits 0; a plain `terminal connect` prints the #5 notice and exits
  non-zero.

- [ ] **Step 4: Commit the e2e suite (the gate itself is verification):**
  ```bash
  git add cli/src/cli-api.test.ts cli/package.json bun.lock
  git commit -m "$(cat <<'EOF'
  test(cli): booted e2e against createSyncApp — the full CLI wire shape (slice #4)

  cli-api.test.ts boots the server in-process, runs main() with an isolated temp
  XDG config/cache, and pins auth login (none) → whoami, sticky→frames→frame
  round-trip, the anonymous --author cosmetic badge (no meta.author) through the
  CLI's exact wire shape, roadmap write (replace batch) → read, a stale-ifRev 409
  printing its body to stdout + exit 1, the tools cache, and version. Ends
  process.exit(0) (booted-app convention). Full suite: all 52 passed.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all 52 suites passed` — and any deviation from the verbatim blocks above,
especially the positional-slot reconciliation and any `@ensembleworks/server`
devDependency you had to add for the Task 8 cross-workspace import.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every §-component maps to a task.**
  - §4 workspace layout + root wiring + `smol-toml` + dev wrappers — Task 1
    (workspace/root/deps) + Task 7 (`bin/ensembleworks`/`ew`).
  - §5 `hosts.toml` store (0600 write, warn-on-read) + the §5.2 per-variable
    resolution chain + `authHeaders` — Task 1 (`hosts.ts`, `resolve.ts`), pinned
    by `hosts.test.ts` + `resolve.test.ts`.
  - §6.3 manifest cache + embedded snapshot + poisoned-path guard — Task 2
    (`http.toRequestUrl`, `build.ts`) + Task 3 (`render/manifest.ts`), pinned by
    `manifest.test.ts`.
  - §6.2 arg model (positional slots, flags, `@file`, JSON spread, room inject,
    method→location) + §7.2 D4 posture — Task 4 (`args.ts`, `validate.ts`),
    pinned by `args.test.ts` + `validate.test.ts`. The positional-slot rule is
    the one reconciled ambiguity (required-first then optional scalars), pinned
    for both `scribe say` and `roadmap read`.
  - §6.1 three-layer dispatch + §6.4 command table (all 15 rendered verbs, kernel
    included) + the generic renderer + §8 auth (login/status/logout, verify via
    `/api/whoami`, mint seam isolated) + `tools`/`version`/`pull-images` +
    Layer-2 trusted-dir extension exec — Task 5, pinned e2e by `cli-api.test.ts`.
  - §10 `terminal connect` slot (flags, §5 resolution, stable per-box gateway-id,
    `--dry-run`, #5 notice) — Task 6, pinned by `connect.test.ts`.
  - §7.1 output discipline (stdout-clean data verbatim; operator `--json`/table;
    stderr narration; 409 body→stdout + exit 1) — `output.ts` (Task 2), asserted
    in `cli-api.test.ts` (Task 8).
  - §9 distribution boundary — no compile/install/self-update here; `build.ts`
    injects the version (§9.2 rule 3); config/cache paths resolve against the real
    FS (§9.2 rule 2); static `allTools` import only (§9.2 rule 1); `bin/canvas`
    untouched (§9.4).
  - §11 SKILL.md reseed (all four files, full rewritten content) — Task 7.
  - §13 seven suites (resolve, hosts, manifest, args, validate, connect, cli-api)
    — 45 → 52; the runner glob already discovers `cli/src/**/*.test.ts` (verified,
    no runner edit).
- **TDD ordering honoured.** Each suite-bearing task writes its test first and
  shows RED (module missing / symbol unexported), then implements to GREEN. Tasks
  2/5/7 are infrastructure/wiring/wrappers with no new suite (explicit coverage
  notes point at the later suite that pins them) and gate on typecheck + rerunning
  the prior green suites.
- **Booted-app convention enforced.** Only `cli-api.test.ts` boots
  `createSyncApp`; it ends `process.exit(0)`. The six unit suites boot nothing
  (network-free / stubbed `globalThis.fetch`) and need no exit.
- **Placeholder scan:** no "as per spec"/"similar to" hand-waving — every module
  is complete verbatim code; every gate names its command + expected output. The
  one deliberate tripwire (`status.ts`'s bogus first import block) is immediately
  followed by its real replacement with an explicit "replace this whole file"
  instruction, so a blind copy of the stub cannot ship.
- **Type consistency across tasks.** `CliError` (Task 1) is the single error
  type main.ts maps; `Conn`/`Auth`/`Flags`/`Env`/`readEnv` (Task 1) feed
  `http.ts`/`args.ts`/every native command; `JsonSchema`/`JsonSchemaProp`/
  `propType`/`isScalar` live once in `validate.ts` and are imported by `args.ts`
  and `run.ts`; `ManifestEntry`/`ManifestEnvelope`/`allTools`/`buildManifest`/
  `MANIFEST_VERSION` come from `@ensembleworks/contracts`; `Globals` lives in
  `dispatch.ts` and is imported by `native/connect.ts`; `Whoami` (contracts) is
  the auth verify/status return. The cli `tsconfig` mirrors the proven
  `transcriber` config (bundler resolution + `allowImportingTsExtensions` +
  contracts `paths`), so `.ts` intra-package imports and the contracts barrel
  both typecheck.
```
