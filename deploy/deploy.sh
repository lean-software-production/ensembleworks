#!/usr/bin/env bash
# Install/update EnsembleWorks to a tagged version on a server (fetch-verify-swap).
#
#   deploy/deploy.sh <ssh-target> <version> [--dry-run]
#   e.g. deploy/deploy.sh mrdavidlaing@ew-donkeyred-001-tailnet 0.11.0
#
# Downloads the tag's CI-compiled binaries (ensembleworks, ensembleworks-server,
# ensembleworks-transcriber) + client-dist.tar.gz from the GitHub release into
# ~APP_USER/releases/<version>, verifies checksums, runs a hermetic pre-swap
# boot-check of the fetched server + transcriber, stamps the posture-era marker,
# installs prod units + Caddyfile, swaps the `current` symlink, restarts, and
# prunes to KEEP releases. Rollback = re-run with an older version (its fetched
# dir is still present -> instant symlink swap) — WITHIN a posture era.
#
# Flags / env:
#   --dry-run             local verify half only (no box): fetch to a scratch dir,
#                         checksum, ew_boot_check, print the swap plan. No ssh/swap.
#   DEPLOY_FETCH_DIR=dir  read release assets from a local dir instead of curl (tests/dry-run).
#   EW_ALLOW_ERA_CROSS=1  permit the one sanctioned cross-era swap (cutover.sh sets it).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SSH_TARGET="${1:?usage: deploy.sh <ssh-target> <version> [--dry-run]}"
VERSION="${2:?usage: deploy.sh <ssh-target> <version> [--dry-run]}"
VERSION="${VERSION#v}" # accept 0.2.0 or v0.2.0
TAG="v${VERSION}"
DRY_RUN=0; [ "${3:-}" = "--dry-run" ] && DRY_RUN=1
APP_USER="${APP_USER:-ensembleworks}"
REPO_SLUG="${REPO_SLUG:-lean-software-production/ensembleworks}"
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
# exists on the box, deploy.sh puts the ensembleworks CLI on its PATH (it can't read
# the 700 app home) and (re)seeds its AGENTS.md/CLAUDE.md guidance. The user itself
# + its NOPASSWD sudoers rule + the launcher are host concerns owned by the
# laingville bootstrap (like the app user and docker).
AGENT_USER="${AGENT_USER:-ensembleworks-agent}"

# ---- --dry-run: the local verify half (no box, no licence key — spec §10.2) ---
# Sources lib.sh, fetches into a scratch release dir, verifies checksums, runs the
# real ew_boot_check against the fetched server + transcriber (launcher prefix "" =
# current user, no sudo), stamps .ew-era, prints the resolved swap plan, exits.
# Never scps, sshs, swaps, or restarts. Does NOT validate the client bundle — no
# tldraw licence key exists off-CI (spec §4.3), so client-dist is machinery-only.
if [ "$DRY_RUN" = 1 ]; then
	# shellcheck disable=SC1091 # relative path, resolved via `cd` to repo root above
	. deploy/lib.sh
	scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
	NEW="${scratch}/${VERSION}"
	echo "==> [dry-run] fetching v${VERSION} into ${NEW}"
	ew_fetch_release "${VERSION}" "${NEW}" "${REPO_SLUG}" ""
	cp deploy/posture-era "${NEW}/.ew-era"
	echo "==> [dry-run] boot-check"
	# shellcheck disable=SC2015 # C is a bare `exit 1` after echo — B (echo) never fails
	ew_boot_check "${NEW}" "" && echo "    boot-check OK" || { echo "    boot-check FAILED" >&2; exit 1; }
	echo "==> [dry-run] swap plan:"
	echo "    release dir : ~${APP_USER}/releases/${VERSION}"
	echo "    new era     : $(cat "${NEW}/.ew-era")"
	echo "    units       : ensembleworks-sync ensembleworks-term ensembleworks-files (+ scribe/discord if enabled)"
	echo "    keep        : ${KEEP} newest (prune walks releases/ only; backups/ exempt)"
	echo "==> [dry-run] done (no box touched)."
	exit 0
fi

# Ship the requirements manifest + lib + the re-homed support files to the box.
REQ_FILE="deploy/runtime-requirements"
LIB_FILE="deploy/lib.sh"
CADDY_PROD="deploy/Caddyfile.prod"
PROD_UNITS="deploy/systemd/prod" # committed unit templates (@APP_USER@/@APP_HOME@)
for f in "$REQ_FILE" "$LIB_FILE" "$CADDY_PROD" \
	"$PROD_UNITS"/ensembleworks-sync.service \
	"$PROD_UNITS"/ensembleworks-term.service \
	"$PROD_UNITS"/ensembleworks-files.service \
	"$PROD_UNITS"/ensembleworks-scribe.service \
	"$PROD_UNITS"/ensembleworks-discord.service \
	"$PROD_UNITS"/ensembleworks-shared-browser.service \
	"$PROD_UNITS"/ensembleworks-shared-browser.slice \
	deploy/posture-era \
	deploy/tmux-ensembleworks.conf \
	deploy/ensembleworks-gh-token \
	bin/gh-app-token.bash \
	deploy/agent-home/AGENTS.md \
	deploy/agent-home/.claude/CLAUDE.md \
	deploy/agent-home/.claude/skills/publish-doc/SKILL.md \
	deploy/agent-home/term.env.example \
	deploy/agent-home/term-env.bashrc \
	deploy/agent-home/gh-helper.bashrc; do
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
REPO_SLUG='${REPO_SLUG}'
KEEP='${KEEP}'
EDGE_PORT='${EDGE_PORT}'
SHARED_BROWSER='${SHARED_BROWSER}'
EW_ALLOW_ERA_CROSS='${EW_ALLOW_ERA_CROSS:-0}'
AGENT_USER='${AGENT_USER}'
APP_HOME="\$(getent passwd "\${APP_USER}" | cut -d: -f6)"
RELEASES="\${APP_HOME}/releases"
NEW="\${RELEASES}/\${VERSION}"
RUN="sudo -u \${APP_USER}"
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
# Terminal sandbox host deps (laingville-provisioned). The prod term unit always sets
# TERM_RUN_AS, so these are required for terminals to work at all — fail fast here with
# a clear pointer rather than letting the gateway fail closed after a "green" deploy.
id -u "\${AGENT_USER}" >/dev/null 2>&1 || { echo "sandbox user \${AGENT_USER} missing — run the laingville bootstrap (terminals run as it; TERM_RUN_AS is set in the prod term unit)" >&2; exit 1; }
test -x /usr/local/bin/ensembleworks-term-launch || { echo "/usr/local/bin/ensembleworks-term-launch missing/not executable — host-provisioned by the laingville bootstrap" >&2; exit 1; }
sudo -u "\${APP_USER}" sudo -n -u "\${AGENT_USER}" true 2>/dev/null || { echo "sudo grant missing: \${APP_USER} -> \${AGENT_USER} (NOPASSWD ensembleworks-term-launch + /usr/bin/true) — run the laingville bootstrap" >&2; exit 1; }
# GitHub App token minting is OPTIONAL — warn but don't block.
sudo test -f "\${APP_HOME}/.config/ensembleworks/github-app.env" 2>/dev/null || echo "    note: \${APP_HOME}/.config/ensembleworks/github-app.env absent — GitHub token minting not provisioned (optional; deploy/github-app-runbook.md)" >&2
echo "    preflight ok"

# ---- fetch the tag's artifacts into \${NEW} -----------------------------------
# Was: git worktree + npm ci + npm run build. Now: public curl fetch + checksum
# verify + client-dist extract (ew_fetch_release). .ew-verified marks a release dir
# that already passed fetch+boot-check, so a rollback re-swap skips re-fetching.
PREV="\$(asapp readlink -f "\${APP_HOME}/current" 2>/dev/null || true)"
if asapp test -f "\${NEW}/.ew-verified"; then
  echo "==> \${VERSION} already fetched+verified — swapping (rollback path)"
else
  echo "==> fetching v\${VERSION} artifacts"
  ew_fetch_release "\${VERSION}" "\${NEW}" "\${REPO_SLUG}" "\${RUN}"
  # stamp the posture-era marker BEFORE the swap (spec §6.2/§9).
  asapp cp /tmp/ew-posture-era "\${NEW}/.ew-era"
  # ---- pre-swap boot-check (spec §6.3) — refuse the swap if it fails ----------
  echo "==> boot-check v\${VERSION}"
  if ! ew_boot_check "\${NEW}" "\${RUN}"; then
    echo "==> refusing to swap: boot-check failed on v\${VERSION}" >&2; exit 1
  fi
  asapp touch "\${NEW}/.ew-verified"
fi

# ---- install prod systemd units -----------------------------------------------
# Units are committed templates in deploy/systemd/prod/ (scp'd to /tmp); sed fills
# in @APP_USER@ / @APP_HOME@. Slice membership + per-service MemoryLow are folded
# into each [Service] (the host owns the ensembleworks.slice envelope; these are
# its sub-division, summing <= the envelope MemoryLow). \${ENSEMBLEWORKS_URL} in the
# scribe unit stays literal for systemd to expand — sed only touches @TOKENS@.
echo "==> installing prod systemd units"
# Drop stale per-service drop-ins from older deploys (slice/MemoryLow now in-unit).
sudo rm -rf /etc/systemd/system/ensembleworks-sync.service.d /etc/systemd/system/ensembleworks-term.service.d /etc/systemd/system/ensembleworks-files.service.d /etc/systemd/system/ensembleworks-scribe.service.d /etc/systemd/system/ensembleworks-discord.service.d
for u in ensembleworks-sync ensembleworks-term ensembleworks-files ensembleworks-scribe ensembleworks-discord; do
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
# The artifact release dir carries NO worktree, so every file the old deploy.sh
# installed from \${NEW}/bin or \${NEW}/deploy is re-homed: the canvas CLI is now the
# ensembleworks ARTIFACT in \${NEW}; the rest ride from this operator checkout as
# /tmp/ew-* (scp'd below). Install targets/modes/owners + marker-gated appends are
# unchanged (spec §6.4). Generated docs, so overwrite on every deploy.
if id -u "\${AGENT_USER}" >/dev/null 2>&1; then
  echo "==> seeding \${AGENT_USER} sandbox (ensembleworks CLI + agent guidance)"
  AGENT_HOME="\$(getent passwd "\${AGENT_USER}" | cut -d: -f6)"
  sudo install -m0755 "\${NEW}/ensembleworks" /usr/local/bin/ensembleworks
  sudo ln -f /usr/local/bin/ensembleworks /usr/local/bin/ew
  sudo -u "\${AGENT_USER}" /usr/local/bin/ensembleworks version >/dev/null 2>&1 || \
    echo "    warn: installed CLI failed 'version' self-check" >&2
  # ensembleworks-files.service runs the compiled server binary AS \${AGENT_USER}
  # for its whole lifetime (it serves that user's $HOME — see the unit's header
  # comment), so it can't exec \${NEW}/ensembleworks-server in place: that path
  # lives under \${APP_HOME}, 700 to \${APP_USER}. A world-readable copy at this
  # fixed path (same mechanism as the CLI install above) is what the unit execs.
  sudo install -m0755 "\${NEW}/ensembleworks-server" /usr/local/bin/ensembleworks-server
  # GitHub App token minting for the sandbox user WITHOUT exposing the App key: the
  # PEM + github-app.env stay in the app user's 700 ~/.config (unreadable to the
  # sandbox user); the agent runs the narrow ensembleworks-gh-token wrapper as the
  # app user via a host-provided NOPASSWD sudoers rule, so only the ~1h token crosses
  # the boundary. See deploy/github-app-runbook.md.
  sudo install -m0755 /tmp/ew-gh-app-token.bash /usr/local/bin/gh-app-token.bash
  sudo install -m0755 /tmp/ew-ensembleworks-gh-token /usr/local/bin/ensembleworks-gh-token
  # Box-wide tmux conf the sandbox user CAN read (it can't read the app's 700 home
  # where deploy/tmux-ensembleworks.conf ships). The host-provisioned launcher
  # (/usr/local/bin/ensembleworks-term-launch) execs \`tmux -f /etc/ensembleworks/tmux.conf\`.
  sudo install -D -m0644 /tmp/ew-tmux.conf /etc/ensembleworks/tmux.conf
  if [ -d /tmp/ew-agent-home ]; then
    sudo install -d -o "\${AGENT_USER}" -m0755 "\${AGENT_HOME}/.claude"
    sudo install -o "\${AGENT_USER}" -m0644 /tmp/ew-agent-home/AGENTS.md "\${AGENT_HOME}/AGENTS.md"
    sudo install -o "\${AGENT_USER}" -m0644 /tmp/ew-agent-home/.claude/CLAUDE.md "\${AGENT_HOME}/.claude/CLAUDE.md"
    # publish-doc: the file-viewer's adoption surface (spec §6) — every agent in
    # every repo on the box picks this up via the same user-level skills dir.
    sudo install -d -o "\${AGENT_USER}" -m0755 "\${AGENT_HOME}/.claude/skills/publish-doc"
    sudo install -o "\${AGENT_USER}" -m0644 /tmp/ew-agent-home/.claude/skills/publish-doc/SKILL.md \
      "\${AGENT_HOME}/.claude/skills/publish-doc/SKILL.md"
  fi
  # Tool env for canvas shells (OPENCODE_API_KEY, …): mirror the legacy app-user
  # term.env mechanism for the sandbox user — a 600 env file it owns, sourced by its
  # ~/.bashrc under set -a. Secret VALUES are operator-filled + off-repo; we only
  # provision the placeholder (create-only, never clobbering a filled-in key) and the
  # idempotent ~/.bashrc sourcing stanza (never clobbering the skel .bashrc).
  if ! sudo -u "\${AGENT_USER}" test -f "\${AGENT_HOME}/.config/ensembleworks/term.env"; then
    sudo install -d -o "\${AGENT_USER}" -m0700 "\${AGENT_HOME}/.config" "\${AGENT_HOME}/.config/ensembleworks"
    sudo install -o "\${AGENT_USER}" -m0600 /tmp/ew-agent-home/term.env.example "\${AGENT_HOME}/.config/ensembleworks/term.env"
    echo "    seeded \${AGENT_HOME}/.config/ensembleworks/term.env (fill in OPENCODE_API_KEY)"
  fi
  if ! sudo -u "\${AGENT_USER}" grep -q __ew_term_env_file "\${AGENT_HOME}/.bashrc" 2>/dev/null; then
    sudo cat /tmp/ew-agent-home/term-env.bashrc | sudo -u "\${AGENT_USER}" tee -a "\${AGENT_HOME}/.bashrc" >/dev/null
  fi
  # gh wrapper (separate marker, so boxes that already have the term.env stanza still
  # pick this up on a later deploy).
  if ! sudo -u "\${AGENT_USER}" grep -q __ew_gh_helper "\${AGENT_HOME}/.bashrc" 2>/dev/null; then
    sudo cat /tmp/ew-agent-home/gh-helper.bashrc | sudo -u "\${AGENT_USER}" tee -a "\${AGENT_HOME}/.bashrc" >/dev/null
  fi
else
  echo "    sandbox user \${AGENT_USER} not present — skipping CLI + agent-home seed"
  echo "    (provision it via the laingville bootstrap; the term gateway fails closed until then)" >&2
fi

# ---- install prod Caddyfile --------------------------------------------------
sudo install -m0644 /tmp/ew-Caddyfile.prod /etc/caddy/Caddyfile

# ---- era gate + swap current -> new, reload ----------------------------------
# Refuse a swap that would cross the Phase-3 posture-era boundary (spec §9). A
# fresh box (no current) is not a crossing; the one sanctioned forward crossing is
# cutover.sh (EW_ALLOW_ERA_CROSS=1).
if ! ew_era_gate "\${NEW}/.ew-era" "\${APP_HOME}/current" "\${RUN}"; then
  live_target="\$(asapp readlink -f "\${APP_HOME}/current" 2>/dev/null || true)"
  live_era="\$(asapp cat "\${live_target}/.ew-era" 2>/dev/null || echo legacy)"
  new_era="\$(asapp cat "\${NEW}/.ew-era" 2>/dev/null || echo legacy)"
  echo "REFUSING era-crossing swap: live='\${live_era}' new='\${new_era}'." >&2
  echo "  Rollback across the Phase-3 boundary is unsupported (keel 3)." >&2
  echo "  The one-time forward crossing is deploy/cutover.sh (sets EW_ALLOW_ERA_CROSS=1)." >&2
  exit 1
fi
echo "==> swapping current -> \${VERSION}"
asapp ln -sfn "\${NEW}" "\${APP_HOME}/current"
sudo systemctl daemon-reload
sudo systemctl enable ensembleworks-sync ensembleworks-term ensembleworks-files >/dev/null 2>&1 || true
sudo systemctl restart ensembleworks-sync ensembleworks-term ensembleworks-files
sudo systemctl is-active --quiet ensembleworks-scribe && sudo systemctl restart ensembleworks-scribe || true
sudo systemctl is-active --quiet ensembleworks-discord && sudo systemctl restart ensembleworks-discord || true
# Shared browser: enable + start it if installed, but DON'T restart a running one
# (a restart drops the live shared session). To pick up a changed unit, restart by
# hand: sudo systemctl restart ensembleworks-shared-browser.
if [ "\${SHARED_BROWSER_INSTALLED}" = 1 ]; then
  sudo systemctl enable ensembleworks-shared-browser >/dev/null 2>&1 || true
  sudo systemctl is-active --quiet ensembleworks-shared-browser || sudo systemctl start ensembleworks-shared-browser
fi
sudo systemctl reload-or-restart caddy

# ---- prune old releases (keep newest \$KEEP, never the live one) -------------
# Walks \${RELEASES} ONLY — ~/backups/pre-cutover-* is structurally exempt (spec D8).
echo "==> pruning releases (keep \${KEEP})"
ew_prune_releases "\${RELEASES}" "\${KEEP}" "\${NEW}" "\${RUN}"

# ---- verify ------------------------------------------------------------------
echo "==> deployed: v\${VERSION} (era \$(asapp cat "\${NEW}/.ew-era"))"
# Poll for readiness — the sync server takes a moment to bind :8788, so a fixed
# sleep would report a false 502 on success.
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

# Copy the small support files + the prod unit templates + the re-homed sandbox
# sources, then run the remote script. The units land at /tmp/ensembleworks-*.service
# (the remote sed loop reads /tmp/${u}.service); ${ENSEMBLEWORKS_URL} inside the
# scribe unit stays literal for systemd (committed file, no escaping).
scp -q "$LIB_FILE" "${SSH_TARGET}:/tmp/ew-lib.sh"
scp -q "$REQ_FILE" "${SSH_TARGET}:/tmp/ew-runtime-requirements"
scp -q "$CADDY_PROD" "${SSH_TARGET}:/tmp/ew-Caddyfile.prod"
scp -q "$PROD_UNITS"/*.service "${SSH_TARGET}:/tmp/"
# The shared-browser .slice ships alongside (the *.service glob already grabbed its
# unit); the remote installs both only when SHARED_BROWSER=1.
scp -q "$PROD_UNITS"/ensembleworks-shared-browser.slice "${SSH_TARGET}:/tmp/"
scp -q deploy/posture-era "${SSH_TARGET}:/tmp/ew-posture-era"
scp -q deploy/tmux-ensembleworks.conf "${SSH_TARGET}:/tmp/ew-tmux.conf"
scp -q deploy/ensembleworks-gh-token "${SSH_TARGET}:/tmp/ew-ensembleworks-gh-token"
scp -q bin/gh-app-token.bash "${SSH_TARGET}:/tmp/ew-gh-app-token.bash"
# Pre-clean the remote dir: `scp -r src host:dest` is non-idempotent — if dest
# already exists (a prior deploy's copy survives in /tmp until reboot), scp nests
# the tree as dest/src/ instead of refreshing dest/, so the seed step below reads
# STALE top-level files and hard-fails on any path new to this release. Remove
# first so every deploy re-copies a clean tree. (The other /tmp/ew-* are single
# files — scp overwrites those idempotently; only this directory copy needs it.)
ssh "$SSH_TARGET" 'rm -rf /tmp/ew-agent-home'
scp -qr deploy/agent-home "${SSH_TARGET}:/tmp/ew-agent-home"
ssh "$SSH_TARGET" "bash -s" <<<"$REMOTE"

echo "==> done."
