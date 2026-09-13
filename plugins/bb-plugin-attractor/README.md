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

Through task T3. `server.ts`, `app.tsx` and `host.ts` are still the T1
scaffold (load under the bb host, no behaviour beyond a startup log line).
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

The BB-thread backend, storage, tools, CLI, RPC surface, DAG UI and human
gates land in later tasks (T4–T7).

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
