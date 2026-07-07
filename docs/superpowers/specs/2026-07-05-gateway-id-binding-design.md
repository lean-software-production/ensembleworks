# Gateway-id identity binding

**Phase 3, sub-project 3c-enforcement (slice 2 of 3).** Bind each terminal-gateway
registration to the identity that created it, so a different identity can no
longer take over a live gateway id — closing the termgw spike's accepted risk.

## Background

`gateway-registry.ts`'s `connect(gatewayId, …)` currently lets *any* reconnect
with a live id replace it (it closes the old socket + its riding browsers and
re-registers). There is no notion of who owns a gateway id. On an authenticated
instance that means a second identity can hijack another's gateway. The auth-plane
foundation now lets us resolve the connecting caller's identity from the CF Access
headers on the WS upgrade request.

## Goal

At `/api/gateway/connect`, resolve the caller's identity, bind the gateway id to
it, and reject a connect whose identity differs from the id's current owner —
with a **fail-closed dev/production split** driven by the existing
`accessVerificationEnabled()` switch, so a bare (null) identity is never a valid
gateway owner in production.

## The owner policy (decided)

`accessVerificationEnabled()` (true when `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`
are configured — the production CF-Access posture) is the "strict" switch. Per
connect:

- **Real verified identity** (a CF Access verified human, or a service token in
  the map) → bind to it.
- **Dev / unverified human** (an `EW_DEV_IDENTITY_EMAIL` fallback, `verified:false`)
  reaching a strict/verified instance → **reject** ("production rejects dev
  identities").
- **Anonymous** (no resolvable identity):
  - strict/verified instance → **reject** (a null owner is never valid — config
    error);
  - non-strict/dev instance → a synthetic **`dev`** owner (so a local no-auth box
    still connects).

The principal strings (`sso:<email>`, `token:<common_name>`, `dev`) can't collide.
Binding on the mapped bot identity / human email is also semantically right: two
tokens an operator maps to the same identity are the same principal. This
replaces the design doc's "none instances stay open" with a stricter,
fail-closed posture: strict when CF Access is configured, synthetic-dev
otherwise, never a null owner.

## Components

### `server/src/whoami.ts` — `resolveGatewayOwner`

Add alongside `resolveCaller`/`resolveWriteScope` (reusing the module-internal
`serviceTokenCommonName` and the already-imported `getAccessIdentity`,
`accessVerificationEnabled`, `lookupServiceToken` — no new imports):

```ts
/**
 * The principal to bind a terminal-gateway registration to, or null to REJECT
 * the connect. `accessVerificationEnabled()` is the strict (production) switch:
 * strict instances require a real verified identity and reject anonymous / dev
 * fallbacks; non-strict (dev) instances synthesise a `dev` owner for an otherwise
 * anonymous caller. Prefixed so principals can't collide.
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

Notes: in strict mode a service token is inherently verified (`serviceTokenCommonName`
uses the signature-verifying path there), so no extra verified check is needed on
the bot branch. An unknown/unmapped token falls through to the anonymous branch
(dev → `dev`, strict → reject) — matching `resolveCaller`, which treats it as
anonymous.

### `server/src/gateway-registry.ts` — bind the id

- `GatewayEntry` gains `ownerIdentity: string`.
- `connect` takes the owner and can reject:
  ```ts
  connect(gatewayId: string, label: string, ws: RelaySocket, ownerIdentity: string): GatewayEntry | null {
  	const existing = this.gateways.get(gatewayId)
  	if (existing && existing.ownerIdentity !== ownerIdentity) return null // owned by another identity — reject, leave it untouched
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
  A same-owner reconnect replaces exactly as today; a different-owner connect
  returns `null` and leaves the existing gateway (and its browsers) untouched.
  `disconnect` (socket-identity check) and everything else are unchanged.

### `server/src/gateway-registry.ts` — `handleUpgrade` wiring

Import `resolveGatewayOwner` from `./whoami.ts`. In the `/api/gateway/connect`
branch, resolve the owner and reject cleanly:

```ts
void (async () => {
	const owner = await resolveGatewayOwner(req.headers)
	if (owner === null) {
		// No resolvable identity (config error, or an anonymous/dev connect to an
		// authenticated instance) — refuse before upgrading.
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
```

Two reject paths: a **null owner** is refused *before* the WS upgrade
(`socket.destroy()`); a **different owner** is refused *after* upgrade
(`ws.close(1008, …)`), since the owner check is synchronous inside `connect`
(race-free) and needs the accepted socket to close. The relay/browser splice
(`/api/term/relay`), `onGatewayFrame`, and the heartbeat are untouched.

## Behaviour-neutrality

The existing **`gateway-plane.test.ts`** runs with no CF Access config →
`accessVerificationEnabled()` false → dev mode → its (header-less) anonymous
connects all resolve to owner `dev`. gw and gw2 in its step-8 replacement share
owner `dev` → same owner → the replacement still succeeds. So it passes
unchanged, and is the behaviour-neutrality guard for the happy/replace path. The
separate terminal-gateway process (`terminal-gateway.ts`, port 8789) is not
touched.

## Testing

- **`server/src/gateway-owner.test.ts`** (unit, network-free): `resolveGatewayOwner`
  — dev mode (CF_ACCESS_* unset, a temp service-token map): anonymous → `dev`,
  email header → `sso:<email>`, service-token JWT (unsigned, header-trust decode)
  → `token:<common_name>`, unknown token → `dev`. Strict mode (CF_ACCESS_* set to
  dummy values — no JWT, so no JWKS/network): anonymous (no headers) → `null`;
  `EW_DEV_IDENTITY_EMAIL` fallback (no JWT) → `null`.
- **`server/src/gateway-registry.test.ts`** (extend, pure `RelaySocket` fakes, no
  WS): `connect(...owner)` — a new id registers and records the owner; a
  same-owner reconnect replaces (closes the old ws + riding browsers); a
  different-owner connect returns `null` and leaves the existing entry + its
  browser channels intact.
- **`server/src/gateway-identity.test.ts`** (WS integration, dev mode,
  network-free, following `gateway-plane.test.ts`'s helpers): bot-A (JWT
  `a.access`) owns `g1` → bot-B (JWT `b.access`) connect is refused (its ws
  closes; `/api/gateway/list` still shows A's `g1`) → A reconnects (same owner)
  and replaces → an anonymous connect (dev owner `dev`) can't take over A's `g1`.
- **`gateway-plane.test.ts`** unchanged — the behaviour-neutral guard.
- Whole-suite gates: `bun run typecheck`, `bun run test` (`all N suites passed`,
  +2 suites), `bun run build` green.

## Risks

- **R1 — testing the strict/verified *allow* path.** Confirming a verified
  identity is *accepted* in strict mode needs a signed JWT + JWKS (network); it is
  left to the unchanged production verifier (`verifyCfAccessClaims`, exercised by
  the auth-foundation slice). The tests cover the reject paths (anonymous/dev in
  strict) network-free and the full binding logic in dev mode.
- **R2 — WS reject timing.** The different-owner reject opens then closes the ws
  (1008); the test's `closed()` helper needs the already-closed guard (as in
  `gateway-plane.test.ts`) to avoid a race.
- **R3 — dev flattens identities.** In dev mode every anonymous connect is owner
  `dev`, so they can freely replace each other's gateways (the current open
  behaviour, preserved). Real identities (a set `EW_DEV_IDENTITY_EMAIL`, or
  service-token JWTs) still bind distinctly. Acceptable for local dev.
