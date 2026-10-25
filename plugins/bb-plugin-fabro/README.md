# Fabro

A BB plugin for running **project-owned Fabro workflows** on a Fabro server.
Define the work in a thread, submit a committed workflow, follow its live DAG card,
and assess the returned evidence in the originating thread.

The plugin owns the connection, isolated checkout, durable run tracking, cards,
completion delivery, and acceptance. The project owns the workflow, scripts,
input schema, output schema, and acceptance instructions.

## Set up a fresh project

Ask **“Set up Fabro pipelines for this project.”** The `setup-fabro` skill inspects
repository instructions, package scripts and CI, recommends an appropriate starter
set, and copies selected recipes into the project with explicit checks:

- Implement an approved plan (Ralph loop)
- Improve code quality
- Review a committed change without source edits
- Fix a reproduced bug with protected regression evidence

The setup script never runs discovered commands or submits a workflow. Existing
workflows are never overwritten. Generated work orders clearly mark task-specific
inputs still needed; the skill validates schemas, graphs and isolated runner
behavior before handoff. Upstream references and recipe provenance live in the
skill's recipe guide. Plugin updates leave project-owned workflows alone.

## Create a project workflow

Ask the agent: **“Create a refactor workflow for this project.”** The bundled
`create-fabro-workflow` skill inspects project conventions and creates:

```text
.fabro/workflows/refactor-code-quality/
  workflow.json
  workflow.fabro
  runner.mjs
```

The starter provides baseline checks, planning, bounded implementation and repair,
independent review, and final verification. It is a template copied into the
project, not a workflow chosen by the plugin at execution time. Adapt and review
it, then commit its files before submission. Creating a workflow does not run it.

A workflow manifest uses version 1 and declares `name`, `workflow` (a filename relative
 to its directory), `files` (workflow plus supporting files), `inputSchema`,
`outputSchema` (JSON Schema draft-07), and `acceptanceInstructions`. Optional
`environment` defaults to `local`; `autoApprove` defaults to false. All declared
files must be regular committed files within the workflow directory. Package limit:
30 files, 256 KB per file, 512 KB total. Schemas are local; remote refs are not
resolved. Declare supporting workflow/prompt files explicitly.

The workflow runs from the repository checkout root. The plugin writes the
frozen work order to `.fabro-input/work-order.json`; the workflow must write its
delivery to `.fabro-output/delivery.json`. Supporting evidence belongs in
`.fabro-output`. The plugin validates delivery against the frozen output schema
before allowing acceptance. Keep larger evidence in referenced files; delivery
validation reads up to 100 KB. The sidebar and thread receive bounded previews.

## Submit and review

Use the `fabro_workflow_submit` tool or `bb fabro submit '<JSON>'`:

```json
{
  "requestKey": "refactor-url-1",
  "workOrder": {
    "title": "Simplify URL handling",
    "objective": "Improve clarity while preserving behavior",
    "baseSha": "FULL_40_CHARACTER_COMMIT_SHA",
    "workflow": ".fabro/workflows/refactor-code-quality/workflow.json",
    "inputs": {
      "setupCommands": ["bun install --frozen-lockfile"],
      "validationCommands": ["bun server/src/livekit-url.test.ts", "bun run --filter '@ensembleworks/server' typecheck"],
      "qualityCommand": "git diff --check"
    },
    "scope": ["server/src/livekit-url.ts", "server/src/livekit-url.test.ts"],
    "constraints": ["Preserve public behavior"],
    "acceptanceCriteria": ["Simpler implementation with passing regression tests"],
    "maxAttempts": 1,
    "maxMinutes": 20,
    "maxChangedFiles": 3
  }
}
```

Replace the SHA and tailor the commands. `inputs` is a JSON object matching the
selected workflow schema (64 KB, up to four nested array/object levels). Refactoring
commands belong to this starter's input schema; another workflow may accept entirely
different fields. In the starter, quality commands must pass by default;
`inputs.qualityMode: "report"` explicitly allows nonzero finding reports for
before/after review while execution errors remain fatal. The shared work order records scope, objectives, acceptance
criteria and limits; the project runner must enforce the applicable limits.

Submission validates the selected workflow before creating the job. Both source and
workflow files are read from `baseSha`, never from dirty working files. Preparation
persists the exact workflow package, its hash and manifest. Later edits affect
new submissions only. Reusing a request key with different input is rejected.

The card displays Fabro's actual SVG graph and latest stage visits, including
repair edges. Active cards refresh every five seconds. Failed updates retain the
last snapshot and mark it stale. The host fetches authenticated data and the
browser renders allowlisted SVG geometry as an image without receiving tokens.
Click the card for the sidebar and external Fabro link.

Completion queues a turn in the originating thread. The agent inspects the diff,
checks the work order and workflow's acceptance instructions, then records
`accepted`, `rework`, or `needs_input` using `fabro_workflow_accept`. A successful
run is not sufficient for acceptance; the output contract must pass too.
Acceptance does not merge, push, publish, or submit rework automatically.

## Setup and compatibility

Build and install with `npm run build` and `bb plugin install . --yes`.
Configuration keys are `fabroEndpoint` (default `http://127.0.0.1:3000/api/v1`),
optional secret `fabroToken`, and optional `fabroWebUrl`. They resolve on the
execution host. Without an explicit token, the host reads the matching dev-token
entry in `~/.fabro/auth.json`. Embedded Fabro pages may require external login.

The plugin ID is `fabro`, its package is `bb-plugin-fabro`, and its source folder
is `plugins/bb-plugin-fabro`. Use `bb plugin config fabro` for settings.
Tools are `fabro_workflow_submit`, `fabro_workflow_inspect`, and
`fabro_workflow_accept`; run cards use the `fabro-workflow` directive.

This is a clean identity change with no compatibility aliases or history migration.
Remove the old installation before installing this package. The new installation
starts with an empty job store; old cards and completion references are not supported.
Project submissions use `workOrder.workflow` pointing to
`.fabro/workflows/<name>/workflow.json`. Existing Fabro server runs are untouched.

```sh
bb fabro list
bb fabro inspect JOB_ID
bb fabro submit '<JSON>'
bb fabro accept '<JSON>'
bb fabro redeliver JOB_ID
```

Run commands in the originating thread. Creation and completion notification
uncertainty are persisted and reconciled before retrying. Only explicitly use
`redeliver` after inspecting an uncertain notification; bounded history may miss
an older delivery. Archived origin threads defer automatic delivery.

To show an existing run in another thread:

```text
::fabro-workflow{jobId="JOB_ID" originThreadId="ORIGIN_THREAD_ID"}
```

## Verification

`npm run typecheck`, `npm test`, and `npm run build` check the plugin. For the
starter's shell-only live graph regression suite:

```sh
FABRO_GRAPH_TEST=1 npm test -- workflows/refactor-code-quality/workflow.test.ts
```

This creates temporary Git fixtures and four Fabro runs without model calls:
first-attempt delivery, successful repair, exhausted budget, and failed planning.
Tests retain the project template's runtime guards. The starter avoids
`max_visits=1`, which rejects the first visit in Fabro 0.254.0, and uses explicit
success transitions plus terminal goal gates. Time budgets are checked between
stages and applied to commands, not enforced as a global process-tree deadline.

Composer banners use a workflow glyph and execution-status icon; tooltips retain
the full title and separate acceptance verdict. Set optional work-order
`displayTitle` (1–60 characters) for a concise banner label; otherwise the full
title is truncated visually. Active runs show their current stage. Expand the
banner to see the mini DAG, or use the sidebar button for details.
