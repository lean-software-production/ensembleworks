# Write scoping — read-only service tokens can't write

**Phase 3, sub-project 3c-enforcement (slice 1 of 3).** The first enforcement
slice built on the auth-plane foundation: a single write-guard that rejects
**read-only service tokens** on any mutating HTTP method. The other two
enforcement mechanisms — attribution stamping and gateway-id identity binding —
are separate slices.

## Background

The auth-plane foundation (merged `a6ebdfe`) resolves a caller as
`human | bot | anonymous` and loads a service-token map whose entries already
carry a `scope` (`read-only | read-write`) — parsed and stored, but nothing
enforces it yet. This slice enforces it: a `read-only` token may read but not
write.

The write surface is 8 routes on the sync app: `POST /api/{sticky, shape,
terminal-status, roadmap, transcript, kick, pulse}` and `PUT /uploads/:id`.
Today all are open (gated only by CF Access as a human, or fully open on "none"
instances). No server-side authorization exists.

## Goal

Reject read-only-token callers on writes, with a **narrow, config-gated**
behaviour change: the only callers ever newly rejected are read-only service
tokens. Everyone else — humans (SSO), read-write bots, anonymous callers, and
every caller on a "none" instance (no service-token map) — is unaffected.

## Scope

**In scope**
- `server/src/whoami.ts` — extract a shared `serviceTokenCommonName` helper
  (behaviour-preserving refactor of `resolveCaller`) and add
  `resolveWriteScope(headers)`.
- `server/src/features/write-scope.ts` — `createWriteScopeGuard()` middleware.
- `server/src/app.ts` — mount the guard.
- Tests for `resolveWriteScope` and the guard (403) path.

**Out of scope (other slices / later)**
- Attribution stamping (`--author` / bot-identity on writes) — its own slice.
- Gateway-id identity binding (`gateway-registry.ts`, the WS relay plane) — its
  own slice; WS upgrades bypass express and this guard.
- The terminal gateway's own routes (`terminal-gateway.ts`, a separate process
  on port 8789, e.g. `DELETE /term/sessions/:id`) — not the sync app; belongs
  with the gateway slice.
- Per-tool / per-route roles — deferred (design §6.4: "until a real need
  appears").
- Requiring auth to write at all — NOT changed; anonymous/human writes stay open.

## The rule

On the sync app, for any **mutating** HTTP method (anything other than
`GET`/`HEAD`/`OPTIONS`): if the caller resolves to a service token whose `scope`
is `read-only`, respond **403** `{ error: 'read-only token: writes are not
permitted' }`; otherwise continue. One global guard covers all 8 write routes
plus any future one, rather than per-router edits.

## Components

### `server/src/whoami.ts` — refactor + `resolveWriteScope`

Extract the inline "get the service token's `common_name` from the headers
(verified vs header-trust)" block into a module-internal helper, so `resolveCaller`
and the new scope resolver share one implementation. `resolveCaller`'s behaviour
is preserved exactly.

```ts
// module-internal (not exported)
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
```

`resolveCaller`'s bot branch becomes:
```ts
	const commonName = await serviceTokenCommonName(headers)
	if (commonName) {
		const entry = lookupServiceToken(commonName)
		if (entry) return { identity: entry.identity, kind: 'bot', via: 'service-token' }
	}
```

New export:
```ts
/**
 * The caller's service-token write scope, or null if the caller is not a
 * recognised service token (a human, an anonymous caller, or an unknown/unmapped
 * token — all of which are "open" for the write guard). Scope is an authz detail,
 * deliberately kept out of the Whoami identity envelope.
 */
export async function resolveWriteScope(
	headers: IncomingHttpHeaders,
): Promise<'read-only' | 'read-write' | null> {
	const commonName = await serviceTokenCommonName(headers)
	if (!commonName) return null
	return lookupServiceToken(commonName)?.scope ?? null
}
```

Note `resolveWriteScope` does not consult the human path: a human's CF Access JWT
carries `email`, not `common_name`, so `serviceTokenCommonName` returns
`undefined` → `null` → open. An unknown token (`common_name` not in the map) →
`null` → open (matching `resolveCaller`, which treats it as anonymous).

### `server/src/features/write-scope.ts` — the guard

```ts
import type { RequestHandler } from 'express'
import { resolveWriteScope } from '../whoami.ts'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Rejects read-only service tokens on mutating requests (403). Humans,
 * read-write tokens, anonymous callers and "none" instances pass untouched, so
 * this is a no-op unless an operator configured a read-only token. Mounted
 * app-wide before the routers; WS upgrades bypass express and are unaffected.
 */
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

(Express 5 propagates a rejected promise from async middleware to the error
handler; `resolveWriteScope` only throws pathologically — `verifyCfAccessClaims`
already swallows its own errors — so a throw degrades to a 500, never an
accidental pass.)

### `server/src/app.ts` — mount

Add the guard as an app-wide middleware right after `app.use('/api', express.json())`
and before the routes, so it gates `/api/*` writes **and** `/uploads` (which is
not under `/api`):
```ts
	app.use('/api', express.json())
	app.use(createWriteScopeGuard())
```

## Data flow

```
mutating request → writeScopeGuard → resolveWriteScope(headers)
   read-only token → 403
   read-write / human / anonymous / none → next() → the existing route handler
GET/HEAD/OPTIONS → next() immediately (guard is a no-op)
```

## Testing

- **`server/src/write-scope.test.ts`** (unit, header-trust mode, network-free,
  temp map with a `read-only` and a `read-write` entry):
  `resolveWriteScope` returns `'read-only'` for the read-only token's JWT,
  `'read-write'` for the read-write token's JWT, and `null` for an unknown
  `common_name`, a human email header, and no headers.
- **`server/src/write-scope-api.test.ts`** (endpoint): boot `createSyncApp`, then
  `POST /api/sticky` with a valid JSON body:
  - read-only-token JWT header → **403** with the error body;
  - read-write-token JWT header → **200** (sticky created — guard passes);
  - no auth headers (anonymous) → **200** (guard passes; humans/none unaffected);
  - `GET /api/whoami` with the read-only token still succeeds (reads unaffected).
- **Regression guard:** the existing `whoami.test.ts` (resolveCaller matrix) and
  `whoami-api.test.ts` must still pass unchanged — the `serviceTokenCommonName`
  extraction is behaviour-preserving.
- Whole-suite gates: `bun run typecheck` and `bun run test` (`all N suites
  passed`, +2 suites) green; `bun run build` green.

## Risks

- **R1 — the refactor changing `resolveCaller`.** Mitigated: the extraction is
  mechanical (same verified/header-trust branches), and the unchanged
  `whoami.test.ts`/`whoami-api.test.ts` lock `resolveCaller`'s behaviour.
- **R2 — over-blocking.** The guard only ever blocks a `read-only`-scoped token;
  `null` (human/anonymous/none/unknown) and `read-write` pass. No existing caller
  in any test or deployment is a read-only token, so it's inert until configured.
- **R3 — coverage gaps.** A global mutating-method guard auto-covers future write
  routes. WS relay and the separate terminal-gateway process are explicitly out
  of scope (the gateway-binding slice).
