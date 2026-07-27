---
description: Turn a card's approved spec into the plan stored on that card for the Code flow to run.
---

Run `/write-plan <ref>`. The card ref comes from `$ARGUMENTS`; the **card is the source of
truth** — read the approved spec from its `spec` field and write the plan back to its `plan`
field, never a shared repo file.

You author the plan **yourself, in the main conversation context** with the regular model —
do NOT delegate to a subagent. The plan's quality depends on the decisions reached in this
conversation (the spec is only a compression of them); a fresh planning subagent lacks that
context, so authoring in-context is how those decisions reach the plan.

## Steps
1. **Resolve the card and spec.** Take the card ref from `$ARGUMENTS`; if absent, ask the user
   which card to plan. Read the approved spec from the card's `spec` field:

       ./bin/relay card <ref> --json

   If the `spec` field is empty or missing, stop — there's no approved spec to plan from. Tell
   the user to produce one first with `/brainstorm <ref>`, then come back to `/write-plan <ref>`.
   Do NOT invent a spec. Otherwise, read it fully. If `./bin/relay card <ref>` shows a
   **CHANGES REQUESTED** block, treat resolving that feedback as this pass's primary goal.

   **Delta re-plan (rejected card):** if the card already has a **non-empty `plan`** AND an open
   `rejection` (the `rejection` field is non-null, i.e. a `CHANGES REQUESTED` block is shown),
   do NOT re-plan greenfield. The card has shipped work that a reviewer sent back. Instead:
   (a) read the rejection `note` — it is usually "X is wrong," meaning X already exists but is
   broken or half-built; (b) **check what is actually implemented against the code** (read the
   repo / `git log` / `git diff main...` for this card's branch) to see what shipped; (c) write a
   plan covering **only the delta** — the fix the note asks for plus any genuine gaps — never
   re-planning or rebuilding work that already shipped and passed. Because the plan then contains
   only the new work, the branch diff matches the plan and the Code flow's `final_review` node
   needs no special-casing.
2. **Author the plan** in-context, following the guidance below.
3. **Self-review** (checklist at the end), fixing inline.
4. **Write the plan to the card.** Save it to a temp file and attach it so it travels with the
   card — do NOT leave a durable repo-root `plan.md` (the Code flow materializes it per-run at
   `$RELAY_PLAN`):

       ./bin/relay plan <ref> @<tmpfile>

   Then summarize the task breakdown to the user. There is no runner command to launch by hand
   anymore (RLY-139): once the card is approved into `Plan:Done`, the Code flow
   (`docs/designs/flows/code.jsonc`, if enabled for this board in Settings › Flows) picks it up
   automatically — dispatch is server-side. Do NOT move or approve the card yourself — that's a
   separate, human-gated step.

---

## Plan authoring guidance

You are writing an implementation plan to be executed autonomously by the Code flow (the
server-side flow engine, ADR 0006 — `docs/designs/flows/code.jsonc`). Assume the executing
engineer has zero repo context and needs every detail.

### Input
The approved spec, read from the card's `spec` field (`./bin/relay card <ref> --json`). Read
it fully. **Design fidelity is the spec's call, not yours** — artboards drift from the shipped
app, so match a mockup only where the spec **explicitly** says a UI should match a named
`docs/designs/*.dc.html` artboard (`/brainstorm` settles this with the human and records the
decision in the spec). When the spec does name one, open that artboard and read the relevant
section so its concrete values (classes, tokens, measurements, states) reach the plan. Where
the spec does not tie a UI to an artboard, do **not** go hunting one — plan to the spec and the
existing design system.

### Task right-sizing
Prefer **~3 coarse, vertical-slice tasks** for a typical MMF (measured cheaper: fewer tasks =
fewer per-task review passes, no retry spike). A task is a coherent slice that ends in an
independently testable deliverable and is worth a fresh reviewer's gate — the Code flow's
`spec_review` and `quality_review` nodes review each task independently. **Merge** tightly-coupled steps: schema +
migration + context + factory for one area belong in ONE task, not split; fold
setup/config/scaffolding/docs into the task whose deliverable needs them. **Split** only when
a task crosses an independent module boundary, would be a very large diff, or is a risky
refactor that benefits from isolation (e.g. keep a pure schema migration its own task).

### Output: the plan you author (this is the executor's contract) — written to the card's `plan` field
- A short header: **Goal**, **Architecture**, **Tech**, a **Global Constraints**
  section (project-wide rules copied verbatim from the spec), and a **`## Verification`**
  section (below).
- **`## Verification`** — declares the gate the executor runs, because not every card is a
  Phoenix card. Two lines:
  - **`Gate:`** the command(s) that must pass. **Default `mix precommit`** (the Elixir/LiveView
    app). A card that only touches **`flutter/`** declares `dart format --set-exit-if-changed .`
    + `flutter analyze` + `flutter test` (run in `flutter/`) instead — matching CI's Flutter Deploy
    `validate` job; `mix precommit` does not exercise Dart. A card touching both declares both.
    (A committed `.githooks/pre-commit` auto-formats staged Dart, so `dart format` is a belt-and-
    suspenders check, not a formatting step.)
  - **`Smoke:`** how the acceptance smoke drives it. Default: the running web app on
    `:4003` via Playwright. A **Flutter** card declares the iOS-simulator smoke (boot the app,
    screenshot each state, compare to `docs/designs/Relay Mobile.dc.html`). Say "none" only for
    a card with no runtime surface.
  The `plan-implementer`, the whole-suite gate, the `smoke-tester`, and the `acceptance-tester`
  all read these lines, so they must be exact.
- **Cover the card's acceptance criteria.** Read the card's `acceptance_criteria` field
  (`./bin/relay card <ref> --json`) and make sure the plan's tasks actually deliver every
  criterion — a criterion no task covers is a gap: add a task for it. Do **NOT** copy the
  criteria into the plan: the `acceptance-tester` reads them off the card at the Code stage, so
  a copy here would only drift.
- Then a series of **bite-sized tasks**. Each task opens with a heading in this EXACT,
  machine-parsed format: **`## Task N: <name>`** — two-to-four `#`, the literal word `Task`,
  the number, then a **colon**. The separator after the number MUST be a colon `:` — never an
  em-dash `—`, en-dash `–`, hyphen `-`, or period. The Code flow's `foreach` node parses tasks
  with `Relay.Runs.PlanTasks` (regex `^#{2,4} Task <N>: <title>`); **any other punctuation
  matches ZERO tasks**, so the run parks the card in `needs_input` with "plan produced no
  tasks" and nothing gets built. Write `## Task 1: Foo`, **not** `## Task 1 — Foo`. Under that
  heading, each task carries:
  - **Files** (exact create/modify/test paths) and
    **Interfaces** — split as **Consumes** (exact signatures this task uses from earlier
    tasks) and **Produces** (exact function names, params, and return types later tasks rely
    on). Each task's implementer sees only its own task, so this block is how it learns the
    names and types its neighbors use.
  - Steps as checkboxes `- [ ]`, each ONE action: write failing test → run it (expect
    fail) → minimal implementation → run it (expect pass) → commit. Include the ACTUAL
    test code and implementation code in fenced blocks — no placeholders, no "similar to".
    The executor sees only this plan, so the code in it is the executor's source of truth
    and the reviewer's diff target; write it in full.
  - **Design fidelity (only where the spec calls for it):** if the spec says this task's UI
    must match a `docs/designs/*.dc.html` artboard, name that artboard file in the
    task and list the **specific elements/states that must match it**, each with the mockup's
    concrete value (exact daisyUI classes, design tokens, px measurements, and the states the
    mockup shows). Fold those into the task's **test code as concrete assertions** (assert the
    exact class / token / px the mockup uses — see `core_components_test.exs`, which pins
    "44px dashed strip … Relay Board.dc.html lines ~75–81"), so "matches the mockup" is a
    checked deliverable, not a hope. The implementer and reviewers act only on what you name
    here — anything you leave out, they won't match. Non-visual tasks, and UI with no
    governing artboard, skip this.
  - End each task with an independently testable deliverable + the commit message to use.
- **Task checkbox convention:** every task's steps use `- [ ]`. The executor flips them to
  `- [x]` as it completes each task, so keep them clean GitHub task-list checkboxes.

### No placeholders
No "TBD", no "add error handling", no "write tests for the above" without the code. Every
step an engineer needs is on the page.

### Self-review then return
After writing the plan, re-read it for: placeholder scan; internal consistency; scope
(single coherent unit of work); ambiguity; **spec coverage** (point each spec
requirement to a task — add a task for any gap); **design coverage** (every UI the spec ties
to a `docs/designs/*.dc.html` artboard names that artboard and carries the mockup's concrete
values in the task and its tests); and **type/signature consistency** across
tasks (a function defined as `clear_layers/1` in Task 3 but called as `clear_full_layers/1`
in Task 7 is a bug — the Consumes/Produces names must match exactly). Fix inline. Then write
the plan to the card (`./bin/relay plan <ref> @<tmpfile>`), summarize the task breakdown, and
tell the user the Code flow picks the card up automatically once it's approved into
`Plan:Done` (Settings › Flows) — there is no runner command to launch by hand. Do NOT move or
approve the card yourself — that's a separate, human-gated step.

## Headless / runner use (no human to dialogue with)

When the board's flow engine runs this command as the `write_plan` node there is no human in
the loop. The node's `run` is a bare `/write-plan {ref}`, so every operational rule lives here.

- **The work is pre-authorized.** Proceed without asking for confirmation. Read the card, write
  the plan, stop.
- **Blast radius: do not touch git, do not touch other cards.** No branches, no commits, no
  pushes, no stage moves. The only write you make is the plan on the card you were given
  (`./bin/relay plan <ref> @<tmpfile>`).
- **Terminal STOP.** When the plan is on the card, you are done — stop. Explicitly do **NOT**
  start implementing, and do not move or approve the card into `Plan:Done` yourself — the Code
  flow's dispatch is automatic and server-side (RLY-139) once a human does that. The
  interactive steps above say approval is "a separate, human-gated step"; headless this is a
  hard stop, because there is no human standing at that gate to be asked.
- **No approved spec → raise `needs-input`, never a silent stop.** Step 1 tells the interactive
  path to stop and tell the user. Headless there is no user to tell, and a silent stop reads to
  the engine as `succeeded` — the card would land on `Plan:Done` carrying no plan, and the Code
  flow would then fail two stages downstream on `test -s "$RELAY_PLAN"` with a confusing error. So if
  the card's `spec` field is empty or missing, park the card where the problem actually is,
  writing the questions to a scratch file under `$RELAY_NODE_SCRATCH`'s directory (never an
  invented `/tmp` path — see
  [`relay.md`](../../relay.md#the-relay_node_scratch-contract)):

      questions_file="$(dirname "$RELAY_NODE_SCRATCH")/questions.json"
      cat > "$questions_file" <<'JSON'
      [
        {
          "prompt": "**No approved spec.** This card has no `spec`, so there is nothing to plan from. How should I proceed?",
          "options": [
            "Run `/brainstorm <ref>` to produce a spec first, then re-run `/write-plan <ref>`. — RECOMMENDED",
            "Paste the spec here and I'll plan directly from it."
          ],
          "allow_text": true
        }
      ]
      JSON
      ./bin/relay needs-input <ref> --questions @"$questions_file"

  Then stop. **Always the structured `--questions @<tmpfile>` JSON-array form** of
  `{prompt, options, allow_text}` objects — never a hand-numbered prose string. The drawer
  renders its one-question-at-a-time stepper only for the structured form; a string degrades to
  a wall of text (RLY-109).

  The engine **parks** a run on the `needs_input` outcome without needing an edge for it, so the
  `plan` flow's single `write_plan → done on: :succeeded` edge is correct as-is and needs no
  change.
- **CHANGES REQUESTED / delta re-plan is already headless-safe** — it reads the rejection off
  the card, not from a human. Follow it exactly as written above: plan **only the delta**. Do
  not re-plan greenfield just because no human is present to confirm.
- **Do not raise `needs-input` for anything else.** Unlike `/brainstorm`, planning is not a
  dialogue: the spec is the approved input and the plan is a mechanical elaboration of it. An
  empty spec is the one genuine blocker.
