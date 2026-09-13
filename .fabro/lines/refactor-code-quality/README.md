# Refactor code quality

This project owns this line. Edit its workflow, runner, schemas, and acceptance
instructions together. The Fabro BB plugin executes the committed definition
named by the work order; it does not choose or generate the workflow at run time.

For a small server utility refactor, use a complete work order with a full commit
SHA, this `line.json` path, explicit source/test scope, and behavior-preserving
acceptance criteria. Suggested input commands for the LiveKit URL resolver:

```json
{
  "setupCommands": ["bun install --frozen-lockfile"],
  "validationCommands": [
    "bun server/src/livekit-url.test.ts",
    "bun run --filter '@ensembleworks/server' typecheck"
  ],
  "qualityCommand": "git diff --check"
}
```

Use one attempt, 20 minutes, and at most three changed files for an initial test.
`git diff --check` detects whitespace errors, not overall code quality: the
independent reviewer must explain a concrete improvement and check each criterion.
Quality command failures block delivery by default. Use `qualityMode: "report"`
only for commands where a nonzero exit is an expected report of existing findings.

The runner writes evidence to `.fabro-output`, rechecks before committing, and
does not merge or push. Its work-order time budget applies between stages and to
shell commands; it is not a hard deadline for a waiting agent. The workflow's node
timeout is 30 minutes. Scope and interaction-contract obligations come from the
work order and repository instructions; choose a non-interaction utility for a
small first run.

Commit the line files before submitting. Dirty files are deliberately excluded.
