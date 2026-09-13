---
name: attractor
description: Author and run Attractor DOT workflows, and inspect a run's progress.
---

# Attractor

Attractor runs a Graphviz DOT workflow graph — a pipeline of agent, prompt,
command, conditional, and human-gate stages — as a BB-thread-backed process,
with live execution state. This skill covers authoring a graph, running it,
and reading back its progress.

## Authoring a graph

A workflow is a `digraph Name { ... }`. The graph needs exactly one start
node and one exit node:

```dot
digraph Example {
  graph [goal="What this run is trying to accomplish"]
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  plan  [label="Plan", prompt="Read the task and write a short plan."]
  build [shape=parallelogram, script="npm run build", goal_gate=true]
  start -> plan -> build -> exit
}
```

Node shape (or an explicit `type=` attribute) selects the handler:

| Shape | type= | Handler | Needs |
|---|---|---|---|
| `Mdiamond` | `start` | entry point | — |
| `Msquare` | `exit` | run termination | — |
| `box` (default) | `agent` | full-tool BB worker thread | `prompt` |
| `tab` | `prompt` | single-call worker thread | `prompt` |
| `parallelogram` | `command` | runs a shell script on the environment's host | `script` |
| `hexagon` | `human` | asks a human to choose an outgoing edge (or type free text on a `freeform=true` edge) | — |
| `diamond` | `conditional` | routes on the previous stage's outcome, no work of its own | — |
| `component` | `parallel` | fans out over its outgoing edges | — |
| `tripleoctagon` | `parallel.fan_in` | where fanned-out branches converge | — |

Useful node attributes: `max_visits` (loop cap), `max_retries` (retries a
thrown/infra fault, not a business failure), `goal_gate=true` (the run only
succeeds if every goal-gated node's last outcome was `succeeded` or
`partially_succeeded`), `model`/`provider`/`reasoning_effort` (or a graph-level
`model_stylesheet`), `output_schema="routing"` (the stage must call the
`attractor_result` tool with a structured routing decision instead of just
answering in text).

Edges route by `condition="outcome=succeeded"` (see the full grammar in the
plan doc), by label (a human gate, or an agent's `preferred_next_label`), or
unconditionally by highest `weight`.

A human gate's outgoing edges are its options — label them with an optional
accelerator prefix (`"[A] Approve"`, `"R) Revise"`, or `"A - Approve"`); add
`freeform=true` to an edge to also accept free text. A human answers a
blocked run either by clicking a button in the chat surface, or from a
terminal:

```
bb attractor answer <runId> <label|text>
```

`<label>` matches an option's raw edge label, its accelerator-stripped
text, or its accelerator key, case-insensitively; anything else is only
accepted as free text if the gate is `freeform`. A run blocked on a human
gate shows status `blocked` (`bb attractor status <runId>`) until answered.
A gate with a `timeout` and nothing to answer falls back to the
`human.default_choice` context key if one is set (e.g. via `attractor_run`'s
`inputs`), otherwise the stage fails clearly rather than hanging forever.

**Not yet implemented:** a `command` node's `output_schema` beyond the
literal string `"routing"` (an inline JSON Schema) is accepted but not
separately validated; only the `routing` shape is checked.

## Running a graph

Call `attractor_run` with either `source` (the DOT text inline) or `path` (a
file in this thread's own environment, resolved relative to its root — a
path that would escape the root is rejected). A successful call returns
`{ runId, previewDirective }`; **emit `previewDirective` exactly once, on its
own line**, so the room sees a live card for the run. The run is validated
and persisted before the call returns, then executed in the background —
it survives a plugin restart from its last checkpoint.

```
attractor_run({ path: "workflows/plan-implement-review.dot", title: "Ship the fix" })
```

## Inspecting a run

`attractor_inspect({ runId })` returns the run's status
(`running`/`succeeded`/`failed`/`cancelled`) and every stage's status, visit
count, and (for an agent/prompt stage) its worker `threadId` — open that
thread to read the stage's own conversation.

## From a terminal

```
bb attractor validate <path>              # lint a graph, no run
bb attractor run <path> [--input k=v]     # same as the tool, from argv
bb attractor status <runId>
bb attractor stages <runId>
bb attractor events <runId> [--since seq]
bb attractor stop <runId>
bb attractor answer <runId> <label|text>  # answer a blocked human gate
```

## Structured results (`output_schema="routing"`)

A stage whose prompt asks for a routing decision must call the
`attractor_result` tool **exactly once**, with:

```json
{
  "outcome": "succeeded",
  "preferred_next_label": "Accept",
  "context_updates": { "reviewed": true }
}
```

`outcome` is required (`succeeded`, `failed`, or `partially_succeeded`);
`preferred_next_label`, `suggested_next_ids`, `failure_reason`, and
`context_updates` are optional. An invalid or missing report gets you a
follow-up message in the same thread asking to correct it (up to twice)
before the stage is recorded as failed.
