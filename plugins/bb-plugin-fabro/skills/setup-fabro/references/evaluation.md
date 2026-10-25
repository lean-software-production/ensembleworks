# Recipe edition 1 evaluation — 2026-09-13

Fresh BB threads evaluated the skill in isolated Node fixtures. Transcripts were
inspected alongside their reports; no Fabro model run was submitted.

- Baseline without setup-fabro (`thr_5qndhzequs`): existing guidance scaffolded
  only the refactor workflow. Ralph required manual adaptation; review and reproduced
  bug recipes were absent. This establishes the capability gap, not a quantitative
  comparison of agent performance.
- Fresh-project treatment (`thr_aw9xzpyays`): generated all four requested recipes
  (20 files), refused overwrites, compiled eight schemas with AJV, validated
  representative inputs and all graphs using Fabro 0.254.0, and passed all four
  runner baselines using actual Node commands. Captured an assertion failure for
  the committed bug reproducer. The seven shipped recipe checks passed.
- Near miss (`thr_nt4nqdysze`): “Run the existing refactor workflow” selected
  fabro and scaffolded nothing. An earlier routing thread failed during
  worktree provisioning and was replaced by this read-only evaluation.

The local development suite also covers successful bug/plan deliveries, immutable
regressions, source-edit rejection during review, missing reproduction, incomplete
plan tasks and criterion reviews, quality failures, attempt exhaustion, traversal,
symlink destinations, non-executing inspection, and all-or-nothing overwrite
preflight. Plugin verification: 59 Vitest checks passed, five optional live checks
skipped; seven Node recipe checks passed; typecheck and build passed.

Evaluation prompted explicit guidance for Node test discovery and command syntax,
placeholder readiness checks, reporting the selected environment, unavailable
model/environment catalogs, and the recipe suite's development dependencies.
The generated bug README carries the regression-discovery warning too.

Limits: these are offline authoring and runner evaluations, not paid end-to-end
model runs. Fabro emits advisory goal_gate_has_retry graph warnings. The fixture
recipes use caller-supplied project commands; real projects still need baseline
validation and concrete task inputs before submission.
