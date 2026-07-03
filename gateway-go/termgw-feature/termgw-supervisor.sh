#!/usr/bin/env bash
# Restart-on-exit supervisor for termgw (spike-grade; systemd is not
# available inside devcontainers). CANVAS_URL etc. come from remoteEnv.
set -u
while true; do
	/usr/local/bin/termgw
	echo "[termgw-supervisor] termgw exited ($?), restarting in 2s" >&2
	sleep 2
done
