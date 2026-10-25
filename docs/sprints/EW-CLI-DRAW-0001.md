# EW-CLI-DRAW-0001 — Sprint plan: CLI frame + drawing-shape creation, reparent, delete

**Slice.** A CLI-only agent can **create** frames + drawing shapes (line / draw / highlight),
**reparent** shapes into/out of frames (coords translated, no jump), **read** them back (`canvas
frame`/`frames` now surface a `drawings` bucket), and **delete** a frame without corrupting its
contents (children kept by default, cascade on `--with-children`). Everything is **contracts +
server**; the CLI is a pure `GET /api/tools` projection — **ZERO `cli/src` changes** (new
verbs/enums/flags surface automatically).

**Authoritative spec (do not contradict — the design is nailed down and adversarially verified; this
plan only operationalizes the ordered TDD breakdown):**
[approved plan](/Users/zaza/.claude/plans/i-want-you-to-frolicking-hopcroft.md) ·
[acceptance — 23 ACs](../acceptance/cli-frames-draw.md) ·
[design note (5.1.0 record props, error matrix, §7 test seams)](../design/cli-frames-draw-api.md).

**Excluded scope (flag as creep if any task touches it): eraser, laser, align, group, image upload.**
`op` enum stays exactly `create|update|delete`; create `type` enum is exactly the **8**:
`geo|text|note|arrow|frame|line|draw|highlight` — no more, no less (AC20 asserts both verbatim from
`GET /api/tools`).

**Provenance.** Merged from three independent drafts (codex, gemini, claude) + three cross-critiques.
The merge anchors on the claude draft's TDD structure (RED-at-front-of-each-server-phase, harness
scaffold hoisted first), grafts codex's per-step RED/GREEN granularity + line-pinned reuse citations,
and adopts gemini's one-branch-per-task create decomposition. All three critiques independently
converged on the same two findings the merge acts on: **(1)** the codex draft's fatal sequencing bug —
its `shape-api.test.ts` harness is scaffolded only at G1 (the end) while phases C–F write RED tests
into it — and **(2)** the claude draft's C1-first interleave as the correct TDD fix. Gemini's critique
arrived late and terse (its CLI hung near the timeout twice this session; codex and claude were
healthy throughout) but corroborated the codex+claude consensus verbatim ("keep detailed assertions
from CODEX, TDD interleaving from CLAUDE"). All reuse-map anchors below were spot-checked against real
source.

---

## Goals / non-goals

**Goals**
- Every one of the 23 ACs becomes satisfiable (executable half green; browser-render half ready for
  the agent-walkthrough pipeline step).
- Two new test artifacts, both repo-convention: `server/src/canvas/drawShapes.test.ts` (pure
  `node:assert`) and `server/src/shape-api.test.ts` (boots the real app in-process, real SQLite, **no
  mocks** — copied from the `scribe-api.test.ts` pattern).
- `bun run typecheck` + `bun run build` green across all three workspaces (client/server/transcriber).

**Non-goals**
- No `cli/src` changes. No new npm dependencies (`compressLegacySegments`, `getIndicesAbove`,
  `decodePoints` already ship in installed `@tldraw/tlschema` + `@tldraw/utils`).
- No excluded-scope types/ops/flags. No rotation-aware page math — the rotated-parent reparent
  limitation is **recorded** (AC22), not silently mis-implemented.

---

## How to read this plan (TDD, Navigator/Driver)

Every phase is **RED → GREEN in separate checkboxes**: Navigator writes a failing `node:assert` test
**first** (real RED — watch it fail for the right reason), Driver writes the minimal code to green.
One RED commit per GREEN commit (the pattern `sprint-self-review` checks).

**The one justified reorder (fixes a bug both critiques caught).** The design note frames the HTTP
suite as a single "Phase G" (`server/src/shape-api.test.ts`). For real TDD that file is authored
**incrementally**: scaffolded once as the **first task of Phase C** (task **C1**), grown by a RED task
at the front of each server phase (C/D/E/F) **before** the matching implementation, then finalized in
**Phase G** with the cross-cutting ACs. Dependency order:

```
A (pure helper + unit) ─┐
                        ├─► C1 harness scaffold ─► C create ─► D update ─► E delete ─► F read ─► G finalize
B (contracts)  ─────────┘        (each server phase: RED → GREEN, interleaved into shape-api.test.ts)
```
A and B are independent and may proceed in parallel; both are prerequisites of the create branches.

---

## Phase A — Pure helper `server/src/canvas/drawShapes.ts` (+ `drawShapes.test.ts`)

Repo convention (design §7): fiddly, unit-testable logic lives in a plain module with a `node:assert`
script (like `frameNav.ts`/`panelLayout.ts`). **Test level for all of Phase A: unit (node:assert,
bottom).** Run: `bun server/src/canvas/drawShapes.test.ts`.

- [ ] **A1 (RED) — `parsePoints(raw, min)` tests.** New `drawShapes.test.ts`. Assert it **throws** for:
      not an array; a point that isn't `[num,num]`/`[num,num,num]`; non-finite (`NaN`/`Infinity`);
      `|x|` or `|y| > 1e6` (e.g. `1e12`); `raw.length < min`; fewer than **2 distinct** points
      (`[[0,0],[0,0]]`). Assert it **returns** `{x,y,z?}[]` for good input (`[[0,0],[120,0]]`). *(design
      §7 `:492-496`, error matrix §6 `:459-466`, degeneracy rule `:474-482`)*
- [ ] **A2 (GREEN) — implement `parsePoints(raw, min)`.** The single input guard; throws a typed error
      on each bad case; returns `{x,y,z?}[]`. This is where every draw/highlight AC19 point case is
      caught — the schema can't see inside the base64 `path` (design §0 load-bearing note `:18-34`).
- [ ] **A3 (RED) — `buildSegments(localPoints)` tests (LOAD-BEARING).** (a) round-trip:
      `decodePoints(result[0].path)` reproduces `localPoints` within **±1px** per axis; (b) the
      Float16 delta ceiling: **`[[0,0],[70000,0]]` throws**, while **`[[0,0],[65000,0]]` and
      `[[0,0],[120,0]]` pass**. *(design §7 `:497-504`, appendix #7 `:559-570`, §0 `:18-34`)*
- [ ] **A4 (GREEN) — implement `buildSegments(localPoints)`.** **First** reject any consecutive-point
      x/y delta `> 65504` (Float16 delta ceiling → typed throw → 400), **then**
      `compressLegacySegments([{ type:'free', points }])` from `@tldraw/tlschema` — never hand-write
      `path`. Guard lives **here** (not `parsePoints`) so `line` stays immune (absolute `T.number`).
      *(design §7 `:497-504`, §0 `:69-73`)*
- [ ] **A5 (RED) — `buildLinePoints(localPoints)` tests.** Assert each key is a **valid `IndexKey`**
      (`T.indexKey.isValid`), `key === id === index`, and `Object.values(...).sort(sortByIndex)`
      reproduces input order. **Do NOT assert literal `'a1'/'a2'`** — `getIndicesAbove` jitters keys
      outside `NODE_ENV==='test'`, so the running server's strings are non-deterministic; assert
      *validity + order*. *(design §0 line validator `:98-107`, §7 `:505-510`)*
- [ ] **A6 (GREEN) — implement `buildLinePoints(localPoints)`.** Keyed dict `{id,index,x,y}` via
      `getIndicesAbove(null, n)` (**new import** from `@tldraw/utils`); `key===id===index`; no handles,
      no `scaleX/scaleY`. *(design §0 `:89-107`)*
- [ ] **A7 (RED) — `translateForReparent` + `toLocal`/`originOf` tests.** `translateForReparent(shape,
      newParentId, byId)`: synthetic `byId` with a nested frame → page-point preserved for frame↔page
      moves (returns `P − NP`). `originOf(points)` = bbox-min; `toLocal(points, origin)` anchors
      top-left at (0,0). *(design §2 normalization `:186-203`, §7 `:511-516`)*
- [ ] **A8 (GREEN) — implement `translateForReparent`, `toLocal`, `originOf`.** `P = pagePoint(shape,
      byId)`; `NP = (byId.get(newParentId) is a shape) ? pagePoint(newParent,byId) : {x:0,y:0}`; return
      `{x: P.x−NP.x, y: P.y−NP.y}`. `originOf`/`toLocal` are the §2 bbox-min normalization, unit-tested
      independently of HTTP. **Do NOT claim rotated-parent support** (design §3 `:345-348`).

## Phase B — Contracts `contracts/src/tools/canvas.ts`

A **schema change** (no standalone `node:assert` seam — design §7 names exactly two seams:
`drawShapes.test.ts` + `shape-api.test.ts`, and routes AC20's enum check through `GET /api/tools` in
the HTTP suite). **Verified by** `bun run typecheck` + the HTTP AC20 assertion in **G2**. All new
fields **`.optional()`** (a new required scalar reshuffles positional-slot order in
`cli/src/render/args.ts`). *(design §1 `:142-172`)*

- [ ] **B1 — Widen create `type` enum + add optional input fields.** `canvasShape.zodInput`
      (`canvas.ts:28-49`): widen `type` (`:32`) to the **8**. Add `.optional()`: `name`, `points:
      z.array(z.array(z.number()))`, `spline: z.enum(['line','cubic'])`, `closed`, `rotate:
      z.number()`, `lock`, `toPage`, `withChildren`. (`fill`,`color`,`x/y/w/h`,`frame`,`id`,`props`
      already exist.) **Add NOTHING named `align|group|eraser|laser|image`** (AC20). `op` (`:30`)
      unchanged.
- [ ] **B2 — Extend read outputs.** `canvasFrames.zodOutput.frames[]` (`:65-69`): add
      `drawings: z.number()`. `canvasFrame.zodOutput` (`:80-91`): add
      `drawings: z.array(z.object({ id: z.string(), type: z.string(), text: z.string().optional() }))`.
- [ ] **B3 — Update `help` strings + record the rotated-parent limitation (AC22).**
      `canvasShape.help` (`:27` — currently "geo, arrow, text, note") names the new create types +
      reparent/riders/delete flags and states that reparent is correct for **unrotated** parents only;
      `canvasFrame`/`canvasFrames` help mention `drawings`.

## Phase C — Server create branches `server/src/features/shape.ts`

Slot four branches after the `note` branch (~`:291`), each building on the existing `base` record
(`:145-156`) + `store.put`. The invalid-`--color` guard already runs before any branch (design §2
`:38-40`), so a bad color 400s for every type. Frame/line/draw/highlight carry **no text** → they
never call `toRichText`/`badgeText`; `base.meta` still stamps `author` (AC21). **One branch per
RED/GREEN pair** — isolates the highlight-vs-draw prop-set difference as its own reviewable unit.
*(design §2 `:176-295`)*

- [ ] **C1 (SCAFFOLD — do FIRST; prereq for every C–F RED task) — new `server/src/shape-api.test.ts`.**
      Copy the harness **pattern** from `scribe-api.test.ts:7-62` (imports `node:assert/strict`,
      `mkdtemp`, `makeTestClient`; `createSyncApp({ dataDir })` over real SQLite, `server.listen(0)`,
      `makeTestClient(base)`, a `documents()` snapshot reader, and a seeded **unrotated** frame). **No
      mocks.** No assertions yet (trivially green) — this is the shared harness the interleaved RED
      tasks write into. *(Fixes the codex-draft bug where the harness lived at the end in G1 while C–F
      referenced it.)*
- [ ] **C2 (RED) — frame create assertions.** Append to `shape-api.test.ts`: `POST /api/canvas/shape`
      create `frame` → record `type:'frame'`, `props.{w,h,name,color}`, page-point `(x,y)`. Bare
      `create frame` (no flags) → **200** with non-zero default `w/h` + default `color` (never 400s for
      missing size); `--name`-only succeeds; a no-name frame reads back `name:""`. Fails RED (branch
      absent → current enum 400). *(AC1, AC2)*
- [ ] **C3 (GREEN) — frame branch + widen server enum.** Add `'frame'` to the create enum (`:116`) +
      its 400 message; add the branch: `props: { w: num(body.w)??800, h: num(body.h)??600, name: typeof
      body.name==='string'?body.name:(text??''), color: color??'black' }`. **`color` is REQUIRED in
      5.1.0** (omit → `put` throws); `w/h` non-zero defaults; no `richText`. *(design §2 `:205-219`)*
- [ ] **C4 (RED) — line create assertions.** `create line --points '[[0,0],[120,60],[200,0]]'` →
      `{ok,id}`; read `props.points`, sort by `index`, ordered vertices equal input (±1px, page space
      `shape.x + local`); `--spline cubic` → `spline:'cubic'`; `--points '[[0,0]]'` (<2) → **400**, no
      record. *(AC4, AC7 partial)*
- [ ] **C5 (GREEN) — line branch.** `parsePoints(body.points,2)` → `origin=originOf` → `props: {
      color:color??'black', dash:'draw', size:'m', spline: body.spline==='cubic'?'cubic':'line', points:
      buildLinePoints(toLocal(pts,origin)), scale:1 }`; `x/y = (num(body.x)??0)+origin.{x,y}`. `points`
      is a **keyed dict, not an array**. *(design §2 `:221-241`)*
- [ ] **C6 (RED) — draw create assertions.** `create draw --points '[[0,0],[40,10],[80,60]]'` →
      `{ok,id}`; `decodePoints(props.segments)` equals input (±1px per axis); a degenerate single-point
      blob **fails**; `--closed` → `isClosed:true`; missing/empty `--points` → **400**; `--fill bogus` →
      **400** (schema rejects on `put`). *(AC5, AC7 partial, AC19 draw rows)*
- [ ] **C7 (GREEN) — draw branch.** Full prop set `{ color, fill: typeof body.fill==='string'?body.fill:
      'none', dash:'draw', size:'m', segments: buildSegments(toLocal(pts,origin)), isComplete:true,
      isClosed:!!body.closed, isPen:false, scale:1, scaleX:1, scaleY:1 }`. `scaleX/scaleY` are
      **required** (finite non-zero) — omitting them throws. *(design §2 `:243-266`, appendix #2)*
- [ ] **C8 (RED) — highlight create assertions.** `create highlight --points '[[0,0],[120,0]]'` →
      `{ok,id}`; decoded segment points equal input (±1px); the record validates with the **smaller**
      prop set — assert **no `fill`, no `dash`, no `isClosed`** key present (unknown-key → 400 if
      copied from draw). *(AC6, AC7 partial)*
- [ ] **C9 (GREEN) — highlight branch.** SMALLER exact set only: `{ color, size:'m', segments:
      buildSegments(toLocal(pts,origin)), isComplete:true, isPen:false, scale:1, scaleX:1, scaleY:1 }`
      — **NO `fill`/`dash`/`isClosed`**. `buildSegments` shared with draw; only the props object
      differs. *(design §2 `:273-295`, appendix #3)*

## Phase D — Server update (reparent + riders) `server/src/features/shape.ts`

Extend the update branch (`:72-108`). Build `records`/`byId`/`shapes` in-transaction as the create
branch does (`:126-128`), then assemble `next` from the prop merge. *(design §3 `:299-348`)*

- [ ] **D1 (RED) — reparent + rider assertions.** Append to `shape-api.test.ts`: record page-point P via
      the decoded record before. `--frame "Test frame"` → `parentId===frameId`, new page-point == P
      (±1px each axis), new `index` valid/unique and sorts **at/above** the frame's existing children;
      `--to-page` → `parentId` == the frame's **actual page id** (seed a multi-page doc — NOT hardcoded
      `page:page`), page-point ±1px; `--rotate 0.5` → `rotation===0.5` exactly; `--lock` →
      `isLocked===true`; **`--rotate abc/NaN/Infinity` → 400**; stray `--x/--y` does **not** move a
      shape that is being reparented. *(AC8, AC9, AC10, AC17)*
- [ ] **D2 (GREEN) — implement reparent.** `--frame`: `findFrameByName(shapes, body.frame)` (**404** on
      miss), `next.parentId=target.id`, `{x,y}=translateForReparent(record, target.id, byId)`,
      `next.index=getIndexAbove(top-of-new-parent-siblings via sortByIndex)`. `--to-page`:
      `next.parentId = pageIdOf(record, byId) ?? firstPage`, translate. **Guard** the existing `--x/--y`
      overrides (`:99-100`) with `if (!newParentId)` so the translation wins. *(design §3 `:305-343`)*
- [ ] **D3 (GREEN) — implement riders.** `body.rotate !== undefined`: `num(body.rotate)` non-finite →
      `throw` (caught by the existing try/catch `:103-105` → 400) else `next.rotation = r`; `typeof
      body.lock==='boolean'` → `next.isLocked = body.lock`. Both persist (record fields). *(design §3
      `:323-329`)*
- [ ] **D4 (GREEN) — record the rotated-parent limitation (AC22) at the reparent site.** `pagePoint`
      (`geometry.ts`) sums parent x/y and **ignores rotation**, so reparent is correct for **unrotated**
      parents only. Add a code comment at the reparent site echoing B3's help note — recorded, not
      silently wrong; no affine transform claimed. *(design §3 `:345-348`)*

## Phase E — Server delete (frame semantics) `server/src/features/shape.ts`

Extend the delete branch (`:49-69`; today it deletes `target` + bindings touching it, which orphans a
frame's children). Key new behavior on `target.type === 'frame'`; **non-frame delete unchanged**
(regression). *(design §4 `:352-412`)*

- [ ] **E1 (RED) — delete-semantics assertions.** Append to `shape-api.test.ts`: (a) **default** — frame
      with 2 stickies → `delete <frameId>` → frame gone, both stickies present with `parentId` == the
      frame's **actual page** (not `page:page`), page-point unchanged (±1px), no dangling `parentId`;
      (b) **`--with-children`** — same setup plus an arrow **outside** the frame bound to a sticky
      **inside** → frame + both stickies gone AND every binding whose `fromId`/`toId` was any removed id
      gone; (c) **nested** A⊃B⊃sticky — `delete A` default → B on A's page (unmoved), B's sticky stays
      under B; `delete A --with-children` → all three gone; (d) **non-frame** delete (geo/line/draw/
      arrow) → only that shape + bindings touching it. Fails RED. *(AC11, AC12, AC13, AC14)*
- [ ] **E2 (GREEN) — default frame delete (keep children).** Reparent **direct** children only to
      `target.parentId` (the frame's real page or enclosing frame), translate `x += target.x` /
      `y += target.y`, assign a fresh `index` via `getIndexAbove` against the new parent's siblings;
      `store.delete(target.id)`; cascade bindings touching the **frame itself**. *(design §4 `:378-398`)*
- [ ] **E3 (GREEN) — `--with-children` cascade.** BFS over `parentId` from the frame → `removeIds` set;
      `store.delete` each; then delete every binding whose `fromId`/`toId` ∈ `removeIds` (incl. an
      arrow living outside the frame). No binding references a deleted id afterward. *(design §4
      `:362-377`)*

## Phase F — Server read symmetry `server/src/features/frames.ts`

Add one `DRAWING_TYPES = ['geo','line','draw','highlight']` bucket, mirroring the existing note/text/
image child-gathering. Closes the pre-existing `geo` read gap too. Reads recompute children every
call, so AC17 (read reflects reparent/delete) holds for free. *(design §5 `:416-446`)*

- [ ] **F1 (RED) — read-symmetry assertions.** Append to `shape-api.test.ts`: after creating a line, a
      draw, and a geo into the frame, `GET /api/canvas/frame "<name>"` returns a `drawings` array of
      `{id, type∈{geo,line,draw,highlight}, text?}` (text only where a `richText` label exists — geo
      yes, line/draw/highlight no), alongside existing notes/texts/images/terminals/iframes; `GET
      /api/canvas/frames` row `drawings` count reflects them and **moves** when a drawing is reparented
      in (D) or a frame is deleted (E). Fails RED. *(AC15, AC16, AC17)*
- [ ] **F2 (GREEN) — drawings count (frames list).** `frames.ts:36-52`: add
      `drawings: children.filter((r) => DRAWING_TYPES.includes(r.type)).length` to each row (join the
      existing `countOf` block). *(design §5 `:422-430`)*
- [ ] **F3 (GREEN) — drawings array (frame detail).** `frames.ts:87-99` region: add the `drawings`
      array via `richTextToPlainText(c.props?.richText)` → `{id,type,text?}`, matching the existing
      `byType`/`notes` gathering. *(design §5 `:432-446`)*

## Phase G — Finalize HTTP integration `server/src/shape-api.test.ts`

Cross-cutting ACs against the now-implemented server. **Test level: integration HTTP (middle).**
Assertions that *drive* an earlier branch are already pinned in that branch's RED (noted inline);
Phase G consolidates the cross-cutting matrix and **re-pins the highest-risk rows at the HTTP layer**
because AC19 requires the observable "no record written" outcome. *(design §6/§7)*

- [ ] **G1 (RED→assert) — full error matrix at the HTTP layer (AC19).** Each writes **no record** and
      returns the exact 4xx: line `[[0,0]]`(<2) / `[]`; draw/highlight `[[0]]`, `[["a",0]]`,
      `NaN`/`Infinity`, `1e12`, duplicate-consecutive `[[0,0],[0,0]]`, and — the row that failed the
      original adversarial gate — **the 65504 consecutive-delta case `[[0,0],[70000,0]]` → 400**
      (re-pinned here at HTTP, not only at unit A3); `create draw --fill bogus` → 400; reparent
      `--frame no-such-frame` → **404**; `--color mauve` → 400; frame rename `--props '{"name":123}'` →
      **400 not 500**. *(AC19; also re-covers AC10 bad-rotate, AC2 defaults)*
- [ ] **G2 (RED→assert) — enums verbatim from `GET /api/tools` (AC20).** Shape tool `op` enum ===
      `['create','update','delete']`; create `type` enum === the **8** exactly; **no** flag/verb named
      `align|group|eraser|laser|image` anywhere in the tool schema. `create group`/`…image`/`…eraser` →
      400 (type not in enum). *(AC20 — the executable check for Phase B)*
- [ ] **G3 (RED→assert) — attribution (AC21).** Credentialed instance → `meta.author===<resolved
      caller>`; anonymous instance with `--author X` → `meta.author===X`; no author context → `meta==={}`.
      None of the four no-text shapes throws/500s for lacking richText; text-bearing shapes (note/geo/
      text) still get the 🤖 badge. Reuses existing `base.meta` — assertion-first; likely no new impl.
      *(Note the harness must set the caller/auth context — copy from `scribe-api.test.ts`.)*
- [ ] **G4 (RED→assert) — frame CRUD-completeness / rename (AC18).** Agent-made frame: rename via
      `--props '{"name":"Renamed"}'` reflected in `GET /api/canvas/frames`; invalid `--props
      '{"name":123}'` → **400** (not 500). create=C, read=F, delete=E — no write-only/read-only orphan.
      Existing raw-prop merge (`shape.ts:97`) + `frameShapeProps.name = T.string` on `put` should cover
      it; RED confirms, no new impl expected. *(AC18 — the AC gemini's draft orphaned.)*
- [ ] **G5 (RED→assert) — end-to-end compose (AC23).** One session: create frame → create line + draw +
      sticky `--frame` → reparent a pre-existing page shape in → `GET /api/canvas/frame` returns the
      frame with all of it (drawings + notes) → `delete` frame (default) → contents survive on the page
      (AC11). *(AC23)*

---

## Per-task → AC traceability (all 23 covered; nothing orphaned, nothing extra)

| Task(s) | Satisfies AC(s) |
|---|---|
| A1/A2 `parsePoints` | AC5, AC6, AC7, AC19 |
| A3/A4 `buildSegments` (Float16 guard + round-trip) | AC5, AC6, AC7, AC19 |
| A5/A6 `buildLinePoints` | AC4 |
| A7/A8 `translateForReparent` / `toLocal` / `originOf` | AC7, AC8, AC9, AC11, AC13 |
| B1 type enum + optional input fields | AC1–AC6, AC10, AC20 |
| B2 read-output fields | AC15, AC16 |
| B3 help strings + rotated-parent note | AC20, AC22 |
| C1 harness scaffold | (enables every HTTP AC) |
| C2/C3 frame branch | AC1, AC2, AC3, AC21 |
| C4/C5 line branch | AC4, AC7, AC19, AC21 |
| C6/C7 draw branch | AC5, AC7, AC19, AC21 |
| C8/C9 highlight branch | AC6, AC7, AC19, AC21 |
| D1/D2 reparent | AC8, AC9, AC17 |
| D3 riders | AC10 |
| D4 rotated-parent note | AC22 |
| E1/E2 default frame delete | AC11, AC13, AC14, AC17 |
| E3 `--with-children` cascade | AC12, AC13 |
| F1/F2/F3 read symmetry | AC15, AC16, AC17 |
| G1 error matrix (HTTP) | AC19, AC10, AC2 |
| G2 tools-enum verbatim | AC20 |
| G3 attribution | AC21 |
| G4 rename / CRUD-complete | AC18 |
| G5 compose end-to-end | AC23 |

> **Browser-render half (repo convention).** This repo has **no executable acceptance harness**;
> acceptance is agent-driven. The tasks above cover the **executable** half of every AC (unit +
> integration, numeric decoded-record assertions). The **AC agent-walkthrough (top)** half — "a human
> sees it render / clip / not move" for **AC1, AC3, AC8, AC23** — is confirmed live in the pipeline's
> acceptance-walkthrough step (`bin/dev up`, drive the CLI, screenshot in the browser). Evidence →
> `docs/acceptance/cli-frames-draw-walkthrough.md`. A browser glance corroborates; it never substitutes
> for the decoded-record assertion.

## Reuse map (file:line — do NOT reinvent; all spot-checked against real source)

| Utility / seam | Location |
|---|---|
| `base` record builder + create parent resolution + sibling `getIndexAbove(topIndex)` | `server/src/features/shape.ts:131-156` |
| create enum + 400 message (widen to 8 here) | `server/src/features/shape.ts:116-117` |
| update branch (extend; `--x/--y` overrides at `:99-100`; try/catch at `:103-105`) | `server/src/features/shape.ts:72-108` |
| delete branch (extend; `store.delete` at `:57`/`:62`) | `server/src/features/shape.ts:49-69` |
| `pagePoint` / `pageIdOf` / `richTextToPlainText` | `server/src/canvas/geometry.ts` (imported by `frames.ts:9`) |
| `findFrameByName` fuzzy matcher | `server/src/canvas/frames-helper.ts` |
| `getIndexAbove`, `sortByIndex` (already imported `shape.ts:8`); **`getIndicesAbove` = NEW import** | `@tldraw/utils` |
| `compressLegacySegments`, `createShapeId`, `toRichText` (already imported `shape.ts:7`) | `@tldraw/tlschema` |
| `decodePoints` (test-side decode of `props.segments`) | `@tldraw/tlschema` (`misc/b64Vecs.ts`) |
| `NOTE_COLORS` / `GEO_TYPES` + shared color guard (`shape.ts:38-40`) | `server/src/canvas/constants.ts` |
| HTTP test harness **pattern** to copy (createSyncApp / listen(0) / makeTestClient / documents / mkdtemp) | `server/src/scribe-api.test.ts:7-62` |
| frames read: list-row child counts / one-frame child gathering | `server/src/features/frames.ts:36-52` / `:83-99` |
| contract input / list-output / frame-output | `contracts/src/tools/canvas.ts:28-49` / `:65-69` / `:80-91` |

## Test-pyramid strategy

- **Bottom — unit (`node:assert`):** all of Phase A (`drawShapes.test.ts`). Pure functions, no HTTP.
- **Middle — integration HTTP (real app, real SQLite, no mocks):** Phases C–G (`shape-api.test.ts`),
  copied from the `scribe-api.test.ts` pattern. Every geometry/position AC asserts the **decoded
  record** (points, `parentId`, page-point, `index`, `rotation`) numerically, ±1px.
- **Top — AC agent-walkthrough (no executable harness — repo convention):** the browser-render halves
  of AC1/AC3/AC8/AC23, driven live in the pipeline's acceptance step; evidence file, not code.
- **Phase B (contracts)** is a schema edit verified by `typecheck` + the HTTP enum assertion (G2) — no
  third `node:assert` seam (design §7 names only two).

## Repo-convention constraints (call out explicitly)

- **`node:assert` tests under `src/`; boot the real app; no mock library.** `drawShapes.test.ts` (pure)
  and `shape-api.test.ts` (real `createSyncApp` + real SQLite, copied pattern from `scribe-api.test.ts`).
- **No new dependencies** — `compressLegacySegments`, `getIndicesAbove`, `decodePoints`, `createShapeId`,
  `toRichText`, `getIndexAbove`, `sortByIndex` already ship in installed `@tldraw/tlschema` +
  `@tldraw/utils`.
- **All new contract input fields `.optional()`** — no positional-slot reshuffle in
  `cli/src/render/args.ts`.
- **ZERO `cli/src` changes** — new verbs/enums/flags surface automatically from `GET /api/tools`.
- **Test-first commit pattern** — each RED task commits before its GREEN task (`sprint-self-review`
  checks this).

## Sequencing & dependencies

- **A** (helper) and **B** (contracts) are independent → parallel; both prerequisite to the create
  branches.
- **C1** (harness scaffold) must land before every C–F RED task (the file they write into).
- **C** create precedes **D** reparent / **E** delete / **F** read (shapes must be creatable first).
- **F** read depends on C/D/E so `drawings` reflects create + reparent + delete.
- **G** asserts against the whole implemented surface → last. Assertions that drive earlier behavior
  are pinned in that phase's RED; G is cross-cutting consolidation + regression.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Float16 delta overflow (65504)** decodes to `Infinity` yet `put` returns 200 (base64 `path` is `T.string`) — the one defect that failed the adversarial gate | A3 RED pins `[[0,0],[70000,0]]` throws / `65000`/`120` pass **before** A4; guard lives in `buildSegments` (draw/highlight only, line immune); **re-pinned at HTTP in G1**. |
| Base64 `path` bypasses schema validation of point data entirely | All count/finiteness/magnitude/degeneracy checks in `parsePoints` **before** encoding (A1/A2); decoded round-trip asserted (A3, C6/C8). |
| Copying draw props onto highlight (`fill`/`dash`/`isClosed`) → unknown-key 400 | C8 RED asserts the highlight record validates with the **smaller** set (no fill/dash/isClosed); C9 keeps the objects separate. |
| Frame `color` omitted → `put` throws (required in 5.1.0) | C3 defaults `color:'black'`; C2 asserts bare `create frame` → 200 with defaults. |
| `line.points` written as an array instead of a keyed dict with valid `IndexKey` | A5 asserts `T.indexKey.isValid` + order (never literal `'a1'`); `buildLinePoints` via `getIndicesAbove`. |
| `getIndicesAbove` jitters keys outside `NODE_ENV==='test'` (non-deterministic strings) | A5 asserts **validity + order**, not literal keys. |
| Reparent jumps the shape / stray `--x` fights the translation | A7 unit + D1 page-point ±1px assertion; D2 guards `--x/--y` with `if (!newParentId)`. |
| Delete orphans children with dangling `parentId`, or drops them on `page:page` instead of the real page | E1 asserts no dangling `parentId` + survivors on the frame's **actual** page; E2 reparents direct children to `target.parentId`. |
| `--to-page` hardcodes first page → wrong on multi-page docs | D2 uses `pageIdOf` (walks parent chain); D1 seeds a multi-page doc and asserts the actual page id. |
| Rotated-parent reparent silently mis-placed (`pagePoint` ignores rotation) | B3 + D4 **record** the limitation (help/README/comment); AC22 = "documented," no affine claimed. |
| Scope creep (eraser/laser/align/group/image) | G2 asserts `op`/`type` enums verbatim from `GET /api/tools`; B1 adds none. |
| Harness ordering (a RED task with no file to write into) | C1 scaffold hoisted to the front of Phase C (the reorder above). |

## Done-ness definition

- [ ] All 23 ACs satisfiable: executable half green — `bun server/src/canvas/drawShapes.test.ts` **and**
      `bun server/src/shape-api.test.ts` pass; browser-render half (AC1/AC3/AC8/AC23) ready for the
      pipeline's agent-driven acceptance-walkthrough step.
- [ ] `bun run typecheck` and `bun run build` green across **all three** workspaces
      (client/server/transcriber) — the build also refreshes the CLI's embedded manifest snapshot so
      the new verbs work offline.
- [ ] `GET /api/tools` exposes exactly the locked `op` and 8-value create `type` enums; no excluded
      type/flag/verb.
- [ ] No new dependencies; no `cli/src` diff; every new contract field `.optional()`.
- [ ] Test pyramid respected (unit bottom for `drawShapes`; integration HTTP for `shape-api`); no
      mocks; RED-is-real / one-RED-commit-per-GREEN for each phase.
