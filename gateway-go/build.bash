#!/usr/bin/env bash
# Build the static termgw binary into the feature's dist/ so a local
# devcontainer feature can install it without a Go toolchain in the image.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p termgw-feature/dist
CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" go build -trimpath -o termgw-feature/dist/termgw .
cp ../deploy/tmux-ensembleworks.conf termgw-feature/tmux.conf
echo "built termgw-feature/dist/termgw ($(du -h termgw-feature/dist/termgw | cut -f1))"
# Stage the feature next to the devcontainer config so the CLI can resolve it.
rm -rf devcontainer/.devcontainer/termgw-feature
cp -r termgw-feature devcontainer/.devcontainer/termgw-feature
