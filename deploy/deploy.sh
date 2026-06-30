#!/usr/bin/env bash
# Install/update EnsembleWorks to a tagged version on a server.
#
#   deploy/deploy.sh <ssh-target> <version>
#   e.g. deploy/deploy.sh mrdavidlaing@ew-donkeyred-001-tailnet 0.2.0
#
# Connects as an admin user with passwordless sudo. Builds the release as the app
# user into ~APP_USER/releases/<version> (a git worktree at tag v<version>),
# reusing node_modules via --reflink=auto + skipping npm ci when the lockfile is
# unchanged, then installs prod units + Caddyfile, swaps the `current` symlink,
# restarts, and prunes to KEEP releases. Rollback = re-run with an older version
# (its built dir is still present -> instant symlink swap).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SSH_TARGET="${1:?usage: deploy.sh <ssh-target> <version>}"
VERSION="${2:?usage: deploy.sh <ssh-target> <version>}"
VERSION="${VERSION#v}" # accept 0.2.0 or v0.2.0
TAG="v${VERSION}"
APP_USER="${APP_USER:-ensembleworks}"
REPO_URL="${REPO_URL:-https://github.com/lean-software-production/ensembleworks.git}"
KEEP="${KEEP:-3}"
EDGE_PORT="8080"
# The shared browser (neko) is an OPTIONAL extra service — off by default. Opt in
# per box with SHARED_BROWSER=1; deploy.sh then installs + enables it (needs docker
# and ~APP_USER/.config/ensembleworks/shared-browser.env on the host — both
# provided by the laingville bootstrap, like LiveKit). It is release-independent
# and never restarted on a routine deploy, so a live shared session survives app
# rollouts; restart it by hand to pick up a changed unit.
SHARED_BROWSER="${SHARED_BROWSER:-0}"

# Terminal shells are dropped to this sandbox user (must match TERM_RUN_AS in the
# prod term unit) so canvas terminals can't read the app user's home. When the user
# exists on the box, deploy.sh puts the canvas CLI on its PATH (it can't read the
# 700 app home where bin/canvas lives) and (re)seeds its AGENTS.md/CLAUDE.md
# guidance. The user itself + its NOPASSWD sudoers rule + the launcher are host
# concerns owned by the laingville bootstrap (like the app user and docker).
AGENT_USER="${AGENT_USER:-ensembleworks-agent}"

# Ship the requirements manifest + lib to the box (the box may not have the repo
# yet on a first deploy; the base src clone happens remotely below).
REQ_FILE="deploy/runtime-requirements"
LIB_FILE="deploy/lib.sh"
CADDY_PROD="deploy/Caddyfile.prod"
PROD_UNITS="deploy/systemd/prod" # committed unit templates (@APP_USER@/@APP_HOME@)
for f in "$REQ_FILE" "$LIB_FILE" "$CADDY_PROD" \
	"$PROD_UNITS"/ensembleworks-sync.service \
	"$PROD_UNITS"/ensembleworks-term.service \
	"$PROD_UNITS"/ensembleworks-scribe.service \
	"$PROD_UNITS"/ensembleworks-shared-browser.service \
	"$PROD_UNITS"/ensembleworks-shared-browser.slice \
	deploy/agent-home/AGENTS.md \
	deploy/agent-home/.claude/CLAUDE.md \
	deploy/agent-home/term.env.example \
	deploy/agent-home/term-env.bashrc; do
	[ -f "$f" ] || {
		echo "missing $f — run from the repo root" >&2
		exit 1
	}
done

echo "==> deploying ${TAG} to ${SSH_TARGET} (app user: ${APP_USER})"

# The remote script. Variables are expanded locally where marked (heredoc without
# quotes); $-on-box vars are escaped as \$.
REMOTE="$(
	cat <<REMOTE_EOF
set -euo pipefail
APP_USER='${APP_USER}'
VERSION='${VERSION}'
TAG='${TAG}'
REPO_URL='${REPO_URL}'
KEEP='${KEEP}'
EDGE_PORT='${EDGE_PORT}'
SHARED_BROWSER='${SHARED_BROWSER}'
AGENT_USER='${AGENT_USER}'
APP_HOME="\$(getent passwd "\${APP_USER}" | cut -d: -f6)"
SRC="\${APP_HOME}/src"
RELEASES="\${APP_HOME}/releases"
NEW="\${RELEASES}/\${VERSION}"
asapp() { sudo -u "\${APP_USER}" "\$@"; }

# ---- preflight: validate host deps against the shipped manifest --------------
. /tmp/ew-lib.sh
echo "==> preflight"
problems=""
while read -r name constraint required probe; do
  case "\$name" in ''|\#*) continue;; esac
  found="\$(extract_version "\$(eval "\$probe" 2>/dev/null || true)")"
  if ! msg="\$(check_constraint "\$name" "\$constraint" "\$required" "\$found")"; then
    problems="\${problems}  - \${msg}
"
  fi
done < /tmp/ew-runtime-requirements
if [ -n "\$problems" ]; then
  echo "PREFLIGHT FAILED — host is behind. Re-run the laingville servers/<host>/bootstrap.sh for ${SSH_TARGET}:" >&2
  printf '%s' "\$problems" >&2
  exit 1
fi
id -u "\${APP_USER}" >/dev/null 2>&1 || { echo "app user \${APP_USER} missing" >&2; exit 1; }
systemctl cat ensembleworks.slice >/dev/null 2>&1 || { echo "ensembleworks.slice missing (host envelope) — run bootstrap.sh" >&2; exit 1; }
echo "    preflight ok"

# ---- ensure base clone + fetch tags -----------------------------------------
if ! asapp test -d "\${SRC}/.git"; then
  echo "==> cloning base repo to \${SRC}"
  asapp git clone "\${REPO_URL}" "\${SRC}"
fi
asapp git -C "\${SRC}" fetch --tags --prune origin
asapp git -C "\${SRC}" rev-parse "\${TAG}" >/dev/null 2>&1 || { echo "tag \${TAG} not found" >&2; exit 1; }

# ---- build the release (old release keeps serving) ---------------------------
PREV="\$(asapp readlink -f "\${APP_HOME}/current" 2>/dev/null || true)"
if asapp test -d "\${NEW}" && asapp test -f "\${NEW}/.ew-built"; then
  echo "==> \${VERSION} already built — swapping (rollback path)"
else
  echo "==> creating worktree \${NEW} at \${TAG}"
  asapp mkdir -p "\${RELEASES}"
  asapp git -C "\${SRC}" worktree add --detach "\${NEW}" "\${TAG}"
  if [ -n "\${PREV}" ] && asapp test -d "\${PREV}/node_modules" && asapp cmp -s "\${PREV}/package-lock.json" "\${NEW}/package-lock.json"; then
    echo "==> lockfile unchanged — reusing node_modules (reflink)"
    asapp cp -a --reflink=auto "\${PREV}/node_modules" "\${NEW}/node_modules"
  else
    echo "==> npm ci"
    asapp env PATH="/usr/local/bin:\${PATH}" bash -c "cd '\${NEW}' && npm ci"
  fi
  echo "==> npm run build"
  # Source build.env (e.g. VITE_TLDRAW_LICENSE_KEY) so Vite bakes build-time vars
  # into the client bundle. tldraw enforces its license on real production domains;
  # without VITE_TLDRAW_LICENSE_KEY the editor blanks. Kept off-repo on the box.
  asapp env PATH="/usr/local/bin:\${PATH}" bash -c "set -a; [ -f '\${APP_HOME}/.config/ensembleworks/build.env' ] && . '\${APP_HOME}/.config/ensembleworks/build.env'; set +a; cd '\${NEW}' && npm run build"
  asapp touch "\${NEW}/.ew-built"
fi

# ---- install prod systemd units -----------------------------------------------
# Units are committed templates in deploy/systemd/prod/ (scp'd to /tmp); sed fills
# in @APP_USER@ / @APP_HOME@. Slice membership + per-service MemoryLow are folded
# into each [Service] (the host owns the ensembleworks.slice envelope; these are
# its sub-division, summing <= the envelope MemoryLow). \${CANVAS_URL} in the
# scribe unit stays literal for systemd to expand — sed only touches @TOKENS@.
echo "==> installing prod systemd units"
# Drop stale per-service drop-ins from older deploys (slice/MemoryLow now in-unit).
sudo rm -rf /etc/systemd/system/ensembleworks-sync.service.d /etc/systemd/system/ensembleworks-term.service.d /etc/systemd/system/ensembleworks-scribe.service.d
for u in ensembleworks-sync ensembleworks-term ensembleworks-scribe; do
  sed -e "s|@APP_USER@|\${APP_USER}|g" -e "s|@APP_HOME@|\${APP_HOME}|g" "/tmp/\${u}.service" | sudo tee "/etc/systemd/system/\${u}.service" >/dev/null
done

# ---- install the OPTIONAL shared browser (neko) ------------------------------
# Release-independent (it runs a container, not release code), so it's installed
# only when opted in (SHARED_BROWSER=1) AND docker + its env file are present;
# otherwise the box is left untouched (any already-running instance keeps serving).
# Its own slice (a browser's RSS would dwarf the app envelope) installs alongside.
SHARED_BROWSER_INSTALLED=0
if [ "\$SHARED_BROWSER" = 1 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "    SHARED_BROWSER=1 but docker is missing — skipping (provision it via the laingville bootstrap)" >&2
  elif ! asapp test -f "\${APP_HOME}/.config/ensembleworks/shared-browser.env"; then
    echo "    SHARED_BROWSER=1 but \${APP_HOME}/.config/ensembleworks/shared-browser.env is missing — skipping (copy deploy/shared-browser.env.example there)" >&2
  else
    echo "==> installing shared-browser unit + slice"
    sudo install -m0644 /tmp/ensembleworks-shared-browser.slice /etc/systemd/system/ensembleworks-shared-browser.slice
    sed -e "s|@APP_HOME@|\${APP_HOME}|g" /tmp/ensembleworks-shared-browser.service | sudo tee /etc/systemd/system/ensembleworks-shared-browser.service >/dev/null
    SHARED_BROWSER_INSTALLED=1
  fi
fi

# ---- seed the terminal sandbox user ------------------------------------------
# The prod term unit drops shells to \${AGENT_USER} (TERM_RUN_AS). That user can't
# read the app user's 700 home, so put the canvas CLI on its PATH and (re)seed its
# guidance from the freshly-built release. These are generated docs, not user data,
# so we overwrite on every deploy to track the canvas CLI version. The user itself
# + sudoers + launcher are host-provisioned (laingville); if it's absent we skip
# and the gateway fails closed (no terminals) until the host catches up.
if id -u "\${AGENT_USER}" >/dev/null 2>&1; then
  echo "==> seeding \${AGENT_USER} sandbox (canvas CLI + agent guidance)"
  AGENT_HOME="\$(getent passwd "\${AGENT_USER}" | cut -d: -f6)"
  sudo install -m0755 "\${NEW}/bin/canvas" /usr/local/bin/canvas
  # Box-wide tmux conf the sandbox user CAN read (it can't read the app's 700 home
  # where deploy/tmux-ensembleworks.conf ships). The host-provisioned launcher
  # (/usr/local/bin/ensembleworks-term-launch) execs \`tmux -f /etc/ensembleworks/tmux.conf\`.
  sudo install -D -m0644 "\${NEW}/deploy/tmux-ensembleworks.conf" /etc/ensembleworks/tmux.conf
  if asapp test -d "\${NEW}/deploy/agent-home"; then
    sudo install -d -o "\${AGENT_USER}" -m0755 "\${AGENT_HOME}/.claude"
    sudo install -o "\${AGENT_USER}" -m0644 "\${NEW}/deploy/agent-home/AGENTS.md" "\${AGENT_HOME}/AGENTS.md"
    sudo install -o "\${AGENT_USER}" -m0644 "\${NEW}/deploy/agent-home/.claude/CLAUDE.md" "\${AGENT_HOME}/.claude/CLAUDE.md"
  fi
  # Tool env for canvas shells (OPENCODE_API_KEY, …): mirror the legacy app-user
  # term.env mechanism for the sandbox user — a 600 env file it owns, sourced by its
  # ~/.bashrc under set -a. Secret VALUES are operator-filled + off-repo; we only
  # provision the placeholder (create-only, never clobbering a filled-in key) and the
  # idempotent ~/.bashrc sourcing stanza (never clobbering the skel .bashrc).
  if ! sudo -u "\${AGENT_USER}" test -f "\${AGENT_HOME}/.config/ensembleworks/term.env"; then
    sudo install -d -o "\${AGENT_USER}" -m0700 "\${AGENT_HOME}/.config" "\${AGENT_HOME}/.config/ensembleworks"
    sudo install -o "\${AGENT_USER}" -m0600 "\${NEW}/deploy/agent-home/term.env.example" "\${AGENT_HOME}/.config/ensembleworks/term.env"
    echo "    seeded \${AGENT_HOME}/.config/ensembleworks/term.env (fill in OPENCODE_API_KEY)"
  fi
  if ! sudo -u "\${AGENT_USER}" grep -q __ew_term_env_file "\${AGENT_HOME}/.bashrc" 2>/dev/null; then
    sudo cat "\${NEW}/deploy/agent-home/term-env.bashrc" | sudo -u "\${AGENT_USER}" tee -a "\${AGENT_HOME}/.bashrc" >/dev/null
  fi
else
  echo "    sandbox user \${AGENT_USER} not present — skipping canvas CLI + agent-home seed"
  echo "    (provision it via the laingville bootstrap; the term gateway fails closed until then)" >&2
fi

# ---- install prod Caddyfile --------------------------------------------------
sudo install -m0644 /tmp/ew-Caddyfile.prod /etc/caddy/Caddyfile

# ---- swap current -> new, reload --------------------------------------------
echo "==> swapping current -> \${VERSION}"
asapp ln -sfn "\${NEW}" "\${APP_HOME}/current"
sudo systemctl daemon-reload
sudo systemctl enable ensembleworks-sync ensembleworks-term >/dev/null 2>&1 || true
sudo systemctl restart ensembleworks-sync ensembleworks-term
sudo systemctl is-active --quiet ensembleworks-scribe && sudo systemctl restart ensembleworks-scribe || true
# Shared browser: enable + start it if installed, but DON'T restart a running one
# (a restart drops the live shared session). To pick up a changed unit, restart by
# hand: sudo systemctl restart ensembleworks-shared-browser.
if [ "\${SHARED_BROWSER_INSTALLED}" = 1 ]; then
  sudo systemctl enable ensembleworks-shared-browser >/dev/null 2>&1 || true
  sudo systemctl is-active --quiet ensembleworks-shared-browser || sudo systemctl start ensembleworks-shared-browser
fi
sudo systemctl reload-or-restart caddy

# ---- prune old releases (keep newest \$KEEP, never the live one) -------------
echo "==> pruning releases (keep \${KEEP})"
live="\${NEW}"   # we just pointed current -> NEW; no need to re-resolve it
# shellcheck disable=SC2012
asapp bash -c "ls -1dt '\${RELEASES}'/*/ 2>/dev/null | tail -n +\$((KEEP+1)) | while read -r d; do d=\"\\\${d%/}\"; [ \"\\\$d\" = '\${live}' ] && continue; git -C '\${SRC}' worktree remove --force \"\\\$d\" 2>/dev/null || rm -rf \"\\\$d\"; done"
asapp git -C "\${SRC}" worktree prune

# ---- verify ------------------------------------------------------------------
echo "==> deployed: \$(asapp git -C "\${NEW}" describe --tags --always)"
# Poll for readiness — the sync server (tsx + esbuild cold start) takes a few
# seconds to bind :8788, so a fixed sleep would report a false 502 on success.
code=000
for _ in \$(seq 1 30); do
  code="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:\${EDGE_PORT}/" || true)"
  [ "\$code" = "200" ] && break
  sleep 1
done
echo "==> edge http://localhost:\${EDGE_PORT}/ -> \${code}"
[ "\$code" = "200" ] || echo "    (warning: edge not 200 after 30s — check 'systemctl status ensembleworks-sync')"
REMOTE_EOF
)"

# Copy the small support files + the prod unit templates, then run the remote
# script. The units land at /tmp/ensembleworks-*.service (the remote sed loop reads
# /tmp/${u}.service); ${CANVAS_URL} inside them stays literal for systemd.
scp -q "$LIB_FILE" "${SSH_TARGET}:/tmp/ew-lib.sh"
scp -q "$REQ_FILE" "${SSH_TARGET}:/tmp/ew-runtime-requirements"
scp -q "$CADDY_PROD" "${SSH_TARGET}:/tmp/ew-Caddyfile.prod"
scp -q "$PROD_UNITS"/*.service "${SSH_TARGET}:/tmp/"
# The shared-browser .slice ships alongside (the *.service glob already grabbed its
# unit); the remote installs both only when SHARED_BROWSER=1.
scp -q "$PROD_UNITS"/ensembleworks-shared-browser.slice "${SSH_TARGET}:/tmp/"
ssh "$SSH_TARGET" "bash -s" <<<"$REMOTE"

echo "==> done."
