#!/usr/bin/env bash
# Sourceable helpers for deploy.sh. Pure functions only (no side effects) so they
# can be unit-tested by deploy/test/lib_test.sh. Do not run system commands here.

# extract_version <string> -> first MAJOR.MINOR[.PATCH] token, or empty.
extract_version() {
	printf '%s' "${1:-}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

# version_ge <a> <b> -> exit 0 iff a >= b (numeric, dotted; uses sort -V).
version_ge() {
	# sort -V handles equal inputs too — the lower of two equal strings is itself.
	local lower
	lower="$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)"
	[ "$lower" = "$2" ]
}

# check_constraint <name> <constraint> <required> <found>
#   present : pass iff found is non-empty
#   exact   : pass iff found == required
#   min     : pass iff found >= required
# On failure prints a one-line reason to stdout and returns 1.
check_constraint() {
	local name="$1" constraint="$2" required="$3" found="$4"
	case "$constraint" in
	present)
		[ -n "$found" ] && return 0
		echo "${name}: not found (need: present)"
		return 1
		;;
	exact)
		[ "$found" = "$required" ] && return 0
		echo "${name}: found ${found:-none}, need exactly ${required}"
		return 1
		;;
	min)
		if [ -n "$found" ] && version_ge "$found" "$required"; then return 0; fi
		echo "${name}: found ${found:-none}, need >= ${required}"
		return 1
		;;
	*)
		echo "${name}: unknown constraint '${constraint}'"
		return 1
		;;
	esac
}

# ---- release fetch / boot-check / era-gate / prune ---------------------------
# Sourced on the box (as /tmp/ew-lib.sh) AND locally by deploy.sh --dry-run and
# deploy/test/fake-release.sh. Prod hosts carry NO JS runtime (the point of
# artifact deploys), so every helper here is shell-native (ss/iproute2 + curl +
# coreutils, present on the glibc boxes). Each takes an optional trailing "run"
# launcher prefix: "" = the current user (local/tests), "sudo -u ensembleworks"
# on the box. All effects are confined to the directories passed in.

# ew_fetch_release <version> <dest-dir> <repo-slug> [run]
# Populate <dest-dir> with the tag's release assets, verify checksums, re-home the
# per-arch binaries to their generic names, and extract client-dist alongside.
# Honors DEPLOY_FETCH_DIR (a local dir of assets) so --dry-run / fake-release.sh
# run with no `gh` and no network.
ew_fetch_release() {
	local ver="$1" dest="$2" slug="$3" run="${4:-}" arch a
	$run mkdir -p "$dest"
	if [ -n "${DEPLOY_FETCH_DIR:-}" ]; then
		$run cp "$DEPLOY_FETCH_DIR"/ensembleworks-* "$DEPLOY_FETCH_DIR"/client-dist.tar.gz "$dest"/
	else
		$run gh release download "v${ver}" -R "$slug" -D "$dest" --clobber \
			-p 'ensembleworks-*' -p 'client-dist.tar.gz' -p 'ensembleworks-checksums.txt'
	fi
	$run bash -c "cd '$dest' && sha256sum -c ensembleworks-checksums.txt --ignore-missing"
	arch="$($run uname -m)"
	case "$arch" in
	x86_64) a=linux-x64 ;;
	aarch64) a=linux-arm64 ;;
	*) echo "ew_fetch_release: unsupported arch '$arch'" >&2; return 1 ;;
	esac
	$run mv "$dest/ensembleworks-server-$a" "$dest/ensembleworks-server"
	$run mv "$dest/ensembleworks-transcriber-$a" "$dest/ensembleworks-transcriber"
	$run mv "$dest/ensembleworks-$a" "$dest/ensembleworks"
	$run chmod +x "$dest"/ensembleworks*
	$run mkdir -p "$dest/client-dist"
	$run tar xzf "$dest/client-dist.tar.gz" -C "$dest/client-dist"
}

# ew_free_port -> the first high port with no listener (fail-closed if none free).
ew_free_port() {
	local p
	for p in $(seq 8790 8890); do
		ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { echo "$p"; return 0; }
	done
	echo 8798 # exhausted: the bind then loses -> ew_poll_health fails closed
}

# ew_poll_health <url> <pid> -> 0 iff <url> goes 200 before <pid> dies / times out.
ew_poll_health() {
	local url="$1" pid="$2" code=000 _
	for _ in $(seq 1 40); do
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
		[ "$code" = 200 ] && return 0
		kill -0 "$pid" 2>/dev/null || return 1
		sleep 0.25
	done
	return 1
}

# ew_boot_check <release-dir> [run] -> 0 iff the fetched server (sync + term) and
# transcriber (--check) all boot on scratch dirs/ephemeral ports. Hermetic: fresh
# DATA_DIR/CLIENT_DIST, no TERM_RUN_AS, no room.connect(). Fail-closed.
ew_boot_check() {
	local NEW="$1" run="${2:-}" ddir cdir port pid ok=1 log="/tmp/ew-bootcheck-$$"
	ddir="$($run mktemp -d)"; cdir="$($run mktemp -d)"
	# --- server sync: /api/health -> 200 ---
	port="$(ew_free_port)"
	$run env PORT="$port" DATA_DIR="$ddir" CLIENT_DIST="$cdir" \
		"${NEW}/ensembleworks-server" sync >"${log}-sync.log" 2>&1 & pid=$!
	ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "boot-check FAILED: server sync" >&2; ok=0; }
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	# --- server term: /api/terminal/health -> 200 (NO TERM_RUN_AS -> no tmux spawn) ---
	port="$(ew_free_port)"
	$run env PORT="$port" "${NEW}/ensembleworks-server" term >"${log}-term.log" 2>&1 & pid=$!
	ew_poll_health "http://127.0.0.1:$port/api/terminal/health" "$pid" || { echo "boot-check FAILED: server term" >&2; ok=0; }
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	# --- transcriber: addon links + config parses (arch integrity), exit 0 ---
	$run timeout 15 "${NEW}/ensembleworks-transcriber" --check >"${log}-scribe.log" 2>&1 \
		|| { echo "boot-check FAILED: transcriber --check nonzero" >&2; ok=0; }
	$run rm -rf "$ddir" "$cdir"
	[ "$ok" = 1 ]
}

# ew_era_gate <new-era-file> <live-current-symlink> [run] -> 0 = allow the swap,
# 1 = refuse (a real mismatch between two PRESENT eras, no EW_ALLOW_ERA_CROSS=1).
# A fresh box (no `current`) is not a crossing -> allowed (spec §9).
ew_era_gate() {
	local new_era_file="$1" live_link="$2" run="${3:-}" new_era live_target live_era
	new_era="$($run cat "$new_era_file" 2>/dev/null || echo legacy)"
	# `readlink -f` canonicalizes even a non-existent path (no error), so a plain
	# emptiness check on its output never catches the "no current yet" case —
	# test existence first.
	$run test -e "$live_link" || return 0 # first deploy — era gate not applicable
	live_target="$($run readlink -f "$live_link" 2>/dev/null || true)"
	live_era="$($run cat "${live_target}/.ew-era" 2>/dev/null || echo legacy)"
	[ "$new_era" = "$live_era" ] && return 0 # within an era — rollback/redeploy allowed
	[ "${EW_ALLOW_ERA_CROSS:-0}" = 1 ] && return 0 # the one sanctioned crossing (cutover.sh)
	return 1
}

# ew_prune_releases <releases-dir> <keep> <live-dir> [run]
# Remove all but the <keep> newest release dirs, never the live one. Walks
# <releases-dir> ONLY — ~/backups/pre-cutover-* is structurally exempt (spec D8).
ew_prune_releases() {
	local rel="$1" keep="$2" live="$3" run="${4:-}"
	# The inner script's $1/$2/$3 are its own positional params (passed after
	# `_` below), deliberately unexpanded by the outer shell.
	# shellcheck disable=SC2012,SC2016
	$run bash -c '
		rel="$1"; keep="$2"; live="$3"
		ls -1dt "$rel"/*/ 2>/dev/null | tail -n +$((keep + 1)) | while read -r d; do
			d="${d%/}"; [ "$d" = "$live" ] && continue; rm -rf "$d"
		done
	' _ "$rel" "$keep" "$live"
}
