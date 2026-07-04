# Sample Remote-Terminal Codespace — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorm) — ready for implementation plan

## Goal

A tiny public sample repo under the `ensembleworks-dev` GitHub org that, when
opened in GitHub Codespaces, lets you run **one script** to register that cloud
machine as a remote terminal tile on an EnsembleWorks canvas. Also serves as a
lightweight cloud dev box: the container ships common coding tools (opencode,
pi, neovim, Node, ripgrep, git-delta, tmux).

Primary use case: **internal demo / dogfooding** of the remote-terminal path
against a public canvas. Convenience over hardening; the operator supplies their
own credentials.

## Non-goals

- No auto-start daemon (the existing `termgw` devcontainer feature's
  entrypoint/supervisor model is deliberately **not** used here).
- No Go toolchain or compiled artifacts committed to the sample repo — the
  connector is a versioned download.
- No Tailscale / private-network path — the canvas is reached at a public URL.
- Not a hardened multi-tenant workshop tool. Credentials are the operator's.

## Key decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Audience | Internal demo / dogfooding |
| Connect trigger | **Manual** — `./connect.sh` in the Codespace terminal |
| Binary source | Prebuilt `termgw` downloaded from a **public** GitHub Release |
| Config / secrets | **Interactive prompt** in `connect.sh`, cached to git-ignored `.termgw.env` |
| Target canvas | **Public** canvas behind Cloudflare Access (service token) |
| Binary hosting | Main repo's public release assets (repo is public; moving under `ensembleworks-dev`) |
| Dev tools | opencode, pi, neovim, Node, ripgrep, git-delta, tmux — **baked into the Dockerfile** |

## Architecture

```
GitHub Codespace (ensembleworks-dev/sample-remote-terminal)
  ├─ .devcontainer/Dockerfile  → base:ubuntu + tmux, neovim, Node,
  │                               ripgrep, git-delta, opencode, pi
  └─ connect.sh                → 1. resolve config (prompt / .termgw.env)
                                 2. download termgw (public release, arch-matched)
                                 3. exec termgw  ── wss ──▶  Cloudflare Access
                                                              ▶ canvas /api/gateway/connect
```

`termgw` (the existing Go connector, unchanged) dials
`CANVAS_URL + /api/gateway/connect` as an outbound WebSocket, sending
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers to pass Cloudflare
Access. Connecting **is** registering: the gateway then appears in the canvas
New-terminal picker (server-wide, via `/api/gateway/list`) under its label, and
browsers open tmux-backed sessions on it over the relay. The relay auto-reconnects
with jittered exponential backoff; tmux sessions survive disconnects.

## Repo layout

```
.devcontainer/
  devcontainer.json      # build.dockerfile: Dockerfile; friendly connect hint
  Dockerfile             # FROM base:ubuntu → dev tools
connect.sh               # THE single script
tmux.conf                # shipped so the connector is self-contained
.gitignore               # .termgw.env, bin/
README.md                # "Open in Codespaces → run ./connect.sh"
```

### `.devcontainer/Dockerfile`

- `FROM mcr.microsoft.com/devcontainers/base:ubuntu`
- Install via apt: `tmux`, `neovim`, `ripgrep`, `git-delta` (git-delta may need a
  `.deb` from its release if not in the distro repo — fall back to that).
- Node via the devcontainer Node feature **or** apt/nodesource — Node also
  provides the npm fallback install path for opencode (`opencode-ai`) and pi
  (`@earendil-works/pi-coding-agent`).
- opencode: `OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash`
- pi: `curl -fsSL https://pi.dev/install.sh | sh`
- Tools land in image layers → fast Codespace prebuild/attach, no per-create work.
- Agent API keys / logins are **not** provisioned here — runtime concern of the
  operator (`pi` `/login`, `ANTHROPIC_API_KEY`, etc.).

### `.devcontainer/devcontainer.json`

- `build.dockerfile: ./Dockerfile`
- No features/entrypoint from the old `termgw-feature`. Container boots idle.
- An `onCreateCommand` / attach message: *"Run `./connect.sh` to join a canvas."*

### `connect.sh` — the single script

Bash, `set -euo pipefail`, `shellcheck`-clean. A single overridable
`RELEASE_REPO="lean-software-production/ensembleworks"` variable near the top
(env override `RELEASE_REPO=...`) so the pending org move under
`ensembleworks-dev` — or a fork — is a one-line change. Steps:

1. **Resolve config.** Precedence: existing env vars → git-ignored
   `.termgw.env` → interactive prompt. Required: `CANVAS_URL`,
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. `GATEWAY_LABEL` defaults to
   `$CODESPACE_NAME` (then hostname). After prompting, offer to save answers to
   `.termgw.env` (git-ignored) for zero-touch re-runs.
2. **Download `termgw`.** Detect arch (`uname -m`: `x86_64→amd64`,
   `aarch64→arm64`). Fetch
   `https://github.com/$RELEASE_REPO/releases/download/$TERMGW_VERSION/termgw-linux-<arch>`
   into `bin/termgw-<version>`, `chmod +x`. `TERMGW_VERSION` is a pinned default
   in the script (env-overridable). Skip download if the cached binary exists.
   Fetch `termgw-checksums.txt` and verify sha256; refuse to run on mismatch.
3. **Run.** `export` config + `TMUX_CONF="$PWD/tmux.conf"`, then
   `exec bin/termgw-<version>`. Foreground; Ctrl-C stops. termgw logs
   "connected … as <label>" on success.
4. **`--dry-run`.** Performs steps 1–2 and prints the resolved config
   (secrets redacted) + the exact download URL + target binary, then exits
   without `exec`. This is the unit-testable path.

## Release pipeline (change in the main repo)

A GitHub Actions workflow triggered when a `v*` release is **published**:

- Set up Go 1.24; build `./gateway-go` for `linux/amd64` and `linux/arm64`.
- Produce `termgw-linux-amd64`, `termgw-linux-arm64`, `termgw-checksums.txt`
  (sha256 of both binaries).
- Attach all three to the release as public assets.

No change to the Go connector source. The main repo is public, so
`connect.sh` downloads assets directly — no mirror repo, no token. `RELEASE_REPO`
defaults to the current `lean-software-production/ensembleworks`; when the repo
moves under `ensembleworks-dev`, update that one line (or set the env override)
and the assets follow automatically.

## Error handling

| Condition | Behavior |
|---|---|
| Missing required config | Prompt (interactive) or fail with the missing var named |
| Download 404 | Report arch, version, and the exact URL tried |
| Checksum mismatch | Refuse to run; delete the bad download |
| CF Access 403 at connect | termgw logs it; connect.sh preamble hints "check the token pair" |
| Connection dropped | termgw relay auto-reconnects (jittered backoff, tmux survives) |
| `tmux` missing | Shouldn't happen (baked in); connect.sh checks and errors with a hint |

## Testing

- **`connect.sh`** — `shellcheck` clean; a bash test drives `--dry-run` and
  asserts config resolution, arch detection, and download-URL construction. The
  only part with real logic.
- **Dockerfile** — CI job builds the image and asserts each tool
  (`tmux`, `nvim`, `node`, `rg`, `delta`, `opencode`, `pi`) is on `PATH` and
  reports a version. `termgw` is **not** in the image (runtime download) — not
  checked here.
- **Release workflow** — validated once by cutting a test tag: confirm the three
  assets appear, are publicly downloadable, and the binary runs. Mostly manual.
- **End-to-end** — README demo checklist: open Codespace → `./connect.sh` → tile
  appears in the New-terminal picker → open a session → run `nvim`/`opencode`.
  Codespaces + CF Access are not meaningfully automatable; this is a manual
  acceptance step.

## Open items / future

- git-delta apt availability varies by Ubuntu release; if absent, install from
  its GitHub `.deb`.
- Codespaces arch is amd64 by default (arm64 on some plans) — both are shipped.
- If the main repo were ever made private, `connect.sh` would need a token or a
  public mirror; not a concern while it stays public.
