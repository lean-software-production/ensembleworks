# Import provenance

This directory was imported from the clean `HEAD` of
`https://github.com/lean-software-production/bb-plugin-communications-hub`
at commit `dd7622cba6a0618d1cb4e33c50c4b8a84fa32df9` on 12 September 2026.

The import copies the source checkout's tracked files and keeps the plugin's
own `package.json`, `package-lock.json`, tests, fixture, and BB entrypoints.
The installed BB host reports Plugin SDK `0.4.84`, so the package's
development-only SDK pin and corresponding lockfile entry were synchronized
from the source's `0.4.47` to `0.4.84`; `bb plugin types --check` passes with
that host. The EnsembleWorks preview version remains `0.1.1-preview.3`.

This import includes the source's reusable Zoom-room work: room-based thread
attachments, registrant-specific links, room renewal and deletion, the Zoom
REST adapter, and their UI and test coverage.
The source checkout's `.git` directory, `node_modules`, `dist`, runtime data,
and secrets are deliberately not part of this tree. The marketplace demo adds
release/catalog documentation at the repository root; it does not add a
second runtime implementation or change the imported plugin's source behavior.
