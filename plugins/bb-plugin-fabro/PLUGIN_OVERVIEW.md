# Fabro plugin modules

- `server.ts`: project-workflow validation before durable submission, tools and CLI,
  thread ownership, cards, acceptance, completion watcher.
- `project-workflow.ts`: bounded reads of manifest and declared files from Git at the
  exact submitted revision; JSON Schema validation.
- `host.ts`: host-local Fabro credentials, isolated checkouts, immutable package
  and manifest snapshots, Fabro RPC, delivery contract and evidence collection.
- `fabro.ts`: bounded authenticated HTTP, modern workflow registration and legacy
  manifest support. It knows nothing about refactoring.
- `jobs.ts`, `orchestrator.ts`, `completion.ts`: durable job/result/assessment
  state, uncertain-operation reconciliation, and origin-thread delivery.
- `app.tsx`, `run-graph.tsx`, `graph-image.ts`: live DAG card and sidebar.
- `skills/create-fabro-workflow`: scaffold script and refactor starter assets. These
  are copied into projects; production execution does not import them.
- `skills/fabro`: submit, inspect, and assess an existing project workflow.
- `workflows/refactor-code-quality`: test-only fixtures for the starter.

Internal identity remains `fabro` for stored data and card compatibility;
user-facing branding and primary CLI are Fabro. All new submissions name a
project workflow, and share the source commit as its immutable revision.
