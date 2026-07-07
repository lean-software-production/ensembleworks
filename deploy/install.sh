#!/usr/bin/env bash
set -euo pipefail
REPO="lean-software-production/ensembleworks"
VER="${ENSEMBLEWORKS_VERSION:-latest}"
case "$(uname -s)-$(uname -m)" in
Linux-x86_64) A=linux-x64 ;;
Linux-aarch64) A=linux-arm64 ;;
Darwin-arm64) A=darwin-arm64 ;;
*) echo "unsupported platform $(uname -sm)" >&2; exit 1 ;;
esac
base="https://github.com/$REPO/releases/latest/download"
[ "$VER" = latest ] || base="https://github.com/$REPO/releases/download/v$VER"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/ensembleworks-$A" -o "$tmp/ew"
curl -fsSL "$base/ensembleworks-checksums.txt" -o "$tmp/sums"
(cd "$tmp" && grep " ensembleworks-$A\$" sums | sed "s/ensembleworks-$A/ew/" | sha256sum -c -)
install -D -m0755 "$tmp/ew" "$HOME/.local/bin/ensembleworks"
ln -f "$HOME/.local/bin/ensembleworks" "$HOME/.local/bin/ew"
echo "installed ensembleworks ($A) -> ~/.local/bin (ew hardlink). Next: ensembleworks auth login"
