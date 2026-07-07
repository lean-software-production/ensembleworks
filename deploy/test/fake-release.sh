#!/usr/bin/env bash
# deploy/test/fake-release.sh — the #7 dry-run proof (spec §10.3). Fakes a GitHub
# release from locally-compiled host binaries and drives deploy/lib.sh's
# fetch/verify/boot-check/era-gate/prune functions against a throwaway HOME tree —
# no ssh, no sudo, launcher prefix "". Proves the machinery, NOT the licence bake
# (no VITE_TLDRAW_LICENSE_KEY off-CI, so client-dist is an empty-dir stub, spec §4.3).
#
# Run from the repo root, after the three build:binary targets have been built:
#   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
#   deploy/test/fake-release.sh
#
# Every `A && ok "..." || bad "..."` below is the intended assert idiom:
# ok()/bad() are echo-only and always return 0, so C never spuriously runs
# when A succeeds; the pattern is deliberate throughout this file.
# shellcheck disable=SC2015
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck disable=SC1091 # relative path, resolved via `cd` to repo root above
. deploy/lib.sh

fail=0
ok()  { echo "ok  : $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

ARCH="$(uname -m)"; case "$ARCH" in x86_64) PAIR=linux-x64;; aarch64) PAIR=linux-arm64;; *) echo "unsupported arch $ARCH" >&2; exit 1;; esac

# --- build the host binaries if missing ---------------------------------------
for w in server cli transcriber; do
  bin="$w/dist/$( [ "$w" = server ] && echo ensembleworks-server || { [ "$w" = cli ] && echo ensembleworks || echo ensembleworks-transcriber; } )"
  [ -x "$bin" ] || (cd "$w" && bun run build:binary)
done

# --- fake a release directory (the fetch source) ------------------------------
rel="$(mktemp -d)"
cp server/dist/ensembleworks-server "$rel/ensembleworks-server-$PAIR"
cp cli/dist/ensembleworks "$rel/ensembleworks-$PAIR"
cp transcriber/dist/ensembleworks-transcriber "$rel/ensembleworks-transcriber-$PAIR"
stub="$(mktemp -d)"; tar czf "$rel/client-dist.tar.gz" -C "$stub" .   # empty-dir bundle (machinery only)
( cd "$rel" && sha256sum ensembleworks-* client-dist.tar.gz > ensembleworks-checksums.txt )

# --- (1) fetch + checksum verify (and a byte-flip must FAIL) -------------------
home="$(mktemp -d)"; NEW="$home/releases/1.0.0"
DEPLOY_FETCH_DIR="$rel" ew_fetch_release 1.0.0 "$NEW" - "" \
  && [ -x "$NEW/ensembleworks-server" ] && [ -d "$NEW/client-dist" ] \
  && ok "fetch: assets re-homed + client-dist extracted" || bad "fetch"
# byte-flip: corrupt a copy, re-checksum -c must fail
bad_rel="$(mktemp -d)"; cp "$rel"/* "$bad_rel"/
printf 'x' | dd of="$bad_rel/ensembleworks-$PAIR" bs=1 seek=8 count=1 conv=notrunc 2>/dev/null
if ( cd "$bad_rel" && sha256sum -c ensembleworks-checksums.txt --ignore-missing >/dev/null 2>&1 ); then
  bad "byte-flip should have failed checksum"
else ok "checksum: a byte-flipped binary fails -c"; fi

# --- (2) boot-check passes; a truncated server binary FAILS -------------------
cp deploy/posture-era "$NEW/.ew-era"
ew_boot_check "$NEW" "" && ok "boot-check: sync + term + files + transcriber --check pass" || bad "boot-check pass"
trunc="$home/releases/1.0.1"; mkdir -p "$trunc/client-dist"
head -c 4096 "$NEW/ensembleworks-server" > "$trunc/ensembleworks-server"; chmod +x "$trunc/ensembleworks-server"
cp "$NEW/ensembleworks-transcriber" "$trunc/"
if ew_boot_check "$trunc" "" 2>/dev/null; then bad "truncated server should have failed boot-check"; else ok "boot-check: a truncated server binary fails (the check gates)"; fi

# --- (3) era stamp ------------------------------------------------------------
[ "$(cat "$NEW/.ew-era")" = "$(cat deploy/posture-era)" ] && ok "era: .ew-era stamped from deploy/posture-era" || bad "era stamp"

# --- (4) era gate: fresh / same / cross / override ----------------------------
ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: fresh tree (no current) allowed" || bad "era-gate fresh"
ln -sfn "$NEW" "$home/current"
ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: same-era swap allowed" || bad "era-gate same"
legacy="$home/releases/0.9.0"; mkdir -p "$legacy"   # no .ew-era -> legacy era
ln -sfn "$legacy" "$home/current"
if ew_era_gate "$NEW/.ew-era" "$home/current" ""; then bad "era-gate should block legacy->unified-1"; else ok "era-gate: cross-era swap blocked"; fi
EW_ALLOW_ERA_CROSS=1 ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: EW_ALLOW_ERA_CROSS=1 unblocks the crossing" || bad "era-gate override"

# --- (5) prune keeps KEEP newest; ~/backups is exempt -------------------------
mkdir -p "$home/releases/1.0.2" "$home/backups/pre-cutover-x"
touch -d '5 days ago' "$home/releases/0.9.0"; touch -d '4 days ago' "$home/releases/1.0.0"
touch -d '3 days ago' "$home/releases/1.0.1"; touch -d '1 day ago' "$home/releases/1.0.2"
ln -sfn "$home/releases/1.0.2" "$home/current"
ew_prune_releases "$home/releases" 2 "$home/releases/1.0.2" ""
{ [ -d "$home/releases/1.0.2" ] && [ -d "$home/releases/1.0.1" ] && [ ! -d "$home/releases/0.9.0" ] && [ -d "$home/backups/pre-cutover-x" ]; } \
  && ok "prune: keeps 2 newest, drops the oldest, backups/ exempt" || bad "prune"

rm -rf "$rel" "$bad_rel" "$stub" "$home"
echo "----"
[ "$fail" = 0 ] && echo "fake-release: ALL PASS" || { echo "fake-release: FAILURES" >&2; exit 1; }
