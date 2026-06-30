
# --- EnsembleWorks gh helper (__ew_gh_helper) ---
# Wrap the GitHub CLI so it authenticates as the ensembleworks[bot] App without you
# handling the key: each call mints a fresh ~1h installation token via the sudo
# wrapper (the sandbox user can't read the App key) and passes it through GH_TOKEN.
# Re-mints per call so it never goes stale (~½s/call for the JWT exchange); for many
# calls in a row, `export GH_TOKEN="$(sudo -u ensembleworks ensembleworks-gh-token)"`
# once and use `command gh`. Appended (idempotently) by deploy/deploy.sh.
if command -v gh >/dev/null 2>&1; then
	gh() { GH_TOKEN="$(sudo -u ensembleworks ensembleworks-gh-token)" command gh "$@"; }
fi
# --- end EnsembleWorks gh helper ---
