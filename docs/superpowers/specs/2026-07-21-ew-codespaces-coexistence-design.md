# EW Codespaces coexistence — design

**Date:** 2026-07-21
**Status:** approved design (brainstorming output; implementation not started)
**Refines:** [`docs/2026-07-21-ew-codespaces-design.md`](../../2026-07-21-ew-codespaces-design.md)
and [`docs/2026-07-21-ew-auth-design.md`](../../2026-07-21-ew-auth-design.md).
This spec turns those architecture docs into a buildable, incremental program:
how EW Codespaces run **alongside** the existing terminal implementation, what
already exists in the codebase, the per-person identity / input-ACL model, the
Codespace canvas shape, and the sub-project decomposition.

---

## 1. Goal

A **Codespace** — a devcontainer bound to a git repository, started on a host
the user owns — becomes a first-class session unit surfaced on the canvas as a
**container shape holding terminal shapes**, running under the **owner's
personal identity**, while the existing shared-VM tmux terminal path keeps
working, untouched, indefinitely.

## 2. What already exists (ground truth, verified 2026-07-21)

The architecture docs understate how much is built. The coexistence story
leans on all of it:

- **Relay plane is live in production.** `server/src/gateway-registry.ts`
  implements the relay splicer: connectors dial one outbound WS to
  `GET /api/terminal/connect?gatewayId=…&label=…` (connect-equals-register);
  browsers attach via `GET /api/terminal/relay?session=X&gateway=Y`. Mounted
  unconditionally in `server/src/app.ts:332`, upgrade handled before `/sync`.
- **The client already forks cleanly.** `client/src/terminal/wsUrl.ts:8-20`:
  `props.gateway` unset → legacy `/api/terminal/ws` (the `:8789` tmux gateway
  process); set → `/api/terminal/relay`. The browser-facing byte protocol is
  identical on both paths.
- **Registration is already identity-bound.** `server/src/whoami.ts:79-90`
  (`resolveGatewayOwner`) binds each gateway registration to a verified CF
  Access identity (`sso:<email>` / `token:<common_name>`); reconnect by a
  different owner is rejected. `GATEWAY_SECRET` was never built and is not
  needed — this supersedes it, as the auth design doc anticipated.
- **A TS connector exists** in `cli/src/connector/` (relay client, mux,
  reconnect/backoff, session manager) — currently tmux-backed via a pluggable
  `SpawnFactory` (`cli/src/connector/session.ts:35`).
- **CLI auth exists.** `ew auth login|status|logout` with CF Access service
  tokens, stored in `~/.config/ensembleworks/hosts.toml` (0600), resolved per
  canvas origin (`cli/src/hosts.ts`). This carries all early sub-projects; the
  browser-login flow is pure UX improvement.
- **Caddy split (the coexistence seam):** `/api/terminal/ws` → the `:8789`
  process; `/api/terminal/connect|relay|list` → the sync app. Both worlds
  answer under `/api/terminal/*` on different listeners today.

## 3. Coexistence architecture

**The legacy path is frozen: zero changes** to `server/src/terminal-gateway.ts`,
the `TERM_RUN_AS` sandbox model, or terminal shapes with `props.gateway`
unset.

A Codespace is **just another gateway** on the existing relay plane:

- Its connector (running inside the devcontainer) dials
  `/api/terminal/connect?gatewayId=codespace-<id>` — existing route, existing
  identity binding, existing framing.
- Its terminals are **existing terminal shapes** with
  `props.gateway = <codespace gatewayId>` — the existing client fork routes
  them to the relay with no flag and no new code path.
- No feature flag is needed: the fork is data-driven by `props.gateway`, and
  rooms without Codespaces behave byte-identically to today.

## 4. Identity & input ACL (per-person, not shared)

Unlike legacy terminals (one shared sandbox user on one shared VM), a
Codespace runs on a host its owner controls, under their own OS user. Personal
credentials — `gh auth login`, ssh keys, dotfiles — are naturally theirs and
never shared infrastructure.

That creates a canvas-side tension: on a shared canvas, anyone can type into
any terminal, so a Codespace holding personal credentials would let teammates
act *as the owner*. Resolution — **owner-controlled input toggle**:

- **Ownership** = the CF Access identity captured at registration (already
  built; `resolveGatewayOwner`).
- **Registration payload gains codespace metadata:** `repo`, `branch`, and
  `inputPolicy: 'locked' | 'shared'`, default `locked`.
- **Enforcement is server-side, at the relay splice.** The relay attach
  resolves the *viewer's* Access identity from the same upgrade headers. When
  policy is `locked` and viewer ≠ owner: output flows normally, input frames
  are dropped at the relay, and the viewer is told they are read-only. Client
  badges are decoration, never the enforcement.
- **Toggle:** the owner flips policy via an authenticated API
  (`POST /api/gateway/:id/input-policy`, owner-match enforced server-side).
  Pure relay-plane state; the connector is not involved. This is the ensemble
  "hand over the keyboard" move.
- **Granularity:** per-Codespace in v1. Per-terminal is a natural later
  extension; not built now.
- **Legacy terminals have no owner** and remain `shared` — behavior unchanged.

## 5. The Codespace canvas shape (tldraw first)

- **New shape type**, props defined once in `contracts/src/shapes.ts`
  (`codespaceShapeProps`): `w, h, gatewayId, repo, branch, status, owner,
  inputPolicy`. Client implements `CodespaceShapeUtil`.
- **It is a container.** Child terminals are the existing terminal shape,
  tldraw-parented into it (children move with the parent natively), created
  with `props.gateway = gatewayId`.
- **Header:** repo@branch, status dot (driven by the gateway registry's
  connect/disconnect events), owner, and the input-policy toggle (visible to
  all; actionable only by the owner — server enforces regardless).
- **`[+ terminal]`** spawns a child terminal shape bound to the gateway.
- **Lifecycle stays in the CLI for v1.** The shape carries no `stop`/`rebuild`
  controls: canvas→host command dispatch (the connector
  executing host-level operations from inside the container) is explicitly
  deferred.
- **Engine:** legacy tldraw first — it runs the `team` room and all daily
  work, and gives parenting for free. The canvas-v2 port joins the v2 parity
  backlog; the shared `contracts` props definition is the porting seam.
- Shape and input-toggle work touch interaction-bearing surfaces →
  **interaction contracts required** per CLAUDE.md (declare in
  `@ensembleworks/interaction-contracts`, red-then-green, both adapters).

## 6. Sub-projects & build order

Five sub-projects, each independently shippable and testable, each with its
own implementation plan. This spec is the umbrella.

1. **Raw-PTY connector backend.** Swap the tmux `SpawnFactory` in
   `cli/src/connector` for a connector-owned PTY per session (design doc §7):
   the connector spawns the shell on a PTY (`contracts` `spawnPty`), keeps the
   scrollback ring, fans output, implements authoritative resize. Accepted
   trades carry over: connector crash kills shells (host supervision
   mitigates); no scrollback reflow on resize. Testable immediately against
   the live relay plane and existing terminal shapes — no devcontainer needed.
2. **`ew codespace up`.** Gated by the **Bun-compat spike**: verify
   `@devcontainers/cli` runs under Bun's node-compat when embedded as an asset
   and executed as a subprocess (suspects: `child_process`,
   `worker_threads`, native-ish deps). Fallbacks: embed a minimal Node
   runtime, or shell out to an installed `devcontainer`. Then: embed the
   pinned upstream CLI + the connector as compiled assets in the one `ew`
   binary; build the unmodified repo (`devcontainer up`); inject the connector
   via a read-only overlay mount of `~/.ew/runtime/`; start it by
   `devcontainer exec` with creds as exec-time env; stable per-checkout
   `gatewayId` persisted host-side; verbs `up / stop / rebuild / list`. The
   **conformance smoke test** (boot 2–3 real public `devcontainer.json`s,
   assert a terminal reaches a canvas) lands here and gates embedded-CLI
   version bumps.
3. **Codespace shape + input ACL.** Contracts props, registration metadata
   (`repo`/`branch`/`inputPolicy`), relay-side ACL enforcement + toggle API,
   `CodespaceShapeUtil` with child-terminal spawning, status dot. Interaction
   contracts as above.
4. **Reconciler + layout restore.** Desired-state in `~/.ew/codespaces.json`;
   boot-time reconciler (systemd user service) that re-runs
   `clone-if-absent → up → inject → connect` idempotently; connector snapshots
   session names/cwds (optionally scrollback) to the durable volume on
   graceful stop and replays the *layout* — not processes — on restart.
5. **Browser `ew auth login`.** The gh-style Cloudflare Access browser flow
   (probe → discover team domain from the 302 → loopback listener → store by
   origin in `hosts.toml`) plus host-side app-token refresh (host mints fresh
   tokens from the org token and hands them to the connector on every
   (re)connect). Fully independent; service-token auth carries 1–4.

## 7. Testing posture

- **Sub-project 1:** unit tests on the PTY session manager mirroring the
  existing `session.test.ts` suite; a loopback test driving a real relay
  (pattern: `server/src/connector-loopback.test.ts`).
- **Sub-project 2:** the conformance smoke test is the acceptance test; the
  Bun-compat spike produces a dated pass/fail verdict before any embedding
  work proceeds.
- **Sub-project 3:** interaction contracts for shape gestures and the toggle;
  server tests covering the ACL matrix (owner / non-owner × locked / shared ×
  input / output).
- **Sub-projects 4–5:** unit tests plus one end-to-end rehearsal each (a real
  reboot-and-reconcile; a real browser login against an Access-fronted
  deployment), specified in their own plans.

## 8. Explicitly out of scope

- Any change to the legacy `:8789` tmux gateway or shared-VM terminals; any
  deprecation of them.
- Canvas-v2 implementation of the Codespace shape (parity backlog).
- Canvas-initiated lifecycle (`stop`/`rebuild` from the shape).
- Per-terminal input ACL granularity.
- Hardened isolation tiers (gVisor/OpenShell), GitHub-Codespace hosting of an
  EW Codespace, multi-repo Codespaces — all remain open decisions in the
  architecture docs, none block this program.
