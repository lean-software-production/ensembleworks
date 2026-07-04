#!/usr/bin/env bash
# Offline tests for connect.sh: exercises --dry-run (config resolution, arch
# detection, URL construction, secret redaction) and the sourced verify_sha256
# helper. No network, no TTY, no termgw exec.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONNECT="$HERE/../connect.sh"
fail=0
contains() { case "$2" in *"$3"*) echo "ok   - $1";; *) echo "FAIL - $1: [$2] missing [$3]"; fail=1;; esac; }
absent()   { case "$2" in *"$3"*) echo "FAIL - $1: leaked [$3]"; fail=1;; *) echo "ok   - $1";; esac; }

# --- dry-run: amd64, pinned version ---
out=$(UNAME_M=x86_64 CANVAS_URL=https://canvas.example CF_ACCESS_CLIENT_ID=cfid \
      CF_ACCESS_CLIENT_SECRET=S3CR3T-XYZ GATEWAY_LABEL=demo \
      TERMGW_VERSION=v1.2.3 RELEASE_REPO=o/r ENV_FILE=/nonexistent BIN_DIR=/tmp/b \
      bash "$CONNECT" --dry-run </dev/null)
contains "amd64 arch line"      "$out" "arch: amd64"
contains "amd64 pinned url"     "$out" "https://github.com/o/r/releases/download/v1.2.3/termgw-linux-amd64"
contains "label passthrough"    "$out" "label: demo"
contains "secret redacted"      "$out" "cf-secret: ***"
absent   "secret not leaked"    "$out" "S3CR3T-XYZ"

# --- dry-run: arm64, latest version ---
out=$(UNAME_M=aarch64 CANVAS_URL=https://c CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
      TERMGW_VERSION=latest RELEASE_REPO=o/r ENV_FILE=/nonexistent BIN_DIR=/tmp/b \
      bash "$CONNECT" --dry-run </dev/null)
contains "arm64 arch line"  "$out" "arch: arm64"
contains "latest url"       "$out" "https://github.com/o/r/releases/latest/download/termgw-linux-arm64"

# --- unsupported arch errors ---
if UNAME_M=mips64 CANVAS_URL=x CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
   ENV_FILE=/nonexistent bash "$CONNECT" --dry-run </dev/null >/dev/null 2>&1; then
  echo "FAIL - unsupported arch should exit non-zero"; fail=1
else echo "ok   - unsupported arch errors"; fi

# --- label defaults to CODESPACE_NAME when unset ---
out=$(UNAME_M=x86_64 CANVAS_URL=x CF_ACCESS_CLIENT_ID=i CF_ACCESS_CLIENT_SECRET=s \
      CODESPACE_NAME=my-space TERMGW_VERSION=latest RELEASE_REPO=o/r \
      ENV_FILE=/nonexistent BIN_DIR=/tmp/b bash "$CONNECT" --dry-run </dev/null)
contains "label default from CODESPACE_NAME" "$out" "label: my-space"

# --- verify_sha256 helper (sourced) ---
# Sourcing re-applies connect.sh's `set -e`; disable it again so a failed
# assertion below reports instead of aborting the test. The BASH_SOURCE guard
# keeps main() from running on source.
source "$CONNECT"
set +e
tmpf=$(mktemp); printf 'hello' > "$tmpf"
want=$(printf 'hello' | sha256sum | awk '{print $1}')
if verify_sha256 "$tmpf" "$want"; then echo "ok   - sha256 match"; else echo "FAIL - sha256 match"; fail=1; fi
if verify_sha256 "$tmpf" "deadbeef"; then echo "FAIL - sha256 mismatch not caught"; fail=1; else echo "ok   - sha256 mismatch"; fi
rm -f "$tmpf"

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
