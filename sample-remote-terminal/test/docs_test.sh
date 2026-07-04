#!/usr/bin/env bash
# tmux.conf parses, and README documents the connect flow.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
fail=0
ok() { echo "ok   - $1"; }
no() { echo "FAIL - $1"; fail=1; }

# tmux can load the config without error (isolated server + socket).
if tmux -L smpltest -f "$ROOT/tmux.conf" start-server \; kill-server 2>/tmp/tmuxerr; then
  ok "tmux.conf loads"
else
  no "tmux.conf failed to load: $(cat /tmp/tmuxerr)"
fi

# README covers the essentials.
for needle in "Codespaces" "./connect.sh" "CANVAS_URL" "Cloudflare Access"; do
  if grep -qi "$needle" "$ROOT/README.md"; then ok "README mentions $needle"; else no "README missing $needle"; fi
done

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
