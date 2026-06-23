#!/usr/bin/env bash
set -euo pipefail

# gh-app-token.bash — mint a short-lived GitHub App *installation* token for the
# EnsembleWorks bot. Prints the token (≈1h lifetime) to stdout.
#
# It signs a ≤10-min RS256 JWT with the App's private key, then exchanges it for
# an installation token (see ensembleworks/deploy/github-app-runbook.md). Use the
# token to push or call the GitHub API, e.g.:
#
#   TOKEN=$(./ensembleworks/bin/gh-app-token.bash)
#   git push "https://x-access-token:${TOKEN}@github.com/lean-software-production/ensembleworks.git" HEAD:my-branch
#
# Config comes from env vars, or a sourced env file (see --env / GITHUB_APP_ENV):
#   GITHUB_APP_ID                 (required)
#   GITHUB_APP_INSTALLATION_ID    (required)
#   GITHUB_APP_PRIVATE_KEY_FILE   path to the .pem   (or GITHUB_APP_PRIVATE_KEY = inline PEM)
#
# Flags:
#   --env FILE     source FILE first (default: $GITHUB_APP_ENV, else the deploy path if present)
#   --jwt-only     print the signed JWT and exit (no GitHub call) — for debugging/tests
#   --repos a,b    scope the token to specific repos (default: all the install can see)
#   -h | --help

DEFAULT_ENV="${GITHUB_APP_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/ensembleworks/github-app.env}"

die() { echo "gh-app-token: $*" >&2; exit 1; }

env_file="" jwt_only=0 repos=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2;;
    --jwt-only) jwt_only=1; shift;;
    --repos) repos="$2"; shift 2;;
    -h|--help) sed -n '3,30p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

# Source an env file if one was given or the default exists.
if [ -n "$env_file" ]; then
  [ -f "$env_file" ] || die "no such env file: $env_file"
  # shellcheck disable=SC1090
  set -a; . "$env_file"; set +a
elif [ -f "$DEFAULT_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$DEFAULT_ENV"; set +a
fi

: "${GITHUB_APP_ID:?set GITHUB_APP_ID (or provide --env)}"
: "${GITHUB_APP_INSTALLATION_ID:?set GITHUB_APP_INSTALLATION_ID (or provide --env)}"

# Resolve the private key into a temp file (supports inline or file).
pem=""
cleanup() { [ -n "${pem_tmp:-}" ] && rm -f "$pem_tmp"; return 0; }
trap cleanup EXIT
if [ -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" ]; then
  pem="$GITHUB_APP_PRIVATE_KEY_FILE"
  [ -f "$pem" ] || die "GITHUB_APP_PRIVATE_KEY_FILE not found: $pem"
elif [ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]; then
  pem_tmp="$(mktemp)"; printf '%s\n' "$GITHUB_APP_PRIVATE_KEY" > "$pem_tmp"; pem="$pem_tmp"
else
  die "set GITHUB_APP_PRIVATE_KEY_FILE or GITHUB_APP_PRIVATE_KEY"
fi

command -v openssl >/dev/null || die "openssl not on PATH"
command -v jq      >/dev/null || die "jq not on PATH"

# base64url (no padding) — used for the JWT segments and signature.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
# iat backdated 60s for clock skew; exp +9min (GitHub caps JWT lifetime at 10min).
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now-60))" "$((now+540))" "$GITHUB_APP_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$pem" -binary | b64url)
jwt="$header.$payload.$sig"

if [ "$jwt_only" = 1 ]; then printf '%s\n' "$jwt"; exit 0; fi

# Exchange the JWT for an installation token.
body="{}"
if [ -n "$repos" ]; then
  # turn a,b,c into a JSON array
  arr=$(printf '%s' "$repos" | jq -R 'split(",")')
  body=$(jq -n --argjson r "$arr" '{repositories: $r}')
fi

resp=$(curl -fsS -X POST \
  -H "Authorization: Bearer $jwt" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$body" \
  "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens") \
  || die "token request failed (check App ID, installation ID, and key)"

token=$(printf '%s' "$resp" | jq -r '.token // empty')
[ -n "$token" ] || die "no token in response: $resp"
printf '%s\n' "$token"
