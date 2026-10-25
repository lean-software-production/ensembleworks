# Canvas v2 — UX polish parity with the tldraw (v1) canvas

**Goal (owner, 2026-09-13):** canvas v2's notes, arrows, geo shapes, frames,
colour/text/font controls reach the same level of polish as the tldraw v1
canvas. Overnight autonomous run: Sonnet implementers + Opus adversarial
validators driven from Workflow scripts, Fable directing and merging.

**Branch:** `bb/polish-canvas-v2-elements-thr_89gnzv52cn`. Each task was
built on its own `polish/<task>` branch in a throwaway worktree, validated,
then merged here. Validators independently re-ran every red/green, drove the
behaviour in a real browser (Playwright) and compared it with tldraw for the
same gesture; a task only merged on a `pass` verdict unless a director note
below says otherwise.

## Method

1. **Gap analysis** — 8 Opus readers, one per area (note, arrow, geo, frame,
   text editing, style panel/toolbar, selection/transform, visual fidelity),
   each producing a rated gap list (feature, v1 behaviour, v2 status, impact,
   effort, where to fix). 155 gaps total; raw JSON kept in the run's
   transcript (`gaps.json`).
2. **Hand scouting** confirmed the two most visible defects before any code:
   arrows rendered a 100×100 "arrow" BoxShape fallback at their origin, and
   the Text tool's click left an empty shape without entering edit mode.
3. **Batches** of tasks, 3 at a time (a 9-wide fan-out tripped the
   subscription's 5-hour session limit and killed every implementer at once;
   see the memory note `subagent-rate-limit-pacing`). Each task:
   implement (Sonnet) → validate (Opus, adversarial) → fix (Sonnet) →
   re-validate. Two tasks needed a third round.

## Batch 1 — landed

| Task | What changed | Verdict |
|---|---|---|
| `label-render` | Empty note renders nothing (was the literal word "note"); static label hidden while editing; multi-line labels; note label size follows `props.size`/`font` (22 px at `m`); tldraw's 3-layer note shadow + 1 px radius | pass |
| `create-edit-flow` | Note tool click → sticky created **and editing** (type immediately, toolbar snaps back to Select); Text tool click → editing; empty text shape auto-deleted on abandon; Enter on a lone text-capable selection starts editing | pass (round 3) |
| `arrow-body` | No BoxShape fallback behind arrows; bounds, point hit-test and marquee follow the routed path (straight or bent); arrow drawn onto a shape binds to it (own in-progress shape excluded from hit-test); viewport cull no longer drops arrows near the edge | accepted (see note 1) |
| `style-panel-icons` | Style panel rebuilt with tldraw-style icon controls (fill/dash/size/font/align/vertical-align), geo icon grid, arrowhead glyphs, opacity slider, swatches matching painted colours | pass (round 2) |
| `note-fixed-size` | Notes hide the 8 resize handles (rotate stays); the resize gesture never arms on a note-only selection, so grabbing a corner drags the note instead of silently translating it | pass |
| `visual-chrome` | Paper background, hover indicator ring (cleared on tool switch), selection outline + handle chrome tuned to tldraw's look | pass (round 2) |
| `geo-variants` | All 20 geo variants render real geometry from a new pure `canvas-model/src/geo-outline.ts` (cloud, star, heart, arrows, check/x-box …) with fill/dash/size honoured | pass (round 2) |
| `frame-interaction` | Frame interior is hollow (clicks/marquee pass through to children); header + border are the hit bands; double-click header renames inline (select-all on open); marquee selects a frame only when fully enclosed | pass (round 2) |
| `keyboard` | Tool shortcuts V/H/N/T/R/A/F/D/L + Escape-to-select with tooltips; Ctrl/Cmd+A (preventDefault'd); arrow-key nudge 1 px / Shift 10 px, one undo step each, works from toolbar focus; Shift-constrained drag that holds its axis beside snap targets | pass after director fix (see note 2) |

**Director notes**
1. `arrow-body`: the round-3 validator could not reproduce a browser-level
   RED for the *excludeId* edge of the new `arrow-binds-to-target-shape`
   contract (in that scene the seeded geo wins the tie-break anyway). The
   unit test `canvas-editor/src/tools/arrow.test.ts` does pin that edge, the
   contract still guards total binding loss, and the goal was verified met
   in the browser, so it was merged on that basis.
2. `keyboard`: the round-2 validator found that arrow keys inside a text
   edit also nudged the shape. Fixed directly on the branch with a RED test
   (`select.test.ts` case 16b: gate on `editingId === null`) before merging.

**Merge-time test updates** (behaviour changes that invalidated old
assertions): `canvas-v2.spec.ts` now counts arrows via
`[data-overlay="arrow"]` and scopes the undo-restore locator to
`[data-shape-kind]` (the hover overlay also carries `data-shape-id`);
`parity.spec.ts` expects `GOLDEN_BOARD_SHAPE_COUNT - GOLDEN_BOARD_ARROW_COUNT`
bodies. The v1-vs-v2 parity gate still passes (every region ≥ 0.92).

**Verification of the merged branch:** `bun run typecheck` 0; every
`*.test.ts` under canvas-*/client/interaction-contracts/contracts/scripts
green; full Playwright e2e lane 76/76. The only red in `bun run test` is
`server/src/{connector,relay}-loopback.test.ts`, which cannot open the tmux
socket inside the agent sandbox (environmental, pre-existing).

## Batch 2 — outcome at close of round (2026-09-14)

| Task | State |
|---|---|
| `style-memory` | **Merged.** Styling a selection also arms the next-shape style (Ctrl/Cmd skips it); fresh shapes and the armed panel show real defaults; all 13 swatches on one row; the panel flips above the selection when a tall geo panel would overflow the viewport. Passed round 2. |
| `text-autosize` | **Merged.** Text shapes grow w/h and note/geo shapes grow `growY` as you type, via a DOM measurer feeding `UpdateProps` (syncs and undoes). Round 1 failed on a padding mismatch that still clipped text; fixed and pinned by a new `labelOverflow` Obs on the `shape-grows-to-fit-typed-text` contract. Passed round 2. Out of scope: fixed-width text via side-handle resize, and shrink-to-fit for long unbreakable words. |
| `arrow-handles` | **Merged.** A selected arrow shows start, end and bend handles; dragging a terminal rebinds with a hover highlight on the target; the bend handle curves it; all 9 arrowhead glyphs render; stroke and heads keep scale with zoom. Round 1 failed because Escape/blur mid-drag left a bound arrow unbound; the fix reverts abandoned drags, binding included. Passed round 2. Advisory: cancelling a bound terminal drag stores the clipped routed point rather than the original raw point. |
| `marquee-live`, `frame-reparent`, `drag-modifiers` | Not started. Implementers died on the session limit before committing anything. |
| `toolbar-icons`, `context-menu`, `geo-hittest` | Not started. |

The round was closed here by the owner (2026-09-14): in-flight work was
finished, no new tasks started. The six unstarted tasks keep their briefs in
the run's `batch2.json`; the one-line scope of each is in the table above.

**Final verification of the branch:** `bun run typecheck` 0; every unit
test file under canvas-*/client/interaction-contracts/contracts/scripts
green; full Playwright e2e lane 82/82 (including the v1-vs-v2 parity gate
and 20+ interaction contracts). Same environmental caveat as batch 1 for the
two server loopback tests.

## Deferred (known, not started)

From the gap analysis, still open after batches 1–2 (plus the six unstarted batch-2 tasks): note clone handles +
Tab/Cmd+Enter adjacent notes, note-pit snapping, shrink-to-fit labels,
arrow labels, elbow arrows, `dash: 'draw'` hand-drawn stroke, pattern fill
hatch fidelity, rich text (bold/italic/links), group/ungroup,
align/distribute, lock, frames drawer / frame navigation / focus view /
export for v2 rooms, dark theme, collaborator selection indicators, and the
Phase-4 carried gap of per-pointermove undo granularity.
