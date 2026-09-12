# Communications Hub marketplace demo

The monorepo indexes two independent plugins in `.bb/plugins.json`. The
Communications Hub remains an isolated npm package under
`plugins/communications-hub`; it is not added to the root Bun workspaces.
Import provenance is recorded in
[`plugins/communications-hub/docs/provenance.md`](../plugins/communications-hub/docs/provenance.md).

## Local developer checks

Use BB 0.43.0 and Node 22.19 or newer in the Node 22 line.
GitHub Actions CI for this plugin is deferred; run these checks locally.

```sh
cd plugins/communications-hub
npm ci
npm test
npm run typecheck
bb plugin types --check
bb plugin build
```

The build produces ignored `dist/` artifacts. The live checks below use an
isolated BB instance; the team's existing Communications Hub is not replaced.

## Separate-instance marketplace demo

After publishing the PR branch and first preview tag, use a separate BB
instance. For example, run this in a dedicated terminal (choose unused ports):

```sh
bb-app --data-dir /tmp/ensembleworks-demo --server-bind-host 127.0.0.1 \
  --server-port 39886 --host-daemon-port 39887
```

In the terminal used for the following demo commands, select that instance
explicitly and clear any inherited thread context:

```sh
unset BB_PROJECT_ID BB_THREAD_ID BB_ENVIRONMENT_ID BB_HOST_ID
export BB_SERVER_URL=http://127.0.0.1:39886
export BB_HOST_DAEMON_PORT=39887
bb status
bb marketplace add git:https://github.com/lean-software-production/ensembleworks.git@bb-plugin-decomposition-doc
bb plugin install communications-hub@ensembleworks --yes
```

Alternatively, from the repository root, use the local catalog while developing:

```sh
bb marketplace add path:$PWD
bb marketplace list
bb plugin install communications-hub@ensembleworks --yes
```

The current catalog range is intentionally preview-only:
`>=0.1.1-preview.1 <0.1.1`. It selects the highest published
`communications-hub/v0.1.1-preview.*` tag. The catalog does not install the
plugin when it is added.

In the isolated instance, import `plugins/communications-hub/fixtures/planning.vtt`
from the Communications page, attach the resulting conversation to a BB
thread, then use the conversation panel or CLI to read/search passages. Check
that each result has a stable citation link, that reading does not implicitly
advance the thread cursor, and that an explicit acknowledge does. Reload the
plugin and verify the conversation, attachment, and cursor remain present.

To prove updating, install the current preview before publishing the next, then run
`bb plugin outdated` and `bb plugin update communications-hub --yes`. Verify the
installed version and that the same conversation, attachment, cursor, and
citations remain. A new install selects the highest published preview.
The first GitHub publication is preview.3; previews .1 and .2 were local
validation releases and are not published to GitHub.

When a stable release is ready, publish a stable tag and change only the
catalog source range to a stable range such as `^0.1.1`; refresh the catalog
and use `bb plugin outdated` followed by `bb plugin update communications-hub`
in the isolated instance. Stable release checks require clean, synchronized
`main`; preview checks are deliberately limited to
`bb-plugin-decomposition-doc`.

## Release commands

The script owns version updates, commits, annotated prefixed tags, and pushes;
do not hand-tag. Preview mode requires an explicit prerelease version:

```sh
node scripts/plugin-release.mjs preview \
  --plugin communications-hub --version 0.1.1-preview.4 --check
node scripts/plugin-release.mjs preview \
  --plugin communications-hub --version 0.1.1-preview.4
node scripts/plugin-release.mjs preview \
  --plugin communications-hub --version 0.1.1-preview.5
```

The first command is side-effect-free. The latter two publish commands require
a clean working tree. `--no-push` creates the
release commit and tag for an operator to inspect; `--check` creates neither.
Stable releases use the same script on synchronized `main`, for example:

```sh
node scripts/plugin-release.mjs stable \
  --plugin communications-hub --version 0.1.1 --check
```

The script currently supports Communications Hub only. It rejects equal or
lower versions, previews outside the catalog's `0.1.1-preview.N` line, existing
tags, and stable releases not synchronized with the live remote main. Every
release runs a clean dependency install, tests, typecheck, SDK check, and build;
verification cannot be skipped. Pushes send the branch and tag atomically.

## Validation on 12 September 2026

- BB 0.43.0 / Plugin SDK 0.4.84; 85 plugin tests, typecheck, SDK check, and build pass.
- Nine release/catalog guardrail tests pass; a separate cheaper-model review
  validated the fixes for version regression and preview-range mismatch.
- The actual release script created annotated `communications-hub/v0.1.1-preview.1`
  and `communications-hub/v0.1.1-preview.2` tags in a disposable Git mirror.
- A fresh BB instance accepted the catalog, installed preview.1 as a managed
  Git plugin, discovered preview.2 with `plugin outdated`, and updated successfully.
- Chromium imported the WebVTT fixture through the UI and rendered four
  passages; searching for “webhook” returned two passages with citation links
  and no page errors.
- CLI checks attached a conversation to a real BB thread, verified that reading
  left its cursor at zero, acknowledged sequence two, and confirmed the four
  passages, attachment, and cursor survived reload and update.
- Reusing the second release tag was rejected without moving it.

These are local integration results, not a claim of publication on GitHub.
Only the isolated server's Git subprocesses redirected the repository URL to
the temporary mirror, through process-scoped Git configuration. The catalog,
semver resolution, subdirectory selection, clean managed builds, storage, and
update activation used BB's real implementation. No global Git rewrite was set.
The GitHub preview.3 publication omits the GitHub Actions workflow because the
available publishing credential lacks workflow scope. The release script's
local verification remains mandatory; earlier local preview tags are unchanged.

## Development workflow

`.bb/workflows/communications-marketplace-demo.js` records the one-off
implementation/validation/feedback workflow used for this PR. It selects
GPT-5.6-Luna explicitly and bounds validation to three rounds. It is a development
harness, not the proposed product-level Automated Workflows domain.

The first run stopped on a provider usage limit. A resumed run completed
implementation but its validator hit another usage limit. A separate
cheaper-model review and final parent validation completed the review and live
checks; the BB workflow itself must not be described as a successful full loop.

No Zoom setup, LiveKit migration, factory integration, presence implementation,
or active-instance installation is part of this file-import demonstration.

UX contract: none — this change does not touch Canvas interaction-bearing code;
it imports the existing Communications Hub surface and adds repository
catalog/release/documentation tooling only.
