# EW Codespaces — repo-bound devcontainer as the session unit

**Date:** 2026-07-21
**Status:** design (brainstorming synthesis; not yet built)
**Builds on:** [`distributed-terminals-design.md`](./distributed-terminals-design.md)
— the gateway / connector / relay-splice plane, outbound-registration model,
session fan-out and authoritative-resize semantics are all **inherited
unchanged** from that doc. This doc reuses them and adds the session unit,
its lifecycle, and its persistence model.
**Supersedes:** that doc's central thesis *"every gateway always uses
TmuxBackend internally."* An EW Codespace's connector owns the PTY directly;
tmux is dropped (§7).

---

## Why

The current model has four structural limits, all rooted in the fact that a
"terminal" is a tmux window on one shared VM, running as one shared user:

1. **No isolation.** Every terminal shares a user, kernel and filesystem; a
   compromised or messy session touches everyone's work.
2. **No per-session dependencies.** There is no way to give session A one
   toolchain and session B another.
3. **No durability.** tmux dies on reboot and nothing reconstructs the
   workspace.
4. **No reach.** You cannot take a terminal that runs *somewhere else* (a
   laptop, a Codespace) and surface it on the canvas.

Reach (#4) is already solved by the distributed-terminals connector/relay
model. This doc solves #1–#3 by making the *session unit* a real, isolated,
dependency-scoped, durable thing — modelled on GitHub Codespaces — and by
giving it a lifecycle and a bring-back story.

## The core idea

**A session is a Codespace: a devcontainer bound to a specific git repository,
started on a host, from which one or many terminals are surfaced onto a
canvas.**

Two units, not one:

- **Codespace** — the isolation + dependency + repo boundary. Heavyweight,
  git-backed, has a real lifecycle (create → start → stop → rebuild). This is
  where isolation (#1) and per-session dependencies (#2) live.
- **Terminal** — a cheap *view* onto a Codespace: one PTY, one canvas shape.
  Disposable. **One Codespace → many terminals** (the GitHub model).

This 1:N split maps almost exactly onto the existing wire model. One connector
runs inside the Codespace, registers it once over an outbound WSS, and serves N
terminal sessions. The relay already addresses bytes as
`session=X & gateway=Y`, so **`gatewayId ≈ codespaceId`** and "many terminals
from one Codespace" needs no new protocol.

### Naming

"Codespace" is used deliberately, disambiguated where it could collide:

- **GitHub Codespace** — the hosted GitHub product.
- **EW Codespace** — one of ours.
- bare **Codespace** — the shared concept (a repo-bound devcontainer you start
  on a host and surface terminals from). Never use the bare word in logs / UI /
  docs where it could mean the product.

A real GitHub Codespace is simply **one host type that can back an EW
Codespace** (§5).

## 1. The compatibility promise

> **If `devcontainer.json` boots your repo in a GitHub Codespace, it boots as
> an EW Codespace, unchanged.**

The promise is enforced by a standard we don't own — the devcontainer spec —
which turns the design into a testable claim rather than an abstraction. It
disciplines the whole design:

- **The devcontainer spec is the contract, not a convenience.** Honor the parts
  teams rely on: `image` / `build`, `features`, `forwardPorts`,
  `postCreateCommand` / `postStartCommand`, `remoteUser`, dotfiles. Anything we
  cannot support becomes an explicit, documented gap — because "works in a
  GitHub Codespace" is now a claim we can be *wrong* about.
- **Conformance smoke test.** CI boots a handful of real public
  `devcontainer.json`s (a plain Node one, a compiled-language one, a
  `features`-heavy one) on an EW host and asserts not just that the container
  comes up but that **a terminal appears on a canvas** — the interesting
  failure surface is repo → container → *connector* (a `remoteUser` that can't
  read `/ew/`, a conflicting mount, a read-only root fs), not repo → container
  alone. This is the mechanical backstop for the promise.
- **The EW-specific piece stays additive** (§2), so the same repo runs on
  GitHub with no EW awareness and on EW with no GitHub awareness. Canvas
  attachment is a property of *where you launched it*, not of the repo.

## 2. Delivery of the EW bits — injection vs. feature

The connector is delivered two ways; which one is right depends on **whether an
EW host process is present to do the injecting.**

- **Runtime injection (default).** Launch-time, host-supplied, **repo-pristine.**
  The EW host builds the *unmodified* repo, then drops the connector into the
  already-running container and starts it. No rebuild, no image change, the repo
  carries zero EW content.
- **Feature (fallback).** Build-time, in-image, **repo-declared.** Runs during
  `devcontainer build`, bakes the connector into the image, and the repo's
  `devcontainer.json` must list it. Portable to hosts we don't control, at the
  cost of a rebuild and the repo "knowing" about EW.

| Host | EW process present? | Delivery | Repo touched? |
|---|---|---|---|
| Laptop / worker VM / stereOS | yes | **runtime injection** | no |
| Real GitHub Codespace | no | feature *or* manual launcher | feature: yes / launcher: no |

Both paths keep the promise: injection needs nothing in the repo; the feature's
one added line is portable by construction.

### 2.1 Runtime injection, concretely (local laptop)

`ew codespace up --canvas https://… --room design-review` in a repo dir:

1. **Host builds the repo as-is.** The `ew` CLI shells out to
   `@devcontainers/cli`: `devcontainer up --workspace-folder .`, honoring the
   repo's `devcontainer.json` exactly and returning the **container id**.
   Nothing EW-specific has touched the repo.
2. **Host layers in the connector via a host-supplied *overlay config*, not an
   edit.** A **read-only bind mount** of `~/.ew/runtime/` (holding a *static*
   connector binary) is added at `up` time via merged config — the repo file is
   never modified; the mount exists only because *this* launch asked for it.
   (`docker cp` into the running container is the cruder fallback.) Upgrading the
   connector becomes a one-file swap host-side.
3. **Host starts the connector by `exec`, with secrets as env — never in the
   image or the workspace.** `devcontainer exec … -- /ew/connector`, passing
   `CANVAS_URL`, the stable `gatewayId`, and the CF Access token /
   `GATEWAY_SECRET` **as exec-time env vars**. Creds never land in an image layer
   and never get written into the **workspace** (which *is the git repo* and
   could otherwise get committed). The connector dials outbound WSS to the
   canvas; terminals appear on the room.
4. **Host owns the lifecycle.** Because the host owns the Codespace
   (`up` / `stop` / `rebuild`), it also supervises the connector — restart on
   crash, re-exec after a container restart, tear down on stop. No
   `postStartCommand`, no in-container supervisor.

Decisions baked in here:

- **Stable `gatewayId`** persisted host-side (an id file in `~/.ew/`, keyed by
  **checkout path** — not repo name, so two clones/branches of the same repo
  get distinct ids and never collide), **not** in the repo, so
  reboot/reconnect reattaches to the same shape instead of spawning a
  duplicate. One Codespace surfaced onto multiple canvases (§4) reattaches
  per-(gatewayId, canvas).
- Under the §7 decision there is no `tmux` in the mount — the connector is the
  PTY owner, so the injection mount ships only the connector binary.

### 2.2 Host prerequisites — one `ew` binary + Docker

The runtime-injection path assumes an **EW host process** (§2). Naively that's a
dependency chain — `ew` **plus** `@devcontainers/cli` **plus** a container
runtime **plus** the connector binary — which is a lot to install on a laptop.
We collapse it to **one `ew` binary + Docker** by embedding the rest.

**Embed the reference devcontainer CLI; do not reimplement it.**
`@devcontainers/cli` (Microsoft, MIT) *is* the reference implementation of the
spec, and §1's compatibility promise is defined by its behaviour — `features`
resolution (OCI feature tarball download, install-order, the generated layered
Dockerfile), image-metadata merge, variable substitution, lifecycle-hook
ordering, workspace-mount / `remoteUser` semantics. Reimplementing that subset
in `ew` would let us *diverge from the thing we promised to match*, on a spec
that keeps moving. So reimplementation is ruled out.

**How it's embedded (approach B).** `ew` is Bun-compiled, so `bun build
--compile` embeds JS and arbitrary assets into the single executable. Rather
than `import`ing the package as a library (its programmatic surface is
internal/unstable — built to be a CLI, not a library), `ew` carries the
upstream CLI **bundle as a data asset**, extracts it to `~/.ew/` on first run,
and runs it **under Bun's node-compat** as a subprocess. This invokes the
supported, stable CLI interface and runs the reference implementation verbatim
— which is exactly what protects the compatibility promise — while still
shipping as one binary.

**The unification.** The **connector** (§2.1) is carried the same way: an
embedded asset `ew` extracts on first run, instead of a separately-downloaded
binary staged in `~/.ew/runtime/`. So the entire host toolchain becomes one
self-contained `ew` binary that extracts what it needs, drives Docker via the
embedded CLI, and injects the connector. This also closes the §2.1 bootstrap
question ("how do `ew` and the connector reach the laptop") — they don't;
`ew` *is* both.

**Honest boundaries:**

- **Docker is still required and is the heavyweight.** "Only Docker" is the
  *floor*, not zero — the spec is defined in terms of containers, so the
  runtime can't be dropped. (Podman/rootless is a separate decision; the CLI
  takes `--docker-path`.)
- **Network is still needed at build time** — pulling base images and OCI
  features. Embedding removes the *install* dependency, not the *runtime fetch*.
- **Bun must actually run the CLI.** The one real technical risk is a
  node-compat gap in `@devcontainers/cli` under Bun (`child_process`,
  `worker_threads`, any native-ish dep). This needs a **spike before
  committing** (tracked in Open decisions). Fallback if it hits a wall: also
  embed a minimal Node runtime (heavier), or keep "shell out to an installed
  `devcontainer`" as an escape hatch.
- **Pin and gate the embedded version.** Version-pin the embedded CLI and treat
  bumping it as a deliberate act gated by §1's conformance smoke test — because
  that CLI's behaviour *is* the promise.

## 3. Isolation tiers = host type

The isolation story is not a separate concept; it is **which runtime backs the
Codespace**, chosen per-Codespace in the orchestrator manifest:

| Tier | Backing host | Notes |
|---|---|---|
| Default | plain devcontainer (Docker) | kernel/fs/process isolation via the container |
| Hardened | gVisor / stereOS VM, or an OpenShell policy sandbox | for agent / untrusted sessions: fs/net/process/inference egress control |
| Zero-infra | a real GitHub Codespace | repo-native; connector via feature/launcher (§2) |
| Latency / scale | laptop / worker-VM pool | same abstraction, different placement |

The connector normalizes all of them to the canvas identically. OpenShell (or
gVisor) is an **opt-in hardened profile for agent/untrusted sessions**, not the
universal substrate.

## 4. Repo-centric, not room-centric

Because the unit is bound to a repo rather than a room, a single Codespace can
surface terminals onto **multiple canvases** — decoupling where compute lives
from which room is watching. Strictly more flexible than today's
one-VM-per-room reality.

Open decision: **one primary repo vs. multi-repo** per Codespace. Recommendation
— keep one *primary* repo for prebuild/identity, allow extra clones alongside.

## 5. Persistence & restart

"Restart" is several events with different guarantees. Separating them is the
whole game.

### 5.1 The five restart events

1. **Terminal reopened** (browser refresh / shape reopened) — host unchanged.
2. **Connector restart** (crash / re-exec) — under option A (§7) the connector
   *owns* the PTYs, so a connector crash **kills every shell in the Codespace**;
   the host supervisor restarts the connector and terminals come back at a
   fresh prompt. (Under rejected option B the PTYs would have survived
   independently.)
3. **Container stop → start** (Codespace stopped, then resumed) — processes die,
   disk persists.
4. **Host reboot** (laptop restarts) — Docker daemon and all under it go down.
5. **Rebuild** (`devcontainer` rebuild) — container recreated from image; only
   persisted volumes survive.

### 5.2 The state model

| State | Where it lives | stop→start | rebuild |
|---|---|---|---|
| A. Working tree (uncommitted edits) | `/workspaces` (laptop: bind mount of the real repo dir) | ✅ | ✅ |
| B. Home / tool state (`~/.config`, history, post-create installs) | container disk (or a named volume) | ✅ | ❌ unless on a volume |
| C. Running processes | container process table | ❌ | ❌ |
| D. Terminal layout (which sessions, names, cwds) | container process table (recoverable as intent — §5.6) | ❌ | ❌ |
| E. Canvas shapes (which terminals existed, placement) | canvas server | ✅ (independent) | ✅ |
| F. Orchestrator desired-state (which Codespaces should exist) | host-side durable store | ✅ | ✅ |

### 5.3 The honest promise

> After any restart, your **working tree is intact** and your **terminals
> reappear on the canvas, in your repo** — but at a **fresh shell prompt**,
> exactly like resuming a stopped GitHub Codespace.

Live processes never survive a container stop — and neither do they in a GitHub
Codespace. We don't fight this: the tempting escape (run the PTY *outside* the
container) breaks isolation (#1) **and** the compatibility promise. Process
checkpoint/restore (CRIU) with ttys, sockets and GPUs in play is explicitly
rejected.

### 5.4 What makes the shape come back

- **Durable state = volumes + git.** On a laptop, A is trivially durable because
  the workspace is a bind mount of real files (survives even `docker rm` and
  rebuild). B needs a **named volume** if post-create tool installs are to
  survive a *rebuild* — the classic Codespaces "rebuild wiped my global install"
  gotcha; matching it is honest, improving on it (volume-mount key dirs) is
  optional.
- **Bring-back = host reconciler + stable `gatewayId`.** The reconciler reads
  desired-state (F) and, for each Codespace that should be running, ensures the
  container is up (`devcontainer up` is idempotent) then re-execs and supervises
  the connector. Because `gatewayId` is durable host-side and canvas shapes (E)
  are durable, the terminal **reattaches to the same shape** rather than
  duplicating.

### 5.5 Reboot-specific tradeoff

**Runtime injection ⇒ the host reconciler is required for reboot.** Docker's
`restart: unless-stopped` brings the *container* back, but it will **not**
re-inject the connector (the connector isn't in the image and isn't the
entrypoint). So reboot survival needs a host-side thing that runs at login (a
systemd user service / login item) and calls the reconciler. The feature path
*could* lean on Docker's restart policy alone (the connector is baked in) — this
is the price of keeping the repo pristine. (The reconciler also serves the
multi-Codespace case — restart policy alone can't express "these Codespaces
should exist"; on a single worker VM with a baked-in connector, restart policy
alone could genuinely suffice.)

### 5.6 Optional — layout restore (recover intent, not processes)

On graceful stop the connector may snapshot to the durable volume: which
terminal sessions existed, their names, cwds, optionally last command line +
scrollback. On restart it replays the *layout* — recreates sessions with the
same names/cwd, re-surfaces the same shapes, optionally shows persisted
scrollback as read-only history — then drops you at a prompt in the right
directory. This is the [quil.cc](https://quil.cc) pattern scoped to what is
actually recoverable.
Because the connector owns its own scrollback ring (§7), persisting it to the
volume is a natural extension.

## 6. Orchestrator plane (the missing piece)

Everything above needs one component that doesn't exist today: an
**orchestrator** holding **desired-state** — "these Codespaces should exist, at
repo@branch, on this host, at this isolation tier" — and a **boot-time
reconciler** that drives reality toward it (`clone-if-absent → up → connect`).
This is the [quil.cc](https://quil.cc) *pattern* (daemon persists
desired-state and reconciles on boot) implemented over the connector, **not**
an adoption of quil.cc as a tmux replacement.

Where desired-state lives: a host-side durable store (e.g.
`~/.ew/codespaces.json`) owned by the `ew` daemon — not the canvas server
(compute placement shouldn't depend on the room being reachable) and not the
repo (the repo stays EW-pristine, §2).

## 7. Terminal substrate — connector owns the PTY (option A)

The tmux behaviours we actually use are: **(a) a session that survives
browser reconnects**, **(b) many browsers attached to the same terminal
seeing identical bytes**, and **(c) shells that survive a gateway/connector
crash or restart.** (a) and (b) are already provided by the connector's
WebSocket layer, *not* by tmux — the connector holds one PTY per session, fans
output to every attached socket, keeps a scrollback ring, and replays it on
reconnect. tmux's windows/panes/prefix-key UI actively gets in the way of
non-tmux users.

(c) we **explicitly trade away**: with the connector owning the PTYs, a
connector crash kills every shell in the Codespace (§5.1 event #2) — a real
regression from tmux, mitigated by host supervision making crashes rare and
restarts fast, not defined away.

**Decision: the connector owns the PTY directly; tmux is dropped.**

- The connector spawns the shell on a PTY, keeps the scrollback ring, broadcasts
  output to N relay clients, accepts input from any of them, and implements the
  inherited authoritative shared resize (any client proposes a size, the
  connector resizes the PTY and broadcasts the authoritative grid to all
  viewers). `Bun.Terminal` / node-pty handles PTY mechanics.
- **Session lifetime ≤ container lifetime.** The shell never outlives the
  container, and (per the (c) trade-off above) also dies with the connector;
  planned connector upgrades ride container restarts.
- The injection mount ships only the connector — no static tmux.
- **Power users keep multiplexing** by running `tmux` themselves inside the
  shell; we simply don't impose it.

**Accepted loss:** no history **reflow on resize** — a raw PTY doesn't re-wrap
old scrollback when the grid changes. For modern repainting apps
(`SIGWINCH` → redraw) this is cosmetic. Also owned by us now, previously free
from tmux: winsize/signal edge cases and UTF-8 / `LANG` handling (see the
existing `LC_CTYPE` foot-gun in `terminal-gateway.ts`). Note both losses match
what a GitHub Codespaces terminal already gives users — no reflow, plain PTY —
so the accepted baseline is the same one the compatibility promise (§1) anchors
to.

*(Rejected — option B: a `dtach`/`abduco`-style session-host daemon owning the
PTY so the shell survives a connector crash/hot-upgrade independent of the
container. Buildable and small — it's detach without multiplexing — but the
resilience it buys only matters when the connector restarts without the
container, which under option A it doesn't. Revisit only if hot-upgrade
independent of container restart becomes a real requirement.)*

## Inherited unchanged from `distributed-terminals-design.md`

The relay plane, the relay-splicer, outbound connect-is-register, the
read-only gateway/Codespace list, session fan-out, authoritative shared
resize, and the `GATEWAY_SECRET` registration-auth requirement (still required
before any non-spike use) all carry over verbatim. Read that doc for *why the
gateway/relay plane exists*; this doc changes only the session unit and the
PTY substrate.

## Open decisions (tracked)

1. One primary repo vs. multi-repo per Codespace (§4) — lean: one primary,
   extra clones allowed.
2. What backs the durable volume for state B across host types (§5.4) — trivial
   on a real Codespace, needs a named-volume story on the worker pool.
3. OpenShell vs. gVisor for the hardened tier (§3) — evaluate against the
   agent-terminal threat model.
4. Reconciler packaging on the laptop (§5.5) — systemd user service vs. login
   item vs. an `ew` background daemon.
5. **Bun-compat spike for the embedded devcontainer CLI (§2.2)** — verify
   `@devcontainers/cli` runs correctly under Bun's node-compat when embedded and
   run as approach B (`child_process`, `worker_threads`, native-ish deps are the
   suspect surfaces). Must pass before committing to the one-binary embedding;
   fallbacks are embedding a minimal Node runtime or shelling out to an
   installed `devcontainer`.
