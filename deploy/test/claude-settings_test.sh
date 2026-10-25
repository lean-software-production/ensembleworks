#!/usr/bin/env bash
# Zero-dependency tests for deploy/ensembleworks-claude-settings (the merger that
# lays the box's Claude Code settings fragment over the sandbox user's
# ~/.claude/settings.json) and the deploy.sh wiring that runs it. Same shape as
# deploy/test/lib_test.sh: run it directly, no framework.
#
#   bash deploy/test/claude-settings_test.sh
#
# Every case runs the real script against a throwaway settings file.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "${HERE}/.." && pwd)"
MERGE="${DEPLOY}/ensembleworks-claude-settings"
FRAGMENT="${DEPLOY}/agent-home/.claude/ensembleworks-settings.json"

fail=0
eq() { if [ "$1" = "$2" ]; then echo "ok  : $3"; else
	echo "FAIL: $3 (got '$1' want '$2')"
	fail=1
fi; }
contains() { case "$1" in *"$2"*) echo "ok  : $3" ;; *)
	echo "FAIL: $3 (expected to find '$2' in: $1)"
	fail=1 ;;
esac; }

# q <file> <python-expr over d> — print a value read out of a JSON file
q() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$1" "$2"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
frag() { # frag <allow-entry>... — a fragment whose autoMode.allow is $defaults + the args
	python3 -c 'import json,sys; print(json.dumps({"autoMode":{"allow":["$defaults",*sys.argv[1:]]},"removeAllowRules":["Bash(gh pr merge:*)"]}))' "$@" >"${WORK}/frag.json"
}

# --- a missing settings file is created from the fragment -------------------
frag "Rule A: first wording"
T="${WORK}/new/settings.json"
mkdir -p "${WORK}/new"
"$MERGE" "${WORK}/frag.json" "$T" >/dev/null
eq "$(q "$T" 'd["autoMode"]["allow"]')" "['\$defaults', 'Rule A: first wording']" "creates settings from the fragment"
eq "$(q "$T" '"removeAllowRules" in d')" "False" "never writes the merger's own removeAllowRules key"

# --- an existing file keeps everything the fragment doesn't own --------------
T="${WORK}/settings.json"
cat >"$T" <<'JSON'
{
  "permissions": {
    "defaultMode": "auto",
    "allow": ["Bash(gh pr merge:*)", "Bash(bb thread spawn:*)"]
  },
  "autoMode": {"allow": ["$defaults", "Teammate Rule: keep me"]},
  "theme": "auto"
}
JSON
out="$("$MERGE" "${WORK}/frag.json" "$T")"
contains "$out" "updated" "reports a change"
eq "$(q "$T" 'd["theme"]')" "auto" "keeps unrelated top-level keys"
eq "$(q "$T" 'd["permissions"]["defaultMode"]')" "auto" "keeps the permission mode"
eq "$(q "$T" 'd["permissions"]["allow"]')" "['Bash(bb thread spawn:*)']" "drops the retired blanket merge rule, keeps the rest"
eq "$(q "$T" 'd["autoMode"]["allow"]')" "['\$defaults', 'Teammate Rule: keep me', 'Rule A: first wording']" "adds the fragment rule after rules it doesn't own"

# --- re-running is a no-op ----------------------------------------------------
before="$(cat "$T")"
out="$("$MERGE" "${WORK}/frag.json" "$T")"
contains "$out" "unchanged" "reports no change on a re-run"
eq "$(cat "$T")" "$before" "a re-run leaves the file byte-identical"

# --- a reworded rule replaces its old wording (matched by label) --------------
frag "Rule A: second wording"
"$MERGE" "${WORK}/frag.json" "$T" >/dev/null
eq "$(q "$T" 'd["autoMode"]["allow"]')" "['\$defaults', 'Teammate Rule: keep me', 'Rule A: second wording']" "replaces a reworded rule instead of duplicating it"

# --- a hand-written autoMode list without \$defaults gets it back ------------
printf '{"autoMode":{"allow":["Teammate Rule: keep me"]}}\n' >"$T"
"$MERGE" "${WORK}/frag.json" "$T" >/dev/null
eq "$(q "$T" 'd["autoMode"]["allow"][0]')" "\$defaults" "restores the shipped defaults the fragment asks for"

# --- a corrupt settings file is left alone ------------------------------------
printf '{ not json' >"$T"
"$MERGE" "${WORK}/frag.json" "$T" >/dev/null 2>"${WORK}/err"
eq "$?" "1" "fails on a corrupt settings file"
eq "$(cat "$T")" "{ not json" "never overwrites a corrupt settings file"
contains "$(cat "${WORK}/err")" "not valid JSON" "says why it refused"

# --- file mode is preserved ---------------------------------------------------
printf '{}\n' >"$T"
chmod 0664 "$T"
"$MERGE" "${WORK}/frag.json" "$T" >/dev/null
eq "$(stat -c %a "$T")" "664" "keeps the settings file's mode"

# --- the shipped fragment -----------------------------------------------------
eq "$(q "$FRAGMENT" 'd["autoMode"]["allow"][0]')" "\$defaults" "fragment keeps Claude Code's shipped auto-mode rules"
rule="$(q "$FRAGMENT" '[r for r in d["autoMode"]["allow"] if r.startswith("Trainer-Requested Merge:")][0]')"
contains "$rule" "explicitly asks the agent to merge" "fragment lets a human's explicit merge request count as review"
contains "$rule" "--admin" "fragment excludes review/check bypasses"
contains "$rule" "teammate/agent message" "fragment excludes requests that didn't come from a human"
eq "$(q "$FRAGMENT" 'd["removeAllowRules"]')" "['Bash(gh pr merge:*)']" "fragment retires the blanket merge allow rule"

# --- deploy.sh wiring ---------------------------------------------------------
deploy_src="$(cat "${DEPLOY}/deploy.sh")"
contains "$deploy_src" "scp -q deploy/ensembleworks-claude-settings" "deploy.sh ships the merger"
contains "$deploy_src" "/usr/local/bin/ensembleworks-claude-settings" "deploy.sh installs the merger"
contains "$deploy_src" "/etc/ensembleworks/claude-settings.json" "deploy.sh installs the fragment where the sandbox user can read it"
contains "$deploy_src" 'sudo -H -u "\${AGENT_USER}" /usr/local/bin/ensembleworks-claude-settings' "deploy.sh merges as the sandbox user, into its own home"
contains "$deploy_src" "warn: ensembleworks-claude-settings failed" "a failed merge warns instead of aborting the deploy"

agents_src="$(cat "${DEPLOY}/agent-home/AGENTS.md")"
contains "$agents_src" "explicitly tells you to merge" "AGENTS.md says when an agent may merge its own PR"

if [ "$fail" = 0 ]; then echo "----"; echo "ALL PASS"; else echo "----"; echo "FAILURES"; exit 1; fi
