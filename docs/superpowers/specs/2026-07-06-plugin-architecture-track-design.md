# Plugin-architecture completion track — orchestration design

**Scope: everything through Phase 6** of the unified-architecture roadmap
(`docs/unified-architecture-design.md` §7): the remainder of Phase 3 (3a
routes, 3b tool manifest, 3c-attribution, #4 CLI, #5 connector, #6
transcriber, #7 distribution), the #8 cutover release (manual), then Phase 4
(docStore + routes-as-tools + `/mcp`), Phase 5 (memory service), Phase 6
(plugin packages + config profiles).

This document specifies **how the track is orchestrated**, not what any slice
builds — each slice still gets its own spec + plan under
`docs/superpowers/{specs,plans}/`.

## Decided (2026-07-06)

- **Scope:** through Phase 6.
- **Gating model:** risk-tiered gates.
- **Orchestration:** hybrid — session-driven spine with workflow-powered
  stages.

## Governing artifacts (written before any slice runs)

- **The Charter** —
  `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`.
  Every open product decision across the track, settled once with the user:
  attribution mechanism, the 3a route table (pinned explicitly), `ew` vs
  `ensembleworks` spelling, CLI command surface (§6.1 confirmed/amended), MCP
  write-tool scoping, memory embedding provider/chunking, plugin-package
  config shape, plus standing conventions (tabs in server/src, self-running
  `bun src/x.test.ts` tests, commit trailer, `--no-ff` merges to
  `unified-architecture-migration`, Bun 1.3.14 via mise PATH prepend).
  Produced by a workflow sweep (parallel agents mine the design doc, existing
  specs, open questions, and code for unsettled decisions) → synthesized
  decision list with recommendations → **the user settles it in one
  sitting**. The charter is the constitution every subagent is briefed
  against; "out of charter" is the escalation trigger.
- **The Track State doc** —
  `docs/superpowers/plans/2026-07-06-plugin-architecture-track.md`. The slice
  queue with per-slice status, gate tier, merge SHA, and deviations. Updated
  after every slice merge; with auto-memory it is what makes the track
  survive compaction and session restarts.

## The gate map (risk-tiered)

| Tier | Slices | User involvement |
|---|---|---|
| **Gated** — spec needs user approval before build | #4 CLI surface, Phase 4 (docStore + MCP), Phase 5 (memory), Phase 6 (config profiles) | Read the spec, approve/amend |
| **Autonomous** — spec approved by adversarial panel vs charter | 3a routes, 3b manifest, 3c-attribution*, #5 connector, #6 transcriber, #7 distribution | None unless escalated |
| **Manual** | #8 cutover deploy | Entirely the user's; the track preps the release checklist |

\* attribution is autonomous only because its mechanism is decided in the
charter; if the charter sitting leaves it murky, it promotes to gated.

Phase boundaries additionally get a **multi-lens review workflow**
(correctness / security / charter-drift / data-keel integrity per §7.1)
whose packet goes to the user regardless of tier.

## Per-slice pipeline (the hybrid)

Session-driven spine: the orchestrating session holds worktrees, merges,
gates, and track state. Per slice:

1. **Spec** — spec-writer agent (opus, briefed with the charter + slice
   context) → **workflow: adversarial spec panel** — 3 opus lenses
   (charter-conformance, security/fail-closed, YAGNI/scope-creep); majority
   must pass; findings loop back to the writer; max 2 rounds, then escalate.
   Gated slices then go to the user; autonomous slices proceed.
2. **Plan** — plan-writer agent (opus) producing the established TDD
   bite-sized format (superpowers:writing-plans), with self-review.
3. **Build** — the proven subagent-driven loop: sonnet implementers, opus
   spec-compliance + code-quality reviews per task, fix loops, in a
   `.worktrees/<slice>` off `unified-architecture-migration`.
4. **Merge** — full suite on the merged result, `--no-ff`, worktree cleanup,
   track-state + memory update.

Parallelism only where provably disjoint (e.g. #6 transcriber beside 3a
routes — separate workspaces); merges always serial.

## Escalation, failure & continuity

- **Escalate to the user (interrupt, don't guess):** out-of-charter
  decision; spec-panel deadlock after 2 rounds; implementer BLOCKED after a
  model-upgrade retry; any data-format keel risk (§7.1); any suite
  regression that survives one fix loop.
- **Order:** 3a → 3b → attribution → #4 → #5 (∥ #6 anytime) → #7 →
  **[#8 gate: user]** → Phase 4 → Phase 5 → Phase 6. Phases 4–6 build on the
  migration branch regardless of when #8 actually deploys.
- **Models:** sonnet implementers; opus wherever judgment lives (spec
  writing, panels, reviews, plans).
- **Continuity:** track-state doc + auto-memory updated at every slice
  merge; any future session resumes from those. Default pacing: work while
  the session is live, report at gates.
