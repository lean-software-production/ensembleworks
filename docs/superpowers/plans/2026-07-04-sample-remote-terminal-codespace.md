# Sample Remote-Terminal Codespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small public sample repo that, opened in GitHub Codespaces, lets you run one script (`connect.sh`) to register that Codespace as a remote terminal tile on an EnsembleWorks canvas — plus the main-repo CI change that publishes the `termgw` binaries the script downloads.

**Architecture:** The sample repo is a *launcher*, not a build. A `.devcontainer/Dockerfile` bakes dev tools (tmux, neovim, Node, ripgrep, git-delta, opencode, pi) into the image. `connect.sh` resolves config (env → git-ignored `.termgw.env` → interactive prompt), downloads the prebuilt `termgw` connector from a public GitHub Release, verifies its checksum, and `exec`s it against the canvas behind Cloudflare Access. A new GitHub Actions workflow in the **main** repo builds and attaches those binaries on each release.

**Tech Stack:** Bash, Docker (devcontainer `base:ubuntu`), GitHub Actions, the existing Go `termgw` connector (unchanged).

**Spec:** `docs/superpowers/specs/2026-07-04-sample-remote-terminal-codespace-design.md`

## Global Constraints

- **Staging location:** author all sample-repo files under `sample-remote-terminal/` in *this* repo; the main-repo CI file goes in `.github/workflows/`. Task 6 publishes `sample-remote-terminal/`'s contents to the new `ensembleworks-dev/sample-remote-terminal` repo.
- **Manual connect only** — no auto-start daemon, no reuse of the old `termgw-feature` entrypoint/supervisor.
- **No Go toolchain and no compiled artifacts** committed to the sample repo — `termgw` is a runtime download.
- **Public download, no token** — `connect.sh` fetches release assets over plain HTTPS.
- `RELEASE_REPO` default = `lean-software-production/ensembleworks`, overridable by env.
- **Arch map:** `x86_64` → `amd64`, `aarch64` → `arm64`; anything else is a hard error.
- **Release assets, exact names:** `termgw-linux-amd64`, `termgw-linux-arm64`, `termgw-checksums.txt`.
- **Baked dev tools (exact set):** `tmux`, `neovim`, Node, `ripgrep`, `git-delta`, `opencode`, `pi`.
- **Go 1.24** for the connector build.
- **Secrets:** `CF_ACCESS_CLIENT_SECRET` must never be printed in cleartext (dry-run redacts to `***`); `.termgw.env` is git-ignored and written with `umask 077`.

---

### Task 1: `connect.sh` — the single connect script + tests

**Files:**
- Create: `sample-remote-terminal/connect.sh`
- Test: `sample-remote-terminal/test/connect_test.sh`

**Interfaces:**
- Consumes: nothing from other tasks. Reads a runtime `./tmux.conf` (created in Task 4) only on the real (non-dry-run) path.
- Produces: the connector's runtime env contract — `CANVAS_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `GATEWAY_LABEL`, `TMUX_CONF` exported before `exec`. Overridable knobs: `RELEASE_REPO`, `TERMGW_VERSION` (a tag like `v0.9.0` or the sentinel `latest`), `BIN_DIR`, `ENV_FILE`, `UNAME_M`. Sourcing the script defines the functions `detect_arch`, `asset_url`, `verify_sha256`, `resolve_config`, `download_termgw`, `main` without running `main` (guarded by `BASH_SOURCE`).

- [ ] **Step 1: Write the failing test**

Create `sample-remote-terminal/test/connect_test.sh`:

```bash
#!/usr/bin/env bash
# Offline tests for connect.sh: exercises --dry-run (config resolution, arch
# detection, URL construction, secret redaction) and the sourced verify_sha256
# helper. No network, no TTY, no termgw exec.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONNECT="$HERE/../connect.sh"
fail=0
contains() { case "$2" in *"$3"*) echo "ok   - $1";; *) echo "FAIL - $1: [$2] missing [$3]"; fail=1;; esac; }
absent()   { case "$2" in *"$3"*) echo "FAIL - $1: leaked [$3]"; fail=1;; *) echo "ok   - $1";; esac; }

# --- dry-run: amd64, pinned version ---
out=$(UNAME_M=x86_64 CANVAS_URL=https://canvas.example CF_ACCESS_CLIENT_ID=cfid \
      CF_ACCESS_CLIENT_SECRET=S3CR3T-XYZ GATEWAY_LABEL=demo \
      TERMGW_VERSION=v1.2.3 RELEASE_REPO=o/r ENV_FILE=/nonexistent BIN_DIR=/tmp/b \
      bash "$CONNECT" --dry-run </dev/null)
contains "amd64 arch line"      "$out" "arch: amd64"
contains "amd64 pinned url"     "$out" "https://github.com/o/r/releases/download/v1.2.3/termgw-linux-amd64"
contains "label passthrough"    "$out" "label: demo"
contains "secret redacted"      "$out" "cf-secret: ***"
absent   "secret not leaked"    "$out" "S3CR3T-XYZ"

# --- dry-run: arm64, latest version ---
out=$(UNAME_M=aarch64 CANVAS_URL=https://c CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
      TERMGW_VERSION=latest RELEASE_REPO=o/r ENV_FILE=/nonexistent BIN_DIR=/tmp/b \
      bash "$CONNECT" --dry-run </dev/null)
contains "arm64 arch line"  "$out" "arch: arm64"
contains "latest url"       "$out" "https://github.com/o/r/releases/latest/download/termgw-linux-arm64"

# --- unsupported arch errors ---
if UNAME_M=mips64 CANVAS_URL=x CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
   ENV_FILE=/nonexistent bash "$CONNECT" --dry-run </dev/null >/dev/null 2>&1; then
  echo "FAIL - unsupported arch should exit non-zero"; fail=1
else echo "ok   - unsupported arch errors"; fi

# --- label defaults to CODESPACE_NAME when unset ---
out=$(UNAME_M=x86_64 CANVAS_URL=x CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
      CODESPACE_NAME=my-space TERMGW_VERSION=latest RELEASE_REPO=o/r \
      ENV_FILE=/nonexistent BIN_DIR=/tmp/b bash "$CONNECT" --dry-run </dev/null)
contains "label default from CODESPACE_NAME" "$out" "label: my-space"

# --- verify_sha256 helper (sourced) ---
# Sourcing re-applies connect.sh's `set -e`; disable it again so a failed
# assertion below reports instead of aborting the test. The BASH_SOURCE guard
# keeps main() from running on source.
source "$CONNECT"
set +e
tmpf=$(mktemp); printf 'hello' > "$tmpf"
want=$(printf 'hello' | sha256sum | awk '{print $1}')
if verify_sha256 "$tmpf" "$want"; then echo "ok   - sha256 match"; else echo "FAIL - sha256 match"; fail=1; fi
if verify_sha256 "$tmpf" "deadbeef"; then echo "FAIL - sha256 mismatch not caught"; fail=1; else echo "ok   - sha256 mismatch"; fi
rm -f "$tmpf"

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash sample-remote-terminal/test/connect_test.sh`
Expected: FAIL — `connect.sh` does not exist yet (`bash: .../connect.sh: No such file or directory`).

- [ ] **Step 3: Write `connect.sh`**

Create `sample-remote-terminal/connect.sh`:

```bash
#!/usr/bin/env bash
# connect.sh — register this Codespace as a remote terminal on an EnsembleWorks
# canvas. Downloads the prebuilt termgw connector from a public GitHub release,
# verifies its checksum, then runs it against the canvas behind Cloudflare Access.
set -euo pipefail

# --- overridable configuration -------------------------------------------------
RELEASE_REPO="${RELEASE_REPO:-lean-software-production/ensembleworks}"
TERMGW_VERSION="${TERMGW_VERSION:-latest}"   # a release tag (e.g. v0.9.0) or "latest"
BIN_DIR="${BIN_DIR:-./bin}"
ENV_FILE="${ENV_FILE:-./.termgw.env}"
UNAME_M="${UNAME_M:-$(uname -m)}"            # test seam

die() { echo "connect.sh: $*" >&2; exit 1; }

detect_arch() {
  case "$UNAME_M" in
    x86_64|amd64)  echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported architecture: $UNAME_M (need x86_64 or aarch64)" ;;
  esac
}

# asset_url NAME → full download URL for the pinned tag or the latest release.
asset_url() {
  local name="$1"
  if [ "$TERMGW_VERSION" = latest ]; then
    echo "https://github.com/$RELEASE_REPO/releases/latest/download/$name"
  else
    echo "https://github.com/$RELEASE_REPO/releases/download/$TERMGW_VERSION/$name"
  fi
}

# verify_sha256 FILE EXPECTED_HEX → exit 0 on match, 1 otherwise.
verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

# prompt_var VAR "text" [silent] — prompt only if VAR unset and stdin is a TTY.
prompt_var() {
  local var="$1" text="$2" silent="${3:-}" val
  [ -n "${!var:-}" ] && return 0
  [ -t 0 ] || die "$var is unset and no TTY to prompt (set it via env or $ENV_FILE)"
  if [ "$silent" = silent ]; then read -rsp "$text: " val; echo; else read -rp "$text: " val; fi
  printf -v "$var" '%s' "$val"
}

write_env_file() {
  umask 077
  { echo "# saved by connect.sh — git-ignored"
    printf 'CANVAS_URL=%q\n' "$CANVAS_URL"
    printf 'CF_ACCESS_CLIENT_ID=%q\n' "$CF_ACCESS_CLIENT_ID"
    printf 'CF_ACCESS_CLIENT_SECRET=%q\n' "$CF_ACCESS_CLIENT_SECRET"
    printf 'GATEWAY_LABEL=%q\n' "$GATEWAY_LABEL"
  } > "$ENV_FILE"
  echo "wrote $ENV_FILE"
}

resolve_config() {
  [ -f "$ENV_FILE" ] && . "$ENV_FILE"
  prompt_var CANVAS_URL "Canvas URL (https://…)"
  prompt_var CF_ACCESS_CLIENT_ID "CF Access Client ID"
  prompt_var CF_ACCESS_CLIENT_SECRET "CF Access Client Secret" silent
  GATEWAY_LABEL="${GATEWAY_LABEL:-${CODESPACE_NAME:-$(hostname)}}"
  if [ ! -f "$ENV_FILE" ] && [ -t 0 ]; then
    local ans; read -rp "Save these to $ENV_FILE for next time? [y/N] " ans
    case "${ans:-}" in y|Y) write_env_file ;; esac
  fi
}

download_termgw() {
  local arch bin url sums_url tmp sums expected
  arch="$(detect_arch)"
  bin="$BIN_DIR/termgw-$TERMGW_VERSION-$arch"
  [ -x "$bin" ] && { echo "$bin"; return 0; }
  mkdir -p "$BIN_DIR"
  url="$(asset_url "termgw-linux-$arch")"
  sums_url="$(asset_url termgw-checksums.txt)"
  tmp="$(mktemp)"; sums="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"       || { rm -f "$tmp" "$sums"; die "download failed (404?) for $url"; }
  curl -fsSL "$sums_url" -o "$sums" || { rm -f "$tmp" "$sums"; die "checksums download failed for $sums_url"; }
  expected="$(awk -v f="termgw-linux-$arch" '$2==f || $2=="*"f {print $1}' "$sums")"
  [ -n "$expected" ] || { rm -f "$tmp" "$sums"; die "no checksum for termgw-linux-$arch in $sums_url"; }
  verify_sha256 "$tmp" "$expected" || { rm -f "$tmp" "$sums"; die "checksum mismatch for $url — refusing to run"; }
  chmod +x "$tmp"; mv "$tmp" "$bin"; rm -f "$sums"
  echo "$bin"
}

main() {
  local dry=0
  [ "${1:-}" = --dry-run ] && dry=1
  resolve_config
  local arch url
  arch="$(detect_arch)"
  url="$(asset_url "termgw-linux-$arch")"
  if [ "$dry" -eq 1 ]; then
    printf 'canvas: %s\n' "$CANVAS_URL"
    printf 'label: %s\n' "$GATEWAY_LABEL"
    printf 'cf-id: %s\n' "$CF_ACCESS_CLIENT_ID"
    printf 'cf-secret: ***\n'
    printf 'arch: %s\n' "$arch"
    printf 'download: %s\n' "$url"
    printf 'would run: %s\n' "$BIN_DIR/termgw-$TERMGW_VERSION-$arch"
    return 0
  fi
  command -v tmux >/dev/null || die "tmux not found on PATH (the devcontainer image should provide it)"
  local bin; bin="$(download_termgw)"
  echo "starting termgw as '$GATEWAY_LABEL' → $CANVAS_URL (Ctrl-C to stop)"
  echo "  (a 403 here means the CF Access service-token pair is wrong or lacks a policy)"
  export CANVAS_URL CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET GATEWAY_LABEL
  export TMUX_CONF="$PWD/tmux.conf"
  exec "$bin"
}

# Run main only when executed, not when sourced (so tests can call helpers).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash sample-remote-terminal/test/connect_test.sh`
Expected: every line `ok - …`, final line `PASS`, exit 0.

- [ ] **Step 5: Lint with shellcheck**

Run: `shellcheck sample-remote-terminal/connect.sh sample-remote-terminal/test/connect_test.sh`
Expected: no output (clean). If shellcheck flags the indirect expansion in `prompt_var`, add a scoped `# shellcheck disable=SC2059` **only** on the offending `printf -v` line with a one-line justification; do not blanket-disable.

- [ ] **Step 6: Commit**

```bash
git add sample-remote-terminal/connect.sh sample-remote-terminal/test/connect_test.sh
git commit -m "feat(sample): connect.sh with offline dry-run tests"
```

---

### Task 2: `.devcontainer/Dockerfile` — baked dev tools + smoke test

**Files:**
- Create: `sample-remote-terminal/.devcontainer/Dockerfile`
- Test: `sample-remote-terminal/test/dockerfile_smoke.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: an image whose `PATH` carries `tmux`, `nvim`, `node`, `rg`, `delta`, `opencode`, `pi` for the default `vscode` user. Referenced by name `Dockerfile` from Task 3's `devcontainer.json`.

- [ ] **Step 1: Write the failing smoke test**

Create `sample-remote-terminal/test/dockerfile_smoke.sh`:

```bash
#!/usr/bin/env bash
# Builds the devcontainer image and asserts each baked tool is on PATH.
# Requires a local Docker daemon. Slow (image build): a few minutes cold.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG=sample-remote-terminal-test
docker build -t "$IMG" "$HERE/../.devcontainer"
run() { echo "== $1"; docker run --rm "$IMG" bash -lc "$1"; }
run 'tmux -V'
run 'nvim --version | head -1'
run 'node --version'
run 'rg --version | head -1'
run 'delta --version'
run 'command -v opencode'
run 'command -v pi'
echo "ALL TOOLS PRESENT"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash sample-remote-terminal/test/dockerfile_smoke.sh`
Expected: FAIL — `docker build` errors because `.devcontainer/Dockerfile` does not exist yet.

- [ ] **Step 3: Write the Dockerfile**

Create `sample-remote-terminal/.devcontainer/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu

# Terminal + editor + search tools from the Ubuntu repos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux neovim ripgrep ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# git-delta ships as a .deb per release (not always in the distro repo).
# Bump DELTA_VERSION if the download 404s (the smoke test will catch it).
ARG DELTA_VERSION=0.18.2
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /tmp/delta.deb \
      "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/git-delta_${DELTA_VERSION}_${arch}.deb" \
 && dpkg -i /tmp/delta.deb \
 && rm -f /tmp/delta.deb

# Node 22 via NodeSource — also the global-install path for the agents below,
# which lands their bins on PATH for every user (more reliable than the
# per-user curl installers in a shared image).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# opencode + pi coding agents, installed globally.
RUN npm install -g opencode-ai @earendil-works/pi-coding-agent
```

- [ ] **Step 4: Verify the git-delta asset exists before a long build**

Run: `curl -fsSI "https://github.com/dandavison/delta/releases/download/0.18.2/git-delta_0.18.2_amd64.deb" | head -1`
Expected: `HTTP/2 200` (or a `302` to the asset). If `404`, find the current version with `gh release view --repo dandavison/delta --json tagName -q .tagName` and update the `DELTA_VERSION` ARG.

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `bash sample-remote-terminal/test/dockerfile_smoke.sh`
Expected: each `== …` block prints a version / path, final line `ALL TOOLS PRESENT`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add sample-remote-terminal/.devcontainer/Dockerfile sample-remote-terminal/test/dockerfile_smoke.sh
git commit -m "feat(sample): devcontainer Dockerfile with baked dev tools"
```

---

### Task 3: `devcontainer.json` + `.gitignore` + validation test

**Files:**
- Create: `sample-remote-terminal/.devcontainer/devcontainer.json`
- Create: `sample-remote-terminal/.gitignore`
- Test: `sample-remote-terminal/test/devcontainer_test.sh`

**Interfaces:**
- Consumes: the `Dockerfile` from Task 2 (by relative name). References `connect.sh` from Task 1 (chmod on create).
- Produces: a Codespace that builds from the Dockerfile, boots idle, and prints the connect hint.

- [ ] **Step 1: Write the failing test**

Create `sample-remote-terminal/test/devcontainer_test.sh`:

```bash
#!/usr/bin/env bash
# Validates devcontainer.json and .gitignore without launching a container.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
fail=0
ok() { echo "ok   - $1"; }
no() { echo "FAIL - $1"; fail=1; }

# devcontainer.json parses as JSON and points at the Dockerfile.
df=$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.build&&c.build.dockerfile))' \
      "$ROOT/.devcontainer/devcontainer.json" 2>/dev/null)
[ "$df" = "Dockerfile" ] && ok "build.dockerfile == Dockerfile" || no "build.dockerfile (got: $df)"

# A hint mentioning connect.sh is present somewhere in the config.
grep -q 'connect.sh' "$ROOT/.devcontainer/devcontainer.json" && ok "connect.sh hint present" || no "connect.sh hint missing"

# .gitignore excludes the secret cache and the downloaded binary.
grep -qx '/.termgw.env' "$ROOT/.gitignore" && ok ".gitignore has /.termgw.env" || no ".gitignore missing /.termgw.env"
grep -qx '/bin/'        "$ROOT/.gitignore" && ok ".gitignore has /bin/"        || no ".gitignore missing /bin/"

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash sample-remote-terminal/test/devcontainer_test.sh`
Expected: FAIL lines for the missing files, `SOME TESTS FAILED`.

- [ ] **Step 3: Write `devcontainer.json`**

Create `sample-remote-terminal/.devcontainer/devcontainer.json`:

```json
{
  "name": "sample-remote-terminal",
  "build": { "dockerfile": "Dockerfile" },
  "remoteUser": "vscode",
  "postCreateCommand": "chmod +x connect.sh",
  "postAttachCommand": {
    "hint": "echo 'Ready. Run ./connect.sh to join an EnsembleWorks canvas.'"
  }
}
```

- [ ] **Step 4: Write `.gitignore`**

Create `sample-remote-terminal/.gitignore`:

```gitignore
/.termgw.env
/bin/
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash sample-remote-terminal/test/devcontainer_test.sh`
Expected: all `ok - …`, final `PASS`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add sample-remote-terminal/.devcontainer/devcontainer.json sample-remote-terminal/.gitignore sample-remote-terminal/test/devcontainer_test.sh
git commit -m "feat(sample): devcontainer.json + gitignore"
```

---

### Task 4: `tmux.conf` + `README.md`

**Files:**
- Create: `sample-remote-terminal/tmux.conf` (copied from `deploy/tmux-ensembleworks.conf`)
- Create: `sample-remote-terminal/README.md`
- Test: `sample-remote-terminal/test/docs_test.sh`

**Interfaces:**
- Consumes: `connect.sh`'s runtime contract (Task 1) — the README documents it; `connect.sh` sets `TMUX_CONF="$PWD/tmux.conf"` at runtime.
- Produces: a self-contained tmux config and the user-facing docs.

- [ ] **Step 1: Write the failing test**

Create `sample-remote-terminal/test/docs_test.sh`:

```bash
#!/usr/bin/env bash
# tmux.conf parses, and README documents the connect flow.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
fail=0
ok() { echo "ok   - $1"; }
no() { echo "FAIL - $1"; fail=1; }

# tmux can load the config without error (isolated server + socket).
if tmux -L smpltest -f "$ROOT/tmux.conf" start-server \; kill-server 2>/tmp/tmuxerr; then
  ok "tmux.conf loads"
else
  no "tmux.conf failed to load: $(cat /tmp/tmuxerr)"
fi

# README covers the essentials.
for needle in "Codespaces" "./connect.sh" "CANVAS_URL" "Cloudflare Access"; do
  grep -qi "$needle" "$ROOT/README.md" && ok "README mentions $needle" || no "README missing $needle"
done

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash sample-remote-terminal/test/docs_test.sh`
Expected: FAIL — `tmux.conf` and `README.md` do not exist.

- [ ] **Step 3: Copy the tmux config**

Run:
```bash
cp deploy/tmux-ensembleworks.conf sample-remote-terminal/tmux.conf
```
This is the same config the production terminal gateway ships, so remote sessions match the canvas terminals. Do not hand-edit it.

- [ ] **Step 4: Write `README.md`**

Create `sample-remote-terminal/README.md`:

```markdown
# Sample Remote Terminal (EnsembleWorks)

Open this repo in **GitHub Codespaces**, run one script, and this cloud machine
appears as a terminal tile on an EnsembleWorks canvas. The container also ships
handy dev tools (tmux, neovim, Node, ripgrep, git-delta, opencode, pi).

## Use it

1. **Code → Create codespace on main.** Wait for the container to build.
2. In the Codespace terminal, run:
   ```bash
   ./connect.sh
   ```
3. It prompts for:
   - `CANVAS_URL` — the canvas base URL, e.g. `https://canvas.example.com`
   - `CF Access Client ID` / `Secret` — a Cloudflare Access **service token**
     pair that lets this machine through the canvas's Cloudflare Access boundary
   - (label defaults to the Codespace name)

   Answer once and optionally save to a git-ignored `.termgw.env` so re-runs are
   zero-touch.
4. The connector registers with the canvas. Open the canvas, add a terminal from
   the New-terminal picker, and choose this gateway by its label. `Ctrl-C` in the
   Codespace stops it.

## How it works

`connect.sh` downloads the prebuilt `termgw` connector from a public GitHub
release (`RELEASE_REPO`, default `lean-software-production/ensembleworks`),
verifies its SHA-256, and runs it. `termgw` dials the canvas over an outbound
WebSocket through Cloudflare Access and serves tmux-backed sessions. Nothing is
compiled here — the sample repo is just a launcher.

## Overrides

| Env var | Default | Purpose |
|---|---|---|
| `RELEASE_REPO` | `lean-software-production/ensembleworks` | Where to download `termgw` from |
| `TERMGW_VERSION` | `latest` | Release tag to pin, or `latest` |
| `GATEWAY_LABEL` | Codespace name | Label shown in the New-terminal picker |

Preview the resolved config and download URL without connecting:
```bash
./connect.sh --dry-run
```

## Agent tools

`opencode` and `pi` are preinstalled but need your own provider/API key at
runtime (`pi` `/login`, or `ANTHROPIC_API_KEY` etc.). This repo does not manage
those credentials.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash sample-remote-terminal/test/docs_test.sh`
Expected: all `ok - …`, final `PASS`, exit 0. (Requires `tmux` installed on the machine running the test.)

- [ ] **Step 6: Commit**

```bash
git add sample-remote-terminal/tmux.conf sample-remote-terminal/README.md sample-remote-terminal/test/docs_test.sh
git commit -m "feat(sample): tmux.conf + README"
```

---

### Task 5: Release workflow — publish termgw binaries (main repo)

**Files:**
- Create: `.github/workflows/release-termgw.yml`

**Interfaces:**
- Consumes: the Go connector at `gateway-go/` (module `github.com/lean-software-production/ensembleworks/gateway-go`, `go 1.24.13`), unchanged.
- Produces: release assets `termgw-linux-amd64`, `termgw-linux-arm64`, `termgw-checksums.txt` on every published release — the exact names `connect.sh` (Task 1) downloads.

- [ ] **Step 1: Prove both target arches compile (this is the test)**

Run:
```bash
cd gateway-go && for arch in amd64 arm64; do \
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -o "/tmp/termgw-linux-$arch" . \
  && echo "built $arch: $(du -h /tmp/termgw-linux-$arch | cut -f1)"; done; cd ..
```
Expected: two `built amd64: …` / `built arm64: …` lines, no compile errors. This is exactly the build the workflow runs; if it passes locally it passes in CI.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/release-termgw.yml`:

```yaml
name: release-termgw
on:
  release:
    types: [published]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.24'

      - name: Build termgw (amd64 + arm64)
        working-directory: gateway-go
        run: |
          set -euo pipefail
          for arch in amd64 arm64; do
            CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
              go build -trimpath -o "../termgw-linux-$arch" .
          done

      - name: Checksums
        run: sha256sum termgw-linux-amd64 termgw-linux-arm64 > termgw-checksums.txt

      - name: Attach binaries to the release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            termgw-linux-amd64
            termgw-linux-arm64
            termgw-checksums.txt
```

- [ ] **Step 3: Validate the workflow YAML parses**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-termgw.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 4: Confirm the checksum format matches `connect.sh`'s parser**

`sha256sum termgw-linux-amd64` emits `<hash>  termgw-linux-amd64` (filename in field 2). `connect.sh`'s `download_termgw` matches on `$2==f`. Verify with the local build from Step 1:
```bash
cd /tmp && sha256sum termgw-linux-amd64 | awk -v f=termgw-linux-amd64 '$2==f{print "match:",$1}'; cd - >/dev/null
```
Expected: a `match: <hash>` line (non-empty), proving the parser and producer agree.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-termgw.yml
git commit -m "ci: publish termgw linux binaries on release"
```

---

### Task 6: Publish the sample repo (ops handoff — requires user authorization)

**Files:** none created in this repo; publishes `sample-remote-terminal/`'s contents to the new GitHub repo.

> **Gate:** creating a public GitHub repo and pushing to it is an outward-facing action. Do **not** run these steps autonomously — confirm with the user first (repo name, org access, `gh auth` identity). The prior tasks are fully testable without this one.

**Interfaces:**
- Consumes: all files under `sample-remote-terminal/` (Tasks 1–4).
- Produces: `github.com/ensembleworks-dev/sample-remote-terminal` with those files at its root.

- [ ] **Step 1: Confirm auth and target with the user**

Run: `gh auth status`
Confirm the authenticated account can create repos in `ensembleworks-dev`, and confirm the repo name `sample-remote-terminal` with the user.

- [ ] **Step 2: Stage the contents into a clean tree**

```bash
rm -rf /tmp/sample-remote-terminal && cp -r sample-remote-terminal /tmp/sample-remote-terminal
cd /tmp/sample-remote-terminal && git init -q && git add . && git commit -q -m "initial import: sample remote terminal"
```

- [ ] **Step 3: Create the repo and push**

```bash
gh repo create ensembleworks-dev/sample-remote-terminal \
  --public --source /tmp/sample-remote-terminal --remote origin --push \
  --description "Open in Codespaces, run ./connect.sh to join an EnsembleWorks canvas as a remote terminal"
```

- [ ] **Step 4: Verify the published tree**

```bash
gh repo view ensembleworks-dev/sample-remote-terminal --json name,visibility,url
gh api repos/ensembleworks-dev/sample-remote-terminal/contents --jq '.[].name'
```
Expected: repo is `public`; contents list includes `connect.sh`, `tmux.conf`, `README.md`, `.devcontainer`, `.gitignore`.

- [ ] **Step 5: End-to-end acceptance (manual, documented)**

Record the result in the PR/notes; do not automate:
1. Open the new repo in Codespaces; wait for the build.
2. Run `./connect.sh`; supply `CANVAS_URL` + a CF Access service-token pair for a live canvas.
3. On the canvas, add a terminal and pick this gateway by label.
4. In the session, confirm `nvim` and `opencode` launch.

---

## Notes on staging vs. final home

`sample-remote-terminal/` lives in this repo only to author and test the files with real tooling (docker, tmux, shellcheck) before Task 6 pushes them to the standalone repo. Whether to keep or `git rm` the staging directory from this repo after publishing is the user's call — leave it until they decide. The `.github/workflows/release-termgw.yml` file is **not** staging; it belongs to this (the main) repo permanently.
