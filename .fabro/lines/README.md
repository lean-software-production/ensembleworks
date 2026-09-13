# Project Fabro lines

These workflows belong to this repository and are read from the submitted Git
commit. Submit through a BB thread using the Fabro plugin; the DAG card and final
acceptance review stay attached to that thread.

| Line | Purpose |
| --- | --- |
| [refactor-code-quality](refactor-code-quality/README.md) | General behavior-preserving refactoring with caller-selected checks. |
| [refactor-fabro-plugin](refactor-fabro-plugin/README.md) | Dogfood the Fabro plugin with fixed scope boundaries and plugin checks. |
| [ralph-loop](ralph-loop/README.md) | Implement an approved, committed feature plan through a bounded implement/check/review loop. |

The dedicated lines include `work-order.example.json`. Copy an example outside
the working source tree, fill its placeholders and full base commit, then submit
it from the originating thread. Do not use an example's request key for multiple
jobs with different inputs. Creating a line does not launch it.

Verify the project runners:

```sh
node --test .fabro/lines/tests/lines.test.mjs
```

An opt-in live Ralph graph regression uses shell substitutes for agent nodes,
checks a failed first iteration followed by a successful repair, and makes no
model calls:

```sh
FABRO_GRAPH_TEST=1 node --test .fabro/lines/tests/lines.test.mjs
```

The live check requires the local Fabro service and its existing CLI dev-token.
Fabro's validator emits advisory `goal_gate_has_retry` warnings because terminal
failures intentionally do not retry through goal-gate fallback targets. Repairs
use explicit graph edges and the runtime attempt budget.
