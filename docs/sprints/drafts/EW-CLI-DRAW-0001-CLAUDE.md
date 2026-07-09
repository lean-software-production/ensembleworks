# EW-CLI-DRAW-0001 — Sprint plan (draft: CLAUDE)

**Slice:** CLI-only agent can create frames + drawing shapes (line/draw/highlight), reparent
shapes into/out of frames, read them back (canvas frame/frames now surface drawings), and delete a
frame without corrupting contents. **Contracts + server only; ZERO `cli/src` changes** (the CLI is a
pure `GET /api/tools` projection).

**Authoritative spec (do not contradict):**
[plan](/Users/zaza/.claude/plans/i-want-you-to-frolicking-hopcroft.md) ·
[acceptance — 23 ACs](../../acceptance/cli-frames-draw.md) ·
[design note](../../design/cli-frames-draw-api.md).
Excluded scope (flag as creep if seen): **eraser, laser, align, group, image upload**. `op` enum stays
exactly `create|update|delete`; create `type` enum is exactly the **8**:
`geo|text|note|arrow|frame|line|draw|highlight`.

## How to read this plan (TDD Navigator/Driver)

Every phase is **RED → GREEN**: Navigator writes a failing `node:assert` test **first** (real RED —
watch it fail), Driver writes the minimal code to green. Checkboxes are the executable task list.

**One justified reorder.** The design note frames the HTTP suite as a single "Phase G"
(`server/src/shape-api.test.ts`). For TDD, that file is authored **incrementally and interleaved** with
the server phases: scaffolded once (task **C1**), grown by a RED task at the front of each server phase
(C/D/E/F) **before** the matching implementation, then finalized in **Phase G** with the cross-cutting
ACs (error matrix, tools-enum, attribution, compose). Dependency order is therefore:
**A (helper) → B (contracts) → C1 harness → C/D/E/F (RED-then-GREEN) → G (finalize)**.

---

## Phase A — Pure helper `server/src/canvas/drawShapes.ts` (+ `drawShapes.test.ts`)

Repo convention (§7): fiddly, unit-testable logic lives in a plain module with a `node:assert` script
(like `frameNav.ts`/`panelLayout.ts`). Pyramid level for all Phase-A tasks: **unit (node:assert,
bottom)**. Run with `bun server/src/canvas/drawShapes.test.ts`.

- [ ] **A1 (RED) — `parsePoints(raw,min)` tests.** New `drawShapes.test.ts`. Assert throws for: not an
      array; a point that isn't `[num,num]`/`[num,num,num]`; non-finite (`NaN`/`Infinity`); `|x|` or
      `|y| > 1e6` (`1e12`); `raw.length < min`; `< 2` **distinct** points (`[[0,0],[0,0]]`). Assert
      returns parsed `{x,y,z?}[]` for good input (`[[0,0],[120,0]]`). *(design §7, error matrix §6)*
- [ ] **A2 (GREEN) — implement `parsePoints(raw,min)`.** Single input guard; throws a typed error on
      each bad case above; returns `{x,y,z?}[]`. This is where every draw/highlight AC19 case is caught
      (schema can't see inside base64 `path`).
- [ ] **A3 (RED) — `buildSegments(localPoints)` tests (LOAD-BEARING).** (a) Round-trip:
      `b64Vecs.decodePoints(result[0].path)` reproduces `localPoints` within **±1px** per axis. (b)
      Float16 delta ceiling: **`[[0,0],[70000,0]]` throws**, while **`[[0,0],[65000,0]]` and
      `[[0,0],[120,0]]` pass**. *(design §7, appendix #7, error matrix §6)*
- [ ] **A4 (GREEN) — implement `buildSegments(localPoints)`.** **First** reject any consecutive-point
      x/y delta `> 65504` (Float16 delta ceiling → typed throw → 400), **then**
      `compressLegacySegments([{ type:'free', points }])`. Lives here (not `parsePoints`) so `line`
      stays immune (absolute `T.number`).
- [ ] **A5 (RED) — `buildLinePoints(localPoints)` tests.** Assert each key is a **valid `IndexKey`**
      (`T.indexKey.isValid`), `key === id === index`, and `Object.values(...).sort(sortByIndex)`
      reproduces input order. **Do NOT assert literal `'a1'/'a2'`** (`getIndicesAbove` jitters keys
      outside `NODE_ENV==='test'`). *(design §0 line validator, §7)*
- [ ] **A6 (GREEN) — implement `buildLinePoints(localPoints)`.** Keyed dict `{id,index,x,y}` via
      `getIndicesAbove(null, n)` from `@tldraw/utils` (**new import**); `key===id===index`.
- [ ] **A7 (RED) — `translateForReparent` + `toLocal`/`originOf` tests.** `translateForReparent(shape,
      newParentId, byId)`: synthetic `byId` with a nested frame → page-point preserved for frame↔page
      moves (returns `P − NP`). `originOf(points)` = bbox-min; `toLocal(points, origin)` anchors
      top-left at (0,0). *(design §2 normalization, §7)*
- [ ] **A8 (GREEN) — implement `translateForReparent`, `toLocal`, `originOf`.** `P = pagePoint(shape,
      byId)`; `NP = (byId.get(newParentId) is a shape) ? pagePoint(newParent,byId) : {x:0,y:0}`; return
      `{x: P.x−NP.x, y: P.y−NP.y}`. `originOf`/`toLocal` are the §2 bbox-min normalization, unit-tested
      independently of HTTP.

## Phase B — Contracts `contracts/src/tools/canvas.ts`

Level: **schema change** — verified by `bun run typecheck` + integration AC20 (`GET /api/tools`). All
new fields **`.optional()`** (a new required scalar reshuffles positional-slot order in
`cli/src/render/args.ts`). *(design §1)*

- [ ] **B1 — Widen create `type` enum + add optional fields.** `canvasShape.zodInput` (`:28-49`): widen
      `type` (`:32`) to the **8** types. Add `.optional()`: `name`, `points:
      z.array(z.array(z.number()))`, `spline: z.enum(['line','cubic'])`, `closed`, `rotate:
      z.number()`, `lock`, `toPage`, `withChildren`. (`fill`,`color`,`x/y/w/h`,`frame`,`id`,`props`
      already exist.) **Add NOTHING named `align|group|eraser|laser|image`** (AC20).
- [ ] **B2 — Extend read outputs.** `canvasFrames.zodOutput.frames[]` (`:65-70`): add
      `drawings: z.number()`. `canvasFrame.zodOutput` (`:80-92`): add
      `drawings: z.array(z.object({ id: z.string(), type: z.string(), text: z.string().optional() }))`.
- [ ] **B3 — Update `help` strings.** `canvasShape.help` (`:27`) names the new create types + reparent/
      riders/delete flags; `canvasFrame`/`canvasFrames` help mention `drawings`. Record the rotated-
      parent limitation (AC22) in the shape help text.

## Phase C — Server create branches `server/src/features/shape.ts`

Slot four branches after the `note` branch (~`:291`), each building on the existing `base` record
(`:145-156`) and `store.put`. Widen the create enum (`:116`) + its 400 message to the 8 types. Color is
already guarded at `:38-40` (invalid `--color` 400s before any branch, all types). *(design §2)*

- [ ] **C1 (SCAFFOLD — do first, prereq for all C–F RED) — new `server/src/shape-api.test.ts`.** Copy
      the `scribe-api.test.ts:17-82` harness verbatim: `createSyncApp({dataDir})` over real SQLite
      (`mkdtemp`), `server.listen(0)`, `makeTestClient`, a seeded unrotated frame, `documents()`
      snapshot reader. **No mocks.** No assertions yet (trivially green) — this is the shared harness.
- [ ] **C2 (RED) — create round-trip assertions.** Append to `shape-api.test.ts`: `POST
      /api/canvas/shape` create `frame` (props `w/h/name/color`, page-point) / `line` / `draw` /
      `highlight`; then **decode the record**: `props.points` sorted by `index` and `decodePoints(
      props.segments)` equal input **±1px in page space** (`shape.x + local`); `getShapePageBounds`-
      equivalent origin/extent per AC7. Bare `create frame` → 200 with default `w/h/color`; `--spline
      cubic`→`spline:'cubic'`; `--closed`→`isClosed:true`. Fails RED (branches absent).
- [ ] **C3 (GREEN) — implement create enum + 4 branches.** Widen `:116` enum + 400 message. **frame**:
      `{ w: num(w)??800, h: num(h)??600, name: string?body.name:(text??''), color: color??'black' }`
      (color REQUIRED; w/h non-zero; no richText). **line**: `{ color??'black', dash:'draw', size:'m',
      spline: body.spline==='cubic'?'cubic':'line', points: buildLinePoints(toLocal(pts,origin)),
      scale:1 }` — points is a **keyed dict, not array**; `parsePoints(body.points,2)`. **draw**: full
      set `{ color, fill: string?body.fill:'none', dash:'draw', size:'m',
      segments: buildSegments(toLocal(pts,origin)), isComplete:true, isClosed:!!body.closed,
      isPen:false, scale:1, scaleX:1, scaleY:1 }`. **highlight**: SMALLER set `{ color, size:'m',
      segments, isComplete:true, isPen:false, scale:1, scaleX:1, scaleY:1 }` — **NO fill/dash/isClosed**
      (unknown-key → 400 if copied). Each sets `x/y = (num(body.x)??0)+origin.{x,y}` (§2 normalization).

## Phase D — Server update (reparent + riders) `server/src/features/shape.ts`

Extend the update branch (`:72-108`). Build `records`/`byId`/`shapes` in-transaction as create does
(`:126-128`). *(design §3)*

- [ ] **D1 (RED) — reparent + rider assertions.** Append to `shape-api.test.ts`: `--frame` →
      `parentId===frameId`, page-point unchanged **±1px**, new `index` valid/unique/at-or-above the
      frame's existing children; `--to-page` → `parentId` == frame's **actual** page id (multi-page
      seed, not hardcoded `page:page`), page-point ±1px; `--rotate 0.5`→`rotation===0.5` exactly;
      `--lock`→`isLocked===true`; **`--rotate abc/NaN/Infinity` → 400**. Guard: `--x/--y` do NOT move a
      shape that is being reparented.
- [ ] **D2 (GREEN) — implement reparent + riders.** `--frame`: `findFrameByName(shapes,body.frame)`
      (404 on miss), `parentId=target.id`, `{x,y}=translateForReparent(record,parentId,byId)`, `index=
      getIndexAbove(topOf(new-parent siblings via sortByIndex))`. `--to-page`: `parentId=pageIdOf(record,
      byId) ?? firstPage`, translate. Riders: `rotate` non-finite → `throw` (caught at `:104` → 400)
      else `next.rotation=r`; `typeof body.lock==='boolean'`→`next.isLocked`. Guard existing `--x/--y`
      (`:99-100`) with `if (!newParentId)` so translation wins.
- [ ] **D3 — Record rotated-parent limitation (AC22).** `pagePoint` sums parent x/y and ignores
      rotation, so reparent is correct for **unrotated** parents only. State this in help/README (with
      B3) and a code comment at the reparent site — recorded, not silently wrong. No affine claimed.

## Phase E — Server delete (frame semantics) `server/src/features/shape.ts`

Extend the delete branch (`:49-69`). Non-frame delete unchanged (regression). Key on
`target.type==='frame'`. *(design §4)*

- [ ] **E1 (RED) — delete-semantics assertions.** Append to `shape-api.test.ts`: **default** frame
      delete (2 stickies) → frame gone, both stickies present with `parentId` == frame's **actual page**
      (not `page:page`), page-point unchanged ±1px, no dangling `parentId`. **`--with-children`** (+ an
      arrow OUTSIDE bound to a sticky INSIDE) → frame + stickies gone AND every binding touching a
      removed id gone. **Nested** (A⊃B⊃sticky): `delete A` default → B on A's page, B's sticky stays
      under B; `delete A --with-children` → all three gone. **Non-frame** delete → only that shape
      (+its bindings). Fails RED.
- [ ] **E2 (GREEN) — implement frame delete.** `withChildren`: BFS over `parentId` from the frame →
      `removeIds` set; `store.delete` each; delete every binding whose `fromId`/`toId` ∈ `removeIds`.
      Default: reparent **direct** children only to `target.parentId`, `x+=target.x`/`y+=target.y`,
      fresh `index` via `getIndexAbove` against the new parent's siblings; `store.delete(frame)`; cascade
      bindings touching the frame itself. Non-frame path untouched.

## Phase F — Server read symmetry `server/src/features/frames.ts`

Add one `DRAWING_TYPES=['geo','line','draw','highlight']` bucket, mirroring the existing note/text/image
child-gathering. Closes the pre-existing `geo` read gap too. *(design §5)*

- [ ] **F1 (RED) — read-symmetry assertions.** Append to `shape-api.test.ts`: after creating a line, a
      draw, and a geo into the frame, `GET /api/canvas/frame` returns a `drawings` array with `{id,
      type∈{geo,line,draw,highlight}, text?}` (text only where a `richText` label exists — geo yes,
      line/draw/highlight no); `GET /api/canvas/frames` row `drawings` count reflects them and **moves**
      when a drawing is reparented in (D) / a frame is deleted (E). Fails RED.
- [ ] **F2 (GREEN) — implement drawings bucket.** `frames.ts:33-54`: add
      `drawings: children.filter(r => DRAWING_TYPES.includes(r.type)).length` to each row. `frames.ts:
      87-149`: add the `drawings` array via `richTextToPlainText(c.props?.richText)` → `{id,type,text?}`.
      Reads recompute children each call, so AC17 holds with no extra work.

## Phase G — Finalize HTTP integration `server/src/shape-api.test.ts`

Cross-cutting ACs against the now-implemented server. Level: **integration HTTP (middle)**. *(design
§6/§7)*

- [ ] **G1 (RED→assert) — error matrix (AC19).** Each writes **no record** and returns the exact 4xx:
      line `[[0,0]]`(<2)/`[]`; draw/highlight `[[0]]`, `[["a",0]]`, `NaN`/`Infinity`, `1e12`,
      duplicate-consecutive `[[0,0],[0,0]]`, and the **65504 consecutive-delta** case `[[0,0],[70000,0]]`
      → **400**; `create draw --fill bogus` → 400; reparent `--frame no-such` → **404**; `--color mauve`
      → 400; rename `--props '{"name":123}'` → **400 not 500**.
- [ ] **G2 (RED→assert) — enums verbatim from `GET /api/tools` (AC20).** Shape tool `op` enum ===
      `['create','update','delete']`; create `type` enum === the **8** exactly; **no** flag/verb named
      `align|group|eraser|laser|image`. `create group`/`…image`/`…eraser` → 400 (type not in enum).
- [ ] **G3 (RED→assert) — attribution (AC21).** Credentialed → `meta.author===<resolved caller>`;
      anonymous `--author X` → `meta.author===X`; no author context → `meta==={}`. None of the four
      no-text shapes throws/500s for lacking richText. Reuses existing `base.meta` (`:155`) — assertion
      only, likely no new impl.
- [ ] **G4 (RED→assert) — CRUD-completeness rename (AC18).** Agent-made frame: rename via `--props
      '{"name":"Renamed"}'` reflected in `GET /api/canvas/frames`; invalid `--props '{"name":123}'` →
      400. (create=C, read=F, delete=E). Assertion only — existing raw-prop merge (`:97`) + schema cover
      it.
- [ ] **G5 (RED→assert) — end-to-end compose (AC23).** One session: create frame → create line + draw +
      sticky `--frame` → reparent a pre-existing page shape in → `GET /api/canvas/frame` returns the
      frame with all of it (drawings + notes) → `delete` frame default → contents survive on the page.

---

## Per-task → AC mapping (all 23 covered; nothing orphaned, nothing extra)

| Task | Satisfies AC(s) |
|---|---|
| A1/A2 parsePoints | AC5, AC6, AC7, AC19 |
| A3/A4 buildSegments (Float16 guard + round-trip) | AC5, AC6, AC7, AC19 |
| A5/A6 buildLinePoints | AC4 |
| A7/A8 translateForReparent / toLocal / originOf | AC7, AC8, AC9, AC11, AC13 |
| B1 type enum + optional fields | AC1–AC6, AC10, AC20 |
| B2 read-output fields | AC15, AC16 |
| B3 help strings | AC20, AC22 |
| C1 harness scaffold | (enables all HTTP ACs) |
| C2/C3 create branches | AC1, AC2, AC3, AC4, AC5, AC6, AC7 |
| D1/D2 reparent + riders | AC8, AC9, AC10, AC17 |
| D3 rotated-parent note | AC22 |
| E1/E2 frame delete | AC11, AC12, AC13, AC14, AC17 |
| F1/F2 read symmetry | AC15, AC16, AC17 |
| G1 error matrix | AC19, AC10 (bad rotate), AC2 (defaults) |
| G2 tools-enum | AC20 |
| G3 attribution | AC21 |
| G4 rename / CRUD-complete | AC18 |
| G5 compose end-to-end | AC23 |

> **Browser-render half (repo convention).** This repo has **no executable acceptance harness**;
> acceptance is agent-driven ([memory: agent-driven acceptance](../../../.claude/…)). The tasks above
> cover the **executable** half of every AC (unit + integration, numeric decoded-record assertions).
> The **AC agent-walkthrough (top)** half — "a human sees it render / clip / not move" for **AC1, AC3,
> AC8, AC23** — is confirmed live in pipeline **step 8** (`bin/dev up`, drive CLI, screenshot), not
> codable here. Evidence → `docs/acceptance/cli-frames-draw-walkthrough.md`.

## Reuse map (file:line — do NOT reinvent)

| Utility | Location |
|---|---|
| `base` record builder + parent resolution | `server/src/features/shape.ts:130-156` |
| create enum + 400 message (widen here) | `server/src/features/shape.ts:116` |
| update branch (extend) | `server/src/features/shape.ts:72-108` (`--x/--y` `:99-100`) |
| delete branch (extend) | `server/src/features/shape.ts:49-69` |
| `pagePoint` / `pageIdOf` / `richTextToPlainText` | `server/src/canvas/geometry.ts` |
| `findFrameByName` | `server/src/canvas/frames-helper.ts` |
| `getIndexAbove` / `getIndicesAbove` / `sortByIndex` | `@tldraw/utils` (`getIndicesAbove` = new import) |
| `compressLegacySegments` / `createShapeId` / `toRichText` | `@tldraw/tlschema` (already imported) |
| `decodePoints` (test-side decode) | `@tldraw/tlschema` `misc/b64Vecs.ts` |
| `NOTE_COLORS` / `GEO_TYPES` (+ color guard `:38-40`) | `server/src/canvas/constants.ts` |
| HTTP test harness (copy) | `server/src/scribe-api.test.ts:17-82` |
| frames read rows / one-frame read | `server/src/features/frames.ts:33-54` / `:87-149` |
| contract input / outputs | `contracts/src/tools/canvas.ts:28-49` / `:65-70` / `:80-92` |

## Repo-convention constraints (call out explicitly)

- **`node:assert` under `src/`, boot the real app, no mock library** — `drawShapes.test.ts` (pure) and
  `shape-api.test.ts` (real `createSyncApp` + real SQLite, copied from `scribe-api.test.ts`).
- **No new dependencies** — `compressLegacySegments` / `getIndicesAbove` / `decodePoints` already ship
  in installed `@tldraw/tlschema` + `@tldraw/utils`.
- **All new contract fields `.optional()`** — no positional-slot reshuffle in
  `cli/src/render/args.ts`.
- **ZERO `cli/src` changes** — new verbs/enums/flags surface automatically from `GET /api/tools`.
- **Test-first commit pattern** — RED task commits before its GREEN task (sprint-self-review checks
  this).

## Sequencing & dependencies

```
A (helper+unit) ─┐
                 ├─► C3 create   ─┐
B (contracts) ───┘                ├─► D update ─► E delete ─► F read ─► G finalize
                 C1 harness ──────┘   (each server phase: RED → GREEN)
```
- A + B are independent and can proceed in parallel; both are prerequisites of C3.
- C1 (harness) must precede every C–F RED task.
- D/E/F depend on C3 (frames/shapes must be creatable to reparent/delete/read).
- G asserts against the whole implemented surface; it runs last.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Float16 delta overflow (65504) writes `Infinity` yet `put` returns 200 | A3 RED pins `[[0,0],[70000,0]]` throws / `65000` passes **before** A4; guard lives in `buildSegments` (draw/highlight only). |
| Copying draw props onto highlight (`fill`/`dash`/`isClosed`) → unknown-key 400 | C2 RED asserts the highlight record validates with the **smaller** set; C3 keeps the objects separate. |
| Frame `color` omitted → `put` throws (required in 5.1.0) | C3 defaults `color:'black'`; C2 asserts bare `create frame` → 200. |
| `line.points` written as an array (should be keyed dict w/ valid `IndexKey`) | A5 asserts `T.indexKey.isValid` + order (not literal `'a1'`); `buildLinePoints` via `getIndicesAbove`. |
| Reparent jumps the shape / `--x` fights translation | A7 unit + D1 page-point ±1px assertion; D2 guards `--x/--y` with `if (!newParentId)`. |
| Delete orphans children with dangling `parentId` | E1 asserts no dangling `parentId` + survivors on the frame's **actual** page (not `page:page`). |
| `getIndicesAbove` jitters keys outside `NODE_ENV==='test'` | A5 asserts validity+order, never literal keys. |
| Scope creep (eraser/laser/align/group/image) | G2 asserts `op`/`type` enums verbatim from `GET /api/tools`; B1 adds none. |
| Rotated-parent reparent silently wrong | D3 records the limitation (help/README/comment); AC22 = "documented," no affine claimed. |

## Done-ness definition

- [ ] All 23 ACs satisfiable: every executable half green (`bun server/src/canvas/drawShapes.test.ts`
      + `bun server/src/shape-api.test.ts`), browser-render half ready for pipeline step 8.
- [ ] `bun run typecheck` and `bun run build` green across **all three** workspaces
      (client/server/transcriber) — build refreshes the CLI's embedded manifest snapshot.
- [ ] No new dependencies; no `cli/src` diff; all new contract fields optional.
- [ ] Test pyramid respected (unit bottom for `drawShapes`; integration HTTP for `shape-api`); no
      mocks; RED-is-real / test-first-commit for each phase.
