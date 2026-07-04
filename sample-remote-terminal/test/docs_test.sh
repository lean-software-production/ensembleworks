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
  grep -qi "$needle" "$ROOT/README.md" && ok "README mentions $needle" || no "README missing $needle"
done

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
