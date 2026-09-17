# Identity

Identity answers "who is who" on a shared BB server. It is the renamed Presence
plugin, and is growing toward named presence and thread ownership (see
`docs/superpowers/specs/2026-09-15-bb-machine-ownership-design.md`).

**Trust statement.** Identity trusts Cloudflare Access headers. It helps people
avoid mistakes and see who is doing what; it is not an access control. The
`Cf-Access-Authenticated-User-Email` header is read as-is (no JWT verification),
so anything that reaches BB without going through Access (loopback, the tailnet,
an agent's `curl`) can claim any email.

## Named presence

Every HTTP request to the BB server runs inside a small request context that
records the Access email header (`request-context.ts`). Presence RPCs resolve
that email against the people directory at call time, so a tab's heartbeat and
typing pulses carry a person when one is known, and stay anonymous otherwise.

- The thread header popover lists the named people on the thread with their
  GitHub avatar (initials if it fails to load), their display name and
  "typing" while they type, then "+N others" for anonymous viewers.
- The header icon's title and the sidebar row label use names when available:
  "Matt and Trevoke here", "Matt, Trevoke and 1 other here", "Matt is typing".
  With nobody named they keep the anonymous wording ("2 other viewers").
- Counts are of distinct people: one person in two browsers counts once. Your
  own browser is excluded.
- The popover footer says who BB thinks you are: "You are David", "Signed in as
  … , not in the Identity directory", or an anonymous explanation.
- `identity_whoami` (RPC) and `GET /api/v1/plugins/identity/http/whoami` return
  `{ email, person }` for the caller; the HTTP route is handy with `curl`.

A request that arrives while plugins are still loading carries no context and is
treated as anonymous.

### Boot self-test

The request context is a monkey patch of `http.Server.prototype.emit`, installed
once per process and never removed, so a BB upgrade could break it silently. At
load Identity therefore self-tests it: it checks the live `emit` is still its own
patch, then drives one request through BB's own server carrying a tagged email and
asserts the handler read that email back out of the *async context*. The verdict is
logged (`bb plugin logs identity`) and served by
`GET /api/v1/plugins/identity/http/request-context-self-test`.

A failure degrades Identity to "no identity" — presence stays anonymous and
attribution records `unknown`. Nothing is ever blocked, and the patch is never
restored: BB disposes the old plugin generation *after* the new one loads, so
restoring `emit` would remove the live patch.

## Attribution

Identity records **who started each thread**. On the first `message.dispatch` for a
thread it writes `threadId -> { starter, via }` to its own KV storage:

- `via: browser` — the dispatch's request carried an Access email that matched a
  person in the directory (`origin: app`, or none);
- `via: agent` — the same, from `origin: cli`/`sdk`; or a dispatch with no identity
  of its own that inherited a **lineage** thread's starter
  (`startedOnBehalfOf.senderThreadId`, a queued message's `senderThreadId`, the hook's
  or the thread's `parentThreadId`, or a fork's `sourceThreadId`, in that order);
- `via: plugin` — a plugin-origin dispatch (an automation, a scheduled send) with no
  identity and no lineage;
- `via: unknown` — nothing identified it: a header-less shell, a drain, an email that
  matches nobody, or a request that beat the patch during plugin load.

**First write wins**: a thread's starter is never rewritten by a later dispatch, so a
follow-up from someone else cannot take a thread over. The hook only observes — it
always proceeds, never rejects, and swallows its own errors, because BB hooks are
fail-closed and Identity must never be able to block a message.

Read it back with `identity_thread_starter` (RPC) or
`GET /api/v1/plugins/identity/http/thread-starter?threadId=<id>`, both of which return
`{ threadId, starter, via, inheritedFrom, recordedAt }` or `null`.

**Storage policy.** One small record per thread (~200 bytes) plus an insertion-ordered
index, capped at 2000 threads; past the cap the oldest records are deleted and read
back as `null`. Attribution is a guardrail aid, not an audit log.

## Settings

### `directory`

A JSON array of people. `person` must match `^[a-z_][a-z0-9_-]*$`; `github` and
`displayName` are non-empty; `emails` is a non-empty list, matched
case-insensitively. A person or an email may appear only once. An invalid
directory marks the plugin *needs configuration* and presence stays anonymous.

```json
[
  { "person": "mrdavidlaing", "displayName": "David", "github": "mrdavidlaing", "emails": ["<github-email>"] },
  { "person": "mattwynne", "displayName": "Matt", "github": "mattwynne", "emails": ["<github-email>"] },
  { "person": "trevoke", "displayName": "Trevoke", "github": "Trevoke", "emails": ["<github-email>"] },
  { "person": "jeremylightsmith", "displayName": "Jeremy", "github": "jeremylightsmith", "emails": ["<github-email>"] }
]
```

### `fallbackEmail`

Optional, default empty. Used as the requester's email when a request carries
no Access header, for a BB server that is not behind Cloudflare Access (e.g. a
laptop). On such a server every header-less caller is attributed to this email,
including agents and the CLI. Leave it empty on a shared server.

### Setting them

```
bb plugin config identity set directory '<json>'
bb plugin config identity set fallbackEmail 'you@example.com'
bb plugin reload identity
```

## Presence

Visible tabs send a location heartbeat every ten seconds. A lease expires after
25 seconds or is cleared when the tab is hidden, so activity is never retained
as history.

Threads viewed by another browser display a badge in the BB sidebar and a
compact people icon in the thread header. Hovering the header icon gives the
summary; clicking it opens the details. The icon and sidebar badge turn amber
while someone is typing.

Replacement sidebars that preserve BB's `data-sidebar-thread-id` row attribute
receive the same badge through a cleanup-safe content-script fallback.

Typing pulses contain no draft text or character counts. They are throttled to
at most once per second and expire after three seconds.

Canvas cursors remain Canvas-scoped awareness; this plugin does not read or
write Canvas documents or membership.

## Upgrading from Presence

The plugin id changed from `presence` to `identity`. On each BB server:

```
bb plugin remove presence
bb plugin install ./plugins/identity
```

Presence kept no durable state, so nothing is lost.
