# Code-quality panel — EW-CLI-DRAW-0001

Three independent judges on different model families each scored the diff (`contracts/src` +
`server/src`, incl. tests) against a repo-derived rubric and answered: **is this at least as high
quality as the surrounding code?** Judges are adversarial *finders*, not vetoes — every must-fix was
verified against the real code before being accepted, per the project's multi-model-gate rule.

## Verdicts

| Judge | Model | Verdict | Must-fix |
|---|---|---|---|
| Claude | claude-opus-4-8 | **PASS** (`at_least_as_good: true`) | none (5 nits) |
| Gemini | gemini | **PASS** (`at_least_as_good: true`) | none |
| Codex | codex (gpt-5.5) | **FAIL → fixed → PASS** | 1 (reparent parent-cycle) — verified real, fixed, re-confirmed |

Claude verified empirically (ran both new suites + neighbor suites + typecheck): 23/23 ACs green,
every record survives `store.put`, Float16 guard load-bearing, no new deps, no mocks, scope contained.
Gemini needed a grounded re-run — its first pass couldn't read `node_modules` (gemini honours
`.gitignore`), so the tldraw 5.1.0 validators were copied to an allowed dir and it re-ran clean; both
passes returned PASS. Infra was healthy (no 503s this session, unlike the prior run).

## The one must-fix (Codex) — verified real, then fixed

**Finding:** the reparent path (`shape.ts` update branch) resolved `--frame` via `findFrameByName`
over **all** shapes including the one being updated, with no self/descendant exclusion. So
`update <frameId> --frame "<its own name>"` set `parentId = self`, and `--frame "<a descendant>"`
made an A→B→A cycle. `store.put` **accepts** a cyclic `parentId` (the base validator only checks the
`page:`/`shape:` prefix); `pageIdOf`/`pagePoint` then bail after their 50-hop guard and the browser
tldraw renderer — which assumes an acyclic tree — can break.

**Verified on the merits:** read `shape.ts:179-201` — confirmed no guard; reproduced with a RED test
(`update <frameId> --frame "<own name>"` returned **200**, creating the cycle). Claude's and Gemini's
PASS were on the *tested* surface (no AC covered reparenting a frame into itself) — this is exactly
the adversarial edge a diverse panel exists to surface.

**Fix (TDD, commit `9190848`):**
- `drawShapes.ts` — new pure `wouldCreateCycle(shapeId, newParentId, byId)` (walks up from
  newParentId; true if it reaches shapeId or loops) + unit test.
- `shape.ts` — reparent now returns **400** ("cannot reparent a shape into itself or its own
  descendant") before touching `parentId`. `--to-page` targets a page id → immune.
- `shape-api.test.ts` — **AC24**: self-cycle + descendant-cycle → 400 (`parentId` unchanged);
  non-cyclic sibling reparent still 200. RED-verified (was `200 !== 400`).
- Fixed the misleading "page space" create comment → "parent-relative" (Codex + Claude nit),
  matching the reconciled help text.

**Re-confirmation:** Codex re-ran on the fixed diff and traced the path end-to-end —
`prior_must_fix_resolved: true`, `new_must_fix: none`, `at_least_as_good: true`, **PASS**. It checked
the bypass surfaces (`byId` is the live snapshot so the descendant walk reaches the shape; the raw
`--props` merge doesn't touch `parentId`) and found no remaining path to a cyclic parent.

## Nits (non-blocking; disposition)

| Nit (judge) | Disposition |
|---|---|
| Misleading "page space" create comment (Codex, Claude) | **Fixed** → "parent-relative" |
| `buildSegments` maps `z:0.5`, discarding `[x,y,pressure]` input pressure (Claude) | Kept — `isPen:false` means pressure is cosmetic for these strokes; noted for a future pressure-honouring pass |
| AC21 deviates from the acceptance doc's "anon+author → meta.author" (Claude) | Already reconciled during execute — the doc wording was factually wrong vs `kernel/attribution.ts`; AC21 corrected, deviation documented for PM ratification at the bossman gate |
| `--frame ""` fuzzy-matches the first frame (Claude) | Pre-existing parity with create/sticky — not introduced here |
| `--x`/`--y` add to bbox-min origin rather than set position on line/draw/highlight (Claude) | Intentional (bbox-min normalization); documented in the design note's point-convention section |
| `arrow` still not in the frame-read `drawings` bucket (Claude) | Deliberate scoping (arrows are connectors, read via their bound nodes); worth a one-liner in a future pass |
| AC22 is doc-only (Codex) | Acknowledged — the rotated-parent limitation is a documentation AC by design |
| Invalid `--spline` silently falls back to `line` (Codex) | Minor; the contract enum + CLI `validate.ts` already warn client-side |

## Gate verdict

**PASS.** All three responding judges return `at_least_as_good: true` with zero outstanding must-fix.
The one real must-fix (reparent cycle) was found by Codex, verified against the code, fixed TDD with
a reproducing test (AC24), and independently re-confirmed resolved by Codex. Final: **24/24 ACs green,
typecheck + build + scribe/canvas/attribution regression green.**
