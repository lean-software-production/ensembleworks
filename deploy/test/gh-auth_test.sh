#!/usr/bin/env bash
# Zero-dependency tests for the EW25 GitHub-auth scripts and the deploy.sh
# wiring that installs them. Same shape as deploy/test/lib_test.sh: run it
# directly, no framework.
#
#   bash deploy/test/gh-auth_test.sh
#
# Every case runs the real script against a throwaway HOME and a stub PATH, so
# nothing here mints a real token or touches the box's git config.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "${HERE}/.." && pwd)"
FAKE_TOKEN="ghs_FAKE0000000000000000000000000000"

fail=0
eq() { if [ "$1" = "$2" ]; then echo "ok  : $3"; else
	echo "FAIL: $3 (got '$1' want '$2')"
	fail=1
fi; }
contains() { case "$1" in *"$2"*) echo "ok  : $3" ;; *)
	echo "FAIL: $3 (expected to find '$2' in: $1)"
	fail=1 ;;
esac; }
lacks() { case "$1" in *"$2"*)
	echo "FAIL: $3 (unexpectedly found '$2')"
	fail=1 ;;
*) echo "ok  : $3" ;;
esac; }

# stubs <reported-user> <ok|fail>
#   $SANDBOX/bin/id    -un  -> <reported-user>
#   $SANDBOX/bin/sudo  -n -l -> a fake NOPASSWD rule naming the token wrapper
#                      else  -> FAKE_TOKEN (ok) or exit 1 (fail)
#   $SANDBOX/bin/gh          -> echoes its args and the GH_TOKEN it was handed
#   $MINTLOG                 -> one line per sudo call, so a case can assert
#                               that NO mint was attempted
SANDBOX=""
MINTLOG=""
stubs() {
	[ -n "$SANDBOX" ] && rm -rf "$SANDBOX"
	SANDBOX="$(mktemp -d)"
	MINTLOG="${SANDBOX}/mints"
	: >"$MINTLOG"
	mkdir -p "${SANDBOX}/bin" "${SANDBOX}/home"
	cat >"${SANDBOX}/bin/id" <<STUB
#!/bin/sh
if [ "\$1" = "-un" ]; then echo "$1"; exit 0; fi
exec /usr/bin/id "\$@"
STUB
	{
		echo '#!/bin/sh'
		echo "echo \"\$*\" >>\"${MINTLOG}\""
		echo 'case " $* " in *" -l "*) echo "    (ensembleworks) NOPASSWD: /usr/local/bin/ensembleworks-gh-token"; exit 0 ;; esac'
		if [ "$2" = "ok" ]; then
			echo "echo \"${FAKE_TOKEN}\""
		else
			echo 'echo "ensembleworks-gh-token: github-app.env missing" >&2; exit 1'
		fi
	} >"${SANDBOX}/bin/sudo"
	cat >"${SANDBOX}/bin/gh" <<'STUB'
#!/bin/sh
echo "gh args: $*"
echo "gh token: ${GH_TOKEN:-<none>}"
STUB
	chmod +x "${SANDBOX}/bin/id" "${SANDBOX}/bin/sudo" "${SANDBOX}/bin/gh"
}
trap '[ -n "$SANDBOX" ] && rm -rf "$SANDBOX"' EXIT

# run_helper <op> <stdin-block>  — the credential helper under the stub PATH
run_helper() {
	printf '%s' "$2" | PATH="${SANDBOX}/bin:${PATH}" HOME="${SANDBOX}/home" \
		bash "${DEPLOY}/git-credential-ensembleworks" "$1" 2>&1
}

# --- git-credential-ensembleworks ------------------------------------------

stubs ensembleworks-agent ok
eq "$(run_helper get 'protocol=https
host=github.com

')" "username=x-access-token
password=${FAKE_TOKEN}" "helper answers github.com for the agent user"

eq "$(run_helper get 'protocol=https
host=example.com

')" "" "helper declines a non-github host"

eq "$(run_helper get 'protocol=http
host=github.com

')" "" "helper declines a non-https protocol"

eq "$(run_helper store 'protocol=https
host=github.com

')" "" "helper ignores the store operation"

eq "$(run_helper erase 'protocol=https
host=github.com

')" "" "helper ignores the erase operation"

stubs someone-else ok
eq "$(run_helper get 'protocol=https
host=github.com

')" "" "helper declines for a non-agent user"

stubs ensembleworks-agent fail
eq "$(run_helper get 'protocol=https
host=github.com

')" "" "helper declines (exit 0, silent) when the mint fails"

# --- gh shim ----------------------------------------------------------------

# run_shim — the shim with the stub gh as its exec target
run_shim() {
	PATH="${SANDBOX}/bin:${PATH}" HOME="${SANDBOX}/home" \
		EW_GH_REAL="${SANDBOX}/bin/gh" bash "${DEPLOY}/gh-shim" "$@" 2>&1
}

stubs someone-else ok
out="$(run_shim api /rate_limit)"
contains "$out" "gh token: <none>" "shim leaves a non-agent user's gh unauthenticated"
contains "$out" "gh args: api /rate_limit" "shim passes arguments through untouched"
eq "$(wc -l <"$MINTLOG")" "0" "shim mints nothing for a non-agent user"

stubs ensembleworks-agent ok
out="$(GH_TOKEN=caller-chose-this run_shim api /rate_limit)"
contains "$out" "gh token: caller-chose-this" "shim never overrides an explicit GH_TOKEN"
eq "$(wc -l <"$MINTLOG")" "0" "shim mints nothing when GH_TOKEN is already set"

stubs ensembleworks-agent ok
out="$(GITHUB_TOKEN=caller-chose-this run_shim api /rate_limit)"
eq "$(wc -l <"$MINTLOG")" "0" "shim mints nothing when GITHUB_TOKEN is already set"

# With the helper wired into the throwaway HOME's gitconfig, the shim must reach
# the token through `git credential fill` — the same path git itself uses.
stubs ensembleworks-agent ok
git config --file "${SANDBOX}/home/.gitconfig" \
	--add credential.https://github.com.helper "${DEPLOY}/git-credential-ensembleworks"
out="$(run_shim api /rate_limit)"
contains "$out" "gh token: ${FAKE_TOKEN}" "shim takes its token from git credential fill"

stubs ensembleworks-agent fail
git config --file "${SANDBOX}/home/.gitconfig" \
	--add credential.https://github.com.helper "${DEPLOY}/git-credential-ensembleworks"
out="$(run_shim api /rate_limit)"
contains "$out" "gh token: <none>" "shim falls through unauthenticated when minting fails"

# --- ensembleworks-gh-token: org-wide only ----------------------------------

out="$(bash "${DEPLOY}/ensembleworks-gh-token" somerepo 2>&1)"
rc=$?
eq "$rc" "2" "token wrapper exits 2 for any argument"
contains "$out" "repo scoping removed" "token wrapper says scoping is gone"
lacks "$out" "ghs_" "token wrapper prints no token when refusing"

exit "$fail"
