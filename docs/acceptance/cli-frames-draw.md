# Acceptance checklist — Frame + drawing creation in the CLI (EW-CLI-DRAW-0001)

Feature: a CLI-only agent can **create** frames and drawing shapes, **reparent** shapes into/out of
frames, **read them back**, and **delete** a frame without corrupting its contents. New surface (all
contracts + server; the CLI is a pure `/api/tools` projection, zero `cli/src` changes):

```
canvas shape create frame   --name … --w … --h … --x … --y … --color …
canvas shape create line    --points '[[0,0],[120,60],[200,0]]' [--spline line|cubic] [--color …]
canvas shape create draw    --points '[[0,0],[40,10],[80,60]]' [--closed] [--color … --fill …]
canvas shape create highlight --points '[[…],[…]]' [--color …]
canvas shape update <id> --frame <name>   |   --to-page      # reparent (coords translated)
canvas shape update <id> --rotate <rad>   |   --lock         # riders (base fields)
canvas shape delete <id>                                     # frame → children kept (moved to its page)
canvas shape delete <id> --with-children                     # frame → cascade-delete contents + bindings
canvas frame  <name>    # NOW also lists drawings (geo/line/draw/highlight), not just note/text/image/…
canvas frames           # NOW also counts drawings per frame
```

This repo has **no executable acceptance-test harness** (plain `node:assert` unit scripts; Playwright
kept out-of-tree). Acceptance is **agent-driven**: `bin/dev up`, drive the **CLI** (`ew canvas …`),
and verify each result with a **numeric store round-trip** (`window.__ewEditor.getSnapshot()` /
`getShapePageBounds(id)` in the browser, and the read verbs) — **plus** a browser screenshot for the
human-visible ACs. Evidence lands in [`cli-frames-draw-walkthrough.md`](./cli-frames-draw-walkthrough.md).

> **Evidence rule (hard-won from the AC critique):** "it renders in the browser" is NOT sufficient
> evidence — a broken base64 encoder or a reparent that forgets coordinates still draws *something*.
> Every geometry/position AC must assert the **decoded record** (points, `parentId`, page-point,
> `index`, `rotation`) numerically, ±1px. A browser glance corroborates; it never substitutes.

> **Status: 0 / 23 — not yet built.**

## Checklist

### Frame creation
- [ ] **AC1 — Create a frame.** `canvas shape create frame --name "Test frame" --w 600 --h 400 --x 100
      --y 80` → `{ ok:true, id:"shape:…" }`. Store record: `type:'frame'`, `props.{w:600,h:400,name:"Test
      frame",color}`, page-point (100,80). `canvas frames` lists it. Browser shows a 600×400 frame titled
      "Test frame" at (100,80).
- [ ] **AC2 — Defaults & minimal call.** `canvas shape create frame` (no flags) → valid record with a
      non-zero default `w`/`h` and a default `color` (never 400s for missing size); `--name` alone also
      succeeds. A no-name frame reads back `name:""` (browser labels it "Frame").
- [ ] **AC3 — Agent-made frame is a real parent.** After AC1, `canvas sticky "hi" --frame "Test frame"`
      and `canvas shape create geo --frame "Test frame"` set each child's `parentId` to the frame id
      (assert via snapshot). Browser renders them **clipped inside** the frame.

### Drawing shapes  *(assert decoded geometry, not "it renders")*
- [ ] **AC4 — Create a line (≥3 non-collinear points, vertex order preserved).** `canvas shape create
      line --points '[[0,0],[120,60],[200,0]]'` → `{ok,id}`. Read back `props.points`, sort by `index`,
      and the ordered vertices equal the input sequence (±1px). `--spline cubic` sets `spline:'cubic'`.
      `--points '[[0,0]]'` (<2 points) → **400**, no record written.
- [ ] **AC5 — Create freehand draw (decoded points == input).** `canvas shape create draw --points
      '[[0,0],[40,10],[80,60]]'` → `{ok,id}`. Decode `props.segments` (base64) and the resulting point
      set equals the input (±1px per axis) — a single-point/degenerate blob **fails** even though `put`
      returned 200. `--closed` sets `isClosed:true`. Missing/empty `--points` → **400**.
- [ ] **AC6 — Create highlighter (decoded points == input).** `canvas shape create highlight --points
      '[[0,0],[120,0]]'` → `{ok,id}`; decoded segment points equal input (±1px); record has the highlight
      prop set (no `fill`/`dash`/`isClosed`) and validates.
- [ ] **AC7 — Bounds land where asked.** For AC4–AC6, `getShapePageBounds(id)` width & height equal the
      input points' bounding-box extent (±2px) and the top-left page-point equals the input origin (±1px).
      Reject if any extent <2px (collapsed) or origin >10px off (flung).

### Reparent & riders (update)  *(numeric page-point round-trip, not eyeball)*
- [ ] **AC8 — Reparent INTO a frame, no jump.** Record page-point P (`getShapePageBounds` top-left)
      before. `canvas shape update <id> --frame "Test frame"` → `parentId` == frame id, new page-point ==
      P (±1px each axis), and the new `index` sorts **at/above** the frame's existing children (valid,
      unique). Browser: clips inside, doesn't move. *(Rotated-parent affine is out of scope — see AC22;
      assert only for an unrotated frame.)*
- [ ] **AC9 — Reparent OUT to the (correct) page.** `canvas shape update <id> --to-page` sets `parentId`
      to the frame's **actual** page id (not a hardcoded first page), page-point unchanged (±1px).
- [ ] **AC10 — Rotate & lock riders (exact, persist).** `--rotate 0.5` → `record.rotation === 0.5`
      exactly; `--lock` → `record.isLocked === true`. Both survive a reload (re-read snapshot). Invalid
      `--rotate` (non-numeric / NaN / Infinity) → **400**.

### Delete semantics
- [ ] **AC11 — Delete a frame KEEPS its children (default), on the right page, unmoved.** Frame with 2
      stickies; record each sticky's page-point. `canvas shape delete <frameId>` → frame gone; both
      stickies present with `parentId` == the frame's **actual page** id (not `page:page`) and page-point
      unchanged (±1px); both enumerable/visible on that page. No dangling `parentId` anywhere.
- [ ] **AC12 — `--with-children` cascades children AND their bindings.** Same setup plus an arrow
      **outside** the frame bound to a sticky **inside** it. `canvas shape delete <frameId>
      --with-children` → frame + both stickies gone AND every binding whose `fromId`/`toId` was any
      removed shape is gone; no binding in the store references a deleted id.
- [ ] **AC13 — Nested-frame delete moves only DIRECT children.** Frame A ⊃ frame B ⊃ sticky.
      `delete A` (default) → A gone; B reparented to A's page (page-point unchanged); **B's sticky stays
      under B** (unmoved). `delete A --with-children` → A, B, and B's sticky all gone.
- [ ] **AC14 — Non-frame delete unchanged (regression).** Deleting a geo/line/draw/arrow by id removes
      just that shape (+ bindings touching it), exactly as before.

### Read symmetry (NEW — canvas frame / frames surface drawings)
- [ ] **AC15 — `canvas frame <name>` lists drawings.** After creating a line, a freehand draw, and a
      geo into "Test frame", `canvas frame "Test frame"` returns them in a `drawings` array (each with
      `id`, `type` ∈ {geo,line,draw,highlight}, and `text` where the shape has a label), alongside the
      existing notes/texts/images/terminals/iframes.
- [ ] **AC16 — `canvas frames` counts drawings.** The same frame's row includes a `drawings` (or
      per-type) count that reflects the created shapes; counts move when a drawing is added/removed.
- [ ] **AC17 — Read reflects reparent/delete.** After AC8 the reparented shape appears under its new
      frame in `canvas frame`; after AC11 the surviving stickies no longer appear under the deleted
      frame. Read verbs and the store agree.

### CRUD-completeness, errors, scope, attribution
- [ ] **AC18 — Frame CRUD is genuinely complete (symmetric).** For an agent-made frame: create (AC1),
      read (AC15/AC16 — including its drawings), update/rename (`canvas shape update <id> --props
      '{"name":"Renamed"}'` reflected in `canvas frames`), delete (AC11/AC13). No write-only or read-only
      orphan remains. An invalid rename (`--props '{"name":123}'`) → **400**, not 500.
- [ ] **AC19 — Bad-input matrix returns clean 4xx (never 500 / never silent success).** Each writes no
      record: line/draw points `[[0]]`, `[["a",0]]`, `[]`, duplicate-consecutive, NaN/Infinity, huge
      (1e12) → **400**; reparent to a non-existent `--frame` → **404**; invalid `--color` → **400**.
- [ ] **AC20 — Excluded scope stays UNBUILT (types, ops, AND flags).** Read from `GET /api/tools`: the
      shape tool's `op` enum is exactly `create|update|delete` and its create `type` enum is exactly
      `geo|text|note|arrow|frame|line|draw|highlight` — nothing more, nothing less. No flag/verb named
      `align|group|eraser|laser|image` exists. `canvas shape create group` (and `…image`, `…eraser`) →
      **400** (type not in enum).
- [ ] **AC21 — Agent attribution is consistent & objective.** On a credentialed instance, frame/line/
      draw/highlight records have `meta.author === <resolved caller>`; on an anonymous instance with
      `--author X`, `meta.author === X`; with no author context, `meta === {}`. None of the four
      throws/500s for lacking richText. Text-bearing shapes (note/geo/text) still get the 🤖 badge.
- [ ] **AC22 — Documented limitation (rotated-parent reparent).** Reparent's coordinate translation is
      correct for **unrotated** parents; reparenting into/out of a **rotated** frame is explicitly out of
      scope for this slice (server has no rotation-aware page math). This AC passes when the limitation is
      recorded (README/help/limitation note) rather than silently wrong — no affine transform is claimed.

### End-to-end usability
- [ ] **AC23 — Compose a framed drawing end-to-end, then read & delete it.** One CLI session: create a
      frame; create a line + freehand draw + sticky inside it (`--frame`); reparent a pre-existing page
      shape in; `canvas frame "…"` returns the frame with all of it (via AC15's `drawings` + notes); a
      human sees a coherent, correctly-clipped frame in the browser. Then `delete` the frame (default) and
      the contents survive on the page (AC11).

## Evidence
Per line: PASS/FAIL + the CLI command & its JSON response + a **numeric store observation**
(`window.__ewEditor.getSnapshot()` record with the asserted `type`/`props`/`parentId`/`index`/
`rotation`; decoded `props.segments`/`props.points`; `GET /api/canvas/frame(s)` payload) + a browser
screenshot for the human-visible ACs (AC1, AC3, AC8, AC23). Driven live against `bin/dev up`.

*(This checklist was hardened by a fresh-context adversarial AC critique — the "fake-ship" review that
turned every "it renders" into a numeric decoded-record assertion, added nested-frame / binding /
multi-page / z-index / vertex-order coverage, and caught the read-side asymmetry now closed by
AC15–AC17.)*
