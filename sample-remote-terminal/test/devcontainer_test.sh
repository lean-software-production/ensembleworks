#!/usr/bin/env bash
# Validates devcontainer.json and .gitignore without launching a container.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
fail=0
ok() { echo "ok   - $1"; }
no() { echo "FAIL - $1"; fail=1; }

# devcontainer.json parses as JSON and points at the Dockerfile.
df=$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.build&&c.build.dockerfile))' \
      "$ROOT/.devcontainer/devcontainer.json" 2>/dev/null)
if [ "$df" = "Dockerfile" ]; then ok "build.dockerfile == Dockerfile"; else no "build.dockerfile (got: $df)"; fi

# A hint mentioning connect.sh is present somewhere in the config.
if grep -q 'connect.sh' "$ROOT/.devcontainer/devcontainer.json"; then ok "connect.sh hint present"; else no "connect.sh hint missing"; fi

# .gitignore excludes the secret cache and the downloaded binary.
if grep -qx '/.termgw.env' "$ROOT/.gitignore"; then ok ".gitignore has /.termgw.env"; else no ".gitignore missing /.termgw.env"; fi
if grep -qx '/bin/'        "$ROOT/.gitignore"; then ok ".gitignore has /bin/";        else no ".gitignore missing /bin/"; fi

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
