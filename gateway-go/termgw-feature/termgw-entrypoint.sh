#!/usr/bin/env bash
# Devcontainer feature entrypoint. The devcontainer CLI chains feature
# entrypoints ahead of the container's main command, so this runs as part of
# the container's persistent init — unlike a postStartCommand daemon, which the
# CLI reaps when its exec returns. We launch the connector supervisor in the
# background, then exec the original command so the container behaves normally.
set -u

# Start the supervisor if it isn't already running. A liveness check (not a
# flag file) is deliberate: /tmp survives `docker stop`/`start` but the
# processes do not, so a flag would leave the gateway dead after the first
# restart. This launches once per container start and re-launches after a
# restart, while staying idempotent if the entrypoint is re-invoked live.
if ! pgrep -f termgw-supervisor.sh >/dev/null 2>&1; then
	setsid /usr/local/share/termgw/termgw-supervisor.sh >>/tmp/termgw.log 2>&1 </dev/null &
fi

exec "$@"
