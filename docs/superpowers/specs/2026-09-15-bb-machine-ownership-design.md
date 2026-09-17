# bb machine ownership: restrict where people start threads, show who owns them

Status: steps 1-2 built, merged (PR #101) and deployed to ew-lsp-001; step 3 (attribution) built on
`feature/identity-attribution`; steps 4-5 designed only. Date: 2026-09-15, updated 2026-09-17.
Scope: the shared bb server `bb-ew-lsp-001` (bb-app 0.43.0). Per-person machines are
named `<box>-<person>`; a team machine is planned.

## Decisions (2026-09-15, after review) — read this first

1. **High trust; UX first, security later.** The team is four trusted people. The goal
   now is to prove the ownership UX works, not to stop a determined teammate. Everything
   below about JWT verification, bypass detection, the gate proxy and source patches is
   **deferred**, kept as the record of what "secure" would cost. The restriction is a
   *guardrail*: a clear refusal when someone picks the wrong machine by mistake.
2. **Merge into Presence and rename it Identity.** One plugin, `identity`
   (`plugins/identity`, package `bb-plugin-identity`, display name "Identity"), holds
   presence (viewing and typing), who people are, machine ownership, attribution, the
   start restriction and the ownership UI. This replaces §4's "separate `people` plugin
   that Presence depends on". It also settles the fight over the single row glyph: one
   plugin renders both presence and ownership.

### What the high-trust version looks like

| Concern | Secure design (deferred) | High-trust design (now) |
|---|---|---|
| Who is this browser? | Verify `Cf-Access-Jwt-Assertion` against JWKS | Read `Cf-Access-Authenticated-User-Email` on an Identity HTTP route (`GET /whoami`) and trust it. Fall back to "unknown" when it's absent. |
| Who started this message? | Submit-intent hash, or a source patch | **The `AsyncLocalStorage` monkey patch** (addendum, option M): the hook reads the email header of the request that triggered the dispatch. It is exact, needs no extra round trip, and costs ~50 lines. If the self-test fails, it **degrades open**: starter shown as unknown, no restriction. So a bb upgrade that breaks the patch costs UX only, never blocks work. |
| Agent and CLI spawns | Lineage from caller-supplied fields is forgeable | Take lineage at face value: a spawn inherits its parent's starter. A spawn with no lineage shows "unknown" and is allowed. |
| Restriction | `reject` plus detection of every bypass | `message.dispatch` `reject` for an inline start on another person's machine, with a friendly message. Send-now, terminals and raw API calls stay open, and that's accepted. |
| Mapping | Host id pins, rename detection | Parse `<box>-<person>` from the host name, plus a settings list of team machines and `person → emails`. |
| Presence | Anonymous | Named: heartbeats go to an HTTP route so the server knows the email, and the popover lists faces instead of counts. |

The README must say plainly: *Identity trusts Cloudflare Access headers and bb's own
thread metadata; it helps people avoid mistakes and see who's doing what, and it is not
an access control.*

### Revised plan for the Identity plugin

1. **Rename (mechanical, no behaviour change).** `git mv plugins/presence
   plugins/identity`; update `package.json` name and `bb.name`, `.bb/plugins.json`, and
   the realtime channel if it's renamed. The plugin id changes, so each server needs
   `bb plugin remove presence` + `bb plugin install ./plugins/identity`. Presence keeps no
   durable state, so nothing is lost.
2. **People.** A `directory` setting (JSON: `person`, `emails[]`, `displayName`), a
   `teamMachines` setting, and `GET /whoami`. Named presence: change the heartbeat/typing
   calls from RPC to HTTP routes, or add a `whoami` step that ties `viewerId` to a person.
3. **Attribution.** The ALS patch with a boot self-test; a hook that records
   `threadId → {starter, via: browser|agent|plugin|unknown}` in `bb.storage` on the first
   dispatch; lineage inheritance for spawns and forks.
4. **Ownership UI (option B).** Row glyph (presence wins while someone is typing), the
   header chip, the "Starting as David" banner in the new-thread composer, and an
   "unknown" state that looks neutral. A host that matches neither a person nor
   `teamMachines` renders as **"unclaimed"**, distinct from "team" (answer 6).
5. **Guardrail.** Reject an inline start whose starter is a known person on another known
   person's machine; the team machine is always allowed for people. Also reject a follow-up
   from anyone but the starter, and an automation that isn't on the team machine (see the answers below). Ship behind a
   `restrictStarts` setting (default off) so the UX can be tried before it bites.

### Answers to the open questions (2026-09-16)

1. **Other people's threads are read-only.** Only the starter sends to a thread. The
   `message.dispatch` guardrail therefore covers `join-turn` and follow-ups too: reject
   when the request's email (ALS) is a known person who isn't the thread's starter. In the UI,
   a composer banner on other people's threads says "Read-only: Matt's thread", and the header
   chip carries the same state. Accepted gaps at high trust: Stop, Archive and
   answering a pending approval are unhooked core routes, so they're not blocked. A drain
   (a queued or scheduled message) has no request, so it's checked against the sender recorded
   when it was queued if bb exposes one, otherwise allowed.
2. **Automations run on the team machine only.** Guardrail: `origin: "plugin"` with
   `originPluginId` = the built-in automations plugin → the host must be a team
   machine, otherwise reject. The starter is shown as the automation (bb records no creator).
   Spike: confirm the automations plugin id, and whether workflows and scheduled send should
   follow the same rule (scheduled send is a person's own message, so probably not).
3. **The team machine runs as the shared, restricted `ensembleworks-agent` user**, the
   same Linux user as the infra repo's `ew_bb_machine_user`. It shows as "team", and the header
   reads "Started by David · runs as ensembleworks-agent on <team machine>". Rule 1 still
   applies: a team-machine thread is read-only to everyone except its starter.
   **Confirmed 2026-09-17: `ew-lsp-001-main` is the shared team machine**, running as
   `ensembleworks-agent`.
4. **Identity email = the email on the person's GitHub account** (Access uses the GitHub IdP).
   The directory becomes `person → {github, email, displayName}`. Extend
   `ew_bb_people` with `github:` (Trevoke's capitalisation) and `email:`, and render
   it into the Identity `directory` setting.

### Answers (2026-09-17)

5. **Team machine = `ew-lsp-001-main`**, running as `ensembleworks-agent`. Put it in the
   `teamMachines` setting.
6. **Hosts that don't match a person or the team list run as `ensembleworks-agent`, and
   Identity shows them as "unclaimed" — not as the team machine** (decided 2026-09-17).

   *The Linux user.* `ensembleworks-agent` is already the answer in infra:
   `roles/ew_bb/defaults/main.yml` sets `ew_bb_machine_user: ensembleworks-agent`, and
   `ew_bb_machines[].user` is optional, so an ansible-declared machine that names no owner
   already runs as it. Person machines are different by construction
   (`roles/ew_bb/tasks/people.yml`: the person's own locked, unprivileged account, 0700
   home, no sudo/docker/ssh). Options weighed and not taken:
   - a separate shared bb user (`bb-shared`) — keeps bb threads out of the canvas-terminal
     home and off the GitHub-token grant, but needs a new bootstrap account and duplicate
     credential seeding for a class with no instances today;
   - a per-host `bb-<machine>` user — best isolation, and the ansible loop already supports
     per-entry `user:`, but N accounts and N credential seedings for hosts that are mostly
     ephemeral;
   - refusing to run threads on any machine that declares neither owner nor team — forces
     the question at provisioning, but makes an ad-hoc laptop daemon unusable until declared.

   Either of the first two stays a one-line `user:` change per machine entry, with no
   Identity code change, if the trade-off below ever bites.

   *Caveat, accepted.* On prod boxes `ensembleworks-agent` is also the canvas-terminal
   sandbox user (README, "Terminal sandbox user"): its home holds `AGENTS.md` and
   `.config/ensembleworks/term.env` (API keys), and it can mint `ensembleworks[bot]` tokens
   through the `ensembleworks-gh-token` sudo wrapper. So a thread on an unclaimed host there
   inherits all of that, and shares one home with the team machine's threads and every
   canvas terminal. Acceptable under the guardrail-not-access-control model; revisit if
   unclaimed hosts ever become long-lived.

   *What Identity does.* Do **not** fold an unmapped host into "shared/allowed" silently.
   Show it as **unclaimed**, a state distinct from "team"; allow starts (the guardrail exists
   to stop someone starting on another *person's* machine, which this isn't); and record the
   `hostId` on first sighting next to the `hostId → person` pin. That is what catches the
   real mistake mode — a typo'd or freshly renamed person machine (`ew-lap-002-mat`) would
   otherwise quietly become a de-facto shared box. Machines joined from someone's laptop land
   here too: they run as whoever launched them and Identity cannot know that, so "unclaimed"
   is the truthful label.
7. **Block thread interactions that carry no identity, where possible.** See "No-identity
   policy" below for what that can and can't cover.
8. **A person's own shell is refused, and gets an opt-in that makes it identified**
   (decided 2026-09-17). `bb thread send`/`tell` from a personal terminal reaches the server
   over loopback (or the tunnel with `BB_SERVER_URL`) with no Access header and no thread id.
   The plugin runs in the bb *server*, so it cannot see the calling Linux uid — the socket is
   TCP, not a unix socket, and a `/proc/net/tcp` inode→uid lookup is too fragile to build on.
   Note that people are denied SSH on the bb box (`roles/ew_bb/tasks/people.yml`), so a
   "personal shell" is either an admin shell on lsp or a laptop pointed at prod.

   **Refuse under `requireIdentity`, and ship the opt-in in the same change:** a person who
   wants to drive their own threads from their own terminal exports `BB_SERVER_HEADERS` (the
   setting found in S7) with `Cf-Access-Authenticated-User-Email: <their email>`, and the
   send then arrives as them and passes the ordinary starter check.
   - Keeps enforcement as one rule in `message.dispatch`, with no personal-shell special case.
   - Costs nothing to build: no verification, and the same trust level the browser path
     already has, since Identity never verifies the Access JWT (deferred, see Decisions).
   - Honest about the trust: a self-asserted header is a label, not a credential. Fine under
     guardrail-not-access-control, and stated rather than hidden.
   - Rejected alternative: allow and attribute "unknown". That is the one hole wide enough to
     carry everything else, and it is exactly the shape a mistaken send onto someone else's
     thread arrives in, so the guardrail would stop meaning anything.
   - Refusal text must name the fix: "no identity — open bb through the Access URL, send from
     a thread (`--parent-self`), or export `BB_SERVER_HEADERS`."
   - **S9 must cover** `bb thread tell` and `spawn` *without* thread context, and an agent's
     own `bb thread stop --self`. The risk is a rule aimed at human shells catching agents'
     CLI calls, which carry no header either.

### No-identity policy (design, 2026-09-17; not built)

Goal: an interaction that can't be tied to a person is refused, instead of running as
"unknown". What "identity" means for each kind of caller:

| Caller | How Identity knows who it is | Verdict when unknown |
|---|---|---|
| Browser through Access | email header (ALS), resolved against the directory | refuse (email missing or not in the directory) |
| Agent inside a thread (`bb thread spawn --parent-self`, `bb thread tell` from a thread, workflows, subagent threads) | **lineage**: `parentThreadId`, `sourceThreadId`, `startedOnBehalfOf.senderThreadId` or the send's `senderThreadId` → that thread's recorded starter | refuse if the linked thread has no recorded starter |
| Person's own shell or `curl` with no Access header and no lineage | nothing, unless the shell exports `BB_SERVER_HEADERS` with the person's email (answer 8) | **refuse** (this is the case you asked to block) |
| Queued/scheduled message draining later (no request) | sender recorded on `message.queued` (runs in the request context, S7) | refuse if nothing was recorded |
| Automations plugin | origin `plugin` + automations plugin id | allowed only on the team machine (answer 2); starter = "automation" |
| Other bb-internal plugin dispatches (provider-retry's `threads.retry`, scheduled send, side-chat…) | `originPluginId`, or a retry of a thread whose starter is recorded | allow when the thread already has a recorded starter; spike each plugin before enforcing |

What it **can** enforce: everything that becomes an agent turn, because it all passes
`message.dispatch` (creates, follow-ups, steers, forks, spawns, drains, retries), except
Send-now.

What it **can't** enforce from the hook (accepted gaps, same as before):
- **Send-now** skips the hook. Mitigation: `message.dispatched` runs in the requester's
  context, so a Send-now with no identity (or by a non-starter) can be caught afterwards:
  stop the turn and post a notice.
- **Unhooked routes**: terminals, Stop, Archive, answering approvals, host routes. The
  request-context patch *could* refuse these with a 403 when the request has no identity,
  but agents' own CLI calls (`bb thread stop --self`, reading timelines) also arrive with no
  header and no thread id in the request, so a blanket block would break agents. Leave these
  open unless the CLI can be made to send a per-machine header (`BB_SERVER_HEADERS`, noted
  in S7).

Rollout details:
- Setting `requireIdentity` (default **off**), turned on for ew-lsp-001 only. A laptop bb
  with no Access has no identity at all; there, leave it off or set `fallbackEmail`.
- Refusal text names the reason and the fix, e.g. "This message has no identity: open bb
  through https://bb-ew-lsp-001.ensembleworks.dev, or send from a thread
  (`bb thread spawn --parent-self`)."
- Startup race: requests during plugin load have no identity. With `requireIdentity` on,
  they'd be refused; that's acceptable (rare, retryable) but the message should say "try
  again".
- **Spike before enforcing (S9):** on a throwaway bb, list the `origin`, `originPluginId`,
  lineage fields and ALS store for each built-in path (automations, workflows,
  provider-retry, scheduled-send, side-chat, fork from the UI, `bb thread spawn` with and
  without `--parent-self`, `bb thread tell` from a thread). Check that nothing
  legitimate arrives identity-less before turning the policy on.

### S7 result (2026-09-16): the monkey patch works in real bb 0.43.0

Setup: a throwaway `bb-app` (Node 24.19, its own `--data-dir`, `HOME` set to a temp dir,
ports 39886/39887) with a spike plugin that patches `http.Server.prototype.emit`, and
a `message.dispatch` handler that echoes `als.getStore()` back in its `reject` message.
Threads were created with `POST /api/v1/threads` and a `cf-access-authenticated-user-email`
header. Nothing touched the shared server.

- **The hook sees the right person** for creates from the app, with or without a header
  (a CLI-style request with no header gives a store whose email is null), for three
  concurrent creates as different people, after `bb plugin reload`, and when a new
  provider is used for the first time.
- **A rejected create leaves no thread** (`/threads/count` stays 0). A refusal is clean.
- **Lesson 1, patch lifecycle.** bb loads a plugin more than once (at startup and on
  reload), and it disposes the old generation *after* the new one has loaded. A
  "restore `emit` in `onDispose`" pattern therefore silently removes the live patch.
  The fix: patch once per process behind a `Symbol.for` global, never unpatch, and read the
  store through that singleton.
- **Lesson 2, startup race.** A request that arrives while plugins are still loading is
  handled before the patch exists. Its hook still runs later, with no store. That's
  benign: it degrades to "unknown", which is the high-trust design's fallback anyway.
- **Hook stack:** `invokeHook` → `invokeWrapped` → bb's own `runEventLoopWork`
  (`AsyncLocalStorage.run`), then `decideWithinBox`. bb's ALS nests inside ours without
  clobbering it.
- **Follow-ups, drains, Send-now (2026-09-16, second run).** With no provider, a turn hangs
  in `active`. `POST /threads/:id/stop` puts the thread back to `idle`, which is enough to
  exercise the dispatch paths. Results:
  - A follow-up `POST /threads/:id/send` **passes the hook with the sender's identity**
    (matt's follow-up was rejected, david's proceeded). The read-only rule works inline.
  - `sendAt` in the future **queues with no hook call**. **Send-now**
    (`POST …/queued-messages/:id/send`) then **dispatches with no hook call either**.
    The bypass is confirmed.
  - When a scheduled message comes due, the drain passes the hook with
    `queuedMessage` set and **store `null`**. That was expected: no request.
  - **The `message.queued` and `message.dispatched` events run inside the request's
    context.** `message.queued` saw the sender (jeremy, matt), and Send-now's
    `message.dispatched` saw the person who pressed it. So Identity *can* attribute
    drains (record `queuedMessageId → email` on `message.queued`, and look it up when the
    hook sees `queuedMessage`). It can also notice a Send-now by a non-starter afterwards,
    and stop the turn plus post a notice if the guardrail is on.
- A useful find along the way: the daemon and CLI read `BB_SERVER_HEADERS`, so an agent's
  CLI calls could carry a per-machine header later.

### S2 result (2026-09-17): the header reaches plugin routes; local auth accepts Access traffic

- **Source.** Plugin HTTP and RPC routes with `auth: "local"` go through
  `browserRequestProblem` → `isTrustedOrigin` (bb-app 0.43.0 `start-server.js`). A
  request with no `Origin` passes. Otherwise the `Origin` must be one of `BB_APP_URL`'s
  origins, or equal the request's own `Host` / `X-Forwarded-Host` (scheme from
  `X-Forwarded-Proto`). Mutations also need `content-type: application/json`.
- **Throwaway bb, Identity installed**, email header `matt@mattwynne.net`, public origin
  `https://bb-ew-lsp-001.ensembleworks.dev`:
  1. `GET /whoami` with `Host` = the public name and `Origin` = the public origin gives Matt.
  2. `POST rpc/identity_whoami` with `Host: 127.0.0.1` and `X-Forwarded-Host` = the public
     name gives Matt.
  3. The same, but with no forwarded host and no `BB_APP_URL`, gives `403 forbidden_origin`.
- **What that means for ew-lsp-001:** Presence's RPCs already work there through Access,
  so one of cases 1 and 2 (or `BB_APP_URL`) already holds for that tunnel. The one link not
  tested locally is Cloudflare injecting `Cf-Access-Authenticated-User-Email` on origin
  requests, which is documented Access behaviour. **Final check once Identity is deployed:**
  open `https://bb-ew-lsp-001.ensembleworks.dev/api/v1/plugins/identity/http/whoami` in a
  browser; it should name you.
- **Confirmed on ew-lsp-001 (2026-09-17), S2 closed.** After the merge of PR #101 and the
  deploy, that URL returns
  `{"email":"david@davidlaing.com","person":{"person":"mrdavidlaing","displayName":"David Laing","github":"mrdavidlaing"}}`.
  So Cloudflare does inject `Cf-Access-Authenticated-User-Email` on origin requests, the
  `auth: "local"` origin check accepts Access traffic through the real tunnel, and the
  directory matches a secondary email (`david@davidlaing.com`, not the primary
  `mrdavidlaing@gmail.com`) to the right person.

### S3-lite result (2026-09-17): the new-thread composer can't see the chosen machine

From the SDK types (0.4.84 `bb-plugin-sdk.d.ts`, `PluginComposerScope`
L15958–15975, `ComposerView` L16010–16022): a composer customization in the `new-thread` scope
gets `projectId`, the draft text, the attachment count and submit state. It does
**not** get the selected machine, environment, provider or model. `NewThreadComposerProps`
only *seeds* those choices for a plugin-rendered composer and doesn't report them back. So:
- the "Starting as David" banner can show who you are and list your allowed machines, but it
  **can't warn before submit** that the selected machine isn't yours;
- the dispatch refusal message is the first point where the wrong machine is caught. Its
  wording has to do the teaching ("ew-lsp-001-mattwynne is Matt's machine. Pick one of
  yours…").
- Changing that would need a new SDK surface (an upstream ask), or Identity rendering its own
  new-thread composer via `NewThreadComposer`, which is heavy.

Not verified at runtime; this is a reading of the types.

Spikes S7 (including follow-ups), S2 and S3-lite are done (results above); S2's through-Access
check was confirmed on ew-lsp-001 on 2026-09-17, so steps 1 and 2 are fully verified in prod.
Open questions 1, 2, 3 and 7 are answered just below.

## TL;DR

- **One real server-side checkpoint exists.** The `message.dispatch` hook
  (`bb.experimental_hooks.on`) runs before any agent turn reaches a provider, and it
  can `reject`. It covers UI creates, follow-ups, forks, CLI/SDK spawns, plugin
  spawns (automations, workflows, scheduled send) and retries. It is told which
  **host** the turn will run on, even before provisioning. Thread *creation* has no
  hook, and there is no API to move a thread or environment to another machine.
- **It never sees who asked.** The hook context holds only server facts. Core routes
  pass no request headers to plugins, the server has no concept of a user, and
  `origin` / `parentThreadId` / `startedOnBehalfOf` are values the caller supplies.
  Plugins can read request headers only on **their own** HTTP and WebSocket routes.
- **Some paths skip the hook.** Send-now on a queued message skips the pass by
  design (and a future `sendAt` is enough to queue a message). Terminals
  (`POST /terminals` with a `host_path` target), host file and directory routes, and
  host rename don't go through it either.
- **No plugin can be a security boundary here.** The bb API has no auth, and it can be
  reached from the machines themselves: loopback on ew-lsp-001, where people's
  daemons run, and the tailnet proxy. Any teammate's agent can `curl` it directly. A
  plugin can be a solid **guardrail against honest mistakes** plus **attribution**.
  A real boundary needs a gate in front of the API and changes upstream in bb.
- **Presence hunch: half right.** Presence is the right *UI surface*, but it's the wrong
  *foundation*. It is anonymous and ephemeral by design, and it uses RPC, which can't
  see headers. Recommend a new **`people`** plugin that owns identity, the people
  directory, host ownership and the attribution ledger, with the dispatch policy
  living in it too. Presence then uses it to show names.

## 1. Enforcement point

### What the SDK offers a server plugin (SDK 0.4.84, which presence and canvas pin)

| Surface | Can veto? | Notes |
|---|---|---|
| `experimental_hooks.on("message.dispatch")` | **yes**: `proceed` / `wait` / `reject` | The only admission hook. Fail-closed: a throw or a timeout over 10s fails the attempt. Runs under a server-wide lock. |
| `events.on("thread.created" \| "thread.active" \| "message.dispatched" \| "experimental_terminal.input" …)` | no | After the fact. Can be used to detect a violation and then stop or archive the thread. |
| `experimental_environments.register({ validate })` / `experimental_machines` | refuses only *its own* provider's creates | Doesn't apply to the built-in project-checkout, worktree and personal environments that people's machines use. |
| RPC / HTTP / CLI / agent tools | n/a | Only the plugin's own endpoints. |
| App slots / content scripts | UI only | There is no host-picker filter hook. Hiding machines would mean hacking the DOM, and that isn't enforcement. |

The hook context (`MessageDispatchHookContext`) contains `thread`, `project`,
`environment`, `host` (taken from the environment, or from the start intent before
provisioning), `environmentIntent`, `input`, `requestedExecution` (so `providerId`
is there, which could enforce "pi only" on the team machine), `attempt`
(`start-turn`/`join-turn`), `queuedMessage`, `origin`, `originPluginId`,
`startedOnBehalfOf` and `parentThreadId`. It has **no request, headers or principal**.
Confirmed in the server bundle: `buildHookContext` in `src/services/threads/dispatch-hooks.ts`
builds the context from the DB and nothing else. The built-in `concurrency-limit`
plugin is prior art for a per-host policy on this hook.

### Coverage matrix (read from source; spike S1 must confirm by running it)

| Path | Passes hook? |
|---|---|
| New thread from UI, with first message | yes (host comes from the start intent) |
| Follow-up, steer or retry in an existing thread | yes |
| Fork (`POST /threads/fork`, which may name a different host) | yes, at its first send. A seed-only fork runs nothing until a message is sent. |
| `bb thread spawn` from an agent or a person's shell (origin `cli`) | yes |
| Plugin spawns: automations, workflows, scheduled send (origin `plugin`) | yes |
| Provider-internal subagents (e.g. Claude's Task tool) | n/a: same process, same machine, no new bb thread |
| "Move thread/environment to another machine" | **no such API** in 0.43.0. `PATCH /threads/:id` only takes title/model/parent/section/visibility (`updateThreadRequestSchema`). A handoff is a fork. |
| Message queued with a future `sendAt`, or because the host is offline, then drained when due | yes: the drain runs the pass |
| **Same queued message, then Send-now** (`POST /threads/:id/queued-messages/:qid/send`) | **NO**. `if (!sendNow && hasMessageDispatchHooks())`. The time and host-offline waits are recorded *before* the pass, so `sendAt: now+1m` followed by Send-now skips policy entirely. |
| **Terminals** `POST /terminals` with target `host_path` / `environment` / `thread` | **NO**: gives a raw shell as that Linux user |
| **Host file and directory routes** (`/threads/:id/host-files/content`, `/hosts/:id/directory`, `/hosts/:id/pick-folder`), `/environments/:id/actions` | **NO** |
| **Host admin**: `PATCH /hosts/:id {name}`, enroll, suspend, remove | **NO**. Renaming breaks any rule based on the name. |
| Thread row creation itself | **NO**, by design. A rejected first message may leave a `pending` row (S1). |

Sources: SDK `bundled-types/bb-plugin-sdk.d.ts` L18947–19131 (hook decision, context,
`PluginHooks`), L18694–18793 (events), L10099 (`createTerminalRequestSchema`),
L11249/L11446 (create and fork requests: `origin`, `originPluginId`,
`startedOnBehalfOf` and `parentThreadId` are request fields). Server
`bb-app/server/dist/start-server.js`: `runMessageDispatchHookPass` (~L207228),
the send path with the `sendNow` and `sendAt` checks (~L220133–220233), route table (grep `"/terminals"`).

### Can the bypasses be closed from a plugin?

Only after the fact. On `message.dispatched`, `thread.active` or
`experimental_terminal.input`, re-check owner against host and then call
`bb.sdk.threads.stop` / archive, and alert. Terminal input can't be stopped
through the SDK. What a plugin can't do at all: stop a direct API caller. The infra repo's
`roles/ew_bb/defaults/main.yml` says it plainly: *"Whoever the tailnet policy lets
reach these ports drives agents — bb has no auth."* On ew-lsp-001 the server is also
on `127.0.0.1:38886`, on the same box as every person's daemon.

## 2. Identity

- **RPC handlers** are `(input) => output` with no context (`PluginRpcHandlers`,
  SDK L14368). This is structurally why Presence is anonymous.
- **HTTP routes** get a Hono `Context` (`PluginHttpHandler`, L19149), and
  **WebSocket routes** get `{ request, headers }` (L19155). So a plugin *can* read
  `Cf-Access-Jwt-Assertion` and `Cf-Access-Authenticated-User-Email`, **but only on
  requests to its own routes**. It cannot read them on `POST /threads`.
- The server has no user model: no `cf-access` string in the bundle, and no creator
  field on `ThreadResponse`.
- **Verify the JWT; never trust the email header.** Access overwrites the header only
  on traffic that goes through Cloudflare. bb is reachable without going through Cloudflare, from loopback and
  the tailnet, which is exactly where agents run, so a forged header is trivial there. EW
  already has a verifier to reuse: `server/src/access-identity.ts` (JWKS from
  `https://<team>/cdn-cgi/access/certs`, RS256, checks `aud`/`exp`, refetches when a
  key rotates). It needs the bb Access app's AUD (plugin setting) plus team domain
  `mrdavidlaing.cloudflareaccess.com`, and egress to Cloudflare. The EW server's
  "header mode is safe because there are no inbound ports" argument **does not hold for bb**.
- **Binding identity to an action** has to be done indirectly. Recommended: **submit intent**. A
  composer customization in the `new-thread` and `thread` scopes
  (`ComposerView.draft`, `richText.onDraftChange`) posts
  `{scope, projectId|threadId, sha256(text)}` to the plugin's HTTP route just before
  submit. The route verifies the JWT and records a short-lived intent. The hook matches
  `(project or thread, hash(input.text), ±N s)`, which tells it **who sent this message**,
  both for creates and for follow-ups. No draft text is stored. To forge it, someone has to
  send identical text to the same place inside the time window. Presence landing is a
  post-hoc cross-check: the creator's tab shows up on the new thread within seconds.
- **Requests with no identity** (CLI on a box, agents, automations): the only thing to
  go on is lineage. That means `parentThreadId` / `sourceThreadId` /
  `startedOnBehalfOf.senderThreadId`, all of which the caller supplies. `bb thread spawn` sends
  `startedOnBehalfOf: null` and a parent only when `--parent-self` is given. Rule: a
  lineage-linked spawn may target **the same host as its parent**. That is no escalation,
  because an agent there already runs as that user. A spawn with no lineage onto a
  person's machine is rejected with a message telling the caller to use `--parent-self`.
  Tell agents this through `bb.agents` context.

## 3. Mapping person → allowed machines

- `Host` carries only `id`, `name`, `type`, `machineProviderId` and lifecycle. There are no
  labels or metadata (`hostSchema`, SDK L471). `getResource` exists only for
  plugin-provisioned machines.
- The naming convention `<box>-<person>` is the only signal today, but **names can be
  changed by anyone** (`PATCH /hosts/:id`, `updateHostRequestSchema` L8642). So
  **derive ownership from the name, then pin it by host id**. On first sight, record
  `hostId → person`. If a later name disagrees with the pin, don't follow it: flag it.
- **Source of truth: the infra repo.** Extend `ew_bb_people` with `emails: [...]`
  (and `github:`, because of Trevoke/trevoke) and a `team_machines` list. Ansible renders it
  into the plugin config with `bb plugin config people set directory '<json>'`, run on the
  server box in the same play that creates the machines. The plugin validates it against
  the live `hosts` list and reports `needsConfiguration` if anything is missing.
  Caveat: plugin config can also be changed over the unauthenticated API.

## 4. Presence fit

> Superseded by Decision 2: merge into Presence and rename it Identity. The analysis
> below still explains why Presence as it stands can't do this without changes.

What Presence knows about a person: **nothing**. It has a random `viewerId` in
localStorage and a `tabId` in sessionStorage, uses RPC only (no headers), keeps
process-local leases that expire after 25s, and its README promises "never retained as
history" and "does not claim names". Ownership is the opposite: durable, attributable,
and it carries policy.

So: **a separate `people` plugin** (identity via `/whoami`, people directory, host
ownership pins, attribution ledger, `message.dispatch` policy, ownership UI). Presence
then *depends on* it: it swaps `viewerId` for the verified person by calling the
`people` HTTP route, then shows names and faces. One practical coupling: both want the
single row glyph `experimental_setThreadRowStatus`, which "temporarily replaces
a thread's draft glyph". Either one plugin renders both, or they agree on a
precedence. That argues for eventually folding presence rendering into `people`.

## 5. Thread ownership UX

Facts to show: **starter** (a person, or an agent or automation acting for one),
**runs as** (the owner of the machine), and **lineage** (fork or spawn parent). The
policy should keep starter and runs-as equal, except on the team machine. Surfaces that
exist today: row status glyph (icon + label only, no avatar),
`experimental_threadHeaderAction`, `homepageSection`, composer `banners` (new-thread
scope), `experimental_threadList` (full sidebar replacement).
`PluginSidebarThread.host {id,name}` is already on every row.

### Option A: machine = owner (minimal, no ledger)

```
 Sidebar                                   Header
 ● Fix login flow            [MW]          Fix login flow        (MW) mattwynne's machine · ew-lsp-001
 ● Upgrade tldraw            [DL]
 ● Nightly digest            [team]
```
Shows only who the machine belongs to, taken from the host name and pin. It is always true, needs no
identity, and works before any of §2 exists. It can't say who *started* a thread, and it
can't tell an agent or automation from a person. On the team machine it shows only "team".

### Option B: starter, plus machine only when different (recommended)

```
 Sidebar                                   Header
 ● Fix login flow            (MW)          Fix login flow   (MW) Matt · runs on ew-lsp-001
 ● ↳ write tests             (MW)🤖                          ↳ spawned by an agent in "Fix login flow"
 ● Nightly digest       (DL)⏰ team                           ⏰ automation "Nightly digest" set up by David · team machine (pi)
 ● Try new prompt       (?) ew-lsp-001-mattwynne             ? starter unknown (CLI, no --parent-self)

 New-thread composer banner
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Starting as David · allowed: ew-lsp-001-mrdavidlaing, ew-donkeyred-001-…, team │
 └──────────────────────────────────────────────────────────────────────────────┘
 Rejection:  "ew-lsp-001-mattwynne is Matt's machine. Pick one of yours or the team machine."
```
The avatar is the starter. Agent and automation starters show a glyph plus the human at the
root of the chain. The machine appears only when it differs from the starter's (team machine, or
unknown). It carries the most information, but needs the ledger and the intent binding.
"Unknown" states will show up and must look honest, not alarming.

### Option C: sidebar grouped by person

```
 ▾ Mine (4)          ▾ Matt (2)  ● ●      ▾ Team machine (1)      ▸ Unknown (1)
```
Replace the sidebar with `experimental_threadList`, one section per machine owner, with presence
faces inline. It reads well for a 4-person team, but it takes over bb's sidebar (a burden
to keep up with bb, and it clashes with the canvas-first navigation), and it hides
threads you're collaborating on in someone else's section.

**Recommend B**, falling back to A where the ledger has no entry (for example
threads that already exist). Forks: the starter is the forker, and lineage shows "forked from
<thread> (owner)". Threads started by an agent or automation inherit the starter at the root of the chain for
policy purposes, but always show the agent/automation glyph.

## Recommended approach (secure path — deferred, see Decisions)

1. **Now, as a guardrail:** a `people` plugin with (a) a directory from `ew_bb_people`, (b)
   host pins, (c) `/whoami` with verified JWT, (d) a submit-intent ledger, (e)
   `message.dispatch` policy:
   - team machine: allow (optionally require provider = pi);
   - person P's machine: allow if the verified sender = P, or if it's a lineage spawn from a thread on the same host;
   - otherwise reject with the message above;
   - unknown hosts: a setting, allow by default at first.
   Add (f) detection of the bypasses: Send-now dispatches and terminal input on another
   person's machine trigger stop and alert. Add (g) option B UI.
   Also be explicit in the README: **this is a guardrail, not a security boundary.**
2. **If the team wants a boundary:** put a gate between cloudflared and bb that verifies the
   Access JWT and enforces the same policy on create, fork, send, queued-send,
   terminals and hosts routes. Then close the unauthenticated paths: tailnet proxy
   and loopback reachable only with a credential; people's daemons not sharing the
   server's loopback (nftables `meta skuid`, or move the server off the person box).
3. **Ask bb upstream** for: a trusted identity header forwarded into the hook context
   (a principal), hooks that are non-bypassable or that also run on Send-now, terminal and
   host-file admission hooks, and owner labels on hosts.

## Addendum: patching bb core instead of waiting for upstream

Facts: bb is **MIT-licensed and public** (`github.com/get-bb/bb`, very active: pushed
2026-09-15). Server plugins run **in the server process with no sandbox**: the loader
`jiti.import`s `server.ts` straight into `start-server.js` (~L328871). The server bundle
is unminified ESM with `// src/...` file markers, but its internals are module-scoped,
so a plugin can't reach them. Node built-ins, however, *are* shared.

### Option M: monkey patch from inside a plugin (no fork)

1. **Identity into the hook.** Wrap `http.Server.prototype.emit` so that each
   `"request"` runs inside `AsyncLocalStorage.run({verified Access identity, peer}, …)`.
   bb's server (`@hono/node-server` → `http.createServer`) dispatches through that emit,
   so the store propagates: route handler → `withEvaluationLock` promise chain → our
   `message.dispatch` handler, which reads `als.getStore()`. Inline sends get the caller's
   identity. Drains and core-driven sends get *no* store, which is also correct: nobody
   asked. A Node model of exactly that shape (server created *before* the patch,
   concurrent requests with different headers, a lock chain, a drain) printed
   `a@x / null / b@x` and `NO CONTEXT` for the drain (Node 22.12). That is a model, not bb: S7.
2. **An in-process gate for the unhooked routes.** The same wrapper can answer 403 before
   calling the original emit. Routes it can decide on from the path alone, after a
   `bb.sdk` lookup of the thread or environment's host: `POST
   …/queued-messages/:id/send` (Send-now), `PATCH /hosts/:id`, `/hosts/:id/directory`,
   `/threads/:id/host-files/content`, `POST /environments/:id/actions`. Routes whose
   decision is in the **body** (`POST /terminals` target, `POST /threads` host) would
   need the body buffered and replayed to Hono without breaking its stream handling.
   That's fragile; prefer the dispatch hook for thread creates, and buffer/replay only for terminals (S8).
3. **Bonus for callers on the same box:** for loopback TCP, the peer's uid can be found
   in `/proc/net/tcp` (the `ss -tep` uid column), which tells you the person's Linux user
   for agents on ew-lsp-001. It is lost for tailnet callers, whose connections come through
   the systemd socket proxy, and for all of donkeyred.

Costs: it depends on bb *internals*, not the SDK (http emit, ALS continuity, route
paths, and plugins staying in-process: bb already runs *host* plugins in a worker). Patches
must be idempotent across `bb plugin reload` (guard with a global symbol, restore in
`onDispose`), and they break silently on upgrade, so a boot self-test is essential: have the plugin send itself a
tagged request and assert the hook saw the store, else call `needsConfiguration`.
Pin `ew_bb_app_version` and re-run S1/S7 on every bump. It still doesn't authenticate
identity-less callers; it only *knows* they're identity-less, and can refuse
mutating ones aimed at person machines.

### Option P: carry a source patch

Fork `get-bb/bb` and keep a small patch series on the release tag we pin:
(a) a request principal (trusted-proxy header → verified identity) threaded into
`buildHookContext`; (b) Send-now runs `message.dispatch` when a plugin marks its
policy `hard`; (c) an admission hook for terminals, host files and host rename; (d) owner labels on
hosts. Build and ship `bb-app` from the fork for the **server only**, because daemons stay stock at
the same version as long as the patch doesn't touch the wire protocol.

Costs: we own a build and release pipeline for a fast-moving monorepo (the app, server
and daemon artifacts the server hands to daemons for updates must match), and
every bb bump means a rebase. Patching `start-server.js` in place from Ansible is cheaper
but even more brittle than Option M, with none of its self-test ergonomics.

### Recommendation

Spike **M first** (S7, S8). It removes the biggest gap, "hook can't see who", with no
fork, and it keeps the patch in our plugin repo where tests live. Write (a)–(d) as
**upstream PRs** at the same time. They match bb's own design language: its docs call
hooks "questions core asks", and the note on Send-now reads as a policy choice
rather than a technical limit. Only fall back to **P** if M's in-process assumptions don't hold, or
upstream says no. None of these closes the unauthenticated loopback and tailnet API; that
is still step 2 of the recommended approach.

## Spikes (all on a throwaway local bb 0.43.0, never the shared server)

- **S1 Coverage.** A plugin that rejects everything. Run every row of the matrix: UI create,
  fork, `bb thread spawn`, automation, workflow, scheduled send, `sendAt`+Send-now,
  host-offline+Send-now, terminal `host_path`. Record pass or bypass, and whether a rejected
  create leaves a `pending` row.
- **S2 Headers.** Does a plugin HTTP route with `auth: "local"` accept requests from the
  Access-fronted origin, and do `Cf-Access-*` headers survive cloudflared → bb? Use a local
  cloudflared tunnel plus a scratch Access app, not the production one.
- **S3 Intent binding.** Is the composer draft final before `POST /threads` goes out,
  and does its text match `PluginDispatchInput.text` (mentions, attachments, slash
  commands)? Measure the timing window and the false-match rate.
- **S4 Host pinning.** Enroll, rename, re-enroll: are ids stable, and are names unique?
- **S5 Exposure.** From a person account on ew-lsp-001, is `127.0.0.1:38886` and the
  tailnet port reachable (read-only `GET`)? Needs a go-ahead before touching the box.
- **S7 ALS in real bb.** A plugin patches `http.Server.prototype.emit`; a hook logs
  `als.getStore()` for a UI create, a CLI spawn (expect a store with no identity) and a drain
  (expect none). Also check behaviour across `bb plugin reload`.
- **S8 In-process gate.** Refuse Send-now and `PATCH /hosts/:id` by path; try
  buffering and replaying the `POST /terminals` body without breaking Hono.
- **S6 Cross-plugin.** Can presence's app call `people`'s HTTP route, and should they share
  or merge the row-glyph surface?

## Open questions

1. **Collaboration vs policy.** Typing into someone else's thread runs the agent *as them*.
   Is that allowed (pairing), limited to some people, or treated like starting a thread?
2. **Automations.** Who owns one? bb records no creator. Restrict automations to the team
   machine, or attribute them when created through a plugin-owned flow?
3. **Team machine rules.** pi-only enforced by `providerId`? Who can start there? Anyone?
4. ~~**Unknown hosts** (the `ensembleworks-agent` machines, laptops that get enrolled). Allow, deny, or admin only?~~ **Answered 2026-09-17: run as `ensembleworks-agent`, shown as "unclaimed", starts allowed, hostId recorded on first sighting — see answer 6 above.**
5. **Fail-closed?** If the plugin app isn't loaded in a stale tab, there's no intent. Reject
   (safe, confusing) or allow and flag (friendly, leaky)?
6. **Threat model.** Is a guardrail enough for four trusted people, or is the gate from step 2
   in scope? That decides whether §2's intent binding is worth building at all.
7. **Emails.** Which address does Access actually assert per person (GitHub IdP primary
   email)? That has to be added to `ew_bb_people`.
8. **Admin override.** Does David (or an ops role) get a break-glass path, and how is it recorded?

### Step 3 built (2026-09-17): attribution, with a boot self-test

Landed on `feature/identity-attribution` (`plugins/identity/attribution.ts`, plus the
self-test in `request-context.ts` and the wiring in `server.ts`). Step 3 of the revised
plan is done; steps 4 and 5 are untouched, and **nothing in this change can reject a
dispatch** — the hook always returns `proceed` and swallows its own errors.

**What it does.**
- `message.dispatch` records `threadId -> {starter, email, via, origin, originPluginId,
  inheritedFrom, recordedAt}` in `bb.storage.kv` on the FIRST dispatch for a thread.
  First write wins, so a follow-up by someone else never takes a thread over.
- `via` is `browser` (identified, `origin: app`/none), `agent` (identified `cli`/`sdk`,
  or a lineage inheritance), `plugin` (plugin origin, no identity, no lineage) or
  `unknown`. An email that matches nobody is `unknown` and is still recorded, never an
  error.
- Lineage priority: `startedOnBehalfOf.senderThreadId`, `queuedMessage.senderThreadId`,
  `context.parentThreadId ?? thread.parentThreadId`, `thread.sourceThreadId`. A linked
  thread whose own starter is unknown is skipped.
- Read path: RPC `identity_thread_starter` and `GET …/http/thread-starter?threadId=`,
  both returning `{threadId, starter, via, inheritedFrom, recordedAt}` or `null`. The
  recorded email is deliberately NOT exposed on the read path; only the resolved person.
- **Boot self-test:** the prototype's live `emit` is checked for Identity's own patch
  marker, then one real request is driven through bb's server to
  `GET …/http/request-context-probe`, whose handler reports the email from the ASYNC
  CONTEXT rather than the header. Verdict logged, and served by
  `GET …/http/request-context-self-test`. It never restores `emit` (S7 lesson 1), and a
  failure only degrades Identity to "no identity".
- **Storage policy, stated:** one ~200-byte record per thread plus an insertion-ordered
  index, capped at 2000 threads (`MAX_STARTER_RECORDS`); past the cap the oldest are
  deleted and read back as `null`. Attribution is a guardrail aid, not an audit log, and
  the cap keeps the index row far inside kv's 256KB per-value limit.

**SDK surfaces verified against `@get-bb/plugin-sdk` 0.4.84 `.d.ts` (not taken on trust).**
- `bb.experimental_hooks.on("message.dispatch", handler)` — the only hook
  (`PluginHookSignatures`, L19084). Confirmed fail-closed: a throw or >10s fails the
  attempt, and the whole pass runs under one server-wide lock — which is what makes
  first-write-wins safe against two concurrent first dispatches.
- `MessageDispatchHookContext` (L19016) carries `thread`, `origin`, `originPluginId`,
  `startedOnBehalfOf`, `parentThreadId`, `queuedMessage`. **Correction to this note:**
  `sourceThreadId` is NOT a hook-context field — it lives on `context.thread`
  (`threadResponseSchema`, L12781), as does a second `parentThreadId`. The
  "No-identity policy" table's lineage list should be read that way. A queued row's
  `senderThreadId` is on `threadQueuedMessageSchema` (L4140).
- `StartedOnBehalfOf` is `{initiator: "agent"|"system", senderThreadId: string}` (L11241).
- `ThreadCreateOrigin` is exactly `app | cli | plugin | sdk` (L11210); the hook context's
  `origin` is nullable for core-driven sends.
- `bb.storage.kv` is `get/set/delete/list(prefix)` with ≤256KB values (L18606).
- `bb.server.loopbackBaseUrl` (L19990) is bind-gated and throws before the server
  listens, so the self-test runs on a delayed timer with retries.

**Runtime probe (throwaway bb-app 0.43.0, temp HOME, ports 39886/39887, 2026-09-17).**
All confirmed against real bb, not just unit tests:
- self-test: `{"ok":true,"detail":"request context is live (probe saw its own tagged
  email, nested in the loading request's context)"}`;
- `POST /api/v1/threads` with `cf-access-authenticated-user-email: david@example.com`
  → `starter: mrdavidlaing, via: browser`;
- the same create with no header and no lineage → `starter: null, via: unknown`;
- a header-less `origin: cli, originKind: fork, sourceThreadId: <david's thread>` create
  → `starter: mrdavidlaing, via: agent, inheritedFrom: <david's thread>`;
- a follow-up `POST /threads/:id/send` from `stranger@example.com` did NOT rewrite the
  starter (first write wins);
- both read paths answer, `null` for an unrecorded thread, 400 for a missing `threadId`.
- Recipe corrections for the next spike: `POST /api/v1/threads` takes `input: [blocks]`
  (not `message`), requires `origin`, and `sourceThreadId` requires `originKind`;
  `POST /threads/:id/send` requires a `mode`; `startedOnBehalfOf` requires a
  `sourceThreadId` or `parentThreadId` alongside it. `bb plugin logs identity` is where
  `bb.log` output lands — not the server log.

**Wrong belief corrected, found only by the probe.** The first cut of the self-test
refused to run when it was already inside a request context. In real bb the plugin
factory — and any timer it schedules — runs inside the async context of the request that
loaded the plugin (`bb plugin reload` is an HTTP request), so the self-test failed on
every single load. Nesting is now noted in the verdict's detail instead of failing it;
the verdict still comes from the probe's own separate request. There is a regression test
for it in `request-context.test.ts`.

**Not done here (deliberately):** the ownership UI (step 4) and the `restrictStarts` /
`requireIdentity` guardrails (step 5). Send-now still skips the hook, so a thread whose
first message goes out through Send-now is recorded on its next hooked dispatch, or not
at all — unchanged from S7's accepted gap, and worth naming in step 5's design.

## Sources

- `plugins/presence/{README.md,server.ts,app.tsx}` in this repo.
- SDK types: `plugins/canvas/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`
  (0.4.84): `BbPluginApi` L20081; hooks L18947–19131; events L18694, L19970; HTTP/RPC
  L19148–19201; `PluginRpcHandlers` L14368; `hostSchema` L471; `updateHostRequestSchema`
  L8642; create/fork/terminal requests L11249/L11446/L10099;
  `PluginSidebarThread` L15082; composer scopes and view L15958–16022.
- Server: `~/.local/share/bb-runtime/lib/node_modules/bb-app/server/dist/start-server.js`
  (0.43.0): `src/services/threads/dispatch-hooks.ts` (`buildHookContext`,
  `runMessageDispatchHookPass`); the send path with `sendNow`/`sendAt`; route literals;
  builtin `concurrency-limit` plugin (per-host dispatch policy).
- CLI: `host-daemon/dist/bb-chunks/*` (`threads.spawn({origin:"cli", … startedOnBehalfOf:null})`,
  `--parent-self` reads `BB_THREAD_ID`); the daemon injects `BB_SERVER_URL` into agent shells.
- Infra: `lean-software-production/infrastructure` `inventory/group_vars/ew.yml`
  (`ew_bb_people`), `roles/ew_bb/defaults/main.yml` (loopback bind, tailnet proxy, "bb has no auth").
- Reusable verifier: `server/src/access-identity.ts`.
