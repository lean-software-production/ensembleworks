# Import provenance

This directory was imported from the clean `HEAD` of
`/home/ensembleworks-agent/bb-plugin-communications-hub` at commit
`725d05593832b0169cfeb8c1088f588244ab13e1` on 12 September 2026.

The import copies the source checkout's tracked files and keeps the plugin's
own `package.json`, `package-lock.json`, tests, fixture, and BB entrypoints.
The installed BB host reports Plugin SDK `0.4.84`, so the package's
development-only SDK pin and corresponding lockfile entry were synchronized
from the source's `0.4.47` to `0.4.84`; `bb plugin types --check` passes with
that host. No runtime dependency or source behavior was otherwise upgraded.
The source checkout's `.git` directory, `node_modules`, `dist`, runtime data,
and secrets are deliberately not part of this tree. The marketplace demo adds
release/catalog documentation at the repository root; it does not add a
second runtime implementation or change the imported plugin's source behavior.
