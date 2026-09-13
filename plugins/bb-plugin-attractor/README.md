# Attractor

A BB plugin that runs **Graphviz DOT workflow definitions** (the StrongDM
Attractor dialect, plus the Fabro extensions that matter for a software
factory) with **BB threads as the agent backend**, and renders the
**workflow DAG with live execution state** (current node, visited path,
per-node status, visit counts, timing) inside BB chat and the thread side
panel.

See `docs/plans/2026-09-13-attractor-runner-plan.md` (in the main
repository) for the full design, the supported DOT dialect, the engine
contracts, and the task breakdown this plugin is built against.

## Authoring a graph

A workflow is a `digraph Name { ... }` (see "Supported DOT dialect" below for
the full grammar). Every graph needs exactly one start node and one exit
node; `dot/validate.ts` rejects anything else before a run is ever started.

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

Three worked examples live in `examples/`, each copied verbatim from the
plan's Appendix and exercised end to end in `tests/e2e.test.ts`:

- `examples/plan-implement-review.dot` — a plan/implement/test loop with a
  `model_stylesheet`, a human approval gate, `max_visits` loop caps, a
  goal-gated `command` (test) node, and a structured `output_schema="routing"`
  review stage.
- `examples/parallel-review.dot` — a `component` fan-out into three
  independent review lenses that converge on a `tripleoctagon` fan-in node.
- `examples/branch-loop.dot` — a `command` (build) node, a `diamond`
  conditional routing on the previous stage's outcome, and a graph-level
  `max_node_visits` bound so a persistently broken build terminates the run
  instead of looping forever.

Validate a graph without running it: `bb attractor validate <path>`.

### Dialect at a glance

| Shape | `type=` | Handler | Needs | Notes |
|---|---|---|---|---|
| `Mdiamond` | `start` | entry point | — | reserved ids `start`/`Start` also default to this |
| `Msquare` | `exit` | run termination | — | reserved ids `exit`/`Exit`/`end`/`End` also default to this |
| `box` (default) | `agent` | full-tool BB worker thread | `prompt` | model/provider/reasoning_effort from the node, the `model_stylesheet`, or the origin thread's defaults, in that order |
| `tab` | `prompt` | single-call worker thread | `prompt` | v1 is otherwise identical to `agent` — see "Deviations" |
| `parallelogram` | `command` | runs `script` on the environment's host via `host.ts` | `script` | writes `command.output`/`command.exit_code` |
| `hexagon` | `human` | asks a human to pick an outgoing edge, or free text on a `freeform=true` edge | — | see "Human gates" below |
| `diamond` | `conditional` | routes on the previous stage's outcome; no work of its own | — | see `context.last_outcome` |
| `component` | `parallel` | fans out over its outgoing edges | — | pairs with a `parallel.fan_in` node |
| `tripleoctagon` | `parallel.fan_in` | where fanned-out branches converge | — | branches write only to `parallel.results`/`parallel.branch_count`, never a top-level merge |

Graph attributes: `goal`, `rankdir`, `model_stylesheet`,
`default_max_retries`, `on_failure` (`route`\|`exit`\|`succeed`),
`retry_target`, `fallback_retry_target`, `max_node_visits` (`0` = unlimited).

Node attributes: `label`, `shape`/`type`, `class`, `prompt`, `script`,
`timeout`, `max_visits`, `max_retries`, `on_failure`, `retry_target`,
`fallback_retry_target`, `goal_gate`, `allow_partial`, `output_schema`
(`"routing"` or an inline JSON Schema string — only `"routing"` is actually
validated in v1), `model`, `provider`, `reasoning_effort`
(`low`\|`medium`\|`high`), `max_parallel`, `question_type`, `join_policy`
(`all`\|`any`\|`first` — v1 implements `all`), `stdin_source`.

Edge attributes: `label`, `condition`, `weight` (int, default `0`),
`freeform` (human gates), `loop_restart` (parsed, ignored in v1).

Condition grammar (`dot/conditions.ts`):
`Key Op Value` or a bare `Key` (truthiness), joined with `&&`/`||`/`!`.
`Key` is `outcome`, `preferred_label`, or a `context.`-prefixed (or bare)
dot-path. `Op` is `= != > < >= <= contains matches`. `outcome` is one of
`succeeded`/`failed`/`partially_succeeded`/`skipped`.

Routing, after a stage completes, tries in order: (1) the outcome's
`jumpToNode`; (2) a conditional edge whose condition is true (highest
`weight`, then lexicographically smallest target); (3) `preferred_label`
matched against an edge's label (accelerator prefixes stripped); (4)
`suggested_next_ids`; (5) a failed outcome's effective `on_failure`; (6) an
unconditional edge; (7) the node's then the graph's `retry_target`/
`fallback_retry_target`, subject to the target's own `max_visits`; (8) no
next node — the run terminates with this node's outcome. See the plan's
"Supported DOT dialect" section for the exact algorithm.

### Human gates

A `hexagon` node's outgoing edges are its options — label them with an
optional accelerator prefix (`"[A] Approve"`, `"R) Revise"`, or
`"A - Approve"`); add `freeform=true` to an edge to also accept free text
(routed via that edge, bypassing the button options). A human answers a
blocked run either by clicking a button in the chat/panel surface, or from a
terminal: `bb attractor answer <runId> <label|text>`. A run blocked on a
gate reports status `blocked` until answered; a gate with a `timeout` and
nothing to answer falls back to the `human.default_choice` context key if
one is set (e.g. via `attractor_run`'s `inputs`), otherwise the stage fails
clearly rather than hanging forever.

## Running a graph

**Agent tools** (registered for the origin thread only, via
`bb.agents.configure`):

- `attractor_run({ source | path, inputs?, title? })` — validates and
  persists a run, starts it in the background, and returns
  `{ runId, previewDirective }`. Emit `previewDirective` (a
  `::attractor-run{run="<runId>"}` message directive) exactly once, on its
  own line, so the room sees a live card.
- `attractor_inspect({ runId })` — the run's status and every stage's
  status/visit count/worker `threadId`.
- `attractor_result` — registered only for a spawned worker thread whose
  node declared `output_schema`; the worker must call it exactly once with
  the structured routing decision (see "Structured results" below).

**CLI** (`bb attractor …`, scoped to the calling thread's own runs):

```
bb attractor validate <path>              # lint a graph, no run
bb attractor run <path> [--input k=v]     # same as attractor_run, from argv
bb attractor status <runId>
bb attractor stages <runId>
bb attractor events <runId> [--since seq]
bb attractor stop <runId>
bb attractor answer <runId> <label|text>  # answer a blocked human gate
```

**RPC** (`server/contracts.ts`, consumed by `ui/*`/`app.tsx` via `useRpc`):
`getRun`, `listRuns`, `getGraph`, `getEvents`, `stopRun` — every method is
scoped to the calling thread's own runs.

**Realtime**: the `attractor-runs` channel publishes `{ runId, threadId }`
on every event; `ui/run-panel.tsx`'s `RunPanel` subscribes via
`useRealtime` and refetches.

**Directive / panel**: the `attractor-run` message directive
(`::attractor-run{run="<runId>"}`) renders a header, the DAG, and an
expandable stage list inline in chat; "Open in right panel" opens the same
run in the thread side panel with the full DAG, stage list, event timeline,
and a Stop button.

### Structured results (`output_schema="routing"`)

A stage whose prompt asks for a routing decision must call the
`attractor_result` tool exactly once with:

```json
{
  "outcome": "succeeded",
  "preferred_next_label": "Accept",
  "context_updates": { "reviewed": true }
}
```

`outcome` is required (`succeeded`, `failed`, or `partially_succeeded`);
`preferred_next_label`, `suggested_next_ids`, `failure_reason`, and
`context_updates` are optional. An invalid or missing report gets a
follow-up correction message in the same thread (up to twice) before the
stage is recorded as failed.

See `skills/attractor/SKILL.md` for the same material pitched at an
authoring/running agent.

## Status

Through task T7 (examples, docs, end-to-end). `examples/*.dot` holds the
three worked graphs above; `tests/e2e.test.ts` runs each of them through
the *real* engine and handler adapters (only the BB-facing dependencies —
an `AgentBackend`, a command `exec`, a `HumanInterviewer` — are scripted
fakes), asserting the visited node path, a plan/implement/review approve
*and* revise-then-approve loop, a three-way parallel fan-out/fan-in, and
both a build-loop success and a build that never turns green within
`max_node_visits`. The "Authoring a graph"/"Running a graph" sections above
are this task's README docs; `docs/plans/2026-09-13-attractor-runner-plan.md`'s
Status line is updated alongside this commit. A whole-branch review then
produced two blocking findings (worker tool gating, dispose behaviour) and
several minor ones; their fixes are recorded at the end of "Deviations from
the plan".

`handlers/human.ts` + `server/human.ts` + `ui/human-gate.tsx`
implement human gates end to end (see the T6 section below); `app.tsx`
registers the real `attractor-run` message directive and thread-panel
action, backed by the DAG/stage-list/event-timeline UI described below.
`server.ts` and `host.ts` are the T4 integration described below.
T2 adds the **DOT front-end** — parsing and validating workflow graphs, with
no execution yet:

- `dot/lexer.ts` — tokenizer (punctuation, quoted strings with escapes,
  `//` and `/* */` comments, bare words covering identifiers/numbers/durations).
- `dot/parser.ts` — token stream -> statement-list AST for
  `digraph Name { ... }` (graph/node/edge defaults, node statements, edge
  chains, subgraph blocks scoping `node[..]`/`edge[..]` defaults).
- `dot/graph.ts` — AST -> a typed `WorkflowGraph` (shape/`type=` -> handler
  kind, attribute typing incl. booleans/integers/durations/enums, node/edge
  default resolution, reserved `start`/`exit`/`end` id fallback).
- `dot/validate.ts` — lint rules producing `Diagnostic[]` (no/multiple
  start or exit nodes, unreachable nodes, edges to missing nodes, malformed
  conditions, agent/command nodes missing `prompt`/`script`, missing retry
  targets, conditions on `selection=random` nodes), plus defensive
  `invalid-enum-value`/`invalid-numeric-value` checks on `on_failure`,
  `reasoning_effort` and `max_visits`.
- `dot/conditions.ts` — the edge-condition grammar (`Expr`/`Or`/`And`/
  `Unary`/`Clause`), parser + evaluator, with numeric-vs-lexical comparison,
  `contains`/`matches`, and Fabro-style truthiness.
- `dot/stylesheet.ts` — `model_stylesheet` parser + CSS-like cascade
  resolver (`*` / shape / `.class` / `#id` specificity, last-rule-wins ties,
  explicit node attributes overriding the stylesheet).

All of `dot/` is pure (no BB imports, no I/O, no randomness) and is
exercised against the three Appendix example graphs and real Fabro job
graphs (see "Deviations from the plan" below) in
`tests/dot-integration.test.ts`.

T3 adds the **execution engine** (`engine/`), still entirely BB-free — it is
driven by fake handlers/clock/checkpoint sink in its own tests, and only
gets a real BB-thread backend in T4:

- `engine/types.ts` — the contracts from the plan's "Engine contracts"
  section (`Outcome`, `HandlerInput`, `Handler`, `HandlerRegistry`,
  `EngineOptions`, `RunResult`, `RunEvent`, `StageScopedEvent`), plus a
  `Checkpoint` shape (not fully specified by the plan; see "Deviations"
  below) and a `Context` interface backing `engine/context.ts`.
- `engine/context.ts` — a dot-path key-value context (`get`/`set` walk
  `"response.plan"` into nested objects, matching `dot/conditions.ts`'s own
  `context.<path>` resolution). Both directions guard against
  `Object.prototype` pollution: `get` only resolves *own* keys (so it never
  returns an inherited `Object.prototype` member like `constructor`), and
  `set`/`merge` refuse (throw) a path with a `__proto__`, `constructor` or
  `prototype` segment rather than writing through to the prototype chain.
  `merge()` dot-traverses each `context_updates` key the same way `set()`
  does — a key like `"build.status"` lands at `context.build.status`, not a
  literal top-level `"build.status"` key — so anything a handler merges in
  is readable the same way an edge `condition` reads it. `clone()`/
  `toObject()` give parallel-branch isolation and persistence, all with
  full deep-copy semantics.
- `engine/router.ts` — the next-node selection cascade (steps 1-6, plus
  `selectRetryTargetCandidates`/`selectRetryTarget` for step 7 and
  `isRetryEligible` for whether a null decision should consult it):
  `jump_to_node`, conditional edges (weight then lexical target tiebreak),
  `preferred_label` (with accelerator-prefix stripping on both sides,
  matched against *any* outgoing edge's label — including a conditional
  edge whose condition just evaluated false), `suggested_next_ids` (same,
  any edge), `on_failure` (`route`/`exit`/`succeed`, including `succeed`'s
  outcome rewrite-and-retry of steps 2-6), unconditional edges, and
  node-then-graph `retry_target`/`fallback_retry_target`.
  `selectRetryTargetCandidates` returns the *whole* existing-node cascade
  (not just its first entry) so the engine can apply `max_visits` to each
  candidate in turn — a visit-exhausted `retry_target` falls through to
  `fallback_retry_target` rather than ending the cascade. Step 7 is only
  ever consulted for a genuinely unresolved failure (or a chosen edge whose
  target turned out visit-exhausted) — never for a non-failed outcome that
  simply dead-ends, which instead terminates via step 8 with its own
  outcome; otherwise a graph-level `retry_target` on a node with no
  outgoing edges would route to itself forever once it succeeded.
- `engine/events.ts` — stamps a handler's narrow `StageScopedEvent` (`log`,
  `agent.thread`, `human.requested`/`human.answered`) into a fully-formed
  `RunEvent` (`runId`/`ts`/`stageId`/`nodeId`).
- `engine/engine.ts` — the walker: visit tracking and `max_visits`/
  `max_node_visits` gating (a non-enterable candidate is skipped and
  routing falls back to step 7 from the *completing* node, itself walking
  every candidate under the same `max_visits` gate), goal-gate evaluation
  at run termination (recorded for every visited node, including one
  executed inside a `parallel` branch — a branch node is a visited node),
  retries with fixed 1s/2s/4s delays via an injected clock (only for a
  thrown handler error — a returned `Outcome{status:"failed"}` is a
  business outcome that goes through the normal `on_failure` cascade, not
  the retry loop; T4 revisits this once the real command handler maps a
  process exit code to an outcome), `parallel`/`parallel.fan_in` fan-out
  with per-branch context clones, a fork node's `max_parallel` bounding how
  many branches run concurrently (unset/0 = unbounded), and
  `parallel.results`/`parallel.branch_count` written to the parent context
  only (never a top-level branch merge), checkpoint saves after every
  non-terminal stage, checkpoint-driven resume, and cancellation via
  `AbortSignal`. Event `stageId`s carry `<nodeId>@<visit>#<attempt>` for
  `stage.started`/`stage.completed`/`stage.failed`; the identity form
  `<nodeId>@<visit>` (no attempt) is what handlers, the checkpoint sink and
  `stage.skipped` see, per the plan's "`#<attempt>` only in events, never
  as identity".

All of `engine/` is pure (no BB imports, no timers of its own, no
randomness — the clock and checkpoint sink are injected) and is exercised
with fake handlers only; `tests/engine.test.ts` includes a full recorded
event-sequence walk of the Appendix's `PlanImplementReview` example (a plan
revision loop, a failing-then-passing test node, and a routing-JSON review
node) as its integration-level check.

T4 adds the **BB integration** — the plugin actually runs a graph now:

- `server/backend.ts` — the BB-thread `CodergenBackend`: spawns a hidden
  worker thread per `agent`/`prompt` stage (reusing the origin thread's
  environment), resolves its model/provider/reasoning_effort tuple
  (`model_stylesheet`, then explicit node attributes, then the origin
  thread's own provider/defaults — validated against the live
  `bb.sdk.providers.models` catalog, never silently substituted), and waits
  for `thread.idle`/`thread.failed`/`thread.deleted` (registering its three
  `bb.events.on` listeners exactly once, since the SDK has no unsubscribe,
  and dispatching by threadId through an internal map — a fast/replayed
  completion is also reconciled immediately via `bb.sdk.threads.get`
  without waiting for the event). A `thread.failed`/`thread.deleted`
  completion **throws**, which is deliberate: engine.ts's own
  `max_retries` machinery only retries a *thrown* handler error, never a
  returned business `Outcome`, so a dead worker thread is exactly the
  "infra fault" that mechanism is for (see T3's README note it flagged as
  needing T4 to settle). For an `output_schema` node, the worker must call
  the `attractor_result` tool; an invalid or missing report gets up to two
  corrective re-prompts of the same thread (`bb.sdk.threads.send`) before
  the stage is recorded failed. Every wait also races `input.signal`: `bb
  attractor stop`/`stopRun` aborts the engine's per-run `AbortController`,
  which the backend observes by calling `bb.sdk.threads.stop` on the live
  worker thread and settling the stage as cancelled — without this, a run
  parked on an agent/prompt stage could never actually be stopped, since
  nothing else was watching the signal. Once a stage settles (however it
  settles), its worker thread is archived (`bb.sdk.threads.archive`),
  best-effort, so a plugin doesn't accumulate a hidden thread per stage for
  the life of the project.
- `handlers/agent.ts` / `handlers/prompt.ts` — thin adapters from the
  engine's `Handler` shape onto `AgentBackend.run`, carrying the per-run
  threadId/projectId/environmentId the backend needs. `prompt` (the `tab`
  shape's "single LLM call, read-only tools") is otherwise identical to
  `agent` in v1 — see "Deviations" below.
- `handlers/command.ts` — runs a node's `script` through an injected `exec`
  dependency (wired to the real `host.ts` RPC in `server/service.ts`) and
  maps its exit code/timeout to an Outcome, writing `command.output` /
  `command.exit_code` to context per the dialect's context-keys list.
- `handlers/conditional.ts` — a `diamond` node has no prompt/script of its
  own; it mirrors the *previous* stage's outcome status via a new
  `context.last_outcome` key engine.ts now writes after every stage (not in
  the plan's literal context-keys list — see "Deviations" below), which is
  what lets the Appendix's BranchLoop `check` node's own
  `condition="outcome=succeeded|failed"` edges mean anything.
- `handlers/parallel.ts` / `handlers/start-exit.ts` — trivial always-succeed
  handlers for `parallel`/`parallel.fan_in`/`start`/`exit`: engine.ts itself
  already does the fan-out/fan-in and goal-gate/termination bookkeeping
  around these nodes' own stage.
- `host.ts` / `host-contract.ts` — the real `exec` host RPC: runs `script`
  via `/bin/sh -c` in a detached process group (so a timeout/abort can kill
  a build tool's own children, not just the shell), `cwd` = the
  environment's path, `ATTRACTOR_RUN_ID`/`ATTRACTOR_NODE_ID` env, optional
  stdin, and stdout/stderr bounded to the last 64 KiB (tail, not head).
- `server/store.ts` — a `better-sqlite3`-backed `RunStore` (runs, stages,
  events; append-only migrations, matching `bb-plugin-assembly-lines`'s
  `JobStore` shape), taking the `Database.Database` handle directly so it
  is unit-testable without a fake `bb`.
- `server/service.ts` — run lifecycle: validates and persists a run,
  starts it in the background (`runEngine` with the real handler
  registry), persists every event/stage transition and checkpoint,
  publishes `bb.realtime` on the `attractor-runs` channel, and resumes
  every `running` run from its last checkpoint (`resumeRunningRuns`,
  called by the `attractor-runs` background service on load — this is how
  a run survives a plugin restart). `resolveWorkflowPath` resolves a
  `path` input relative to the origin thread's environment root and
  rejects any traversal outside it.
- `server/contracts.ts` — the `getRun`/`listRuns`/`getGraph`/`getEvents`
  RPC contract; every read is scoped to the calling thread's own runs.
- `server.ts` — wires all of the above: the `attractor_run` /
  `attractor_inspect` / `attractor_result` agent tools, `bb agents.configure`
  gating (a spawned worker thread gets only `attractor_result` when its
  node needs a structured result, otherwise no plugin tools at all; the
  origin thread gets `attractor_run`/`attractor_inspect` + the `attractor`
  skill), the `bb attractor validate|run|status|stages|events|stop` CLI,
  and the `attractor-runs` background service.

`tests/server/backend.test.ts`, `tests/server/service.test.ts` and
`tests/server/server.test.ts` exercise this against
`@get-bb/plugin-sdk/testing`'s `createFakePluginHost` (spawn args, idle →
output → outcome, a failed thread retrying, structured-result
validation/retry, path-traversal rejection, directive text, RPC ownership
scoping, and resuming a run stuck "running" across a simulated reload);
`tests/host.test.ts` exercises the real `exec` host entry via
`experimental_createHostEntryHarness` (exit code, stdin, timeout/kill,
output bounding); `tests/handlers/*` and `tests/server/store.test.ts` cover
the rest with plain fakes.

T5 adds the **DAG UI**:

- `ui/dag.tsx` — a pure `layoutGraph()` (dagre, rank direction from the
  graph's `rankdir`) plus `DagView`, an SVG rendering with a live execution
  overlay: shape hints per `handlerKind` (start/exit/human/command/
  conditional/parallel each get a distinct outline; only agent/prompt stay a
  plain rounded rect), status colour (`pending`/`running`/`succeeded`/`failed`/`skipped`), a
  visit-count badge once `visit > 1`, the run's current node highlighted,
  and traversed edges (derived from `edge.selected` events, not persisted
  per-edge state) drawn solid/arrowed with the last-selected reason and
  label in a `<title>`; an agent/prompt node with a known worker thread is
  clickable.
- `ui/stages.tsx` — the stage list (node, status, visit, duration via
  `formatDuration`, the node's declared provider/model, and an "Open
  thread" link when a stage has a worker thread).
- `ui/events.tsx` — a paged (`PAGE_SIZE = 50`), oldest-first-within-page
  event timeline starting on the most recent page, with a one-line
  `describeEvent` summary per `RunEvent` variant.
- `ui/run-panel.tsx` — `RunPanel`, the data-fetching component shared by
  both surfaces: `getRun`/`getGraph`/`getEvents` on mount, refetch on any
  `attractor-runs` realtime signal (or one naming this run), a header
  (title, status, elapsed, *visited*/total stages), and mode-specific
  layout (`"directive"`: DAG + expandable stage list + "Open in right
  panel"; `"panel"`: DAG + stage list + event timeline + a Stop button
  while the run is active).
- `app.tsx` — registers the `attractor-run` `messageDirective` (renders
  `RunPanel` in `"directive"` mode, or an error when the directive's `run`
  attribute is missing/blank) and the matching `threadPanelAction`
  (`"panel"` mode, reading `runId` from the tab's `params`).

`ui/*` and `app.tsx` only ever import from `server/contracts.ts` (zod
schemas + their inferred TS types) and `engine/types.ts` (the pure
`RunEvent` union) — never `server/service.ts` or `server/store.ts`, which
pull in `better-sqlite3`, a native module that must never end up in the
app's esbuild bundle (`bb plugin build .`'s `dist/app.js` is ~60 KB with
zero references to it, vs. `dist/server.js`'s ~850 KB).

`tests/ui/dag.test.ts` covers `layoutGraph` directly (deterministic,
node-environment, no DOM); `tests/ui/dag.render.test.tsx`,
`tests/ui/stages.test.tsx` and `tests/ui/events.test.tsx` cover their
respective components under jsdom; `tests/app.test.tsx` exercises the
directive and panel end-to-end through `@get-bb/plugin-sdk/testing/app`'s
`loadPluginApp`/`renderSlot` against a fake RPC (invalid/blank run id,
node/status rendering, "Open in right panel", the Stop button, realtime
refetch, and error/not-found states).

T6 adds **human gates** — the `hexagon` handler, end to end:

- `handlers/human.ts` — builds the option list from `gate`'s outgoing edges
  (`parseAcceleratorLabel` reads a `"[K] label"` / `"K) label"` / `"K - label"`
  prefix into `{ key, text }`; edges with no `condition` and just a `label`
  are the choices), marks `freeform: true` when any outgoing edge declares
  `freeform=true`, and asks an injected `HumanInterviewer` — the same
  injection-seam pattern as `handlers/agent.ts`'s `AgentBackend`, so `engine/`
  stays BB-free and this handler is unit-tested with a fake interviewer (and
  exercised through the real engine in `tests/engine.test.ts`'s "human gate
  routing" block). A chosen option's raw edge label becomes the outcome's
  `preferredLabel`, so the existing routing cascade (step 3) takes it to the
  matching edge — no new routing logic needed. A free-text answer instead
  carries no edge label to match, so it sets the outcome's `jumpToNode`
  directly to the graph's `freeform=true` edge's target (cascade step 1),
  bypassing steps 2-6 entirely — without this, a free-text answer would
  fall through to step 6 and silently take one of the gate's *button* edges
  instead (validation finding, T6 round 2 — see "engine: human gate
  routing" > "routes free text along the freeform edge" in
  `tests/engine.test.ts`). Context keys written exactly
  per the plan: `human.gate.selected`, `human.gate.label` (button choices
  only), `human.gate.text` (freeform only), `human.gate.<node>.answer` /
  `.label` — `dot/validate.ts` flags a gate node id of
  `selected`/`label`/`text` as `human-gate-reserved-id` (round 2: those ids
  collide with the fixed keys above, silently clobbering one write with the
  other) and a gate with neither a labeled edge nor a `freeform` edge as
  `human-gate-no-options` (round 2: such a gate could previously only ever
  be cancelled). A user cancel, an unanswered timeout with nothing to fall
  back to, or a timed-out gate whose `human.default_choice` names no
  outgoing edge label (round 2 — previously a typo'd default choice still
  returned a bogus `succeeded`/`preferredLabel` that fell through to step 6
  and took an arbitrary unconditional edge) fails the stage clearly (never
  hangs) — and, since there's no answer to
  drive `respondWithChoice`'s own `human.answered` emit, all three failure
  branches emit
  a bare `human.answered` (no `answer`) themselves, so `applyEventToStore`
  still clears the transient `blocked` run/stage status before the routing
  cascade carries the run on through the failed gate's outgoing edges.
- `server/human.ts` — the real `HumanInterviewer`, via `bb.ui.requestInput`
  (`rendererId: "attractor-human-gate"`, from `server/contracts.ts`'s
  `HUMAN_GATE_RENDERER_ID`). Maps `requestInput`'s cancellation reasons:
  `"timeout"` → `{ kind: "timeout" }`, `"user"` (the pendingInteraction's own
  Cancel button) → `{ kind: "cancelled" }`, anything else (in particular
  `"request-aborted"`, exactly what the Stop button's `AbortSignal` produces)
  → a thrown error, so the engine treats a Stop the same way it does for an
  in-flight agent stage rather than quietly recording a declined gate.
- `server/service.ts` — wires `createHumanHandler` into the handler
  registry (an optional `humanInterviewer` dependency, defaulting to one
  that fails clearly, so every pre-T6 test that never reaches a human node
  is unaffected); `applyEventToStore` sets both the stage and the run's
  `status` to a new `"blocked"` value on `human.requested`, back to
  `"running"` on `human.answered` — never a terminal status, `recordFinish`
  always overwrites it once the run actually ends. `listRunningRunIds` now
  also picks up `"blocked"` runs so a plugin restart while a gate is waiting
  doesn't strand the run (it simply re-asks on resume, from its last
  checkpoint before the gate). `answerHumanGate(runId, answer)` backs `bb
  attractor answer` — see "Deviations" below for how it resolves a live
  `bb.ui.requestInput` interaction from outside the app's own renderer.
- `ui/human-gate.tsx` — the `pendingInteraction` renderer: one button per
  option (`[key] text`), a free-text field + Submit when the payload's
  `freeform` is true, and a Cancel button. Reads/writes the `HumanGate*`
  zod schemas in `server/contracts.ts` (payload in, `HumanGateValue` out via
  `submit()`), registered in `app.tsx` under `HUMAN_GATE_RENDERER_ID`.
- `ui/dag.tsx` gets a `"blocked"` status colour (amber) and `ui/run-panel.tsx`
  treats `"blocked"` like `"running"` for the elapsed-time ticker and the
  Stop button (a human gate can still be aborted).
- CLI: `bb attractor answer <runId> <label|text>` — matches `answer` against
  an option's raw label, its accelerator-stripped text, or its accelerator
  key (case-insensitively), falling back to free text only when the gate's
  `freeform` allows it; scoped to the run's owning thread like every other
  runId subcommand.

`tests/handlers/human.test.ts` unit-tests the handler against a fake
interviewer (options built from edges, accelerator parsing, context keys,
freeform, timeout with/without `human.default_choice`, cancellation);
`tests/engine.test.ts`'s "human gate routing" block runs it through the
real engine; `tests/server/human.test.ts` exercises the real
`bb.ui.requestInput`-backed interviewer against
`@get-bb/plugin-sdk/testing`'s fake host (the request carries the edge
options, a submitted choice/text/cancel/abort maps correctly, a malformed
or unknown submitted value is rejected rather than guessed); `tests/server/
service.test.ts` covers the run/stage `"blocked"`↔`"running"` transition and
`answerHumanGate`'s matching/ownership logic; `tests/server/server.test.ts`
adds full end-to-end coverage of `bb attractor answer` against a real
`attractor_run` (see "Deviations" below on how that test bridges the fake
host's two otherwise-disconnected interaction mechanisms); `tests/ui/
human-gate.test.tsx` covers the renderer (buttons per option, freeform
field, Cancel, invalid-payload fallback) and `tests/app.test.tsx` adds its
registration + a smoke render.

T7 adds the worked examples and end-to-end tests:

- `examples/plan-implement-review.dot`, `examples/parallel-review.dot`,
  `examples/branch-loop.dot` — the plan's three Appendix graphs, copied
  verbatim (see "Authoring a graph" above for what each one exercises).
- `tests/e2e.test.ts` — wires the *real* handler adapters
  (`handlers/agent.ts`/`prompt.ts`/`command.ts`/`conditional.ts`/
  `parallel.ts`/`start-exit.ts`/`human.ts`) to scripted fakes for the three
  BB-facing injection seams (`AgentBackend`, a command `exec` function, a
  `HumanInterviewer`) and runs each example through the real
  `dot/graph.ts` parser and `engine/engine.ts` walker, asserting the
  visited node path from the recorded `RunEvent`s. Unlike
  `tests/engine.test.ts` (trivial always-succeed fake `Handler`s), this is
  the first test to exercise the actual handler-adapter wiring
  `server/service.ts` assembles for a live run, end to end and BB-free.
  Five cases: PlanImplementReview's happy path and its
  approve/revise-then-approve loop; ParallelReview's three-way fan-out/
  fan-in (asserting `parallel.branch_count`/`parallel.results`, and the
  branch node ids as a set since branches may interleave); BranchLoop's
  build-fails-then-succeeds loop and a build that never turns green within
  `max_node_visits` (asserting the run fails its goal gate and the loop is
  actually bounded, not infinite).
- README's "Authoring a graph"/"Running a graph" sections (dialect table,
  routing cascade summary, human gates, CLI/tool/RPC/directive reference,
  structured-result contract) — this task's docs deliverable, distinct from
  `skills/attractor/SKILL.md`'s agent-facing version of the same material.
- `docs/plans/2026-09-13-attractor-runner-plan.md`'s Status line, updated
  to reflect all seven tasks landed.

## Development

From this directory:

```sh
npm --cache "$PWD/.local/npm-cache" install
npm --cache "$PWD/.local/npm-cache" run typecheck
npm --cache "$PWD/.local/npm-cache" test
bb plugin build .
```

`.local/` (the npm cache override) is gitignored, along with `dist/` and
`node_modules/`.

## Deviations from the plan

- **T2 acceptance criteria says "the three Fabro graphs stored in
  `~/.bb/plugins/assembly-lines/host-data/jobs/*/workflow.json`".** At the
  time this task ran, that directory held four job directories, but only
  **two** distinct `workflow.fabro` texts among them — the other two are
  byte-for-byte duplicates (same SHA-256 of the DOT text). Both distinct
  graphs are copied into `tests/fixtures/fabro-graphs.ts` and exercised in
  `tests/dot-integration.test.ts`; there was no third distinct graph to
  include.

- **The `edge-missing-target`/`edge-missing-source` validate rules are not
  reachable from real, authored DOT source.** `dot/graph.ts`'s statement
  walker auto-creates a node for every id mentioned in an edge chain (so
  `a -> ghost` always yields a node named `ghost`, which then falls through
  to `handler-missing-prompt` etc. instead), so a graph parsed from DOT text
  can never actually have an edge pointing at a genuinely missing node. The
  rules are still real defensive coverage — they protect `validate()` against
  any future caller that builds a `WorkflowGraph` by hand instead of via
  `parseWorkflowGraph` — and `tests/validate.test.ts` exercises them the same
  way, by pushing a synthetic edge onto an already-built graph object rather
  than parsing DOT text.

- **Graph-scope `key=value;` statements (no `graph [..]` wrapper) are not
  supported.** Idiomatic Graphviz allows a bare assignment at the top of a
  graph body, e.g. `rankdir=LR;`, as shorthand for `graph [rankdir=LR];`.
  The plan's dialect list only names the `graph [..]` form, so this parser
  treats a bare `key=value` graph-scope statement as a syntax error rather
  than a graph attribute. Prefer `graph [key=value, ...]` when authoring.

- **`Checkpoint` (T3).** The plan's engine contracts snippet references
  `checkpoint?: { save(state: Checkpoint): Promise<void>; load?: Checkpoint }`
  but never defines `Checkpoint` itself. `engine/types.ts` defines it as
  `{ runId, nextNodeId, context, visitCounts, goalGateOutcomes }` — enough
  state that loading one and resuming needs to replay nothing before
  `nextNodeId` (verified in `tests/engine.test.ts`). `server/store.ts` (T4)
  is expected to persist this shape; if that task finds it insufficient
  (e.g. for resuming mid-parallel-fan-out — see below), it should extend
  rather than replace it.

- **Checkpoint granularity vs. `parallel` fan-out (T3).** A checkpoint is
  only saved at points in the *main* walk (after a non-parallel stage
  picks its next node, and once after a whole `parallel`/`parallel.fan_in`
  group has converged), not after each individual parallel branch stage.
  Resuming mid-fan-out therefore re-runs the whole group rather than only
  the branches that hadn't finished. This wasn't in the acceptance
  criteria (which only requires "checkpoint save after every stage" and a
  resume test with a linear graph, both of which pass) and finer-grained
  parallel checkpointing did not seem worth the added complexity for v1.

- **Retry vs. `on_failure` (T3).** "Retries: `max_retries` per node with
  fixed 1s/2s/4s delays" is separate machinery from the `on_failure`
  routing cascade. This implementation treats them as covering different
  failure sources: `max_retries` retries a **thrown handler error** (e.g.
  an infra/network fault) in place, re-running the same stage; a handler
  that *returns* `Outcome{status:"failed"}` is a normal business outcome
  that is never retried in place — it goes straight through the
  `on_failure` cascade (`route`/`exit`/`succeed`) like any other outcome.
  Only once retries are exhausted does a thrown error turn into a
  synthetic `{status:"failed"}` outcome that then also goes through that
  same cascade. This reading isn't spelled out in the plan and a future
  task may need to reconcile it against T4's real agent/command handlers
  (e.g. should a non-zero command exit code retry via `max_retries`,
  or route via `on_failure` the same as a routing-JSON `failed`
  outcome? this implementation assumes the latter, since it's already an
  `Outcome`, not a throw).

- **`parallel` fan-in target (T3).** The plan describes `component`
  (fan-out) / `tripleoctagon` (fan-in) shapes but not how the engine
  should locate *which* fan-in node a set of branches converges on. This
  implementation lets each branch run its own normal routing cascade
  (so a branch may be more than one node long) until it *would* enter a
  `parallel.fan_in`-kind node, stops there without running it, and then
  has the fork itself continue the main walk at that node (first, if
  branches disagree, by sorting the reached ids lexicographically — not
  exercised by any test, since every branch in both the Appendix example
  and this task's own tests converges on the same single node).

- **Goal-gate evaluation timing (T3).** "Goal gates: at exit, every visited
  node with `goal_gate=true`..." is implemented as "whenever the run
  terminates for any reason" (reaching the `exit` node, step 8's "no next
  node", or a `max_visits`/on_failure=exit dead end), not only when an
  `exit`-shaped node is actually reached. In every graph the dialect
  requires (validate.ts requires exactly one `exit`), the two coincide for
  a successful run; for a run that dead-ends before ever reaching `exit`,
  evaluating the gate anyway can only ever keep an already-failing run
  failing, never flip a run that would otherwise succeed — so this is a
  safe superset of the literal wording, not a narrowing.

- **`context.last_outcome` (T4, new engine.ts context key).** The plan's
  "Context keys written by handlers" list doesn't include a way for a
  `conditional`/diamond node — which has no prompt/script of its own — to
  know the *previous* stage's outcome status, which its own outgoing
  `condition="outcome=succeeded|failed"` edges need (see the Appendix's
  BranchLoop example's `check` node). `engine.ts`'s `writeOutcomeToContext`
  now also writes `context.last_outcome` after every stage (main walk and
  parallel branches alike), and `handlers/conditional.ts` mirrors it as its
  own outcome. This is additive — no existing context key changed meaning —
  and is covered by a new `tests/engine.test.ts` case plus
  `tests/handlers/conditional.test.ts`.

- **`context.stage_status.<nodeId>` (T4, new engine.ts context key).**
  `last_outcome` only ever holds the *most recent* stage's status, but the
  plan's "Prompt assembly" section asks the worker prompt's prior-stages
  summary to include each prior stage's own status alongside its response
  preview. `engine.ts`'s `writeOutcomeToContext` now also writes
  `context.stage_status.<nodeId>` after every stage (main walk and parallel
  branches alike, same as `last_outcome`), and `server/backend.ts`'s
  `summarizePriorStages` reads it (plus the node's `label` from the graph) to
  build each bullet. Additive, covered by a new `tests/engine.test.ts` case
  plus `tests/server/backend.test.ts`'s prompt-assembly test.

- **`prompt` (`tab`) nodes are not actually read-only (T4).** The plan
  describes `tab` as "single LLM call, read-only tools", but BB's plugin
  SDK has no per-tool read-only restriction a plugin can apply to a
  spawned worker thread — `bb.sdk.threads.spawn` takes a permission *mode*
  (`accept-edits`/`auto`/`full`), not a tool allowlist, and that mode
  already comes from the origin thread's own defaults or the stylesheet.
  `handlers/prompt.ts` is therefore identical to `handlers/agent.ts` in
  v1; a real read-only mode would need either a BB SDK addition or a
  provider-specific permission override, out of scope here.

- **Structured-result validation only actually validates the `routing`
  shape (T4).** `output_schema` is documented as `"routing" | inline JSON
  Schema string`, but v1 only implements real validation for the literal
  `"routing"` value (`server/backend.ts`'s `validateRoutingResult`,
  matching the "Routing output schema" section's exact field list). A node
  with an inline JSON-Schema-string `output_schema` still gets the
  `attractor_result` tool and the same routing-shape check; its own schema
  string is not separately parsed or enforced. Documented in
  `skills/attractor/SKILL.md` too.

- **`inputs`/`context_updates` tool parameters are flat scalar maps, not
  arbitrary JSON (T4).** A plugin agent tool's `parameters` schema is
  turned into a JSON Schema for the provider, and the SDK's own
  `registerTool` refuses one containing a recursive local `$ref` chain —
  which is exactly what `zod`'s `z.json()` produces, being defined
  recursively. `attractor_run`'s `inputs` and `attractor_result`'s
  `context_updates` are therefore `Record<string, string | number |
  boolean | null>` rather than arbitrary JSON values. The RPC surface
  (`server/contracts.ts`), which isn't turned into provider-facing JSON
  Schema, still uses `z.json()` for a run's full context/outcome/events.

- **Human (`hexagon`) nodes (T4 stub, implemented T6).** T4 gave `human` a
  stub that always failed the stage; T6 replaces it with the real
  `handlers/human.ts` + `server/human.ts` + `ui/human-gate.tsx` described
  above. `createService`'s `humanInterviewer` dependency is *optional*,
  defaulting to one that still fails clearly (`"no human interviewer is
  configured for this plugin instance"`) — this keeps every earlier task's
  `createService({...})` call site (none of which pass one, and none of
  which reach a human node) working unchanged, and means a graph that
  somehow reaches a human node with no interviewer configured still fails
  the stage instead of hanging, exactly like the old T4 stub did.

- **"timeout -> human.default_choice" (T6) is a context key, not a new node
  attribute.** The plan's T6 task list names this behaviour without saying
  whether `human.default_choice` is a context key an earlier stage can set
  (via `context_updates` or a run's `inputs`) or an undocumented node
  attribute — `default_choice` appears nowhere in "Node attributes". This
  implementation reads it as a context key
  (`context.get("human.default_choice")`, i.e. `context.human.default_choice`
  once dot-path-nested), the more literal reading of the name and the one
  that needs no addition to the documented dialect. A timeout with no such
  context value fails the stage clearly rather than guessing. For this to be
  reachable at all, a run's `inputs` (T6 fix round 1) are now dot-path
  expanded into the initial context the same way an agent's
  `context_updates` already are — `attractor_run`'s tool schema and `bb
  attractor run --input k=v` can only produce a flat scalar map (no nested
  objects, so `attractor_run` stays representable as non-recursive JSON
  Schema for every model provider's tool list), so `inputs: {
  "human.default_choice": "[A] Approve" }` is the only shape a caller can
  actually send; `createAndStartRun` now merges it through `Context.merge`
  before persisting it as the run's `initialContext`, so the literal dotted
  key lands where `context.get("human.default_choice")` — and every
  `context.<path>` edge condition — can see it. Previously it was stored
  verbatim as a literal top-level key named `"human.default_choice"` and was
  invisible to both.

- **`question_type` (T6) is parsed, threaded through to the interviewer's
  `payload.questionType`, and otherwise left uninterpreted.** The plan lists
  `question_type` as a node attribute and names "`question_type` overrides"
  as a T6 behaviour, but never says what it overrides — there is no
  candidate value vocabulary (`"yesno"` is only ever used as an example) and
  no described rendering/routing effect to override, unlike `freeform`
  (an edge attribute with a stated meaning) or `human.default_choice`
  (named, if not fully specified). Rather than invent UI semantics the plan
  doesn't ask for, this implementation carries the attribute end to end —
  `dot/graph.ts` parses it, `handlers/human.ts` passes it to the
  `HumanInterviewer`, `server/human.ts` puts it on the `bb.ui.requestInput`
  payload — so a future renderer (or a different `HUMAN_GATE_RENDERER_ID`
  consumer) has it available, but the shipped `ui/human-gate.tsx` doesn't
  branch on it: its rendering (buttons per edge option, plus a free-text
  field when any outgoing edge is `freeform`) already covers every case the
  plan actually describes, `question_type` included.

- **Accelerator-key answers take priority over literal free text on a
  `freeform` gate (T6).** `resolveHumanAnswerValue` (`bb attractor answer`)
  matches `answer` against an option's raw label, its stripped text, or its
  accelerator key (case-insensitively) before ever falling back to free
  text — so on a gate offering `"[A] Approve"`, `bb attractor answer <run> a`
  is read as "pick Approve", not as the literal one-character text answer
  "a", even when the gate also declares `freeform=true`. This is a
  deliberate choice, consistent with how the same three forms are matched
  everywhere else (`parseAcceleratorLabel`, the router's own accelerator
  handling) — a `freeform` edge is meant to let a gate accept an answer
  outside its button set, not to make its buttons' own accelerators
  ambiguous with text that happens to collide with one. `tests/server/
  service.test.ts` locks this precedence in with a regression test.

- **`bb attractor answer` resolves a live interaction via
  `bb.sdk.threads.interactions.list`/`respond` (T6), an SDK area the plan's
  "BB plugin SDK notes" doesn't mention** (that section only documents the
  request side, `bb.ui.requestInput`). Resolving a pending interaction from
  outside the app's own `pendingInteraction` renderer needs *some* SDK
  surface; `bb.sdk.threads.interactions` (`list`/`get`/`respond`/`resolve`/
  `cancel`) is the general one for exactly this, per its own schema (a
  `PluginPendingInteraction`'s shape — `origin: { kind: "plugin", rendererId
  }`, `payload: { kind: "plugin", data }` — is what `bb.ui.requestInput`
  itself creates), so `server/service.ts`'s `answerHumanGate` uses it: list
  the run's origin thread's pending interactions, find the one whose
  `rendererId` is `HUMAN_GATE_RENDERER_ID` and whose payload's `runId`
  matches, match the given answer against an option (or accept it as free
  text when the gate allows), and `respond()` with the same
  `HumanGateValue` shape the renderer's own `submit()` would send.
  `@get-bb/plugin-sdk/testing`'s `createFakePluginHost` does **not** wire
  `bb.ui.requestInput`'s pending interactions to `bb.sdk.threads.
  interactions.*` (confirmed by direct probing — the latter simply throws
  "not stubbed" unless a test stubs it, entirely independent internal
  state from `harness.pendingInteractions`/`submitInteraction`). So
  `tests/server/server.test.ts`'s end-to-end `bb attractor answer` tests
  install a small bridge (`bridgeHumanGateInteractions`) that stubs
  `threads.interactions.list`/`respond` to read/resolve the harness's own
  `pendingInteractions`/`submitInteraction` — this is test-only plumbing to
  compensate for the fake host's two otherwise-disconnected mechanisms, not
  a claim about how the real host actually wires them together.

- **Ownership scoping applies everywhere a runId crosses a thread boundary
  (T4, not explicitly required by the plan).** `server.ts`'s shared `owned()`
  helper checks the stored run's `threadId` against the caller's own
  `threadId`, matching the ownership check `bb-plugin-assembly-lines`'s RPC
  surface already applies to its jobs. It's used by the RPC
  `getRun`/`getGraph`/`getEvents` handlers, by the `attractor_inspect` agent
  tool, and by every CLI subcommand that takes a runId (`status`, `stages`,
  `events`, `stop`) — a thread cannot read another thread's run's DOT source
  or context, nor stop its run, just by learning its id. Not called out in
  the plan's RPC list, but seemed like an obvious-enough safety property to
  apply consistently rather than only at the RPC surface.

- **T1's scaffold test is superseded, not extended (T4).** `tests/
  scaffold.test.ts` faked a minimal `bb` object (`{ log }`) and asserted
  `server.ts` logged a startup line — true of the T1 stub, but `server.ts`
  now needs the full `BbPluginApi` (storage, hosts, sdk, rpc, agents, cli,
  background) to load at all, and no longer logs anything on a bare
  happy-path load. It's replaced by `tests/server/server.test.ts`'s "loads
  and registers rpc, cli, tools, and the background service" case, which
  asserts the same "the plugin loads under the bb host" fact against a
  real (fake) host instead of a hand-rolled partial one.

- **`getGraph`'s `GraphView` now also carries `rankdir` and each node's
  declared `model`/`provider` (T5, small extension to T4's RPC surface).**
  T4's `graphViewSchema` didn't expose the graph's `rankdir` or any
  per-node model/provider, but T5's DAG explicitly needs "rank direction
  from the graph's `rankdir`" and the stage list needs a provider column.
  `server/service.ts`'s `toGraphView` now includes both, and
  `server/contracts.ts` also exports the schemas' inferred TS types
  (`RunView`/`StageView`/`GraphNodeView`/`GraphEdgeView`/`GraphView`) so
  `ui/*`/`app.tsx` can consume them without importing `server/service.ts`.
  The **provider/model shown is the node's declared DOT attribute**, not
  the live-resolved stylesheet/thread-default tuple `server/backend.ts`
  computes per run (T4's real answer to "which model actually ran this
  stage") — that resolved tuple isn't persisted per-stage anywhere a T4
  test depends on, and adding it felt like a bigger surface change than a
  UI task should make unprompted. A node with no declared `model`/
  `provider` attribute shows "—" in the stage list even though it in fact
  ran against a stylesheet- or thread-default-resolved model.

- **Added a `stopRun` RPC method (T5, not in T4's RPC list).** T4's RPC
  list was `getRun`/`listRuns`/`getGraph`/`getEvents` (all reads); stopping
  a run was CLI-only (`bb attractor stop <runId>`). T5's Panel explicitly
  needs a "Stop button", so `server/contracts.ts`/`server.ts` add a
  `stopRun` RPC with the same `owned()` thread-scoping as every other
  runId-taking surface, returning `{ stopped: boolean }` (`false` rather
  than a thrown error for "not your run" / "no such run", so the UI can't
  learn whether a foreign runId exists). Reuses `service.stopRun`, the
  same code path the CLI's `stop` subcommand already calls.

- **DAG node shapes are a simplified visual mapping, not a literal
  redraw of the DOT shapes (T5).** `ui/dag.tsx`'s `shapePoints()` gives
  every `handlerKind` its own outline: a clip-tipped diamond for `start`
  (standing in for `Mdiamond`), a plain diamond for `conditional`, a
  hexagon for `human`, a parallelogram for `command`, a clip-cornered
  rectangle for `exit` (standing in for `Msquare`), and an octagon (with
  wider corner cuts than `exit`'s, so the two stay distinct) standing in
  for both `component`/`tripleoctagon` on `parallel`/`parallel.fan_in`;
  only `agent`/`prompt` remain a plain rounded rect. This satisfies the
  plan's "start/exit/human/command distinct" acceptance without being a
  pixel-exact Graphviz shape library (no true multi-line `M`-prefix corner
  decorations, no bevelled `Msquare` double border).

- **Test-infra note: raw `render()` needs an explicit `afterEach(cleanup)`
  in this project's vitest config (T5, not a plan deviation, but worth
  recording).** `vitest.config.ts` doesn't set `test.globals`, so
  `@testing-library/react`'s own auto-cleanup (which looks for a global
  `afterEach`) never engages; every new `tests/ui/*.test.tsx` file and
  `tests/app.test.tsx` (which renders through the SDK's `renderSlot`, built
  on the same `render()`) explicitly imports `cleanup` and registers
  `afterEach(cleanup)`, matching the pattern a future UI test file should
  follow too.

- **Worker tool gating keys on `context.origin.pluginId`, not only on the
  backend's own bookkeeping (whole-branch review fix).** `bb.agents.configure`
  runs for a worker at its very first `thread.start`, which fires inside
  `bb.sdk.threads.spawn()` before the backend learns the worker's id. So a
  worker is recognised first by `origin.pluginId === bb.pluginId` (BB stamps
  the spawning plugin on the thread; the built-in Workflows plugin relies on
  the same rule) and only refined by the backend's `isWorkerThread` /
  `isAwaitingResult` sets afterwards. At that first resolution a worker gets
  `attractor_result` conservatively; the tool itself rejects (does not
  record) a report from any thread that is not a live worker awaiting a
  structured result. Workers never see `attractor_run`, `attractor_inspect`
  or the `attractor` skill, so a stage cannot fan out recursively. Workers
  are spawned as root hidden threads (no `parentThreadId`), as a hidden
  thread with a parent would report its turns to the origin thread.
  Known limitation: the backend only learns a worker's id once `spawn`
  resolves, so an `attractor_result` call that arrives before that (the
  model would have to emit a tool call before the spawn RPC returns) is
  rejected and costs one of the two corrective re-prompts; the stage still
  converges.

- **Dispose semantics (whole-branch review fix).** `server.ts` threads its
  `lifecycle` AbortController into `createService` as `disposeSignal`. On
  dispose/reload every in-flight run's engine is aborted (which stops its
  worker threads), no further engine is started, and — unlike an explicit
  `stopRun` — no terminal status is persisted: the run is left `running` at
  its last checkpoint for the next plugin instance's `resumeRunningRuns()`.
  `stopRun` now marks the run `cancelled` synchronously so `bb attractor
  stop` and the panel's Stop button read back the new state immediately.

- **`RunStore` is the single owner of the schema.** Its constructor runs the
  idempotent `CREATE … IF NOT EXISTS` statements; `server.ts` no longer also
  passes them through `bb.storage.migrate`, so tests that open a store on an
  in-memory database and the plugin host see exactly the same setup path.
  Versioned migrations, when needed, should be added to `RunStore` too.

- **Panel refetch coalescing.** The realtime channel publishes once per
  engine event; `ui/run-panel.tsx` coalesces bursts into one trailing
  refetch (150 ms) and the service caches each run's parsed graph, so a busy
  stage no longer re-parses the DOT and issues an RPC triplet per event.
