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
		case "$2" in
		norule)
			echo 'case " $* " in *" -l "*) echo "    (root) NOPASSWD: /usr/local/bin/something-else"; exit 0 ;; esac'
			;;
		*)
			echo 'case " $* " in *" -l "*) echo "    (ensembleworks) NOPASSWD: /usr/local/bin/ensembleworks-gh-token"; exit 0 ;; esac'
			;;
		esac
		case "$2" in
		ok) echo "echo \"${FAKE_TOKEN}\"" ;;
		fail) echo 'echo "ensembleworks-gh-token: github-app.env missing" >&2; exit 1' ;;
		generic-fail) echo 'echo "ensembleworks-gh-token: mint failed: 500 from GitHub" >&2; exit 1' ;;
		norule) echo 'exit 1' ;;
		esac
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

# --- ensembleworks-gh-doctor -------------------------------------------------

DOCTOR="${DEPLOY}/ensembleworks-gh-doctor"

run_doctor() {
	PATH="${SANDBOX}/bin:${PATH}" HOME="${SANDBOX}/home" bash "${DOCTOR}" "$@" 2>&1
}

# green_stubs — checks 1-5 all pass: real credential helper wired in, minting
# stubbed to succeed. A "git" stub forwards everything except ls-remote to the
# real git, so config/credential-fill behave exactly as in production; only
# ls-remote (network) is faked, via EW_TEST_LS_REMOTE_MODE.
green_stubs() {
	stubs ensembleworks-agent ok
	cat >"${SANDBOX}/bin/git" <<STUB
#!/bin/sh
if [ "\$1" = "ls-remote" ]; then
	case "\${EW_TEST_LS_REMOTE_MODE:-ok}" in
	ok) echo "abc123 HEAD"; exit 0 ;;
	404) echo "remote: Repository not found." >&2; echo "fatal: repository not found" >&2; exit 128 ;;
	403) echo "remote: Bad credentials." >&2; echo "fatal: Authentication failed" >&2; exit 128 ;;
	esac
fi
exec /usr/bin/git "\$@"
STUB
	chmod +x "${SANDBOX}/bin/git"
	cat >"${SANDBOX}/bin/gh" <<STUB
#!/bin/sh
if [ "\$1" = "api" ]; then
	case "\${EW_TEST_GH_API_MODE:-ok}" in
	ok) echo "lean-software-production/ensembleworks"; exit 0 ;;
	fail) echo "gh: HTTP 403" >&2; exit 1 ;;
	esac
fi
echo "gh stub: unexpected args \$*" >&2
exit 1
STUB
	chmod +x "${SANDBOX}/bin/gh"
	git config --file "${SANDBOX}/home/.gitconfig" \
		--add credential.https://github.com.helper "cache --timeout=2700"
	git config --file "${SANDBOX}/home/.gitconfig" \
		--add credential.https://github.com.helper "${DEPLOY}/git-credential-ensembleworks"
}

run_green_doctor() {
	EW_GH_DOCTOR_HELPER_PATH="${DEPLOY}/git-credential-ensembleworks" \
		EW_GH_DOCTOR_GH_BIN="${SANDBOX}/bin/gh" run_doctor "$@"
}

# --- check 1: invoking user --------------------------------------------------

stubs someone-else ok
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "wrong user: exits non-zero"
contains "$out" "auth is provisioned for" "wrong user: names the provisioned user"
contains "$out" "you are \`someone-else\`" "wrong user: names the actual user"

# --- check 2: sudoers rule ---------------------------------------------------

stubs ensembleworks-agent norule
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "missing sudoers rule: exits non-zero"
contains "$out" "NOPASSWD sudoers rule missing" "missing sudoers rule: names the cause"
contains "$out" "deploy/github-app-runbook.md" "missing sudoers rule: points at the runbook"

# --- check 3: token mint -----------------------------------------------------

stubs ensembleworks-agent fail
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "app not provisioned: exits non-zero"
contains "$out" "App not provisioned on this box" "app not provisioned: names the cause"
lacks "$out" "$FAKE_TOKEN" "app not provisioned: never prints a token"

stubs ensembleworks-agent generic-fail
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "generic mint error: exits non-zero"
contains "$out" "500 from GitHub" "generic mint error: surfaces the underlying error"
lacks "$out" "App not provisioned on this box" "generic mint error: distinct from the env-missing diagnosis"

# --- check 4: credential helper configured in ~/.gitconfig ------------------
#
# EW_GH_DOCTOR_HELPER_PATH is a test seam mirroring gh-shim's EW_GH_REAL: it
# lets a case point the "expected helper" check at a sandboxed script instead
# of the real /usr/local/bin/git-credential-ensembleworks.

stubs ensembleworks-agent ok
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "no helper configured: exits non-zero"
contains "$out" "credential helper not configured in ~/.gitconfig" "no helper configured: names the cause"

stubs ensembleworks-agent ok
git config --file "${SANDBOX}/home/.gitconfig" \
	--add credential.https://github.com.helper "/usr/local/bin/some-old-helper"
out="$(run_doctor)"
rc=$?
eq "$rc" "1" "stale helper only: exits non-zero"
contains "$out" "some-old-helper" "stale helper only: names the stale helper it found"

# --- check 5: git credential fill returns a password -------------------------
#
# A helper that's configured but returns nothing (e.g. a stale binary that
# silently declines everything) must be distinguished from "not configured"
# (check 4) — the fix is different (redeploy the helper vs. reseed gitconfig).

stubs ensembleworks-agent ok
cat >"${SANDBOX}/bin/broken-helper" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "${SANDBOX}/bin/broken-helper"
git config --file "${SANDBOX}/home/.gitconfig" \
	--add credential.https://github.com.helper "cache --timeout=2700"
git config --file "${SANDBOX}/home/.gitconfig" \
	--add credential.https://github.com.helper "${SANDBOX}/bin/broken-helper"
out="$(EW_GH_DOCTOR_HELPER_PATH="${SANDBOX}/bin/broken-helper" run_doctor)"
rc=$?
eq "$rc" "1" "helper returns nothing: exits non-zero"
contains "$out" "helper configured but returning nothing" "helper returns nothing: names the cause"

# --- check 6: git ls-remote against the repo ---------------------------------

green_stubs
out="$(EW_TEST_LS_REMOTE_MODE=404 run_green_doctor)"
rc=$?
eq "$rc" "1" "ls-remote 404: exits non-zero"
contains "$out" "App not installed on that owner" "ls-remote 404: names the cause"

green_stubs
out="$(EW_TEST_LS_REMOTE_MODE=403 run_green_doctor)"
rc=$?
eq "$rc" "1" "ls-remote 403: exits non-zero"
contains "$out" "token rejected / expired" "ls-remote 403: names the cause"
lacks "$out" "App not installed on that owner" "ls-remote 403: distinct from the 404 diagnosis"

# --- check 7: gh is the shim, and the API call works -------------------------

green_stubs
# EW_GH_DOCTOR_HELPER_PATH but deliberately no EW_GH_DOCTOR_GH_BIN override, so
# the "expected gh" path stays the real /usr/local/bin/gh, which won't match
# the stub gh actually first on PATH.
out="$(EW_GH_DOCTOR_HELPER_PATH="${DEPLOY}/git-credential-ensembleworks" run_doctor)"
rc=$?
eq "$rc" "1" "different gh on PATH: exits non-zero"
contains "$out" "a different gh is earlier on PATH" "different gh on PATH: names the cause"
contains "$out" "${SANDBOX}/bin/gh" "different gh on PATH: names the offending path"

green_stubs
out="$(EW_TEST_GH_API_MODE=fail run_green_doctor)"
rc=$?
eq "$rc" "1" "gh api call fails: exits non-zero"
contains "$out" "gh authenticated but API call failed" "gh api call fails: names the cause"

# --- full success path -------------------------------------------------------

green_stubs
out="$(run_green_doctor)"
rc=$?
eq "$rc" "0" "all checks pass: exits zero"
contains "$out" "all checks passed" "all checks pass: says so"
lacks "$out" "$FAKE_TOKEN" "all checks pass: never prints the token value"

# --quiet: no passing-check noise when everything is fine.
green_stubs
out="$(run_green_doctor --quiet)"
rc=$?
eq "$rc" "0" "quiet + all pass: exits zero"
eq "$out" "" "quiet + all pass: prints nothing"

# --quiet still surfaces a failure.
stubs someone-else ok
out="$(run_doctor --quiet)"
rc=$?
eq "$rc" "1" "quiet + failure: still exits non-zero"
contains "$out" "auth is provisioned for" "quiet + failure: still names the cause"

# --- check 8: warn-only SSH-remote scan --------------------------------------

green_stubs
mkdir -p "${SANDBOX}/home/repos/myrepo"
git -C "${SANDBOX}/home/repos/myrepo" init -q
git -C "${SANDBOX}/home/repos/myrepo" remote add origin git@github.com:lean-software-production/myrepo.git
out="$(run_green_doctor)"
rc=$?
eq "$rc" "0" "SSH remote found: still exits zero (warn-only)"
contains "$out" "SSH remote bypasses credential helpers entirely" "SSH remote found: warns"
contains "$out" "myrepo" "SSH remote found: names the offending clone"

green_stubs
out="$(run_green_doctor)"
rc=$?
eq "$rc" "0" "no SSH remotes: exits zero"
lacks "$out" "SSH remote bypasses" "no SSH remotes: no warning printed"

exit "$fail"
