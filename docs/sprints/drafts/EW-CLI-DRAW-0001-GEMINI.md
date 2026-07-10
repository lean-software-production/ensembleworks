# Sprint Plan: EW-CLI-DRAW-0001 (GEMINI)

## Feature in one line
A CLI-only agent can create frames + drawing shapes (line/draw/highlight), reparent shapes into/out of frames, read them back (canvas frame/frames now surface drawings), and delete a frame without corrupting its contents. Everything is **contracts + server**; the CLI is a pure `/api/tools` projection with ZERO `cli/src` changes.

## 1. Ordered TDD Task Breakdown
*(TDD executed Navigator/Driver style: Navigator writes a failing `node:assert` test FIRST, Driver implements minimal code to green.)*

This order strictly layers from pure isolated logic (Phase A) up to contracts (Phase B), into server endpoints (Phases C-F), and finishes with full HTTP integration verification (Phase G). This sequencing isolates the high-risk schema/base64 geometry quirks early, unblocking the server routes.

### Phase A — Pure helper `server/src/canvas/drawShapes.ts` (+ `drawShapes.test.ts`, node:assert)
**Test Level:** Unit (node:assert, bottom)
- [ ] **Task A1: Implement `parsePoints(raw, min)`**
  - **Test:** RED tests for bad inputs: not an array, non-finite coords, `|c| > 1e6`, length < min, < 2 distinct points. Good input returns parsed `VecModel` array.
  - **Implementation:** Validate point arrays before encoding.
- [ ] **Task A2: Implement `buildSegments(localPoints)`**
  - **Test:** RED tests: (a) `b64Vecs.decodePoints(result[0].path)` round-trips back to `localPoints` within ±1px. (b) Load-bearing test: `[[0,0],[70000,0]]` -> throws, while `[[0,0],[65000,0]]` and `[[0,0],[120,0]]` -> pass.
  - **Implementation:** Reject any consecutive-point x/y delta > 65504 (Float16 ceiling). Then run `compressLegacySegments([{type:'free', points}])`.
- [ ] **Task A3: Implement `buildLinePoints(localPoints)`**
  - **Test:** RED test asserting valid `IndexKey` (`T.indexKey.isValid`) + order reproduced via `sortByIndex` with `key===id===index` (DO NOT assert literal 'a1'/'a2').
  - **Implementation:** Use `getIndicesAbove(null, n)` from `@tldraw/utils` to build the keyed dict.
- [ ] **Task A4: Implement `translateForReparent(shape, newParentId, byId)`**
  - **Test:** Synthetic `byId` with nested frame; assert page-point preserved for frame↔page moves.
  - **Implementation:** Use `pagePoint` to get absolute offsets, return translation deltas.
- [ ] **Task A5: Implement `toLocal(points, origin)` / `originOf(points)`**
  - **Test:** Verify bbox-min normalization.

### Phase B — Contracts `contracts/src/tools/canvas.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task B1: Widen create enum and add OPTIONAL fields**
  - **Implementation:** Widen create `type` to 8 values (`geo|text|note|arrow|frame|line|draw|highlight`). Add `name`, `points`, `spline`, `closed`, `rotate`, `lock`, `toPage`, `withChildren` (ALL `.optional()`). Update help strings.
- [ ] **Task B2: Extend read outputs for frames**
  - **Implementation:** Extend `canvasFrames.zodOutput` (drawings count) and `canvasFrame.zodOutput` (drawings array `{id,type,text?}`).

### Phase C — Server create branches `server/src/features/shape.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task C1: Extend create enum & update 400 message**
  - **Implementation:** Expand enum to 8 types (~line 116).
- [ ] **Task C2: Implement frame branch**
  - **Implementation:** Add branch using `base` record. Default color 'black' (required), non-zero w/h defaults.
- [ ] **Task C3: Implement line branch**
  - **Implementation:** Use `parsePoints`, `buildLinePoints`. Keyed dict, no scaleX/scaleY.
- [ ] **Task C4: Implement draw branch**
  - **Implementation:** Use `parsePoints`, `buildSegments`. Include `scaleX`/`scaleY` + `isClosed`.
- [ ] **Task C5: Implement highlight branch**
  - **Implementation:** Use `parsePoints`, `buildSegments`. Small set: NO `fill`/`dash`/`isClosed`.

### Phase D — Server update (reparent + riders) `server/src/features/shape.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task D1: Implement reparent (`--frame`, `--to-page`)**
  - **Implementation:** Extend update branch (~:72-108). `findFrameByName`, `translateForReparent`, recompute index using `getIndexAbove`. For `--to-page`, find frame's ACTUAL page. Guard `--x/--y` to apply only when not reparenting.
- [ ] **Task D2: Implement riders (`--rotate`, `--lock`)**
  - **Implementation:** Finite guard for `--rotate` -> 400.

### Phase E — Server delete (frame semantics) `server/src/features/shape.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task E1: Implement frame default delete (reparent children)**
  - **Implementation:** Extend delete branch (~:49-69). Reparent direct children to frame's actual parent, translate (x+=frame.x), fresh index.
- [ ] **Task E2: Implement frame `--with-children` delete (cascade)**
  - **Implementation:** BFS cascade subtree + delete every binding touching any removed id.
- [ ] **Task E3: Maintain non-frame delete regression**
  - **Implementation:** Ensure non-frame delete works exactly as before.

### Phase F — Server read symmetry `server/src/features/frames.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task F1: Extend `GET /api/canvas/frames`**
  - **Implementation:** Add `drawings` count per frame row (~lines 33-54). Bucket: `['geo','line','draw','highlight']`.
- [ ] **Task F2: Extend `GET /api/canvas/frame`**
  - **Implementation:** Add `drawings` array matching existing note/text/image gathering (~lines 87-149).

### Phase G — HTTP integration `server/src/shape-api.test.ts`
**Test Level:** Integration HTTP (middle)
- [ ] **Task G1: Set up test harness**
  - **Implementation:** Boot REAL app in-process, real SQLite, NO mocks (copy `server/src/scribe-api.test.ts:17-82`).
- [ ] **Task G2: Assert round-trip create (AC1, AC4-AC7)**
  - **Implementation:** Decode `props.segments` / read `props.points` sorted by index, assert == input +/-1px in page space. Check bounds/origin.
- [ ] **Task G3: Assert reparent + riders (AC8-AC10)**
  - **Implementation:** Reparent page-point +/-1px, index valid, actual page resolved. Bad rotate 400.
- [ ] **Task G4: Assert delete semantics (AC11-AC14)**
  - **Implementation:** Default reparents direct children. Nested check. `--with-children` cascade removes bindings. Regression check.
- [ ] **Task G5: Assert read symmetry (AC15-AC17)**
  - **Implementation:** Validate `drawings` bucket in frame(s) endpoints.
- [ ] **Task G6: Assert error matrix + scope + attribution (AC19-AC21)**
  - **Implementation:** Invalid `--points` and `--color` 400s. Enums verbatim exactly the 8 allowed types + 3 ops. `meta.author` set correctly.
- [ ] **Task G7: Document rotated-parent limitation (AC22)**
  - **Implementation:** Verify limitation recorded in source comments/help string.
- [ ] **Task G8: End-to-end compose scenario (AC23)**
  - **Implementation:** Write integration tests covering the full AC23 CLI sequence.

## 2. Per-Task Acceptance Mapping

| Task | AC ID(s) Satisfied |
|---|---|
| Phase A (A1-A5) | Foundation for AC4, AC5, AC6, AC7, AC19 |
| Phase B (B1-B2) | Foundation for AC20, AC15, AC16 |
| Phase C (C1-C5) | AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC19, AC21 |
| Phase D (D1-D2) | AC8, AC9, AC10 |
| Phase E (E1-E3) | AC11, AC12, AC13, AC14 |
| Phase F (F1-F2) | AC15, AC16, AC17 |
| Phase G (G1-G8) | Verifies all of the above via HTTP roundtrips |
| End-to-End Walkthrough | AC23, plus human-visible verification of AC1, AC3, AC8 |

## 3. Reuse Map

| Element | Location (File:Line) |
|---|---|
| Base record builder | `server/src/features/shape.ts:145-156` |
| `pagePoint` | `server/src/canvas/geometry.ts` |
| `findFrameByName` | `server/src/canvas/frames-helper.ts` |
| `getIndexAbove` / `getIndicesAbove` / `sortByIndex` | `@tldraw/utils` |
| `compressLegacySegments` / `createShapeId` / `toRichText` | `@tldraw/tlschema` |
| `NOTE_COLORS` / `GEO_TYPES` | `server/src/canvas/constants.ts` |
| Test harness | `server/src/scribe-api.test.ts:17-82` |

## 4. Test-Pyramid Level Per Task
- **Phase A**: unit (node:assert, bottom)
- **Phase B - Phase G**: integration HTTP (middle)
- **Agent Walkthrough**: AC agent-walkthrough (top, no executable harness — repo convention)

## 5. Repo-Convention Constraints
- Node `assert` tests under `src/` that boot the real app.
- No mock library.
- No new dependencies (`compressLegacySegments` / `getIndicesAbove` already ship in installed pkgs).
- All new contract fields MUST be `.optional()` (no positional-slot reshuffle in `cli/src/render/args.ts`).
- **NO `cli/src` changes** (pure projection surface).
- Excluded scope strictly omitted (eraser, laser, align, group, image upload). The `op` enum stays exactly `create|update|delete`; the `type` enum is exactly `geo|text|note|arrow|frame|line|draw|highlight` (8).

## 6. Sequencing/Dependencies, Risks + Mitigations, & Done-ness Definition
- **Sequencing:** A -> B -> C -> D -> E -> F -> G. Helper logic (A) isolates the most complex Float16 delta behavior from the server. Contracts (B) provide type safety for Server (C-F). Integration tests (G) validate the whole.
- **Risks & Mitigations:**
  - *Risk:* Base64 delta overflow for shapes (design note §0/§7). *Mitigation:* `buildSegments` strictly caps consecutive-point deltas at `65504` and catches it before insertion.
  - *Risk:* CLI slot argument reshuffling. *Mitigation:* Enforce `z.optional()` on all new fields in contracts.
  - *Risk:* Frame children or bindings get orphaned. *Mitigation:* Delete logic BFS cascade and correct translation ensures tree integrity.
- **Done-ness Definition:** All 23 ACs are satisfiable. Tests are GREEN. `bun run typecheck` and `bun run build` run successfully with zero errors across all workspaces.