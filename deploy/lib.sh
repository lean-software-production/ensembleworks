#!/usr/bin/env bash
# Sourceable helpers for deploy.sh. Pure functions only (no side effects) so they
# can be unit-tested by deploy/test/lib_test.sh. Do not run system commands here.

# extract_version <string> -> first MAJOR.MINOR[.PATCH] token, or empty.
extract_version() {
	printf '%s' "${1:-}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

# version_ge <a> <b> -> exit 0 iff a >= b (numeric, dotted; uses sort -V).
version_ge() {
	[ "$1" = "$2" ] && return 0
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
