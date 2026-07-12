#!/usr/bin/env bash
# Devcontainer post-create: back the home-dir state/config paths (the
# interface every doc and server uses) with the git-ignored .local/ folder in
# the workspace, so canvas SQLite, uploads and dev.env survive container
# rebuilds — the workspace is the one thing local devcontainers AND
# Codespaces both persist. Then install deps.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$repo/.local/share/ensembleworks" "$repo/.local/config/ensembleworks"
mkdir -p "$HOME/.local/share" "$HOME/.config"
ln -sfn "$repo/.local/share/ensembleworks" "$HOME/.local/share/ensembleworks"
ln -sfn "$repo/.local/config/ensembleworks" "$HOME/.config/ensembleworks"

# Offset stacks (ENSEMBLEWORKS_PORT_OFFSET, containerEnv-stamped; '' or '0' both
# mean "no offset") get the same persistence for their own data dir.
if [ -n "${ENSEMBLEWORKS_PORT_OFFSET:-}" ] && [ "${ENSEMBLEWORKS_PORT_OFFSET:-0}" != "0" ]; then
	mkdir -p "$repo/.local/share/ensembleworks-$ENSEMBLEWORKS_PORT_OFFSET"
	ln -sfn "$repo/.local/share/ensembleworks-$ENSEMBLEWORKS_PORT_OFFSET" "$HOME/.local/share/ensembleworks-$ENSEMBLEWORKS_PORT_OFFSET"
fi

cd "$repo"
bun install
bin/dev doctor || true   # informational on first build — shows what's lit up
