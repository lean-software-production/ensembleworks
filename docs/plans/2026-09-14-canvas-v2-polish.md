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

## Batch 2 — in flight at time of writing

`arrow-handles` (endpoint/bend handles, rebind, hover binding target,
arrowhead glyphs), `text-autosize` (text w/h and note/geo `growY` from a
DOM measurer injected into the editor), `style-memory` (next-shape style
learns from edits, fresh shapes show current values, swatch row and panel
overflow fixes), `marquee-live` (brush rectangle, live selection,
Shift-add), `frame-reparent` (drag into/out of frames, clipping),
`drag-modifiers` (Alt-duplicate, Ctrl+D, rotation snap, live Alt/Shift
resize, Escape reverts drag), `toolbar-icons`, `context-menu`,
`geo-hittest` (hit-test the variant outline).

## Deferred (known, not started)

From the gap analysis, still open after batches 1–2: note clone handles +
Tab/Cmd+Enter adjacent notes, note-pit snapping, shrink-to-fit labels,
arrow labels, elbow arrows, `dash: 'draw'` hand-drawn stroke, pattern fill
hatch fidelity, rich text (bold/italic/links), group/ungroup,
align/distribute, lock, frames drawer / frame navigation / focus view /
export for v2 rooms, dark theme, collaborator selection indicators, and the
Phase-4 carried gap of per-pointermove undo granularity.
