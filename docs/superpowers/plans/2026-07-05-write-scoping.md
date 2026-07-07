# Write Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject read-only service tokens on any mutating HTTP request (403), leaving humans, read-write tokens, anonymous callers and "none" instances untouched.

**Architecture:** A behaviour-preserving refactor extracts the service-token `common_name` extraction out of `resolveCaller` into a shared helper; a new `resolveWriteScope` reuses it; one app-wide express guard 403s read-only tokens on non-GET/HEAD/OPTIONS requests, mounted before the routers so it covers all write routes (incl. `/uploads`).

**Tech Stack:** Bun ≥ 1.3.14, TypeScript, express 5, Cloudflare Access JWTs.

Spec: `docs/superpowers/specs/2026-07-05-write-scoping-design.md`. Builds on the auth-plane foundation (`server/src/whoami.ts` `resolveCaller`, `service-tokens.ts` `lookupServiceToken`, `access-identity.ts` verifiers).

---

## Environment & conventions (read before starting)

1. **Bun version.** Default PATH `bun` is 1.3.4 (too old). Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Per-task green + commit.** Every task ends by committing and must leave `bun run typecheck` green. Commit trailer, exactly:
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```
   (This repo's `git` runs through a direnv wrapper — commit exactly as shown.)
3. **Indentation: TABS** in all `server/src/*` files.
4. **Tests** are self-running scripts discovered by `scripts/run-tests.ts`; the suite count rises by 2.

---

## Task 1 — `resolveWriteScope` + the shared `serviceTokenCommonName` refactor (TDD)

Extract the service-token `common_name` extraction out of `resolveCaller` (behaviour-preserving) and add `resolveWriteScope`. The existing `whoami.test.ts`/`whoami-api.test.ts` guard `resolveCaller`.

**Files:**
- Create: `server/src/write-scope.test.ts`
- Modify: `server/src/whoami.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/write-scope.test.ts`:
  ```ts
  // Run: bun src/write-scope.test.ts   (from server/)
  // resolveWriteScope: read-only / read-write tokens resolve their scope; a human,
  // anonymous, or unknown token → null (open). Header-trust mode, network-free.
  import assert from 'node:assert/strict'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-write-scope-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(
  	mapFile,
  	[
  		'[tokens."ro.access"]',
  		'identity = "🤖 ro"',
  		'scope = "read-only"',
  		'[tokens."rw.access"]',
  		'identity = "🤖 rw"',
  		'scope = "read-write"',
  	].join('\n') + '\n',
  )
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const { resolveWriteScope } = await import('./whoami.ts')

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

  assert.equal(
  	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'ro.access' }) }),
  	'read-only',
  	'read-only token → read-only',
  )
  assert.equal(
  	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'rw.access' }) }),
  	'read-write',
  	'read-write token → read-write',
  )
  assert.equal(
  	await resolveWriteScope({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
  	null,
  	'unknown token → null',
  )
  assert.equal(await resolveWriteScope({ 'cf-access-authenticated-user-email': 'a@b.com' }), null, 'human → null')
  assert.equal(await resolveWriteScope({}), null, 'anonymous → null')

  console.log('ok: resolveWriteScope')
  ```

- [ ] **Step 2: Run it — expect failure** (export missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/write-scope.test.ts)
  ```
  Expected: error that `resolveWriteScope` is not exported / not a function.

- [ ] **Step 3: Refactor `server/src/whoami.ts`.** Extract the bot-`common_name` block into a shared helper and add `resolveWriteScope`. Replace the current `resolveCaller` function (the whole `export async function resolveCaller … }` block) with the helper + the refactored `resolveCaller` + the new export. BEFORE (current `resolveCaller`):
  ```ts
  export async function resolveCaller(headers: IncomingHttpHeaders): Promise<Whoami> {
  	// 1. Human — the existing three-mode CF Access resolution (email present).
  	const human = await getAccessIdentity(headers)
  	if (human) return { identity: human.name ?? human.email, kind: 'human', via: 'sso' }

  	// 2. Bot — a CF Access service token, keyed by its common_name.
  	const jwt = header(headers, JWT_HEADER)
  	if (jwt) {
  		let commonName: string | undefined
  		if (accessVerificationEnabled()) {
  			try {
  				commonName = (await verifyCfAccessClaims(jwt))?.commonName
  			} catch {
  				commonName = undefined
  			}
  		} else {
  			commonName = decodeCfAccessClaimsUnverified(jwt)?.commonName
  		}
  		if (commonName) {
  			const entry = lookupServiceToken(commonName)
  			if (entry) return { identity: entry.identity, kind: 'bot', via: 'service-token' }
  		}
  	}

  	// 3. Anonymous.
  	return { identity: null, kind: 'anonymous', via: 'none' }
  }
  ```
  AFTER:
  ```ts
  // Extract the CF Access service-token common_name from the request headers
  // (verified in verified mode; decoded-unverified in header-trust mode — the same
  // tunnel trust basis as the Cf-Access-…-Email header). Shared by resolveCaller
  // and resolveWriteScope.
  async function serviceTokenCommonName(headers: IncomingHttpHeaders): Promise<string | undefined> {
  	const jwt = header(headers, JWT_HEADER)
  	if (!jwt) return undefined
  	if (accessVerificationEnabled()) {
  		try {
  			return (await verifyCfAccessClaims(jwt))?.commonName
  		} catch {
  			return undefined
  		}
  	}
  	return decodeCfAccessClaimsUnverified(jwt)?.commonName
  }

  export async function resolveCaller(headers: IncomingHttpHeaders): Promise<Whoami> {
  	// 1. Human — the existing three-mode CF Access resolution (email present).
  	const human = await getAccessIdentity(headers)
  	if (human) return { identity: human.name ?? human.email, kind: 'human', via: 'sso' }

  	// 2. Bot — a CF Access service token, keyed by its common_name.
  	const commonName = await serviceTokenCommonName(headers)
  	if (commonName) {
  		const entry = lookupServiceToken(commonName)
  		if (entry) return { identity: entry.identity, kind: 'bot', via: 'service-token' }
  	}

  	// 3. Anonymous.
  	return { identity: null, kind: 'anonymous', via: 'none' }
  }

  /**
   * The caller's service-token write scope, or null if the caller is not a
   * recognised service token (a human, an anonymous caller, or an unknown/unmapped
   * token — all "open" for the write guard). Scope is an authz detail, kept out of
   * the Whoami identity envelope.
   */
  export async function resolveWriteScope(
  	headers: IncomingHttpHeaders,
  ): Promise<'read-only' | 'read-write' | null> {
  	const commonName = await serviceTokenCommonName(headers)
  	if (!commonName) return null
  	return lookupServiceToken(commonName)?.scope ?? null
  }
  ```
  (All existing imports — `verifyCfAccessClaims`, `decodeCfAccessClaimsUnverified`, `accessVerificationEnabled`, `getAccessIdentity`, `lookupServiceToken`, `header`, `JWT_HEADER` — remain used. No import changes.)

- [ ] **Step 4: Run the new test + the resolveCaller regression guard — expect pass:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/write-scope.test.ts)
  (cd server && bun src/whoami.test.ts)
  (cd server && bun src/whoami-api.test.ts)
  ```
  Expected: `ok: resolveWriteScope`; `ok: resolveCaller`; `whoami-api.test.ts: all assertions passed` (the last two prove the refactor didn't change `resolveCaller`).

- [ ] **Step 5: Typecheck green:**
  ```bash
  bun run typecheck
  ```

- [ ] **Step 6: Commit:**
  ```bash
  git add server/src/whoami.ts server/src/write-scope.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): resolveWriteScope + shared serviceTokenCommonName helper

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — the write-scope guard + mount (TDD)

**Files:**
- Create: `server/src/features/write-scope.ts`
- Create: `server/src/write-scope-api.test.ts`
- Modify: `server/src/app.ts` (mount)

- [ ] **Step 1: Write the failing test.** Create `server/src/write-scope-api.test.ts`:
  ```ts
  // Run: bun src/write-scope-api.test.ts   (from server/)
  // The write guard: a read-only token is 403'd on a write; read-write and
  // anonymous callers pass (200); reads are unaffected. Header-trust mode, temp map.
  import assert from 'node:assert/strict'
  import { writeFileSync } from 'node:fs'
  import { mkdtemp } from 'node:fs/promises'
  import os from 'node:os'
  import path from 'node:path'
  import { createSyncApp } from './app.ts'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = await mkdtemp(path.join(os.tmpdir(), 'write-scope-api-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(
  	mapFile,
  	[
  		'[tokens."ro.access"]',
  		'identity = "🤖 ro"',
  		'scope = "read-only"',
  		'[tokens."rw.access"]',
  		'identity = "🤖 rw"',
  		'scope = "read-write"',
  	].join('\n') + '\n',
  )
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const { server } = createSyncApp({ dataDir: dir })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
  const postSticky = (extra: Record<string, string>) =>
  	fetch(`${base}/api/sticky`, {
  		method: 'POST',
  		headers: { 'Content-Type': 'application/json', ...extra },
  		body: JSON.stringify({ room: 'team', text: 'hello from a scoping test' }),
  	})

  // read-only token → 403 on a write
  {
  	const res = await postSticky({ 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'ro.access' }) })
  	assert.equal(res.status, 403, 'read-only token blocked on write')
  	assert.deepEqual(await res.json(), { error: 'read-only token: writes are not permitted' }, 'error body')
  }
  // read-write token → allowed (200)
  {
  	const res = await postSticky({ 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'rw.access' }) })
  	assert.equal(res.status, 200, 'read-write token allowed')
  }
  // anonymous → allowed (200) — humans/none unaffected
  {
  	const res = await postSticky({})
  	assert.equal(res.status, 200, 'anonymous allowed')
  }
  // read-only token can still READ
  {
  	const res = await fetch(`${base}/api/whoami`, {
  		headers: { 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'ro.access' }) },
  	})
  	assert.equal(res.status, 200, 'reads unaffected')
  	assert.deepEqual(await res.json(), { identity: '🤖 ro', kind: 'bot', via: 'service-token' }, 'still resolves as the bot')
  }

  server.close()
  console.log('write-scope-api.test.ts: all assertions passed')
  process.exit(0)
  ```

- [ ] **Step 2: Run it — expect failure** (guard not mounted → the read-only write returns 200, so the `403` assertion fails):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/write-scope-api.test.ts)
  ```
  Expected: FAIL — `read-only token blocked on write` (got 200, expected 403).

- [ ] **Step 3: Create the guard `server/src/features/write-scope.ts`:**
  ```ts
  /**
   * Write-scope guard: rejects read-only service tokens on mutating requests
   * (403). Humans, read-write tokens, anonymous callers and "none" instances pass
   * untouched, so this is a no-op unless an operator configured a read-only token.
   * Mounted app-wide before the routers; WS upgrades bypass express and are
   * unaffected (that is the gateway-id binding slice).
   */
  import type { RequestHandler } from 'express'
  import { resolveWriteScope } from '../whoami.ts'

  const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

  export function createWriteScopeGuard(): RequestHandler {
  	return async (req, res, next) => {
  		if (READ_METHODS.has(req.method)) return next()
  		if ((await resolveWriteScope(req.headers)) === 'read-only') {
  			return void res.status(403).json({ error: 'read-only token: writes are not permitted' })
  		}
  		next()
  	}
  }
  ```

- [ ] **Step 4: Mount it in `app.ts`.** Add the import alongside the other feature-router imports (after `import { createWhoamiRouter } from './features/whoami.ts'`):
  ```ts
  import { createWriteScopeGuard } from './features/write-scope.ts'
  ```
  Then mount it immediately after the JSON body parser, before any route. BEFORE:
  ```ts
  	app.use('/api', express.json())

  	app.get('/api/health', (_req, res) => {
  ```
  AFTER:
  ```ts
  	app.use('/api', express.json())

  	// Write scoping: read-only service tokens are 403'd on mutating requests.
  	app.use(createWriteScopeGuard())

  	app.get('/api/health', (_req, res) => {
  ```

- [ ] **Step 5: Run the test — expect pass:**
  ```bash
  (cd server && bun src/write-scope-api.test.ts)
  ```
  Expected: `write-scope-api.test.ts: all assertions passed`.

- [ ] **Step 6: Full gate — typecheck, whole suite, build:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  bun run test     # ends "all N suites passed" (N = prior total + 2)
  bun run build
  ```
  Expected: all exit 0; suite count is the prior total + 2. `bun run test` spawns tmux for relay-loopback and takes a few minutes — let it finish; do NOT kill it. Report the count.

- [ ] **Step 7: Commit:**
  ```bash
  git add server/src/features/write-scope.ts server/src/write-scope-api.test.ts server/src/app.ts
  git commit -m "$(cat <<'EOF'
  feat(server): write-scope guard — 403 read-only tokens on mutating requests

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count and any deviation from the verbatim blocks above.)_
