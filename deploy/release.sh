#!/usr/bin/env bash
# Package a version: validate, bump, tag, push. The public repo is the artifact
# store; the tag is the release (CI builds every `v*` tag and publishes its
# GitHub release, which deploy.sh then fetches).
#
#   deploy/release.sh patch|minor|major          # a normal release — from clean main
#   deploy/release.sh rc patch|minor|major       # START an rc series: 0.11.0 -> `rc minor` -> 0.12.0-rc.1
#   deploy/release.sh rc                         # CONTINUE it:         0.12.0-rc.1 -> 0.12.0-rc.2
#
# Final releases come only from a clean main. An `rc` may be cut from ANY branch:
# it's a throwaway prerelease whose CI-built assets you can deploy to staging
# before the branch merges. The bump commit + tag land on the current branch.
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
# Final releases (patch|minor|major) are the real artifact and still come only
# from main. An `rc` is a throwaway prerelease we cut to get CI-built assets to
# deploy to staging BEFORE a branch merges, so it may be cut from any branch: its
# bump commit + tag land on that branch and ride into main when the PR merges
# (graduating the rc to the final release then happens from main — see header).
if [ "$BUMP" != rc ] && [ "$branch" != "main" ]; then
	echo "final release from main only (on '$branch') — cut a prerelease with: release.sh rc [patch|minor|major]" >&2
	exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "working tree not clean" >&2
	exit 1
fi
# Dry run (RELEASE_DRY_RUN=1): run the full validation but skip the
# origin-sync requirement and stop before bump/push. Lets you test the
# release gate — including "does it disturb a running bin/dev stack?" — at
# any time. A real release still requires clean main == origin/main.
if [ -z "${RELEASE_DRY_RUN:-}" ]; then
	# Sync-check the branch we're releasing FROM (main for a final release, the
	# feature branch for an rc). A branch not yet on origin is fine — the push
	# below creates it — so only compare when the upstream ref exists.
	git fetch origin "$branch" 2>/dev/null || true
	if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
		[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ] || {
			echo "local $branch != origin/$branch — push or pull first" >&2
			exit 1
		}
	fi
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

git push origin "$branch" --follow-tags
echo "==> pushed $branch + ${new}. Deploy with: deploy/deploy.sh <ssh-target> ${new#v}"
