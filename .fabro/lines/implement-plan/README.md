# Implement approved plan

Recipe edition 1, maintained by the BB Fabro plugin; inspired by https://docs.fabro.sh/examples/repl-handoff and https://docs.fabro.sh/examples/definition-of-done. Project-owned copy; plugin updates never overwrite it. Review line.json, workflow.fabro and runner.mjs.

Validation commands:
- npm --prefix plugins/bb-plugin-assembly-lines run typecheck
- npm --prefix plugins/bb-plugin-assembly-lines test
- npm --prefix plugins/bb-plugin-assembly-lines run build

Quality: git diff --check

Complete all REPLACE_WITH fields in work-order.example.json, freeze the task scope and criteria, and commit the line before submission. Commands are copied, not executed by setup. Run baseline and isolated failure-path checks before the first model run. Use the assembly-lines skill for an explicitly requested execution.

The approved plan must be a committed Markdown file at baseSha. All task criteria must be covered and reviewed before delivery.

## EnsembleWorks customization

Environment: `local`; planning, implementation and independent review use
Fabro's configured model default (currently OpenAI `gpt-5.5`). This initial dogfood
example targets `plugins/bb-plugin-assembly-lines`, an isolated npm package outside
the Bun workspace. Setup uses its committed npm lockfile (`npm ci --include=dev`);
validation runs plugin typecheck, tests (including recipe guards), and build.
Commands run from the repository root. Narrow the example scope per task.

For another workspace, replace the example commands and scope after inspecting
its instructions and CI. Root application checks use `bun install --frozen-lockfile`,
`bun run typecheck`, `bun run test` and `bun run build`. The Canvas plugin has its
own npm typecheck/test/quality/build gates. Do not assume the Fabro plugin checks
cover application or Canvas changes.

For canvas-editor tools, canvas-react, or client canvas-v2 input/tool changes, declare or extend an interaction contract (or justify ux-contract: none), record verbatim RED before fixing and stop if unreachable, implement Obs additions in both FSM and browser adapters, and independently verify RED/GREEN during review.

Validation, test and build stages remain shell commands.
