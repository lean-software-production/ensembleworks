# Binding the client identity to Cloudflare Access (issue #55, Problem 1)

**Status:** approved design, not yet implemented
**Issue:** [#55](https://github.com/lean-software-production/ensembleworks/issues/55) — Problem 1 only. Problem 2 (a second tab silently killing A/V) was fixed by PR #58's `SingleTabGate` and is not revisited here.

## Problem

`client/src/identity.ts` mints `crypto.randomUUID()` into localStorage. That id is
what `server/src/app.ts` logs (`[sync] open room=… user=<uuid> session=…`) and what
LiveKit sees as the participant identity. It has no relationship to the Cloudflare
Access identity that actually authenticated the request.

So when a facilitator reports "user X couldn't do Y", nothing maps the person to
their `user=` id. The name exists only in the voice transcript; the two never meet.
A real incident triage stalled on exactly this — we could see *a* user had two
concurrent canvas tabs during the complaint window, but could not confirm it was the
reporting user.

The server is not blind to the Access identity: `app.ts:482` already resolves it on
the sync upgrade. But that capture is fire-and-forget (so it doesn't delay the WS
handshake), lives in an in-memory per-room map, and exists to serve co-author
attribution through `/api/participants`. Nothing puts it where a triage looks.

## Approach

**The UUID stays the device/join key. `person` becomes a side-band binding the
server resolves from Access headers it already has, and writes to the logs.**

The issue's own first suggestion — derive the app identity *from* the Access email —
was considered and rejected for two reasons.

**It breaks multi-device A/V.** An email-derived id is identical on a laptop and a
phone, so LiveKit's single-identity slot raises `DUPLICATE_IDENTITY` *across
devices*, and `SingleTabGate`'s `navigator.locks` is per-browser and cannot guard
that. Today's random-per-browser id is precisely what keeps two devices separate.
The team uses this: joining from two browsers to test multiplayer is routine, and
mobile is occasionally a second device. Neither justifies a takeover UX — the device
component is collision avoidance, not a product concept.

**The blast radius is large and buys no triage.** `contracts/src/user-id.ts`'s
`rawUserId()` exists so the tldraw presence id, the LiveKit participant identity, the
pulse/latency wire and the server session maps all join on one id. Reformatting that
id to `person#device` means touching every join site to learn nothing the side-band
binding doesn't already tell us.

Two further options were weighed and dropped:

- **Enrich `[sync] open` itself** by awaiting the identity before `handleUpgrade`.
  One line instead of two, but it couples the WS handshake to Access resolution —
  sub-millisecond with warm JWKS, a network round-trip when cold — so it needs a
  boot-time pre-warm and a timeout fallback. Machinery for cosmetics.
- **Persist bindings** to SQLite with an admin view. The logs already answer the
  question, and this adds a store of user emails to own.

## Design

### 1. The identity binding line

One new log line per authenticated connection, emitted when the Access identity
resolves, joinable to every other line by `session=` / `user=`:

```
[sync] identity room=team user=<uuid> session=<sid> person=alice@example.com verified=true
```

Because the line is emitted *when the identity is known*, it never has to beat
`[sync] open` — the race that makes "just add the email to the open line" more than a
one-line change simply does not arise.

Sites:

- **`server/src/app.ts:482`** — inside the existing fire-and-forget
  `getAccessIdentity(req.headers).then(...)`, which already resolves and stores what
  we need. When the identity is `null` (dev or anonymous), log `person=none` rather
  than staying silent: silence is indistinguishable from a resolver bug.
- **`server/src/features/av.ts`, the `avToken` handler** — has both `req.headers` and
  the client-supplied `identity`. Log
  `[av] token room=… identity=<uuid> person=… verified=…`. This is what ties a
  LiveKit participant to a person, since LiveKit's own logs only ever see the UUID.
- **Terminal gateway** — already covered. `gateway-registry.ts:250` logs
  `as ${owner}`, and `resolveGatewayOwner()` returns `sso:<email>`. No change.

A shared helper in `access-identity.ts` formats the `person=`/`verified=` pair, so
every plane renders it identically — a grep for `person=alice@` must match all of
them, or the feature has a hole.

Triage after this lands: grep the email to get UUIDs and session ids, then grep a
UUID for everything that user did. The logs are also the only artifact that survives
a restart; the in-memory map is not.

**Known gap, stated not fixed.** `/sync/v2` (`app.ts:434`) carries no `userId` in its
URL at all, so there is nothing to bind. Dogfood-only path, out of scope.

### 2. Seeding the display name from `/api/whoami`

So the canvas and the logs agree on who someone is. `resolveCaller()` already returns
`identity: name ?? email` for an SSO human; that string is the seed.

The obstacle is startup order. `getIdentity()` runs at module-eval time in two places
— `main.tsx:37` and `App.tsx:50` — and `main.tsx` statically imports `App`, so
`App.tsx:50` prompts before any `await` in `main.tsx` could seed.

Fix: move `App.tsx:50`'s module-level `const identity = getIdentity()` behind a
memoized `identityOnce()` evaluated at render, then have `main.tsx` `await seedName()`
before `createRoot`. Import order stops mattering because nothing touches identity
until render. (The alternative — making `App`'s import dynamic — adds a chunk request
on the default render path and reads as unrelated churn beside `main.tsx`'s
zero-exposure comment.)

`seedName()`:

- No-op if `ensembleworks.userName` is already set. A user's chosen name wins, and no
  existing user is renamed under them.
- Otherwise `GET /api/whoami`; on `kind: 'human'` with a non-null `identity`, write
  that to `NAME_KEY`.
- Bounded (~1.5s `AbortController`) and never throws. On timeout, network failure, or
  `kind: 'anonymous'` (local dev bypasses Access), fall through to today's
  `window.prompt` — the prompt stays as the fallback, it just stops being the first
  thing an SSO user sees.

Cost: first paint waits on that fetch when the name is unset, i.e. first visit per
browser, never on reload.

This does **not** make the name authoritative. It seeds the same localStorage field
and stays editable. The triage mechanism is the log binding; this is the cosmetic
half.

## Testing

- **Server, unit:** the shared formatter renders verified, header-trust, and
  `null` (→ `person=none`) identities. Cover it once, at the helper.
- **Server, integration:** drive a sync upgrade with a `Cf-Access-Authenticated-User-Email`
  header and assert an `[sync] identity … person=…` line naming the same `session=`
  as the `[sync] open` line — the join is the feature, so the test asserts the join,
  not the string. Same for `avToken` with headers present and absent.
- **Client, unit:** `seedName()` against a stubbed `fetch` — name already set (no
  request issued), human whoami (name written), anonymous whoami (untouched),
  rejection and timeout (untouched, no throw). Plus `identityOnce()` calling through
  exactly once.
- **Manual:** load a room in dev with `EW_DEV_IDENTITY_EMAIL` set, confirm the
  binding line appears and the name prompt does not.

## Non-goals

- Changing the identity format on the wire (`rawUserId`, LiveKit participant
  identity, tldraw presence). Explicitly rejected above.
- Persisting bindings to a database, or any admin UI over them.
- Cross-device duplicate detection. Now *possible* server-side once `person` is
  known, but a separate piece of work.
- Making the Access identity authoritative over the user's chosen display name.
- `/sync/v2` binding (no `userId` on that route).
- Problem 2 of issue #55 — already fixed by PR #58.

## PR notes

`ux-contract: none` — nothing here touches `canvas-editor/src/tools/`,
`canvas-react/src/`, or `client/src/canvas-v2/` input/tool files. The changes are
server logging, `client/src/identity.ts`, `main.tsx` and one module-scope-to-render
move in `App.tsx`.

Issue #55 can close when this lands: Problem 2 was fixed by PR #58, and this is
Problem 1.
