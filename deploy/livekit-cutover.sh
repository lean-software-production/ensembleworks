#!/usr/bin/env bash
#
# livekit-cutover.sh — flip EnsembleWorks from LiveKit Cloud to self-hosted
# LiveKit OSS on this VM. Idempotent + reversible.
#
# Run as ROOT on the VM (htz-useast-ash-001):
#   bash livekit-cutover.sh            # do the cutover (steps 1-4)
#   bash livekit-cutover.sh --rollback # restore LiveKit Cloud + stop the SFU
#   bash livekit-cutover.sh --status   # show current state, change nothing
#
# What it does:
#   1. Generate a LiveKit API key/secret + write /etc/livekit/livekit.yaml
#      (with the verified config: tcp_port:0, interfaces:[lo,eth0], pinned
#      node_ip). Saves the key/secret to a root-owned file for reuse on
#      re-runs and for rollback safety.
#   2. Start ensembleworks-livekit (the SFU). Confirms it booted + that only
#      127.0.0.1:7880 is listening (no public *:7881 ICE-TCP leak).
#   3. Back up the current (LiveKit Cloud) sync.env + scribe.env, then flip
#      them to the self-host values. Preserves STT_API_KEY in scribe.env.
#      Fixes ownership/permissions so the app units (running as APP_USER)
#      can still read them.
#   4. Restart ensembleworks-sync + ensembleworks-scribe to pick up the new
#      env. The client (Vite) needs no restart — it gets the LiveKit URL
#      from the sync server's token endpoint.
#
# It does NOT:
#   - touch the Hetzner cloud firewall (open UDP 50000-50300 there manually,
#     rule name "livekit-media-UDP", if you have a cloud firewall enabled)
#   - start/restart the client or term units
#   - run the acceptance checks (two-browser mob, scribe, /api/kick) — see
#     the printed "VERIFY" section after a successful run
#
# After a successful run, open https://canvas.leansoftware.ai in TWO browsers
# in the same canvas room and run the acceptance checklist (printed at the end).
#
# Rollback: bash livekit-cutover.sh --rollback
#   restores the .cloud-backup env files, stops the SFU, restarts sync+scribe.
#   The client + scribe reconnect to LiveKit Cloud on next token fetch.

set -euo pipefail

# ---- Constants (this VM) -----------------------------------------------------
APP_USER="ensembleworks-leansoftware-ai"
ENV_DIR="/home/${APP_USER}/.config/ensembleworks"
SYNC_ENV="${ENV_DIR}/sync.env"
SCRIBE_ENV="${ENV_DIR}/scribe.env"
LIVEKIT_YAML="/etc/livekit/livekit.yaml"
KEYS_FILE="/root/livekit-self-host-keys.env"   # root-only, reused on re-runs
PUBLIC_IPV4="178.156.162.162"
PUBLIC_HOSTNAME="canvas.leansoftware.ai"
LIVEKIT_UNIT="ensembleworks-livekit"
APP_UNITS="ensembleworks-sync ensembleworks-scribe"

log()  { printf '\n==> %s\n' "$*" >&2; }
note() { printf '    %s\n' "$*" >&2; }
die()  { printf '\n!! %s\n' "$*" >&2; exit 1; }

# ---- Preflight --------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo bash $0)"
[[ -d "$ENV_DIR" ]]    || die "env dir not found: $ENV_DIR"
command -v livekit-server >/dev/null || die "livekit-server not installed — run bootstrap first"
[[ -f /etc/systemd/system/ensembleworks-livekit.service ]] || die "livekit unit not installed — run bootstrap first"

# ---- Handle --status / --rollback ------------------------------------------
if [[ "${1:-}" == "--status" ]]; then
  log "LiveKit self-host cutover status"
  printf '    SFU unit:     enabled=%s active=%s\n' \
    "$(systemctl is-enabled "$LIVEKIT_UNIT" 2>/dev/null || echo n/a)" \
    "$(systemctl is-active  "$LIVEKIT_UNIT" 2>/dev/null || echo n/a)"
  printf '    livekit.yaml: %s\n' "$( [[ -f $LIVEKIT_YAML ]] && echo present || echo MISSING )"
  printf '    keys file:    %s\n' "$( [[ -f $KEYS_FILE ]] && echo present || echo 'not yet generated' )"
  printf '    sync.env LIVEKIT_URL:   %s\n' "$(grep -E '^LIVEKIT_URL='    $SYNC_ENV   2>/dev/null | cut -d= -f2- || echo '(file missing)')"
  printf '    scribe.env LIVEKIT_URL: %s\n' "$(grep -E '^LIVEKIT_URL='    $SCRIBE_ENV 2>/dev/null | cut -d= -f2- || echo '(file missing)')"
  printf '    cloud backups present:  sync=%s scribe=%s\n' \
    "$( [[ -f $SYNC_ENV.cloud-backup ]]   && echo yes || echo no )" \
    "$( [[ -f $SCRIBE_ENV.cloud-backup ]] && echo yes || echo no )"
  printf '    listening sockets (7880/7881):\n'
  ss -lunpt 2>/dev/null | grep -E '7880|7881' | sed 's/^/      /' || printf '      (none)\n'
  exit 0
fi

if [[ "${1:-}" == "--rollback" ]]; then
  log "ROLLBACK to LiveKit Cloud"
  [[ -f "$SYNC_ENV.cloud-backup"   ]] || die "no sync.env.cloud-backup to restore"
  [[ -f "$SCRIBE_ENV.cloud-backup" ]] || die "no scribe.env.cloud-backup to restore"
  cp "$SYNC_ENV.cloud-backup"   "$SYNC_ENV"
  cp "$SCRIBE_ENV.cloud-backup" "$SCRIBE_ENV"
  chown "$APP_USER:$APP_USER" "$SYNC_ENV" "$SCRIBE_ENV"
  chmod 600 "$SYNC_ENV" "$SCRIBE_ENV"
  note "restored Cloud env files"
  systemctl stop "$LIVEKIT_UNIT" 2>/dev/null || true
  note "stopped the SFU"
  systemctl restart $APP_UNITS
  note "restarted sync + scribe (reconnecting to LiveKit Cloud)"
  log "Rollback done. Verify in a browser that media works again."
  exit 0
fi

[[ -z "${1:-}" ]] || die "unknown arg: $1 (use --status or --rollback, or no arg for cutover)"

# ---- Step 1: key/secret + livekit.yaml -------------------------------------
log "Step 1: generate key/secret + write $LIVEKIT_YAML"
if [[ -f "$KEYS_FILE" ]]; then
  note "reusing existing key/secret from $KEYS_FILE"
  # shellcheck disable=SC1090
  . "$KEYS_FILE"
  [[ -n "${LIVEKIT_API_KEY:-}" && -n "${LIVEKIT_API_SECRET:-}" ]] \
    || die "$KEYS_FILE is missing LIVEKIT_API_KEY/LIVEKIT_API_SECRET — delete it and re-run"
else
  LIVEKIT_API_SECRET="$(openssl rand -hex 32)"
  LIVEKIT_API_KEY="API$(openssl rand -hex 4)"
  install -m 600 /dev/stdin "$KEYS_FILE" <<EOF
# Generated by livekit-cutover.sh. Root-only. Reused on re-runs so the
# key/secret stay stable across restarts. The same values must appear in
# /etc/livekit/livekit.yaml, sync.env, and scribe.env.
LIVEKIT_API_KEY="${LIVEKIT_API_KEY}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET}"
EOF
  note "generated new key/secret → saved to $KEYS_FILE (root-only)"
fi
note "key:   ${LIVEKIT_API_KEY}"
note "secret: ${LIVEKIT_API_SECRET:0:8}… (full value in $KEYS_FILE)"

install -m 0640 -o root -g ensemble-livekit /dev/stdin "$LIVEKIT_YAML" <<EOF
# Written by livekit-cutover.sh. Signaling (7880) bound to loopback, proxied
# via Caddy /livekit + Cloudflare Tunnel + CF Access. Media is UDP 50000-50300
# (public). rtc.tcp_port: 0 disables the default *:7881 ICE-TCP listener.
# rtc.interfaces restricts ICE to lo + eth0 (excludes docker bridges) —
# empirically ~doubles the 300-port range's peer ceiling (~25-30 -> ~45-50).
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 0
  port_range_start: 50000
  port_range_end: 50300
  node_ip: ${PUBLIC_IPV4}
  use_external_ip: false
  interfaces:
    includes:
      - lo
      - eth0
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
logging:
  level: info
EOF
note "wrote $LIVEKIT_YAML (root:ensemble-livekit 0640)"

# ---- Step 2: start the SFU + verify it booted ------------------------------
log "Step 2: start $LIVEKIT_UNIT + verify"
systemctl restart "$LIVEKIT_UNIT"
sleep 2
systemctl is-active --quiet "$LIVEKIT_UNIT" \
  || die "SFU failed to start — check: journalctl -u $LIVEKIT_UNIT -n 30"
note "SFU is active (running)"

# Confirm it's advertising the pinned node_ip + no public ICE-TCP leak.
if journalctl -u "$LIVEKIT_UNIT" --since "-10s" --no-pager 2>/dev/null \
   | grep -q "\"nodeIP\": \"${PUBLIC_IPV4}\""; then
  note "SFU log confirms nodeIP=${PUBLIC_IPV4}"
else
  note "WARNING: could not confirm nodeIP in recent logs — check:"
  note "  journalctl -u $LIVEKIT_UNIT -n 5 --no-pager"
fi

LEAK="$(ss -lunpt 2>/dev/null | grep -E ':7881\b' || true)"
if [[ -n "$LEAK" ]]; then
  die "ICE-TCP port 7881 is listening publicly — tcp_port:0 didn't take. Aborting before env flip:\n      $LEAK"
fi
note "no public *:7881 listener (tcp_port:0 took effect)"
note "listening sockets on 7880/7881:"
ss -lunpt 2>/dev/null | grep -E '7880|7881' | sed 's/^/      /' || note "      (none visible — check ss perms)"

# ---- Step 3: back up Cloud env + flip to self-host -------------------------
log "Step 3: back up LiveKit Cloud env + flip to self-host"
if [[ ! -f "$SYNC_ENV.cloud-backup" ]]; then
  cp "$SYNC_ENV" "$SYNC_ENV.cloud-backup"
  note "backed up sync.env → sync.env.cloud-backup (LiveKit Cloud values)"
else
  note "sync.env.cloud-backup already exists — leaving it (preserves original Cloud values for rollback)"
fi
if [[ ! -f "$SCRIBE_ENV.cloud-backup" ]]; then
  cp "$SCRIBE_ENV" "$SCRIBE_ENV.cloud-backup"
  note "backed up scribe.env → scribe.env.cloud-backup"
else
  note "scribe.env.cloud-backup already exists — leaving it"
fi

# Preserve STT_API_KEY from the current scribe.env (or the backup if absent now)
STT_API_KEY="$(grep -E '^STT_API_KEY=' "$SCRIBE_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [[ -z "$STT_API_KEY" ]]; then
  STT_API_KEY="$(grep -E '^STT_API_KEY=' "$SCRIBE_ENV.cloud-backup" 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi
[[ -n "$STT_API_KEY" ]] || die "couldn't find STT_API_KEY in scribe.env or its backup — fix manually before continuing"

install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/stdin "$SYNC_ENV" <<EOF
# Self-hosted LiveKit OSS (written by livekit-cutover.sh).
# sync mints browser tokens with LIVEKIT_URL (public, via Caddy /livekit +
# CF Access) and calls RoomService (kick) against LIVEKIT_API_URL (localhost).
LIVEKIT_URL=wss://${PUBLIC_HOSTNAME}/livekit
LIVEKIT_API_URL=http://localhost:7880
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
EOF

install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/stdin "$SCRIBE_ENV" <<EOF
# Self-hosted LiveKit OSS (written by livekit-cutover.sh).
# Scribe is co-located with the SFU -> connects signaling to localhost (ws://),
# NOT the public tunneled URL (which is behind CF Access, no browser cookies).
STT_API_KEY=${STT_API_KEY}
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
EOF
note "wrote sync.env + scribe.env (owned $APP_USER, mode 600)"

# ---- Step 4: restart sync + scribe (the actual flip) ----------------------
log "Step 4: restart sync + scribe to pick up the new env"
systemctl restart $APP_UNITS
sleep 3
for u in $APP_UNITS; do
  if systemctl is-active --quiet "$u"; then
    note "$u: active"
  else
    die "$u failed to restart — check: journalctl -u $u -n 30. Rollback with: bash $0 --rollback"
  fi
done

# ---- Done ------------------------------------------------------------------
log "Cutover complete. VERIFY before trusting it:"
cat >&2 <<'VERIFY'

  1. Open https://canvas.leansoftware.ai in TWO browsers, same canvas room:
     [ ] both see + hear each other (spatial audio tracks canvas distance)
     [ ] active-speaker events still drive the faces-rail "speaker pop"

  2. Scribe:
     [ ] "📝 scribe" joins (subscribe-only) and transcribes a spoken utterance
     [ ] POST /api/transcript lands, stamped with the speaker's cursor position

  3. Kick (exercises LIVEKIT_API_URL=http://localhost:7880):
     [ ] POST /api/kick removes a participant from the media room

  4. Under load (6 cameras + a loud terminal build):
     [ ] cursor sync doesn't stutter (CPUWeight=50 isolation holds)
     [ ] free -h shows ~0.8G OS headroom holding under dev+media load

  If ANYTHING fails, rollback is one command:
    bash livekit-cutover.sh --rollback

  Also confirm (one-time, external): from another host, a UDP probe to the
  media range reaches the box — e.g. `nmap -sU -p 50000-50010 178.156.162.162`.
  If media doesn't connect but signaling does, check the Hetzner cloud
  firewall (open UDP 50000-50300, rule name "livekit-media-UDP").

  Status anytime:  bash livekit-cutover.sh --status
VERIFY

# Remind about the key file location for future reference
note "key/secret saved at $KEYS_FILE (root-only) for reuse on re-runs"
note "rollback: bash $0 --rollback   |   status: bash $0 --status"
