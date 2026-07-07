#!/usr/bin/env bash
# Runs ON the box (piped by cutover.sh as /tmp/ew-reseed.sh). Idempotent env rename:
# rewrite CANVAS_URL/CANVAS_ROOM -> ENSEMBLEWORKS_URL/ENSEMBLEWORKS_ROOM in the app
# + service env files so the renamed scribe unit (Task 5) and the CLI (#4) agree.
# The SKILL.md reseed is carried by the deploy.sh sandbox seed (AGENTS.md/CLAUDE.md);
# this script only re-homes the env tokens the cutover renames.
set -euo pipefail
APP_USER=ensembleworks
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
AGENT_USER=ensembleworks-agent

rewrite_env() { # $1 = env file path, $2 = run-as user
  local f="$1" as="$2"
  sudo -u "$as" test -f "$f" || return 0
  sudo -u "$as" sed -i -e 's/^CANVAS_URL=/ENSEMBLEWORKS_URL=/' -e 's/^CANVAS_ROOM=/ENSEMBLEWORKS_ROOM=/' "$f"
  echo "    rewrote CANVAS_* -> ENSEMBLEWORKS_* in $f"
}

# app-user service env files
for f in "${APP_HOME}/.config/ensembleworks/scribe.env" "${APP_HOME}/.config/ensembleworks/sync.env"; do
  rewrite_env "$f" "$APP_USER"
done
# sandbox-user term env
if id -u "$AGENT_USER" >/dev/null 2>&1; then
  AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
  rewrite_env "${AGENT_HOME}/.config/ensembleworks/term.env" "$AGENT_USER"
fi
echo "==> env reseed complete (CANVAS_* -> ENSEMBLEWORKS_*)"
