#!/usr/bin/env bash
# Build an embed-capable t3code web bundle from pinned upstream.
#
# t3code (https://github.com/pingdotgg/t3code, MIT) is embedded on the canvas
# as iframe windows. Its SPA has no built-in way to hide the left thread-list
# sidebar, and we don't carry a fork: this script builds the stock upstream
# web app at UPSTREAM_PIN, then injects deploy/t3code-embed/embed.{js,css}
# into the built index.html. `?embed=1` on any app URL then hides the sidebar
# (see embed.css for the selector contract). Without the param the bundle
# behaves exactly like stock.
#
# The t3code server serves this dist itself (staticDir falls back to the
# monorepo apps/web/dist), so the app stays same-origin with its backend and
# the normal cookie auth applies — no pairing/CORS work. See README.md.
#
# Env overrides:
#   T3CODE_SRC   checkout location   (default: <repo>/.local/t3code-upstream)
#   T3CODE_REPO  upstream remote     (default: https://github.com/pingdotgg/t3code)
#   T3CODE_PIN   commit to build     (default: contents of UPSTREAM_PIN)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

SRC="${T3CODE_SRC:-$REPO_ROOT/.local/t3code-upstream}"
REMOTE="${T3CODE_REPO:-https://github.com/pingdotgg/t3code}"
PIN="${T3CODE_PIN:-$(tr -d '[:space:]' < "$HERE/UPSTREAM_PIN")}"

note() { echo "t3code-embed: $*" >&2; }

# Upstream is a pnpm monorepo (catalog: deps; bun cannot install it) and
# requires node ^24 (package.json engines). corepack picks up the exact pnpm
# from the packageManager field.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
	note "ERROR: t3code needs node >=24 (found $(node --version 2>/dev/null || echo none))."
	note "hint: mise exec node@24 -- $0"
	exit 1
fi
if command -v corepack >/dev/null 2>&1; then
	PNPM=(corepack pnpm)
else
	PNPM=(pnpm)
fi

if [ ! -d "$SRC/.git" ]; then
	note "cloning $REMOTE -> $SRC"
	git clone "$REMOTE" "$SRC"
fi

if ! git -C "$SRC" cat-file -e "$PIN^{commit}" 2>/dev/null; then
	note "fetching $REMOTE for pin $PIN"
	git -C "$SRC" fetch origin
fi
note "checking out pin $PIN"
git -C "$SRC" checkout --detach --quiet "$PIN"

note "installing dependencies (pnpm)"
(cd "$SRC" && "${PNPM[@]}" install --frozen-lockfile)

note "building @t3tools/web (and its workspace deps)"
(cd "$SRC" && "${PNPM[@]}" --filter "@t3tools/web..." run build)

DIST="$SRC/apps/web/dist"
INDEX="$DIST/index.html"
[ -f "$INDEX" ] || { note "ERROR: no $INDEX after build"; exit 1; }

note "injecting embed assets into $DIST"
cp "$HERE/embed.js" "$DIST/ew-embed.js"
cp "$HERE/embed.css" "$DIST/ew-embed.css"

MARKER="ew-embed.js"
if grep -q "$MARKER" "$INDEX"; then
	note "index.html already injected; skipping"
else
	SNIPPET='<link rel="stylesheet" href="/ew-embed.css"><script src="/ew-embed.js"></script>'
	python3 - "$INDEX" "$SNIPPET" <<-'PY'
	import sys
	path, snippet = sys.argv[1], sys.argv[2]
	html = open(path).read()
	if "</head>" not in html:
	    sys.exit("no </head> in " + path)
	open(path, "w").write(html.replace("</head>", snippet + "</head>", 1))
	PY
fi

# The hiding depends on upstream DOM attributes; fail the build loudly if the
# pinned source no longer contains them (see embed.css selector contract).
for attr in 'data-slot="sidebar"' 'data-sidebar-control' 'data-slot="sidebar-rail"'; do
	if ! grep -rq "$attr" "$SRC/apps/web/src"; then
		note "ERROR: upstream no longer uses $attr — update embed.css for pin $PIN"
		exit 1
	fi
done

note "done"
echo "$DIST"
