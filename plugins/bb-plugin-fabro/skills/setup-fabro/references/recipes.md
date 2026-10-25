# Starter catalog

| Recipe | Use when | Prerequisites / result |
| --- | --- | --- |
| implement-plan | A feature or fix has an agreed written plan | Committed Markdown plan, real baseline/check commands; bounded implementation, task coverage, independent criterion review and delivery commit |
| refactor-code-quality | Improve maintainability without behavior changes | Passing baseline and meaningful quality criteria; focused diff, checks, review and delivery commit |
| review-change | Assess an existing committed change | reviewBaseSha ancestor of baseSha, scoped paths and passing check commands; review Markdown and evidence, no source edits/commit |
| fix-bug | A specific bug has a reliable regression | Committed regressionPaths plus reproductionCommand and expectedFailureExitCode (1–125); passing unrelated baseline; inspect RED, protect regression, fix, GREEN, independent review and delivery commit |

Do not use review-change to fix findings. Its delivery outcome `reviewed` says only that the review completed. Do not treat a compiler/setup error as a valid bug reproduction. The bug workflow checks exit codes mechanically; its planner/reviewer must establish that the recorded failure matches the bug.

All workflows use `.fabro-input/work-order.json` and `.fabro-output/delivery.json`, preserving BB origin-thread review. Commands, scope, budgets, environment and models must fit the target project. Node timeouts are 30 minutes; runner elapsed/attempt checks are not a hard process-tree deadline during agent waits.

## Provenance

Recipe edition: 1 (2026-09-13). The assets are maintained in this BB plugin, based on its dogfooded refactor and Ralph runners; review and bug variants add their own delivery guards. They are copied into the project, not linked to upstream HEAD and not overwritten by plugin updates. The existing create-fabro-workflow refactor asset remains the shared source for that recipe.

Upstream pattern references (inspiration, not unmodified imports):
- Fabro REPL handoff: https://docs.fabro.sh/examples/repl-handoff
- Definition-of-done audit/repair: https://docs.fabro.sh/examples/definition-of-done
- Official workflow collection: https://github.com/fabro-sh/fabro/tree/main/.fabro/workflows
- Historical authoring skill (removed upstream; not an installation dependency): https://github.com/fabro-sh/fabro/blob/5abf775cf5269b599d55e036301b261ebe0df5b6/skills/fabro-create-workflow/SKILL.md

Upstream recipes can contain repository-specific commands, models, Git merges or publication steps. Do not copy those assumptions into a fresh project. Validate against the installed Fabro version; our assets keep explicit success routing and runner attempt limits.
