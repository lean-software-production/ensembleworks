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

Through task T2. `server.ts`, `app.tsx` and `host.ts` are still the T1
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

The execution engine, BB-thread backend, storage, tools, CLI, RPC surface,
DAG UI and human gates land in later tasks (T3–T7).

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
