#!/usr/bin/env bash
# connect.sh — register this Codespace as a remote terminal on an EnsembleWorks
# canvas. Downloads the prebuilt termgw connector from a public GitHub release,
# verifies its checksum, then runs it against the canvas behind Cloudflare Access.
set -euo pipefail

# Resolve paths relative to this script, not the caller's CWD.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- overridable configuration -------------------------------------------------
RELEASE_REPO="${RELEASE_REPO:-lean-software-production/ensembleworks}"
TERMGW_VERSION="${TERMGW_VERSION:-latest}"   # a release tag (e.g. v0.9.0) or "latest"
BIN_DIR="${BIN_DIR:-./bin}"
ENV_FILE="${ENV_FILE:-./.termgw.env}"
UNAME_M="${UNAME_M:-$(uname -m)}"            # test seam

die() { echo "connect.sh: $*" >&2; exit 1; }

detect_arch() {
  case "$UNAME_M" in
    x86_64|amd64)  echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported architecture: $UNAME_M (need x86_64 or aarch64)" ;;
  esac
}

# asset_url NAME → full download URL for the pinned tag or the latest release.
asset_url() {
  local name="$1"
  if [ "$TERMGW_VERSION" = latest ]; then
    echo "https://github.com/$RELEASE_REPO/releases/latest/download/$name"
  else
    echo "https://github.com/$RELEASE_REPO/releases/download/$TERMGW_VERSION/$name"
  fi
}

# verify_sha256 FILE EXPECTED_HEX → exit 0 on match, 1 otherwise.
verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ]
}

# prompt_var VAR "text" [silent] — prompt only if VAR unset and stdin is a TTY.
prompt_var() {
  local var="$1" text="$2" silent="${3:-}" val
  [ -n "${!var:-}" ] && return 0
  [ -t 0 ] || die "$var is unset and no TTY to prompt (set it via env or $ENV_FILE)"
  if [ "$silent" = silent ]; then read -rsp "$text: " val; echo; else read -rp "$text: " val; fi
  # shellcheck disable=SC2059  # indirect assignment: $var is the variable name, not format string
  printf -v "$var" '%s' "$val"
}

write_env_file() {
  umask 077
  { echo "# saved by connect.sh — git-ignored"
    printf 'CANVAS_URL=%q\n' "$CANVAS_URL"
    printf 'CF_ACCESS_CLIENT_ID=%q\n' "$CF_ACCESS_CLIENT_ID"
    printf 'CF_ACCESS_CLIENT_SECRET=%q\n' "$CF_ACCESS_CLIENT_SECRET"
    printf 'GATEWAY_LABEL=%q\n' "$GATEWAY_LABEL"
  } > "$ENV_FILE"
  echo "wrote $ENV_FILE"
}

resolve_config() {
  # shellcheck source=/dev/null
  [ -f "$ENV_FILE" ] && . "$ENV_FILE"
  prompt_var CANVAS_URL "Canvas URL (https://…)"
  prompt_var CF_ACCESS_CLIENT_ID "CF Access Client ID"
  prompt_var CF_ACCESS_CLIENT_SECRET "CF Access Client Secret" silent
  GATEWAY_LABEL="${GATEWAY_LABEL:-${CODESPACE_NAME:-$(hostname)}}"
  if [ ! -f "$ENV_FILE" ] && [ -t 0 ]; then
    local ans; read -rp "Save these to $ENV_FILE for next time? [y/N] " ans
    case "${ans:-}" in y|Y) write_env_file ;; esac
  fi
}

download_termgw() {
  local arch bin url sums_url tmp sums expected
  arch="$(detect_arch)"
  bin="$BIN_DIR/termgw-$TERMGW_VERSION-$arch"
  [ -x "$bin" ] && { echo "$bin"; return 0; }
  mkdir -p "$BIN_DIR"
  url="$(asset_url "termgw-linux-$arch")"
  sums_url="$(asset_url termgw-checksums.txt)"
  tmp="$(mktemp)"; sums="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"       || { rm -f "$tmp" "$sums"; die "download failed (404?) for $url"; }
  curl -fsSL "$sums_url" -o "$sums" || { rm -f "$tmp" "$sums"; die "checksums download failed for $sums_url"; }
  expected="$(awk -v f="termgw-linux-$arch" '$2==f || $2=="*"f {print $1}' "$sums")"
  [ -n "$expected" ] || { rm -f "$tmp" "$sums"; die "no checksum for termgw-linux-$arch in $sums_url"; }
  verify_sha256 "$tmp" "$expected" || { rm -f "$tmp" "$sums"; die "checksum mismatch for $url — refusing to run"; }
  chmod +x "$tmp"; mv "$tmp" "$bin"; rm -f "$sums"
  echo "$bin"
}

main() {
  local dry=0
  [ "${1:-}" = --dry-run ] && dry=1
  resolve_config
  local arch url
  arch="$(detect_arch)"
  url="$(asset_url "termgw-linux-$arch")"
  if [ "$dry" -eq 1 ]; then
    printf 'canvas: %s\n' "$CANVAS_URL"
    printf 'label: %s\n' "$GATEWAY_LABEL"
    printf 'cf-id: %s\n' "$CF_ACCESS_CLIENT_ID"
    printf 'cf-secret: ***\n'
    printf 'arch: %s\n' "$arch"
    printf 'download: %s\n' "$url"
    printf 'would run: %s\n' "$BIN_DIR/termgw-$TERMGW_VERSION-$arch"
    return 0
  fi
  command -v tmux >/dev/null || die "tmux not found on PATH (the devcontainer image should provide it)"
  local bin; bin="$(download_termgw)"
  echo "starting termgw as '$GATEWAY_LABEL' → $CANVAS_URL (Ctrl-C to stop)"
  echo "  (a 403 here means the CF Access service-token pair is wrong or lacks a policy)"
  export CANVAS_URL CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET GATEWAY_LABEL
  export TMUX_CONF="$PWD/tmux.conf"
  export ENSEMBLEWORKS_TMUX_CONF="$PWD/tmux.conf"
  exec "$bin"
}

# Run main only when executed, not when sourced (so tests can call helpers).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
