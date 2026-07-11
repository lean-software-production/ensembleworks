#!/usr/bin/env bash
# Runs ON the box (piped by cutover.sh). $1 = version. Fetch the server binary,
# boot it against COPIES of the live storage dirs with EW_WARM_ROOMS=1 (forces
# every rooms/<room>.sqlite through getOrCreateRoom — and so through the
# @tldraw schema — at boot instead of lazily on first WS connect), and assert
# /api/health lists every room the live DATABASE_DIR carries. ABORT (exit 1)
# if any room fails to load.
set -euo pipefail
VERSION="${1:?usage: cutover-dataload-check.sh <version>}"
# shellcheck disable=SC1091 # /tmp/ew-lib.sh is deploy/lib.sh, scp'd there by cutover.sh
. /tmp/ew-lib.sh
APP_USER=ensembleworks
REPO_SLUG="${REPO_SLUG:-lean-software-production/ensembleworks}"
RUN="sudo -u ${APP_USER}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
# Live paths come from the box's storage.env — the same single source of truth
# the sync unit and the backup units read (required-database-dirs spec).
STORAGE_ENV="${APP_HOME}/.config/ensembleworks/storage.env"
DATA_DIR="$(sudo grep '^DATA_DIR=' "$STORAGE_ENV" | tail -n1 | cut -d= -f2-)"
DATABASE_DIR="$(sudo grep '^DATABASE_DIR=' "$STORAGE_ENV" | tail -n1 | cut -d= -f2-)"
if [ -z "$DATA_DIR" ] || [ -z "$DATABASE_DIR" ]; then
  echo "ABORT: DATA_DIR/DATABASE_DIR missing from $STORAGE_ENV" >&2; exit 1
fi

echo "==> fetching v${VERSION} server binary for the data-load check"
fetchdir="$(${RUN} mktemp -d)"
ew_fetch_release "${VERSION}" "${fetchdir}" "${REPO_SLUG}" "${RUN}"

echo "==> booting against copies of the live DATA_DIR + DATABASE_DIR"
work="$(${RUN} mktemp -d)"; work_db="$(${RUN} mktemp -d)"; work_bk="$(${RUN} mktemp -d)"; cdir="$(${RUN} mktemp -d)"
${RUN} cp -a "${DATA_DIR}/." "${work}/"
if ${RUN} test -d "${DATABASE_DIR}/rooms"; then
  ${RUN} cp -a "${DATABASE_DIR}/rooms" "${work_db}/rooms"
fi
port="$(ew_free_port)"
# Scratch triple (siblings under /tmp) satisfies the startup geometry validation.
${RUN} env PORT="$port" DATA_DIR="$work" DATABASE_DIR="$work_db" DATABASE_BACKUPS_DIR="$work_bk" CLIENT_DIST="$cdir" EW_WARM_ROOMS=1 \
  "${fetchdir}/ensembleworks-server" sync >/tmp/ew-dataload.log 2>&1 & pid=$!
ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "ABORT: server did not come up on the copied storage dirs" >&2; kill "$pid" 2>/dev/null; exit 1; }

# Cross-check: every rooms/<room>.sqlite must appear in /api/health's rooms[].
loaded="$(curl -s "http://127.0.0.1:$port/api/health")"
echo "    /api/health: ${loaded}"
rc=0
if ${RUN} test -d "${work_db}/rooms"; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    room="$(basename "$f" .sqlite)"
    case "$loaded" in
    *"\"$room\""*) echo "    ok: room '$room' loaded" ;;
    *) echo "    FAIL: room '$room' did NOT load under the new binary" >&2; rc=1 ;;
    esac
  done < <(${RUN} bash -c "ls '${work_db}/rooms'/*.sqlite 2>/dev/null || true")
fi
# `wait` on the just-killed server returns 143 (SIGTERM); under `set -e` that
# would abort the script AFTER the check already passed. Guard it — the room
# verdict is captured in $rc above and gated below.
kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
${RUN} rm -rf "$fetchdir" "$work" "$work_db" "$work_bk" "$cdir"
[ "$rc" = 0 ] || { echo "ABORT: data-load check failed — do NOT cut over" >&2; exit 1; }
echo "==> data-load check passed: every room loads under v${VERSION}"
