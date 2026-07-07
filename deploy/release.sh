#!/usr/bin/env bash
# Package a version: validate, bump, tag, push. Run from a clean `main` on your
# laptop. The public repo is the artifact store; the tag is the release.
#
#   deploy/release.sh patch|minor|major          # a normal release
#   deploy/release.sh rc patch|minor|major       # START an rc series: 0.11.0 -> `rc minor` -> 0.12.0-rc.1
#   deploy/release.sh rc                         # CONTINUE it:         0.12.0-rc.1 -> 0.12.0-rc.2
#
# Graduating an rc to the real release is the plain form: from 0.12.0-rc.N,
# `release.sh minor` (or patch/major — whichever matches the series target)
# drops the prerelease suffix and tags v0.12.0 (npm semver `inc` semantics).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage="usage: release.sh patch|minor|major | rc [patch|minor|major]"
BUMP="${1:?$usage}"
RC_BASE_BUMP="${2:-}"
case "$BUMP" in
patch | minor | major)
	[ -z "$RC_BASE_BUMP" ] || {
		echo "unexpected extra argument '$RC_BASE_BUMP' — $usage" >&2
		exit 1
	}
	;;
rc)
	case "$RC_BASE_BUMP" in "" | patch | minor | major) ;; *)
		echo "rc series bump must be patch|minor|major — $usage" >&2
		exit 1
		;;
	esac
	;;
*)
	echo "$usage" >&2
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

echo "==> preflight: bun meets the .tool-versions floor"
floor="$(awk '$1=="bun"{print $2}' .tool-versions)"
have="$(bun --version)"
[ "$(printf '%s\n%s\n' "$floor" "$have" | sort -V | head -1)" = "$floor" ] || {
	echo "bun $have but .tool-versions floor is $floor — install it and retry" >&2
	exit 1
}

# Validate in a throwaway worktree: `bun install` rewrites node_modules, which
# used to yank deps out from under the running dev services (the watchers, vite,
# the terminal gateway) when releasing from a live checkout. The worktree gets
# its own fresh node_modules and is removed afterwards; the live tree is never
# touched. The bump/tag below still happens here — a one-file commit that
# watchers shrug at. (The fetch-verify-swap artifact deploy is a later sub-project;
# this gate only proves the tag builds under Bun.)
echo "==> validating build before tagging (isolated worktree)"
worktree_parent="$(mktemp -d /tmp/ensembleworks-release.XXXXXX)"
worktree="$worktree_parent/tree"
cleanup() {
	git worktree remove --force "$worktree" >/dev/null 2>&1 || true
	rm -rf "$worktree_parent"
}
trap cleanup EXIT
git worktree add --detach "$worktree" HEAD
(cd "$worktree" && bun install && bun run typecheck && bun run build)

if [ -n "${RELEASE_DRY_RUN:-}" ]; then
	echo "==> dry run: validation passed; skipping version bump + push"
	exit 0
fi

# Resolve the version argument npm gets. Plain bumps pass through; `rc` either
# continues the current prerelease (npm's own rc.N+1 arithmetic) or starts a new
# series at rc.1 (npm's preminor-style bumps start at rc.0, so the first tag of
# a series is computed explicitly to match the house convention).
if [ "$BUMP" = rc ]; then
	current="$(bun -p "require('./package.json').version")"
	if [[ "$current" == *-rc.* ]]; then
		[ -z "$RC_BASE_BUMP" ] || {
			echo "already on an rc series ($current) — drop '$RC_BASE_BUMP' and rerun 'release.sh rc'" >&2
			exit 1
		}
		VERSION_ARG="prerelease --preid=rc" # 0.12.0-rc.1 -> 0.12.0-rc.2
	else
		[ -n "$RC_BASE_BUMP" ] || {
			echo "on $current — starting a new rc series needs a target: release.sh rc patch|minor|major" >&2
			exit 1
		}
		IFS=. read -r maj min pat <<<"$current"
		case "$RC_BASE_BUMP" in
		patch) target="$maj.$min.$((pat + 1))" ;;
		minor) target="$maj.$((min + 1)).0" ;;
		major) target="$((maj + 1)).0.0" ;;
		esac
		VERSION_ARG="$target-rc.1" # e.g. 0.11.0 -> `rc minor` -> 0.12.0-rc.1
	fi
else
	VERSION_ARG="$BUMP"
fi

echo "==> npm version ${VERSION_ARG}"
# shellcheck disable=SC2086 — VERSION_ARG is intentionally word-split for the
# `prerelease --preid=rc` form.
new="$(npm version $VERSION_ARG -m "release: %s")" # bumps package.json, commits, tags vX.Y.Z[-rc.N]
echo "==> tagged ${new}"

git push origin main --follow-tags
echo "==> pushed main + ${new}. Deploy with: deploy/deploy.sh <ssh-target> ${new#v}"
