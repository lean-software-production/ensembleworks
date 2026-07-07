#!/usr/bin/env bash
# ensembleworks-cli feature entrypoint. The devcontainer CLI chains feature
# entrypoints ahead of the container's main command, so this runs as part of the
# container's persistent init (unlike a postStartCommand daemon, which the CLI
# reaps when its exec returns). Launch the connector supervisor in the
# background, then exec the original command so the container behaves normally.
set -u

# Liveness check (not a flag file): /tmp survives `docker stop`/`start` but the
# processes do not, so a flag would leave the connector dead after a restart.
# Idempotent if the entrypoint is re-invoked live.
if ! pgrep -f ensembleworks-connect/supervisor.sh >/dev/null 2>&1; then
	setsid /usr/local/share/ensembleworks-connect/supervisor.sh \
		>>/tmp/ensembleworks-connect.log 2>&1 </dev/null &
fi

exec "$@"
