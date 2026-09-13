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

## Status

Through task T4. `app.tsx` is still the T1 scaffold (no slots yet — the
`attractor-run` message directive, thread-panel action and DAG UI land in
T5; human gates in T6). `server.ts` and `host.ts` are now the real T4
integration described below.
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

The DAG UI and human gates land in later tasks (T5–T7).

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

- **Human (`hexagon`) nodes fail clearly rather than block (T4).** Human
  gates are T6's task; until then, `server/service.ts`'s `HandlerRegistry`
  gives `human` a stub that returns `{ status: "failed", failureReason:
  "human gates are not implemented yet (T6)" }` so a graph reaching one
  fails the stage (and, via the normal `on_failure` cascade, the run) with
  a clear message instead of hanging forever waiting for an answer that
  can never come.

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
