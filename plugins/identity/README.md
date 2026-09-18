# Identity

Identity answers "who is who" on a shared BB server. It is the renamed Presence
plugin, and now covers named presence, attribution, thread ownership, a start
guardrail and an audit log (see
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
`{ threadId, starter, via, inheritedFrom, recordedAt, host }` or `null` — `host` being the
machine bb resolved for that dispatch (`null` on records written before it was recorded).

**Storage policy.** One small record per thread (~200 bytes) plus an insertion-ordered
index, capped at 2000 threads; past the cap the oldest records are deleted and read
back as `null`. Attribution is a guardrail aid, not an audit log.

## Ownership UI

Identity **shows** who owns what. It labels; it restricts nothing, and nothing here can
reject, delay or alter a dispatch.

- **Machines are labelled `person`, `team` or `unclaimed`.** A machine named
  `<box>-<person>` whose last segment matches a directory `person` or `github` belongs to
  that person; a machine listed in `teamMachines` is the team's; anything else is
  **unclaimed** — never silently folded into "team". A host is **pinned** to its person by
  host id on first sight, and a later rename that disagrees with the pin is *not* followed:
  the pin stands and the disagreement is reported (`GET …/http/host-pins`, and in the
  header chip).
- **Thread rows** show who started the thread ("Started by David · team machine"), except
  while someone is viewing or typing — **presence wins** that glyph.
- **The thread header** reads "Started by David · runs as ensembleworks-agent on
  `<machine>` (team machine)". The machine appears only when it is not the starter's own.
  An unrecorded starter reads "Starter not recorded", muted — never alarming, never blank.
- **The new-thread composer** carries "Starting as David", plus the machines that are
  yours. It deliberately makes **no** claim about the machine you picked: a `new-thread`
  composer customization cannot see the selected machine (SDK 0.4.84 `ComposerView`). What
  it says about what happens *after* you press send follows the `enforcement` setting, and
  `ownership-labels.test.ts` fails if that copy ever promises an enforcement that is not
  switched on — in either tense, so audit's "would be refused" may never read as "was".
- **In `audit` mode the header chip also says what enforcement would have done**
  ("Started by Matt · would be refused — Matt's thread (audit mode, so it went through)"),
  so the team can evaluate the guardrail by using BB rather than by reading logs.

Read paths: `identity_thread_ownership` (RPC, batched) / `GET …/http/thread-ownership`,
`identity_machines` (RPC), `GET …/http/host-pins`. The machine list comes from bb's own
`GET /api/v1/hosts` over the loopback base url — the SDK gives a server plugin no way to
enumerate hosts.

## The guardrail, and audit mode

One three-way setting, `enforcement`:

| Mode | What happens |
|---|---|
| `off` (default) | Record who started what, label it in the UI, refuse nothing, log nothing. |
| `audit` | Take the **same** decision `enforce` would, write it to the log as a would-refuse, and let the message through. |
| `enforce` | Act on that decision. |

The rules `audit` reports and `enforce` acts on (`guardrail.ts`): **A** a known person's
start on another *person's* machine (team and unclaimed machines are always fine); **B** a
known person's message into a thread a different known person started; **C** an automation
(`origin: plugin`, `originPluginId: automations`) headed for a machine that is not a team
machine. A dispatch Identity cannot tie to a person is **always allowed, in every mode** —
that is the normal shape of every agent path (see the design note's S9) — and an identity
that came from `fallbackEmail` counts as untied.

`audit` and `enforce` run the *same* `decideGuardrail` call; only the returned action
differs. A test drives the same facts through both modes and asserts the verdicts are
equal, so audit cannot drift into estimating what enforcement "would have" done.

### The audit log

Audit lines go through `bb.log` and nowhere else — no ring buffer, no HTTP route, no UI
page. One JSON object per line, prefixed `identity-audit`:

`bb plugin logs identity` emits one JSON envelope per line
(`{"ts","level","message"}`), so the audit object is the tail of `.message`:

```
bb plugin logs identity | jq -r 'select(.message|startswith("identity-audit")) | .message[15:]' | jq
```

Three streams, correlated by a request id (`req`) that the request-context patch stamps on
every HTTP request, and each carrying `v` (schema version) and `kind`:

- **`request`** — one line per mutation BB handles, including the routes the dispatch hook
  never sees (terminals, Stop, Archive, answering approvals, host routes, plugin RPCs):
  `{method, path, access, person, req}`. `access` is whether the Access header was present;
  `person` is who it resolved to, `null` when nobody.
- **`request.rollup`** — every read, plus the known high-frequency chatter (Identity's own
  presence RPCs, `presence`-named plugin RPCs, the event stream), counted rather than
  itemised: one line per minute with `{method, path, access, person, count}` buckets. This
  is the volume policy: presence heartbeats fire every 10s per open tab and a per-request
  line would drown the log. Paths are normalised (`/threads/:id/send`) and the bucket list
  is capped, with the overflow counted in `dropped`.
- **`dispatch`** — every `message.dispatch`: the full attribution facts (origin,
  originPluginId, lineage, ALS email, resolved starter, `via`, the host and its
  classification), the guardrail `verdict` plus the `rule` and `refusal` text it would have
  produced, and the `action` actually returned. In `audit` those last two differ, and that
  difference is the product.
- **`message.queued` / `message.dispatched`** — the post-dispatch stream. These run in the
  requester's async context, so they see Send-now and queued drains, the paths that skip
  the hook entirely. They report identity; they cannot act on it.

**Emails appear in these lines by design** — "which actions carried identity, and whose" is
the question being answered. Message bodies and thread content never do; identity facts
only. In `off` and `audit` no dispatch is ever refused or delayed: logging sits inside the
hook's existing 5s fail-open deadline and swallows its own failures.

Worked examples:

```
audit () { bb plugin logs identity | jq -r 'select(.message|startswith("identity-audit")) | .message[15:]'; }

# which paths carried identity, and which did not?
audit | jq -r 'select(.kind=="request") | "\(.method) \(.path) access=\(.access) person=\(.person)"' \
  | sort | uniq -c | sort -rn
# …and the same question for the rolled-up traffic
audit | jq -r 'select(.kind=="request.rollup") | .buckets[] | "\(.count)\t\(.method) \(.path) access=\(.access) person=\(.person)"' \
  | sort -rn | head

# what would enforcement have refused?
audit | jq -c 'select(.kind=="dispatch" and .verdict=="reject") | {req,threadId,rule,action,person,host:.host.name}'

# the paths that skip the hook, and what identity they carried
audit | jq -c 'select(.kind|startswith("message.")) | {kind,threadId,access,person}'
```

## Settings

### `enforcement`

`off` | `audit` | `enforce`, default `off`. See "The guardrail, and audit mode" above.
Anything unrecognised reads as `off`: an unreadable setting must never start refusing
people's work.

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

### `teamMachines`

Host names of the shared team machines, one per line or comma separated (a JSON array
works too). A host that matches neither a person nor this list renders as "unclaimed".

### `sharedMachineUser`

Default `ensembleworks-agent`: the account team and unclaimed machines run as, shown in
the header chip. Display only — Identity never sets or checks it.

### Setting them

```
bb plugin config identity set directory '<json>'
bb plugin config identity set fallbackEmail 'you@example.com'
bb plugin config identity set teamMachines 'ew-lsp-001-main'
bb plugin config identity set enforcement audit
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
