# EW-CLI-DRAW-0001 Sprint Plan — CLI Frames + Draw Shapes

Scope: server/contracts only. No `cli/src` changes, no UI, no new verbs outside the locked surface. Excluded scope remains unbuilt: eraser, laser, align, group, image upload. `op` stays exactly `create|update|delete`; create `type` stays exactly `geo|text|note|arrow|frame|line|draw|highlight`.

Authoritative inputs: approved plan `/Users/zaza/.claude/plans/i-want-you-to-frolicking-hopcroft.md`, acceptance contract `docs/acceptance/cli-frames-draw.md`, and design note `docs/design/cli-frames-draw-api.md`.

## Ordered TDD Task List

### Phase A — Pure Helper: `server/src/canvas/drawShapes.ts`

- [ ] **A1. RED: write `drawShapes.test.ts` coverage for point parsing.** Test `parsePoints(raw,min)` before implementation: accepts `[x,y]` and `[x,y,z]`; rejects non-array, bad tuple arity, non-finite values, `|x|`/`|y| > 1e6`, fewer than `min`, and fewer than two distinct points. Cite design guard at `docs/design/cli-frames-draw-api.md:492-496` and error rows at `:459-466`. Test level: unit (node:assert, bottom).
- [ ] **A2. GREEN: implement `parsePoints(raw,min)` minimally.** Return `{x,y,z?}[]`; throw a typed/recognizable error that `shape.ts` can convert to 400. Preserve the design's degeneracy rule: at least two distinct points, not both-axes-non-zero (`docs/design/cli-frames-draw-api.md:474-482`). Test level: unit (node:assert, bottom).
- [ ] **A3. RED: write `buildSegments(localPoints)` tests with real decode round-trip.** Assert `compressLegacySegments` output decodes back to input within ±1px, and the load-bearing Float16 guard: `[[0,0],[70000,0]]` throws while `[[0,0],[65000,0]]` and `[[0,0],[120,0]]` pass. This is required by `docs/design/cli-frames-draw-api.md:18-34`, `:497-504`, and `:559-570`. Test level: unit (node:assert, bottom).
- [ ] **A4. GREEN: implement `buildSegments(localPoints)`.** First reject any consecutive x/y delta `> 65504`, then call `compressLegacySegments([{ type:'free', points }])`; do not hand-write base64 paths (`docs/design/cli-frames-draw-api.md:69-73`, `:267-270`). Test level: unit (node:assert, bottom).
- [ ] **A5. RED: write `buildLinePoints(localPoints)` ordering and IndexKey tests.** Use `T.indexKey.isValid` or equivalent schema validator and `sortByIndex`; assert key/id/index equality and sorted order, not literal `'a1'/'a2'` (`docs/design/cli-frames-draw-api.md:98-107`, `:505-510`). Test level: unit (node:assert, bottom).
- [ ] **A6. GREEN: implement `buildLinePoints(localPoints)`.** Use `getIndicesAbove(null, n)` from `@tldraw/utils`; produce `Record<string,{id,index,x,y}>` with no handles and no line `scaleX/scaleY` support (`docs/design/cli-frames-draw-api.md:89-107`). Test level: unit (node:assert, bottom).
- [ ] **A7. RED: write normalization and reparent math tests.** Cover `originOf(points)`, `toLocal(points, origin)`, and `translateForReparent(shape,newParentId,byId)` with nested frames; assert page point preserved for frame-to-page and page-to-frame moves using `pagePoint` semantics (`docs/design/cli-frames-draw-api.md:186-203`, `:511-516`). Test level: unit (node:assert, bottom).
- [ ] **A8. GREEN: implement `originOf`, `toLocal`, and `translateForReparent`.** `originOf` is bbox-min; `toLocal` subtracts it; `translateForReparent` computes `pagePoint(shape, byId) - pagePoint(newParent, byId)` or `{0,0}` for page parents. Do not claim rotated-parent support (`docs/design/cli-frames-draw-api.md:345-348`). Test level: unit (node:assert, bottom).

### Phase B — Contracts: `contracts/src/tools/canvas.ts`

- [ ] **B1. RED: add/extend contract tests or schema assertions for the public tool surface.** Assert `canvasShape.zodInput` accepts the 8 create types, keeps `op` exactly `create|update|delete`, includes optional fields `name/points/spline/closed/rotate/lock/toPage/withChildren`, and excludes `align/group/eraser/laser/image` (`docs/design/cli-frames-draw-api.md:142-165`). Test level: unit (node:assert, bottom).
- [ ] **B2. GREEN: widen `canvasShape` input and help string.** Update `contracts/src/tools/canvas.ts:27-49`: widen `type` from 4 to 8; add every new field as `.optional()` only, because required scalars can reshuffle positional slots in `cli/src/render/args.ts`; keep `fill/color/x/y/w/h/frame/id/props` as existing fields. Test level: unit (node:assert, bottom).
- [ ] **B3. RED: add schema assertions for read-output symmetry.** Assert `canvasFrames.zodOutput.frames[]` accepts `drawings: number` and `canvasFrame.zodOutput` accepts `drawings: [{id,type,text?}]` (`docs/design/cli-frames-draw-api.md:167-172`). Test level: unit (node:assert, bottom).
- [ ] **B4. GREEN: extend `canvasFrames` and `canvasFrame` outputs and help strings.** Update `contracts/src/tools/canvas.ts:54-92`; do not add CLI code. Test level: unit (node:assert, bottom).

### Phase C — Server Create Branches: `server/src/features/shape.ts`

- [ ] **C1. RED: HTTP tests for frame creation and defaults.** In `server/src/shape-api.test.ts`, boot the real app in-process and assert `create frame` writes `type:'frame'`, non-zero `w/h`, `props.name`, required default `color:'black'`, page point, and `meta.author` behavior. Cover bare `create frame` and `--name` only (`docs/design/cli-frames-draw-api.md:44-53`, `:205-219`, `:518-533`). Test level: integration HTTP (middle).
- [ ] **C2. GREEN: widen create enum and add the frame branch.** Update `server/src/features/shape.ts:115-118` and add the branch after note/create logic using the existing base record at `shape.ts:145-156`; default `w/h` to `800/600`, `name` to `body.name ?? text ?? ''`, `color` to black. Test level: integration HTTP (middle).
- [ ] **C3. RED: HTTP tests for line creation.** Assert `props.points` is a keyed dict sorted by valid index and reconstructs input page-space points ±1px; assert `--spline cubic`, `<2 points` 400, no record. Cite line schema at `docs/design/cli-frames-draw-api.md:89-107` and create design at `:221-241`. Test level: integration HTTP (middle).
- [ ] **C4. GREEN: add the line branch.** Use `parsePoints`, `originOf`, `toLocal`, and `buildLinePoints`; set `dash:'draw'`, `size:'m'`, `scale:1`, default `spline:'line'`; normalize `x/y` to bbox-min plus optional nudge (`docs/design/cli-frames-draw-api.md:186-203`, `:221-241`). Test level: integration HTTP (middle).
- [ ] **C5. RED: HTTP tests for draw and highlight creation.** Decode `props.segments`, assert page-space points equal input ±1px, `draw --closed` sets `isClosed:true`, missing/empty/degenerate points 400, and highlight has no `fill/dash/isClosed` keys (`docs/design/cli-frames-draw-api.md:55-87`, `:243-295`). Test level: integration HTTP (middle).
- [ ] **C6. GREEN: add draw and highlight branches.** Draw props must include `color/fill/dash/size/segments/isComplete/isClosed/isPen/scale/scaleX/scaleY`; highlight gets the smaller exact set `color/size/segments/isComplete/isPen/scale/scaleX/scaleY` only. Let schema reject invalid fill as 400 via `store.put` (`docs/design/cli-frames-draw-api.md:243-295`, `:467`). Test level: integration HTTP (middle).

### Phase D — Server Update: Reparent + Riders

- [ ] **D1. RED: HTTP tests for `--frame` reparent.** Create a page shape, record page point and sibling order, update into a fuzzy-matched frame, then assert `parentId`, page point ±1px, valid unique top index, and clipped-in-frame browser-read semantics by store/read payload. Use unrotated frame only (`docs/design/cli-frames-draw-api.md:299-348`). Test level: integration HTTP (middle).
- [ ] **D2. GREEN: implement `--frame` reparent in update.** Extend `server/src/features/shape.ts:72-108` to load `records/byId/shapes`, resolve `findFrameByName`, call `translateForReparent`, set `parentId/x/y`, and compute `index` with `getIndexAbove` after `sortByIndex` against new-parent siblings. Test level: integration HTTP (middle).
- [ ] **D3. RED: HTTP tests for `--to-page`, `--rotate`, `--lock`, bad rotate, and `x/y` interaction.** Assert `--to-page` uses the frame's actual page via parent chain, not hardcoded `page:page`; valid rotation persists exactly; lock persists; invalid rotate returns 400; reparent translation is not overwritten by stray `x/y` (`docs/design/cli-frames-draw-api.md:336-343`). Test level: integration HTTP (middle).
- [ ] **D4. GREEN: implement `--to-page`, riders, and `x/y` guard.** Import/use `pageIdOf`; apply `x/y` direct setters only when no reparent target is active; convert non-finite rotate to 400 through the existing catch at `shape.ts:103-105`. Test level: integration HTTP (middle).
- [ ] **D5. Add the rotated-parent limitation note in server help/docs touched by this slice.** Echo the design limitation that `pagePoint` ignores rotation and this sprint supports unrotated reparent math only (`docs/design/cli-frames-draw-api.md:345-348`). Test level: AC agent-walkthrough (top, no executable harness — repo convention).

### Phase E — Server Delete: Frame Semantics

- [ ] **E1. RED: HTTP tests for default frame delete.** Frame with two direct children: delete frame, assert children survive under the frame's actual parent/page, page points unchanged ±1px, fresh indexes, no dangling `parentId` (`docs/design/cli-frames-draw-api.md:352-404`). Test level: integration HTTP (middle).
- [ ] **E2. GREEN: implement default frame delete.** In `server/src/features/shape.ts:49-69`, branch on `target.type === 'frame'`; reparent direct children only to `target.parentId`, translate `x += target.x`, `y += target.y`, assign fresh indexes, delete bindings touching the frame itself. Non-frame path stays as-is. Test level: integration HTTP (middle).
- [ ] **E3. RED: HTTP tests for `--with-children`, nested frames, and bindings.** Assert BFS removes all descendants and every binding touching removed ids, including an outside arrow bound to an inside sticky; default nested delete moves only direct child frame while its sticky stays nested; non-frame delete regression still removes shape plus touching bindings only (`docs/design/cli-frames-draw-api.md:362-412`). Test level: integration HTTP (middle).
- [ ] **E4. GREEN: implement `--with-children` BFS cascade and non-frame regression path.** Use a `removeIds` set over `parentId`, delete all subtree shapes, then delete all bindings with `fromId` or `toId` in the set; preserve existing 404 behavior and delete counts. Test level: integration HTTP (middle).

### Phase F — Server Read Symmetry: `server/src/features/frames.ts`

- [ ] **F1. RED: HTTP tests for `canvas frames` drawings count.** Create `geo/line/draw/highlight` children in a frame; assert `GET /api/canvas/frames` includes `drawings` count and it changes after reparent/delete (`docs/design/cli-frames-draw-api.md:416-430`). Test level: integration HTTP (middle).
- [ ] **F2. GREEN: add `DRAWING_TYPES` count to frames list.** Update `server/src/features/frames.ts:33-54` with `DRAWING_TYPES = ['geo','line','draw','highlight']` and `drawings` count. Test level: integration HTTP (middle).
- [ ] **F3. RED: HTTP tests for `canvas frame <name>` drawings array.** Assert `GET /api/canvas/frame` includes drawings `{id,type,text?}` for `geo/line/draw/highlight`, with `text` only when rich text exists, alongside existing notes/text/images/terminals/iframes (`docs/design/cli-frames-draw-api.md:432-446`). Test level: integration HTTP (middle).
- [ ] **F4. GREEN: add drawings array to frame detail.** Update `server/src/features/frames.ts:87-149` using the existing child-gathering and `richTextToPlainText` pattern; reads must recompute after reparent/delete. Test level: integration HTTP (middle).

### Phase G — HTTP Integration: Full AC Round-Trip

- [ ] **G1. RED: create `server/src/shape-api.test.ts` harness from `scribe-api.test.ts`.** Copy the real app pattern from `server/src/scribe-api.test.ts:17-82`: env setup, `createSyncApp({dataDir})`, `server.listen(0)`, `makeTestClient`, seeded frame, and `documents()` snapshot reader. No mocks, real SQLite. Test level: integration HTTP (middle).
- [ ] **G2. RED: AC create/read geometry suite.** Cover AC1-AC7 with decoded record assertions, sorted line points, decoded draw/highlight segments, bbox-origin normalization, bad single-point line, and browser-visible facts represented numerically in the store (`docs/design/cli-frames-draw-api.md:523-525`). Test level: integration HTTP (middle).
- [ ] **G3. RED: AC update/delete/read suite.** Cover AC8-AC18: reparent in/out, riders, bad rotate, delete default, cascade, nested frames, non-frame delete, read symmetry, frame rename via raw props and invalid rename 400 (`docs/design/cli-frames-draw-api.md:526-531`). Test level: integration HTTP (middle).
- [ ] **G4. RED: AC error/scope/attribution/end-to-end suite.** Cover AC19-AC23: full bad-input matrix including Float16 overflow, GET `/api/tools` enums verbatim, excluded types/flags absent, meta.author cases, rotated-parent limitation recorded, and one composed framed drawing flow (`docs/design/cli-frames-draw-api.md:450-472`, `:532-533`). Test level: integration HTTP (middle).
- [ ] **G5. GREEN: complete minimal implementation until the full HTTP suite passes.** Only touch contracts/server/helper/test files needed by phases A-F. No `cli/src`, no new dependencies, no excluded scope. Test level: integration HTTP (middle).
- [ ] **G6. Top-level acceptance walkthrough task for Navigator/Driver execution.** After implementation, an agent runs `bin/dev up`, drives `ew canvas ...` through all 23 ACs, verifies numeric store observations plus browser screenshots where required, and records evidence in `docs/acceptance/cli-frames-draw-walkthrough.md`. This repo convention has no executable AC harness (`docs/acceptance/cli-frames-draw.md`). Test level: AC agent-walkthrough (top, no executable harness — repo convention).

## Per-Task Acceptance Mapping

| Task | ACs |
|---|---|
| A1 | AC19 |
| A2 | AC19 |
| A3 | AC5, AC6, AC19 |
| A4 | AC5, AC6, AC19 |
| A5 | AC4, AC8 |
| A6 | AC4, AC8 |
| A7 | AC7, AC8, AC9, AC11, AC13 |
| A8 | AC7, AC8, AC9, AC11, AC13, AC22 |
| B1 | AC20 |
| B2 | AC1, AC2, AC4, AC5, AC6, AC8, AC9, AC10, AC11, AC12, AC20 |
| B3 | AC15, AC16 |
| B4 | AC15, AC16, AC17 |
| C1 | AC1, AC2, AC21 |
| C2 | AC1, AC2, AC3, AC18, AC21 |
| C3 | AC4, AC7, AC19 |
| C4 | AC4, AC7, AC19, AC21 |
| C5 | AC5, AC6, AC7, AC19 |
| C6 | AC5, AC6, AC7, AC19, AC21 |
| D1 | AC8 |
| D2 | AC3, AC8, AC17, AC23 |
| D3 | AC9, AC10 |
| D4 | AC9, AC10, AC18 |
| D5 | AC22 |
| E1 | AC11 |
| E2 | AC11, AC13 |
| E3 | AC12, AC13, AC14 |
| E4 | AC12, AC13, AC14, AC17, AC23 |
| F1 | AC16, AC17 |
| F2 | AC16, AC17 |
| F3 | AC15, AC17 |
| F4 | AC15, AC17, AC18, AC23 |
| G1 | AC1-AC23 |
| G2 | AC1, AC2, AC3, AC4, AC5, AC6, AC7 |
| G3 | AC8, AC9, AC10, AC11, AC12, AC13, AC14, AC15, AC16, AC17, AC18 |
| G4 | AC19, AC20, AC21, AC22, AC23 |
| G5 | AC1-AC23 |
| G6 | AC1-AC23 |

## Reuse Map

| Reuse target | File:line |
|---|---|
| Existing shape base record (`id`, `typeName`, `parentId`, `index`, `x/y`, `rotation`, `isLocked`, `opacity`, `meta`) | `server/src/features/shape.ts:145-156` |
| Existing create enum and 400 message to widen | `server/src/features/shape.ts:115-118` |
| Existing delete branch to extend | `server/src/features/shape.ts:49-69` |
| Existing update branch to extend | `server/src/features/shape.ts:72-108` |
| Existing create parent resolution and sibling index logic | `server/src/features/shape.ts:130-143` |
| `pagePoint` and `pageIdOf` for page-space and actual page parent | `server/src/canvas/geometry.ts:27-49` |
| `findFrameByName` fuzzy matcher | `server/src/canvas/frames-helper.ts:10-17` |
| `getIndexAbove`, `sortByIndex` existing imports; add `getIndicesAbove` from same package | `server/src/features/shape.ts:8`; design `docs/design/cli-frames-draw-api.md:104-107` |
| `compressLegacySegments`, `createShapeId`, `toRichText` | `server/src/features/shape.ts:7`; design `docs/design/cli-frames-draw-api.md:69-73` |
| `NOTE_COLORS`, `GEO_TYPES` | `server/src/canvas/constants.ts:6-8` |
| Real app HTTP test harness pattern | `server/src/scribe-api.test.ts:17-82` |
| Contract enum/output locations | `contracts/src/tools/canvas.ts:23-52`, `:54-92` |
| Read-side frame list/detail child-gathering pattern | `server/src/features/frames.ts:33-54`, `:87-149` |

## Repo-Conventions And Constraints

- Tests are `node:assert` scripts under `src/`; HTTP tests boot the real app in-process with real SQLite.
- No mock library and no new dependencies. `compressLegacySegments`, `createShapeId`, `toRichText`, `getIndexAbove`, `getIndicesAbove`, and `sortByIndex` already ship in installed packages.
- All new contract fields are optional to avoid positional-slot reshuffle in `cli/src/render/args.ts`.
- No `cli/src` changes. The CLI is a pure `/api/tools` projection.
- No build in this planning task. Execution done-ness later still requires `bun run typecheck` and `bun run build` across all three workspaces.
- No excluded scope: no eraser, laser, align, group, or image upload; no new `op` values; no extra create types.

## Sequencing, Dependencies, Risks

- Phase A must precede server create/update/delete because it defines the geometry and parent-coordinate seams that make decoded-record assertions possible.
- Phase B should land before HTTP GET `/api/tools` assertions; it also prevents accidental CLI work by making the existing projection sufficient.
- Phase C depends on A and B for shape props and public inputs.
- Phase D depends on A's `translateForReparent` and existing `pagePoint/pageIdOf` behavior.
- Phase E depends on D/A coordinate assumptions so default frame delete preserves page points.
- Phase F depends on C/D/E record behavior so read symmetry can reflect create, reparent, and delete.
- Phase G spans all prior phases and should remain red until the matching implementation lands.

Risks and mitigations:

- **Base64 path accepts invalid geometry.** Mitigate with pre-encoding `parsePoints` plus decoded round-trip tests (`docs/design/cli-frames-draw-api.md:18-34`, `:492-504`).
- **Float16 consecutive deltas can decode to `Infinity`.** Mitigate with `buildSegments` `>65504` guard and the explicit `70000` red test (`docs/design/cli-frames-draw-api.md:559-567`).
- **Line point indexes can be schema-invalid if hand-written.** Mitigate with `getIndicesAbove(null,n)` and IndexKey/order assertions (`docs/design/cli-frames-draw-api.md:98-107`, `:505-510`).
- **Frame delete can orphan children or bindings.** Mitigate with direct-child default move, BFS cascade for `--with-children`, no-dangling-parent/binding assertions (`docs/design/cli-frames-draw-api.md:352-412`).
- **Multi-page correctness can regress through hardcoded `page:page`.** Mitigate by using `pageIdOf` and asserting actual page parent (`server/src/canvas/geometry.ts:27-35`).
- **Rotated-parent math is not implemented.** Mitigate by documenting the limitation; only unrotated reparent/delete page-point preservation is in scope (`docs/design/cli-frames-draw-api.md:345-348`).
- **Contract required fields can break CLI positional rendering.** Mitigate by making every new field `.optional()` (`docs/design/cli-frames-draw-api.md:142-145`).

## Done Definition

- All tasks above have a real RED before the matching GREEN implementation.
- All 23 ACs are satisfiable by executable unit/integration tests or the documented agent walkthrough convention.
- `GET /api/tools` exposes exactly the locked `op` and create `type` enums, with no excluded flags or verbs.
- `canvas frame` and `canvas frames` read back drawings symmetrically with create/reparent/delete behavior.
- No `cli/src` changes and no new dependencies.
- Implementation execution, when performed, ends with `bun run typecheck` and `bun run build` green across `client`, `server`, and `transcriber`.
