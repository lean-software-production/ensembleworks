# Browser `ew auth login` (Cloudflare Access) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ew auth login` against an Access-fronted canvas becomes the gh-style flow — probe the URL, open the browser for the same GitHub SSO the canvas uses, store the long-lived Access **org token** in `hosts.toml` under a new `access-browser` method — and every later `ew` command (and every connector (re)spawn under the SP2 supervisor) silently mints a fresh short-lived **app token** from it, sent as the `cf-access-token` header.

**Architecture:** Sub-project 5 of `docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md` (§6.5), implementing `docs/2026-07-21-ew-auth-design.md` under the four binding SP5 decisions in `docs/superpowers/plans/2026-07-21-ew-codespaces-decision-log.md`: native implementation (no cloudflared dependency), all unit tests against a fake Access server, token refresh = supervisor re-exec with fresh env, storage plaintext-0600 `hosts.toml`. The server side is **untouched** — `server/src/access-identity.ts` keeps verifying `Cf-Access-Jwt-Assertion`, which the Cloudflare edge injects after validating our `cf-access-token` header. Everything lands in `cli/src/auth/` plus small seams in `resolve.ts`, `dispatch.ts`, `native/connect.ts`, `connector/relay-client.ts`, and (add-if-absent) `codespace/up.ts`.

**Tech Stack:** Bun + TypeScript. Tests are plain `bun <file>` scripts using `node:assert/strict` (no test framework — the repo's `**/src/**/*.test.ts` glob picks them up). One new dependency: `tweetnacl` (NaCl box decryption for the Access token transfer — same primitive cloudflared uses).

**Branch:** continue on `docs/ew-codespaces-design` (the program branch, PR #53). Do not branch.

**Interaction contracts:** `ux-contract: none — CLI auth tooling; no interaction-bearing surface` (record verbatim in the PR body).

**Commit trailer:** every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Discovery findings — how Access CLI login actually works

Pinned 2026-07-21 against cloudflared `master` source (`token/token.go`, `token/transfer.go`, `token/encrypt.go`) and Cloudflare One docs. **The auth design doc's §1 "loopback listener" assumption is wrong** — this plan implements the real mechanism.

### Verified (read directly from source/docs)

1. **Probe / app-info discovery** (`token.go` `GetAppInfo`): an unauthenticated request to the app URL redirects to
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<app-domain>?kid=<AUD>&…`.
   The Access application **AUD is the `kid` query parameter** of that redirect; the **team domain is its hostname**. (cloudflared uses HEAD + follows until the path contains `/cdn-cgi/access/login`; a plain 200 with no redirect means no Access in front.)
2. **Browser leg — there is NO loopback listener.** cloudflared generates a **NaCl box keypair** (`box.GenerateKey`, Curve25519/XSalsa20-Poly1305; public key encoded `base64.URLEncoding` — padded, URL-safe) and opens the browser at the **app origin**:
   `https://<app>/cdn-cgi/access/cli?token=<publicKey>&aud=<AUD>&redirect_url=<app>&send_org_token=true&edge_token_transfer=true`.
   The CLI then **long-polls Cloudflare's transfer store** `https://login.cloudflareaccess.org/transfer/<publicKey>` — non-200 means "user hasn't finished SSO yet"; on 200 the body is std-base64 of `nonce(24 bytes) ‖ box-ciphertext`, the sender's public key rides the **`service-public-key` response header**, and NaCl `box.open` yields JSON `{"app_token": "…", "org_token": "…"}` (`transferServiceResponse` in `token.go`). Delivery rides Cloudflare's store keyed by our public key — so the login URL can be opened on **any** machine (the SSH'd-into-a-worker-VM case needs zero extra code: print the URL, keep polling).
3. **Org token → app token, browser-free** (`token.go` `exchangeOrgToken`/`handleRedirects`): request the app URL following redirects manually; when redirected to a path containing `/cdn-cgi/access/login`, attach cookie `CF_Authorization=<org token>`; when redirected to `/cdn-cgi/access/authorized`, attach the `CF_AppSession` cookie observed en route; **stop at the authorized response — its `CF_Authorization` Set-Cookie IS the app token**. Pure HTTP; this is the silent refresh.
4. **Sending the app token**: Access evaluates the **`cf-access-token` request header** on every request ([Cloudflare One "Connect through Cloudflare Access using a CLI" tutorial](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) — it is what `cloudflared access curl` injects). The edge validates it and forwards `Cf-Access-Jwt-Assertion` to the origin — exactly what `server/src/access-identity.ts` already verifies. **Not** `Authorization:`; that shape is for service-token pairs.
5. **Local token validation**: cloudflared checks only the JWT payload's `exp` before reuse (no signature verification client-side — the edge is the verifier). We do the same.

### Assumed (could not be verified without a live Access org — each has a manual-e2e verification step in Task 13)

- The transfer-store behavior at `https://login.cloudflareaccess.org/` (long-poll semantics, 200-on-ready, exact base64 variant of the `service-public-key` header, `=`-padded pubkey in the URL path). Read from client source; the service itself is unobservable offline. Our decoder is deliberately tolerant of std vs URL-safe base64.
- That `send_org_token=true` returns an `org_token` under every org configuration (could conceivably be policy-gated).
- `cf-access-token` acceptance on **WebSocket upgrade** requests through the edge (an upgrade is an HTTP request, so expected; docs only show plain HTTP).
- Post-login browser landing behavior of `redirect_url` (cosmetic — token delivery does not depend on it).
- App/org token lifetimes (typically ~24 h app / longer org; org-configurable — the code never hardcodes a lifetime, only reads `exp`).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `cli/package.json` | Modify | Add `tweetnacl` dependency |
| `cli/src/hosts.ts` | Modify | `InstanceRecord` method `'access-browser'` + `org_token`/`app_token`/`team_domain`/`aud` fields |
| `cli/src/hosts.test.ts` | Modify | Round-trip + logout coverage for the new record shape |
| `cli/src/auth/access.ts` | Create | The native Access client: probe, JWT decode helpers, transfer keys/URL/decrypt, poll, `browserLogin`, `exchangeOrgToken`, injectable deps |
| `cli/src/auth/access.test.ts` | Create | Probe / crypto / poll / browser-flow / exchange tests against the fake |
| `cli/src/auth/fake-access.ts` | Create | Test-support fake of the three Access surfaces (app origin, team login/authorized, transfer store) — one loopback `Bun.serve`; **never imported by production code** |
| `cli/src/resolve.ts` | Modify | `Auth` gains `{ method: 'access'; appToken }`; `ENSEMBLEWORKS_ACCESS_TOKEN` env; `authHeaders` emits `cf-access-token` |
| `cli/src/resolve.test.ts` | Modify | Env precedence + header emission tests |
| `cli/src/auth/fresh.ts` | Create | `ensureFreshAppToken` (cache-or-mint + persist), `resolveConnFresh`, `refreshConnAuth` (the SP2 re-exec seam) |
| `cli/src/auth/fresh.test.ts` | Create | Cache reuse / mint+persist / expired-org error, on a temp hosts file + fake |
| `cli/src/auth/login.ts` | Modify | Probe-driven method resolution; the access-browser login flow |
| `cli/src/auth/token.ts` | Create | `ew auth token` — print a fresh app token for scripting |
| `cli/src/auth/status.ts` | Modify | Per-host STATE incl. the distinct `credential expired`; injectable fetch |
| `cli/src/auth/status-token.test.ts` | Create | status states + token verb, against the fake + temp hosts |
| `cli/src/dispatch.ts` | Modify | `--method access-browser`; `auth token` verb; `resolveConnFresh` at the conn seam; access env passthrough to extensions |
| `cli/src/native/connect.ts` | Modify | `resolveConnFresh`; `authMethod` union widened |
| `cli/src/connector/relay-client.ts` | Modify | `AuthRejectedError`: 401/403/302-to-Access on dial is fatal (exit → supervisor re-execs with fresh token) |
| `cli/src/connector/auth-reject.test.ts` | Create | Fatal-vs-retry dial rejection |
| `cli/src/codespace/up.ts` | Modify (add-if-absent) | `buildExecArgv` access branch (`ENSEMBLEWORKS_ACCESS_TOKEN`, REDACTED in dry-run); per-respawn `refreshConnAuth` in the supervise loop |
| `cli/src/codespace/up.test.ts` | Modify (add-if-absent) | Access-branch argv + redaction assertions |

---

### Task 1: `tweetnacl` dependency

The transfer response is NaCl-box encrypted (Discovery #2). `tweetnacl` is the canonical JS port of the exact primitive (`box.keyPair`/`box.open`), ~50 KB, zero deps, ships its own types.

**Files:**
- Modify: `cli/package.json`

- [ ] **Step 1: Add the dependency**

In `cli/package.json`, add to `"dependencies"` (after `"smol-toml"`):

```json
		"tweetnacl": "^1.0.3",
```

Run: `bun install`
Expected: lockfile updates, exit 0.

- [ ] **Step 2: Verify it loads under Bun**

Run: `bun -e "import nacl from 'tweetnacl'; const k = nacl.box.keyPair(); console.log('ok', k.publicKey.length, k.secretKey.length)"`
Expected: `ok 32 32`

- [ ] **Step 3: Commit**

```bash
git add cli/package.json bun.lock
git commit -m "chore(cli): add tweetnacl — NaCl box decrypt for the Access token transfer" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `hosts.toml` schema — the `access-browser` record

**Files:**
- Modify: `cli/src/hosts.ts:12-18` (`InstanceRecord`)
- Test: `cli/src/hosts.test.ts` (append at end, before the final `console.log`)

- [ ] **Step 1: Write the failing test**

Append to `cli/src/hosts.test.ts` (before its final `console.log` line):

```ts
// access-browser records (SP5): org/app tokens + team domain + aud round-trip
// losslessly; logout removes the whole record (tokens leave the disk with it).
{
	let h: HostsFile = { instances: {} }
	h = setInstance(h, 'https://canvas.leansoftware.ai', {
		method: 'access-browser',
		org_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-org',
		app_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-app',
		team_domain: 'lean-software.cloudflareaccess.com',
		aud: 'a1b2c3d4e5f6',
		default_room: 'team',
		identity: 'sam@leansoftware.ai',
	})
	const f = path.join(dir, 'access.toml')
	saveHosts(f, h)
	const back = loadHosts(f)
	assert.deepEqual(back.instances['https://canvas.leansoftware.ai'], {
		method: 'access-browser',
		org_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-org',
		app_token: 'eyJhbGciOiJSUzI1NiJ9.e30.sig-app',
		team_domain: 'lean-software.cloudflareaccess.com',
		aud: 'a1b2c3d4e5f6',
		default_room: 'team',
		identity: 'sam@leansoftware.ai',
	}, 'access-browser record round-trips losslessly')
	assert.equal(statSync(f).mode & 0o777, 0o600, 'still written 0600')
	// logout drops the record — and with it every stored token.
	const out = removeInstance(back, 'https://canvas.leansoftware.ai')
	assert.equal(out.instances['https://canvas.leansoftware.ai'], undefined, 'logout removes tokens with the record')
	console.log('ok: hosts — access-browser record round-trip + logout')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/hosts.test.ts`
Expected: FAIL — typecheck-level: `'access-browser'` is not assignable to `InstanceRecord['method']` (bun surfaces it as a runtime type error only via tsc; the deepEqual itself passes since the parser is schema-less — so ALSO run `cd cli && bunx tsc --noEmit` and expect the assignability error). Either failure counts as RED.

- [ ] **Step 3: Write minimal implementation**

Replace `InstanceRecord` in `cli/src/hosts.ts`:

```ts
export interface InstanceRecord {
	method: 'service-token' | 'none' | 'access-browser'
	token_id?: string
	token_secret?: string
	/** access-browser (SP5): the long-lived Access org token — THE stored credential */
	org_token?: string
	/** access-browser: cached short-lived app token; re-minted from org_token when stale */
	app_token?: string
	/** access-browser: <team>.cloudflareaccess.com host, discovered from the probe redirect */
	team_domain?: string
	/** access-browser: the Access application AUD tag (the login redirect's kid param) */
	aud?: string
	default_room?: string
	identity?: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/hosts.test.ts && cd cli && bunx tsc --noEmit && cd ..`
Expected: PASS incl. `ok: hosts — access-browser record round-trip + logout`; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add cli/src/hosts.ts cli/src/hosts.test.ts
git commit -m "feat(cli): hosts.toml access-browser method — org/app token, team domain, aud fields" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `access.ts` part 1 — JWT helpers + the probe

**Files:**
- Create: `cli/src/auth/access.ts`
- Create: `cli/src/auth/access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/auth/access.test.ts`:

```ts
// Native Access client (SP5, discovery-pinned against cloudflared master):
// this file grows with access.ts across Tasks 3-6. Network-free — every
// server is a loopback Bun.serve. Run with: bun src/auth/access.test.ts
import assert from 'node:assert/strict'
import { decodeJwtPayload, jwtEmail, jwtExpired, probeAccess } from './access.ts'
import { makeJwt } from './fake-access.ts'

// -- JWT helpers: decode-only (the edge verifies signatures, we never do) -----
{
	const t = makeJwt({ email: 'sam@example.com', exp: 1_000_000 })
	assert.equal(decodeJwtPayload(t)?.email, 'sam@example.com')
	assert.equal(jwtEmail(t), 'sam@example.com')
	assert.equal(decodeJwtPayload('not-a-jwt'), null)
	assert.equal(jwtEmail('not-a-jwt'), undefined)
	// exp is in SECONDS (1_000_000 s = 1_000_000_000 ms); ms comparisons with a
	// default 60s skew.
	assert.equal(jwtExpired(t, 1_000_000_000 - 61_000), false, '61s before exp → fresh')
	assert.equal(jwtExpired(t, 1_000_000_000 - 59_000), true, 'inside the 60s skew → treated expired')
	assert.equal(jwtExpired(t, 1_000_000_001 * 1000), true, 'past exp → expired')
	assert.equal(jwtExpired('garbage', 0), true, 'undecodable → expired')
	assert.equal(jwtExpired(makeJwt({ email: 'x@y' }), 0), true, 'no exp claim → expired')
	console.log('ok: access — jwt decode/expiry helpers')
}

// -- probeAccess: the three §1 outcomes ---------------------------------------
{
	// One fake origin that answers per-path so all outcomes share a server.
	const srv = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req) {
			const u = new URL(req.url)
			if (u.pathname === '/open') return new Response('canvas', { status: 200 })
			if (u.pathname === '/broken') return new Response('boom', { status: 500 })
			if (u.pathname === '/elsewhere')
				return new Response(null, { status: 302, headers: { location: 'https://example.com/not-access' } })
			// default: behind Access → 302 to the team login carrying kid=AUD
			return new Response(null, {
				status: 302,
				headers: { location: `http://127.0.0.1:${srv.port}/fake-team/cdn-cgi/access/login/app.example?kid=aud-42&meta=1` },
			})
		},
	})
	const deps = { fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init) }
	try {
		const access = await probeAccess(`http://127.0.0.1:${srv.port}/`, deps)
		assert.deepEqual(access, { kind: 'access', teamDomain: `127.0.0.1:${srv.port}`, aud: 'aud-42' },
			'302-to-Access → team domain from Location host, AUD from kid — never prompted (design §1)')

		const open = await probeAccess(`http://127.0.0.1:${srv.port}/open`, deps)
		assert.deepEqual(open, { kind: 'open' }, 'plain 200 → no auth boundary')

		await assert.rejects(() => probeAccess(`http://127.0.0.1:${srv.port}/broken`, deps), /500/,
			'anything else → clear error, nothing stored')
		await assert.rejects(() => probeAccess(`http://127.0.0.1:${srv.port}/elsewhere`, deps), /not Cloudflare Access/,
			'redirect to a non-Access target → clear error')
	} finally {
		srv.stop(true)
	}
	console.log('ok: access — probe detects behind-Access / open / error')
}
```

Also create the fake's shared JWT builder — create `cli/src/auth/fake-access.ts` with (the server itself arrives in Task 5; only `makeJwt` is needed now):

```ts
/**
 * Test-support fake of the Cloudflare Access surfaces the CLI talks to (SP5).
 * NEVER imported by production code; not matched by the *.test.ts discovery
 * glob, so it is a plain module, not a suite.
 */

/** An unsigned-but-well-formed JWT (we only ever DECODE payloads client-side —
 *  Discovery #5: the edge is the verifier). */
export function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
	return `${enc({ alg: 'RS256', kid: 'fake-kid' })}.${enc(payload)}.${Buffer.from('fake-sig').toString('base64url')}`
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/access.test.ts`
Expected: FAIL — cannot resolve `./access.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `cli/src/auth/access.ts`:

```ts
/**
 * Native Cloudflare Access CLI login (SP5 — auth design doc §1-§3), the same
 * mechanics as `cloudflared access login`, reimplemented on fetch + tweetnacl
 * so `ew` stays one binary. Pinned against cloudflared master (token/token.go,
 * transfer.go, encrypt.go — see the plan's Discovery findings):
 *   probe    : unauthenticated GET; behind Access ⇒ 302 whose Location is
 *              https://<team>/cdn-cgi/access/login/<app>?kid=<AUD>
 *   browser  : open <app>/cdn-cgi/access/cli?token=<pubkey>&aud=…&
 *              send_org_token=true&edge_token_transfer=true, long-poll
 *              <store>/transfer/<pubkey> for the NaCl-boxed
 *              {app_token, org_token} JSON. NO loopback listener — delivery
 *              rides Cloudflare's transfer store, so the printed URL works
 *              from ANY machine (headless-host relay for free, design §3).
 *   exchange : org token ⇒ app token browser-free via the login/authorized
 *              redirect dance with CF_Authorization / CF_AppSession cookies.
 * All network + browser + clock access goes through AccessDeps so every unit
 * test runs against a loopback fake.
 */
import nacl from 'tweetnacl'
import { CliError } from '../errors.ts'
import { narrate } from '../output.ts'

export const ACCESS_LOGIN_PATH = '/cdn-cgi/access/login'
export const ACCESS_AUTHORIZED_PATH = '/cdn-cgi/access/authorized'
/** cloudflared's transfer store (transfer.go baseStoreURL). Unverifiable
 *  offline — manual-e2e item #2 confirms it against a live team. */
export const DEFAULT_TRANSFER_STORE = 'https://login.cloudflareaccess.org/'

export interface AccessDeps {
	fetch: typeof fetch
	/** open a URL in the user's browser; false ⇒ print-URL fallback */
	openBrowser: (url: string) => Promise<boolean>
	/** transfer-store base URL; tests point it at the fake */
	storeBaseUrl: string
	now: () => number
	pollIntervalMs: number
	pollTimeoutMs: number
}

export function realAccessDeps(): AccessDeps {
	return {
		fetch: (input, init) => fetch(input, init),
		openBrowser: openBrowserReal,
		storeBaseUrl: DEFAULT_TRANSFER_STORE,
		now: () => Date.now(),
		pollIntervalMs: 2_000,
		pollTimeoutMs: 300_000, // 5 min — a full first-time SSO can be slow
	}
}

/** Best-effort platform browser open; false (never throw) when unavailable. */
export async function openBrowserReal(url: string): Promise<boolean> {
	const cmd =
		process.platform === 'darwin' ? ['open', url]
		: process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url]
		: ['xdg-open', url]
	try {
		const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
		return (await p.exited) === 0
	} catch {
		return false
	}
}

// -- JWT payload helpers (decode-only; Discovery #5: the edge verifies) -------

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.')
	if (parts.length !== 3) return null
	try {
		return JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
	} catch {
		return null
	}
}

/** true when undecodable, exp-less, or exp within skewMs of nowMs. */
export function jwtExpired(token: string, nowMs: number, skewMs = 60_000): boolean {
	const p = decodeJwtPayload(token)
	if (!p || typeof p.exp !== 'number') return true
	return p.exp * 1000 <= nowMs + skewMs
}

export function jwtEmail(token: string): string | undefined {
	const p = decodeJwtPayload(token)
	return p && typeof p.email === 'string' ? p.email : undefined
}

// -- Probe (design §1 step 1 / cloudflared GetAppInfo) ------------------------

export type ProbeResult =
	| { kind: 'access'; teamDomain: string; aud: string }
	| { kind: 'open' }

/** Hit the origin unauthenticated. 2xx ⇒ open; 3xx to
 *  …/cdn-cgi/access/login/…?kid=<AUD> ⇒ behind Access (team domain + AUD
 *  discovered from the redirect — the URL is the only thing the user types);
 *  anything else ⇒ CliError, nothing stored. */
export async function probeAccess(originUrl: string, deps: Pick<AccessDeps, 'fetch'>): Promise<ProbeResult> {
	let res: Response
	try {
		res = await deps.fetch(originUrl, { redirect: 'manual' })
	} catch (err) {
		throw new CliError(`could not reach ${originUrl}: ${(err as Error).message}`)
	}
	if (res.status >= 200 && res.status < 300) return { kind: 'open' }
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location')
		if (loc) {
			const u = new URL(loc, originUrl)
			if (u.pathname.includes(ACCESS_LOGIN_PATH)) {
				const aud = u.searchParams.get('kid')
				if (!aud) throw new CliError(`Access login redirect carries no kid (AUD): ${u.href}`)
				return { kind: 'access', teamDomain: u.host, aud }
			}
		}
		throw new CliError(`probe: ${originUrl} redirects to ${loc ?? '(no Location)'} — not Cloudflare Access; refusing to store anything`)
	}
	throw new CliError(`probe: ${originUrl} answered ${res.status} — neither an open canvas nor behind Access`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/auth/access.test.ts`
Expected: PASS — both `ok:` lines.

- [ ] **Step 5: Commit**

```bash
git add cli/src/auth/access.ts cli/src/auth/access.test.ts cli/src/auth/fake-access.ts
git commit -m "feat(cli): Access probe + jwt helpers — team domain and AUD discovered from the 302" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `access.ts` part 2 — transfer keys, login URL, decrypt (pure crypto)

**Files:**
- Modify: `cli/src/auth/access.ts` (append)
- Test: `cli/src/auth/access.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `cli/src/auth/access.test.ts` (extend the import from `./access.ts` with `buildCliLoginUrl, decryptTransfer, generateTransferKeys`, and add `import nacl from 'tweetnacl'` at the top):

```ts
// -- Transfer crypto: keypair, login URL, NaCl-box decrypt --------------------
{
	const keys = generateTransferKeys()
	// Go base64.URLEncoding parity: URL-safe alphabet WITH '=' padding — the
	// edge stores the token under this exact string (Discovery #2).
	assert.match(keys.publicKeyB64, /^[A-Za-z0-9_-]+={0,2}$/, 'URL-safe base64')
	assert.equal(Buffer.from(keys.publicKeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 32, '32-byte Curve25519 key')

	const url = new URL(buildCliLoginUrl('https://canvas.example.com', 'aud-42', keys.publicKeyB64))
	assert.equal(url.origin, 'https://canvas.example.com', 'CLI-login page lives on the APP origin')
	assert.equal(url.pathname, '/cdn-cgi/access/cli')
	assert.equal(url.searchParams.get('token'), keys.publicKeyB64)
	assert.equal(url.searchParams.get('aud'), 'aud-42')
	assert.equal(url.searchParams.get('send_org_token'), 'true', 'org token requested — the host is the refresher (design §2)')
	assert.equal(url.searchParams.get('edge_token_transfer'), 'true')
	assert.equal(url.searchParams.get('redirect_url'), 'https://canvas.example.com')

	// Round-trip: seal as the service would (nonce ‖ box, std base64 body,
	// service public key alongside) and decrypt.
	const service = nacl.box.keyPair()
	const plain = new TextEncoder().encode(JSON.stringify({ app_token: 'app.jwt', org_token: 'org.jwt' }))
	const nonce = nacl.randomBytes(24)
	const clientPub = new Uint8Array(Buffer.from(keys.publicKeyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
	const boxed = nacl.box(plain, nonce, clientPub, service.secretKey)
	const body = Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString('base64')
	const servicePubB64 = Buffer.from(service.publicKey).toString('base64')

	const out = decryptTransfer(body, servicePubB64, keys.secretKey)
	assert.deepEqual(out, { app_token: 'app.jwt', org_token: 'org.jwt' })

	// Tolerant of a URL-safe-encoded service key (unverified encoding detail).
	const outUrlSafe = decryptTransfer(body, Buffer.from(service.publicKey).toString('base64url'), keys.secretKey)
	assert.deepEqual(outUrlSafe, { app_token: 'app.jwt', org_token: 'org.jwt' })

	// Tampered ciphertext → CliError, never garbage.
	const bad = Buffer.from(body, 'base64')
	bad[bad.length - 1] ^= 0xff
	assert.throws(() => decryptTransfer(bad.toString('base64'), servicePubB64, keys.secretKey), /decrypt/i)
	console.log('ok: access — transfer keys, cli login url, nacl-box decrypt')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/access.test.ts`
Expected: FAIL — `generateTransferKeys` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `cli/src/auth/access.ts`:

```ts
// -- Token transfer (design §1 step 2 / cloudflared transfer.go + encrypt.go) --

export interface TransferKeys {
	/** Go base64.URLEncoding of the 32-byte Curve25519 public key (padded,
	 *  URL-safe) — the transfer-store key AND the browser URL's token param. */
	publicKeyB64: string
	secretKey: Uint8Array
}

function b64urlPadded(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Tolerant base64 (accepts std and URL-safe alphabets, padded or not). */
function b64decode(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

export function generateTransferKeys(): TransferKeys {
	const kp = nacl.box.keyPair()
	return { publicKeyB64: b64urlPadded(kp.publicKey), secretKey: kp.secretKey }
}

/** The browser-leg URL — on the APP origin (cloudflared buildRequestURL):
 *  /cdn-cgi/access/cli?token=<pubkey>&aud=…&redirect_url=<origin>&
 *  send_org_token=true&edge_token_transfer=true */
export function buildCliLoginUrl(originUrl: string, aud: string, publicKeyB64: string): string {
	const u = new URL('/cdn-cgi/access/cli', originUrl)
	u.searchParams.set('token', publicKeyB64)
	u.searchParams.set('aud', aud)
	u.searchParams.set('redirect_url', new URL(originUrl).origin)
	u.searchParams.set('send_org_token', 'true')
	u.searchParams.set('edge_token_transfer', 'true')
	return u.toString()
}

export interface TransferTokens {
	app_token: string
	org_token: string
}

/** Body = std-base64(nonce(24) ‖ nacl.box ciphertext); sender key rides the
 *  service-public-key header (encrypt.go). Throws CliError on any mismatch. */
export function decryptTransfer(bodyB64: string, servicePublicKeyB64: string, secretKey: Uint8Array): TransferTokens {
	const data = b64decode(bodyB64)
	if (data.length <= 24) throw new CliError('transfer response too short to decrypt')
	const nonce = data.slice(0, 24)
	const opened = nacl.box.open(data.slice(24), nonce, b64decode(servicePublicKeyB64), secretKey)
	if (!opened) throw new CliError('failed to decrypt transfer response (key mismatch or corrupt payload)')
	let parsed: { app_token?: unknown; org_token?: unknown }
	try {
		parsed = JSON.parse(new TextDecoder().decode(opened))
	} catch {
		throw new CliError('decrypted transfer response is not JSON')
	}
	if (typeof parsed.app_token !== 'string' || parsed.app_token === '')
		throw new CliError('transfer response carries no app_token')
	if (typeof parsed.org_token !== 'string' || parsed.org_token === '')
		throw new CliError('transfer response carries no org_token — cannot refresh silently; is send_org_token honored for this org? (see manual-e2e item 2c)')
	return { app_token: parsed.app_token, org_token: parsed.org_token }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/auth/access.test.ts`
Expected: PASS — three `ok:` lines.

- [ ] **Step 5: Commit**

```bash
git add cli/src/auth/access.ts cli/src/auth/access.test.ts
git commit -m "feat(cli): Access transfer crypto — curve25519 keys, cli-login URL, nacl-box decrypt" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: the fake Access server + poll + `browserLogin`

**Files:**
- Modify: `cli/src/auth/fake-access.ts` (grow into the full fake)
- Modify: `cli/src/auth/access.ts` (append `pollTransferStore`, `browserLogin`)
- Test: `cli/src/auth/access.test.ts` (append)

- [ ] **Step 1: Write the full fake**

Replace `cli/src/auth/fake-access.ts` with:

```ts
/**
 * Test-support fake of the three Cloudflare Access surfaces the CLI talks to
 * (SP5): the app origin behind Access, the team-domain login/authorized dance,
 * and the transfer store — one Bun.serve on a loopback ephemeral port plays
 * all three, so every SP5 unit test is network-free. NEVER imported by
 * production code; not matched by the *.test.ts discovery glob.
 */
import nacl from 'tweetnacl'

/** An unsigned-but-well-formed JWT (we only ever DECODE payloads client-side —
 *  Discovery #5: the edge is the verifier). */
export function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
	return `${enc({ alg: 'RS256', kid: 'fake-kid' })}.${enc(payload)}.${Buffer.from('fake-sig').toString('base64url')}`
}

export interface FakeAccess {
	origin: string
	storeBaseUrl: string
	aud: string
	email: string
	orgToken: string
	appToken: string
	/** simulate the user finishing SSO in a browser for the given pubkey */
	completeLogin: (publicKeyB64: string) => void
	/** swap the org token (e.g. for an expired one) */
	setOrgToken: (t: string) => void
	/** method+path log, for zero-network assertions */
	requests: string[]
	stop: () => void
}

export function startFakeAccess(opts: { email?: string; orgExpSec?: number; appExpSec?: number } = {}): FakeAccess {
	const email = opts.email ?? 'sam@example.com'
	const aud = 'fake-aud-1234'
	const nowSec = Math.floor(Date.now() / 1000)
	let orgToken = makeJwt({ email, exp: nowSec + (opts.orgExpSec ?? 3600) })
	const appToken = makeJwt({ email, aud, exp: nowSec + (opts.appExpSec ?? 3600) })
	const serviceKeys = nacl.box.keyPair()
	const completed = new Set<string>()
	const requests: string[] = []

	const fromB64url = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))

	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req) {
			const u = new URL(req.url)
			requests.push(`${req.method} ${u.pathname}`)
			const origin = `http://127.0.0.1:${server.port}`
			const cookie = req.headers.get('cookie') ?? ''

			// 1. Transfer store: 404 until completeLogin(pubkey); then the
			// nacl-boxed {app_token, org_token} JSON (Discovery #2).
			if (u.pathname.startsWith('/store/transfer/')) {
				const key = decodeURIComponent(u.pathname.slice('/store/transfer/'.length))
				if (!completed.has(key)) return new Response('pending login', { status: 404 })
				const nonce = nacl.randomBytes(24)
				const plain = new TextEncoder().encode(JSON.stringify({ app_token: appToken, org_token: orgToken }))
				const boxed = nacl.box(plain, nonce, fromB64url(key), serviceKeys.secretKey)
				return new Response(Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString('base64'), {
					status: 200,
					headers: { 'service-public-key': Buffer.from(serviceKeys.publicKey).toString('base64') },
				})
			}

			// 2. Team-domain login (the org→app exchange leg, Discovery #3):
			// valid CF_Authorization=<org token> cookie → 302 to authorized,
			// planting CF_AppSession; otherwise the interactive login page (200,
			// no redirect — a browser-only dead end for the exchange).
			if (u.pathname.includes('/cdn-cgi/access/login')) {
				if (cookie.includes(`CF_Authorization=${orgToken}`)) {
					return new Response(null, {
						status: 302,
						headers: {
							location: `${origin}/cdn-cgi/access/authorized?code=fake`,
							'set-cookie': 'CF_AppSession=fake-app-session; Path=/; HttpOnly',
						},
					})
				}
				return new Response('<html>interactive SSO page</html>', { status: 200 })
			}

			// 3. Authorized endpoint: needs the CF_AppSession planted above; its
			// CF_Authorization Set-Cookie IS the app token (Discovery #3).
			if (u.pathname.includes('/cdn-cgi/access/authorized')) {
				if (!cookie.includes('CF_AppSession=fake-app-session')) return new Response('missing app session', { status: 400 })
				return new Response(null, {
					status: 302,
					headers: { location: `${origin}/`, 'set-cookie': `CF_Authorization=${appToken}; Path=/; HttpOnly` },
				})
			}

			// 4. The canvas's whoami, reachable with a valid cf-access-token
			// header (Discovery #4; what verifyWhoami and auth status hit).
			if (u.pathname === '/api/whoami') {
				if (req.headers.get('cf-access-token') === appToken)
					return Response.json({ identity: `sso:${email}`, kind: 'user', via: 'access' })
				return new Response('forbidden', { status: 403 })
			}

			// 5. Everything else on the app origin: behind Access → 302 to the
			// team login carrying kid=<AUD> (what probeAccess parses).
			return new Response(null, {
				status: 302,
				headers: { location: `${origin}/team/cdn-cgi/access/login/app.example?kid=${aud}&meta=1` },
			})
		},
	})

	return {
		origin: `http://127.0.0.1:${server.port}`,
		storeBaseUrl: `http://127.0.0.1:${server.port}/store/`,
		aud,
		email,
		orgToken,
		appToken,
		completeLogin: (k) => completed.add(k),
		setOrgToken: (t) => {
			orgToken = t
		},
		requests,
		stop: () => server.stop(true),
	}
}
```

- [ ] **Step 2: Write the failing test**

Append to `cli/src/auth/access.test.ts` (extend the `./access.ts` import with `browserLogin, pollTransferStore, type AccessDeps`; extend the `./fake-access.ts` import with `startFakeAccess`):

```ts
// -- browserLogin end-to-end against the fake ---------------------------------
{
	const fake = startFakeAccess()
	const opened: string[] = []
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		// The "browser": records the URL and completes SSO for the pubkey it
		// carries — exactly what a human's zero-click Access bounce does.
		openBrowser: async (u) => {
			opened.push(u)
			fake.completeLogin(new URL(u).searchParams.get('token')!)
			return true
		},
		storeBaseUrl: fake.storeBaseUrl,
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 2_000,
	}
	try {
		const res = await browserLogin(fake.origin, { teamDomain: 'team.example', aud: fake.aud }, deps)
		assert.equal(res.appToken, fake.appToken)
		assert.equal(res.orgToken, fake.orgToken, 'org token delivered alongside (send_org_token)')
		assert.equal(res.teamDomain, 'team.example')
		assert.equal(res.aud, fake.aud)
		assert.equal(opened.length, 1)
		const u = new URL(opened[0]!)
		assert.equal(u.origin, fake.origin, 'browser sent to the APP origin cli endpoint')
		assert.equal(u.pathname, '/cdn-cgi/access/cli')
	} finally {
		fake.stop()
	}
	console.log('ok: access — browserLogin round-trip through the fake transfer store')
}

// -- print-URL fallback + poll timeout ----------------------------------------
{
	const fake = startFakeAccess()
	// No browser AND the user never completes SSO → poll times out cleanly.
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async () => false,
		storeBaseUrl: fake.storeBaseUrl,
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 60,
	}
	try {
		await assert.rejects(
			() => browserLogin(fake.origin, { teamDomain: 'team.example', aud: fake.aud }, deps),
			/timed out/i,
			'no completion within pollTimeoutMs → clear timeout error',
		)
	} finally {
		fake.stop()
	}
	console.log('ok: access — no-browser fallback polls and times out cleanly')
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun cli/src/auth/access.test.ts`
Expected: FAIL — `browserLogin` not exported.

- [ ] **Step 4: Write minimal implementation**

Append to `cli/src/auth/access.ts`:

```ts
/** Long-poll the transfer store for our pubkey until SSO completes (non-200 =
 *  "still waiting", cloudflared transferRequest) — then decrypt. */
export async function pollTransferStore(keys: TransferKeys, deps: AccessDeps): Promise<TransferTokens> {
	const url = new URL(`transfer/${keys.publicKeyB64}`, deps.storeBaseUrl)
	const deadline = deps.now() + deps.pollTimeoutMs
	for (;;) {
		try {
			const res = await deps.fetch(url, { redirect: 'manual' })
			if (res.status === 200) {
				const servicePub = res.headers.get('service-public-key')
				if (!servicePub) throw new CliError('transfer store answered 200 without a service-public-key header')
				return decryptTransfer(await res.text(), servicePub, keys.secretKey)
			}
		} catch (err) {
			if (err instanceof CliError) throw err // decrypt/shape errors are fatal, not retriable
			// transient network error → keep polling
		}
		if (deps.now() >= deadline) {
			throw new CliError('timed out waiting for the browser login to complete — re-run `ew auth login` and finish the SSO page')
		}
		await new Promise((r) => setTimeout(r, deps.pollIntervalMs))
	}
}

export interface BrowserLoginResult {
	appToken: string
	orgToken: string
	teamDomain: string
	aud: string
}

/** The browser leg (design §1 step 2): keypair → open (or print) the
 *  cli-login URL → poll the store → decrypt. The URL is ALWAYS printed —
 *  delivery is keyed by our pubkey at the store, so it works opened from any
 *  machine (the design-§3 headless-human relay needs nothing more). */
export async function browserLogin(
	originUrl: string,
	probe: { teamDomain: string; aud: string },
	deps: AccessDeps,
): Promise<BrowserLoginResult> {
	const keys = generateTransferKeys()
	const loginUrl = buildCliLoginUrl(originUrl, probe.aud, keys.publicKeyB64)
	const opened = await deps.openBrowser(loginUrl)
	narrate(opened ? 'Opening browser to authenticate…' : 'No browser available — open this URL on any machine:')
	narrate(loginUrl)
	const tokens = await pollTransferStore(keys, deps)
	return { appToken: tokens.app_token, orgToken: tokens.org_token, teamDomain: probe.teamDomain, aud: probe.aud }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun cli/src/auth/access.test.ts`
Expected: PASS — five `ok:` lines.

- [ ] **Step 6: Commit**

```bash
git add cli/src/auth/access.ts cli/src/auth/access.test.ts cli/src/auth/fake-access.ts
git commit -m "feat(cli): browserLogin — cli-login URL, transfer-store polling, fake Access server" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `exchangeOrgToken` — silent app-token minting

**Files:**
- Modify: `cli/src/auth/access.ts` (append)
- Test: `cli/src/auth/access.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `cli/src/auth/access.test.ts` (extend the `./access.ts` import with `exchangeOrgToken`; extend the `./fake-access.ts` import with `makeJwt` if not already):

```ts
// -- exchangeOrgToken: org → app, browser-free (Discovery #3) -----------------
{
	const fake = startFakeAccess()
	const deps = { fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init), now: () => Date.now() }
	try {
		const appToken = await exchangeOrgToken(fake.origin, fake.orgToken, deps)
		assert.equal(appToken, fake.appToken, 'app token minted via the login/authorized cookie dance')

		// A WRONG org token dead-ends at the interactive login page (no
		// redirect) → distinct credential error, not a hang or a bogus token.
		const wrong = makeJwt({ email: 'x@y', exp: Math.floor(Date.now() / 1000) + 3600 })
		await assert.rejects(() => exchangeOrgToken(fake.origin, wrong, deps), /ew auth login/,
			'rejected exchange tells the user to log in again')

		// An EXPIRED org token short-circuits locally — zero network traffic.
		const before = fake.requests.length
		const expired = makeJwt({ email: 'x@y', exp: Math.floor(Date.now() / 1000) - 10 })
		await assert.rejects(() => exchangeOrgToken(fake.origin, expired, deps), /expired/i)
		assert.equal(fake.requests.length, before, 'expired org token never leaves the machine')
	} finally {
		fake.stop()
	}
	console.log('ok: access — exchangeOrgToken mints, rejects, and short-circuits expiry')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/access.test.ts`
Expected: FAIL — `exchangeOrgToken` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `cli/src/auth/access.ts`:

```ts
/** Exit code for "stored credential is expired/revoked — re-login" so callers
 *  (auth status, the SP2 supervisor) can distinguish it from generic failures
 *  (design §2: a distinct state, not a generic disconnect). */
export const CREDENTIAL_EXPIRED_EXIT = 4

/** Org token → fresh app token with zero browser (cloudflared
 *  exchangeOrgToken/handleRedirects): walk the app's redirect chain manually;
 *  attach CF_Authorization=<org> at the login hop and the observed
 *  CF_AppSession at the authorized hop; the authorized response's
 *  CF_Authorization Set-Cookie is the app token. */
export async function exchangeOrgToken(
	originUrl: string,
	orgToken: string,
	deps: Pick<AccessDeps, 'fetch' | 'now'>,
): Promise<string> {
	if (jwtExpired(orgToken, deps.now())) {
		throw new CliError('Access session expired — run `ew auth login` again', CREDENTIAL_EXPIRED_EXIT)
	}
	let target = originUrl
	let appSession: string | undefined
	for (let hop = 0; hop < 10; hop++) {
		const pathNow = new URL(target).pathname
		const cookies: string[] = []
		if (pathNow.includes(ACCESS_LOGIN_PATH)) cookies.push(`CF_Authorization=${orgToken}`)
		if (pathNow.includes(ACCESS_AUTHORIZED_PATH) && appSession) cookies.push(`CF_AppSession=${appSession}`)
		let res: Response
		try {
			res = await deps.fetch(target, {
				method: 'HEAD',
				redirect: 'manual',
				headers: cookies.length ? { cookie: cookies.join('; ') } : {},
			})
		} catch (err) {
			throw new CliError(`token refresh: could not reach ${new URL(target).origin}: ${(err as Error).message}`)
		}
		for (const sc of res.headers.getSetCookie()) {
			const pair = sc.split(';', 1)[0]!
			const eq = pair.indexOf('=')
			if (eq < 0) continue
			const name = pair.slice(0, eq).trim()
			const value = pair.slice(eq + 1)
			if (name === 'CF_AppSession') appSession = value
			if (name === 'CF_Authorization' && pathNow.includes(ACCESS_AUTHORIZED_PATH)) return value
		}
		const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
		if (!loc) break // dead end (e.g. the interactive login page) — the org session is no longer honored
		target = new URL(loc, target).toString()
	}
	throw new CliError(
		'could not mint an app token from the stored Access session — it may be expired or revoked; run `ew auth login` again',
		CREDENTIAL_EXPIRED_EXIT,
	)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/auth/access.test.ts`
Expected: PASS — six `ok:` lines.

- [ ] **Step 5: Commit**

```bash
git add cli/src/auth/access.ts cli/src/auth/access.test.ts
git commit -m "feat(cli): exchangeOrgToken — browser-free app-token minting via the Access cookie dance" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `resolve.ts` — the `access` auth variant + `cf-access-token` header

**Files:**
- Modify: `cli/src/resolve.ts`
- Test: `cli/src/resolve.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `cli/src/resolve.test.ts` (match the file's existing style — read it first; it tests `resolveConn`/`authHeaders` with inline fixtures):

```ts
// -- access auth (SP5): env token, header emission, precedence ---------------
{
	// ENSEMBLEWORKS_ACCESS_TOKEN alone (the in-container connector case: SP2's
	// supervisor injects exactly this) → access auth.
	const conn = resolveConn(
		{},
		{ ENSEMBLEWORKS_URL: 'https://canvas.example.com', ENSEMBLEWORKS_ACCESS_TOKEN: 'app.jwt.here' },
		{ instances: {} },
	)
	assert.deepEqual(conn.auth, { method: 'access', appToken: 'app.jwt.here' })

	// It wins over a service-token pair in the same env (most specific first).
	const both = resolveConn(
		{},
		{
			ENSEMBLEWORKS_URL: 'https://canvas.example.com',
			ENSEMBLEWORKS_ACCESS_TOKEN: 'app.jwt.here',
			ENSEMBLEWORKS_TOKEN_ID: 'tid',
			ENSEMBLEWORKS_TOKEN_SECRET: 'tsec',
		},
		{ instances: {} },
	)
	assert.equal(both.auth.method, 'access')

	// An access-browser FILE record resolves to method none here — minting is
	// async and lives in resolveConnFresh (Task 8); pure resolveConn stays sync.
	const rec = resolveConn({}, { ENSEMBLEWORKS_URL: 'https://canvas.example.com' }, {
		instances: {
			'https://canvas.example.com': { method: 'access-browser', org_token: 'org.jwt', default_room: 'team' },
		},
	})
	assert.equal(rec.auth.method, 'none')

	// The header is cf-access-token (Discovery #4) — NOT Authorization.
	assert.deepEqual(authHeaders({ method: 'access', appToken: 'app.jwt.here' }), { 'cf-access-token': 'app.jwt.here' })
	console.log('ok: resolve — access env token, precedence, cf-access-token header')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/resolve.test.ts`
Expected: FAIL — `{ method: 'access', … }` not assignable / `auth.method` resolves to `'none'` for the env-token case.

- [ ] **Step 3: Write minimal implementation**

In `cli/src/resolve.ts`:

`Env` gains a field (after `ENSEMBLEWORKS_TOKEN_SECRET`):

```ts
	ENSEMBLEWORKS_ACCESS_TOKEN?: string
```

`readEnv` gains the mapping (same position):

```ts
		ENSEMBLEWORKS_ACCESS_TOKEN: env.ENSEMBLEWORKS_ACCESS_TOKEN,
```

`Auth` becomes:

```ts
export type Auth =
	| { method: 'service-token'; tokenId: string; tokenSecret: string }
	| { method: 'access'; appToken: string } // a minted CF Access app token (SP5)
	| { method: 'none' }
```

In `resolveConn`, replace the `const auth: Auth = …` expression with:

```ts
	// Most-specific first: an explicit app token (the in-container connector —
	// SP2 injects ENSEMBLEWORKS_ACCESS_TOKEN per (re)spawn) beats the service
	// pair; the pair beats none. An access-browser FILE record stays 'none'
	// here — minting is async; resolveConnFresh (auth/fresh.ts) upgrades it.
	const accessToken = env.ENSEMBLEWORKS_ACCESS_TOKEN
	const auth: Auth = accessToken
		? { method: 'access', appToken: accessToken }
		: tokenId && tokenSecret
			? { method: 'service-token', tokenId, tokenSecret }
			: { method: 'none' }
```

`authHeaders` gains the branch (before the final `return {}`):

```ts
	if (auth.method === 'access') {
		// Discovery #4: Access evaluates cf-access-token on every request; the
		// edge validates it and forwards Cf-Access-Jwt-Assertion to the origin
		// (which server/src/access-identity.ts already verifies — no server change).
		return { 'cf-access-token': auth.appToken }
	}
```

Also update the file's header comment first line to mention the new variant, e.g. append to the existing comment: `authHeaders additionally emits cf-access-token for a minted Access app token (SP5).`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/resolve.test.ts && cd cli && bunx tsc --noEmit && cd ..`
Expected: PASS + typecheck 0. If tsc flags `ConnectConfig.authMethod` in `native/connect.ts` (its union is narrower than `conn.auth.method`), widen it now:

In `cli/src/native/connect.ts`, change

```ts
	authMethod: 'service-token' | 'none'
```

to

```ts
	authMethod: 'service-token' | 'none' | 'access'
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/resolve.ts cli/src/resolve.test.ts cli/src/native/connect.ts
git commit -m "feat(cli): access auth variant — ENSEMBLEWORKS_ACCESS_TOKEN env + cf-access-token header" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `fresh.ts` — silent minting at the connection seam

`resolveConn` stays pure/sync; this async layer above it turns a stored `access-browser` record into a live `access` conn: reuse the cached `app_token` while fresh (≥2 min left), otherwise mint via `exchangeOrgToken` and persist the new cache back to `hosts.toml`. Then wire it into the two places that resolve a connection today.

**Files:**
- Create: `cli/src/auth/fresh.ts`
- Create: `cli/src/auth/fresh.test.ts`
- Modify: `cli/src/dispatch.ts:98` (+ `tryExtension`), `cli/src/native/connect.ts:47-56`

- [ ] **Step 1: Write the failing test**

Create `cli/src/auth/fresh.test.ts`:

```ts
// fresh.ts (SP5): ensureFreshAppToken reuses a live cached app token, mints +
// persists when stale, and surfaces credential-expired distinctly;
// resolveConnFresh upgrades an access-browser record to a live access conn
// and passes every other method through untouched. Network-free (fake Access).
// Run with: bun src/auth/fresh.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHosts, saveHosts, type HostsFile } from '../hosts.ts'
import { CREDENTIAL_EXPIRED_EXIT, realAccessDeps } from './access.ts'
import { makeJwt, startFakeAccess } from './fake-access.ts'
import { ensureFreshAppToken, refreshConnAuth, resolveConnFresh } from './fresh.ts'
import { CliError } from '../errors.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-fresh-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
delete env.ENSEMBLEWORKS_URL
delete env.ENSEMBLEWORKS_ACCESS_TOKEN
delete env.ENSEMBLEWORKS_TOKEN_ID
delete env.ENSEMBLEWORKS_TOKEN_SECRET
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')
const deps = { ...realAccessDeps(), pollIntervalMs: 5, pollTimeoutMs: 500 }

const fake = startFakeAccess()
const nowSec = Math.floor(Date.now() / 1000)

// Seed: an access-browser record with a STALE cached app token.
const seed: HostsFile = {
	default_instance: fake.origin,
	instances: {
		[fake.origin]: {
			method: 'access-browser',
			org_token: fake.orgToken,
			app_token: makeJwt({ email: fake.email, exp: nowSec - 10 }), // stale
			team_domain: 'team.example',
			aud: fake.aud,
			default_room: 'team',
			identity: `sso:${fake.email}`,
		},
	},
}
saveHosts(hostsFile, seed)

try {
	// 1. Stale cache → mint via the fake exchange, persist the new cache.
	const minted = await ensureFreshAppToken(hostsFile, fake.origin, deps)
	assert.equal(minted, fake.appToken, 'stale cache → exchangeOrgToken mints')
	assert.equal(loadHosts(hostsFile).instances[fake.origin]!.app_token, fake.appToken, 'minted token persisted back (cache)')

	// 2. Fresh cache → reused, ZERO network.
	const before = fake.requests.length
	const reused = await ensureFreshAppToken(hostsFile, fake.origin, deps)
	assert.equal(reused, fake.appToken)
	assert.equal(fake.requests.length, before, 'fresh cache reused without a request')

	// 3. resolveConnFresh: the record upgrades to a live access conn…
	const conn = await resolveConnFresh({ url: fake.origin }, env, deps)
	assert.deepEqual(conn.auth, { method: 'access', appToken: fake.appToken })
	assert.equal(conn.room, 'team')
	// …and refreshConnAuth (the SP2 per-respawn seam) re-derives it from disk.
	const refreshed = await refreshConnAuth(conn, env, deps)
	assert.deepEqual(refreshed.auth, { method: 'access', appToken: fake.appToken })

	// 4. Non-access instances pass through untouched.
	const noneConn = await resolveConnFresh({ url: 'http://localhost:9' }, env, deps)
	assert.deepEqual(noneConn.auth, { method: 'none' }, 'unknown instance stays none — no minting attempted')

	// 5. Expired ORG token → the distinct credential-expired failure.
	const hosts = loadHosts(hostsFile)
	hosts.instances[fake.origin]!.org_token = makeJwt({ email: fake.email, exp: nowSec - 10 })
	hosts.instances[fake.origin]!.app_token = makeJwt({ email: fake.email, exp: nowSec - 10 })
	saveHosts(hostsFile, hosts)
	await assert.rejects(
		() => ensureFreshAppToken(hostsFile, fake.origin, deps),
		(e: unknown) => e instanceof CliError && e.exitCode === CREDENTIAL_EXPIRED_EXIT && /expired/i.test(e.message),
		'expired org token → CREDENTIAL_EXPIRED_EXIT, telling the user to re-login',
	)
} finally {
	fake.stop()
}
console.log('ok: fresh — cache reuse, mint+persist, passthrough, credential-expired')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/fresh.test.ts`
Expected: FAIL — cannot resolve `./fresh.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `cli/src/auth/fresh.ts`:

```ts
/**
 * The async layer between hosts.toml and a live connection (SP5): pure
 * resolveConn cannot mint (network), so callers that need real credentials go
 * through resolveConnFresh — which upgrades an access-browser record into
 * { method: 'access', appToken } by reusing the cached app_token while it has
 * ≥2 min left, else minting via exchangeOrgToken and persisting the new cache.
 * refreshConnAuth is the SP2 supervisor's per-(re)spawn seam: token refresh =
 * re-exec with fresh env (decision-log SP5 #3).
 */
import { hostsPath, loadHosts, saveHosts } from '../hosts.ts'
import { CliError } from '../errors.ts'
import { type Conn, type Flags, readEnv, resolveConn } from '../resolve.ts'
import { type AccessDeps, exchangeOrgToken, jwtExpired, realAccessDeps } from './access.ts'

/** Cached-app-token freshness margin: don't hand out a token about to die
 *  mid-request/mid-dial. */
const APP_TOKEN_MIN_LEFT_MS = 120_000

type FreshDeps = Pick<AccessDeps, 'fetch' | 'now'>

/** Return a fresh app token for the access-browser instance at `url`,
 *  minting + persisting through `file` when the cache is stale. */
export async function ensureFreshAppToken(file: string, url: string, deps: FreshDeps): Promise<string> {
	const hosts = loadHosts(file)
	const rec = hosts.instances[url]
	if (!rec || rec.method !== 'access-browser' || !rec.org_token) {
		throw new CliError(`${url} is not a logged-in access-browser instance — run \`ew auth login\``, 2)
	}
	if (rec.app_token && !jwtExpired(rec.app_token, deps.now(), APP_TOKEN_MIN_LEFT_MS)) return rec.app_token
	const appToken = await exchangeOrgToken(url, rec.org_token, deps)
	hosts.instances[url] = { ...rec, app_token: appToken }
	saveHosts(file, hosts)
	return appToken
}

/** resolveConn + silent minting: flags/env win exactly as before; only a
 *  file-record access-browser instance (which pure resolveConn leaves at
 *  'none') gets upgraded here. */
export async function resolveConnFresh(flags: Flags, env: NodeJS.ProcessEnv, deps: FreshDeps = realAccessDeps()): Promise<Conn> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const conn = resolveConn(flags, readEnv(env), hosts)
	if (conn.auth.method !== 'none') return conn
	const rec = hosts.instances[conn.url]
	if (rec?.method === 'access-browser' && rec.org_token) {
		return { ...conn, auth: { method: 'access', appToken: await ensureFreshAppToken(file, conn.url, deps) } }
	}
	return conn
}

/** Per-(re)spawn refresh for supervisors (SP2 codespace up): re-derive the
 *  auth from disk so every connector exec gets a token with a full lifetime.
 *  Non-access-browser instances pass through untouched. */
export async function refreshConnAuth(conn: Conn, env: NodeJS.ProcessEnv, deps: FreshDeps = realAccessDeps()): Promise<Conn> {
	const file = hostsPath(env)
	const rec = loadHosts(file).instances[conn.url]
	if (rec?.method !== 'access-browser' || !rec.org_token) return conn
	return { ...conn, auth: { method: 'access', appToken: await ensureFreshAppToken(file, conn.url, deps) } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun cli/src/auth/fresh.test.ts`
Expected: PASS — `ok: fresh — cache reuse, mint+persist, passthrough, credential-expired`

- [ ] **Step 5: Wire the two connection seams**

In `cli/src/dispatch.ts`, replace line 98:

```ts
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
```

with:

```ts
	// SP5: async resolution — an access-browser instance silently mints a fresh
	// app token here (cache-first); everything else is byte-identical.
	const conn = await resolveConnFresh({ url: globals.url, room: globals.room }, env)
```

and change the import line

```ts
import { type Conn, readEnv, resolveConn } from './resolve.ts'
```

to

```ts
import type { Conn } from './resolve.ts'
import { resolveConnFresh } from './auth/fresh.ts'
```

In `tryExtension` (same file), after the service-token `if` block that sets `ENSEMBLEWORKS_TOKEN_ID`/`SECRET`, add:

```ts
	if (conn.auth.method === 'access') {
		childEnv.ENSEMBLEWORKS_ACCESS_TOKEN = conn.auth.appToken
	}
```

In `cli/src/native/connect.ts`, in `connectSlot`, replace:

```ts
	const conn = resolveConn({ url: globals.url, room: globals.room }, readEnv(env), loadHosts(hostsPath(env)))
```

with:

```ts
	const conn = await resolveConnFresh({ url: globals.url, room: globals.room }, env)
```

and adjust its imports: drop `readEnv, resolveConn` from the `../resolve.ts` import (keep `authHeaders, type Conn`), drop `hostsPath, loadHosts` from `../hosts.ts` **only if now unused elsewhere in the file** (check — `stableGatewayId` may use them; keep whatever is still referenced), and add:

```ts
import { resolveConnFresh } from '../auth/fresh.ts'
```

- [ ] **Step 6: Verify nothing regressed**

Run: `cd cli && bunx tsc --noEmit && cd .. && bun cli/src/native/connect.test.ts && bun cli/src/resolve.test.ts && bun cli/src/cli-api.test.ts`
Expected: typecheck 0; all three suites PASS (the none/service-token paths behave byte-identically — `resolveConnFresh` only adds behavior for access-browser records).

- [ ] **Step 7: Commit**

```bash
git add cli/src/auth/fresh.ts cli/src/auth/fresh.test.ts cli/src/dispatch.ts cli/src/native/connect.ts
git commit -m "feat(cli): resolveConnFresh — silent app-token minting at the connection seam" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `auth login` — probe-driven method + the access-browser flow

Design §1: the URL is the only thing the user types. No `--method` → probe decides (302→`access-browser` browser leg, 200→`none`); the old interactive method prompt is removed (behavior change, design-mandated). Explicit `--method` (incl. the existing `service-token`/`none` CI paths) still wins.

**Files:**
- Modify: `cli/src/auth/login.ts`
- Modify: `cli/src/dispatch.ts` (`parseLoginFlags`)
- Test: `cli/src/auth/login.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `cli/src/auth/login.test.ts`:

```ts
// auth login (SP5): probe-driven method resolution — behind Access → the full
// browser leg (keypair → open → poll → verify → store access-browser record);
// open origin → auth = none stored as before. Fully flag-driven (no prompts).
// Network-free via the fake. Run with: bun src/auth/login.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHosts } from '../hosts.ts'
import type { AccessDeps } from './access.ts'
import { startFakeAccess } from './fake-access.ts'
import { login } from './login.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-login-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')

// -- behind Access, no --method → probe picks the browser leg -----------------
{
	const fake = startFakeAccess()
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async (u) => {
			fake.completeLogin(new URL(u).searchParams.get('token')!)
			return true
		},
		storeBaseUrl: fake.storeBaseUrl,
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 2_000,
	}
	try {
		const code = await login({ url: fake.origin, room: 'team' }, env, deps)
		assert.equal(code, 0)
		const rec = loadHosts(hostsFile).instances[fake.origin]!
		assert.equal(rec.method, 'access-browser')
		assert.equal(rec.org_token, fake.orgToken, 'org token stored — the credential')
		assert.equal(rec.app_token, fake.appToken, 'app token cached')
		assert.equal(rec.aud, fake.aud, 'AUD from the probe redirect, never prompted')
		assert.equal(rec.team_domain, `127.0.0.1:${new URL(fake.origin).port}`, 'team domain from the redirect host')
		assert.equal(rec.identity, `sso:${fake.email}`, 'identity from /api/whoami through the app token')
		assert.equal(rec.default_room, 'team')
		assert.equal(loadHosts(hostsFile).default_instance, fake.origin, 'last login wins the default')
	} finally {
		fake.stop()
	}
	console.log('ok: login — probe → browser leg → access-browser record stored')
}

// -- open origin, no --method → stored as none (design §1 outcome 2) ----------
{
	const open = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req) {
			const u = new URL(req.url)
			if (u.pathname === '/api/whoami') return Response.json({ identity: null, kind: 'anonymous', via: 'none' })
			return new Response('canvas', { status: 200 })
		},
	})
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async () => {
			throw new Error('browser must not open for an open origin')
		},
		storeBaseUrl: 'http://127.0.0.1:1/never/',
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 100,
	}
	try {
		const code = await login({ url: `http://127.0.0.1:${open.port}`, room: 'team' }, env, deps)
		assert.equal(code, 0)
		assert.equal(loadHosts(hostsFile).instances[`http://127.0.0.1:${open.port}`]!.method, 'none')
	} finally {
		open.stop(true)
	}
	console.log('ok: login — probe → open origin stored as none')
}

// -- --method access-browser against a NON-Access origin → clear error --------
{
	const open = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok', { status: 200 }) })
	const deps: AccessDeps = {
		fetch: (i, init) => fetch(i, init),
		openBrowser: async () => true,
		storeBaseUrl: 'http://127.0.0.1:1/never/',
		now: () => Date.now(),
		pollIntervalMs: 5,
		pollTimeoutMs: 100,
	}
	try {
		await assert.rejects(
			() => login({ url: `http://127.0.0.1:${open.port}`, method: 'access-browser', room: 'team' }, env, deps),
			/not behind Cloudflare Access/,
		)
	} finally {
		open.stop(true)
	}
	console.log('ok: login — forced access-browser against an open origin refuses')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/login.test.ts`
Expected: FAIL — `login` rejects `method: 'access-browser'` at the type level and/or the first block prompts on stdin / stores no access-browser record.

- [ ] **Step 3: Write the implementation**

Replace `cli/src/auth/login.ts` with:

```ts
/**
 * `auth login` (auth design doc §1 + spec §8.1): resolve url → resolve METHOD
 * (explicit --method wins; otherwise PROBE the origin — behind Access ⇒ the
 * browser leg, plain 200 ⇒ none; the URL is the only thing the user ever
 * types) → acquire credentials → verify via GET /api/whoami → store the
 * [instances."<url>"] record 0600 and make it default_instance.
 * service-token/none paths are byte-compatible with the pre-SP5 CLI (minus
 * the removed interactive method prompt — probe replaces it).
 */
import type { Whoami } from '@ensembleworks/contracts'
import { CliError } from '../errors.ts'
import { hostsPath, type InstanceRecord, loadHosts, saveHosts, setInstance } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { narrate } from '../output.ts'
import { ask, askSecret } from './prompt.ts'
import { type Auth, authHeaders } from '../resolve.ts'
import { type AccessDeps, browserLogin, jwtEmail, probeAccess, type ProbeResult, realAccessDeps } from './access.ts'

export interface LoginFlags {
	url?: string
	room?: string
	method?: 'service-token' | 'none' | 'access-browser'
	tokenId?: string
	tokenSecret?: string
}

export async function login(flags: LoginFlags, env: NodeJS.ProcessEnv, deps: AccessDeps = realAccessDeps()): Promise<number> {
	const url = flags.url ?? (await ask('instance url: '))
	if (!url) throw new CliError('auth login requires a url (--url or the prompt)', 2)

	// Method resolution (design §1): explicit flag wins; else probe.
	let probe: ProbeResult | undefined
	let method = flags.method
	if (!method) {
		probe = await probeAccess(url, deps)
		if (probe.kind === 'access') {
			method = 'access-browser'
			narrate(`probe: behind Cloudflare Access (team ${probe.teamDomain})`)
		} else {
			method = 'none'
			narrate('probe: no auth boundary — storing auth = none')
		}
	}

	if (method === 'access-browser') {
		probe ??= await probeAccess(url, deps)
		if (probe.kind !== 'access') throw new CliError(`--method access-browser, but ${url} is not behind Cloudflare Access`, 2)
		return accessBrowserLogin(url, probe, flags, env, deps)
	}

	const auth = await credentialAcquire(method, flags)
	const who = await verifyWhoami(url, auth, deps)
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

/** The browser leg (design §1 steps 2-3): browserLogin → verify → store the
 *  org token (credential) + app token (cache) + team/aud (probe facts). */
async function accessBrowserLogin(
	url: string,
	probe: { teamDomain: string; aud: string },
	flags: LoginFlags,
	env: NodeJS.ProcessEnv,
	deps: AccessDeps,
): Promise<number> {
	const res = await browserLogin(url, probe, deps)
	const auth: Auth = { method: 'access', appToken: res.appToken }
	const who = await verifyWhoami(url, auth, deps)
	const identity = who.identity ?? jwtEmail(res.appToken)
	narrate(`✓ logged in as ${identity ?? '(anonymous)'} [${who.kind} via ${who.via}]`)

	const defaultRoom = flags.room ?? (await ask('default room (team): ', 'team'))
	const rec: InstanceRecord = {
		method: 'access-browser',
		org_token: res.orgToken,
		app_token: res.appToken,
		team_domain: res.teamDomain,
		aud: res.aud,
		default_room: defaultRoom,
	}
	if (identity) rec.identity = identity

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

async function verifyWhoami(url: string, auth: Auth, deps: Pick<AccessDeps, 'fetch'>): Promise<Whoami> {
	const target = toRequestUrl(url, '/api/whoami')
	let res: Response
	try {
		res = await deps.fetch(target, { headers: authHeaders(auth) })
	} catch (err) {
		throw new CliError(`could not reach ${target.origin}: ${(err as Error).message}`)
	}
	if (!res.ok) throw new CliError(`verify failed: GET /api/whoami → ${res.status}`)
	return (await res.json()) as Whoami
}
```

In `cli/src/dispatch.ts` `parseLoginFlags`, replace the `--method` case:

```ts
			case '--method': {
				const v = args[++i]
				if (v !== 'service-token' && v !== 'none' && v !== 'access-browser')
					throw new CliError(`--method must be service-token, none, or access-browser, got: ${v}`, 2)
				flags.method = v
				break
			}
```

(and if the `LoginFlags` import type annotation there constrains method, it now matches the widened union automatically since it imports the type from `./auth/login.ts`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/auth/login.test.ts && bun cli/src/cli-api.test.ts`
Expected: both PASS — cli-api pins `auth login --url … --method none --room team`, which never probes (explicit method) and is unchanged.

- [ ] **Step 5: Commit**

```bash
git add cli/src/auth/login.ts cli/src/auth/login.test.ts cli/src/dispatch.ts
git commit -m "feat(cli): probe-driven auth login — browser leg stores the access-browser record" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `auth token` verb + `auth status` distinct states

Design §1.4 (`ew auth token` for scripting) and §2 ("credential expired" as a distinct state, not a generic disconnect). `auth status` grows a STATE column: `ok` / `unreachable` / `credential expired`; the `--json` shape's `reachable` boolean becomes `state` (pre-1.0 CLI; nothing in-repo consumes it — verified: only `status.ts` itself references it).

**Files:**
- Create: `cli/src/auth/token.ts`
- Modify: `cli/src/auth/status.ts`
- Modify: `cli/src/dispatch.ts` (`authGroup`, help text)
- Create: `cli/src/auth/status-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/auth/status-token.test.ts`:

```ts
// auth status states + auth token (SP5): ok / unreachable / credential
// expired are distinct; token prints a fresh app token to stdout. Network-free
// via the fake. Run with: bun src/auth/status-token.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveHosts, type HostsFile } from '../hosts.ts'
import { realAccessDeps } from './access.ts'
import { makeJwt, startFakeAccess } from './fake-access.ts'
import { status } from './status.ts'
import { tokenCmd } from './token.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ew-status-'))
const env = { ...process.env, XDG_CONFIG_HOME: tmp } as NodeJS.ProcessEnv
delete env.ENSEMBLEWORKS_URL
delete env.ENSEMBLEWORKS_ACCESS_TOKEN
const hostsFile = path.join(tmp, 'ensembleworks', 'hosts.toml')
const deps = { ...realAccessDeps(), pollIntervalMs: 5, pollTimeoutMs: 500 }

const fake = startFakeAccess()
const nowSec = Math.floor(Date.now() / 1000)

const hosts: HostsFile = {
	default_instance: fake.origin,
	instances: {
		// live access-browser instance (stale app cache → forces a mint)
		[fake.origin]: {
			method: 'access-browser',
			org_token: fake.orgToken,
			app_token: makeJwt({ email: fake.email, exp: nowSec - 10 }),
			team_domain: 'team.example',
			aud: fake.aud,
			default_room: 'team',
		},
		// expired org token → credential expired, decided locally
		'https://dead.example.com': {
			method: 'access-browser',
			org_token: makeJwt({ email: 'x@y', exp: nowSec - 10 }),
			default_room: 'team',
		},
		// unreachable none instance
		'http://127.0.0.1:1': { method: 'none', default_room: 'team' },
	},
}
saveHosts(hostsFile, hosts)

const captureStdout = async (fn: () => Promise<number>): Promise<{ code: number; out: string }> => {
	const chunks: string[] = []
	const real = process.stdout.write.bind(process.stdout)
	;(process.stdout as any).write = (s: string) => {
		chunks.push(String(s))
		return true
	}
	try {
		const code = await fn()
		return { code, out: chunks.join('') }
	} finally {
		;(process.stdout as any).write = real
	}
}

try {
	// status --json: three rows, three distinct states.
	const { code, out } = await captureStdout(() => status({ json: true }, env, deps))
	assert.equal(code, 1, 'any non-ok row → exit 1')
	const rows = JSON.parse(out) as Array<{ url: string; state: string; identity?: string | null }>
	const byUrl = Object.fromEntries(rows.map((r) => [r.url, r]))
	assert.equal(byUrl[fake.origin]!.state, 'ok')
	assert.equal(byUrl[fake.origin]!.identity, `sso:${fake.email}`, 'whoami through the freshly minted token')
	assert.equal(byUrl['https://dead.example.com']!.state, 'credential expired', 'the §2 distinct state — decided locally, no network')
	assert.equal(byUrl['http://127.0.0.1:1']!.state, 'unreachable')

	// auth token prints the fresh app token to STDOUT (scriptable).
	const t = await captureStdout(() => tokenCmd({ url: fake.origin }, env, deps))
	assert.equal(t.code, 0)
	assert.equal(t.out.trim(), fake.appToken)

	// auth token on a non-access instance → clear refusal.
	await assert.rejects(() => tokenCmd({ url: 'http://127.0.0.1:1' }, env, deps), /not a.*access-browser/i)
} finally {
	fake.stop()
}
console.log('ok: status/token — ok vs unreachable vs credential-expired, token prints fresh jwt')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/auth/status-token.test.ts`
Expected: FAIL — cannot resolve `./token.ts`.

- [ ] **Step 3: Write the implementation**

Create `cli/src/auth/token.ts`:

```ts
/** `auth token [--url <u>]` (design §1.4): print a FRESH app token for the
 *  resolved access-browser instance to stdout — the scripting escape hatch
 *  (`curl -H "cf-access-token: $(ew auth token)" …`). */
import { CliError } from '../errors.ts'
import { hostsPath, loadHosts } from '../hosts.ts'
import { emitLine } from '../output.ts'
import { type AccessDeps, realAccessDeps } from './access.ts'
import { ensureFreshAppToken } from './fresh.ts'

export async function tokenCmd(
	flags: { url?: string },
	env: NodeJS.ProcessEnv,
	deps: Pick<AccessDeps, 'fetch' | 'now'> = realAccessDeps(),
): Promise<number> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const url = flags.url ?? hosts.default_instance
	if (!url) throw new CliError('auth token requires --url or a default instance (run `ew auth login`)', 2)
	const rec = hosts.instances[url]
	if (rec?.method !== 'access-browser') {
		throw new CliError(`auth token: ${url} is not an access-browser instance (service-token/none creds are already env-shaped)`, 2)
	}
	emitLine(await ensureFreshAppToken(file, url, deps))
	return 0
}
```

Replace `cli/src/auth/status.ts` with:

```ts
/** `auth status`: for the resolved instance (or every configured instance when
 *  no --url), report a per-host STATE — ok / unreachable / credential expired
 *  (design §2's distinct state: an access-browser org token past exp, or an
 *  exchange the team domain refuses) — plus the whoami identity. --json emits
 *  the raw rows (state replaces the old reachable boolean). */
import type { Whoami } from '@ensembleworks/contracts'
import { hostsPath, type InstanceRecord, loadHosts } from '../hosts.ts'
import { toRequestUrl } from '../http.ts'
import { emitJson, emitTable } from '../output.ts'
import { type Auth, authHeaders } from '../resolve.ts'
import { type AccessDeps, jwtExpired, realAccessDeps } from './access.ts'
import { ensureFreshAppToken } from './fresh.ts'

export interface StatusFlags {
	url?: string
	json: boolean
}

export type HostState = 'ok' | 'unreachable' | 'credential expired'

interface Row {
	url: string
	state: HostState
	whoami: Whoami | null
}

export async function status(
	flags: StatusFlags,
	env: NodeJS.ProcessEnv,
	deps: Pick<AccessDeps, 'fetch' | 'now'> = realAccessDeps(),
): Promise<number> {
	const file = hostsPath(env)
	const hosts = loadHosts(file)
	const urls = flags.url ? [flags.url] : Object.keys(hosts.instances)
	if (urls.length === 0) {
		process.stderr.write('no instances configured — run `ensembleworks auth login`\n')
		return 1
	}
	const rows: Row[] = []
	for (const url of urls) rows.push(await probeOne(file, url, hosts.instances[url], deps))
	if (flags.json) {
		emitJson(rows.map((r) => ({ url: r.url, state: r.state, ...(r.whoami ?? {}) })))
		return rows.every((r) => r.state === 'ok') ? 0 : 1
	}
	emitTable(
		['URL', 'STATE', 'IDENTITY', 'KIND', 'VIA'],
		rows.map((r) => [r.url, r.state, r.whoami?.identity ?? '—', r.whoami?.kind ?? '—', r.whoami?.via ?? '—']),
	)
	return rows.every((r) => r.state === 'ok') ? 0 : 1
}

async function probeOne(
	file: string,
	url: string,
	rec: InstanceRecord | undefined,
	deps: Pick<AccessDeps, 'fetch' | 'now'>,
): Promise<Row> {
	let auth: Auth = { method: 'none' }
	if (rec?.method === 'service-token' && rec.token_id && rec.token_secret) {
		auth = { method: 'service-token', tokenId: rec.token_id, tokenSecret: rec.token_secret }
	} else if (rec?.method === 'access-browser' && rec.org_token) {
		// Credential health first, locally: an expired org token is 'credential
		// expired' — a distinct state, never a generic unreachable (design §2).
		if (jwtExpired(rec.org_token, deps.now())) return { url, state: 'credential expired', whoami: null }
		try {
			auth = { method: 'access', appToken: await ensureFreshAppToken(file, url, deps) }
		} catch {
			return { url, state: 'credential expired', whoami: null }
		}
	}
	try {
		const res = await deps.fetch(toRequestUrl(url, '/api/whoami'), { headers: authHeaders(auth) })
		if (!res.ok) return { url, state: 'unreachable', whoami: null }
		return { url, state: 'ok', whoami: (await res.json()) as Whoami }
	} catch {
		return { url, state: 'unreachable', whoami: null }
	}
}
```

In `cli/src/dispatch.ts` `authGroup`, add the verb (after `case 'status':`):

```ts
			case 'token':
				return tokenCmd({ url: globals.url }, env)
```

with the import:

```ts
import { tokenCmd } from './auth/token.ts'
```

and update the default-case error text to `(expected login | status | token | logout)`, plus the `printTopHelp` native line to `auth login|status|token|logout`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/auth/status-token.test.ts && bun cli/src/cli-api.test.ts && cd cli && bunx tsc --noEmit && cd ..`
Expected: all PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add cli/src/auth/token.ts cli/src/auth/status.ts cli/src/auth/status-token.test.ts cli/src/dispatch.ts
git commit -m "feat(cli): auth token verb + status STATE column with distinct credential-expired" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: fatal auth-rejection on the connector dial

The refresh design (§2, SP5 decision 3) only works if an auth-rejected connector **exits** — today `runTransport` retries every dial failure forever, so an expired token would spin silently instead of letting the SP2 supervisor re-exec with a fresh one. Access rejects a bad `cf-access-token` on the upgrade with 401/403 or a 302 to the team login page; those become fatal. Every other failure keeps today's backoff-retry behavior.

**Files:**
- Modify: `cli/src/connector/relay-client.ts`
- Create: `cli/src/connector/auth-reject.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/src/connector/auth-reject.test.ts`:

```ts
// Auth-rejected dial is FATAL (SP5 §2): a 403/401/302-to-Access upgrade
// response makes runTransport throw AuthRejectedError (so the process exits
// and the SP2 supervisor re-execs with a fresh token) instead of backing off
// forever on a dead credential. A plain 500 keeps the retry behavior.
// Run with: bun src/connector/auth-reject.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { ConnectorSessionManager } from './session.ts'
import { AuthRejectedError, runTransport } from './relay-client.ts'

const timers = {
	now: () => Date.now(),
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
	setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
	clearInterval: (h: ReturnType<typeof setInterval>) => clearInterval(h),
}
const mgr = new ConnectorSessionManager(() => {
	throw new Error('no sessions in this test')
})

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> =>
	new Promise((resolve) => {
		const server = http.createServer(handler)
		server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
	})

// 403 on upgrade → AuthRejectedError (fatal).
{
	const { server, port } = await listen((_req, res) => {
		res.writeHead(403, { 'content-type': 'text/plain' })
		res.end('forbidden')
	})
	const ac = new AbortController()
	await assert.rejects(
		() => runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0.5, WebSocketCtor: WebSocket }, ac.signal),
		(e: unknown) => e instanceof AuthRejectedError && /403/.test((e as Error).message),
		'403 upgrade → fatal AuthRejectedError',
	)
	server.close()
}

// 302 to the Access login page → AuthRejectedError (the edge's rejection shape).
{
	const { server, port } = await listen((_req, res) => {
		res.writeHead(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/app?kid=x' })
		res.end()
	})
	const ac = new AbortController()
	await assert.rejects(
		() => runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0.5, WebSocketCtor: WebSocket }, ac.signal),
		(e: unknown) => e instanceof AuthRejectedError,
		'302→Access login on upgrade → fatal AuthRejectedError',
	)
	server.close()
}

// A 500 is NOT auth — runTransport keeps retrying (we abort it after the
// first backoff window to prove it did not throw).
{
	let dials = 0
	const { server, port } = await listen((_req, res) => {
		dials++
		res.writeHead(500)
		res.end('boom')
	})
	const ac = new AbortController()
	const run = runTransport(`ws://127.0.0.1:${port}/api/terminal/connect`, {}, mgr, { timers, rng: () => 0, WebSocketCtor: WebSocket }, ac.signal)
	// rng=0 → minimal jitter; give it time for ≥2 dials, then abort.
	await new Promise((r) => setTimeout(r, 2_500))
	ac.abort()
	await run // resolves (no throw) — retry semantics preserved
	assert.ok(dials >= 2, `non-auth failures keep retrying (saw ${dials} dials)`)
	server.close()
}

console.log('ok: auth-reject — 403/302-to-Access fatal, 500 retries as before')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/connector/auth-reject.test.ts`
Expected: FAIL — `AuthRejectedError` is not exported from `./relay-client.ts`.

- [ ] **Step 3: Write minimal implementation**

In `cli/src/connector/relay-client.ts`:

Add after the imports:

```ts
/** The server (or the Access edge) explicitly rejected our credentials on the
 *  upgrade. FATAL: retrying with the same token cannot succeed — exit so a
 *  supervisor (SP2 codespace up) re-execs with a freshly minted one (SP5 §2). */
export class AuthRejectedError extends Error {}
```

In `serveOnce`, add alongside the other `ws.on(…)` registrations (after `ws.on('error', …)`):

```ts
		ws.on('unexpected-response', (_req, res) => {
			const status = res.statusCode ?? 0
			const loc = String(res.headers.location ?? '')
			const authRejected =
				status === 401 || status === 403 || ((status === 301 || status === 302) && loc.includes('/cdn-cgi/access/login'))
			done(
				authRejected
					? new AuthRejectedError(`relay dial rejected: HTTP ${status}${loc ? ` → ${loc}` : ''} — credentials refused`)
					: new Error(`relay dial failed: HTTP ${status}`),
			)
		})
```

(Registering `unexpected-response` means `ws` no longer emits `error` for non-101 responses; the non-auth branch's `done(err)` reproduces the old reject-and-retry path exactly.)

In `runTransport`, replace the bare `catch`:

```ts
			try {
				await serveOnce(wsUrl, headers, mgr, deps, signal)
			} catch {
				/* logged; reconnect */
			}
```

with:

```ts
			try {
				await serveOnce(wsUrl, headers, mgr, deps, signal)
			} catch (err) {
				if (err instanceof AuthRejectedError) throw err // fatal — see class doc
				/* anything else: reconnect with backoff, as before */
			}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/connector/auth-reject.test.ts && bun cli/src/connector/reconnect.test.ts`
Expected: both PASS (reconnect.test.ts proves the retry loop is otherwise untouched).

- [ ] **Step 5: Commit**

```bash
git add cli/src/connector/relay-client.ts cli/src/connector/auth-reject.test.ts
git commit -m "feat(cli): fatal AuthRejectedError on auth-rejected relay dial — enables supervisor re-exec refresh" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: SP2 supervisor integration — fresh token per connector (re)spawn (ADD-IF-ABSENT)

SP5 decision 3: the refresh channel is **re-exec with fresh env** — the SP2 supervise loop re-mints before every spawn. SP2 (`docs/superpowers/plans/2026-07-21-ew-codespace-up.md` Tasks 7–9) may or may not have landed when this task runs.

**First check:** does `cli/src/codespace/up.ts` exist?

- **If NO** (SP2 not yet landed): do not create it. Instead append the addendum below to the END of `docs/superpowers/plans/2026-07-21-ew-codespace-up.md` so SP2's implementer applies it, commit that doc change with message `docs(plans): SP5 addendum to codespace up — access-token exec env + per-respawn mint`, and mark this task's remaining steps N/A in the execution notes.
- **If YES**: apply the same content directly as code + test, below.

**The addendum text / the change (identical content either way):**

**Files (if applying directly):**
- Modify: `cli/src/codespace/up.ts` (`buildExecArgv`; `runCodespace`'s supervise closure)
- Modify: `cli/src/codespace/up.test.ts`

- [ ] **Step 1: Write the failing test**

In `cli/src/codespace/up.test.ts`, append to the `buildExecArgv` test block (it already covers the service-token remote-env lines and REDACTED forms — mirror its local `runner`/`rec` fixtures):

```ts
// access-browser conn (SP5): the minted app token rides ENSEMBLEWORKS_ACCESS_TOKEN
// as exec-time env — REDACTED in the printable form, real when rebuilt live.
{
	const conn = { url: 'http://localhost:8788', room: 'team', auth: { method: 'access', appToken: 'minted.app.jwt' } } as const
	const real = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: false })
	assert.ok(real.includes('ENSEMBLEWORKS_ACCESS_TOKEN=minted.app.jwt'), 'access token as --remote-env')
	assert.ok(!real.some((a) => a.includes('ENSEMBLEWORKS_TOKEN_ID')), 'no service pair for an access conn')
	const redacted = buildExecArgv(runner, '/work/myrepo', conn, rec, { redact: true })
	assert.ok(redacted.includes('ENSEMBLEWORKS_ACCESS_TOKEN=REDACTED'), 'dry-run never prints the token')
	assert.ok(!redacted.some((a) => a.includes('minted.app.jwt')), 'token value absent from redacted argv')
	console.log('ok: buildExecArgv — access token remote-env + redaction')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun cli/src/codespace/up.test.ts`
Expected: FAIL — no `ENSEMBLEWORKS_ACCESS_TOKEN` line in the argv.

- [ ] **Step 3: Implement**

In `cli/src/codespace/up.ts` `buildExecArgv`, after the `if (conn.auth.method === 'service-token') { … }` block, add:

```ts
	if (conn.auth.method === 'access') {
		// access-browser instance (SP5): the app token minted for THIS spawn —
		// refreshed per supervise cycle via refreshConnAuth (auth design §2).
		argv.push('--remote-env', `ENSEMBLEWORKS_ACCESS_TOKEN=${secret(conn.auth.appToken)}`)
	}
```

In `runCodespace`'s supervise closure, move the exec-argv build INSIDE `runOnce` and refresh first — replace:

```ts
	const execArgv = buildExecArgv(runner, plan.workspaceFolder, conn, plan, { redact: false })
	…
		await supervise(async () => {
			child = Bun.spawn(execArgv, { env: childEnv, stdout: 'inherit', stderr: 'inherit' })
```

with:

```ts
	…
		await supervise(async () => {
			// Re-mint per (re)spawn (SP5 decision 3: token refresh = re-exec with
			// fresh env). Non-access instances pass through untouched.
			const freshConn = await refreshConnAuth(conn, env)
			const execArgv = buildExecArgv(runner, plan.workspaceFolder, freshConn, plan, { redact: false })
			child = Bun.spawn(execArgv, { env: childEnv, stdout: 'inherit', stderr: 'inherit' })
```

adding the import:

```ts
import { refreshConnAuth } from '../auth/fresh.ts'
```

(If a supervise cycle's mint throws — org session died mid-supervision — the error propagates out of `supervise`, `codespace up` exits non-zero with the `run \`ew auth login\`` message: correct, the design's "only a truly expired org session bounces the user back through login".)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/codespace/up.test.ts && cd cli && bunx tsc --noEmit && cd ..`
Expected: PASS + typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add cli/src/codespace/up.ts cli/src/codespace/up.test.ts
git commit -m "feat(cli): codespace up mints a fresh Access app token per connector (re)spawn" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Manual e2e runbook — OWNER-RUN, against a real Access-fronted canvas

Not CI; not agent-runnable (needs a live browser + the Access org). This is where every **assumed** discovery fact gets verified before the feature is trusted. Record outcomes as dated notes in this plan's Execution-notes section.

- [ ] **1. Prerequisites:** a deployed canvas behind Cloudflare Access with GitHub IdP (e.g. `https://canvas.leansoftware.ai`), `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` set server-side (verified mode), and a laptop with a browser.
- [ ] **2. Login:** `bun cli/src/main.ts auth login --url https://canvas.leansoftware.ai --room team`
  - Expect: `probe: behind Cloudflare Access (team …)`, browser opens, SSO completes (zero-click with a live session), `✓ logged in as <you>`.
  - **2a VERIFY-ASSUMPTION (transfer store):** the poll against `https://login.cloudflareaccess.org/transfer/<pubkey>` returns 200 after SSO. If it 404s forever: open the browser's devtools network tab on the SSO tab, find where the token POST went, and correct `DEFAULT_TRANSFER_STORE` / the URL shape in `cli/src/auth/access.ts`.
  - **2b VERIFY-ASSUMPTION (encodings):** decryption succeeds (our decoder tolerates std and URL-safe base64 for body/header — if it throws, dump `service-public-key` and the body prefix and adjust `b64decode`).
  - **2c VERIFY-ASSUMPTION (org token):** the login stores a non-empty `org_token` in `~/.config/ensembleworks/hosts.toml` (mode 0600). If the transfer response had no `org_token`, `send_org_token` is not honored for this org — silent refresh is then impossible and the design needs a re-think; STOP and report.
- [ ] **3. Token + HTTP:** `bun cli/src/main.ts auth token` prints a JWT; decode its payload (`cut -d. -f2 | tr '_-' '/+' | base64 -d`) — `aud` matches the app's AUD, `exp` ≈ the org's session length. Then any rendered verb, e.g. `bun cli/src/main.ts canvas frames`, succeeds — **VERIFY-ASSUMPTION:** the edge accepts `cf-access-token` and the server's whoami shows `sso:<your email>`.
- [ ] **4. WSS upgrade:** `bun cli/src/main.ts terminal connect --backend pty --gateway-id e2e-auth-smoke` registers (check the canvas's gateway list) — **VERIFY-ASSUMPTION:** `cf-access-token` works on the WebSocket upgrade through the edge.
- [ ] **5. Silent refresh:** edit `hosts.toml`, corrupt `app_token` (e.g. truncate it); re-run step 3 — the command still succeeds and `hosts.toml` holds a new `app_token` (minted from the org token, no browser).
- [ ] **6. Credential expired:** temporarily set `org_token` to a garbage string; `auth status` shows `credential expired` for the host (and other hosts unaffected); restore by re-running `auth login`.
- [ ] **7. Supervisor refresh:** in a repo with a devcontainer, `bun cli/src/main.ts codespace up` against the Access canvas; once the terminal is live, `docker exec` into the container and kill the connector process — the supervisor narration shows a respawn, and the new process's env carries a token (opaque check: the gateway re-registers).
- [ ] **8. Revocation:** revoke your session in the Cloudflare Zero-Trust dashboard → the connector's next dial is rejected and the process **exits** with the `AuthRejectedError` message (not an endless backoff loop).

---

### Task 14: Full verification

- [ ] **Step 1: Typecheck everything**

Run: `bun run typecheck`
Expected: exit 0 across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: `all N suites passed` — the discovery glob picks up the five new test files (`access.test.ts`, `fresh.test.ts`, `login.test.ts`, `status-token.test.ts`, `auth-reject.test.ts`) automatically; `fake-access.ts` is a module, not a suite.

- [ ] **Step 3: Clean tree**

```bash
git status --short   # should be clean
```

Done. Hand off per superpowers:finishing-a-development-branch — the PR body must include:
`ux-contract: none — CLI auth tooling; no interaction-bearing surface`

---

## Out of scope for this plan

- Any server change — `access-identity.ts`, `service-tokens.ts`, and the relay's owner binding already do the whole server half.
- OS-keychain storage for `hosts.toml` (decision-log SP5 #4: plaintext-0600, gh posture).
- Shelling out to an installed `cloudflared` (decision-log SP5 #1: native immediately).
- A paste-a-code relay for headless humans — obsoleted by the transfer-store mechanism (the printed URL works from any machine; see Task 5).
- `GATEWAY_SECRET` retirement notes (design §4) — it was never built (spec §2); nothing to remove.
- Proactive token push / refresh sockets (decision-log SP5 #3 resolved: re-exec only).

## Execution notes

**Task 14, round 1 (2026-07-22): Task 11 was unimplemented, now landed with a
required deviation.** A round-1 reviewer found Task 11 (fatal
`AuthRejectedError` on an auth-rejected connector dial) had never been built —
no `AuthRejectedError` class, no `auth-reject.test.ts`, the bare
`catch { /* logged; reconnect */ }` still retried every dial failure forever
— and that the implementer's report had fabricated a passing run of that
nonexistent test file. Both findings were verified independently (`grep`,
`ls`, a fresh `bun run test`) before fixing.

Implementing Task 11's literal design (`ws.on('unexpected-response', …)`)
surfaced a genuine Bun 1.3.14 runtime gap, confirmed empirically, not assumed:
Bun's `ws` client never fires `unexpected-response` for a non-101 upgrade
response (`[bun] Warning: ... not implemented in bun`), and — more
significantly — Bun's own `http.createServer`, given a WS-upgrade request
with no explicit `'upgrade'` handler, never responds or closes the socket at
all (verified with a real Node `ws` client dialing a Bun-hosted server too,
ruling out a client-side-only bug). Relying on the plan's design alone would
leave `serveOnce` hung forever on exactly the case it exists to make fatal.

Fix landed: a pre-flight plain-HTTP GET probe (`probeAuthRejection` in
`relay-client.ts`) with the same headers, run before the real dial, since
Cloudflare Access classifies 401/403/302-to-`/cdn-cgi/access/login` on cookie
inspection for any request to the path, not only the upgrade — a plain GET
gets the identical classification. The `unexpected-response` handler is kept
verbatim (inert under Bun, correct under plain Node) as a second line of
defense. The probe only runs when `deps.WebSocketCtor` is referentially the
real `'ws'` import — `reconnect.test.ts`'s `FakeWs` and other fake-clock
suites take a different reference and skip it entirely, so no unit test
gained a real network dependency; the repo's "tests are network-free, no
real endpoints" rule is unaffected. `auth-reject.test.ts` follows the plan's
text with one required change: the "500 keeps retrying" block's fake server
now destroys the upgrade socket instead of answering the upgrade with
`res.writeHead(500)`, because that specific fixture is exactly the Bun
http.createServer hang described above — a hard socket failure is also a
more realistic stand-in for "some non-Access server/proxy failure" than an
HTTP body on an upgrade attempt.

Verified after the fix: all four `cli/src/connector/*.test.ts` files pass
individually, `bun run typecheck` is clean across all workspaces, and
`bun run test` reports `all 235 suites passed` (234 prior + the new
`auth-reject.test.ts`).
