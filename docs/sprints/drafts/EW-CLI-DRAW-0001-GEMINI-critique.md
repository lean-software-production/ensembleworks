# Sprint Plan Critique: EW-CLI-DRAW-0001

## CODEX Draft Critique
* **TDD Order is NOT executable:** Early tasks (Phases C-F) write RED tests to `server/src/shape-api.test.ts` before the test harness/file is scaffolded in Phase G (G1). This makes early tests un-runnable/uncheck-inable in actual TDD.
* **AC Mapping:** All 23 ACs (AC1–AC23) are correctly mapped and none are left orphaned or unhandled.
* **No Excluded Scope Creep:** Excluded tools (eraser, laser, align, group, image) are explicitly forbidden and absent from schemas.
* **Record-Prop Fidelity:** Highly compliant. Frame default color is required, highlight uses the restricted subset (no fill/dash/isClosed), line uses a keyed dict via `Record`, and the `buildSegments` Float16 delta guard is well-specified.

## CLAUDE Draft Critique
* **TDD Order is REAL & Executable:** Solves the interleaving issue by scaffolding the test-harness in C1 *before* Phase C-F write their RED assertions, ensuring a true executable TDD cycle.
* **AC Mapping:** Fully mapped and trace-verified. All 23 ACs are accounted for across helper, contract, server, and integration tasks.
* **No Excluded Scope Creep:** Rigorously blocks any creep, mentioning the exact forbidden list.
* **Record-Prop Fidelity:** Perfect adherence. Mandates frame color defaults, small highlight properties, `Record` keyed dict for lines, and the Float16 65504 limit check in `buildSegments`.

Keep detailed assertions from CODEX, TDD interleaving sequence from CLAUDE.