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
