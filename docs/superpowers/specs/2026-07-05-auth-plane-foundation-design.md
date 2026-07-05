# Auth-plane foundation — identity resolution + whoami

**Phase 3, sub-project 3c (foundation slice).** The additive first slice of the
auth plane: resolve a caller's identity as `human | bot | anonymous` (with a
`via` provenance), load a server-side service-token → `{identity, scope}` config
map, and serve `GET /api/whoami`. **No change to any existing write, read, or
git-co-author behaviour.** Enforcement (attribution stamping, write scoping,
gateway-id identity binding) is deferred to follow-on slices that build on the
identity this one resolves.

## Background

Today the server has a **human** identity path only: `access-identity.ts`
verifies Cloudflare Access JWTs (GitHub SSO → email) — three modes (`verified`
via JWKS, `header`-trust behind the tunnel, `dev` fallback) — and the result
feeds git-co-author attribution (presence-based, in `app.ts` at WS upgrade).
There is **no bot/service-token concept, no whoami endpoint, no write scoping,
and no server-side attribution** anywhere. Agent writes are unauthenticated at
the app layer (localhost/"none" instances) or gated only by CF Access as a
human; `bin/canvas`'s `--author` is a client-side text-prefix convention, not
server state.

The design (`docs/unified-architecture-design.md` §6.4) calls for CF Access
**service tokens** (bots) alongside the human path: a config map from the
service token's identifier → a bot identity + write scope, a
`GET /api/whoami → {identity, kind, via}` envelope shared with the CLI's
`auth status`, and (later) attribution + scoping + gateway-id binding.

## Goal

Add the identity-resolution foundation and `GET /api/whoami`, purely additively,
so later slices can enforce attribution/scoping against a single resolved
identity — and so the CLI (sub-project 4) has a `whoami` to render.

## Scope

**In scope**
- `contracts/src/whoami.ts` — the shared `Whoami` envelope (type + Zod schema),
  exported from the contracts barrel (browser-safe; the CLI reuses it).
- `server/src/service-tokens.ts` — load + cache the config-folder TOML map.
- `server/src/access-identity.ts` — a **behaviour-preserving** refactor exposing
  the verified JWT claims (so the service-token `common_name` is reachable);
  `getAccessIdentity` output is unchanged.
- `server/src/whoami.ts` — `resolveCaller(headers): Promise<Whoami>` composing
  the human path + the service-token path.
- `server/src/features/whoami.ts` + a mount in `app.ts` — `GET /api/whoami`.
- Tests for the map loader, `resolveCaller`, and a `getAccessIdentity`
  behaviour-preservation guard.

**Out of scope (deferred to later 3c slices)**
- Attribution enforcement (stamping the bot identity onto writes; `--author`
  ignored/must-match).
- Per-token write scoping enforcement (read-only rejects writes). The `scope`
  field is *parsed and stored* here, but nothing enforces it yet.
- Gateway-id identity binding (`gateway-registry.ts`).
- The clean per-plugin route rename (sub-project 3a) — `whoami` is a kernel route
  (`/api/whoami`), unaffected by that rename.
- Any CLI-side `hosts.toml` / credential storage (sub-project 4).

## Config placement (decided)

The service-token map is **operator config, not server data**, so it lives in the
config folder alongside the deploy's `*.env` files, **not** in `DATA_DIR`:

- Default: `${XDG_CONFIG_HOME:-$HOME/.config}/ensembleworks/service-tokens.toml`
- Override: `EW_SERVICE_TOKENS_FILE` (absolute path) — used by `deploy.sh`/tests.
- Missing file → empty map (the "none"-instance case; no bots recognised).

It holds **no secrets**: CF Access validates the service token; the server only
maps an *already-authenticated* `common_name` to an identity + scope. (Contrast
the client's `hosts.toml`, which holds token secrets and is mode 0600.)

## Components

### `contracts/src/whoami.ts` (new, browser-safe)

```ts
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

Exported from `contracts/src/index.ts` (the barrel) — it is a pure type/schema,
safe for the browser, and the CLI's `auth status` will reuse it. (Note: unlike
`session-manager`, this genuinely belongs in the barrel.)

### `server/src/service-tokens.ts` (new)

Loads the config-folder TOML map with `Bun.TOML.parse`, cached by `mtime` so
edits are picked up without a restart. File schema:

```toml
[tokens."codespace-3.access"]      # keyed by the CF Access service-token common_name
identity = "🤖 codespace-3"
scope    = "read-write"            # "read-only" | "read-write"; parsed now, ENFORCED later
```

```ts
export interface ServiceTokenEntry {
  identity: string
  scope: 'read-only' | 'read-write'
}
export function lookupServiceToken(commonName: string): ServiceTokenEntry | null
```

- Path: `process.env.EW_SERVICE_TOKENS_FILE` or the XDG default above.
- Read-fail / missing file → empty map (lookups return `null`).
- Parse error → log a warning + empty map (**fail closed**: an unparseable file
  recognises no tokens rather than crashing the server).
- Per-entry validation: an entry missing `identity` is skipped; `scope` defaults
  to `'read-only'` (the safe default) when absent or not one of the two literals.
- `mtime` cache: stat the file per lookup; re-read + re-parse only when `mtimeMs`
  changes (or on first use). Missing-file state is cached too.

### `server/src/access-identity.ts` (behaviour-preserving refactor)

The internal `verifyCfAccessJwt(token): Promise<{email} | null>` becomes
`verifyCfAccessClaims(token): Promise<{ email?: string; commonName?: string } | null>`:
same signature/aud/exp/nbf/iss verification, but it returns whatever identity
claims the verified payload carries — `email` for humans, `common_name` for
service tokens — instead of requiring `email`.

`getAccessIdentity` is rewired to call `verifyCfAccessClaims` and **keep its exact
current behaviour**: it returns `{ email, verified: true }` only when a verified
`email` is present, and `null` otherwise (including for a valid service-token JWT
that has no email — exactly as today, where `verifyCfAccessJwt` returned `null`
for a claim set without an email). The `header`-trust and `dev` branches are
unchanged. This preserves the co-author path in `app.ts`/`sessions.ts`/
`presence.ts` and the `AccessIdentity` type.

A small exported helper `decodeCfAccessClaimsUnverified(token): { email?; commonName? } | null`
base64url-decodes the JWT payload **without** verifying — used only in
`header`-trust mode (the same tunnel trust basis as reading the `Cf-Access…-Email`
header today).

### `server/src/whoami.ts` (new) — `resolveCaller`

```ts
export async function resolveCaller(headers: IncomingHttpHeaders): Promise<Whoami>
```

Resolution order:
1. **human** — `const id = await getAccessIdentity(headers)`; if non-null →
   `{ identity: id.name ?? id.email, kind: 'human', via: 'sso' }`.
2. **bot** — else, obtain `common_name`:
   - verified mode (`accessVerificationEnabled()`): from
     `verifyCfAccessClaims(jwt)?.commonName`;
   - header-trust mode: from `decodeCfAccessClaimsUnverified(jwt)?.commonName`.
   If a `common_name` resolves and `lookupServiceToken(common_name)` hits →
   `{ identity: entry.identity, kind: 'bot', via: 'service-token' }`.
3. **anonymous** — otherwise `{ identity: null, kind: 'anonymous', via: 'none' }`
   (covers no headers, an unknown/unmapped service token, and an unverifiable JWT
   in verified mode).

Reusing `getAccessIdentity` for the human branch keeps the three-mode
(verified/header/dev) logic in one place; the cost is that verified mode reads
the JWT claims twice (once for the human check, once for `common_name`). That is
acceptable on the low-frequency `whoami` endpoint; when enforcement makes
`resolveCaller` run per-write, consolidate to a single claim resolution then.

### `server/src/features/whoami.ts` + `app.ts` mount

A one-route router `createWhoamiRouter()` (no `ctx` needed) handling
`GET /api/whoami`:

```ts
router.get('/api/whoami', async (req, res) => {
  res.json(await resolveCaller(req.headers))
})
```

Mounted in `app.ts` alongside the other feature routers (or inline next to
`/api/health`). It is `/api/whoami` — a kernel/auth route, deliberately not
plugin-namespaced, and untouched by the sub-project 3a route rename.

## The one verify-step

The exact CF Access **service-token JWT claim** carrying the token identifier —
designed here as `common_name` — is confirmed during implementation against a
crafted JWT (CF Access service-token assertions carry `common_name`; if the real
claim differs, e.g. `sub`/`azp`, only the extraction in `verifyCfAccessClaims`/
`decodeCfAccessClaimsUnverified` and the map key adjust). The `Whoami` surface,
the config schema, and `resolveCaller`'s shape stay fixed. (Same pattern as the
Bun.Terminal spike in sub-project 1.)

## Behaviour-neutrality & testing

Purely additive: a new endpoint, a new config file (empty when absent), and a
refactor that provably preserves `getAccessIdentity`.

- **`server/src/service-tokens.test.ts`** — write a temp TOML file + point
  `EW_SERVICE_TOKENS_FILE` at it: a valid entry resolves; a missing file → `null`
  lookups; malformed TOML → `null` lookups (fail-closed); `scope` default is
  `read-only`; an mtime change is picked up.
- **`server/src/whoami-api.test.ts`** — boot the sync app (like the other
  `*-api.test.ts`) and hit `GET /api/whoami`, in the default `header`-trust mode
  (network-free):
  - no headers → `{identity:null, kind:'anonymous', via:'none'}`;
  - `Cf-Access-Authenticated-User-Email` header → `{identity: <email>, kind:'human', via:'sso'}`;
  - `Cf-Access-Jwt-Assertion` = an (unsigned) JWT whose payload has a
    `common_name` present in a temp map → `{identity:<mapped>, kind:'bot', via:'service-token'}`;
  - the same JWT with a `common_name` **not** in the map → anonymous.
- **`getAccessIdentity` guard** (in the whoami/access-identity test) — for a
  human email header and for a bot-shaped claim set, `getAccessIdentity` returns
  exactly what it does today (`{email, verified}` for the human; `null` for the
  bot). This locks the behaviour-preserving refactor.
- Whole-suite gates: `bun run typecheck` and `bun run test`
  (`all N suites passed`, +2 new suites) stay green; `bun run build` (client
  bundles the `Whoami` type but no server code) stays green.

Verified-mode JWKS verification is existing (untested) production code exercised
by the same claim-extraction path; the new tests stay network-free (header-trust
+ dev + anonymous), and the verify-step covers the service-token claim.

## Risks

- **R1 — refactoring `access-identity.ts` without changing `getAccessIdentity`.**
  Mitigated by the guard test + the co-author path; the change is internal
  (claim extraction), the public function's contract is unchanged.
- **R2 — the service-token claim name.** Handled by the verify-step; isolated to
  two extraction sites + the map key.
- **R3 — config file trust/permissions.** The file holds no secrets; a
  fail-closed parse means a bad/missing file degrades to "no bots," never a
  crash or an open door.
