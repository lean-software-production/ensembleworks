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
git fetch origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || {
	echo "local main != origin/main" >&2
	exit 1
}

echo "==> validating build before tagging"
npm ci
npm run typecheck
npm run build

echo "==> npm version ${BUMP}"
new="$(npm version "$BUMP" -m "release: %s")" # bumps package.json, commits, tags vX.Y.Z
echo "==> tagged ${new}"

git push origin main --follow-tags
echo "==> pushed main + ${new}. Deploy with: deploy/deploy.sh <ssh-target> ${new#v}"
