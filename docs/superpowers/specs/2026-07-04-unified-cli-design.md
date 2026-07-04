# Unified `ensembleworks` CLI — design

**Date:** 2026-07-04
**Status:** approved (brainstorming session; pty spike run and passed during design)
**Companion docs:**
[`docs/plugin-architecture-design.md`](../../plugin-architecture-design.md)
(§5 tool registry, §5.4 attribution — this design lands both early),
[`docs/distributed-terminals-design.md`](../../distributed-terminals-design.md),
[`2026-07-03-remote-devcontainer-terminal-spike-design.md`](./2026-07-03-remote-devcontainer-terminal-spike-design.md)
(the Go termgw spike this design retires).

## Goal

One `ensembleworks` binary that absorbs `bin/canvas` (agent canvas verbs),
the `termgw` Go connector (remote terminal daemon) and `connect.sh` (remote
setup UX). Primary driver: **one artifact on remote boxes** — a
devcontainer/Codespace curls down a single file that both connects its
terminal to the canvas and gives resident agents the canvas verbs,
resurrecting the agent-in-devcontainer loop the termgw spike deferred.

Alongside the CLI, the repo consolidates on **Bun as its only JS runtime**
and on **CI-compiled binaries** as the only thing installed on servers.

## Decisions (from brainstorming)

1. **Implementation: Bun/TypeScript, compiled with `bun build --compile`.**
   Chosen over Go (approaches B/C) after the pty spike passed — see Spike
   results. Amends plugin-architecture §2 ("Terminal gateway: Go"): the
   gateway/connector stays TypeScript on Bun; the Go rewrite is retired.
2. **Clean break.** No `canvas` alias or shim; SKILL.md reseeded once; the
   `CANVAS_URL`/`CANVAS_ROOM` env names die with the bash CLI (replaced by
   `ENSEMBLEWORKS_URL`/`ENSEMBLEWORKS_ROOM`).
3. **gh-style, auth-first UX.** `ensembleworks auth login` is the front
   door; noun-verb command groups; `ew` hardlink for daily typing.
4. **Auth methods v1: CF Access service-token pair + "none"** (localhost /
   tailnet instances without edge auth). Human SSO deferred.
5. **Service-token → bot-identity attribution is in scope** (plugin §5.4
   made real): `/api/whoami`, enforced authorship for token writes,
   per-token read-only/read-write scoping.
6. **CLI extensibility: all three layers in v1** — server tool manifest
   (primary), gh-style PATH extensions, native commands (auth, connector).
7. **bin/dev stays a separate command** (contributor tool, different
   audience) but moves onto the Bun runtime.
8. **Repo goes Bun-only.** Server runtime migrates to Bun (spike-gated);
   transcriber is spiked under Bun and falls back to a contained Node
   exception if `@livekit/rtc-node` fails; Python + livekit-agents is the
   transcriber's named future, triggered by local-Whisper/diarisation
   work, as its own spec. Contributor host requirement becomes
   **bun + docker**; Node version pins are deleted.
9. **CI-compiled binaries for every service; servers are runtime-free.**
   `deploy.sh` stops building on the host (no `npm ci` on prod) and
   becomes fetch-verify-swap of checksummed release artifacts.

## Spike results (2026-07-04, run during this design)

Bun ≥ 1.3.14 ships a native PTY API — `Bun.Terminal` /
`Bun.spawn(cmd, { terminal })` with write, resize, data callback, termios
flags and raw mode: a complete node-pty replacement. Verified:

- A `bun build --compile` standalone binary, copied to a clean directory
  and run with a scrubbed environment, spawned `tmux new -A` through a
  real PTY, wrote a command, read output, resized 80×24 → 120×40, exited
  cleanly.
- Cross-compile linux-x64 → linux-arm64 works with one `--target` flag;
  musl variants available. Binaries ~90 MB, link only glibc.
- The API is absent in Bun 1.3.4 — **Bun ≥ 1.3.14 is the build floor.**

Consequence: no node-pty anywhere in the end state, and the CLI connector
and the server terminal gateway share one session-manager implementation.

## 1. Command surface

```
ensembleworks auth login [--url <instance>]   # interactive: URL → method → verify → store
ensembleworks auth status                     # per instance: reachable + resolved identity
ensembleworks auth logout [--url <instance>]

ensembleworks canvas    sticky|shape|frames|read|pull-images
ensembleworks roadmap   list|read|push|ops
ensembleworks transcript read|say
ensembleworks terminal  connect|status

ensembleworks version                         # own build + connected server version
```

- Installed as `ensembleworks` with an `ew` hardlink.
- Connection resolution for every command: flags → env → `hosts.toml`;
  failure says "run `ensembleworks auth login`".
- **Resident agents stay zero-interactive:** `ENSEMBLEWORKS_URL`, `_ROOM`,
  `_TOKEN_ID`, `_TOKEN_SECRET` env vars bypass the config file entirely
  (the `GH_TOKEN` pattern). `deploy.sh` seeds these in agent homes;
  on-box agents hit localhost with method "none".
- Rooms: default room stored per instance at login; `--room` overrides;
  `ENSEMBLEWORKS_ROOM` for agents.
- `terminal connect` absorbs the termgw daemon; connect.sh's `--setup`
  flow is subsumed by `auth login`. `--dry-run` prints resolved config
  without dialling. `--label` defaults to hostname.
- Verb semantics carry over from `bin/canvas` 1:1 under the new
  namespaces; only the spelling changes.

## 2. Architecture & code layout

Two new npm workspaces:

```
contracts/src/
  tools/…               # verb definitions: Zod input schema + HTTP mapping + help text
  terminal-protocol.ts  # the 5-message WS protocol (today: a comment in terminal-gateway.ts)
  session-manager.ts    # tmux-attach via Bun.Terminal — shared by server gateway and CLI connector
  whoami.ts             # identity envelope shared by /api/whoami and auth status
cli/src/
  main.ts               # dispatch: native → manifest groups → PATH extensions → error
  auth/                 # hosts.toml read/write, resolution chain, login/status/logout
  render/               # generic verb renderer: manifest entry → argv parser, --help, validation
  connector/            # relay WS client, backoff/ping — termgw port, protocol-identical
```

- The server validates `/api/*` bodies with the same Zod objects the CLI
  parses flags against. This deliberately starts plugin-architecture
  migration step 1 (extract contracts) rather than waiting for it.
- The connector speaks the Go termgw protocol message-for-message; the
  server relay plane is untouched, so a half-migrated fleet (Go termgw
  still connected while the CLI rolls out) keeps working.
- Server additions: `GET /api/whoami`, `GET /api/tools` (the manifest),
  and an `access-identity.ts` extension mapping CF Access service-token
  client-IDs → bot identities (config file, per §5.4 "start small").

## 3. CLI extensibility — three layers

**Layer 1 — the tool manifest (primary).** `GET /api/tools` serves the
JSON Schema export of every registered tool — the plugin-architecture §5
tool registry landing minimally now. The CLI is a *generic renderer* of
that manifest: verb groups, flags, `--help`, local validation. The verbs
baked into the binary are only an embedded snapshot of the manifest
(offline cache, refreshed from the server into `~/.cache/ensembleworks/`).
Consequences: a new server plugin's tools appear in every installed CLI
with no CLI release; old binaries in long-lived agent tmux shells gain new
verbs; the CLI has no verb knowledge of its own to drift.

**Layer 2 — PATH extensions (gh's model).** An unmatched group
`ensembleworks foo` execs `ensembleworks-foo` from PATH or
`~/.config/ensembleworks/extensions/`, passing the resolved connection via
`ENSEMBLEWORKS_*` env. Process-level, any language — the worker-SPI
philosophy. No install/registry machinery in v1.

**Layer 3 — native commands.** Only `auth` and `terminal connect` are
hardcoded (credential storage and a PTY daemon cannot be data-driven).

No runtime loading of JS plugin code into the compiled binary — mirroring
the plugin architecture's "no dynamic plugin loading" non-goal.

## 4. Auth & attribution

- `hosts.toml` (mode 0600, plaintext — headless boxes have no keychain;
  same posture as connect.sh's env file):

  ```toml
  [instances."https://canvas.example.com"]
  method = "service-token"        # or "none"
  token_id = "…"
  token_secret = "…"
  default_room = "team"
  identity = "🤖 codespace-3"     # cached from last whoami
  ```

- `GET /api/whoami` → `{identity, kind: human|bot|anonymous,
  via: service-token|sso|none}`.
- **Attribution enforced where a credential exists:** writes via a service
  token are stamped with the token's bot identity server-side (`--author`
  ignored or must match). Localhost/"none" instances keep the voluntary
  `--author` convention — no credential to enforce against, inside the
  box's trust boundary.
- Write scoping: per-token `read-only`/`read-write` in the same server
  config map. No per-tool roles (deferred, per plugin §5.4).
- **Closes the termgw spike's accepted risk:** on authenticated instances,
  gateway registration requires a resolvable identity and a gateway id is
  bound to the identity that registered it — replace-on-reconnect only
  succeeds for the same identity. On "none" instances the open behaviour
  remains, documented as a property of no-auth instances.

## 5. Distribution & release

**Release assets** (built by `release-cli.yml`, successor to
`release-termgw.yml`, on `v*` tags; `deploy/release.sh` flow unchanged):

```
ensembleworks-linux-x64        ensembleworks-linux-arm64
ensembleworks-darwin-arm64     ensembleworks-server-linux-x64
ensembleworks-server-linux-arm64
ensembleworks-transcriber-linux-{x64,arm64}   # if the rtc-node spike passes
client-dist.tar.gz             install.sh
ensembleworks-checksums.txt
```

**Remote-box bootstrap:**

```
curl -fsSL https://github.com/lean-software-production/ensembleworks/releases/latest/download/install.sh | bash
ensembleworks auth login
ensembleworks terminal connect --label $(hostname)
```

`install.sh` keeps connect.sh's habits: arch detect, checksum verify,
`ENSEMBLEWORKS_VERSION` pinning, installs to `~/.local/bin/` with the `ew`
hardlink. The devcontainer feature (`termgw-feature`) is repackaged as an
`ensembleworks-cli` feature — same entrypoint/supervisor pattern, exec'ing
`ensembleworks terminal connect`.

**Server deploys are artifact-based.** `deploy.sh` becomes
fetch-verify-swap: download the tag's artifacts into `~/releases/<ver>/`,
verify checksums, swap the `current` symlink, restart units. No `npm ci`,
no build toolchain, no JS runtime on prod hosts. laingville's bootstrap
shrinks. A `--build-from-source` escape hatch covers unpushed branches and
dev boxes.

- Binaries embed sourcemaps (`--sourcemap`) so stack traces stay readable.
- Disk: ~90 MB × services × 3 retained releases ≈ 800 MB. Accepted.
- CI gains a smoke job that **boots the compiled binaries** (not
  source-under-Bun) and exercises `/api/whoami` + a room sync — compiled
  bundles are what ship, so they are what CI tests.
- Rollback strengthens: each release dir is self-contained. Transition
  caveat: pre-artifact releases still need Node on host until they age
  out of the keep-last-3 window.
- Version skew is tolerant by design: the manifest layer means an older
  binary renders newer server verbs; the binary only *must* update when
  native code (auth, connector, renderer) changes. Self-update
  (`ensembleworks upgrade`) deferred.

## 6. Runtime consolidation (Bun-only repo)

| Process | Fate |
|---|---|
| `cli/` | Bun, compiled (this design) |
| `server/` | Runtime → Bun, compiled in CI; adopts the shared session manager; **node-pty leaves the repo**. Spike-gated. |
| `transcriber/` | Spiked under Bun (compiled, with the `.node` addon embedded). Pass → compiled artifact like the rest. Fail → contained Node exception (devcontainer + one prod unit) until the Python rewrite. |
| `client/` | Browser runtime; Vite 7 build driven by Bun (spike line-item). |
| `bin/dev` | Runs under Bun; host requirement becomes bun + docker (`bunx @devcontainers/cli`). |

Node `engines` pins and the npm lockfile are deleted once the last process
migrates (`bun install` + `bun.lock` replace them). Python +
livekit-agents is the transcriber's named future — most mature audio
pipeline (AudioStream PCM, Silero VAD, STT plugins), already sanctioned by
plugin-architecture §2 for ML-heavy workers — triggered by the first
local-Whisper/diarisation feature, as its own spec.

## 7. Migration path

Each step ships independently on `main`.

- **Step 0 — compat spike battery** (~half a day; pty spike already ✅):
  compiled server under Bun (express 5, `ws` upgrade path under sync-core
  traffic, `node:sqlite`, static serving from a bundle), Vite-driven-by-Bun
  build, compiled transcriber with embedded rtc-node addon.
- **Step 1 — `contracts/` + `cli/` land.** Auth, `/api/whoami`,
  `/api/tools` manifest + renderer, canvas verbs as manifest entries. CLI
  ships **alongside** `bin/canvas` (routes unchanged; both work).
- **Step 2 — connector port.** Relay client + shared session manager,
  validated against the existing `relay-loopback.test.ts` harness, then a
  real workshop box. Devcontainer feature repackaged.
  **Retires: `gateway-go/`, `sample-remote-terminal/connect.sh`,
  `release-termgw.yml`.**
- **Step 3 — server artifact cutover.** systemd units exec the compiled
  server binary; `terminal-gateway.ts` adopts the shared session manager;
  node-pty removed; `deploy.sh` switches to fetch-verify-swap. Node stays
  on hosts only until pre-artifact releases age out of rollback range.
- **Step 4 — Node elimination.** Transcriber per spike result; `bun
  install` at the root; `bin/dev` under Bun; engines pins deleted;
  contributor docs say bun + docker.
- **Step 5 — clean-break cutover.** `deploy.sh` seeds `ENSEMBLEWORKS_*`
  env in agent homes; SKILL.md reseeded to teach `ew …`.
  **Deletes: `bin/canvas`.** Accepted disruption: live agent tmux shells
  lose `canvas` at that deploy and learn the new idiom at reseed.

### Compatibility keels

1. No existing `/api/*` route changes shape or path (mid-transition, old
   `bin/canvas` calls from live shells and the new CLI hit the same
   routes).
2. `DATA_DIR` changes stay additive; rollback within the retained-release
   window always works.
3. tmux sessions (`canvas-<id>`) survive every step — naming convention
   and `KillMode=process` untouched; the connector protocol is identical,
   so browser terminals reattach across the Go→Bun connector swap.

## Open questions

- Whether `ew` should be the documented primary spelling (SKILL.md) with
  `ensembleworks` as the formal name, or vice versa.
- musl builds: add `bun-linux-{x64,arm64}-musl` targets only when an
  Alpine-family box appears.
- Manifest cache staleness policy: refresh on every invocation vs TTL vs
  on-miss; start with on-miss + `--refresh` and tune.
- Whether `auth login` should offer to mint/register the service token via
  a canvas-side admin flow (today: paste a pair created in the Cloudflare
  dashboard).
- Step-0 spike outcomes may reorder steps 3–4 (e.g. transcriber exception
  path) without changing the end state.
