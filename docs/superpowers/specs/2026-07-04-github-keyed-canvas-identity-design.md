# GitHub-keyed Canvas Identity — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** Milestone A only. Milestone B (terminal owner colouring) and the unified
`ensembleworks` CLI are deferred — see [Future work](#future-work).

## Goal

When a user reaches the canvas through GitHub Auth (Cloudflare Access GitHub IdP),
derive their canvas identity from their verified GitHub identity instead of asking
them: **no "Your name" prompt**, a display name from GitHub, and a **stable colour
and identity per person** (consistent across devices/reloads). Outside Access
(local dev, Codespaces that bypass Access), behaviour is unchanged.

This also lays the identity foundation a later feature needs: terminal tiles
coloured by the GitHub identity that launched them (Milestone B, deferred).

## Background — current state

- **Client** (`client/src/identity.ts`): identity is local-only —
  `{ id: crypto.randomUUID(), name: window.prompt(...), colorKey: chosen ?? hash(id) }`,
  all in `localStorage`. `getIdentity()` is synchronous and blocks on a `window.prompt`
  until a name is entered. The `id` is the tldraw presence userId, and per the
  project's identity coupling it also feeds the LiveKit participant identity and the
  transcript speaker.
- **Server** (`server/src/access-identity.ts`): already turns the Cloudflare Access
  headers into an `AccessIdentity { email, name?, verified }`, used today only for git
  co-author attribution. It exposes the **email**, not a GitHub identifier.

## Probe finding (2026-07-04)

A real `/cdn-cgi/access/get-identity` payload from the deployed canvas (GitHub IdP)
was captured. Relevant fields:

```jsonc
{
  "id": 227505,                       // GitHub NUMERIC user id (stable, unique)
  "name": "David Laing",              // GitHub profile display name
  "email": "david@davidlaing.com",    // real email — NOT the @users.noreply.github.com form
  "idp": { "id": "…", "type": "github" },
  "orgs":  [ … , { "id": 298212945, "name": "ensembleworks-dev" } ],
  "teams": [ … , { "name": "ew-staging-001-users", "org_id": 298212945 }, … ]
  // user_uuid / account_id are Cloudflare's own, not GitHub
}
```

Conclusions that shape the design:

- **No GitHub login/handle is exposed** — no `login`/`nickname`/`username` field, and
  the email is a real address, so parsing a handle out of it is impossible.
- **The GitHub numeric user id IS exposed** (`id`), is stable and globally unique, and
  the Codespace side can obtain the exact same number via `gh api user --jq .id`.
  → **Key on the GitHub numeric user id, not the login.**
- `name` is a good display name.
- Bonus (out of scope): `orgs`/`teams` are present and could later scope rooms /
  authorization (e.g. `ew-staging-001-users`). Not used in this milestone.

## Key decisions

| Decision | Choice |
|---|---|
| Canonical identity key | **GitHub numeric user id** (`get-identity` `id`; Codespace `gh api user --jq .id`) |
| Identity model behind Access | **Full**: tldraw `userId = "github:<id>"`; name from GitHub `name`; colour = `hash(userId)`, overridable |
| Identity model in dev/local (no Access) | **Unchanged** — random UUID, `window.prompt` name, `hash(id)` colour |
| Multi-tab | **Accepted constraint**: one tab per person behind Access (see risks) |
| Identity source | Cloudflare Access, read client-side from `/cdn-cgi/access/get-identity` |

## Design

### Identity model

The `Identity` interface shape is unchanged — `{ id, name, colorKey }`. What changes is
the *semantics and source* of those fields behind Access:

- **Behind Access:** `id = "github:" + payload.id` (e.g. `github:227505`),
  `name = payload.name ?? String(payload.id)`,
  `colorKey = localStorage override ?? colorKeyForId(id)`. No prompt. Namespacing the
  id with `github:` keeps it distinct from a dev random UUID and makes the numeric id
  trivially recoverable (strip the prefix) for Milestone B matching. Keying `id` on the
  GitHub numeric id makes presence, LiveKit identity, and transcript speaker stable and
  meaningful per person.
- **Dev/local (no Access):** exactly today's behaviour — random UUID, prompt, hash.

The chosen-colour override key is unchanged, so a user's picked colour still wins.
`colorKeyForId` is now fed the stable `github:<id>` (not a random UUID), so the default
colour is consistent across a person's devices.

### Client resolution flow

`getIdentity()` becomes **async**. On startup:

1. Fetch `GET /cdn-cgi/access/get-identity` (relative; only reachable behind Access),
   with a bounded timeout.
2. **200 and a valid GitHub identity** — `extractGithubIdentity(payload)` returns
   `{ id: "github:<n>", name }` when `payload.id` is a positive integer and
   `payload.idp?.type === "github"`. Then set `colorKey = override ?? colorKeyForId(id)`,
   persist to `localStorage`, and use it. **No prompt.**
3. **non-200 / network error / timeout / not a GitHub identity** → fall back to the
   current local model: existing `localStorage` id or a fresh `crypto.randomUUID()`,
   prompt for the name if unset, `colorKey = override ?? colorKeyForId(id)`.

Callers of `getIdentity()` (startup in `App.tsx`) await it. `peekIdentity()` (the
non-prompting render-path reader) stays synchronous and reads the same `localStorage`
keys, so canvas-render paths are unaffected.

### GitHub identity extraction

`extractGithubIdentity(payload)` is a small pure function:

```
extractGithubIdentity(payload):
  if payload.idp?.type !== "github"        → return null
  if !Number.isInteger(payload.id) || payload.id <= 0 → return null
  return { id: `github:${payload.id}`, name: payload.name || `github:${payload.id}` }
```

No field-guessing or fallback chain — the probe confirmed `id` + `idp.type` are the
reliable, present fields. `null` means "not a usable GitHub identity" and the caller
falls back to the dev/local model.

### Server

No required change for Milestone A — display name and colour are cosmetic and resolved
client-side from `get-identity`. `getAccessIdentity` stays as-is for co-author
attribution. (A verified server `/api/me` is out of scope here; it belongs with
Milestone B / the unified CLI, where a server-trusted identity matters.)

## Non-goals

- No terminal tile colouring (Milestone B).
- No unified `ensembleworks` CLI work.
- No server-side verified identity endpoint.
- No org/team-based room scoping (the payload supports it; deferred).
- No resolving the numeric id back to a human handle (optional future polish via a
  public `GET /user/{id}` lookup).
- No change to dev/local identity behaviour.
- No multi-tab support behind Access (see risks).

## Risks & accepted constraints

- **Multi-tab collision (accepted):** with `userId = github:<id>`, the same person in
  two tabs behind Access shares one identity. LiveKit rejects duplicate participant
  identities (the second connection displaces the first) and tldraw presence merges.
  Accepted under a one-tab-per-person assumption. *Future mitigation if needed:* give
  the LiveKit participant a per-tab suffix (`github:<id>#<nonce>`) while keeping the
  base id for presence/colour/matching — deferred.
- **Identity re-key:** existing users have a random-UUID identity in `localStorage`.
  Behind Access they switch to a `github:<id>`-keyed identity (new presence identity,
  name, and default colour unless overridden). One-time, expected transition.
- **`get-identity` availability:** if the endpoint is unreachable or returns a
  non-GitHub identity (e.g. a service-token session), the client cleanly falls back to
  the dev/local model — the feature simply doesn't engage rather than breaking.

## Error handling

| Condition | Behaviour |
|---|---|
| `get-identity` 404 / unreachable (dev, local, Codespace) | Fall back to current local model (prompt) |
| `get-identity` 200 but not a GitHub identity / no integer `id` | Fall back to current local model |
| `get-identity` slow/hangs | Bounded timeout, then fall back; never block canvas load |
| `name` field absent | Use `github:<id>` as the display name |
| User had a colour override | Override still wins over `colorKeyForId(id)` |

## Testing

- **`extractGithubIdentity`** (pure, unit, table-driven): valid GitHub payload →
  `{ id: "github:227505", name: "David Laing" }`; missing/zero/non-integer `id` → null;
  `idp.type !== "github"` → null; missing `name` → id used as name.
- **`getIdentity` resolution** (client, mock `fetch('/cdn-cgi/access/get-identity')`):
  (a) 200 GitHub payload → `id/name` from GitHub, `window.prompt` **not** called;
  (b) 200 non-GitHub / bad id → fallback; (c) non-200 → fallback to prompt/local;
  (d) colour override respected; (e) timeout → fallback.
- **`colorKeyForId("github:<id>")`** stability: same id → same colour across calls.
- No server tests required (no server change).

## Future work

- **Milestone B — terminal owner colouring.** Colour a Codespace-launched terminal tile
  by the GitHub identity that launched it: the launcher passes its GitHub **numeric id**
  (`gh api user --jq .id`) through the connector's gateway registration
  (`owner=<id>`), the server stores it on the gateway entry and surfaces it in
  `/api/gateway/list`, and the terminal shape renders the same owner-colour border the
  screenshare tiles use — live colour if a present participant's id === `github:<owner>`
  (this milestone's keying makes that a direct match), else `colorKeyForId("github:<owner>")`.
  **Deferred to be built inside the unified CLI** so the connector-side plumbing isn't
  built on `connect.sh` / `termgw` and then re-homed. (If the launcher's human handle is
  wanted on the tile, resolve `id → login` via a public `GET /user/{id}` lookup.)
- **Unified `ensembleworks` Go CLI.** One cross-platform binary with subcommands that
  (a) connect the current terminal to a canvas (absorbing `termgw` + the sample repo's
  `connect.sh`) and (b) interact with the canvas (absorbing `bin/canvas`'s
  `status`/`sticky`/`frames`/`read`/… HTTP verbs). Its own brainstorm → spec. The
  connect verb's name (`connect-terminal` vs `connect-tmux` vs `terminal connect`) is an
  open question for that spec. Milestone B's owner-emitting is built here as part of the
  connect verb.
- **Org/team room scoping.** `get-identity` carries the user's GitHub `orgs`/`teams`
  (e.g. `ew-staging-001-users`); a future authorization layer could scope rooms to them.
