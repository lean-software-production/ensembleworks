---
name: gauntlet
description: Build or polish a feature with a Gauntlet Loop — builders improve one piece at a time and a fresh blind critic judges each candidate against a real bar — run as an Attractor workflow. Use when asked to run a gauntlet loop, or to build something "until it beats" a reference.
---

# Gauntlet Loop

A Gauntlet Loop ([Matt Shumer's method](https://somethingbig.ai/gauntlet-loop))
gives an agent a goal and a concrete bar, splits the work into pieces, and
puts every piece through builder-versus-critic rounds. The builder never
grades its own work: a fresh critic that has seen none of the builder's
reasoning compares the new candidate with the version currently being kept,
unlabelled and in random order, and picks the better one against the bar.
A winner becomes the kept version; a loser is thrown away and the critic's
largest gap goes back to the builder.

This skill runs that loop as an Attractor workflow (see the `attractor`
skill for how runs, gates and the live card work). Two files sit beside this
one:

- `gauntlet-loop.dot` — the workflow graph.
- `gauntlet-loop.mjs` — the bookkeeping the graph's command nodes run, so
  that committing, the A/B order, keeping or resetting, and stopping are
  never left to an agent.

## When it fits

The loop sharpens; it does not find direction. Use it when there is
something real to compare against. If the user has no bar, finding one is
the first job — do not start a run on "make it great".

A usable bar is something a critic can open or measure: reference files in
this repo, a competitor's behaviour, a spec with numbers, a test suite, a
set of example outputs. It does not have to be reachable.

## Running one

1. **Interview the user to establish the goal and the bar.** Do this
   first, before touching the repository, and do not write the bar for
   them from your own assumptions. Ask one or two questions at a time and
   keep going until each of these has a concrete answer:
   - **Goal** — what should exist at the end, for whom, and what is out of
     scope. Outcomes only; steer them away from prescribing architecture.
   - **Reference** — what the result should be as good as or better than:
     a product, a file or module in this repo, a spec, example outputs.
     If they say "just make it good", propose two or three candidate
     references and let them choose.
   - **How a critic can tell** — for each quality they care about, what a
     critic with no context could open, run or measure to compare two
     versions. Anything nobody can inspect does not belong in the bar.
   - **What must always pass** — the tests or checks a candidate has to
     clear before it is judged at all.
   - **Budget** — roughly how many rounds per piece they will pay for
     (default 5), and whether builders and critics should use different
     models.

   Then play the goal and the bar back to them in a few lines and get an
   explicit yes before continuing.
2. **Start clean, on a feature branch.** A losing round is discarded with
   `git reset --hard`, and winning rounds are committed with `--no-verify`
   (the plan's `check` command is the gate). The run refuses to start with
   uncommitted changes.
3. **Install the working files** from the repository root:

   ```
   node <this skill's directory>/gauntlet-loop.mjs setup
   ```

   (`bun` works too.) This creates `.gauntlet/` holding the graph, the
   helper and a `.gauntlet/g` wrapper, and git-excludes the directory.
4. **Write down what the interview agreed:**
   - `.gauntlet/goal.md` — what to build. State the outcome, not the
     architecture; choosing the approach is the lead stage's job.
   - `.gauntlet/bar.md` — the bar, with the paths, URLs or measurements a
     critic can inspect, and the checks that must always pass.
5. **Pick models if the user asked for a split.** Critique works well on a different model
   from the builder. Add a `model_stylesheet` to the graph attributes in
   `.gauntlet/gauntlet-loop.dot` using the `.builder` and `.critic`
   classes; the comment at the top of the file shows the shape. Use only
   models the user has (`bb provider models`).
6. **Run it**: `attractor_run({ path: ".gauntlet/gauntlet-loop.dot", title: "<goal>" })`
   and emit the returned `previewDirective` once.
7. **The plan gate.** The first stage splits the goal into pieces and
   writes `.gauntlet/plan.md`; the run then blocks on "Approve the pieces?".
   That decision is the user's — do not answer it for them. "Revise" sends
   it back to the lead stage; the user can also edit
   `.gauntlet/pieces.json` by hand before approving.
8. **Let it run.** Do not interrupt rounds. `.gauntlet/progress.md` (or
   `.gauntlet/g status`) shows every piece's status, rounds and the last
   verdict; the Attractor card shows the stage in flight.
9. **When it ends**, read `.gauntlet/final-review.md` (a fresh reviewer's
   judgement of the whole result against the bar) and
   `.gauntlet/progress.md`, and report both to the user: which pieces
   passed, which plateaued or ran out of budget, and the gaps that remain.
   Opening a pull request, merging, or starting another run is the user's
   call.

## What the run does

```
plan → approve (human) → init
  → [ brief → build → snapshot → critic → ratchet → count ]  per round
  → smooth → finish → review
```

- `init` checks the plan and requires the plan's `check` command to pass
  on the starting commit.
- `brief` picks the current piece and writes `.gauntlet/brief.md`: the
  goal, the bar, the piece, and what blind critics said in earlier rounds.
- `build` is a fresh builder thread each round, working on top of the
  kept version.
- `snapshot` commits the changes as a candidate. No changes, or a failing
  `check`, ends the round as a loss before any critic is spent. Otherwise
  it captures the piece's `evidence` command output and exports both
  versions to `.gauntlet/arena/A` and `B`.
- `critic` is a new thread every round with `fidelity="truncate"`, so
  nothing an earlier stage said is in its prompt. It records a verdict
  with `.gauntlet/g verdict`: the winner, whether the evidence was usable,
  whether the winner meets the bar, and the single largest remaining gap.
- `ratchet` de-blinds the verdict. A winning candidate becomes the kept
  version; a losing one is reset away (it stays reachable at
  `refs/gauntlet/<piece>/r<round>`). Unusable evidence voids the round.
- A piece ends as `passed` (a critic judged the kept version to meet the
  bar), `plateaued` (`plateau` candidates in a row lost), `capped`
  (`max_rounds` judged rounds spent) or `blocked` (evidence unusable
  twice).
- `smooth` makes one consistency pass over the whole result; `finish`
  keeps it only if `check` still passes; `review` writes the final
  judgement.

Round budgets live in `.gauntlet/pieces.json` under `limits`
(`max_rounds`, default 5; `plateau`, default 2). The graph also caps any
single stage at 80 visits (`max_node_visits`); raise it for a run with
many pieces and a large round budget.

## Limits of this version

- **One piece at a time, in the checkout the run started from.** There is
  no parallel fan-out yet, and nothing else should use that checkout while
  a run is in flight.
- **The critic is blind by construction of its inputs, not by isolation.**
  It works in the same checkout as the builder; the arena, its brief and
  its prompt carry nothing that identifies the candidate, and the A/B
  mapping is kept under `.git/`, but a critic that ignored its
  instructions could read git history. Treat verdicts accordingly.
- **Builders do not remember earlier rounds.** Each round's builder is a
  new thread; what carries over is the kept code and the critics' gaps in
  the brief.
- **A weak `evidence` command gives weak verdicts.** If critics keep
  reporting unusable evidence the piece ends `blocked`; fix the command in
  `pieces.json` rather than rerunning.
