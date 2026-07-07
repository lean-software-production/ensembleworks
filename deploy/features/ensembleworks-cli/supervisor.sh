#!/usr/bin/env bash
# Restart-on-exit supervisor for the ensembleworks connector (spike-grade;
# systemd is not available inside devcontainers). Config is baked into
# /etc/ensembleworks-connect.env at feature-install time from the feature
# options (URL/label/id, and optionally a token) — no reliance on remoteEnv
# reaching this backgrounded process. A token may instead arrive via the
# container's runtime env (spec §4); either way it is in this process's environment.
set -u

# Source the baked file KEY-BY-KEY, setting only keys NOT already in the
# environment — so a token rotated at container runtime (spec §4) always wins over
# a stale build-baked value. A plain `. file` would clobber runtime env with the
# baked value; this makes the baked file a fallback, not an override.
if [ -f /etc/ensembleworks-connect.env ]; then
	while IFS='=' read -r key val; do
		case "$key" in ''|'#'*) continue ;; esac   # skip blanks + the header comment
		[ -n "${!key:-}" ] && continue             # runtime value present — keep it
		val=${val#\'}; val=${val%\'}               # strip the single-quotes emit() added
		export "$key=$val"
	done < /etc/ensembleworks-connect.env
fi

# Fail loudly once instead of an infinite 2s crash loop when unconfigured.
if [ -z "${ENSEMBLEWORKS_URL:-}" ]; then
	echo "[ensembleworks-connect] ENSEMBLEWORKS_URL unset — set the 'url' feature option or inject it at runtime" >&2
	exit 1
fi

# label/gateway-id are FLAGS (no env form). Pass --label ONLY when non-empty:
# resolveConnectConfig uses `label = flags.label ?? hostname()`, so --label ""
# would set an EMPTY label, NOT fall back to hostname. Omitting the flag is what
# gives the hostname default. Likewise pass --gateway-id ONLY when pinned — an
# empty id lets the CLI derive its stable per-box id (spec §4.1).
args=(terminal connect)
[ -n "${EW_LABEL:-}" ] && args+=(--label "$EW_LABEL")
[ -n "${EW_GATEWAY_ID:-}" ] && args+=(--gateway-id "$EW_GATEWAY_ID")

while true; do
	ensembleworks "${args[@]}"
	echo "[ensembleworks-connect] connector exited ($?), restarting in 2s" >&2
	sleep 2
done
