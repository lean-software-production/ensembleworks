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
[ "$df" = "Dockerfile" ] && ok "build.dockerfile == Dockerfile" || no "build.dockerfile (got: $df)"

# A hint mentioning connect.sh is present somewhere in the config.
grep -q 'connect.sh' "$ROOT/.devcontainer/devcontainer.json" && ok "connect.sh hint present" || no "connect.sh hint missing"

# .gitignore excludes the secret cache and the downloaded binary.
grep -qx '/.termgw.env' "$ROOT/.gitignore" && ok ".gitignore has /.termgw.env" || no ".gitignore missing /.termgw.env"
grep -qx '/bin/'        "$ROOT/.gitignore" && ok ".gitignore has /bin/"        || no ".gitignore missing /bin/"

[ "$fail" -eq 0 ] && echo "PASS" || echo "SOME TESTS FAILED"
exit "$fail"
