#!/usr/bin/env bash
# Devcontainer initializeCommand — runs on the HOST before the container is
# created (cwd = the workspace folder). Detects this host's primary LAN IP and
# writes it to the git-ignored .local backing store, which post-create.bash
# symlinks into the container as ~/.config/ensembleworks/host-lan-ip. bin/dev
# reads it as LiveKit's --node-ip so the SFU advertises a browser-reachable
# media address — that's what makes voice work from another machine on the LAN.
#
# Best-effort by design: if it can't determine an IP (no default route, an
# unfamiliar OS), it writes nothing and bin/dev falls back to 127.0.0.1
# (localhost-only voice). It must never fail container creation.
set -u

dir=".local/config/ensembleworks"
mkdir -p "$dir" 2>/dev/null || exit 0

ip=""
if command -v ip >/dev/null 2>&1; then
	# Linux: the source address of the route toward a public IP is this host's
	# primary LAN address (no packet is sent).
	ip=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')
elif command -v route >/dev/null 2>&1; then
	# macOS: resolve the default-route interface, then its IPv4 address.
	dev=$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/{print $2}')
	[ -n "$dev" ] && ip=$(ipconfig getifaddr "$dev" 2>/dev/null || true)
fi

if [ -n "$ip" ]; then
	printf '%s\n' "$ip" >"$dir/host-lan-ip"
	echo "detect-lan-ip: LiveKit node_ip -> $ip (LAN voice)"
else
	rm -f "$dir/host-lan-ip" 2>/dev/null || true
	echo "detect-lan-ip: no LAN IP found; voice stays localhost-only (127.0.0.1)"
fi
exit 0
