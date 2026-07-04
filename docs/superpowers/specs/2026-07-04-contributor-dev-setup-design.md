# Contributor dev setup — design

**Date:** 2026-07-04
**Status:** approved

## Goal

A third-party contributor — most likely driving development through a coding
agent like Claude Code — clones the repo, opens the devcontainer, and has a
fully working local EnsembleWorks (canvas, terminals, voice, transcription)
with zero accounts or keys. The same tooling replaces the host-specific
`~/Work/ensembleworks-devserver` launcher (which is retired) and fixes the
release-time clash where `release.sh`'s `npm ci` wipes `node_modules` under
the running dev services.

Out of scope: the shared browser (neko) inside the devcontainer — it needs
docker-in-docker. It remains available on native hosts (gated on docker, as
today).

## Components

### 1. `bin/dev` — dependency-free Node CLI, tmux engine

A plain-JS Node script (`#!/usr/bin/env node`, `node:` builtins only,
`// @ts-check` + JSDoc so `npm run typecheck` covers it). No `node_modules`
imports, so it runs on a fresh clone before `npm ci`.

**Service table as data** — the core of the script, a plain array unit-tested
like the rest of the repo:

| window | command | gated on | health |
|---|---|---|---|
| sync | `npm run dev --workspace=server` | always | `GET :8788/api/health` |
| term | `npm run dev:term --workspace=server` | always | port 8789 |
| client | `npm run dev --workspace=client` | always | port 5173 |
| caddy | `caddy run --config deploy/Caddyfile` | caddy on PATH | port 8080 |
| livekit | `livekit-server --dev` (config file overrides when present) | binary present | port 7880 |
| scribe | `npm run dev --workspace=transcriber` | livekit up AND (`STT_URL` or `STT_API_KEY`) | — |
| shared-browser | neko container (as in the old devserver) | docker present, `SHARED_BROWSER_ENABLE!=0` | — |

**Subcommands:**

- `up [--attach] [--no-install]` — idempotent. Fresh start: `npm ci`, create
  the tmux session, one window per enabled service, wait for health checks,
  print a cheat-sheet (window list, tmux keys, URLs). Already running:
  re-source the tmux config and report.
- `down` — kill the session.
- `restart <svc>` — respawn one window without touching the others.
- `status [--json]` — per service: enabled/disabled (and why), up/down,
  port, health. `--json` is the agent interface.
- `logs <svc> [--tail N]` — scrollback via `tmux capture-pane`, to stdout.
- `attach` — human entry into the tmux session.
- `doctor` — executable prerequisites: Node version vs `.nvmrc`, node-pty
  loads (ABI check), tmux/caddy/livekit-server/docker presence, ports free,
  `.local/` git-ignored. Every failing check prints its remedy. Exit code
  reflects readiness.

**Preserved from the retired devserver script:**

- The `hold()` shell wrapper (SIGINT `trap ":" INT` + drop-to-shell with
  scrollback on crash) — kept verbatim as a string constant, war-story
  comment attached. It runs *inside* tmux windows, so it stays shell.
- `npm ci` on fresh start; `DATA_DIR=~/.local/share/ensembleworks`;
  sourcing `~/.config/ensembleworks/dev.env` (`set -a` semantics) when
  present; `ENSEMBLEWORKS_PUBLIC_HOST` override for tailnet/tunnel setups;
  the scribe's wait-for-sync-and-SFU startup gate.
- Node-version handling becomes enforce-not-provide: check
  `process.version` against `.nvmrc`; on mismatch, re-exec via mise/nvm if
  one is on PATH (soft dependency), otherwise fail with the exact remedy.
  No repo-level mise config; `.nvmrc` is the single source of truth.

LiveKit in dev uses the OSS server's dev-mode keys (no account); when
enabled, sync gets the loopback `LIVEKIT_API_URL` and the browser-facing
`LIVEKIT_URL` exactly as the old script wired it.

### 2. Devcontainer — Debian 13 (trixie), the blessed path

Repo-root `.devcontainer/` with a Dockerfile based on `debian:trixie`,
matching the production/dogfood OS:

- Node pinned by **reading `.nvmrc` at image build** — one place to bump.
  Check `deploy/runtime-requirements` agrees.
- tmux, caddy, git, gh, build essentials for node-pty.
- `livekit-server` binary (OSS SFU).
- A local OpenAI-compatible Whisper server + small multilingual model baked
  into the image, so transcription works keyless. The exact server
  (whisper.cpp's server vs speaches) is an implementation-time choice; the
  contract is only `STT_URL` → `POST /v1/audio/transcriptions`.
- `postCreateCommand`: create the `.local/` backing dirs + symlinks (below),
  then `npm ci`.
- `postStartCommand`: `bin/dev up --no-attach`.
- Port 8080 forwarded (Caddy = the app); WebRTC UDP mapped for local
  devcontainers. **Documented caveat:** voice/video does not traverse
  Codespaces port-forwarding (TCP-only) — canvas + terminals + everything
  else still works there.

### 3. State & config — home-dir interface, repo-local backing store

The home-dir paths stay the single convention on every platform (they match
the Debian boxes and all existing docs):

- `~/.local/share/ensembleworks` — DATA_DIR (canvas SQLite, uploads,
  transcripts)
- `~/.config/ensembleworks` — `dev.env`, optional `livekit-dev.yaml`

In the devcontainer, postCreate makes them symlinks into a git-ignored
workspace folder, so state and keys survive container rebuilds and are
inspectable from the host:

```
<repo>/.local/
├── share/ensembleworks/   ← ~/.local/share/ensembleworks
└── config/ensembleworks/  ← ~/.config/ensembleworks
```

Symlinks-in-postCreate rather than `mounts:` in devcontainer.json because
`${localWorkspaceFolder}` bind mounts don't work in Codespaces; the workspace
folder is what both environments already persist. Native hosts are untouched
(real dirs in `$HOME`, no migration).

Safety and hygiene:

- `.gitignore` gets `.local/`; `bin/dev doctor` verifies the ignore rule is
  intact (keys live under the repo tree in the devcontainer).
- Watchers must not see `.local/`: tsx watches only its module graph and
  Vite watches `client/`, so it should be quiet by construction, but the
  implementation must explicitly exclude `.local/` from any watcher that
  takes an ignore list and verify canvas writes don't trigger restarts.
- `rm -rf .local` is a documented factory reset.

### 4. `release.sh` — validate in an isolated worktree

The `npm ci && npm run typecheck && npm run build` gate moves into a
throwaway `git worktree` (e.g. under `/tmp`), created from the validated
commit and removed afterward. The live checkout's `node_modules` is never
touched, so cutting a release while `bin/dev` runs becomes a non-event.
Adds a Node-version preflight against `.nvmrc`. The `npm version` bump,
commit, and tag still run in the real checkout (a small commit is harmless
to watchers).

### 5. Docs — agent-first

- **README "Development"** rewritten around two paths: devcontainer (open
  it, done) and native (`bin/dev doctor` tells you what's missing). This
  makes the README's existing devcontainer claim true.
- **AGENTS.md / CLAUDE.md**: a "Local dev" section stating the `bin/dev`
  contract, what works keyless, where data lives, and how to run the smoke
  tests — written for an agent to follow literally.
- **CONTRIBUTING.md** (new, short): devcontainer as the path, smoke tests as
  the verification bar, AGPL licensing basics.
- Prerequisites live in `doctor`, not prose — executable documentation.

### 6. Retirement

`~/Work/ensembleworks-devserver` is deleted once `bin/dev` reaches parity.
On baljeet: keep `ENSEMBLEWORKS_PUBLIC_HOST=baljeet.cyprus-macaroni.ts.net`
(and any keys) in `~/.config/ensembleworks/dev.env`, run `bin/dev up`.
Existing `~/.local/share/ensembleworks` data keeps working unchanged. The
memory/dev-notes that reference the old script get updated.

## Error handling

- `doctor` is the diagnostic surface: every check failure names the check,
  the observed state, and the remedy command.
- `up` fails loudly if a health check times out, pointing at
  `bin/dev logs <svc>`.
- A crashed service leaves its tmux window alive (exit code + scrollback +
  shell) via the `hold()` wrapper; `logs` retrieves it, `restart` respawns
  it.
- The gateway/node-pty ABI mismatch (wrong Node) is caught by `doctor`
  before it manifests as a cryptic runtime failure.

## Testing

- Unit tests for the service-table gating logic (which services enable under
  which env/binary conditions) and the `.nvmrc` version comparison — run
  with `npx tsx` like the repo's other tests.
- `doctor` doubles as the environment smoke test; the existing
  `smoke-client.ts` / `smoke-terminal.ts` / API tests are the end-to-end
  verification bar, reachable as soon as `up` reports healthy.
- Manual verification for the devcontainer: build it, `bin/dev status --json`
  all-healthy, run the smoke tests, rebuild the container, confirm canvas
  state and `dev.env` survived.
