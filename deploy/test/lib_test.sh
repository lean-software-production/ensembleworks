#!/usr/bin/env bash
# Zero-dependency unit tests for deploy/lib.sh pure helpers.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib.sh
. "${HERE}/../lib.sh"

fail=0
eq() { if [ "$1" = "$2" ]; then echo "ok  : $3"; else
	echo "FAIL: $3 (got '$1' want '$2')"
	fail=1
fi; }
yes() { if "$@" >/dev/null 2>&1; then echo "ok  : $*"; else
	echo "FAIL: expected pass: $*"
	fail=1
fi; }
no() { if "$@" >/dev/null 2>&1; then
	echo "FAIL: expected fail: $*"
	fail=1
else echo "ok  : !($*)"; fi; }

# extract_version: first MAJOR.MINOR[.PATCH] token
eq "$(extract_version 'v22.22.3')" "22.22.3" "node -v"
eq "$(extract_version 'cloudflared version 2024.6.1 (built 2024-...)')" "2024.6.1" "cloudflared"
eq "$(extract_version 'tmux 3.3a')" "3.3" "tmux"
eq "$(extract_version 'git version 2.39.5')" "2.39.5" "git"
eq "$(extract_version 'no digits here')" "" "no version"

# version_ge A B  -> 0 (true) iff A >= B
yes version_ge 2.8.1 2.8.0
yes version_ge 2.8.0 2.8.0
yes version_ge 22.22.3 22.22.3
no version_ge 2.7.9 2.8.0
no version_ge 22.21.0 22.22.3

# check_constraint name constraint required found
yes check_constraint node exact 22.22.3 22.22.3
no check_constraint node exact 22.22.3 22.21.0
yes check_constraint caddy min 2.7.0 2.8.1
no check_constraint caddy min 2.7.0 2.6.0
yes check_constraint cc present - anything
no check_constraint cc present - ""

echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
