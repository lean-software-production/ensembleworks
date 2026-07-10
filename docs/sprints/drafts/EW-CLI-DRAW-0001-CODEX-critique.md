# EW-CLI-DRAW-0001 — Codex critique of GEMINI and CLAUDE drafts

Scope of this critique: I am not re-deriving the design. I am checking the two other sprint drafts
against the acceptance file and the tldraw 5.1.0 design note, with emphasis on real TDD ordering,
AC coverage, excluded-scope discipline, record fidelity, contract compatibility, reuse, and sequencing.

## GEMINI draft

### Stronger than my draft

- The high-level phase ladder is compact and easy to scan. `Phase A -> B -> C -> D -> E -> F -> G`
  clearly communicates the intended implementation dependency order.
- `Task A2` pins the load-bearing Float16 delta test exactly where it belongs: helper-level
  `buildSegments(localPoints)`, with `[[0,0],[70000,0]]` throwing while `65000` and `120` pass. This
  matches the design note's critical warning and correctly keeps the guard out of `line`.
- The reuse map is concise and mostly accurate: base record at `server/src/features/shape.ts:145-156`,
  `pagePoint`, `findFrameByName`, `getIndexAbove/getIndicesAbove/sortByIndex`,
  `compressLegacySegments`, and the `scribe-api.test.ts:17-82` harness are all the right reuse targets.
- It avoids obvious scope creep: it states no `cli/src`, no new dependencies, exact `op` enum, exact
  eight create types, and no eraser/laser/align/group/image upload.

### Weaker than my draft

- The TDD order is mostly asserted, not operationalized. `Phase C` through `Phase F` are implementation
  tasks (`C2 Implement frame branch`, `D1 Implement reparent`, `E1 Implement frame default delete`,
  `F1 Extend GET /api/canvas/frames`) with no task-specific RED test immediately before the
  implementation. The integration tests arrive later in `Phase G`, after the branches they cover would
  already be implemented. That makes RED less real than the draft claims.
- `Phase B` is labeled "Integration HTTP" but contains only implementation tasks (`B1`, `B2`). There is
  no failing contract/schema test before widening `canvasShape.zodInput` or extending read outputs.
- The AC map is too coarse. Rows like `Phase C (C1-C5) | AC1...AC21` and `Phase G | Verifies all` make
  it hard to see whether AC18 rename, AC22 documentation, and AC23 composition are actually served by a
  specific task rather than swept into a final bucket.
- `G7 Document rotated-parent limitation (AC22)` is misplaced as an HTTP integration task. AC22 is a
  documentation/help limitation note, not something that should be deferred until after update/delete
  implementation; the draft does not name the actual file/help string where the limitation will land.

### Missing tasks

- A dedicated RED contract test for `GET /api/tools`: exact `op` enum, exact eight create types, all
  new input fields optional, and excluded names absent. `G6` eventually asserts some of this, but it is
  not before `B1`.
- A RED test for read-output contract shape before `B2`: `canvasFrames.zodOutput.frames[].drawings` and
  `canvasFrame.zodOutput.drawings[]`.
- A concrete help/docs task for AC22. `G7` says "Verify limitation recorded in source comments/help
  string", but no earlier task actually records it.
- A specific AC18 rename task. The map lists AC18 nowhere except indirectly through "all of the above";
  `G6` covers attribution and scope, not invalid frame rename or `canvas frames` reflection.
- A harness scaffold before server RED tests. `G1` comes after C-F, so there is no obvious place for the
  C/D/E/F tests to fail before their matching implementation.
- A clear `--x/--y` reparent interaction test. `D1` says to guard it, but no RED assertion is named.

### Risks underweighted

- Highlight prop fidelity is mentioned in `C5`, but there is no explicit RED test that validates the
  smaller highlight prop set and absence of `fill`, `dash`, and `isClosed`.
- Frame `color` being required in tldraw 5.1.0 is implemented in `C2`, but the draft does not explicitly
  put a failing bare-frame/default-color test before it.
- `line.points` as a keyed dictionary with valid `IndexKey` is good in `A3`, but the later create test
  `G2` is broad; a developer could pass the helper test and still wire an array into the server branch
  without a phase-local RED test catching it before `C3`.
- Attribution (AC21) is under-specified: `G6` says to assert it, but there is no note about how the
  credentialed caller is simulated in the copied HTTP harness.

### Sequencing problems

- `Phase G` is too late for TDD. It verifies the implementation after `C-F` rather than driving each
  server change before it is written.
- `Phase B` claims HTTP integration level before there is any HTTP harness. It should either be a pure
  contract/schema RED/GREEN phase or depend on an earlier harness.
- `D`, `E`, and `F` depend on records created by `C`, which is fine, but their tests should be inserted
  before each matching implementation, not gathered at the end.

## CLAUDE draft

### Stronger than my draft

- This is the stronger TDD plan. The RED/GREEN pairing is explicit in `A1/A2`, `A3/A4`, `A5/A6`,
  `A7/A8`, then again in `C2/C3`, `D1/D2`, `E1/E2`, and `F1/F2`.
- The "justified reorder" is good: scaffold `shape-api.test.ts` once in `C1`, then grow it incrementally
  before each server phase. That fixes the main weakness in Gemini's plan.
- Record-prop fidelity is strong. `C3` calls out frame `color:'black'`, non-zero `w/h`, line keyed
  points via `buildLinePoints`, draw `scaleX/scaleY`, highlight's smaller prop set with no
  `fill/dash/isClosed`, and `buildSegments` via `compressLegacySegments`.
- The AC map is much more useful. Every AC from AC1 through AC23 has at least one named task, and the
  mapping does not hide everything behind a final "verify all" row.
- The risk table names the real schema traps: Float16 overflow, highlight unknown keys, required frame
  color, line point indexes, reparent jumps, dangling parents, scope creep, and rotated-parent limits.

### Weaker than my draft

- `Phase B` still lacks true RED tasks. `B1`, `B2`, and `B3` are direct implementation/doc tasks, with
  AC20 mostly deferred to `G2`. This is not as test-first as the rest of the plan.
- `Phase G` labels cross-cutting checks as `RED->assert`, but these run after the matching
  implementations are already present. That is acceptable for final regression coverage, but not for
  "FAILING test before implementation" on AC19/AC20/AC21/AC18 edge cases unless those assertions are
  pulled earlier or their implementation is delayed until G.
- `C1` says "Copy the `scribe-api.test.ts:17-82` harness verbatim." The reuse target is correct, but
  verbatim copying would drag scribe-specific setup/tests if interpreted literally. It should say copy
  the harness pattern: env setup, `createSyncApp({dataDir})`, `server.listen(0)`, `makeTestClient`,
  seeded records, and `documents()`.
- `D3` records AC22 in help/README "with B3" and a code comment. That is more concrete than Gemini, but
  it still does not include a RED check that the public tool help exposes the limitation.

### Missing tasks

- Contract RED tests before `B1/B2`: exact enum values, optional-only new fields, and read-output zod
  additions should fail before contracts are edited.
- An earlier RED test for `create draw --fill bogus -> 400` if the implementation is in `C3`; currently
  it appears in `G1`, after create implementation.
- An explicit test that `canvas shape create frame --name only` succeeds and no-name frame reads back
  `name:""`; `C2` covers bare frame defaults but does not name the `--name`-only AC2 case.
- A concrete test/check for the browser-visible half of AC1/AC3/AC8/AC23 is deferred to the walkthrough,
  which is acceptable per repo convention, but the task does not name the exact evidence file path until
  the note after the AC map.

### Risks underweighted

- `C2` says "getShapePageBounds-equivalent origin/extent" inside an HTTP test. Server tests do not have
  an editor `getShapePageBounds`; they must compute/validate the equivalent from decoded records and
  normalized page-space geometry. The wording could mislead an implementer into trying to pull in a UI
  editor seam.
- The credentialed attribution path in `G3` may need explicit harness setup. The draft says assert
  `meta.author===<resolved caller>`, but does not say how to set headers or auth context in the existing
  app test client.
- `E2` says default frame delete should "cascade bindings touching the frame itself." That is probably
  intended to remove bindings to the deleted frame, but the wording is loose enough to be mistaken for
  broader cascade behavior in the default keep-children case.

### Sequencing problems

- The main implementation sequence is sound: helpers and contracts before create; create before
  update/delete/read; read before final compose.
- The contract phase should be made RED/GREEN, or it should be explicitly covered by `C1`/early harness
  assertions before `B1/B2`.
- Cross-cutting edge cases in `G1-G4` should be split: assertions that drive already-written behavior
  should move before that behavior's GREEN task, while final compose/regression checks can remain in G.

## All-AC and scope comparison

- Gemini covers all 23 ACs only at a coarse level. I would not trust its map alone to prevent AC18,
  AC22, or AC23 from being missed.
- Claude covers all 23 ACs with named tasks and is the safer execution plan.
- Neither draft adds excluded types or flags. Both keep `op` to `create|update|delete` and type to the
  exact eight values.
- Both drafts correctly require all new contract input fields to be `.optional()` and include read-output
  additions for drawings.
- Both drafts correctly locate the Float16 consecutive-delta guard in `buildSegments` for draw/highlight
  only, leaving line immune.
- Both drafts correctly use existing helpers instead of inventing replacements: `pagePoint`,
  `findFrameByName`, `getIndexAbove/getIndicesAbove/sortByIndex`, and `compressLegacySegments`.

## If I were merging, keep X from draft A and Y from draft B

Treat GEMINI as draft A and CLAUDE as draft B.

- Keep from draft A: the compact phase summary, concise reuse table, and clear high-level risk framing.
- Keep from draft B: the interleaved RED/GREEN server sequencing, the detailed AC map, the explicit
  prop-fidelity notes in `C3`, and the risk table.
- Before merging either, add true RED contract tasks to Phase B and move the late `G1-G4` edge-case
  assertions that drive implementation into the phase that implements that behavior.
