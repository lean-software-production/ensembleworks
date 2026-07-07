#!/usr/bin/env bash
# Runs ON the box (piped by cutover.sh). $1 = version. Fetch the server binary,
# boot it against a COPY of the live DATA_DIR, and assert /api/health lists every
# room the DATA_DIR carries. ABORT (exit 1) if any room fails to load.
set -euo pipefail
VERSION="${1:?usage: cutover-dataload-check.sh <version>}"
# shellcheck source=deploy/lib.sh disable=SC1091
. /tmp/ew-lib.sh
APP_USER=ensembleworks
REPO_SLUG="${REPO_SLUG:-lean-software-production/ensembleworks}"
RUN="sudo -u ${APP_USER}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
DATA_DIR="${APP_HOME}/.local/share/ensembleworks"

echo "==> fetching v${VERSION} server binary for the data-load check"
fetchdir="$(${RUN} mktemp -d)"
ew_fetch_release "${VERSION}" "${fetchdir}" "${REPO_SLUG}" "${RUN}"

echo "==> booting against a copy of the live DATA_DIR"
work="$(${RUN} mktemp -d)"; cdir="$(${RUN} mktemp -d)"
${RUN} cp -a "${DATA_DIR}/." "${work}/"
port="$(ew_free_port)"
${RUN} env PORT="$port" DATA_DIR="$work" CLIENT_DIST="$cdir" \
  "${fetchdir}/ensembleworks-server" sync >/tmp/ew-dataload.log 2>&1 & pid=$!
ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "ABORT: server did not come up on the copied DATA_DIR" >&2; kill "$pid" 2>/dev/null; exit 1; }

# Cross-check: every rooms/<room>.sqlite must appear in /api/health's rooms[].
loaded="$(curl -s "http://127.0.0.1:$port/api/health")"
echo "    /api/health: ${loaded}"
rc=0
if ${RUN} test -d "${work}/rooms"; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    room="$(basename "$f" .sqlite)"
    case "$loaded" in
    *"\"$room\""*) echo "    ok: room '$room' loaded" ;;
    *) echo "    FAIL: room '$room' did NOT load under the new binary" >&2; rc=1 ;;
    esac
  done < <(${RUN} bash -c "ls '${work}/rooms'/*.sqlite 2>/dev/null || true")
fi
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
${RUN} rm -rf "$fetchdir" "$work" "$cdir"
[ "$rc" = 0 ] || { echo "ABORT: data-load check failed — do NOT cut over" >&2; exit 1; }
echo "==> data-load check passed: every room loads under v${VERSION}"
