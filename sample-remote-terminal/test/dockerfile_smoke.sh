#!/usr/bin/env bash
# Builds the devcontainer image and asserts each baked tool is on PATH.
# Requires a local Docker daemon. Slow (image build): a few minutes cold.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG=sample-remote-terminal-test
docker build -t "$IMG" "$HERE/../.devcontainer"
run() { echo "== $1"; docker run --rm "$IMG" bash -lc "$1"; }
run 'tmux -V'
run 'nvim --version | head -1'
run 'node --version'
run 'rg --version | head -1'
run 'delta --version'
run 'command -v opencode'
run 'command -v pi'
echo "ALL TOOLS PRESENT"
