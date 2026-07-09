# Acceptance walkthrough — CLI frames + drawing creation (EW-CLI-DRAW-0001)

Agent-driven walkthrough of every item in [`cli-frames-draw.md`](./cli-frames-draw.md), run against
the **live app** on the final code. This repo has no executable acceptance harness (plain `node:assert`
unit scripts; Playwright kept out-of-tree), so acceptance is a driven walkthrough: the **real `ew` CLI
binary** drives `/api/canvas/*`, and every result is confirmed by a **numeric store round-trip** in the
browser (`window.__ewEditor`) plus a screenshot for the human-visible ACs. Per the evidence rule, every
geometry/position AC asserts the **decoded record** (points, `parentId`, page-point, `index`,
`rotation`) numerically — a browser glance only corroborates.

## Result — 23 / 23 PASS

| AC | What was checked | Result |
|----|------------------|--------|
| **AC1** Create a frame | record `type:frame`, `props{w:600,h:400,name,color:blue}`, page-point (100,80); `canvas frames` lists it; renders titled | ✅ |
| **AC2** Defaults & minimal | bare `create frame` → 200, `w:800,h:600`, color present, `name:""`; `--name`-only succeeds | ✅ |
| **AC3** Agent frame is a real parent | sticky + geo `--frame` → each `parentId` == frame id; render clipped inside | ✅ |
| **AC4** Line, vertex order | decoded `props.points` sort-by-index == input ±1px; `--spline cubic`; `<2 pts` → 400, no record | ✅ |
| **AC5** Freehand draw | base64 `segments` decode == input ±1px; `--closed`→`isClosed:true`; empty → 400 | ✅ |
| **AC6** Highlighter | decoded == input ±1px; prop set has NO `fill/dash/isClosed`, has `scaleX/scaleY` | ✅ |
| **AC7** Bounds land where asked | line/draw page-bounds == input bbox (origin ±1, extent ±2); highlight decoded-point bbox exact (page-bounds inflate by stroke width — see notes) | ✅ |
| **AC8** Reparent INTO frame | `parentId` == frame id, page-point unchanged ±1px, new `index` sorts above existing child; clips inside, unmoved | ✅ |
| **AC9** Reparent OUT to real page | 2-page doc: `--to-page` → `parentId` == the frame's **actual** page id (not `page:page`), page-point unchanged | ✅ |
| **AC10** Rotate/lock riders | `rotation === 0.5` exact, `isLocked === true`; both survive a browser reload; invalid rotate → 400 | ✅ |
| **AC11** Delete keeps children | 2-page doc: frame gone, both stickies survive on the frame's **actual** page id, unmoved, no dangling `parentId` | ✅ |
| **AC12** `--with-children` cascade | frame + 2 inside stickies gone, external arrow's binding to a deleted sticky gone; no binding references a deleted id | ✅ |
| **AC13** Nested delete | default: A gone, B → page unmoved, B's sticky stays under B; cascade: A+B+sticky all gone | ✅ |
| **AC14** Non-frame delete (regression) | delete geo → geo + its binding gone, other geo survives | ✅ |
| **AC15** `canvas frame` lists drawings | `drawings` array with line/draw/geo; geo carries `text`, line has none; other buckets present | ✅ |
| **AC16** `canvas frames` counts drawings | row `drawings:3`, drops to `2` after one removed | ✅ |
| **AC17** Read reflects reparent/delete | reparented geo appears under new frame; deleted frame absent from `canvas frames` | ✅ |
| **AC18** Frame CRUD complete | rename via `--props` reflected in `canvas frames`; invalid `{name:123}` → 400 (not 500) | ✅ |
| **AC19** Bad-input matrix | 12 cases → 400, reparent-to-missing-frame → 404; store shape count unchanged (no record written) | ✅ |
| **AC20** Excluded scope unbuilt | `op` enum == create\|update\|delete; type enum == the 8; no align/group/eraser/laser/image; `create group` → 400 | ✅ |
| **AC21** Attribution objective | anon: 4 types → `meta === {}`; `--author` parity with reference geo (no fabricated author); note gets `🤖 Bob` badge; credentialed stamp via unit | ✅ |
| **AC22** Documented limitation | rotated-parent reparent limitation recorded in design note + CLI `--help` | ✅ |
| **AC23** Compose end-to-end | frame + line + draw + sticky + reparented geo; `canvas frame` surfaces all; renders coherent; delete keeps contents | ✅ |

## Environment
- App: **http://localhost:8080** (Caddy), room **`ew-cli-draw-accept`** (browser `?room=ew-cli-draw-accept`).
- CLI: real binary — `PATH="$HOME/.bun/bin:$PATH" ENSEMBLEWORKS_URL=http://localhost:8080
  ENSEMBLEWORKS_ROOM=ew-cli-draw-accept bun cli/src/main.ts <verb> …` from the repo root. `--json` on.
- Store observations via `window.__ewEditor.getShape/getShapePageBounds/getShapePageTransform/store`
  (Playwright MCP). Draw/highlight base64 paths decoded with a faithful in-browser port of
  `@tldraw/tlschema` `b64Vecs.decodePoints` (the exact function the server unit test uses).
- Instance identity: **anonymous** (`kernel whoami` → `{identity:null, kind:"anonymous", via:"none"}`).
- The server/store contract is independently green: `bun server/src/shape-api.test.ts` → **23/23 ACs green**
  (real `createSyncApp` + SQLite; covers the credentialed AC21 path and the 2-page AC9/AC11 seeds).
- **CLI note:** `update`/`delete` require `--id` (a bare positional binds to `type`, not `id`).
- Screenshots referenced below live in the run's scratchpad (`…/scratchpad/shots/*.png`) and are **not
  committed** to the repo tree, per the deliverable instruction.

---

## Per-AC evidence

### AC1 — Create a frame ✅
- CLI: `canvas shape create frame --name "Test frame" --w 600 --h 400 --x 100 --y 80 --color blue`
  → `{"ok":true,"id":"shape:OVfq5FkZEqLacrRKvE_si"}`
- CLI: `canvas frames` → row `{name:"Test frame", x:100, y:80, w:600, h:400, drawings:0}`
- Store: `type:'frame'`, `parentId:"page:page"`, `x:100, y:80`, `props{w:600,h:400,name:"Test frame",color:"blue"}`,
  `pageBounds {x:100,y:80,w:600,h:400}`.
- Screenshot: `shots/ac1-frame.png` — frame titled "TEST FRAME", 600×400 at (100,80).

### AC2 — Defaults & minimal ✅
- CLI: `canvas shape create frame` → `{"ok":true,...}` (200, never 400s for missing size).
- CLI: `canvas shape create frame --name "Named only"` → 200.
- Store: bare frame `w:800, h:600, color:"black", name:""` (empty → browser labels "Frame"); named frame `name:"Named only"`.
  (Both auto-placed frames were deleted afterward to keep the room legible.)

### AC3 — Agent-made frame is a real parent ✅
- CLI: `canvas sticky "hi" --frame "Test frame"` → note `shape:GLA7…`; `canvas shape create geo --frame "Test frame"` → geo `shape:yiOot…`
- Store: both `parentId == "shape:OVfq5FkZEqLacrRKvE_si"` (the frame); both page-bounds fully within the frame bounds.
- Screenshot: `shots/ac3-children-clip.png` — white geo rectangle + orange "hi" sticky clipped inside TEST FRAME.

### AC4 — Create a line (vertex order preserved) ✅
- CLI: `canvas shape create line --points '[[0,700],[120,760],[200,700]]' --color red` → `shape:8bh-…`
- Store: `props.points` sorted by `index` → page verts `[[0,700],[120,760],[200,700]]` (== input, order preserved);
  `pageBounds {x:0,y:700,w:200,h:60}`.
- CLI: `… line --points '[[300,700],[360,760]]' --spline cubic` → store `props.spline == "cubic"`.
- CLI: `… line --points '[[0,0]]'` → `{"error":"…points must have at least 2 point(s)"}` (server 400, no record).
- Screenshot: `shots/ac456-drawings.png` (red V-line).

### AC5 — Freehand draw (decoded == input) ✅
- CLI: `canvas shape create draw --points '[[400,700],[440,710],[480,760]]' --color green` → `shape:VgdC…`
- Store: base64 `segments[0].path` decoded (`b64Vecs.decodePoints` port) → `[[400,700],[440,710],[480,760]]` (== input ±1px);
  props carry `fill/dash/isClosed`, `isClosed:false`, `scaleX:1`.
- CLI: `… draw --points '[[600,700],[640,700],[620,760]]' --closed` → decoded `[[600,700],[640,700],[620,760]]`, `isClosed:true`.
- CLI: `… draw --points '[]'` → server 400, no record.
- Screenshot: `shots/ac456-drawings.png` (green freehand stroke, closed-draw hook).

### AC6 — Highlighter (decoded == input) ✅
- CLI: `canvas shape create highlight --points '[[800,700],[920,740]]' --color yellow` → `shape:7iQg…`
- Store: decoded path → `[[800,700],[920,740]]` (== input ±1px); prop set has **no** `fill/dash/isClosed`, has `scaleX/scaleY`; `type:'highlight'`.
- Screenshot: `shots/ac456-drawings.png` (thick yellow marker stroke).

### AC7 — Bounds land where asked ✅
- Line `shape:8bh-…`: `pageBounds {x:0,y:700,w:200,h:60}` == input bbox (origin ±0, extent ±0); both extents ≥ 2.
- Draw `shape:VgdC…`: `pageBounds {x:400,y:700,w:80,h:60}` == input bbox (80×60); not collapsed, not flung.
- Highlight `shape:7iQg…`: **decoded-point** bbox origin (800,700) / extent (120,40) is exact; `getShapePageBounds`
  reads `{x:786.1,y:686.1,w:147.8,h:67.8}` — inflated **symmetrically ~14px** by the highlighter's rendered stroke
  half-width. This is stroke thickness (not a fling: geometry origin is exact). See notes.

### AC8 — Reparent INTO a frame, no jump ✅
- Setup (CLI): frame "Reparent frame" @ (1300,100) 400×300; an existing geo child; a page geo `shape:LVQjIzD5…` @ page (1400,180).
- Before: `parentId:"page:page"`, page-point (1400,180); existing child `index:a03f4q3V`.
- CLI: `canvas shape update --id shape:LVQjIzD5… --frame "Reparent frame"` → `{"ok":true,…}`
- Store: `parentId == frame id`; page-point (1400,180) **unchanged** (no jump); new `index:a1gaCVhV` sorts **above**
  the existing child `a03f4q3V` (unique); page-bounds fully inside the frame.
- Screenshot: `shots/ac8-reparent-in.png` — violet reparented rect clipped inside REPARENT FRAME.

### AC9 — Reparent OUT to the correct page ✅
- Setup: a **real 2nd page** `page:3hnHhECCqxBvrofaTcuVt` ("Second") created in the browser; a frame + geo child seeded on it
  (child at page-point (1200,560)). CLI creates always land on the first page, so page-2 seeding is required to make the
  "not `page:page`" assertion meaningful — done live.
- CLI: `canvas shape update --id shape:ac9S --to-page` → `{"ok":true,…}`
- Store: `parentId == "page:3hnHhECCqxBvrofaTcuVt"` (the frame's **actual** page, **not** `page:page`); page-point (1200,560) unchanged.

### AC10 — Rotate & lock riders (exact, persist) ✅
- CLI: `canvas shape update --id shape:aAscx… --rotate 0.5` → store `rotation === 0.5` (exact).
- CLI: `canvas shape update --id shape:aAscx… --lock` → store `isLocked === true`.
- Persistence: full browser reload → re-read `rotation:0.5, isLocked:true` (persisted).
- Invalid rotate: CLI blocks client-side (`field rotate must be number`, exit 2, no request sent). Direct POST
  `{op:update,rotate:"abc"}` and `{rotate:null}` → **HTTP 400** `"rotate must be a finite number"` (server rejects too).

### AC11 — Delete a frame KEEPS its children ✅
- Setup: on page-2, frame "P2 delete" @ (2000,500) 600×400 with 2 stickies at page-points (2040,540) / (2300,680).
- CLI: `canvas shape delete --id shape:ac11F` → `{"ok":true,"deleted":1}`
- Store: frame gone; both stickies survive; `parentId == "page:3hnHhECCqxBvrofaTcuVt"` (the frame's **actual** page,
  not `page:page`); page-points unchanged (2040,540)/(2300,680); **no dangling `parentId`** anywhere on the page.
- Screenshot: `shots/ac11-delete-keeps.png` — both stickies survive on page "SECOND" (frame border gone).

### AC12 — `--with-children` cascades children AND bindings ✅
- Setup: frame "Cascade frame" + 2 inside stickies + a geo **outside** + an **arrow** (outside geo → inside sticky A).
  Pre-state: arrow `parentId:"page:page"`, a binding references sticky A.
- CLI: `canvas shape delete --id shape:uXPf… --with-children` → `{"ok":true,"deleted":4}`
- Store: frame + both inside stickies gone; outside geo survives; **0 bindings reference any deleted id** (the arrow's
  binding to sticky A removed; the arrow→outside-geo binding remains).

### AC13 — Nested-frame delete moves only DIRECT children ✅
- Setup: Frame A ⊃ Frame B ⊃ sticky (via `create frame --frame` / `sticky --frame`); B at page-point (100,2800). A second identical set for cascade.
- CLI (default): `canvas shape delete --id <A>` → A gone; B survives, `parentId:"page:page"`, page-point unchanged (100,2800);
  B's sticky **still under B**.
- CLI (cascade): `canvas shape delete --id <A2> --with-children` → `{"deleted":3}`; A2, B2, and B2's sticky all gone.

### AC14 — Non-frame delete unchanged (regression) ✅
- Setup: geoA + geoB + arrow(A→B).
- CLI: `canvas shape delete --id <geoA>` → `{"ok":true,"deleted":2}` (geo + its binding).
- Store: geoA gone; geoB survives; 0 bindings reference geoA.

### AC15 — `canvas frame <name>` lists drawings ✅
- Setup: frame "Read frame" with a line, a freehand draw, and a geo labeled "geo lbl".
- CLI: `canvas frame "Read frame"` → `drawings:[{line},{draw},{geo,text:"geo lbl"}]`; geo carries `text`, line has no `text` field;
  `notes/texts/images/terminals/iframes` buckets all present. `type ∈ {geo,line,draw,highlight}`.

### AC16 — `canvas frames` counts drawings ✅
- CLI: `canvas frames` → "Read frame" row `drawings:3`.
- CLI: `canvas shape delete --id <line>` then `canvas frames` → `drawings:2` (count moves with add/remove).

### AC17 — Read reflects reparent/delete ✅
- After AC8: `canvas frame "Reparent frame"` → `drawings` includes the reparented geo `shape:LVQjIzD5…`.
- After AC11: `canvas frames` → "P2 delete" **absent**; listing shows `[Test frame, Reparent frame, NestB, Read frame, P2 reparent]`
  (frames listed across both pages). Read verbs and store agree.

### AC18 — Frame CRUD complete (symmetric) ✅
- CLI: `canvas shape update --id <RF> --props '{"name":"Renamed frame"}'` → `canvas frames` shows "Renamed frame" (old name gone).
- Invalid: `--props '{"name":123}'` → **HTTP 400** `ValidationError: At shape(type = frame).props.name: Expected string, got a number` (not 500).

### AC19 — Bad-input matrix returns clean 4xx ✅
Direct POST (to capture true HTTP status), all against `ew-cli-draw-accept`:

| case | status |
|------|--------|
| line `[[0]]` (1-tuple) | 400 |
| line `[["a",0]]` (non-numeric) | 400 |
| line `[]` (empty) | 400 |
| draw `[]` (empty) | 400 |
| draw `[[0]]` (1-tuple) | 400 |
| highlight `[[0]]` (1-tuple) | 400 |
| draw `[[5,5],[5,5]]` (collapse) | 400 |
| draw `[[1e12,0],[1,2]]` (huge) | 400 |
| line `[[1e12,0],[1,2]]` (huge) | 400 |
| draw `[[0,0],[70000,0]]` (>65504 delta) | 400 |
| draw `fill:"bogus"` | 400 |
| highlight `color:"mauve"` | 400 |
| reparent to `--frame "no-such-frame-xyz"` | **404** |

- Store: shape count **25 → 25** (no record written for any case); reparent-404 target's `parentId` unchanged. None 500, none silent success.

### AC20 — Excluded scope stays UNBUILT ✅
- `GET /api/tools` shape tool: `op` enum == `["create","delete","update"]`; create `type` enum == `["arrow","draw","frame","geo","highlight","line","note","text"]` (exactly the 8).
- No input field or type enum member named `align/group/eraser/laser/image`.
- Direct POST `type:group|image|eraser|laser|align` → **400** each. CLI `canvas shape create group` → `{"error":"type must be geo | text | note | arrow | frame | line | draw | highlight"}`.

### AC21 — Agent attribution is consistent & objective ✅
- Instance is **anonymous** (`whoami` → `identity:null`).
- 4 types created anon (frame/line/draw/highlight) → `meta === {}` for all (none threw/500 for lacking richText).
- `--author "Bob"` on all 4 types + a reference geo → every `meta === {}` (identical to the reference geo — **no fabricated
  `meta.author`**, matching `kernel/attribution.ts`: an anonymous voluntary author is a cosmetic badge only).
- Text-bearing note `--text "hello" --author Bob` → `props.richText` contains `"🤖 Bob: hello"`.
- The **credentialed** branch (`meta.author === resolved caller`) is not reachable on this anonymous live instance; it is
  proven by `shape-api.test.ts` AC21 (sends a `cf-access-authenticated-user-email` header, asserts `meta.author == "agent@ew.test"`
  for all 4 types) — **green**.

### AC22 — Documented limitation (rotated-parent reparent) ✅
- `docs/design/cli-frames-draw-api.md` records it (lines 345–347: "This slice supports **unrotated parents only**;
  the limitation is recorded here", plus line 412 for delete-reparent).
- CLI `canvas shape --help`: "…both preserve page-position; **correct for UNROTATED parents only**…". The limitation is
  recorded rather than silently wrong (no affine transform is claimed).

### AC23 — Compose a framed drawing end-to-end ✅
- One CLI session: create geo "pre-existing" on the page; create frame "Compose" @ (100,5000) 600×400; create a line + a
  freehand draw + a sticky `--frame "Compose"`; reparent the pre-existing geo in (`update --frame`).
- CLI: `canvas frame "Compose"` → `drawings:[geo,line,draw]` + `notes:1` (surfaces line + draw + reparented geo + sticky).
- Store: all four children `parentId == frame id`; all inside the frame bounds.
- Screenshot: `shots/ac23-compose.png` — coherent, correctly-clipped frame (note sticky, pre-existing geo, red line, violet draw).
- CLI: `canvas shape delete --id <Compose>` → `{"deleted":1}`; frame gone, all four contents survive on `page:page`, no dangling `parentId` (AC11 semantics).

---

## Notes & caveats (honest)

1. **AC7 highlight page-bounds inflation (expected, not a failure).** `getShapePageBounds` for the highlighter
   reads ~148×68 with a top-left ~14px above/left of the input origin — this is the highlighter's rendered stroke
   half-width, symmetric on all sides. The **decoded stroke geometry** (the actual stored points) has origin (800,700)
   and extent 120×40 exactly, so the shape is neither collapsed nor flung. Line and draw page-bounds match the input
   bbox exactly (thin strokes). AC7's intent — lands where asked, right size, not degenerate — holds.

2. **AC21 credentialed path — verified via unit, browser-deferred.** This live instance resolves every caller as
   anonymous (no Cloudflare Access / dev identity), so the `meta.author == <caller>` branch can't be exercised through
   the live CLI. Every *anonymous* attribution assertion passed live; the credentialed branch is covered by
   `shape-api.test.ts` AC21 (green). Not fabricated.

3. **Observation → RECONCILED (consistent convention; docs fixed, no code change).** Originally flagged: `create …
   --frame` places `--points` **parent-relative** (frame-local), while the help said "page coords". On inspection this
   is **not a bug** — it's the established create-API convention: `shape.x` is stored raw with `parentId = frame`
   (`shape.ts:145-156`), so `geo`/`text`/`note`/`sticky` framed-create are frame-local **too**. Making line/draw/highlight
   translate would make them *inconsistent* with every other create verb (a worse defect), and reparent (`update --frame`)
   translates only because it MOVES an existing shape and must not jump (AC8 verified). Resolution: the imprecise "page
   coords" label was corrected to **"parent-relative (page coords on the page, frame-local under `--frame`)"** in the CLI
   help (`contracts/src/tools/canvas.ts`) and the design note's point-convention section. Behavior unchanged; AC4–AC7 use
   unparented shapes where parent-relative == page. AC23's drawings used frame-appropriate (frame-local) coords, which is
   now the documented convention.

4. **Backing unit contract.** `bun server/src/shape-api.test.ts` → **23/23 ACs green** against the real in-process app
   (SQLite, same schema the browser runs), including the credentialed AC21 and the 2-page AC9/AC11 seeds.
