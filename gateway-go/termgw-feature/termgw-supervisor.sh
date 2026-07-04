#!/usr/bin/env bash
# Restart-on-exit supervisor for termgw (spike-grade; systemd is not available
# inside devcontainers). Config is baked into /etc/termgw.env at feature-install
# time from the feature options — no reliance on remoteEnv reaching this
# backgrounded process.
set -u
[ -f /etc/termgw.env ] && . /etc/termgw.env
export CANVAS_URL GATEWAY_LABEL GATEWAY_ID TMUX_CONF
# Fail loudly once instead of an infinite 2s crash loop when unconfigured.
if [ -z "${CANVAS_URL:-}" ]; then
	echo "[termgw-supervisor] CANVAS_URL unset — set the 'canvasUrl' feature option" >&2
	exit 1
fi
while true; do
	/usr/local/bin/termgw
	echo "[termgw-supervisor] termgw exited ($?), restarting in 2s" >&2
	sleep 2
done
