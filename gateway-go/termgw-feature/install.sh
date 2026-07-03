#!/usr/bin/env bash
# Devcontainer feature installer: runs at image build as root, with this
# feature's files as the working directory.
set -euo pipefail

if ! command -v tmux >/dev/null; then
	apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*
fi

install -D -m 0755 ./dist/termgw /usr/local/bin/termgw
install -D -m 0755 ./termgw-supervisor.sh /usr/local/share/termgw/termgw-supervisor.sh
# Optional tmux conf: ship the repo conf when present beside the feature.
if [ -f ./tmux.conf ]; then
	install -D -m 0644 ./tmux.conf /usr/local/share/termgw/tmux.conf
fi
echo "termgw feature installed"
