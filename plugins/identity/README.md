# Identity

Identity answers "who is who" on a shared BB server. It is the renamed Presence
plugin, and now covers named presence, attribution, thread ownership, a start
guardrail and an audit log (see
`docs/superpowers/specs/2026-09-15-bb-machine-ownership-design.md`).

**Trust statement.** Identity reads the upstream Access email header but does not
cryptographically verify it. It helps people
avoid mistakes and see who is doing what; it is not an access control. The
`Cf-Access-Authenticated-User-Email` header is read as-is (no JWT verification),
so anything that reaches BB without going through Access (loopback, the tailnet,
an agent's `curl`) can claim any email.

## Named presence

Once the plugin patch is installed, ordinary HTTP requests run inside a small request context that
records the upstream email header and the raw named selection cookie (`request-context.ts`). Presence RPCs resolve
them against the current people directory at call time, so a tab's heartbeat and
typing pulses carry a person when one is known, and stay anonymous otherwise.

- The thread header popover lists the named people on the thread with their
  GitHub avatar (initials if it fails to load), their display name and
  "typing" while they type, then "+N others" for anonymous viewers.
- The header icon's title and the sidebar row label use names when available:
  "Matt and Trevoke here", "Matt, Trevoke and 1 other here", "Matt is typing".
  With nobody named they keep the anonymous wording ("2 other viewers").
- Counts are of distinct people: one person in two browsers counts once. Your
  own browser is excluded.
- The popover footer states the source of the name, including whether it was chosen
  in this browser or came from an unverified upstream header.
- `identity_whoami` (RPC) and `GET /api/v1/plugins/identity/http/whoami` return
  `{ email, person, provenance, selection, picker }` for the caller.

A request that arrives while plugins are still loading carries no context and is
treated as anonymous.

### Boot self-test

The request context is a versioned monkey patch of `http.Server.prototype.emit`, installed
once per process and never removed, so a BB upgrade could break it silently. At
load Identity therefore self-tests it: it checks the live `emit` is still its own
patch, then drives separate requests through BB's own server carrying a tagged email
and a tagged named cookie. Each is checked in the *async context*. The verdict is
logged (`bb plugin logs identity`) and served by
`GET /api/v1/plugins/identity/http/request-context-self-test`.

A failed cookie leg disables only browser selection and reports `cookie-bridge-unavailable` in
`whoami`; upstream-header resolution and dispatch continue. Nothing is blocked, and the patch is never
restored: BB disposes the old plugin generation *after* the new one loads, so
restoring `emit` would remove the live patch.

## Browser fallback identity picker

`selfSelectedIdentity` defaults to `false`. Set `selectionPublicOrigin` to the exact
browser origin (for example `https://bb.example.test`, or a local HTTP origin with its
port) and enable `selfSelectedIdentity` to offer the picker in the compact thread
popover and on the **This browser** tab of the People & machines settings section. The picker is an ordinary labelled select with Switch and
Forget controls. An app-wide modal opens on any BB screen the first time an unidentified
tab sees a ready picker. Dismissing it suppresses further automatic opens for that tab's
page session; the ownership bubble still opens the picker on demand from a thread. It
fits 320px and 390px viewports. All tabs on one origin share the
cookie and refresh from server `whoami` state; the UI never treats its click as proof
that the browser retained the cookie. A private window, cleared site data, or an
ephemeral WebView needs a fresh choice.

Identity creates a random 256-bit `selectionSigningKey` through the SDK's secret
setting. The SDK stores secret settings in a 0600 file under the plugin data directory,
outside `bb.db`, and does not send them to the app. The key is read back before issuance.
To rotate, use **Rotate signing key** on the settings section's This browser tab (or set a
new 32-byte base64url key in the secret setting); all old selections immediately become
invalid. The token is bounded, versioned, HMAC-SHA256 signed,
origin-bound and expires after 30 days. Verification uses a timing-safe comparison.
The cookie name contains a short hash of the configured origin, so two BB servers
on the same host at different ports do not overwrite each other's choice. The
cookie is host-only, `HttpOnly`, `SameSite=Lax`, `Path=/`, with `Secure` for a
configured HTTPS origin. No forwarded protocol or host header selects its security
attributes. Selection and forget first use an authenticated plugin RPC to mint a random,
one-time capability that expires after 60 seconds. A same-origin GET consumes it and sets
the cookie. This avoids native WebViews whose rewritten `Origin` BB's HTTP CSRF gate
rejects before a plugin route can run. The capability is memory-only, bounded to 256
pending entries, and never persisted. Legacy direct mutations still require JSON content
and a matching or absent `Origin`, in addition to BB's `auth: local` route protection.
Only relative same-origin browser requests are used. A different app/API origin is
unsupported. A missing or malformed public origin keeps the picker unavailable.

Resolution order is strict: a present upstream email header, even one absent from
the directory, wins; then a valid selected person still in the directory; then the
configured `fallbackEmail`; then unknown. While the picker is ready (browser names on,
with a valid origin, signing key and cookie bridge), an invalid, stale,
expired or tampered choice resolves as anonymous: it never falls through to
`fallbackEmail` and never silently selects a different person. (With the picker off or
not ready, the cookie is ignored altogether, as if the browser had presented none.) Directory
display-name and colour changes take effect on the next resolution. The header is
unverified by this plugin; the signed cookie only proves that this server issued a
choice, not that the chooser is that person.

The picker is **attribution only**. `self-selected` and `configured-fallback` names
are never policy requesters. Their starter records are display history, never protected
owners in the guardrail. A future `requireIdentity` rule must treat self-selection as
unidentified. The `selfSelectedIdentity` setting can be switched off at runtime:
existing cookies become inert immediately, and upstream resolution and dispatch still
work. Old Identity code ignores the new cookie and queue namespace. Access-attributed
starter rows retain their old strict shape; older code reads weak new rows as unknown.

### HTTP and queue coverage

| Action | Attribution coverage | Policy hook |
| --- | --- | --- |
| Browser `POST /threads`, `/threads/fork`, `/:id/send` | Request context when the patch and route match; otherwise unknown. A fork needs a live source session. | Yes for the dispatch attempt. |
| Ordinary future/busy/host-wait queue via `/threads` or `/:id/send` | `message.queued` snapshots the requester by row ID; a later drain reads that row. Capture misses and storage races are unknown. | Initial attempt and ordinary drain. |
| Explicit `POST /threads/:id/queued-messages` | The request audit sees the insertion attempt, but no suitable queue event binds the row; the drain requester is unknown. | No insertion hook; normal drain hook later. |
| Automatic/scheduled drain | Per-row ledger, never ambient async context; mixed or missing row identity is unknown. A changed content digest is attributed as unknown. | Yes, subject to core behavior. |
| `POST .../queued-messages/:id/send` (Send-now) | Post-hoc `message.dispatched` names the stored enqueuer and the separate presser when observed. | **No**: core bypasses the dispatch hook. |
| Queue edits, reorder, group, cancel | HTTP request audit only; unobserved edits have no reliable editor binding. Cancel/dispatch cleanup is best effort. | No edit hook. |
| Approvals, Stop, Archive, terminal and host HTTP routes | Request audit only. It records an observed attempt, not successful completion. | No Identity policy hook. |
| Presence and Identity RPC reads | Current `whoami`/presence state; polling is rolled up in audit. | No. |
| Core WebSockets, CLI/agent/plugin traffic, plugin-load races | No browser selection guarantee; report unknown unless other upstream facts are present. | Existing core behavior only. |

Request-context facts are bounded and captured before async work. Ordinary queue
coverage depends on `message.queued` running in the originating request context;
this was observed on an isolated BB 0.43.3 instance, not established as an SDK
guarantee or production observation. Core queue insertion and Identity's KV write are
not one transaction. A crash, reload, failed write, fast drain, disabled plugin or
capacity eviction can leave `capture-missing`. The queue ledger keeps at most 1000
indexed rows, first capture wins (including unknown), and dispatched rows are
tombstoned then removed. Long schedules retain snapshots while their rows remain in
the bounded ledger; exceeding capacity degrades older rows to unknown. Message text,
cookie values, signatures and keys are never written to audit lines. Audit schema v2
adds `provenance` and `captureSource`; selection and forget produce bounded action
events. Audit emission always swallows its own failures.

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
follow-up from someone else cannot take a thread over. Attribution and audit swallow
their own errors; only the separately configured machine guardrail can reject a dispatch.

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
| `off` (default) | Record who started what, label it in the UI, refuse nothing, and write no request, dispatch or post-dispatch audit lines. The change lines below (settings, pins, colours, browser-name choices) are still written. |
| `audit` | Take the **same** decision `enforce` would, write it to the log as a would-refuse, and let the message through. |
| `enforce` | Act on that decision. |

The rules `audit` reports and `enforce` acts on (`guardrail.ts`): **A** a known person's
start on another *person's* machine (team and unclaimed machines are always fine); **B** a
known person's message into a thread a different known person started; **C** an automation
(`origin: plugin`, `originPluginId: automations`) headed for a machine that is not a team
machine. A dispatch Identity cannot tie to a person is **always allowed, in every mode** —
that is the normal shape of every agent path (see the design note's S9) — and an identity
that came from a browser name or from `fallbackEmail` counts as untied: only an Access
identity can ever be refused.

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
  presence RPCs AND its own read RPCs, `presence`-named plugin RPCs, the event stream),
  counted rather than itemised: one line per minute with `{method, path, access, person,
  count}` buckets. This is the volume policy: presence heartbeats fire every 10s per open
  tab and a per-request line would drown the log. Paths are normalised
  (`/threads/:id/send`) and the bucket list is capped, with the overflow counted in
  `dropped`.

  Note the reason the read RPCs are named explicitly: the BB client sends **every** plugin
  RPC over POST, so a "POST means a mutation" rule files a read poll as a human action.
  Identity's own `identity_whoami` poll (every 5s per open tab) produced 52 of 53 audit
  lines in a review re-measurement before this was fixed. Another plugin's RPCs still get
  a line each — their method names are not ours to interpret — so **re-measure the volume
  on any busy server** (Canvas especially) before leaving `audit` on for long.
- **`dispatch`** — every `message.dispatch`: the full attribution facts (origin,
  originPluginId, lineage, ALS email, resolved starter, `via`, the host and its
  classification), the guardrail `verdict` plus the `rule` and `refusal` text it would have
  produced, and the `action` actually returned. In `audit` those last two differ, and that
  difference is the product.
- **`message.queued` / `message.dispatched`** — the post-dispatch stream. The first
  is observed in the originating request context for ordinary submissions; later
  drains use the row ledger. Send-now is post-hoc only. These events report identity;
  they cannot act on it.

Four more kinds record changes rather than traffic, and are written in **every** mode,
`off` included: `settings.change` and `host.pin` (the People & machines section's writes,
below), `person.color` (a colour set or cleared) and `identity.selection` (a browser
choosing or forgetting a name). A setting changed directly — through BB's generated
Configuration form or `bb plugin config identity set` — writes no line at all.

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

## The settings section: People & machines

BB's settings page carries one Identity section, **People & machines** (section id
`people`). It explains who and what Identity recognises, why, and what it does about it,
and it is where the settings below are meant to be changed. From the top:

- **The identity bar** — who this browser is (`You: Alex Rivera · from your Access email,
  read as-is · counts for Attribution and the guardrail`), and the standing reminder that
  Identity is a guardrail against mistakes, not a lock.
- **The readiness strip** — six items (profile, people, machines, browser names,
  guardrail, check), each an icon plus text; activating one opens the tab that fixes it.
- **The server profile question** — on a fresh server (nobody in the directory and every
  writable setting at its default), and on demand from the readiness strip: *How do
  people reach this BB server?* (Cloudflare Access / Direct, without Access / Only me). It shows each
  setting it would change, from → to, before **Apply** writes them.
- **Five tabs** (the WAI-ARIA tabs pattern: ←/→ move, Home/End jump):
  - **People** — the directory, read-only, with each person's colour, machines, whether a
    thread of theirs is on record, and *How Identity recognises* them (their Access
    emails, a browser name, a machine name suffix, a pin). **Copy directory entry** copies
    the JSON to paste into the infra repo: the directory is rendered by Ansible
    (`ew_bb_people`), and nothing in the UI or any RPC writes it. Colours are the one
    thing editable here, by anyone, for anyone, as before.
  - **Machines** — every host BB knows, classified `person` / `team` / `unclaimed` and
    why, problems first. A pin conflict offers **Keep pin**, **Re-pin** or **Unpin**;
    any machine can be made a team machine or removed from the team; a team machine can
    be added by name; the shared machine user is edited here. Each action on a listed
    machine confirms first: re-pin and remove-from-team spell out the rule A / rule C
    consequence, and unpin that the owner is re-derived from the name.
  - **This browser** — *Why am I shown as …?* (the precedence ladder, with the deciding
    rung marked), the browser-name picker, the browser-names switch and public origin
    (with the picker's readiness chain), the fallback email, and the signing key's
    status (`valid`, `invalid` or `missing` — never the key) with **Rotate signing key**.
  - **Rules** — the enforcement mode, the audit `jq` command with a copy button, a
    simulator that runs the real `decideGuardrail` in your browser (who × what × which
    machine → the outcome in off, audit and enforce), and a map of which BB paths the
    guardrail can see.
  - **Health** — the self-test (re-runnable), the picker's readiness chain, how full the
    thread-starter and queued-requester records are, configuration checks with the fix
    for each, and **Copy diagnostics**.

### What each write does

Settings writes from this section go through `settings.experimental_set`, pins through
the host-pin store and colours through the colour store. Each of the section's write RPCs
and colour/pin actions that changes something writes exactly one audit line through
`bb.log` naming who asked (person, email, provenance) and what changed, from → to. These
lines are written whatever `enforcement` is.

That promise covers only the section. BB's generated Configuration form (still listed
beside the section) and `bb plugin config identity set` write the settings directly; Identity
applies such a change at once but cannot tell who made it, so it writes **no**
`settings.change` line for it and none of the confirmations below apply.

| Action | RPC | Audit line | Safeguard |
|---|---|---|---|
| Apply a server profile | `identity_update_settings` | `settings.change` | Shows every change first |
| Change `enforcement` | `identity_update_settings` | `settings.change` | Turning on **Enforce** opens a dialog naming who Identity can tell would be refused and needs an acknowledgement ticked; cancelling leaves the mode unchanged |
| Browser names on/off, public origin | `identity_update_settings` | `settings.change` | Switching browser names either way is confirmed; so is changing a set origin, which forgets every browser's choice |
| Set `fallbackEmail` | `identity_update_settings` | `settings.change` | A non-empty value needs *Only one person uses this server* ticked; the server refuses it otherwise |
| Team machines, shared machine user | `identity_update_settings` | `settings.change` | Making a listed machine a team machine, or removing one, is confirmed (rule C); adding one by name is not |
| Rotate the signing key | `identity_rotate_signing_key` | `settings.change` (`[secret]` → `[rotated]`) | Type `rotate`; every browser's chosen name expires at once |
| Keep / re-pin / unpin a machine | `identity_resolve_pin` | `host.pin` | Confirmed; re-pin spells out the rule A consequence, unpin that the owner is re-derived from the name |
| A person's colour | `identity_set_person_color` / `identity_clear_person_color` | `person.color` | None — cosmetic, as before |
| Re-run the self-test | `identity_rerun_self_test` | — | Read-only |
| Copy diagnostics | `identity_diagnostics` | — | Read-only; every stored setting that fails its own validation (public origin, fallback email, shared machine user, each team machine) is shown as `invalid`, then every email left in the bundle is shortened and every configured display name masked; the key is left out |

Every confirm dialog opens with **Cancel** focused, names its consequence, and returns
focus to whatever opened it. The section reads through `identity_settings_overview`,
which returns the signing key's status only, and the directory as a count and an error.

### The trust model is unchanged

The section can change things, but it verifies no one: any caller may write, exactly as
BB's generated settings form and the colour picker already allow. That is the trade the
rest of Identity makes — a guardrail against mistakes, not a lock — and the audit line is
what makes a section write accountable. A change made through the generated form or the
CLI carries no such line (see *What each write does*), so while that form stays visible
the log is not a complete record of who changed a setting. Precedence stays fixed (Access header → valid browser
name → `fallbackEmail` → anonymous; a stale, expired or invalid name is anonymous and
never falls through to the fallback), and only an Access identity can ever be refused.

### Audit evidence stays out of the UI

By decision there is no log viewer and no count of would-refuse decisions in the
section. The Rules tab shows, and copies, this command instead:

```
bb plugin logs identity | sed -n 's/.*identity-audit //p' | jq -c 'select(.kind == "dispatch" and .verdict == "reject") | {at, mode, rule, person, host: .host.name, action}'
```

### What still needs BB core

The section labels these "Needs BB core" where it mentions them; none is attempted here:
grouping or hiding BB's generated settings form (it still lists every setting beside the
section), setting provenance or locks, a host owner field, a plugin log query (and so any
in-UI would-refuse evidence), a Send-now dispatch hook, stamping `threads.send` so rule C
can see automation follow-ups, a deep link to the section, and showing the composer's
selected host.

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
neither an Access header nor a valid browser name, for a BB server that is not behind
Cloudflare Access (e.g. a laptop). Such callers, agents and the CLI included, are then
attributed to this email. With browser names on, a browser presenting a stale, expired
or invalid name stays anonymous — it never falls through to the fallback. The guardrail
never refuses on a fallback identity. Leave it empty on a shared server.

### `teamMachines`

Host names of the shared team machines, one per line or comma separated (a JSON array
works too). A host that matches neither a person nor this list renders as "unclaimed".

### `sharedMachineUser`

Default `ensembleworks-agent`: the account team and unclaimed machines run as, shown in
the header chip. Display only — Identity never sets or checks it.

### Setting them

Prefer the People & machines section above: it confirms the risky changes and writes an
audit line for each. The CLI still works, and is the only way to set `directory`, but a
CLI (or generated Configuration form) change skips those confirmations and writes no
audit line:

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
