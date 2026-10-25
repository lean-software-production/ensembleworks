# EW-CLI-DRAW-0001 — Cross-critique (author: CLAUDE)

Read-only review of the other two drafts (`-CODEX.md`, `-GEMINI.md`) against the authoritative
`docs/acceptance/cli-frames-draw.md` (AC1–AC23) and `docs/design/cli-frames-draw-api.md` (5.1.0 record
props, error matrix, §7 test seams). I did **not** re-derive the design; every claim below is checked
against those two files or against the draft text itself. Comparisons are relative to my own draft
(`-CLAUDE.md`).

## Verdict at a glance

| # | Criterion | CODEX | GEMINI |
|---|---|---|---|
| 1 | TDD order real (RED before impl **each phase**; Float16 helper-unit test) | **Strong** — RED/GREEN split at every step | **Weak** — server RED all deferred to Phase G; Phase A collapses RED+GREEN |
| 2 | All 23 ACs, task→AC map, nothing orphaned/extra | **Strong** — per-task map, all 23 | **Partial** — phase-level map; **AC18 orphaned** |
| 3 | Excluded-scope discipline (`op`=3, `type`=8) | Strong | OK |
| 4 | Record-prop fidelity to 5.1.0 | **Strongest of the three** | Strong |
| 5 | Contract fields `.optional()` + read outputs | Strong | Strong |
| 6 | Reuse grounded (file:line) | **Strong** — line-pinned | Partial — mostly file-level |
| 7 | Sequencing | **Weak** — harness scaffold misplaced at G1 while C1 uses it | OK — linear & self-consistent (but bought with the TDD inversion) |
| 8 | Over/under-engineering | Minor over — a contracts test seam not in §7 | Under — thin error matrix; missing AC18 task |

Bottom line: **CODEX is the more rigorous plan** (TDD granularity, record fidelity, line-pinned reuse)
with **one real sequencing bug**. **GEMINI is the more readable plan** with a **structural TDD
inversion** and a **coverage hole (AC18)**.

---

## Draft CODEX (`-CODEX.md`)

### Stronger than mine
- **RED/GREEN is split into separate checkboxes at every layer** (A1 RED → A2 GREEN, C1 RED → C2 GREEN,
  … through F). Mine batches some RED tasks (e.g. my C2 asserts several create facts in one task).
  CODEX's per-step split makes the *test-first commit pattern* (which `sprint-self-review` checks) easier
  to honor — one RED commit per GREEN commit.
- **Line-pinned reuse map.** CODEX cites `geometry.ts:27-49` (pagePoint/pageIdOf), `frames-helper.ts:10-17`
  (findFrameByName), `constants.ts:6-8` (NOTE_COLORS/GEO_TYPES), and the existing imports at
  `shape.ts:7` / `:8`. Mine leaves several of these at file-level. For an executor, CODEX's map is more
  actionable.
- **Design-note line citations inside each task** (e.g. A1 → `:492-496` / `:459-466`; A3 → `:18-34`,
  `:497-504`, `:559-570`). This gives per-task traceability back to the spec that neither my draft nor
  GEMINI matches.
- **Record-prop fidelity is the most explicit of the three.** C6 spells the draw set
  (`…isClosed/isPen/scale/scaleX/scaleY`) *and* the highlight "smaller exact set … only", and C5 RED
  asserts highlight has **no** `fill/dash/isClosed` key — the unknown-key→400 trap, tested, not just
  narrated.

### Weaker than mine
- **Harness sequencing bug (the headline issue).** C1/C3/C5/D1/D3/E1/E3/F1/F3 all say *"In
  `server/src/shape-api.test.ts`, boot the real app in-process …"* — yet the task that **creates** that
  harness is **G1** ("RED: create `server/src/shape-api.test.ts` harness from `scribe-api.test.ts`.
  Copy the real app pattern …"), placed at the very end. As written, **C1 cannot start when placed** —
  the file/harness it writes into doesn't exist until G1. My draft explicitly hoists this to **C1
  (SCAFFOLD — do first, prereq for all C–F RED)** and flags it as the one justified reorder. CODEX
  needs the identical fix: move G1's scaffold to the front of Phase C.
- **A contracts-level `node:assert` test seam that the design doesn't name.** B1/B3 are RED "contract
  tests or schema assertions" run as *unit (node:assert)*. Design §7 names exactly **two** seams —
  `drawShapes.test.ts` (pure) and `shape-api.test.ts` (HTTP) — and routes AC20's enum verification
  through `GET /api/tools` in the HTTP suite. Directly unit-testing `canvasShape.zodInput` is defensible
  (a zod schema is trivially testable) but it introduces a third test artifact not grounded in §7 and
  risks the schema asserting itself. Minor, but it's the one place CODEX steps past the design's stated
  seams. (My draft folds AC20 into G2 against `GET /api/tools`, per §7.)
- **A couple of AC mappings are loose enablers.** B2 claims AC1,2,4,5,6,8,9,10,11,12,20 — the contract
  widening "enables" all of them, but that's the same enabler-inflation I kept out of my map by pointing
  create ACs at the create tasks. Not wrong, just less discriminating.

### Missing tasks / underweighted risks
- **Frame-`color`-required and highlight-extra-key are handled in impl (C2/C6) but absent from CODEX's
  risk list.** The risk table has base64 / Float16 / line-index / delete-orphan / `page:page` /
  rotated-parent / contract-required — but not "omit `color` → `put` throws" or "copy `fill` onto
  highlight → 400". Both are tested, so this is a documentation gap, not a coverage gap. My draft lists
  both as explicit risks with their mitigations.
- No explicit re-assertion that the **NODE_ENV jitter** on `getIndicesAbove` is *why* A5 must not assert
  literal `'a1'/'a2'` — CODEX gives the correct instruction ("not literal 'a1'/'a2'") without the
  reason. Fine for execution, weaker for a reviewer.

### Sequencing wrong
- Only the **G1 harness placement** (above). Everything else (A→B→C→D→E→F, riders after reparent,
  delete keyed on `type==='frame'`, read last) is correctly ordered. Fix G1 and CODEX's DAG is sound.

---

## Draft GEMINI (`-GEMINI.md`)

### Stronger than mine
- **Cleanest create decomposition.** Phase C is one branch per task — C1 enum, C2 frame, C3 line, C4
  draw, C5 highlight. That reads more clearly than my combined C3 "implement create enum + 4 branches",
  and it makes the highlight-vs-draw prop-set difference its own reviewable unit (C4 vs C5).
- **Leanest, most scannable plan.** Lower reading cost than either CODEX or mine; the one-line
  "Feature", the layered-sequencing rationale, and the tight risk list are easy to consume.
- **Sequencing is internally self-consistent** (see below) — no task references an artifact that doesn't
  exist yet, because it defers all HTTP tests to Phase G.

### Weaker than mine
- **Structural TDD inversion (the headline issue).** Phases **C, D, E, F carry no RED tests** — they are
  pure "Implementation:" tasks. *All* server-side failing assertions live in Phase G (G2–G8), written
  **after** create/update/delete/read are implemented. That is test-**after** at the integration layer
  and violates criterion 1's "each phase puts a FAILING test **before** the implementation it covers."
  Both my draft (RED task at the front of each server phase) and CODEX (RED→GREEN within each phase)
  keep the loop honest; GEMINI does not. `sprint-self-review`'s test-first-commit check would flag every
  server phase.
- **Phase A collapses RED and GREEN into one checkbox.** "Task A1: Implement `parsePoints`" with a
  *Test:* sub-bullet and an *Implementation:* sub-bullet is a single task — there's no separate RED that
  commits and is watched to fail before the GREEN. The Float16 load-bearing test **is present and
  correctly at helper-unit level** (A2: `[[0,0],[70000,0]]` throws while `[[0,0],[65000,0]]` /
  `[[0,0],[120,0]]` pass — verbatim, good), but "RED is real" is weaker when the same checkbox owns the
  implementation.
- **Reuse map is the coarsest.** Only `shape.ts:145-156` and the two test/harness lines carry line
  numbers; `pagePoint`, `findFrameByName`, `constants.ts` are file-level only. Accurate, but less useful
  than CODEX's line-pinned map (and no worse than mine on those specific rows).
- **Phase B is labeled "Integration HTTP (middle)" but has no test** — B1/B2 are implementation-only,
  verified later in G6. The label is misleading; the contract change is a schema edit whose only test is
  deferred.

### Missing tasks / underweighted risks
- **AC18 is orphaned.** The per-task map (phase-level) lists A→{4,5,6,7,19}, B→{20,15,16}, C→{1,2,3,4,5,
  6,7,19,21}, D→{8,9,10}, E→{11,12,13,14}, F→{15,16,17}. **AC18 (frame CRUD-completeness: rename via
  `--props '{"name":"Renamed"}'`; invalid `--props '{"name":123}'` → 400) appears in no phase row and
  has no dedicated task or assertion.** Frame rename may work via the existing raw-prop merge, but GEMINI
  never states it, tests it, or maps it. My draft covers it as **G4** ("CRUD-completeness rename"); CODEX
  covers it in C2/D4/G3.
- **AC22 has a task (G7) but is absent from the AC map** — a documentation gap rather than a coverage
  gap, but it means the map can't be trusted as the completeness ledger the way CODEX's and mine can.
- **Error matrix under-specified at the integration layer.** G6 lumps "Invalid `--points` and `--color`
  400s" without enumerating AC19's concrete rows — `[[0]]`, `[["a",0]]`, `[]`, duplicate-consecutive,
  `NaN/Infinity`, `1e12`, and crucially the **65504 consecutive-delta** case. The design flags Float16
  overflow as *"the one defect that failed the adversarial gate"*; GEMINI asserts it only at unit level
  (A2) and does **not** re-assert `[[0,0],[70000,0]]`→400 through HTTP. My G1 and CODEX's G4 both pin the
  full matrix at the integration layer. Underweighted for the highest-risk row in the spec.
- **Thin done-ness.** GEMINI's done-list omits the "browser-render half is agent-driven (repo
  convention, no executable harness)" nuance and the "typecheck+build across **all three** workspaces"
  gate that both my draft and the task's own context call for. It says "bun run typecheck / build …
  across all workspaces" generically but never separates the executable half from the agent-walkthrough
  half.

### Sequencing wrong
- The **DAG is executable** (A→B→C→D→E→F→G, harness at G1 with nothing before it touching
  `shape-api.test.ts`) — so, unlike CODEX, GEMINI has **no "can't-start" task**. But that consistency is
  *purchased* by the TDD inversion: the only reason G1's harness-at-the-end works is that C–F write no
  tests. So the sequencing isn't "wrong" so much as it encodes the wrong ordering *policy* (implement
  first, test last). The fix is the same as making it TDD: pull a RED slice from G2–G8 to the front of
  each of C/D/E/F, and hoist the G1 harness ahead of them (converging on my C1-scaffold structure).

---

## If I were merging

**Keep from CODEX:**
- Its **RED/GREEN-per-step granularity** (separate checkboxes) and its **line-pinned reuse map**
  (`geometry.ts:27-49`, `frames-helper.ts:10-17`, `constants.ts:6-8`, imports `shape.ts:7`/`:8`) — the
  most executor-ready scaffolding of the three.
- Its **explicit record-prop assertions** (C5/C6: highlight's smaller set tested for the *absence* of
  `fill/dash/isClosed`; draw's full `scaleX/scaleY/isClosed`).
- Its **per-task design-note citations** for traceability.
- **But fix CODEX's one bug:** hoist the `shape-api.test.ts` harness scaffold out of **G1** to the front
  of Phase C (my **C1 SCAFFOLD**), so the RED tasks in C–F have a file to write into.

**Keep from GEMINI:**
- Its **one-branch-per-task create decomposition** (frame / line / draw / highlight as C2–C5) — clearer
  than my combined create task, and it isolates the highlight prop-set difference.
- Its **lean, scannable structure** for the narrative sections.
- **But fix GEMINI's two structural problems:** (a) move a RED assertion slice to the front of each
  server phase (C–F) instead of deferring all of it to Phase G — otherwise C–F are test-after; and
  (b) **add the missing AC18 task** (frame rename via `--props`, invalid rename → 400) and re-assert the
  **Float16 65504 case at the HTTP layer**, not just at unit A2.

**Anchor on my draft's structure for the merge:** the **C1-first harness scaffold**, the **RED-at-the-
front-of-each-server-phase** interleave, the **per-task AC map with all 23 and no orphan**, and the
explicit **executable-half vs agent-walkthrough-half** done-ness. Then graft in CODEX's granularity +
line-pinned reuse and GEMINI's create-branch clarity. The result: CODEX's rigor, GEMINI's readability,
no harness-ordering bug, no orphaned AC18, Float16 pinned at both layers.
