# Communications Hub marketplace demo

The monorepo indexes two independent plugins in `.bb/plugins.json`. The
Communications Hub remains an isolated npm package under
`plugins/communications-hub`; it is not added to the root Bun workspaces.
Import provenance is recorded in
[`plugins/communications-hub/docs/provenance.md`](../plugins/communications-hub/docs/provenance.md).

## Local developer checks

```sh
cd plugins/communications-hub
npm ci
npm test
npm run typecheck
bb plugin types --check
bb plugin build
```

The build produces ignored `dist/` artifacts. This PR does not install the
plugin into the active BB instance or claim a live update test.

## Separate-instance marketplace demo

After the parent publishes the preview tags, use a separate BB instance or
isolated data directory. From this checkout, the local catalog can be added
without installing code:

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
  --plugin communications-hub --version 0.1.1-preview.1 --check
node scripts/plugin-release.mjs preview \
  --plugin communications-hub --version 0.1.1-preview.1
node scripts/plugin-release.mjs preview \
  --plugin communications-hub --version 0.1.1-preview.2
```

The first command is side-effect-free. The latter two are the parent-owned
publish commands and require a clean working tree. `--no-push` creates the
release commit and tag for an operator to inspect; `--check` creates neither.
Stable releases use the same script on synchronized `main`, for example:

```sh
node scripts/plugin-release.mjs stable \
  --plugin communications-hub --version 0.1.1 --check
```

The stable command is shown in check mode here; publishing it requires the
parent's deliberate release action.

No Zoom setup, LiveKit migration, factory integration, presence implementation,
or active-instance installation is part of this file-import demonstration.

UX contract: none — this change does not touch Canvas interaction-bearing code;
it imports the existing Communications Hub surface and adds repository
catalog/release/documentation tooling only.
