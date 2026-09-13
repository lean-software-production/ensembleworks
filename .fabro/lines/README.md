# Project Fabro lines

These project-owned recipes are read from the submitted Git commit. Define a
concrete task in a BB thread; its Fabro card and acceptance review stay there.

| Line | Purpose |
| --- | --- |
| [implement-plan](implement-plan/README.md) | Ralph loop implementing an approved, committed Markdown plan. |
| [refactor-code-quality](refactor-code-quality/README.md) | Improve maintainability while preserving behavior. |
| [review-change](review-change/README.md) | Review a committed range without editing source. |
| [fix-bug](fix-bug/README.md) | Repair a reproduced bug with an immutable committed regression. |

All four examples use the Fabro plugin's isolated npm package as the initial
dogfood scope, with lockfile installation, typecheck, tests and build, plus
`git diff --check`. Environment is `local`. Planning, implementation and
independent review use Fabro's configured model default (currently OpenAI
`gpt-5.5`). Command stages still run deterministic checks.
Choose narrower source paths and explicit acceptance criteria for each task.
For application or Canvas work, select the appropriate workspace checks as
described in each line README; plugin checks do not cover those surfaces.

Copy `work-order.example.json` outside the source tree and replace all
`REPLACE_WITH` markers. A plan run needs a committed approved plan, a review needs
a full ancestor review-base SHA, and a bug fix needs a committed failing regression
plus its reproduction command. Commit the line definitions before submission.
Setup creates no run and acceptance never merges, pushes or deploys.

These four recipes replace the earlier `ralph-loop` and `refactor-fabro-plugin`
paths. New submissions should use the names above. Existing jobs retain their
frozen line package. The general refactor now uses explicit work-order commands;
it does not inherit the retired plugin-specific runner's fixed-command policy.
Do not weaken checks or widen scope to get a passing result.

Verify project Ralph guards with `node --test .fabro/lines/tests/lines.test.mjs`.
Set `FABRO_GRAPH_TEST=1` for its optional local-server shell-only graph regression.
Run `npm --prefix plugins/bb-plugin-assembly-lines run test:recipes` for the
four-recipe scaffold and runner suite (no model calls). Set `FABRO_BIN` to the
installed CLI path to validate generated graphs too. Graph validation can emit
advisory `goal_gate_has_retry` warnings; repairs use explicit graph edges and
runner attempt limits.
