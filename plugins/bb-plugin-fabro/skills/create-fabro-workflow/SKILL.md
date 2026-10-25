---
name: create-fabro-workflow
description: Create or adapt a project-owned Fabro refactoring workflow, including its workflow, input schema, delivery contract, and checks. Use when asked to create a workflow for a project; not for running an existing workflow or general refactoring.
---

# Create a Fabro workflow

For guided selection of several pipeline types in a fresh project, use setup-fabro. This skill handles a focused refactor-workflow creation request.

The project owns the workflow. The Fabro plugin supplies execution, run cards,
completion delivery, and acceptance. Creating a workflow does not submit it.

Inspect the repository instructions, package scripts, tests, and quality tooling.
Identify meaningful baseline and after checks, permitted scope, and evidence
needed for acceptance. Preserve repository interaction-contract obligations.
Avoid merely counting successful commands as evidence of improved quality.

For a new refactor workflow, run the bundled script (paths relative to this skill):

```sh
node scripts/create-refactor-workflow.mjs /absolute/project/path
```

It copies `assets/refactor-workflow` into `.fabro/workflows/refactor-code-quality/` and
refuses to overwrite an existing workflow. Inspect and adapt the generated files:

- `workflow.json`: version 1, display name, relative workflow filename, explicit
  list of supporting files, JSON Schema draft-07 input/output schemas,
  acceptance instructions, Fabro environment, and approval policy.
- `workflow.fabro`: baseline, planning, bounded implementation/validation/review,
  and delivery. Use the project workflow's runner path. Keep explicit success edges;
  this Fabro version does not reliably honor `on_failure` on fallback edges.
  Do not use `max_visits=1`; the runtime bounds implementation attempts.
- `runner.mjs`: project-owned checks, scope and attempt guards, evidence, and
  delivery commit. It reads the work order from `.fabro-input/work-order.json`
  and writes `.fabro-output/delivery.json` and supporting evidence.

The starter accepts `inputs.validationCommands`, `inputs.qualityCommand`, and
optional `inputs.setupCommands`. Quality checks must pass by default; set
`inputs.qualityMode` to `report` only for a tool whose nonzero exit means existing
findings that the reviewer must compare. Execution errors are always fatal. Choose real project commands and document a
concrete example work order in the project workflow directory. Adapt schemas and
runner together when the project's input needs differ. The starter's
`autoApprove: true` is for its fixed graph without human gates; set it false if
you add human decisions. Node timeout defaults to 30 minutes; tune it alongside
the work order's elapsed-time budget.

Verify the manifest schemas, validate the DOT with the installed Fabro CLI,
and exercise the runner with a small isolated fixture. Confirm failing checks
stop delivery and attempt exhaustion stops implementation. Do not launch a
paid workflow merely to validate the scaffold. Inspect generated diffs and
report paths, chosen checks, and any project-specific limits.

Workflow files must be committed before submission: the plugin reads every declared
file from the work order's full `baseSha`, never from dirty working files. Do not
commit unrelated work. When execution is requested, use the fabro-workflows skill
and submit `workOrder.workflow` plus schema-valid `workOrder.inputs`.
