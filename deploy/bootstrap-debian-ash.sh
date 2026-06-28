#!/usr/bin/env bash

# Bootstrap the ASH dogfood box (Hetzner) into a self-editing EnsembleWorks host.
#
# ASH-ONLY. This is the watch-mode / in-place self-edit setup. Production client
# boxes (e.g. ew-donkeyred-001 on OVH) are provisioned by the laingville repo's
# servers/<host>/bootstrap.sh and deployed with deploy/deploy.sh — they do NOT
# use this script. Folding ash onto that path is a future migration.
#
# !!! SECURITY — READ THIS !!!
# A Cloudflare Tunnel publishes your hostname to the PUBLIC internet. The
# terminal gateway (/term) is shell access as the `ensemble` user. You MUST put
# a Cloudflare Access policy in front of the hostname (see the printed steps at
# the end) or anyone on the internet gets a shell on this box. Access is the
# auth boundary here, the way the tailnet was with Tailscale. Because the mob
# can edit the code the services run, the LiveKit/Groq keys are effectively
# readable by anyone with a terminal — that's inherent to a self-editing room,
# so only admit people you'd trust with those keys.
#
# Run as root on a clean box. APP_USER and SRC_DIR are REQUIRED — no defaults,
# so you state where the code lives and who runs it (no silent misconfiguration):
#   scp deploy/bootstrap-debian-ash.sh root@<box>:/root/
#   ssh root@<box> 'APP_USER=ensemble SRC_DIR=/home/ensemble/.local/lean-software-production/ensembleworks SKIP_VCS=1 bash /root/bootstrap-debian-ash.sh'
# (clone the repo to SRC_DIR yourself first when using SKIP_VCS=1; drop SKIP_VCS
# to have bootstrap clone REPO_URL into SRC_DIR as APP_USER.)
#
# Idempotent: safe to re-run after editing config or pulling new code.

set -euo pipefail

# -----------------------------------------------------------------------------
# Config — edit these, or override via environment (e.g. REPO_BRANCH=main ...).
# -----------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/lean-software-production/ensembleworks.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
# REQUIRED. The user the app units run as and that owns the code tree. Pick a
# dedicated user (e.g. `ensemble`) to keep the app isolated from your login
# account, or your own login user on a single-user dev box. Must exist (or be
# creatable — bootstrap will `useradd --create-home` if missing).
: "${APP_USER:?bootstrap: APP_USER is required (the user the units run as, e.g. APP_USER=ensemble)}"

# REQUIRED. Absolute path to the ensembleworks repo checkout (the repo root IS
# the app). With SKIP_VCS=1 the script uses it as-is (no clone, no chown) — the
# normal case for a repo cloned with your own credentials. Without SKIP_VCS,
# bootstrap clones REPO_URL into SRC_DIR (must not yet exist, or be empty) as APP_USER.
: "${SRC_DIR:?bootstrap: SRC_DIR is required (absolute path to the repo checkout, e.g. SRC_DIR=/home/ensemble/.local/lean-software-production/ensembleworks)}"

# Set SKIP_VCS=1 if the repo is ALREADY checked out at ${SRC_DIR} (e.g. you
# cloned it yourself with your own credentials). The script then skips git
# entirely and just builds/wires what's on disk — useful for a private repo
# the app user has no credentials for. Ownership is left as-is under SKIP_VCS.
SKIP_VCS="${SKIP_VCS:-}"

# Cloudflare Tunnel connector token (from the Zero Trust dashboard: Networks ->
# Tunnels -> create a tunnel -> "Install connector" shows `cloudflared ... run
# --token eyJ...`; paste just the eyJ... part). Leave blank to install
# cloudflared and configure the tunnel by hand later.
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"

# The public hostname this box serves on (the Cloudflare Tunnel's Public
# Hostname). REQUIRED for the Vite client: behind Cloudflare, Vite rejects
# requests whose Host isn't allow-listed and can't place its HMR socket without
# it. Defaults to this deployment's hostname; override for a different box.
PUBLIC_HOST="${PUBLIC_HOST:-canvas.leansoftware.ai}"

# Node pinned to the devcontainer's version + amd64 checksum (Hetzner CPX/CCX are x86_64).
NODE_VERSION="${NODE_VERSION:-22.22.3}"
NODE_SHA256="${NODE_SHA256:-2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f}"

# Where canvas state goes. Defaults under the user's home (resolved in step 5);
# override to force a path — but keep it inside a home dir, never /var.
DATA_DIR="${DATA_DIR:-}"

EDGE_PORT="8080" # Caddy's plain-HTTP port; the tunnel points here
NPM_BIN="/usr/local/bin/npm"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then
	echo "Run as root." >&2
	exit 1
fi

# -----------------------------------------------------------------------------
# 1. Base packages (build-essential + python3 + pkg-config for node-pty's native
#    addon; tmux backs the gateway terminals; sudo lets the mob redeploy).
# -----------------------------------------------------------------------------
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
	ca-certificates curl git build-essential python3 pkg-config tmux jq sudo \
	gnupg debian-keyring debian-archive-keyring apt-transport-https
update-ca-certificates

# -----------------------------------------------------------------------------
# 2. Node 22 — pinned tarball into /usr/local, checksum-verified (matches the
#    devcontainer Dockerfile so host == dev).
# -----------------------------------------------------------------------------
if [[ "$(node -v 2>/dev/null || true)" != "v${NODE_VERSION}" ]]; then
	log "Installing Node ${NODE_VERSION}"
	archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
	curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"
	echo "${NODE_SHA256}  /tmp/${archive}" | sha256sum -c -
	tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1
	rm -f "/tmp/${archive}"
else
	log "Node ${NODE_VERSION} already present — skipping"
fi

# -----------------------------------------------------------------------------
# 3. Caddy — official apt repo. Internal reverse proxy only: serves plain HTTP
#    on :${EDGE_PORT} and does the /term, /dev/{port}, and app routing. TLS is
#    terminated upstream at the Cloudflare edge, so Caddy needs no certs.
# -----------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
	log "Installing Caddy"
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
		gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt |
		tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	apt-get update -y
	apt-get install -y caddy
else
	log "Caddy already present — skipping"
fi

# -----------------------------------------------------------------------------
# 4. cloudflared — the public edge. Dials OUT to Cloudflare, so no inbound port
#    is opened on the box. Access (configured in the dashboard) is the auth gate.
# -----------------------------------------------------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
	log "Installing cloudflared"
	curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg |
		tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
	echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" |
		tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
	apt-get update -y
	apt-get install -y cloudflared
else
	log "cloudflared already present — skipping"
fi

# -----------------------------------------------------------------------------
# 5. livekit-server — the self-hosted WebRTC SFU (media plane). Pinned release;
#    single static Go binary in /usr/local/bin. Runs under a dedicated
#    unprivileged user (ensemble-livekit, created in section 7) with config in
#    /etc/livekit/livekit.yaml. Media flows over UDP 50000-50300 (opened in
#    section 10); signaling WS (7880) is bound to loopback and proxied via Caddy
#    (section 9).
# -----------------------------------------------------------------------------
LIVEKIT_VERSION="1.13.1" # pin a concrete release; bump deliberately
if ! command -v livekit-server >/dev/null 2>&1; then
	log "Installing livekit-server ${LIVEKIT_VERSION}"
	curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" |
		tar -xz -C /usr/local/bin livekit-server
else
	log "livekit-server already present — skipping (pin: ${LIVEKIT_VERSION})"
fi

# -----------------------------------------------------------------------------
# 6. The app user owns everything. Resolve its home and derive every path under
#    it — code lives at ~/.local/lean-software-production/ensembleworks
#    (overridable via SRC_DIR); data and secrets live in ~/.local/share and ~/.config.
# -----------------------------------------------------------------------------
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
	log "Creating user ${APP_USER}"
	useradd --create-home --shell /bin/bash "${APP_USER}"
fi
# Read journald for its own units without sudo (journalctl -u ensembleworks-*).
usermod -aG systemd-journal "${APP_USER}"

APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
# APP_DIR symlinks to ${SRC_DIR} (the repo root IS the app) so the units (which
# run as APP_USER) can cd into the app regardless of where the repo checkout lives.
# DATA_DIR/CONF_DIR stay under APP_HOME (env files with secrets).
APP_DIR="${APP_HOME}/ensembleworks" # symlink -> the repo checkout
DATA_DIR="${DATA_DIR:-${APP_HOME}/.local/share/ensembleworks}"
CONF_DIR="${APP_HOME}/.config/ensembleworks" # env files with secrets

if [[ -n "${SKIP_VCS}" ]]; then
	log "SKIP_VCS set — using the code already at ${SRC_DIR}"
	if [[ ! -d "${SRC_DIR}/.git" ]]; then
		echo "SKIP_VCS set but ${SRC_DIR} has no git checkout — clone the repo there first." >&2
		exit 1
	fi
else
	log "Fetching code (${REPO_BRANCH}), as ${APP_USER}"
	if [[ -d "${SRC_DIR}/.git" ]]; then
		runuser -u "${APP_USER}" -- git -C "${SRC_DIR}" fetch --depth 1 origin "${REPO_BRANCH}"
		runuser -u "${APP_USER}" -- git -C "${SRC_DIR}" checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}"
	else
		runuser -u "${APP_USER}" -- git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SRC_DIR}"
	fi
fi

# Make sure the app user owns the whole tree — it may have been cloned by an
# admin user rather than by the app user. Skipped under SKIP_VCS: the code is
# already on disk and owned by whoever cloned it, and clobbering ownership
# would break their ability to edit it in place. If you point SRC_DIR at a
# checkout owned by another user, ensure APP_USER can read+execute the path
# (the units run as APP_USER and cd into APP_DIR, which symlinks into SRC_DIR).
if [[ -z "${SKIP_VCS}" ]]; then
	chown -R "${APP_USER}:${APP_USER}" "${SRC_DIR}"
fi

log "Wiring and building, as ${APP_USER}"
# Stop the running watch-mode app units BEFORE npm ci — npm ci wipes node_modules,
# and tsx watch/Vite import from it live; a mid-reinstall import races with the
# unlink storm and crashes (Cannot find module '.../tsx/dist/preflight.cjs').
# Record which were running so we restart exactly those after the rebuild
# (don't auto-start an optional unit like scribe the operator hasn't enabled).
# Stopping a not-yet-installed/stopped unit is non-fatal.
RUNNING_BEFORE_BUILD=""
for svc in sync term client scribe; do
	if systemctl is-active --quiet "ensembleworks-${svc}.service" 2>/dev/null; then
		RUNNING_BEFORE_BUILD="${RUNNING_BEFORE_BUILD} ${svc}"
	fi
	systemctl stop "ensembleworks-${svc}.service" 2>/dev/null || true
done
runuser -u "${APP_USER}" -- ln -sfn "${SRC_DIR}" "${APP_DIR}"
runuser -u "${APP_USER}" -- mkdir -p "${DATA_DIR}" "${CONF_DIR}"
runuser -u "${APP_USER}" -- env PATH="/usr/local/bin:${PATH}" bash -c "
  set -euo pipefail
  cd '${APP_DIR}'
  npm ci
  npm run build
"

# Let the mob redeploy after editing the code in place — only restart/start/stop
# of the app's own units, never a root shell.
log "Granting ${APP_USER} restart rights on the app units (sudoers)"
cat >/etc/sudoers.d/ensembleworks <<EOF
# Let the ${APP_USER} mob redeploy EnsembleWorks after editing it in place,
# without handing out a root shell. Restricted to the app's units + safe verbs.
Cmnd_Alias ENSEMBLEWORKS_SVC = /usr/bin/systemctl restart ensembleworks-*, /usr/bin/systemctl start ensembleworks-*, /usr/bin/systemctl stop ensembleworks-*, /usr/bin/systemctl reload-or-restart ensembleworks-*
${APP_USER} ALL=(root) NOPASSWD: ENSEMBLEWORKS_SVC
EOF
chmod 0440 /etc/sudoers.d/ensembleworks
visudo -cf /etc/sudoers.d/ensembleworks >/dev/null

# -----------------------------------------------------------------------------
# 7. Secrets — env files read by the units, in the user's home (~/.config), owned
#    by ${APP_USER}. Written with placeholders ONLY if absent, so re-runs never
#    clobber real secrets.
# -----------------------------------------------------------------------------
if [[ ! -f "${CONF_DIR}/sync.env" ]]; then
	log "Writing ${CONF_DIR}/sync.env placeholder — FILL THIS IN"
	cat >"${CONF_DIR}/sync.env" <<'EOF'
# Self-hosted LiveKit OSS. The sync server mints browser tokens with
# LIVEKIT_URL (public signaling, proxied via Caddy /livekit + CF Access) and
# calls RoomService (kick) against LIVEKIT_API_URL (internal, localhost).
# LIVEKIT_API_KEY/SECRET MUST match the keys block in /etc/livekit/livekit.yaml.
LIVEKIT_URL=wss://canvas.leansoftware.ai/livekit
LIVEKIT_API_URL=http://localhost:7880
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
EOF
fi
if [[ ! -f "${CONF_DIR}/scribe.env" ]]; then
	log "Writing ${CONF_DIR}/scribe.env placeholder — FILL THIS IN (optional scribe)"
	cat >"${CONF_DIR}/scribe.env" <<'EOF'
# Groq key for Whisper STT (https://console.groq.com/keys).
STT_API_KEY=gsk_...
# Self-hosted LiveKit OSS — the scribe is co-located with the SFU, so it
# connects signaling to localhost (ws://), NOT the public tunneled URL (which
# is behind CF Access and has no browser cookies). LIVEKIT_API_KEY/SECRET MUST
# match /etc/livekit/livekit.yaml and sync.env.
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
EOF
fi

# Dedicated unprivileged user for livekit-server (no login, no shell). Distinct
# from the shared ensemble user that runs the four dev services. The unit
# (ensembleworks-livekit.service, installed in section 10) runs as this user.
if ! id ensemble-livekit >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin ensemble-livekit
fi

# livekit-server config. Generated at provision time (NOT a committed template —
# the API secret is sensitive). Placeholders only if absent, like sync.env.
# Field names verified against livekit-server v1.13.1 (pkg/config/config.go):
#   bind_addresses -> binds the HTTP signaling port to loopback only
#   rtc.node_ip    -> pins the advertised ICE candidate IP (deterministic, not STUN)
#   rtc.tcp_port: 0 -> CRITICAL: disables the RTC ICE-TCP listener, which otherwise
#                     defaults to 7881 and listens on * (all interfaces), breaking
#                     the no-inbound-TCP posture. bind_addresses does NOT govern
#                     this port — only tcp_port: 0 closes it.
#   rtc.interfaces.includes -> restricts ICE host-candidate UDP sockets to the
#                     listed interfaces. Empirically measured on the production VM
#                     (178.156.162.162, which also has docker0 + a docker bridge):
#                     WITHOUT the filter the SFU binds a UDP socket per interface
#                     per peer (~10 ports/peer across 4 interfaces), capping the
#                     300-port range at ~25-30 concurrent peers; WITH
#                     includes:[lo,eth0] it binds only 2 interfaces (~5-6
#                     ports/peer), raising the ceiling to ~45-50 peers. lo keeps
#                     the co-located scribe (localhost) reachable; eth0 carries
#                     the public IP for browsers. The docker bridges serve no
#                     media purpose and are excluded. IF THE VM'S PUBLIC INTERFACE
#                     IS NAMED DIFFERENTLY (e.g. ens3, eth1), update this list.
install -d -m 0750 -o root -g ensemble-livekit /etc/livekit
if [[ ! -f /etc/livekit/livekit.yaml ]]; then
	log "Writing /etc/livekit/livekit.yaml placeholder — FILL IN node_ip + keys"
	# PUBLIC_IP is the box's stable public IPv4 (Hetzner IPs are stable; pin it
	# deterministically rather than boot-time STUN). Override at provision time.
	# The API key/secret MUST match LIVEKIT_API_KEY/LIVEKIT_API_SECRET in sync.env
	# + scribe.env. Secret must be >=32 chars (openssl rand -hex 32 = 64 chars).
	cat >/etc/livekit/livekit.yaml <<EOF
# LiveKit OSS SFU config. Signaling (port 7880) is bound to loopback and
# proxied via Caddy /livekit; media is UDP 50000-50300 (public). rtc.tcp_port
# is 0 to disable the ICE-TCP listener (otherwise it opens *:7881 publicly).
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 0
  port_range_start: 50000
  port_range_end: 50300
  node_ip: ${PUBLIC_IP:-<PUBLIC_IP>}
  use_external_ip: false
  # Bind ICE host-candidate UDP sockets only on lo + the public interface.
  # Excludes docker0 / docker bridges, which would otherwise inflate
  # per-peer port usage ~2x and cut the 300-port range's peer ceiling in
  # half. See the comment above this heredoc for the empirical basis.
  interfaces:
    includes:
      - lo
      - eth0
keys:
  <APIKEY>: <SECRET>
logging:
  level: info
EOF
	chown root:ensemble-livekit /etc/livekit/livekit.yaml
	chmod 0640 /etc/livekit/livekit.yaml
fi
if [[ ! -f "${CONF_DIR}/github-app.env" ]]; then
	log "Writing ${CONF_DIR}/github-app.env placeholder — FILL THIS IN (see github-app-runbook.md)"
	cat >"${CONF_DIR}/github-app.env" <<'EOF'
# EnsembleWorks GitHub App (ensembleworks-lsp[bot]) — config for
# bin/gh-app-token.bash, which mints short-lived installation tokens used to
# push and call the GitHub API. Non-secret IDs; the real secret is the
# private-key PEM referenced below. See deploy/github-app-runbook.md for how
# to obtain these values and place the .pem (use the real absolute path, not
# $HOME, once filled in — $HOME here is just an illustrative placeholder).
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_FILE=$HOME/.config/ensembleworks/ensembleworks-lsp.private-key.pem
GITHUB_BOT_USER_ID=
GITHUB_BOT_LOGIN=
EOF
fi
if [[ ! -f "${CONF_DIR}/term.env" ]]; then
	log "Writing ${CONF_DIR}/term.env placeholder — FILL THIS IN"
	cat >"${CONF_DIR}/term.env" <<'EOF'
# Env vars for shells spawned in canvas xterm/tmux sessions (the
# ensembleworks-term gateway: node-pty + tmux). Unlike sync.env / scribe.env /
# github-app.env — which are read by systemd units or on-demand scripts — this
# file is sourced into every interactive shell by ~/.bashrc (set -a), so
# anything launched from a canvas terminal (opencode, gh-app-token, ad-hoc
# curl, …) sees these vars. Plain KEY=value (no `export`). New terminals pick
# it up at shell startup; edit this file then open a new terminal (or
# `source ~/.bashrc`) to apply. Keep chmod 600. See README "Users & data".
OPENCODE_API_KEY=
EOF
fi
chown "${APP_USER}:${APP_USER}" "${CONF_DIR}"/*.env
chmod 600 "${CONF_DIR}"/*.env

# Wire term.env into the app user's ~/.bashrc so interactive shells spawned by
# the terminal gateway source it at startup. Idempotent: only append if the
# stanza isn't already present, so re-runs never duplicate it.
BASHRC="${APP_HOME}/.bashrc"
touch "${BASHRC}"
if ! grep -q '__ew_term_env_file' "${BASHRC}"; then
	log "Wiring ${CONF_DIR}/term.env into ${BASHRC}"
	cat >>"${BASHRC}" <<'EOF'

# --- EnsembleWorks terminal env ---
# Source ~/.config/ensembleworks/term.env so CLI tools run from a canvas
# xterm/tmux session see those vars. Sourced once at shell startup under set -a
# (new terminals pick it up; edit term.env then open a new terminal or
# `source ~/.bashrc`). Written by deploy/bootstrap-debian-ash.sh.
__ew_term_env_file="${XDG_CONFIG_HOME:-$HOME/.config}/ensembleworks/term.env"
[ -f "$__ew_term_env_file" ] && { set -a; . "$__ew_term_env_file" 2>/dev/null; set +a; }
# --- end EnsembleWorks terminal env ---
EOF
	chown "${APP_USER}:${APP_USER}" "${BASHRC}"
fi

# -----------------------------------------------------------------------------
# 6b. Swap headroom — this VM has little RAM and shipped without swap, so an
#     allocation spike went straight to the OOM killer and forced a reboot. A 2G
#     swapfile gives the kernel somewhere to spill before that happens; it pairs
#     with the per-service cgroup caps in §7. Idempotent: skip if swap is active.
# -----------------------------------------------------------------------------
if [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
	log "Creating 2G /swapfile (no active swap found)"
	fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
	chmod 600 /swapfile
	mkswap /swapfile
	swapon /swapfile
	grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
else
	log "Swap already active — skipping swapfile creation"
fi

# -----------------------------------------------------------------------------
# 8. systemd units — run as ${APP_USER}, out of its home.
# -----------------------------------------------------------------------------
log "Installing systemd units"

# OOM containment slice. Resource policy is inverted for easy resizing: the three
# core services (sync/client/scribe) each reserve a protected working set via
# MemoryLow, and term — the spiky, low-blast-radius tmux workload — gets "the
# rest". The slice's MemoryLow must be >= the sum of the children's MemoryLow so
# the protection propagates (cgroup v2 clamps a child's effective low to its
# ancestors'). MemoryHigh throttles/reclaims the collective first (pressure lands
# on unprotected term); MemoryMax is the hard ceiling whose OOM kill targets the
# largest process — the runaway term pane. Resizing the VM needs NO edits here:
# MemoryHigh/MemoryMax are a percentage of RAM and auto-scale; the core's
# MemoryLow numbers are an absolute working set and stay fixed.
cat >/etc/systemd/system/ensembleworks.slice <<EOF
[Unit]
Description=Resource limits for EnsembleWorks dev services
Before=slices.target

[Slice]
MemoryAccounting=yes
# Protected reservation for the core: sync 512M + client 512M + scribe 256M.
MemoryLow=1280M
# Collective throttle (~4.6G) and hard ceiling (~5.3G) on a 7.6 GiB box.
# Lowered from 78%/88% to leave OS headroom for the separate
# ensembleworks-media.slice (LiveKit SFU, MemoryMax=1500M): dev ~5.3G + media
# 1.5G ~= 6.8G, ~0.8G for kernel/Caddy/cloudflared. Percentages auto-scale
# if the VM is resized; revisit if headroom proves tight under real RSS.
MemoryHigh=60%
MemoryMax=70%
# CPUWeight=50 yields to the media slice (CPUWeight=200) under contention.
# The SFU is latency-critical (a delayed SFU backs up RTP and works harder, not
# slower); the scribe is async and tolerates CPU lag. See
# deploy/systemd/ensembleworks.slice + memory-resource-policy.md.
CPUWeight=50
EOF

# Dogfooding stage: units run the watch/dev npm scripts (tsx watch + Vite HMR),
# the same the devcontainer uses, so source edits reload live. See the README
# "Hardening later" note to switch to the non-watch `start` scripts + static
# client when you want the instance to stop being self-editable.

cat >/etc/systemd/system/ensembleworks-sync.service <<EOF
[Unit]
Description=EnsembleWorks sync server (tldraw sync + assets + API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/server
Environment=PORT=8788
Environment=DATA_DIR=${DATA_DIR}
EnvironmentFile=${CONF_DIR}/sync.env
ExecStart=${NPM_BIN} run dev
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/ensembleworks-term.service <<EOF
[Unit]
Description=EnsembleWorks terminal gateway (node-pty + tmux)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/server
Environment=PORT=8789
Environment=TMUX_CONF=${APP_DIR}/deploy/tmux-ensembleworks.conf
ExecStart=${NPM_BIN} run dev:term
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/ensembleworks-client.service <<EOF
[Unit]
Description=EnsembleWorks client (Vite dev server + HMR, fronted by Caddy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/client
Environment=ENSEMBLEWORKS_PUBLIC_HOST=${PUBLIC_HOST}
ExecStart=${NPM_BIN} run dev
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/ensembleworks-scribe.service <<EOF
[Unit]
Description=EnsembleWorks transcriber bot (LiveKit subscriber -> Groq Whisper -> /api/transcript)
After=network-online.target ensembleworks-sync.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/transcriber
Environment=CANVAS_URL=http://localhost:8788
Environment=CANVAS_ROOM=team
Environment=STT_URL=https://api.groq.com/openai/v1
Environment=STT_MODEL=whisper-large-v3-turbo
Environment=STT_LANGUAGE=en
EnvironmentFile=${CONF_DIR}/scribe.env
# Wait for the sync server (CANVAS_URL, port 8788) to actually accept connections
# before fetching a LiveKit token. After= only orders unit *start*, not socket
# readiness, so without this the bot races the server on a cold boot and dies on
# ECONNREFUSED. curl (no -f) exits 0 on any HTTP reply, nonzero on conn-refused.
ExecStartPre=/bin/sh -c 'until curl -s -o /dev/null --connect-timeout 2 "\${CANVAS_URL}/"; do echo "waiting for sync server at \${CANVAS_URL} ..."; sleep 1; done'
ExecStart=${NPM_BIN} run dev
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# OOM containment — written as per-service drop-ins (10-memory.conf) rather than
# inline in the unit bodies above, so the whole cgroup/memory policy lives in one
# obvious place and matches what `systemctl set-property` writes. The core
# services reserve a protected MemoryLow (reclaimed/OOM-killed LAST); term carries
# none, so under pressure the slice throttles (MemoryHigh) then OOM-kills the
# largest process — a runaway term pane — while the protected core survives. The
# slice's MemoryLow (deploy/systemd/ensembleworks.slice) must equal the sum of
# these. See ensembleworks.slice for the full policy.
declare -A SVC_MEMLOW=([sync]=512M [client]=512M [scribe]=256M [term]=)
for svc in sync term client scribe; do
	dropin_dir="/etc/systemd/system/ensembleworks-${svc}.service.d"
	mkdir -p "$dropin_dir"
	{
		echo "[Service]"
		echo "Slice=ensembleworks.slice"
		echo "MemoryAccounting=yes"
		[ -n "${SVC_MEMLOW[$svc]}" ] && echo "MemoryLow=${SVC_MEMLOW[$svc]}"
	} >"${dropin_dir}/10-memory.conf"
done

# -----------------------------------------------------------------------------
# 9. Caddy edge — the SAME deploy/Caddyfile the devcontainer uses (:${EDGE_PORT}
#    -> Vite + the /dev/{port} proxy). Copied from the repo so there's one source
#    of truth; re-run this script (or cp it again) after editing it. The
#    Cloudflare Tunnel points its public hostname at http://localhost:${EDGE_PORT}.
# -----------------------------------------------------------------------------
log "Installing /etc/caddy/Caddyfile from ${APP_DIR}/deploy/Caddyfile"
install -m 0644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile

# -----------------------------------------------------------------------------
# 10. Enable services. Install the tunnel connector if a token was provided.
# -----------------------------------------------------------------------------
log "Reloading systemd and enabling services"
systemctl daemon-reload
# `enable --now` won't reload an already-running Caddy (the apt package starts it
# with the default :80 Caddyfile at install), so explicitly reload-or-restart to
# pick up the /etc/caddy/Caddyfile we just installed.
systemctl enable caddy
systemctl reload-or-restart caddy
# Restart the app units that were running before the rebuild (we stopped them
# before npm ci to avoid the reinstall race). Use restart, not enable --now:
# enable --now is a no-op on already-enabled units, so it wouldn't start units
# we just stopped. Restart also picks up the rebuilt code. Units that weren't
# running stay stopped (e.g. an optional scribe the operator hasn't enabled).
systemctl enable ensembleworks-sync ensembleworks-term ensembleworks-client
for svc in ${RUNNING_BEFORE_BUILD}; do
	systemctl restart "ensembleworks-${svc}.service"
done

# Install the LiveKit SFU units. Enabled but NOT started here — starting
# without a filled-in /etc/livekit/livekit.yaml would crash-loop. The cutover
# runbook (Task 7) starts it after env + keys are set. The slice gets its own
# MemoryMax/CPUWeight cap, separate from the dev ensembleworks.slice.
install -m 0644 "${APP_DIR}/deploy/systemd/ensembleworks-media.slice" /etc/systemd/system/ensembleworks-media.slice
install -m 0644 "${APP_DIR}/deploy/systemd/ensembleworks-livekit.service" /etc/systemd/system/ensembleworks-livekit.service
systemctl daemon-reload
systemctl enable ensembleworks-livekit.service

if [[ -z "${PUBLIC_HOST}" ]]; then
	log "WARNING: PUBLIC_HOST is unset — the Vite client will reject the public"
	printf '  Cloudflare hostname until you set Environment=ENSEMBLEWORKS_PUBLIC_HOST in\n'
	printf '  /etc/systemd/system/ensembleworks-client.service and restart it.\n'
fi

if [[ -n "${CF_TUNNEL_TOKEN}" ]]; then
	log "Installing cloudflared tunnel connector"
	cloudflared service install "${CF_TUNNEL_TOKEN}"
	systemctl enable --now cloudflared
fi

# -----------------------------------------------------------------------------
# Host firewall (ufw). Executed + idempotent — opens the narrowed LiveKit media
# UDP range (50000-50300) for direct ICE. `allow OpenSSH` runs BEFORE `--force
# enable` so re-running this on a box without ufw can't lock out SSH. ufw
# commands are idempotent, so re-runs are safe. This is ONE layer; the cutover
# runbook confirms the SAME narrowed range is open in the Hetzner cloud firewall
# (host ufw alone is insufficient if the cloud firewall is enabled). No host-
# level UDP rate-limit — it's the wrong tool for a media port (legitimate
# 6-publisher inbound ~1800 pps; a high limit stops no real flood, a low one
# self-DoS, and global-not-per-source means one attacker exhausts the budget).
# Volumetric defense is Hetzner network DDoS + the narrow range + token gating.
# -----------------------------------------------------------------------------
log "Configuring host firewall (ufw)"
apt-get install -y ufw
ufw allow OpenSSH comment 'SSH (bootstrap)'
ufw allow 50000:50300/udp comment 'livekit-media-UDP'
ufw --force enable

log "Done. Remaining steps:"
cat <<EOF

  1. Cloudflare Tunnel (if you didn't pass CF_TUNNEL_TOKEN):
       - Zero Trust dashboard -> Networks -> Tunnels -> Create a tunnel (cloudflared).
       - Copy the connector token and run on this box:
           cloudflared service install <TOKEN> && systemctl enable --now cloudflared
       - Add a Public Hostname for the tunnel:
           Subdomain/Domain: e.g. canvas.leansoftware.ai
           Service:          HTTP  ->  localhost:${EDGE_PORT}

  2. !!! Cloudflare Access — REQUIRED, this is the auth boundary !!!
       Zero Trust -> Access -> Applications -> Add a Self-hosted application:
         Application domain: canvas.leansoftware.ai   (the same hostname, whole path)
         Policy: Allow -> e.g. "Emails" = your allowlist, or a Google/GitHub IdP.
       Until this exists, /term is an OPEN SHELL to the public internet.

  3. Set the client's public host (if you didn't pass PUBLIC_HOST): put your
     Cloudflare hostname in ensembleworks-client.service, then restart it:
       Environment=ENSEMBLEWORKS_PUBLIC_HOST=canvas.leansoftware.ai
       sudo systemctl restart ensembleworks-client

  4. Fill in real secrets (owned by ${APP_USER}, in its home):
       ${CONF_DIR}/sync.env        (LIVEKIT_URL / LIVEKIT_API_URL / API_KEY / API_SECRET)
       ${CONF_DIR}/scribe.env      (STT_API_KEY + the same LiveKit values)  # scribe only
       ${CONF_DIR}/github-app.env  (GITHUB_APP_* — see github-app-runbook.md)  # bot push/API
       ${CONF_DIR}/term.env        (OPENCODE_API_KEY + any CLI-tool vars)     # canvas shells
     Then: sudo systemctl restart ensembleworks-sync
     (term.env is sourced by ~/.bashrc — no restart needed; open a new terminal.)

  5. (Optional) transcription:
       systemctl enable --now ensembleworks-scribe

  6. Host firewall + Hetzner cloud firewall: bootstrap now installs ufw, allows
     OpenSSH + the narrowed LiveKit media range (UDP 50000-50300), and enables
     it. If you instead rely on a Hetzner Cloud Firewall, open tcp/22 + udp/
     50000-50300 there too — host ufw alone is insufficient if the cloud
     firewall is enabled. The LiveKit cutover runbook confirms both.

  Edit EnsembleWorks from inside it (dogfooding): open a terminal (you are
  ${APP_USER}), then just edit — the units run in watch mode, so server/client
  changes reload live:
       cd ~/ensembleworks        # symlink to ${SRC_DIR}
       \$EDITOR server/src/...    # tsx watch / Vite HMR pick it up automatically
       sudo systemctl restart ensembleworks-sync   # only for dep changes / a wedged unit

  Logs:  journalctl -u ensembleworks-sync -f   (also -term, -client, -scribe; caddy, cloudflared need sudo)
  Update from git later:  cd ${SRC_DIR} && git pull, then re-run this script
  (with SKIP_VCS=1 it rebuilds what's on disk; without, it fetches ${REPO_BRANCH}).
EOF
