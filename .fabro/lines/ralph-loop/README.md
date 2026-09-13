# Ralph feature implementation loop

Use this line after the feature plan has been agreed in a BB thread. Save that
approved plan as a Markdown file in the project and commit it alongside the line.
Submit the plan path, real test/setup commands, scope, and concrete acceptance
criteria. `work-order.example.json` shows the input shape; replace every placeholder.

The line reads the plan **from the work order's Git commit**, snapshots its text,
and records its SHA-256. Dirty edits and symlink plans are rejected or excluded.
It prepares a task checklist, implements remaining work, runs checks, and asks an
independent reviewer to compare the entire result with the original plan. Failed
validation or review routes back through the attempt budget. Context for each
iteration comes from the approved plan, task state, execution notes, and prior
findings in `.fabro-output`.

The task checklist is `.fabro-output/progress.json`:

```json
{"tasks":[{"id":"task-1","title":"Implement the requested behavior","done":false,"criteria":[0]}]}
```

Every task references zero-based work-order acceptance criterion indexes; all
criteria must be covered. The first checklist is frozen by the check-plan stage.
Later iterations can change completion flags but cannot delete or redefine tasks.
Delivery requires all tasks done, real source changes, passing final checks, and
an independent `.fabro-output/review.json` such as:

```json
{"verdict":"accept","criteria":[{"index":0,"passed":true,"evidence":"Specific test and inspected behavior"}]}
```

Each criterion needs its own passing evidence. The reviewer also writes readable
`review.md`. These records organize review; the originating BB thread still
independently assesses the actual diff, tests, and original plan before accepting.
The source plan and `.fabro/lines` cannot be modified by this workflow.

For interaction-bearing code, every stage carries the repository's contract
obligations: declare/extend contracts, observe RED before the fix, stop if RED is
unreachable, implement observations in both adapters, and independently reproduce
RED/GREEN during review. Include the concrete affected contracts in the work order.

The example allows three implementation attempts and a 60-minute elapsed budget.
Each Fabro node also has a 30-minute timeout. Exhaustion fails with retained
progress; it does not claim completion or launch another run. The budget is not a
hard global process-tree deadline while an agent is waiting. `qualityMode` defaults
to `gate`; use `report` only when nonzero exits are expected findings for review.

Submit from the originating thread with `bb fabro submit '<completed JSON>'`.
There is no automatic merge, push, deployment, or unlimited loop. Creating this
line does not execute the plan.
