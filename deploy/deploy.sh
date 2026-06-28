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

# Ship the requirements manifest + lib to the box (the box may not have the repo
# yet on a first deploy; the base src clone happens remotely below).
REQ_FILE="deploy/runtime-requirements"
LIB_FILE="deploy/lib.sh"
CADDY_PROD="deploy/Caddyfile.prod"
for f in "$REQ_FILE" "$LIB_FILE" "$CADDY_PROD"; do
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
  echo "PREFLIGHT FAILED — host is behind. Update & re-run servers/ew-donkeyred-001/bootstrap.sh:" >&2
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
  asapp env PATH="/usr/local/bin:\${PATH}" bash -c "cd '\${NEW}' && npm run build"
  asapp touch "\${NEW}/.ew-built"
fi

# ---- install prod systemd units (app sub-division; envelope is host-owned) ---
echo "==> installing prod systemd units"
write_unit() { sudo tee "/etc/systemd/system/\$1" >/dev/null; }
write_dropin() { sudo install -d "/etc/systemd/system/\$1.d"; sudo tee "/etc/systemd/system/\$1.d/10-memory.conf" >/dev/null; }

write_unit ensembleworks-sync.service <<UNIT
[Unit]
Description=EnsembleWorks sync server (tldraw sync + assets + API)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=\${APP_USER}
WorkingDirectory=\${APP_HOME}/current/server
Environment=PORT=8788
Environment=DATA_DIR=\${APP_HOME}/.local/share/ensembleworks
Environment=CLIENT_DIST=\${APP_HOME}/current/client/dist
EnvironmentFile=\${APP_HOME}/.config/ensembleworks/sync.env
ExecStart=/usr/local/bin/npm run start
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

write_unit ensembleworks-term.service <<UNIT
[Unit]
Description=EnsembleWorks terminal gateway (node-pty + tmux)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=\${APP_USER}
WorkingDirectory=\${APP_HOME}/current/server
Environment=PORT=8789
Environment=TMUX_CONF=\${APP_HOME}/current/deploy/tmux-ensembleworks.conf
ExecStart=/usr/local/bin/npm run start:term
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

write_unit ensembleworks-scribe.service <<UNIT
[Unit]
Description=EnsembleWorks transcriber (LiveKit -> Groq Whisper -> /api/transcript)
After=network-online.target ensembleworks-sync.service
Wants=network-online.target
[Service]
Type=simple
User=\${APP_USER}
WorkingDirectory=\${APP_HOME}/current/transcriber
Environment=CANVAS_URL=http://localhost:8788
Environment=CANVAS_ROOM=team
Environment=STT_URL=https://api.groq.com/openai/v1
Environment=STT_MODEL=whisper-large-v3-turbo
Environment=STT_LANGUAGE=en
EnvironmentFile=\${APP_HOME}/.config/ensembleworks/scribe.env
ExecStartPre=/bin/sh -c 'until curl -s -o /dev/null --connect-timeout 2 "\\\${CANVAS_URL}/"; do sleep 1; done'
ExecStart=/usr/local/bin/npm run start
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

# Per-service MemoryLow sub-division (must sum <= host slice MemoryLow). term
# carries none (the elastic "rest"). No client unit in prod.
printf '[Service]\nSlice=ensembleworks.slice\nMemoryAccounting=yes\nMemoryLow=512M\n' | write_dropin ensembleworks-sync.service
printf '[Service]\nSlice=ensembleworks.slice\nMemoryAccounting=yes\n'                | write_dropin ensembleworks-term.service
printf '[Service]\nSlice=ensembleworks.slice\nMemoryAccounting=yes\nMemoryLow=256M\n' | write_dropin ensembleworks-scribe.service

# ---- install prod Caddyfile --------------------------------------------------
sudo install -m0644 /tmp/ew-Caddyfile.prod /etc/caddy/Caddyfile

# ---- swap current -> new, reload --------------------------------------------
echo "==> swapping current -> \${VERSION}"
asapp ln -sfn "\${NEW}" "\${APP_HOME}/current"
sudo systemctl daemon-reload
sudo systemctl enable ensembleworks-sync ensembleworks-term >/dev/null 2>&1 || true
sudo systemctl restart ensembleworks-sync ensembleworks-term
sudo systemctl is-active --quiet ensembleworks-scribe && sudo systemctl restart ensembleworks-scribe || true
sudo systemctl reload-or-restart caddy

# ---- prune old releases (keep newest \$KEEP, never the live one) -------------
echo "==> pruning releases (keep \${KEEP})"
live="\$(asapp readlink -f "\${APP_HOME}/current")"
# shellcheck disable=SC2012
asapp bash -c "ls -1dt '\${RELEASES}'/*/ 2>/dev/null | tail -n +\$((KEEP+1)) | while read -r d; do d=\"\\\${d%/}\"; [ \"\\\$d\" = '\${live}' ] && continue; git -C '\${SRC}' worktree remove --force \"\\\$d\" 2>/dev/null || rm -rf \"\\\$d\"; done"
asapp git -C "\${SRC}" worktree prune

# ---- verify ------------------------------------------------------------------
echo "==> deployed: \$(asapp git -C "\${NEW}" describe --tags --always)"
sleep 2
code="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:\${EDGE_PORT}/" || true)"
echo "==> edge http://localhost:\${EDGE_PORT}/ -> \${code}"
REMOTE_EOF
)"

# Copy the small support files, then run the remote script.
scp -q "$LIB_FILE" "${SSH_TARGET}:/tmp/ew-lib.sh"
scp -q "$REQ_FILE" "${SSH_TARGET}:/tmp/ew-runtime-requirements"
scp -q "$CADDY_PROD" "${SSH_TARGET}:/tmp/ew-Caddyfile.prod"
ssh "$SSH_TARGET" "bash -s" <<<"$REMOTE"

echo "==> done."
