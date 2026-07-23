# Working with Relay from your agent

Relay is a kanban board you drive from an AI agent. Work moves back and forth between humans
and AI as cards flow through a board's stages — Relay decides which card is ready, which flow
runs it, and what each step does. You talk to Relay two ways, both through one tool,
`bin/relay`:

- a **CLI** — read the board and drive a card (`bin/relay board`, `move`, `comment`, …);
- **`relay execute`** — the runner mode: it claims work from the server and runs it,
  "passing the baton" between humans and AI as cards move through a board's flows.

**Dispatch is entirely server-side.** Which cards are ready, which flow they run, and what each
step does are all decided by Relay. `bin/relay` is generic — it knows the REST API and how to
run a claimed job, but **nothing** about any particular board's columns, agents, or skills.
Per-project customization happens in **Settings › Flows**, not in a runner config file.

---

## Setup

1. **Mint a board API key:** in Relay, open `/board/settings` → **API keys** → Generate (shown
   once). Every write is attributed to the board's AI agent ("Relay AI").
2. **Configure the environment** the agent's shell uses (e.g. in `.envrc.local`, gitignored):

   ```bash
   export RELAY_URL="https://<your-relay-host>"
   export RELAY_API_KEY="relay_xxxxxxxxxxxx_…"
   ```
3. **Confirm access:** `./bin/relay board` should print your board.

`bin/relay` is zero-dependency (Python 3 standard library only), so it runs anywhere the agent
does.

## CLI

Human output by default; add `--json` for machine output. Non-zero exit on any error.

| Command | What it does |
|---|---|
| `bin/relay board` | The board: stages with their cards |
| `bin/relay card RLY-12` | One card: description, plan, branch, timeline |
| `bin/relay why RLY-12` | **Why isn't this card moving?** One plain-language answer |
| `bin/relay runs RLY-12` | The card's runs + node executions, with detail untruncated |
| `bin/relay executors` | Who is connected, their advertised capacity, and the jobs they hold |
| `bin/relay flow-stats code` | Per-node metrics for a flow (runs, duration, cost, attempts, verdict split, loop-laps); `--window 7d\|30d\|all`, `--json` |
| `bin/relay version` | The git SHA the deployed app was built from |
| `bin/relay create "Fix login" --stage Backlog` | Create a new card (title; optional `--stage`/`--description`/`--tag`) |
| `bin/relay comment RLY-12 "…"` | Post a comment (as Relay AI) |
| `bin/relay move RLY-12 Code` | Move to a stage (by name, e.g. `"Code:Review"`) |
| `bin/relay status RLY-12 working` | Set status (`ready`\|`working`\|`needs_input`\|`in_review`) |
| `bin/relay describe RLY-12 @spec.md` | Set the card's **description** (the spec) |
| `bin/relay criteria RLY-12 @criteria.md` | Set the card's **acceptance criteria** (numbered; authored at Spec, run at Code) |
| `bin/relay plan RLY-12 @plan.md` | Set the card's **plan** (travels with the card) |
| `bin/relay branch RLY-12 rly-12-…` | Record the **branch** this card's work lives on |
| `bin/relay pr RLY-12 <url>` | Record the card's **PR URL** (for the review gate) |
| `bin/relay sub-tasks RLY-12 @tasks.md` | Set the **sub-task checklist** (newline-per-item or a JSON array) — Plan writes it |
| `bin/relay check RLY-12 42` / `bin/relay uncheck RLY-12 42` | Toggle one sub-task done/undone by id — Code checks items off |
| `bin/relay result RLY-12 @result.json` | Set the card's **AI result** blob (summary / changes / screens / deploy_url) |
| `bin/relay needs-input RLY-12 "…"` | Ask the human a question — blocks the card |
| `bin/relay own RLY-12` / `bin/relay release RLY-12` | Claim for the AI / hand back |
| `bin/relay approve RLY-12` / `bin/relay reject RLY-12 "note"` | Gate: advance / send back |
| `bin/relay retry RLY-12 [--at NODE]` | Retry the card's failed run in place — re-enters the last node it executed, or `--at NODE` to pick one |

Text args accept `-` (stdin) or `@path` (file) for long content (specs, plans).

**When a card isn't moving, start with `bin/relay why RLY-12`.** It answers in one or two
sentences — no enabled flow for that stage, nothing connected to run it, blocked on a human,
run failed at node X, job stranded — and `bin/relay runs RLY-12` prints the full,
untruncated failure detail behind it. `bin/relay executors` shows what is connected, and
`bin/relay version` shows which commit is deployed.

Every `--json` command also takes `--field PATH` for a single value:
`bin/relay card RLY-12 --field status` prints `working` — no `jq`, no inline `python3 -c`.

**Done is derived, not a status.** The stored status vocabulary is just
`ready | working | needs_input | in_review` — there is no `done` status to set. A card
payload instead carries `done: true` once a `ready` card is parked at the board's terminal
(rightmost) stage, plus a `needs_you: true/false` fact (and the board payload carries a
`needs_you` rollup — `needs_input` / `in_review` / `awaiting_human` / `agent_stalled`). This
means "ready" is used two ways: **positionally**, a card is "ready to pull" when the column to
its right is an AI column; as a **status**, `ready` means the card isn't actively
`working`/blocked — it's just sitting wherever it is. Don't set a `done` status; move the card
to its terminal stage instead and Done follows.

## The executor

`bin/relay execute` claims jobs from the server and runs each in an executor-owned git
worktree. It is cheap when idle — a long-poll claim only returns when there is actual work, or
after `poll_timeout` seconds.

Agent steps run headless Claude (`claude -p --dangerously-skip-permissions --output-format
stream-json`, streamed as a live feed); shell/gate steps run shell. Which stages are
AI-enabled, what each step does, and where finished work goes are all configured on the board —
view or edit them in **Settings › Flows**.

- **Watch it live:** `bin/relay execute` prints a `🤖`/`🔧` play-by-play of each headless step.
- **One job:** `bin/relay execute --once`. **Dry run (no tokens, no mutations):** `--dry-run`.

### Auth: subscription vs API tokens

Headless `claude -p` uses whatever authentication the local Claude CLI has. If it is logged into
a **Claude subscription** (Max includes Claude Code), the runner bills against the subscription —
**no `ANTHROPIC_API_KEY` needed**. If that env var *is* set, Claude Code uses the metered API
instead. Subscription **rate limits** are the ceiling; when hit, `claude -p` is throttled (it does
not silently fall back to paid API). Working one card at a time keeps this manageable.

---

## Running work — the node contract

You only need this section if you **author your own flows or agents**. Using the shipped flows,
Relay handles all of it for you.

A flow is a graph of **nodes** (steps). The server hands the executor one node-job at a time;
the executor runs it in the card's worktree and reports a typed **outcome** that routes the
card to the next node. Everything a node needs arrives in the job (the card `ref`, the resolved
`vars`, and — for an agent node — which agent to run); nothing durable is passed through the
working tree.

### Declaring an outcome

An agent node **must declare its verdict** by running:

```
relay outcome <succeeded|failed> [--detail TEXT|@file]
```

`detail` becomes the context handed to the next node. The rule is strict on purpose:

- **Silence is failure.** An agent that exits without declaring an outcome is reported
  `failed`, whatever its exit code — an agent that did nothing is indistinguishable from one
  that exited early, so it must never route past its own gate.
- **A success claim must be backed by a commit.** For the commit-producing Code nodes
  (`implement`, `final_fix`, `smoke_fix`, `acceptance_fix`), a `succeeded` that leaves the
  branch unchanged is overridden to `failed`.
- **Asking a human always wins.** If the node moved the card to `needs_input`, that is the
  outcome even if the node also declared something else.

The outcome-declaration reminder is appended to every agent node's prompt automatically, so the
requirement travels with every invocation. Shell and gate nodes are exempt — their exit code is
already an unambiguous verdict.

### The `RELAY_NODE_SCRATCH` contract

Before running **every** node — agent and shell/gate alike — the executor sets
`RELAY_NODE_SCRATCH` to a temp file inside the node's own worktree, and creates the directory.
It is **one file per card per node**: the path derives only from `(ref, node)`, so it stays
stable across retries of the same node and across an executor restart, and it is git-ignored so
it never gets committed. Use it for `outcome failed --detail @$RELAY_NODE_SCRATCH`, and write
any second scratch file (e.g. a structured `--questions` payload for `needs-input`) as a
sibling in the same directory: `$(dirname "$RELAY_NODE_SCRATCH")/<name>.json`.

**Agents must not invent an absolute path of their own** for scratch output.
`$RELAY_NODE_SCRATCH` is namespaced per `(ref, node)` precisely so two runs can never read or
clobber each other's files.

### The `RELAY_PLAN` contract

The executor also exports `RELAY_PLAN` to a plan file inside the node's worktree. Unlike
`RELAY_NODE_SCRATCH` it is **per-card, not per-node**: the Code flow's first node writes the
card's plan there, and every later node (`implement`, the reviewers, smoke/acceptance) reads
the same file. It is git-ignored and namespaced by card, so two runs' plans are always
different files. A node with no plan sees `RELAY_PLAN` unset, never inherited.

### Needs-input re-entry

A `needs_input` outcome parks the run. When the human clears the card and the run resumes, the
server hands the **same node** back and the agent's prior session is resumed with its context
intact — it picks the conversation back up rather than starting the node over.

### Configuring the executor

`bin/relay execute` is configured by `.relay/executor.json`:

```json
{
  "namespace": "exec",
  "capacity": { "shared_clean": 3, "exclusive": 1 },
  "poll_timeout": 25,
  "heartbeat_interval": 15,
  "cache_dir": "~/.relay/cache",
  "prepare": ".relay/prepare-worktree.sh",
  "max_retained_failed": 3
}
```

`name` defaults to the hostname, `namespace` to `exec`; a missing file falls back to
`capacity: {shared_clean: 1, exclusive: 1}`. `capacity` is the field you'll routinely edit — it
caps how many `shared_clean` jobs and how many `exclusive` run-slots this executor advertises at
once. Worktrees live under the `exec-*` namespace: `shared_clean` jobs share one reused
`exec-clean` worktree; each `exclusive` card gets its own `exec-<ref>` worktree, created on
demand and torn down when its run terminates. The remaining keys are optional: `cache_dir` is a
warm dep/build cache passed to the prepare hook, `prepare` is that hook's path, and
`max_retained_failed` caps how many failed-run worktrees are kept on disk for post-mortem.

> **Running more than one `exclusive` slot?** Concurrent runs each work in their own worktree,
> so make sure they don't share mutable state — most importantly, **give each run its own test
> database** (or equivalent) so parallel test suites don't truncate each other. How you do that
> depends on your project's toolchain.

- **Running it:** `bin/relay execute` runs the claim/execute/report loop until Ctrl-C (which
  stops claiming and waits for in-flight jobs to finish). `--once` drains a single
  claim→execute→report cycle and exits. `--dry-run` claims and mutates nothing — it only logs
  the capacity it would advertise. `--interval N` overrides the configured `poll_timeout`.
- **Cancel/revoke.** If a run is cancelled server-side while this executor is running one of its
  jobs, the executor terminates that job's live subprocess on its next heartbeat. An
  `exclusive` job's worktree is reset; a `shared_clean` job's is left as-is (it is shared by
  other jobs that may still be running there). Either way, no outcome is reported for a revoked
  job.

## Operating invariants

These are the rules the runner relies on. Break one and cards corrupt each other's work. If you
build your own runner or agents, honor these:

1. **One agent works in a repo directory at a time.** A `git checkout` (or branch/file edit) is
   *global to the working directory* — two agents on two branches in one directory overwrite each
   other. Serialize (one card at a time), or give each agent its own **clone or `git worktree`**.
   Do **not** run the runner and an interactive session in the same working tree at once.

2. **Many cards are in flight, moving back and forth between stages.** A card may be specced, then
   sit for review, then planned much later, while other cards pass through. So **state must live on
   the board/card, never in the working tree.** Nothing durable may depend on "what's currently
   checked out" or a shared repo-root scratch file.

3. **Each card owns its own branch — commit at the end of every step, checkout at the start.**
   Because the working tree is shared and cards interleave, every step must:
   - **begin** by `git checkout`-ing the card's branch (restore its context — the card carries its
     `branch` field for exactly this), and
   - **end** by committing its work (never leave uncommitted changes for the next card to inherit).
   A step must be self-contained: it cannot assume the tree is where it left it.

4. **Work travels *with the card*, not in shared repo files.** The **spec** is the card's
   `description`; the **acceptance criteria** are the card's `acceptance_criteria` field; the
   **plan** is the card's `plan` field. A step materializes these into the repo just-in-time
   (inside the card's branch, at the per-card `$RELAY_PLAN` path) and never relies on a shared
   worktree-root file that another card would clobber.

5. **Readiness is positional and prioritized.** A card is *ready* when the column immediately to its
   right is an AI column (`Next up → Spec`, `Spec:Done → Plan`, `Plan:Done → Code`). Work
   **right-to-left** (finish what's furthest along first). Two guards: **respect WIP
   limits** (don't pull into a full AI column) and **skip blocked cards** (anything in
   `needs_input`).

6. **Finish a stage by pushing to the next column — Review if it exists, else Done.** A `*:Review`
   sub-lane is a human checkpoint (the runner stops; a human approves it into `*:Done`); a `*:Done`
   sub-lane auto-continues (the runner picks it up for the next AI stage). The board's sub-lane
   layout *is* the human-checkpoint configuration.

7. **On failure, flag the card — never retry-loop.** If a step fails, set the card to `needs_input`
   with the reason. Because blocked cards are skipped (invariant 5), a flagged card is not retried
   until a human clears it. Idempotent, no infinite loops.

8. **Ask, don't guess.** If a reasoning stage needs clarification, it calls `bin/relay needs-input`
   and stops; the human answers in the drawer; the card unblocks and resumes on a later tick.
   Verification is baked into the Code flow itself: the precommit gate → whole-branch review →
   smoke → acceptance (the "eyes" that watch it actually run) all have to pass before the card
   merges — so nothing merges unverified.

## Customizing a board's flows

A board's flows — which stages are AI-enabled, what each node does, model/effort per node,
retry/loop budgets — are configured on the board, not in a repo config file. View or edit them
in **Settings › Flows**, which is also where you can read the literal node/edge contents of the
shipped Spec, Plan, and Code flows.

Two rules keep custom nodes safe (see the invariants above): to honor invariant 3, an
agent/shell node's command should start by checking out the card's branch (from `vars.branch`)
and end by committing; to honor invariant 4, the Plan flow writes the plan to the card's `plan`
field, and the Code flow's first node (`branch`, in the shipped `code.jsonc` definition)
materializes it into the per-card `$RELAY_PLAN` path for `implement` to work through.
