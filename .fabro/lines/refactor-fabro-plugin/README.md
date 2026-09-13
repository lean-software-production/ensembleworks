# Refactor the Fabro BB plugin

This is the dogfood line for `plugins/bb-plugin-assembly-lines` (displayed in BB
as **Fabro**). It selects and implements a small behavior-preserving improvement,
checks it, asks for independent review, and returns a delivery to the BB thread.

The runner fixes its own setup and validation commands:

- `npm ci --include=dev` in the plugin's isolated checkout, using a temporary cache.
- Plugin `npm run typecheck`, `npm test` without live Fabro tests, and `npm run build`.
- `git diff --check`, plus scope and file-count checks.

Submissions cannot override those commands. Changes must satisfy the requested
scope **and** remain inside the plugin directory. Dependency/package scripts,
lockfile, test runner configuration, and compiler configuration are protected.
The reviewer must identify a concrete quality improvement; passing checks alone
is insufficient. The graph and runner retain the same bounded retry semantics
as the general refactor line.

Copy `work-order.example.json`, replace `baseSha` with `git rev-parse HEAD`, and
make the objective/scope/criteria specific enough to assess. Submit from the
thread that should receive the result:

```sh
bb fabro submit "$(cat /path/to/completed-work-order.json)"
```

Use a new request key for a new run. `inputs` is `{}`. The example allows two
attempts, 30 minutes, and five changed files. Source and line definitions must be
committed before submission. Creating this line does not run it.
