#!/usr/bin/env bash
# Package a version: validate, bump, tag, push. Run from a clean `main` on your
# laptop. The public repo is the artifact store; the tag is the release.
#
#   deploy/release.sh patch|minor|major
#
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BUMP="${1:?usage: release.sh patch|minor|major}"
case "$BUMP" in patch | minor | major) ;; *)
	echo "bump must be patch|minor|major" >&2
	exit 1
	;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || {
	echo "release from main only (on '$branch')" >&2
	exit 1
}
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "working tree not clean" >&2
	exit 1
fi
# Dry run (RELEASE_DRY_RUN=1): run the full validation but skip the
# origin-sync requirement and stop before bump/push. Lets you test the
# release gate — including "does it disturb a running bin/dev stack?" — at
# any time. A real release still requires clean main == origin/main.
if [ -z "${RELEASE_DRY_RUN:-}" ]; then
	git fetch origin main
	[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
		echo "local main != origin/main" >&2
		exit 1
	}
fi

echo "==> preflight: node matches .nvmrc"
wanted="v$(tr -d 'v[:space:]' <.nvmrc)"
[ "$(node -v)" = "$wanted" ] || {
	echo "node $(node -v) but .nvmrc pins $wanted (node-pty ABI) — install it and retry" >&2
	exit 1
}

# Validate in a throwaway worktree: `npm ci` DELETES node_modules, which used
# to yank node-pty out from under the running dev services (tsx watch, vite,
# the terminal gateway) when releasing from a live checkout. The worktree gets
# its own fresh node_modules and is removed afterwards; the live tree is never
# touched. The bump/tag below still happens here — a one-file commit that
# watchers shrug at.
echo "==> validating build before tagging (isolated worktree)"
worktree_parent="$(mktemp -d /tmp/ensembleworks-release.XXXXXX)"
worktree="$worktree_parent/tree"
cleanup() {
	git worktree remove --force "$worktree" >/dev/null 2>&1 || true
	rm -rf "$worktree_parent"
}
trap cleanup EXIT
git worktree add --detach "$worktree" HEAD
(cd "$worktree" && npm ci && npm run typecheck && npm run build)

if [ -n "${RELEASE_DRY_RUN:-}" ]; then
	echo "==> dry run: validation passed; skipping version bump + push"
	exit 0
fi

echo "==> npm version ${BUMP}"
new="$(npm version "$BUMP" -m "release: %s")" # bumps package.json, commits, tags vX.Y.Z
echo "==> tagged ${new}"

git push origin main --follow-tags
echo "==> pushed main + ${new}. Deploy with: deploy/deploy.sh <ssh-target> ${new#v}"
