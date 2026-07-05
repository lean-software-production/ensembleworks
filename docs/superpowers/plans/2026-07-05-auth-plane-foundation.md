# Auth-plane Foundation (identity + whoami) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the additive auth-plane foundation — resolve a caller as `human | bot | anonymous` (+ `via`), load a config-folder service-token map, and serve `GET /api/whoami` — with zero change to existing write/read/co-author behaviour.

**Architecture:** A shared `Whoami` envelope in contracts; a fail-closed, mtime-cached TOML map loader (`service-tokens.ts`); a behaviour-preserving refactor of `access-identity.ts` that exposes the verified JWT claims (so a service token's `common_name` is reachable); a `resolveCaller` composing the human path + the bot path; and a one-route `GET /api/whoami`.

**Tech Stack:** Bun ≥ 1.3.14 (`Bun.TOML.parse`), TypeScript, express 5, zod (contracts), Cloudflare Access JWTs.

Spec: `docs/superpowers/specs/2026-07-05-auth-plane-foundation-design.md`.

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
3. **Indentation: TABS.** Both `server/src/*` and the pre-existing `contracts/src/*` files (constants.ts, stamp.ts) use tab indentation. Use tabs in every new/edited file here. (The code blocks below use tabs; if your editor shows spaces, convert to tabs.)
4. **Intra-contracts imports use the `.js` extension** (nodenext). Server imports use explicit `.ts` extensions (see neighbouring imports).
5. **Tests** are self-running scripts discovered by `scripts/run-tests.ts` (`**/src/**/*.test.ts`); each ends with a `console.log('ok: …')` / `process.exit(0)`. The suite count rises by 5.

---

## Task 1 — The `Whoami` contract envelope

**Files:**
- Create: `contracts/src/whoami.ts`
- Create: `contracts/src/whoami.test.ts`
- Modify: `contracts/src/index.ts` (barrel export)

- [ ] **Step 1: Write the failing test.** Create `contracts/src/whoami.test.ts`:
  ```ts
  // Run: bun contracts/src/whoami.test.ts
  import assert from 'node:assert/strict'
  import { whoamiSchema, type Whoami } from './whoami.js'

  const valid: Whoami = { identity: '🤖 x', kind: 'bot', via: 'service-token' }
  assert.deepEqual(whoamiSchema.parse(valid), valid, 'valid bot envelope parses')
  assert.deepEqual(
  	whoamiSchema.parse({ identity: null, kind: 'anonymous', via: 'none' }),
  	{ identity: null, kind: 'anonymous', via: 'none' },
  	'anonymous envelope parses',
  )
  assert.equal(whoamiSchema.safeParse({ identity: 'x', kind: 'alien', via: 'none' }).success, false, 'bad kind rejected')
  console.log('ok: whoami envelope schema')
  ```

- [ ] **Step 2: Run it — expect failure** (module missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun contracts/src/whoami.test.ts
  ```
  Expected: `Cannot find module './whoami.js'` / `Could not resolve`.

- [ ] **Step 3: Create `contracts/src/whoami.ts`:**
  ```ts
  /**
   * The identity envelope shared by the server's GET /api/whoami and (later) the
   * CLI's `auth status`. Pure type + schema — browser-safe, exported from the
   * barrel. See docs/unified-architecture-design.md §6.4.
   */
  import { z } from 'zod'

  export type WhoamiKind = 'human' | 'bot' | 'anonymous'
  export type WhoamiVia = 'sso' | 'service-token' | 'none'

  export interface Whoami {
  	identity: string | null
  	kind: WhoamiKind
  	via: WhoamiVia
  }

  export const whoamiSchema = z.object({
  	identity: z.string().nullable(),
  	kind: z.enum(['human', 'bot', 'anonymous']),
  	via: z.enum(['sso', 'service-token', 'none']),
  })
  ```

- [ ] **Step 4: Export from the barrel.** In `contracts/src/index.ts`, add a line after the other `export *` lines:
  ```ts
  export * from './whoami.js'
  ```

- [ ] **Step 5: Run the test — expect pass:**
  ```bash
  bun contracts/src/whoami.test.ts
  ```
  Expected: `ok: whoami envelope schema`.

- [ ] **Step 6: Typecheck green:**
  ```bash
  bun run typecheck
  ```
  Expected: exit 0.

- [ ] **Step 7: Commit:**
  ```bash
  git add contracts/src/whoami.ts contracts/src/whoami.test.ts contracts/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(contracts): Whoami identity envelope (type + schema)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — The service-token config map loader (TDD)

**Files:**
- Create: `server/src/service-tokens.test.ts`
- Create: `server/src/service-tokens.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/service-tokens.test.ts`:
  ```ts
  // Run: bun src/service-tokens.test.ts   (from server/)  — or via `bun run test`
  // Loads the config-folder service-token map: valid entry, missing file, malformed
  // TOML (fail closed), scope default, and mtime-based reload. Uses distinct file
  // paths per case (path change busts the cache) plus one explicit mtime bump.
  import assert from 'node:assert/strict'
  import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-service-tokens-'))
  let n = 0
  function useMap(content: string | null): void {
  	const f = path.join(dir, `st-${n++}.toml`)
  	if (content !== null) writeFileSync(f, content)
  	process.env.EW_SERVICE_TOKENS_FILE = f
  }

  const { lookupServiceToken } = await import('./service-tokens.ts')

  // Missing file → no tokens.
  useMap(null)
  assert.equal(lookupServiceToken('codespace-3.access'), null, 'missing file → null')

  // Valid entry resolves; unknown common_name → null.
  useMap('[tokens."codespace-3.access"]\nidentity = "🤖 codespace-3"\nscope = "read-write"\n')
  assert.deepEqual(
  	lookupServiceToken('codespace-3.access'),
  	{ identity: '🤖 codespace-3', scope: 'read-write' },
  	'valid entry resolves',
  )
  assert.equal(lookupServiceToken('unknown.access'), null, 'unknown common_name → null')

  // scope defaults to read-only when absent.
  useMap('[tokens."ro.access"]\nidentity = "🤖 ro"\n')
  assert.deepEqual(lookupServiceToken('ro.access'), { identity: '🤖 ro', scope: 'read-only' }, 'scope defaults read-only')

  // Malformed TOML → fail closed (no tokens), no throw.
  useMap('this is [not valid TOML')
  assert.equal(lookupServiceToken('anything'), null, 'malformed → null (fail closed)')

  // mtime reload: editing the same file (with an advanced mtime) is picked up.
  const rf = path.join(dir, 'reload.toml')
  process.env.EW_SERVICE_TOKENS_FILE = rf
  writeFileSync(rf, '[tokens."a.access"]\nidentity = "🤖 a"\n')
  utimesSync(rf, new Date(1000), new Date(1000))
  assert.equal(lookupServiceToken('a.access')?.identity, '🤖 a', 'first load')
  writeFileSync(rf, '[tokens."a.access"]\nidentity = "🤖 b"\n')
  utimesSync(rf, new Date(2000), new Date(2000))
  assert.equal(lookupServiceToken('a.access')?.identity, '🤖 b', 'mtime change reloads')

  console.log('ok: service-tokens map loader')
  ```

- [ ] **Step 2: Run it — expect failure** (module missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/service-tokens.test.ts)
  ```
  Expected: `Cannot find module './service-tokens.ts'` / `Could not resolve`.

- [ ] **Step 3: Create `server/src/service-tokens.ts`:**
  ```ts
  /**
   * Server-side service-token config map: a CF Access service token's common_name
   * → a bot identity + write scope. Operator config, NOT server data (and it holds
   * no secrets — CF Access validates the token; this only names the
   * already-authenticated caller), so it lives in the config folder alongside the
   * deploy's *.env files, not DATA_DIR. Read + mtime-cached so edits are picked up
   * without a restart; a missing or unparseable file recognises no tokens
   * (fail closed). Scope is parsed and stored here but ENFORCED in a later slice.
   */
  import { readFileSync, statSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'

  export interface ServiceTokenEntry {
  	identity: string
  	scope: 'read-only' | 'read-write'
  }

  function configPath(): string {
  	const override = process.env.EW_SERVICE_TOKENS_FILE
  	if (override) return override
  	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  	return path.join(base, 'ensembleworks', 'service-tokens.toml')
  }

  let cache: { path: string; mtimeMs: number; map: Map<string, ServiceTokenEntry> } | null = null

  function load(): Map<string, ServiceTokenEntry> {
  	const p = configPath()
  	let mtimeMs: number
  	try {
  		mtimeMs = statSync(p).mtimeMs
  	} catch {
  		// Missing/unreadable file → empty map (the "none"-instance case).
  		if (!(cache && cache.path === p && cache.mtimeMs === -1)) cache = { path: p, mtimeMs: -1, map: new Map() }
  		return cache.map
  	}
  	if (cache && cache.path === p && cache.mtimeMs === mtimeMs) return cache.map

  	const map = new Map<string, ServiceTokenEntry>()
  	try {
  		const parsed = Bun.TOML.parse(readFileSync(p, 'utf8')) as { tokens?: Record<string, unknown> }
  		for (const [commonName, raw] of Object.entries(parsed.tokens ?? {})) {
  			const e = (raw ?? {}) as Record<string, unknown>
  			const identity = typeof e.identity === 'string' ? e.identity : null
  			if (!identity) continue // an entry without an identity is ignored
  			const scope: ServiceTokenEntry['scope'] = e.scope === 'read-write' ? 'read-write' : 'read-only'
  			map.set(commonName, { identity, scope })
  		}
  	} catch (err) {
  		console.warn(`[service-tokens] failed to parse ${p} — recognising no tokens`, err)
  		// fall through with the empty map (fail closed)
  	}
  	cache = { path: p, mtimeMs, map }
  	return map
  }

  export function lookupServiceToken(commonName: string): ServiceTokenEntry | null {
  	return load().get(commonName) ?? null
  }
  ```

- [ ] **Step 4: Run the test — expect pass:**
  ```bash
  (cd server && bun src/service-tokens.test.ts)
  ```
  Expected: `ok: service-tokens map loader`.

- [ ] **Step 5: Typecheck green:**
  ```bash
  bun run typecheck
  ```

- [ ] **Step 6: Commit:**
  ```bash
  git add server/src/service-tokens.ts server/src/service-tokens.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): service-token config map loader (fail-closed, mtime-cached)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — `access-identity.ts`: expose verified claims (behaviour-preserving)

Refactor the internal JWT verify to return all identity claims (`email` + `common_name`), add an unverified decoder for header-trust mode, and rewire `getAccessIdentity` so its output is **unchanged**. A guard test locks that.

**Files:**
- Create: `server/src/access-identity.test.ts`
- Modify: `server/src/access-identity.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/access-identity.test.ts`:
  ```ts
  // Run: bun src/access-identity.test.ts   (from server/)
  // Locks the behaviour-preserving refactor: getAccessIdentity's header-trust + dev
  // output is unchanged, and the new unverified claim decoder extracts email /
  // common_name. Network-free (verified/JWKS mode is unchanged prod code).
  import assert from 'node:assert/strict'
  import { decodeCfAccessClaimsUnverified, getAccessIdentity } from './access-identity.ts'

  // Header-trust mode (CF_ACCESS_* unset), no dev fallback.
  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  // getAccessIdentity behaviour preserved.
  assert.deepEqual(
  	await getAccessIdentity({ 'cf-access-authenticated-user-email': 'bob@example.com' }),
  	{ email: 'bob@example.com', verified: false },
  	'human email header → {email, verified:false}',
  )
  assert.equal(await getAccessIdentity({}), null, 'no headers → null')

  process.env.EW_DEV_IDENTITY_EMAIL = 'dev@example.com'
  assert.deepEqual(await getAccessIdentity({}), { email: 'dev@example.com', verified: false }, 'dev fallback preserved')
  delete process.env.EW_DEV_IDENTITY_EMAIL

  // decodeCfAccessClaimsUnverified extracts whichever identity claim is present.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
  assert.deepEqual(
  	decodeCfAccessClaimsUnverified(jwt({ email: 'e@x.com' })),
  	{ email: 'e@x.com', commonName: undefined },
  	'email claim decoded',
  )
  assert.deepEqual(
  	decodeCfAccessClaimsUnverified(jwt({ common_name: 'svc.access' })),
  	{ email: undefined, commonName: 'svc.access' },
  	'common_name claim decoded',
  )
  assert.equal(decodeCfAccessClaimsUnverified('not-a-jwt'), null, 'non-JWT → null')
  assert.equal(decodeCfAccessClaimsUnverified(jwt({ other: 1 })), null, 'no identity claim → null')

  console.log('ok: access-identity refactor preserved')
  ```

- [ ] **Step 2: Run it — expect failure** (the new export doesn't exist):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/access-identity.test.ts)
  ```
  Expected: an error that `decodeCfAccessClaimsUnverified` is not exported / not a function.

- [ ] **Step 3: Rename `verifyCfAccessJwt` → `verifyCfAccessClaims` and widen its result.** In `server/src/access-identity.ts`, replace the whole `verifyCfAccessJwt` function. Before:
  ```ts
  // Verify a Cf-Access-Jwt-Assertion and return its email claim, or null if the
  // token is malformed / unsigned-by-us / expired / wrong-audience.
  async function verifyCfAccessJwt(token: string): Promise<{ email: string } | null> {
  	const { teamDomain, aud } = cfg()
  	if (!teamDomain) return null
  	const parts = token.split('.')
  	if (parts.length !== 3) return null
  	const [h, p, s] = parts as [string, string, string]
  	const head = b64urlToJson(h)
  	if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null
  	const jwk = await getJwk(teamDomain, head.kid)
  	if (!jwk) return null
  	const key = createPublicKey({ key: jwk, format: 'jwk' })
  	if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64urlToBuf(s))) return null
  	const payload = b64urlToJson(p)
  	const now = Math.floor(Date.now() / 1000)
  	if (typeof payload.exp === 'number' && payload.exp < now) return null
  	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null
  	if (payload.iss && payload.iss !== `https://${teamDomain}`) return null
  	const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  	if (aud && !auds.includes(aud)) return null
  	if (typeof payload.email !== 'string') return null
  	return { email: payload.email }
  }
  ```
  After (identical verification; returns whatever identity claims are present — `email` for humans, `common_name` for service tokens — requiring at least one):
  ```ts
  // Verify a Cf-Access-Jwt-Assertion and return its identity claims (email for
  // humans, common_name for service tokens), or null if the token is malformed /
  // unsigned-by-us / expired / wrong-audience / carries no identity claim.
  export async function verifyCfAccessClaims(
  	token: string,
  ): Promise<{ email?: string; commonName?: string } | null> {
  	const { teamDomain, aud } = cfg()
  	if (!teamDomain) return null
  	const parts = token.split('.')
  	if (parts.length !== 3) return null
  	const [h, p, s] = parts as [string, string, string]
  	const head = b64urlToJson(h)
  	if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null
  	const jwk = await getJwk(teamDomain, head.kid)
  	if (!jwk) return null
  	const key = createPublicKey({ key: jwk, format: 'jwk' })
  	if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64urlToBuf(s))) return null
  	const payload = b64urlToJson(p)
  	const now = Math.floor(Date.now() / 1000)
  	if (typeof payload.exp === 'number' && payload.exp < now) return null
  	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null
  	if (payload.iss && payload.iss !== `https://${teamDomain}`) return null
  	const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  	if (aud && !auds.includes(aud)) return null
  	const email = typeof payload.email === 'string' ? payload.email : undefined
  	const commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined
  	if (!email && !commonName) return null
  	return { email, commonName }
  }

  // Decode a Cf-Access-Jwt-Assertion's identity claims WITHOUT verifying its
  // signature — used only in header-trust mode, the same tunnel trust basis as
  // reading the Cf-Access-Authenticated-User-Email header. Returns null for a
  // malformed token or one carrying no identity claim.
  export function decodeCfAccessClaimsUnverified(
  	token: string,
  ): { email?: string; commonName?: string } | null {
  	const parts = token.split('.')
  	if (parts.length !== 3) return null
  	try {
  		const payload = b64urlToJson(parts[1] as string)
  		const email = typeof payload.email === 'string' ? payload.email : undefined
  		const commonName = typeof payload.common_name === 'string' ? payload.common_name : undefined
  		if (!email && !commonName) return null
  		return { email, commonName }
  	} catch {
  		return null
  	}
  }
  ```

- [ ] **Step 4: Rewire `getAccessIdentity` to use the widened verifier, output unchanged.** In the same file, in `getAccessIdentity`, the verified-mode branch. Before:
  ```ts
  		try {
  			const v = await verifyCfAccessJwt(jwt)
  			if (v) return { email: v.email, verified: true }
  		} catch (err) {
  			console.warn('[access] JWT verification error', err)
  		}
  		return null
  ```
  After (returns `{email, verified:true}` only when a verified email is present — identical to before; a service-token JWT with no email still falls through to `null`):
  ```ts
  		try {
  			const c = await verifyCfAccessClaims(jwt)
  			if (c?.email) return { email: c.email, verified: true }
  		} catch (err) {
  			console.warn('[access] JWT verification error', err)
  		}
  		return null
  ```

- [ ] **Step 5: Run the test — expect pass:**
  ```bash
  (cd server && bun src/access-identity.test.ts)
  ```
  Expected: `ok: access-identity refactor preserved`.

- [ ] **Step 6: Confirm no stale reference + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  grep -rn "verifyCfAccessJwt" server/src | grep -v node_modules || echo "no stale verifyCfAccessJwt references"
  bun run typecheck
  ```
  Expected: `no stale verifyCfAccessJwt references`; typecheck exit 0.

- [ ] **Step 7: Commit:**
  ```bash
  git add server/src/access-identity.ts server/src/access-identity.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(server): access-identity exposes verified claims (email + common_name)

  getAccessIdentity output unchanged (guarded); adds verifyCfAccessClaims +
  decodeCfAccessClaimsUnverified for the service-token path.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — `resolveCaller`: compose human + bot into the `Whoami` envelope (TDD)

**Files:**
- Create: `server/src/whoami.test.ts`
- Create: `server/src/whoami.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/whoami.test.ts`:
  ```ts
  // Run: bun src/whoami.test.ts   (from server/)
  // resolveCaller across anonymous / human / bot-in-map / unknown-token, in the
  // default header-trust mode (network-free).
  import assert from 'node:assert/strict'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-whoami-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(mapFile, '[tokens."codespace-3.access"]\nidentity = "🤖 codespace-3"\nscope = "read-write"\n')
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const { resolveCaller } = await import('./whoami.ts')

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

  assert.deepEqual(await resolveCaller({}), { identity: null, kind: 'anonymous', via: 'none' }, 'no headers → anonymous')

  assert.deepEqual(
  	await resolveCaller({ 'cf-access-authenticated-user-email': 'alice@example.com' }),
  	{ identity: 'alice@example.com', kind: 'human', via: 'sso' },
  	'email header → human',
  )

  assert.deepEqual(
  	await resolveCaller({ 'cf-access-jwt-assertion': jwt({ common_name: 'codespace-3.access' }) }),
  	{ identity: '🤖 codespace-3', kind: 'bot', via: 'service-token' },
  	'service-token in map → bot',
  )

  assert.deepEqual(
  	await resolveCaller({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
  	{ identity: null, kind: 'anonymous', via: 'none' },
  	'unknown service token → anonymous',
  )

  console.log('ok: resolveCaller')
  ```

- [ ] **Step 2: Run it — expect failure** (module missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/whoami.test.ts)
  ```
  Expected: `Cannot find module './whoami.ts'` / `Could not resolve`.

- [ ] **Step 3: Create `server/src/whoami.ts`:**
  ```ts
  /**
   * Resolve the caller's identity envelope for GET /api/whoami. Composes the
   * existing CF Access human path (access-identity.ts — verified/header/dev) with
   * the service-token bot path (service-tokens.ts), keyed by the token's
   * common_name. Additive: it enforces nothing; later slices reuse this same
   * resolution to stamp attribution and scope writes.
   */
  import type { IncomingHttpHeaders } from 'node:http'
  import type { Whoami } from '@ensembleworks/contracts'
  import {
  	accessVerificationEnabled,
  	decodeCfAccessClaimsUnverified,
  	getAccessIdentity,
  	verifyCfAccessClaims,
  } from './access-identity.ts'
  import { lookupServiceToken } from './service-tokens.ts'

  const JWT_HEADER = 'cf-access-jwt-assertion'

  function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  	const v = headers[name]
  	return Array.isArray(v) ? v[0] : v
  }

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

- [ ] **Step 4: Run the test — expect pass:**
  ```bash
  (cd server && bun src/whoami.test.ts)
  ```
  Expected: `ok: resolveCaller`.

- [ ] **Step 5: Typecheck green:**
  ```bash
  bun run typecheck
  ```

- [ ] **Step 6: Commit:**
  ```bash
  git add server/src/whoami.ts server/src/whoami.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): resolveCaller composes human + service-token into Whoami

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — `GET /api/whoami` route + mount

**Files:**
- Create: `server/src/features/whoami.ts`
- Create: `server/src/whoami-api.test.ts`
- Modify: `server/src/app.ts` (import + mount)

- [ ] **Step 1: Write the failing test.** Create `server/src/whoami-api.test.ts`:
  ```ts
  // Run: bun src/whoami-api.test.ts   (from server/)
  // Endpoint wiring: GET /api/whoami returns the resolved envelope. Header-trust
  // mode (network-free); the full resolution matrix is covered by whoami.test.ts.
  import assert from 'node:assert/strict'
  import { mkdtemp } from 'node:fs/promises'
  import os from 'node:os'
  import path from 'node:path'
  import { createSyncApp } from './app.ts'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'whoami-api-'))
  const { server } = createSyncApp({ dataDir })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  // anonymous
  {
  	const res = await fetch(`${base}/api/whoami`)
  	assert.equal(res.status, 200, 'whoami responds 200')
  	assert.deepEqual(await res.json(), { identity: null, kind: 'anonymous', via: 'none' }, 'anonymous envelope')
  }
  // human via the CF Access email header
  {
  	const res = await fetch(`${base}/api/whoami`, {
  		headers: { 'Cf-Access-Authenticated-User-Email': 'carol@example.com' },
  	})
  	assert.deepEqual(await res.json(), { identity: 'carol@example.com', kind: 'human', via: 'sso' }, 'human envelope')
  }

  server.close()
  console.log('whoami-api.test.ts: all assertions passed')
  process.exit(0)
  ```

- [ ] **Step 2: Run it — expect failure** (route not mounted → 404, so the anonymous assertion's `res.status === 200` fails, or the router module is missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/whoami-api.test.ts)
  ```
  Expected: FAIL (404 / assertion error) — the route isn't wired yet.

- [ ] **Step 3: Create the router `server/src/features/whoami.ts`:**
  ```ts
  /**
   * Auth-plane foundation route: GET /api/whoami returns the caller's identity
   * envelope (human|bot|anonymous + via) via resolveCaller. A kernel/auth route —
   * deliberately not plugin-namespaced, and untouched by the sub-project 3a route
   * rename.
   */
  import express from 'express'
  import { resolveCaller } from '../whoami.ts'

  export function createWhoamiRouter(): express.Router {
  	const router = express.Router()
  	router.get('/api/whoami', async (req, res) => {
  		res.json(await resolveCaller(req.headers))
  	})
  	return router
  }
  ```

- [ ] **Step 4: Mount it in `app.ts`.** Add the import alongside the other feature-router imports (after `import { createUploadsRouter } from './features/uploads.ts'`):
  ```ts
  import { createWhoamiRouter } from './features/whoami.ts'
  ```
  Then mount it as a kernel/auth route — right after the `/api/gateway/list` line and before `app.use(createAvRouter(ctx))`. Before:
  ```ts
  	const gatewayPlane = createGatewayPlane()
  	app.get('/api/gateway/list', gatewayPlane.listHandler)

  	app.use(createAvRouter(ctx))
  ```
  After:
  ```ts
  	const gatewayPlane = createGatewayPlane()
  	app.get('/api/gateway/list', gatewayPlane.listHandler)

  	// Auth-plane foundation: caller identity envelope (human|bot|anonymous).
  	app.use(createWhoamiRouter())

  	app.use(createAvRouter(ctx))
  ```

- [ ] **Step 5: Run the test — expect pass:**
  ```bash
  (cd server && bun src/whoami-api.test.ts)
  ```
  Expected: `whoami-api.test.ts: all assertions passed`.

- [ ] **Step 6: Full gate — typecheck, whole suite, build:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  bun run test     # ends "all N suites passed" (N = previous + 5 new suites)
  bun run build    # client (Vite under Bun) + server + transcriber
  ```
  Expected: all exit 0; the suite count is the prior total + 5.

- [ ] **Step 7: Commit:**
  ```bash
  git add server/src/features/whoami.ts server/src/whoami-api.test.ts server/src/app.ts
  git commit -m "$(cat <<'EOF'
  feat(server): GET /api/whoami — caller identity envelope

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: record the confirmed CF Access service-token claim used for `common_name` (the verify-step), the final `bun run test` suite count, and any deviation from the verbatim blocks above.)_
