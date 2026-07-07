# Gateway-id Identity Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each terminal-gateway registration to the identity that created it so a different identity can't take over a live gateway id, with a fail-closed dev/production split driven by `accessVerificationEnabled()`.

**Architecture:** A new `resolveGatewayOwner` (in `whoami.ts`) maps the CF Access headers on the WS upgrade to a principal (`sso:…`/`token:…`/`dev`) or `null` (reject). `GatewayRegistry.connect` gains an `ownerIdentity`, replaces only on the same owner, and returns `null` on a different one. `handleUpgrade` resolves the owner, refuses a `null` owner before upgrading and a different owner after.

**Tech Stack:** Bun ≥ 1.3.14, TypeScript, `ws`, Cloudflare Access JWTs.

Spec: `docs/superpowers/specs/2026-07-05-gateway-id-binding-design.md`. Builds on `server/src/whoami.ts` (`resolveCaller`, the internal `serviceTokenCommonName`), `access-identity.ts` (`getAccessIdentity`, `accessVerificationEnabled`), `service-tokens.ts` (`lookupServiceToken`).

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
4. **`tmux` + `bash`** on PATH for the full suite.

---

## Task 1 — `resolveGatewayOwner` (TDD)

**Files:**
- Create: `server/src/gateway-owner.test.ts`
- Modify: `server/src/whoami.ts`

- [ ] **Step 1: Write the failing test.** Create `server/src/gateway-owner.test.ts`:
  ```ts
  // Run: bun src/gateway-owner.test.ts   (from server/)
  // resolveGatewayOwner: dev mode synthesises 'dev' and binds identities; strict
  // mode (accessVerificationEnabled) rejects anonymous + dev fallbacks. Network-free
  // (strict cases use no JWT → no JWKS fetch).
  import assert from 'node:assert/strict'
  import { mkdtempSync, writeFileSync } from 'node:fs'
  import os from 'node:os'
  import path from 'node:path'

  // Start in dev mode: no CF Access verification, no dev-identity fallback.
  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ew-gw-owner-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(mapFile, ['[tokens."a.access"]', 'identity = "🤖 A"', 'scope = "read-write"'].join('\n') + '\n')
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const { resolveGatewayOwner } = await import('./whoami.ts')

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`

  // --- dev mode (accessVerificationEnabled() false) ---
  assert.equal(await resolveGatewayOwner({}), 'dev', 'anonymous → dev (synthetic)')
  assert.equal(
  	await resolveGatewayOwner({ 'cf-access-authenticated-user-email': 'x@y.com' }),
  	'sso:x@y.com',
  	'human → sso:<email>',
  )
  assert.equal(
  	await resolveGatewayOwner({ 'cf-access-jwt-assertion': jwt({ common_name: 'a.access' }) }),
  	'token:a.access',
  	'mapped token → token:<common_name>',
  )
  assert.equal(
  	await resolveGatewayOwner({ 'cf-access-jwt-assertion': jwt({ common_name: 'nope.access' }) }),
  	'dev',
  	'unmapped token → dev (treated as anonymous)',
  )

  // --- strict mode (verification configured; no JWT used → no network) ---
  process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com'
  process.env.CF_ACCESS_AUD = 'dummy-aud'
  assert.equal(await resolveGatewayOwner({}), null, 'strict: anonymous → reject')
  process.env.EW_DEV_IDENTITY_EMAIL = 'dev@example.com'
  assert.equal(await resolveGatewayOwner({}), null, 'strict: dev fallback (unverified) → reject')
  delete process.env.EW_DEV_IDENTITY_EMAIL

  console.log('ok: resolveGatewayOwner')
  ```

- [ ] **Step 2: Run it — expect failure** (export missing):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/gateway-owner.test.ts)
  ```
  Expected: error that `resolveGatewayOwner` is not exported / not a function.

- [ ] **Step 3: Add `resolveGatewayOwner` to `server/src/whoami.ts`.** Append it after `resolveWriteScope` (it reuses the module-internal `serviceTokenCommonName` and the already-imported `accessVerificationEnabled`, `getAccessIdentity`, `lookupServiceToken` — no import changes):
  ```ts
  /**
   * The principal to bind a terminal-gateway registration to, or null to REJECT
   * the connect. accessVerificationEnabled() is the strict (production) switch:
   * strict instances require a real verified identity and reject anonymous / dev
   * fallbacks; non-strict (dev) instances synthesise a `dev` owner for an
   * otherwise anonymous caller. Prefixed so principals can't collide.
   */
  export async function resolveGatewayOwner(headers: IncomingHttpHeaders): Promise<string | null> {
  	const strict = accessVerificationEnabled()
  	const human = await getAccessIdentity(headers)
  	if (human) {
  		if (strict && !human.verified) return null // dev/unverified identity in production
  		return `sso:${human.email}`
  	}
  	const commonName = await serviceTokenCommonName(headers)
  	if (commonName && lookupServiceToken(commonName)) return `token:${commonName}`
  	// Anonymous — no resolvable identity.
  	return strict ? null : 'dev'
  }
  ```

- [ ] **Step 4: Run the test — expect pass:**
  ```bash
  (cd server && bun src/gateway-owner.test.ts)
  ```
  Expected: `ok: resolveGatewayOwner`.

- [ ] **Step 5: Typecheck green:**
  ```bash
  bun run typecheck
  ```

- [ ] **Step 6: Commit:**
  ```bash
  git add server/src/whoami.ts server/src/gateway-owner.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): resolveGatewayOwner — gateway-connect principal + strict/dev policy

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — bind the id in `gateway-registry.ts` (connect + handleUpgrade)

`connect` gains a required `ownerIdentity` (so its signature change and the `handleUpgrade` caller update land together to stay typecheck-green). The registry binding is unit-tested with the existing fakes; `handleUpgrade` wiring is covered by typecheck here and end-to-end in Task 3.

**Files:**
- Modify: `server/src/gateway-registry.ts`
- Modify: `server/src/gateway-registry.test.ts`

- [ ] **Step 1: Update the failing test first.** In `server/src/gateway-registry.test.ts`:
  - The existing two `reg.connect(...)` calls need the new owner arg + null-narrowing. Change line ~51 `const entry1 = reg.connect('gw-a', 'Box A', gw1)` to:
    ```ts
  	const entry1 = reg.connect('gw-a', 'Box A', gw1, 'token:a')
  	assert.ok(entry1, 'first connect registers')
    ```
    and line ~121 `const entry2 = reg.connect('gw-a', 'Box A again', gw2)` to (SAME owner so the reconnect still replaces):
    ```ts
  	const entry2 = reg.connect('gw-a', 'Box A again', gw2, 'token:a')
  	assert.ok(entry2, 'same-owner reconnect replaces')
    ```
  - Add a new owner-binding block at the end of `main()` (before the final closing brace / `console.log`):
    ```ts
  	// --- owner binding: reject a different identity, allow same-identity replace ---
  	{
  		const reg2 = new GatewayRegistry()
  		const wsA = fakeSocket()
  		const a = reg2.connect('g', 'A', wsA, 'token:a')
  		assert.ok(a, 'first connect registers')
  		const browser = fakeSocket()
  		openChannel(a, browser, 's1', 80, 24)
  		// A different identity is rejected; A + its browser survive.
  		const wsB = fakeSocket()
  		assert.equal(reg2.connect('g', 'B', wsB, 'token:b'), null, 'different owner → rejected')
  		assert.equal(wsA.closed, false, 'existing gateway untouched')
  		assert.equal(browser.closed, false, 'riding browser untouched')
  		assert.equal(reg2.list()[0]!.label, 'A', 'still A')
  		// Same identity reconnects → replaces (old socket + browser closed).
  		const wsA2 = fakeSocket()
  		const a2 = reg2.connect('g', 'A2', wsA2, 'token:a')
  		assert.ok(a2, 'same owner reconnect replaces')
  		assert.equal(wsA.closed, true, 'old gateway socket closed on replace')
  		assert.equal(browser.closed, true, 'old riding browser closed on replace')
  		assert.equal(reg2.list()[0]!.label, 'A2', 'now A2')
  		console.log('ok: gateway owner binding')
  	}
    ```

- [ ] **Step 2: Run it — expect failure** (connect doesn't take a 4th arg yet):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/gateway-registry.test.ts)
  ```
  Expected: FAIL — a TypeScript/argument error on the 4-arg `connect`, or the binding block's assertions.

- [ ] **Step 3: Add `ownerIdentity` to `GatewayEntry`.** In `server/src/gateway-registry.ts`, the interface (~lines 38-45). Before:
  ```ts
  export interface GatewayEntry {
  	gatewayId: string
  	label: string
  	ws: RelaySocket
  	connectedAt: number
  	channels: Map<number, RelaySocket>
  	nextChannelId: number
  }
  ```
  After:
  ```ts
  export interface GatewayEntry {
  	gatewayId: string
  	label: string
  	ws: RelaySocket
  	ownerIdentity: string
  	connectedAt: number
  	channels: Map<number, RelaySocket>
  	nextChannelId: number
  }
  ```

- [ ] **Step 4: Bind in `connect`.** Replace the whole `connect` method (the doc comment + body, ~lines 61-81). Before:
  ```ts
  	/** Connect-equals-register. A reconnect with a live id replaces it: the old
  	 * socket and every browser riding it are closed (their client-side backoff
  	 * re-establishes channels on the new connection). */
  	connect(gatewayId: string, label: string, ws: RelaySocket): GatewayEntry {
  		const existing = this.gateways.get(gatewayId)
  		if (existing) {
  			for (const browser of existing.channels.values()) browser.close()
  			existing.channels.clear()
  			existing.ws.close()
  		}
  		const entry: GatewayEntry = {
  			gatewayId,
  			label,
  			ws,
  			connectedAt: Date.now(),
  			channels: new Map(),
  			nextChannelId: 1,
  		}
  		this.gateways.set(gatewayId, entry)
  		return entry
  	}
  ```
  After:
  ```ts
  	/** Connect-equals-register, bound to the caller's identity. A reconnect by the
  	 * SAME owner replaces the live id (old socket + riding browsers closed; their
  	 * client-side backoff re-establishes channels). A connect by a DIFFERENT owner
  	 * is rejected (returns null) and leaves the existing gateway untouched. */
  	connect(gatewayId: string, label: string, ws: RelaySocket, ownerIdentity: string): GatewayEntry | null {
  		const existing = this.gateways.get(gatewayId)
  		if (existing && existing.ownerIdentity !== ownerIdentity) return null
  		if (existing) {
  			for (const browser of existing.channels.values()) browser.close()
  			existing.channels.clear()
  			existing.ws.close()
  		}
  		const entry: GatewayEntry = {
  			gatewayId,
  			label,
  			ws,
  			ownerIdentity,
  			connectedAt: Date.now(),
  			channels: new Map(),
  			nextChannelId: 1,
  		}
  		this.gateways.set(gatewayId, entry)
  		return entry
  	}
  ```

- [ ] **Step 5: Import `resolveGatewayOwner` + rewire `handleUpgrade`.** Add the import near the top of `server/src/gateway-registry.ts` (after the `ws` import):
  ```ts
  import { resolveGatewayOwner } from './whoami.ts'
  ```
  Then replace the `/api/gateway/connect` body in `handleUpgrade` (~lines 221-237). Before:
  ```ts
  			const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
  			void accept(req, socket, head).then((ws) => {
  				const entry = registry.connect(gatewayId, label, ws)
  				console.log(`[gateway ${gatewayId}] connected (${label})`)
  				ws.on('message', (data, isBinary) => onGatewayFrame(entry, data as Buffer, isBinary))
  				ws.on('close', () => {
  					registry.disconnect(gatewayId, ws)
  					console.log(`[gateway ${gatewayId}] disconnected`)
  				})
  			})
  			return true
  ```
  After:
  ```ts
  			const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
  			void (async () => {
  				const owner = await resolveGatewayOwner(req.headers)
  				if (owner === null) {
  					// No resolvable identity (config error, or an anonymous/dev connect
  					// to an authenticated instance) — refuse before upgrading.
  					console.warn(`[gateway ${gatewayId}] rejected: no resolvable identity`)
  					socket.destroy()
  					return
  				}
  				const ws = await accept(req, socket, head)
  				const entry = registry.connect(gatewayId, label, ws, owner)
  				if (!entry) {
  					console.warn(`[gateway ${gatewayId}] rejected: id owned by another identity`)
  					ws.close(1008, 'gateway id owned by another identity')
  					return
  				}
  				console.log(`[gateway ${gatewayId}] connected (${label}) as ${owner}`)
  				ws.on('message', (data, isBinary) => onGatewayFrame(entry, data as Buffer, isBinary))
  				ws.on('close', () => {
  					registry.disconnect(gatewayId, ws)
  					console.log(`[gateway ${gatewayId}] disconnected`)
  				})
  			})()
  			return true
  ```

- [ ] **Step 6: Run the registry test + typecheck — expect pass:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/gateway-registry.test.ts)
  bun run typecheck
  ```
  Expected: the registry test prints its `ok:` lines including `ok: gateway owner binding`; `bun run typecheck` exits 0.

- [ ] **Step 7: Commit:**
  ```bash
  git add server/src/gateway-registry.ts server/src/gateway-registry.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): bind gateway id to its owner; reject cross-identity takeover

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — WS integration test + full gate

**Files:**
- Create: `server/src/gateway-identity.test.ts`

- [ ] **Step 1: Write the integration test.** Create `server/src/gateway-identity.test.ts`:
  ```ts
  // Run: bun src/gateway-identity.test.ts   (from server/)
  // WS integration for gateway-id binding (network-free): in dev mode a different
  // identity can't take over a live gateway id and the same identity replaces; in
  // strict mode an anonymous connect is refused before upgrade.
  import assert from 'node:assert/strict'
  import { writeFileSync } from 'node:fs'
  import { mkdtemp } from 'node:fs/promises'
  import os from 'node:os'
  import path from 'node:path'
  import WebSocket from 'ws'
  import { createSyncApp } from './app.ts'
  import { makeTestClient } from './test-helpers.ts'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-identity-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(
  	mapFile,
  	[
  		'[tokens."a.access"]',
  		'identity = "🤖 A"',
  		'scope = "read-write"',
  		'[tokens."b.access"]',
  		'identity = "🤖 B"',
  		'scope = "read-write"',
  	].join('\n') + '\n',
  )
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
  const closed = (ws: WebSocket) =>
  	new Promise<void>((resolve) => {
  		if (ws.readyState === WebSocket.CLOSED) return resolve()
  		ws.once('close', () => resolve())
  	})

  // --- dev mode: cross-identity binding over real WS ---
  {
  	const { server } = createSyncApp({ dataDir: dir })
  	await new Promise<void>((r) => server.listen(0, r))
  	const address = server.address() as { port: number }
  	const base = `http://127.0.0.1:${address.port}`
  	const wsBase = `ws://127.0.0.1:${address.port}`
  	const { getJson } = makeTestClient(base)
  	const ids = async () =>
  		((await getJson('/api/gateway/list')).body.gateways as Array<{ gatewayId: string }>).map((g) => g.gatewayId)
  	const openGw = (id: string, token?: string) =>
  		new Promise<WebSocket>((resolve, reject) => {
  			const headers = token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}
  			const ws = new WebSocket(`${wsBase}/api/gateway/connect?gatewayId=${id}&label=${id}`, { headers })
  			ws.once('open', () => resolve(ws))
  			ws.on('error', reject)
  		})

  	const a = await openGw('g1', 'a.access')
  	assert.ok((await ids()).includes('g1'), 'A registered g1')

  	// bot B tries g1 → rejected (its ws closes 1008); A + g1 survive.
  	const b = await openGw('g1', 'b.access')
  	await closed(b)
  	assert.ok((await ids()).includes('g1'), 'g1 survives B rejection')
  	assert.equal(a.readyState, WebSocket.OPEN, 'A still connected')

  	// A reconnects (same owner) → replaces; old A closes.
  	const a2 = await openGw('g1', 'a.access')
  	await closed(a)
  	assert.ok((await ids()).includes('g1'), 'g1 survives A replace')

  	// anonymous (dev owner) can't take over A2's g1 → rejected.
  	const anon = await openGw('g1')
  	await closed(anon)
  	assert.equal(a2.readyState, WebSocket.OPEN, 'A2 keeps g1 after anon rejected')

  	a2.close()
  	server.close()
  }

  // --- strict mode: an anonymous connect is refused before upgrade (network-free) ---
  {
  	process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com'
  	process.env.CF_ACCESS_AUD = 'dummy-aud'
  	const { server } = createSyncApp({ dataDir: dir })
  	await new Promise<void>((r) => server.listen(0, r))
  	const address = server.address() as { port: number }
  	const wsBase = `ws://127.0.0.1:${address.port}`
  	await assert.rejects(
  		new Promise<WebSocket>((resolve, reject) => {
  			const ws = new WebSocket(`${wsBase}/api/gateway/connect?gatewayId=g9&label=g9`)
  			ws.once('open', () => resolve(ws))
  			ws.on('error', reject)
  		}),
  		'strict mode: anonymous gateway connect refused',
  	)
  	server.close()
  	delete process.env.CF_ACCESS_TEAM_DOMAIN
  	delete process.env.CF_ACCESS_AUD
  }

  console.log('gateway-identity.test.ts: all assertions passed')
  process.exit(0)
  ```

- [ ] **Step 2: Run it — expect pass:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/gateway-identity.test.ts)
  ```
  Expected: `gateway-identity.test.ts: all assertions passed`. (If the dev-mode reject cases hang, the `closed()` already-closed guard handles the 1008-close race; the strict-mode case rejects because the upgrade is destroyed pre-handshake.)

- [ ] **Step 3: Behaviour-neutral guard + full gate:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/gateway-plane.test.ts)   # unchanged; dev mode → owner 'dev' → replace still works
  bun run typecheck
  bun run test     # ends "all N suites passed" (N = prior total + 2)
  bun run build
  ```
  Expected: `gateway-plane.test.ts: all assertions passed`; typecheck 0; the suite count is prior + 2 (`gateway-owner`, `gateway-identity`); build 0. `bun run test` spawns tmux and takes a few minutes — let it finish. Report the count.

- [ ] **Step 4: Commit:**
  ```bash
  git add server/src/gateway-identity.test.ts
  git commit -m "$(cat <<'EOF'
  test(server): gateway-id binding WS integration (cross-identity reject, strict refuse)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count and any deviation from the verbatim blocks above.)_
