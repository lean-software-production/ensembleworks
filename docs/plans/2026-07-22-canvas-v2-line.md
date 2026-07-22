# Canvas v2 — full-parity LINE (multi-point / spline) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 a first-class **line** shape with tldraw-parity data
fidelity — a multi-point line/polyline whose points are typed and validated,
rendered as a styled stroked path in either **straight** (`spline:'line'`) or
**smooth cubic** (`spline:'cubic'`) form, drawable via a Line tool, and
round-tripping real synced v1 line shapes — plus the browser contract that pins
tool→doc creation.

**Architecture:** Four clean-room layers plus wiring. (1) The `line` shape's
props schema gets **typed permissively** in `canvas-model/src/shape.ts` — a
**keyed-map** `points` (`{ [id]: { id, index, x, y } }`, matching the installed
tldraw schema exactly so synced v1 lines validate), plus `spline` and the
`color/dash/size` style axes. (2) A **pure, deterministic** geometry module,
`canvas-model/src/line-geometry.ts`, turns the ordered handle set into an SVG
path — a straight `M…L…` polyline or a Catmull-Rom→cubic-bezier smooth curve.
(3) A **`LineShape` body** in `canvas-react` renders it as a **stroked** path
(`fill:none`, `stroke=color`), reusing GeoShape's exported color/size/dash
tables exactly as the arrow overlay does. (4) A **line tool FSM**,
`canvas-editor/src/tools/line.ts`, is a 2-point drag (down = start handle,
drag = live end, up = finalize) that writes a normalized 2-handle line and
auto-selects it. (5) The toolbar/tool-loop gain a **Line button**; a **browser
interaction contract** pins that dragging the Line tool creates a `line` shape.

**Tech stack:** TypeScript pure-FSM editor, Zod (`validateShape` in
`canvas-model`), React 18 (client), Bun test runner, Playwright (browser
contract), `@ensembleworks/interaction-contracts`.

**Scope (decided — see Decisions):** full parity in the **model + renderer** —
N points, BOTH spline modes, color/dash/size styling, and validation/round-trip
of real synced v1 lines; an **MVP 2-point-drag creation gesture** in the tool
(the schema + renderer already carry the full N-point/spline surface, so the
richer gestures are pure tool add-ons). **Out of this cycle (deferred, flagged
to owner):** multi-point creation (click-to-add-handles), post-creation handle
editing/dragging, and arming `spline:'cubic'` from the style panel (the renderer
paints cubic for any synced/authored cubic line; our tool writes straight lines
this cycle). Same posture the draw sub-cycle took with multi-segment strokes.

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These are the exact rules the draw sub-cycle (`docs/plans/2026-07-22-canvas-v2-draw.md`)
was governed by; they were violated repeatedly earlier on this branch (~15 false
factual claims, several fake REDs, one filtered-sign-off regression). Read every
line before writing any code.

### Test runner (this is where people lose hours)
- **`bun test` is NOT our runner. NEVER run it.** It ignores our harness.
  - Full suite: `bun run test`
  - One file: `~/.bun/bin/bun <path/to/file.test.ts>`
  - One package's suite: `cd <pkg> && bun test.ts` (the package's own entry)
  - Always `export PATH="$HOME/.bun/bin:$PATH"` first.
- **Both runners are FAIL-FAST** — `process.exit(1)` on the first failing file.
  Neither prints "N passed, 1 failed." **Judge pass/fail by the EXIT CODE, not
  the output tail.**
- **`$?` in a compound command is the LAST command's status, not the suite's.**
  Run the suite as its own command, then read `$?` **bare on its own line**
  (zsh has no bash `PIPESTATUS`; `suite | tail` leaves `$?` = tail's status),
  or redirect suite output to a file and check `$?`. This exact mistake was made
  on this branch.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — line sub-cycle; governing contract
  line-creates-a-line-shape lands with this sub-cycle (see plan)'` before
  `bun run test` on any task whose diff touches a **gated path**
  (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`) but
  not the contracts module. Once **K** (which touches `interaction-contracts/`)
  is in the working tree, the gate passes on the sub-cycle's combined diff.
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every command
  block. Agent bash cwd resets between calls.
- `bun run typecheck` catches TS issues the single-file bun runner misses — run
  it after any signature/union change (the `ToolId` union, the schema, the
  registry ripple across workspaces).
- Browser contract runs: `cd e2e && bunx playwright test --project=e2e -g <name>`.

### FULL E2E SIGN-OFF (bake this in — a filtered sign-off already slipped a bug)
- The sub-cycle sign-off MUST run the **FULL** e2e suite —
  `cd e2e && bunx playwright test --project=e2e` — **not** a `-g`-filtered subset.
  A StylePanel regression slipped a filtered sign-off in an earlier step and was
  only caught later. Per-task, filter for speed; for the sub-cycle's final green,
  run the whole e2e project plus the whole `bun run test` suite plus
  `bun run typecheck`. Redirect e2e output to a file and read `$?` on its own
  line (see the runner rules above).

### RED-first discipline (TDD is mandatory, every task)
1. Write the failing test. **RUN it. Capture the VERBATIM failure** into the
   task's commit message / execution note. An assertion already true at the
   parent commit proves nothing.
2. **A missing or renamed import throws at module-load and manufactures a FAKE,
   green-looking RED** (the module never runs, so "it failed" tells you nothing
   about your assertion). Caught repeatedly on this branch. After writing a RED
   test, confirm the failure is your *assertion* failing — not `SyntaxError` /
   `Cannot find name` / `is not a function` / Playwright `locator … not found` /
   `boundingBox() … null` / `undefined is not an object`. If it is a load/lookup
   error, the RED is fake: add a stub export first so the test *runs* and the
   *assertion* is what fails.
3. Where a test pins a choice, name the wrong implementations it kills (a
   **mutant table** — each row: a plausible wrong impl → the assertion that
   catches it). **Each mutant row must genuinely DISCRIMINATE — RUN the test
   against that wrong impl if you are not certain it fails.** This is the single
   most repeated lesson from the draw sub-cycle: first-pass mutant tables
   shipped rows that did NOT discriminate — draw's geometry tasks (G1–G3) found
   **2** escaping mutants, its tool task (T1) found **4**, its renderer (R1)
   found **1**, all only because the implementer actually ran each mutant. Do
   the same here: every non-trivial task below ships a mutant table, and you
   run each row.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). Forbidden (verified against the test):
  imports of `loro-crdt`, `ws`, `@tldraw/`, `react`, `canvas-sync`,
  `@ensembleworks/canvas-sync`; `from '../server'`; and the literals
  `document.`, `window.`, `Date.now(`, `Math.random(`. The line tool's id-mint
  uses `editor.random`, never `Math.random(` (the scan fails the literal even
  in a comment). The guard does NOT check `express`/`navigator` substrings —
  don't chase those in ordinary words.
- **`canvas-model` has NO boundary test** (only `canvas-editor` scans text).
  `canvas-model/src/line-geometry.ts` is still pure **by construction**: no DOM,
  no clock, no PRNG, no I/O — a pure function of its point/spline inputs. Do not
  reach for `Math.random`/`Date.now` there either; the spline math is fully
  deterministic without them.
- `canvas-react` and `client` MAY touch the DOM (the renderer + the toolbar).

### Interaction contracts (CLAUDE.md — mandatory; carry into EVERY gated brief)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan the **gated** tasks are **T1** (`tools/
  line.ts`), **R1** (`canvas-react/src/shapes/LineShape.tsx`), and **W1**
  (`client/src/canvas-v2/…`). The pure model/geometry tasks (M1, G1) and the
  contract (K, `interaction-contracts` + `e2e`) are **not** under a gated
  prefix. Satisfy the gate for the sub-cycle by landing **K** (the real
  contract); until then, gated tasks carry the `UX_CONTRACT_PR_BODY` opt-out
  above.
- **No new Obs.** The `shapeKind(id): string | null` Obs already landed with the
  draw sub-cycle and is implemented for real in BOTH adapters — verified:
  `canvas-editor/src/contracts/fsm-runner.ts` (a `shapeKind(id)` method) and
  `e2e/lib/contracts.ts` (a `kinds` field on the sample, `shapeKind: (id) =>
  sample.kinds[id] ?? null`, sampled over the `styleIds` union which already
  includes selection). K reuses it verbatim. `shapeCount`/`selectedShapeIds`
  also already exist in both adapters. **This sub-cycle adds no `Obs` method** —
  if you find yourself editing `interaction-contracts/src/types.ts`'s `Obs`
  interface, STOP: the reuse is the whole point.
- **The line tool is a tool FSM** (like draw/arrow), so K is
  **`level: 'browser'`**: it must click the real toolbar Line button (the FSM
  runner only drives `select` / `select+transform`, see `Contract.tool` — there
  is no FSM-runner path for a `line` ToolId). The tool's own FSM behavior is
  pinned by unit tests in **T1**; K is the end-to-end browser proof.
- **Obligations 2 & 4 (RED, reviewer-verified):** K runs RED against an inert
  predecessor and the reviewer independently reproduces red→green (revert, see
  the failure, restore) — never accept the implementer's report. K's exact RED
  handle is named in its task (revert W1's toolset `line` entry to a no-op — the
  Line button stays present so the `element` anchor still resolves and
  `shapeCount()` stays 0: a clean assertion RED, never a locator error).

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught ~15 false factual claims; the dominant
  failure mode is confident *quantitative / locational* claims. **Prefer wording
  that cannot rot** — describe by argument/behavior, not raw line numbers.

---

## Decisions (settled — do not re-litigate)

### D-1. The line points model (schema permissiveness) — Task M1
`line`'s props schema is EMPTY today (`line: z.looseObject({})` — verified,
`shape.ts`), so it accepts **everything** (our shapes AND v1 shapes already
validate — an empty `looseObject` drops nothing). The risk is the *opposite* of
the COLOR-enum cycle: typing too **strictly** would start dropping synced v1
line shapes at the write boundary.

**VERIFIED against the installed dependency** (`node_modules/@tldraw/tlschema/
src/shapes/TLLineShape.ts`, do NOT import it — clean-room): the current line
schema is
```
color: DefaultColorStyle,  dash: DefaultDashStyle,  size: DefaultSizeStyle,
spline: enum(['cubic','line']) default 'line',
points: T.dict(T.string, { id: string, index: indexKey, x: number, y: number }),
scale: nonZeroNumber
```
i.e. **`points` is a KEYED MAP** `{ [id]: { id, index, x, y } }`, **not an
array**. (The migration history in that file confirms it: handles → points
array → keyed dict; the installed version 5.1.0 is at the keyed-dict stage.)
**This means: if we type `points` as `z.array(...)`, every real synced v1 line
is DROPPED at the write boundary** — the exact failure mode this task exists to
avoid. Decision — type it **permissively, matching v1's keyed-map shape**:

```ts
// A line handle/point: v1 stores a KEYED MAP { [id]: { id, index, x, y } }
// (verified against @tldraw/tlschema's TLLineShape.ts — points: T.dict(...)).
// LOOSE so extra keys ride through; x/y REQUIRED numbers so a malformed point
// (missing/non-number coord) is caught; id/index OPTIONAL strings (present on
// real v1; our own tool writes them, the renderer tolerates their absence).
const linePoint = z.looseObject({
  x: z.number(), y: z.number(),
  id: z.string().optional(), index: z.string().optional(),
})
// line props: points as a KEYED MAP (z.record) — NOT z.array (which would drop
// every real synced v1 line, which carries the dict form) — plus spline
// (line|cubic) + the three style axes tldraw line carries (color/dash/size) +
// our own w/h (see the coordinate note). Everything optional; looseObject so
// v1's scale/etc ride through untouched.
line: z.looseObject({
  points: z.record(z.string(), linePoint).optional(),
  spline: z.enum(['line', 'cubic']).optional(),
})
  .extend(box.shape)                                 // w?/h?
  .extend(styleProps('color', 'dash', 'size').shape),
```

- **Keyed map, not an array** — match tldraw's `points: dict` verbatim so a
  synced v1 line validates against exactly the field it carries, and OUR tool
  writes the SAME keyed-map format (one format → one renderer path handles both,
  unlike draw where v1's base64 `path` diverged and had to be deferred). The
  renderer sorts the map's values by `index` and reads x/y.
- **`spline` is typed as a line-LOCAL field**, NOT added to `STYLE_ENUMS`.
  Rationale in D-5's judgment call: keeping it local avoids rippling a new key
  into `STYLE_VALUE_SETS` (which the client style panel consumes) as an
  unplanned side effect this cycle. It IS a closed enum here, so a bad `spline`
  value is still rejected.
- **`line` is NOT added to `TEXT_CAPABLE_KINDS`** (it stays a structural kind —
  no text body; it's already excluded there, see that list's comment). No change
  to that allowlist.
- **Coordinate convention (load-bearing, reuse draw's exact approach):** OUR
  line tool **normalizes** — `shape.x/y` = the point-cloud's min corner, each
  stored handle is relative to that min (v1's own convention: "X/Y relative to
  the line shape's origin"), and it writes `props.w/h` = the point bbox size.
  This makes `localBounds` exact for our lines with **no geometry.ts change**
  (`size()`'s generic branch reads `props.w/h`; `line` has no `DEFAULTS` entry,
  so absent `w/h` → 100×100). **Synced v1** lines carry no `w/h` → a loose
  100×100 selection/cull box, but the **body still paints the true path** via
  `overflow:visible` (D-4). Tight bounds for v1 lines = the same documented
  follow-up draw already carries, not this cycle.

### D-2. The spline geometry (faithfulness + location) — Task G1
A single **pure, deterministic** module `canvas-model/src/line-geometry.ts`
(sitting with the other pure geometry — `geometry.ts`, `arrow-route.ts`,
`draw-geometry.ts`; canvas-model imports nothing but `zod` and its own types).
The renderer (canvas-react) imports it. Far simpler than draw's freehand — one
small function:

```ts
export function linePathData(points: readonly { x: number; y: number }[], spline: 'line' | 'cubic'): string
```

- **`spline:'line'`** — a straight polyline: `M x0 y0 L x1 y1 L x2 y2 …` through
  the points in order. No `Z` (a line is open, not closed).
- **`spline:'cubic'`** — a smooth curve THROUGH the points via **Catmull-Rom →
  cubic bezier** (the standard pure conversion): for each segment `p[i]→p[i+1]`,
  control points `cp1 = p[i] + (p[i+1]-p[i-1])/6`, `cp2 = p[i+1] -
  (p[i+2]-p[i])/6`, with endpoints duplicated (`p[-1]=p[0]`, `p[n]=p[n-1]`) so
  the curve passes through the first and last handle. Emit
  `M p0 C cp1 cp2 p1 C … pn`. Deterministic; coincident points make `cp = point`
  (no division), so no NaN.
- **Degenerate inputs:** `points.length === 0` → `''`; `points.length === 1` →
  `''` (a single handle has no visible segment — MVP simplification, matching
  "need ≥2 handles to draw a line"; a synced v1 line always has ≥2). Never
  throws.

**Pixel-exact match to tldraw's own line renderer is neither testable nor
required** (its renderer is under the forbidden `@tldraw/` boundary). Property
tests pin the invariants instead (see G1).

### D-3. The renderer — Task R1 (BODY, not overlay)
**Decision: a `LineShape` BODY component** (`canvas-react/src/shapes/
LineShape.tsx`), registered in `registerCoreShapes.ts` (replacing `line`'s
current `BoxShape` fallback) — **not** an overlay.

**Why a body, not an overlay (the arrow contrast):** the arrow lives in the
overlay (`Arrows.tsx`) for ONE reason — `routeArrow` performs a **cross-shape
read** (a bound arrow's geometry depends on some OTHER shape's current
position), which `ShapeBody`'s per-shape content-memo model is explicitly not
built for (see `Arrows.tsx`'s module header). **A line has NO cross-shape
reads** — its geometry is a pure function of its OWN `props.points`. So the
memo model fits perfectly, and a body is the simpler, correct home — the same
call `DrawShape` made (also a multi-point SVG path, also a body). The renderer
stays logic-free (CLAUDE.md: canvas-react "holds no editor logic") because the
spline math lives in canvas-model (D-2).

Per-render:
- Flatten `props.points`: read the keyed map (object) → take `Object.values` →
  sort by `index` (string compare; fall back to insertion order when `index` is
  absent) → keep `{x,y}` where both are finite numbers. Tolerant of the array
  form too (defensive), mirroring `DrawShape.flattenDrawPoints`.
- `< 2` points → render an empty `<div data-shape-body="line">` (no `<path>`),
  never throwing.
- `d = linePathData(sortedPoints, spline)` where `spline = props.spline ===
  'cubic' ? 'cubic' : 'line'`.
- Render **stroked** (unlike DrawShape's fill):
  `<svg style={{overflow:'visible', position:'absolute', inset:0}}><path d={d}
  fill="none" stroke={strokeColor} strokeWidth={w}
  strokeDasharray={…}/></svg>` at **1:1 local coordinates** (NO scaling
  `viewBox` — points are already in world-unit local space, exactly like
  DrawShape; the WorldLayer applies the camera scale). `overflow:visible` lets a
  stroke overflowing the wrapper box paint (always for a synced v1 line with no
  normalized `w/h`).
- **Styling reuses the SAME exported tables the arrow overlay reuses** — NOT a
  second copy: `GEO_COLORS`/`colorEntry` (color→hex, absent→'black'),
  `STROKE_WIDTH_PX` (size→px, absent→'m'), `dashArray`/`DASH_VALUES`
  (dash→dasharray, `'none'`→no stroke). This is the identical resolution
  `Arrows.tsx`'s `arrowStyle` does; the LineShape's style resolver is closest to
  that, not to DrawShape's fill resolver. A line **IS a stroked path**
  (`stroke=color, fill=none`), confirmed against tldraw (line is a stroked
  spline, not a filled region).
- The body sets `data-shape-body="line"` so tests/contracts can find it. Pure/
  presentational — no `snapshot` read (content-memo friendly).

### D-4. The line tool — Task T1 (GATED)
`createLineTool(ctx: ToolContext): Tool<LineState>`, structurally the **2-point
drag** shape of `arrow.ts` (threshold gate, `pointing → drawing`) but with
`create.ts`'s **auto-select** (so K can discover the created id via
`selectedShapeIds()` — the arrow tool does NOT auto-select, which is why we
follow create/draw here instead):

- **`pointerdown`** (idle): record the down SCREEN point + `t`. **No doc write**
  — threshold gate (a bare click would make a zero-length, useless line;
  abandon with zero writes on a sub-threshold pointerup, exactly like arrow).
  Enter `pointing`.
- **`pointermove`** (pointing): once `crossedThreshold(down, event)` — mint `id`
  (reuse arrow.ts/draw.ts's five-line module-private `makeId`; NOT imported —
  same not-worth-the-coupling rationale those files document), compute `index`
  via `topIndex(ctx, pageId)` (same module-private helper), build a **2-handle
  line** (start = down world point, end = current world point) via the shape
  builder below, and emit `CreateShape` + `SetSelection([id])`. Enter `drawing`
  with `{ id, index, downWorld }`.
- **`pointermove`** (drawing): re-emit **one upserted** `CreateShape` for the
  2-handle line with the updated end point — one commit per move, the same
  per-pointermove cadence create/arrow/draw document.
- **`pointerup`** (drawing): emit the final `CreateShape` + `SetSelection([id])`,
  return to `idle`.

**Shape builder** (pure, deterministic — reuse draw's normalization): given the
two world points `a` (start) `b` (end), compute `minX/minY/maxX/maxY`;
`x=minX, y=minY`; the two handles are stored relative to the min as a **keyed
map**:
```
props.points = {
  a1: { id: 'a1', index: 'a1', x: a.x - minX, y: a.y - minY },
  a2: { id: 'a2', index: 'a2', x: b.x - minX, y: b.y - minY },
}
props.spline = 'line'                 // MVP writes straight (see D-5 judgment call)
props.w = maxX - minX ; props.h = maxY - minY
...whitelisted armed style (color/dash/size via whitelistStyleProps over STYLE_VALUE_SETS)
```
Fixed handle keys `'a1'/'a2'` are deterministic and sufficient for the 2-point
MVP; a future multi-point tool would generate keys via `indexBetween`. Stamp
armed style exactly as create.ts/draw.ts do (`whitelistStyleProps(editor.get().
nextShapeStyle)`, opacity destructured onto the envelope). `spline` is NOT a
STYLE_VALUE_SETS key, so it is written explicitly by the builder, never carried
by the style whitelist.

### D-5. Toolbar + tool wiring — Task W1 (GATED)
- `client/src/canvas-v2/tool-loop.ts`: add `'line'` to the `ToolId` union,
  `line: Tool<LineState>` to `ToolSet`, `line: createLineTool(ctx)` to
  `createToolSet`, `line: tools.line.initialState` to `createInitialToolStates`,
  and import `createLineTool` + `type LineState` from
  `@ensembleworks/canvas-editor`. In `cancelActiveTool`, add a `line` branch to
  the in-flight-delete family: its `'drawing'` state carries `id` (the line is
  already committed to the doc mid-drag, exactly like arrow), so an abandoned
  mid-draw line is deleted via `DeleteShapes([s.id])`.
- `client/src/canvas-v2/CanvasV2App.tsx`: append `{ id: 'line', label: 'Line' }`
  to `TOOL_BUTTONS` (renders `<button data-canvas-v2-tool="line">` — the
  existing attribute, no new selector needed). **No pressure/DOM-normalization
  change** (unlike draw — line has no pressure concept; the existing pointer
  event flow suffices).

### D-6. The contract — Task K (satisfies the gate; NO new Obs)
- **Contract `line-creates-a-line-shape`** (K), `level:'browser'`,
  `when:'at-end'`, empty scene: click the Line button
  (`[data-canvas-v2-tool="line"]` via the `element` anchor — the armed-style /
  draw contract's proven pattern), then down→move(steps)→up over empty canvas
  (a drag that clears the threshold, so a real line is created). `check`:
  `selectedShapeIds()` is exactly one id `lid` (the tool auto-selects on
  finalize), `shapeCount() === 1`, and `shapeKind(lid) === 'line'`. Exact path
  geometry is pinned by G1's pure property tests and R1's renderer test; the
  contract pins the end-to-end tool→doc creation. **Reuses the existing
  `shapeKind` Obs — adds no `Obs` method** (see the interaction-contracts rule
  in READ-THIS).

### Judgment calls surfaced to the owner
1. **MVP 2-point-drag creation; multi-point + handle-editing DEFERRED
   (recommend: accept).** The owner asked for "multi-point line/polyline with
   handles + spline option." The **model + renderer deliver full parity** (N
   points, both splines, styling, v1 round-trip); the **tool** ships a 2-point
   drag this cycle. Multi-point *creation* (click-to-add-handles) and
   *post-creation handle editing/dragging* are substantial separate interaction
   surfaces (the latter needs handle hit-testing + a handle-drag FSM in the
   select/transform layer, with its own contracts) — the schema already supports
   them, so they add later without touching model/renderer. **OK to ship 2-point
   creation now and defer richer gestures?** (recommend yes — mirrors draw's
   multi-segment deferral; delivers the shape's full data fidelity immediately.)
2. **`spline:'cubic'` renders but our tool writes only `'line'` this cycle
   (recommend: accept).** The renderer paints cubic for any synced/authored
   cubic line (full parity), but the MVP tool writes straight lines. Arming
   `cubic` from the style panel is deferred with (1). **OK?** (recommend yes.)
3. **`spline` as a line-LOCAL schema field, NOT a global `STYLE_ENUMS` axis
   (recommend: local).** tldraw models spline as a `StyleProp`, but adding it to
   `STYLE_ENUMS` would inject a `spline` key into `STYLE_VALUE_SETS`, which the
   client style panel (`client/src/canvas-v2/style-axes.ts`) consumes — an
   unplanned panel change this cycle. Typing it as a closed-enum line-local
   field keeps the change contained while still rejecting bad values. **OK to
   keep spline line-local (revisit if/when spline-arming lands)?** (recommend
   yes.)
4. **Write `props.w/h` on our lines for tight bounds (recommend: yes, matches
   draw).** tldraw line has no `w/h`; writing it is an extra passthrough key
   (rides through `looseObject`, same as draw already ships). It buys exact
   `localBounds` for our lines; v1 lines keep the loose 100×100 box (deferred,
   documented — same as draw). **OK to write `w/h`?** (recommend yes — tight
   bounds + consistency with draw; low risk.)

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| M1 | `line` props schema (keyed-map points + spline + color/dash/size, permissive) | canvas-model (no) | — | bad-color / bad-spline / malformed-point line wrongly validates; array-typed points drops a v1 keyed-map line |
| G1 | `linePathData` (straight polyline + cubic Catmull-Rom spline) | canvas-model (no) | — | empty→`''`; cubic emits no `C`; non-deterministic path |
| R1 | `LineShape` body (stroked, both splines) + registry | canvas-react (**YES**) | M1, G1 | line renders BoxShape fallback, no path |
| T1 | line tool FSM `tools/line.ts` (2-point drag, threshold gate, auto-select, normalize) | canvas-editor (**tools/ = YES**) | M1 | drag emits no line-kind CreateShape; no auto-select; not normalized |
| W1 | toolbar + tool-loop wiring | client/canvas-v2 (**YES**) | T1 | no Line button / line tool unrouted / cancel leaks in-flight line |
| K | browser contract `line-creates-a-line-shape` | interaction-contracts + e2e (satisfies gate) | R1, W1 | Line button inert → no line shape created |

Land **W1 before K** (the Line button must render so K's `element` anchor
resolves — otherwise K's RED is a fake locator error). R1 and W1 are independent
of each other. T1/R1/W1 are gated: run their suites with the
`UX_CONTRACT_PR_BODY` opt-out until K lands. **No H task** — `shapeKind` already
exists in both adapters (reused).

---

## Task M1 — `line` props schema (canvas-model, pure)

**Files:**
- Modify: `canvas-model/src/shape.ts` (the `line:` entry in `propsByKind`; add
  the `linePoint` loose object near the other prop fragments like `drawPoint`)
- Test: `canvas-model/src/shape.test.ts` (the existing schema test file)

Replace `line: z.looseObject({})` with the D-1 schema. Add `linePoint` beside
`drawPoint`/`drawSegment`; compose `color/dash/size` via
`styleProps('color','dash','size')` and `box.shape` exactly like `geo`/`draw`.

**Step 1 — RED test.** Add these assertions to `shape.test.ts`:
- `validateShape(v1Line)` where `v1Line.props = { points: { a1: {id:'a1',
  index:'a1', x:0, y:0}, a2: {id:'a2', index:'a2', x:100, y:50} }, color:'blue',
  dash:'solid', size:'m', spline:'line', scale:1 }` → **`ok: true`** (the
  permissiveness guard; passes today too — this is the guard, not the RED, and
  it's what the "type points as array" mutant breaks).
- `validateShape(badColorLine)` (same but `color:'chartreuse'`) → **`ok:false`**
  — **RED** (empty `looseObject` returns `ok:true` today).
- `validateShape(badSplineLine)` (`spline:'wiggly'`) → **`ok:false`** — **RED**.
- `validateShape(malformedPointLine)` (`points: { a1: { x: 0 } }` — missing `y`,
  or `y:'nope'`) → **`ok:false`** — **RED**.

Run `~/.bun/bin/bun canvas-model/src/shape.test.ts`; confirm the RED is the
*value/structure assertion* failing (`ok:true` where `ok:false` expected), not a
load error.

**Mutant table (RUN each — draw's M1 lesson):**
| Wrong impl | Killed by |
|---|---|
| Leave `looseObject({})` | bad-color, bad-spline, malformed-point all wrongly `ok:true` |
| Type `points` as `z.array(linePoint)` | **v1 keyed-map line wrongly `ok:false`** (the drop-risk this task exists to prevent) |
| Type `color` as `z.string()` not the enum | bad-color `'chartreuse'` wrongly `ok:true` |
| Type `spline` as `z.string()` not the enum | bad-spline `'wiggly'` wrongly `ok:true` |
| Type `linePoint` as `z.any()` / omit x/y | malformed-point wrongly `ok:true` |
| Make `points` or `spline` REQUIRED | a v1 line lacking one wrongly dropped (regression) |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): type the line shape's keyed-map points + spline + style axes, permissively`).

---

## Task G1 — `linePathData` (canvas-model, pure)

**Files:**
- Create: `canvas-model/src/line-geometry.ts`
- Test: `canvas-model/src/line-geometry.test.ts`
- Modify: `canvas-model/src/index.ts` (export the new surface)

Implement `linePathData(points, spline)` per D-2 (straight polyline;
Catmull-Rom→cubic-bezier smooth spline; `''` for 0/1 points; never throws).

**Step 1 — RED property tests** (`~/.bun/bin/bun
canvas-model/src/line-geometry.test.ts`) — add a **stub export first** so the
RED is your *assertion*, not `linePathData is not a function`:
- `linePathData([], 'line')` → `''`; `linePathData([{x:1,y:2}], 'line')` → `''`.
- straight: `linePathData([{x:0,y:0},{x:10,y:0},{x:10,y:10}], 'line')` starts
  with `M` and contains `L`, contains no `C`.
- cubic: `linePathData(sameThreePoints, 'cubic')` starts with `M` and **contains
  `C`** (the smooth-curve marker) — the key straight-vs-cubic discriminator.
- endpoints: for both splines the path's first coordinate pair is the first
  point and (parse the last coord) the last is the last point — the curve/line
  passes THROUGH the endpoints.
- determinism: two calls with the same input are the identical string.
- no NaN/Infinity in the emitted string for: two identical points, three
  collinear points, a 2-point input (cubic's endpoint-duplication path).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Ignore `spline`, always straight | cubic contains-`C` assertion |
| Emit `L` segments for cubic too | cubic contains-`C` assertion |
| Curve that doesn't hit endpoints (wrong Catmull-Rom tangents) | endpoints-through assertion |
| Throw / `NaN` on `< 2` or identical points | empty→`''` and no-NaN assertions |
| Non-deterministic key/order iteration | determinism assertion |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): linePathData — straight polyline + cubic spline for the line shape`).

---

## Task R1 — `LineShape` body + registry (canvas-react — GATED)

**Files:**
- Create: `canvas-react/src/shapes/LineShape.tsx`
- Modify: `canvas-react/src/shapes/registerCoreShapes.ts` (import +
  `registerShape('line', LineShape)`)
- Test: `canvas-react/src/shapes/line-shape.test.ts`

Per D-3: a `flattenLinePoints(shape)` helper (keyed-map → `Object.values` →
sort by `index` → finite-`{x,y}` guard, tolerant of the array form and of
absent `index`), then `linePathData(sorted, spline)`, rendered as a **stroked**
`<path fill="none" stroke=… strokeWidth=… strokeDasharray=…>` inside an
`<svg overflow:visible …>` with NO viewBox (1:1 local, like DrawShape). Reuse
`GEO_COLORS`/`colorEntry`/`STROKE_WIDTH_PX`/`DASH_VALUES`/`dashArray` from
`GeoShape.js` (imported, not re-copied — same as `Arrows.tsx`). Model the style
resolver on `Arrows.tsx`'s `arrowStyle` (stroked), NOT DrawShape's fill.
`< 2` points → an empty `<div data-shape-body="line">` (no path), no throw. Set
`data-shape-body="line"`. Use `renderToStaticMarkup` + `createElement` (no JSX)
like the other `*-shape.test.ts` files, so the test file stays `.test.ts`.

**Step 1 — RED test.** Render a `line` shape with a real 3-point keyed map and
`color:'blue', spline:'line'` and assert:
- output has `[data-shape-body="line"]` (the BoxShape fallback renders a plain
  box body, NOT `line`) — **RED** before registration (registry falls back to
  `BoxShape`; assert via `lookupShapeComponent('line')` and/or the rendered
  attribute, same harness as `draw-shape.test.ts`).
- a `<path>` with a non-empty `d` starting `M` is present.
- the path has `stroke` = `GEO_COLORS['blue'].solid` and `fill="none"` (a line
  is stroked, not filled — this kills the "copied DrawShape's fill" mutant).
- a `spline:'cubic'` variant's path `d` contains `C`.
Confirm the RED is the missing-`line`-body assertion, not a render/import crash.

**Mutant table (RUN each — draw's R1 found an escaper):**
| Wrong impl | Killed by |
|---|---|
| Forget to register `line` | `[data-shape-body="line"]` absent (BoxShape) |
| Fill the path (`fill=color`, copied from DrawShape) | `fill="none"` / `stroke=color` assertion |
| Ignore `spline`, always straight | cubic-variant contains-`C` assertion |
| Scaling `viewBox` like GeoShape | a known local point maps 1:1 (coord assertion) |
| `< 2` points crashes | empty/one-point line renders `[data-shape-body="line"]` with no path, no throw |

**ux-contract:** GATED (`canvas-react/src/`). Opt-out (`UX_CONTRACT_PR_BODY`)
until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-react): LineShape body renders straight + cubic styled lines`).

---

## Task T1 — line tool FSM (canvas-editor — tools/ GATED)

**Files:**
- Create: `canvas-editor/src/tools/line.ts` — **GATED** (`tools/`)
- Test: `canvas-editor/src/tools/line.test.ts`
- Modify: `canvas-editor/src/index.ts` (`export * from './tools/line.js'`)

`createLineTool(ctx): Tool<LineState>`, FSM `idle → pointing → drawing`, per
D-4. Reuse the module-private `makeId`/`topIndex` helpers (reimplement inline as
arrow.ts/draw.ts each do — NOT imported), `crossedThreshold`, `screenToWorld`,
and `whitelistStyleProps` over `STYLE_VALUE_SETS`. The shape builder writes the
2-handle keyed-map `points`, `spline:'line'`, normalized `x/y` + relative
handles + `w/h`, and the whitelisted armed style. Auto-select via
`SetSelection([id])` on the create emission AND on finalize (so K can discover
the id).

**Step 1 — RED tests** (fake `Editor`/`ToolContext` + `script()`; run
`~/.bun/bin/bun canvas-editor/src/tools/line.test.ts`; add a stub export first
so the RED is the assertion, not a load error):
- a `down → move(cross threshold) → move → up` script yields intents whose net
  effect creates **one shape of kind `'line'`** with exactly **two** handles in
  `props.points` (start + current end; the intermediate move upserts the same
  id). RED before the tool exists → after stub, RED is the kind/points
  assertion.
- **auto-select:** the drawing shape's id appears in a `SetSelection` intent
  (both on the pointing→drawing transition and on pointerup) — pins the
  divergence from arrow (which does NOT auto-select).
- **threshold gate:** a bare `down → up` (no move) creates **no shape** and
  emits **zero** doc-write intents (a sub-threshold click is not a line) — pins
  the arrow-style gate (kills a draw-style "commit on pointerdown" mutant).
- **normalization/determinism:** the same script twice → deep-equal shapes; the
  two handles are stored `>= 0` relative to the min corner, `props.w/h` equal
  the 2-point bbox, and `shape.x/y` = the min corner.
- **z-order:** with a pre-existing sibling of index `'a5'`, the line's
  `index > 'a5'` (reuses `topIndex`, computed once).
- run `~/.bun/bin/bun canvas-editor/src/boundary.test.ts` — clean-room still
  holds (no `Math.random(`/`@tldraw/`; id-mint uses `editor.random`).

**Mutant table (RUN each — draw's T1 found FOUR escapers; be ruthless):**
| Wrong impl | Killed by |
|---|---|
| Commit on pointerdown (no threshold gate, draw-style) | bare-click-creates-nothing assertion |
| No `SetSelection` (arrow-style) | auto-select assertion → K would have no id to find |
| Don't normalize (store raw world handles) | handles-≥0 / bbox `w/h` / `x/y`=min assertion |
| Recompute `topIndex` per move | non-deterministic index / z-order churn |
| Write `points` as an array not a keyed map | schema-shape / M1-consistency assertion (points is a map) |
| Overwrite the start handle on each move (1 handle) | exactly-two-handles assertion |
| Mint a new `id` per move | one-shape / deep-equal-determinism assertion |

**ux-contract:** GATED (`tools/line.ts`). Run this task's full suite with the
`UX_CONTRACT_PR_BODY` opt-out until K lands.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-editor): 2-point line tool FSM`).

---

## Task W1 — toolbar + tool-loop wiring (client/canvas-v2 — GATED)

**Files:**
- Modify: `client/src/canvas-v2/tool-loop.ts` (`ToolId`, `ToolSet`,
  `createToolSet`, `createInitialToolStates`, `cancelActiveTool`, imports)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`TOOL_BUTTONS`)
- Test: `client/src/canvas-v2/tool-loop.test.ts`

Per D-5. Import `createLineTool`, `type LineState` from
`@ensembleworks/canvas-editor`. Wire all five tool-loop sites. `cancelActiveTool`:
add a `line` branch mirroring `draw`/`arrow` (delete the in-flight `id` when the
state is `'drawing'`). Append `{ id: 'line', label: 'Line' }` to `TOOL_BUTTONS`.
No DOM-normalization change.

**Step 1 — RED test** (DOM-free, in `tool-loop.test.ts`):
- `createToolSet(ctx).line` is defined and `createInitialToolStates(tools)` has
  a `line` entry (RED: `ToolSet` has no `line`).
- `dispatchToActiveTool(tools, states, 'line', editor, downEvent)` then a
  threshold-crossing move routes to the line tool and applies a `CreateShape`
  (assert a `line`-kind shape now exists in the fake editor's doc). RED before
  wiring.
- `cancelActiveTool(tools, drawingStates, 'line', editor)` returns a
  `DeleteShapes` intent for the in-flight id (RED: line not in the delete branch
  → the in-flight shape leaks).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Forget `line` in `createToolSet`/states | `tools.line` undefined → dispatch crashes / no shape |
| `cancelActiveTool` omits `line` | leaked-in-flight-line assertion |
| Wire `line` to the wrong factory (e.g. arrow) | created shape's kind ≠ `'line'` |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): wire the Line tool into the toolbar and tool loop`).

---

## Task K — browser contract `line-creates-a-line-shape` (satisfies the gate)

**Files:**
- Create: `interaction-contracts/src/contracts/line-creates-a-line-shape.ts`
- Modify: `interaction-contracts/src/index.ts` (import + append to `CONTRACTS`)

Per D-6. Model it **directly on** `interaction-contracts/src/contracts/
draw-creates-a-draw-shape.ts` (read it — same structure). `level:'browser'`,
`when:'at-end'`, `scene: () => []`. Gesture: click the Line button, then a
threshold-clearing drag on empty canvas well clear of the toolbar/panel:

```ts
const LINE_TOOL_SELECTOR = '[data-canvas-v2-tool="line"]'
gesture: () => [
  { kind: 'down', at: { ref: 'element', selector: LINE_TOOL_SELECTOR } },
  { kind: 'up' },
  { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
  { kind: 'move', at: { ref: 'point', x: 640, y: 600 }, steps: 8 },
  { kind: 'up' },
],
check: (obs) => {
  const ids = obs.selectedShapeIds()
  if (ids.length !== 1) return `expected exactly one shape after drawing a line, got ${JSON.stringify(ids)}`
  if (obs.shapeCount() !== 1) return `expected shapeCount 1 after one line, got ${obs.shapeCount()}`
  const kind = obs.shapeKind(ids[0]!)
  if (kind !== 'line') return `expected the created shape to be kind 'line', got ${JSON.stringify(kind)}`
  return null
},
```
(Reuses the existing `shapeKind` Obs — **no `Obs` change**.)

**RED (Obligation 2/4 — name it precisely):** the genuine, clean RED is reached
by **reverting W1's toolset entry** `line: createLineTool(ctx)` to a no-op (e.g.
`line: tools.hand` or a stub tool) — the Line button **still renders**, so the
`element` anchor resolves and the click succeeds, but dragging produces no shape
→ `shapeCount()` stays 0 and `selectedShapeIds()` stays `[]` → a clean
**assertion** failure ("expected exactly one shape after drawing a line, got
[]"), never a locator error. Capture the **verbatim** RED. The reviewer
independently reverts that same toolset entry, observes the identical RED, and
restores. Run: `cd e2e && bunx playwright test --project=e2e -g
line-creates-a-line-shape`. Commit (`test(contracts): drawing a line creates a
line shape`).

> **Why not point the RED at "the Line button is absent"?** That would make the
> `element` anchor throw `boundingBox() … null` — a FAKE (load/locator) RED that
> proves nothing about the assertion. Reaching the RED through a present-but-inert
> button (W1 toolset revert) is the only clean path, exactly the draw/armed-style
> contract's own RED discipline.

---

## PR body — required content

The sub-cycle is interaction-bearing (`tools/`, `canvas-react/src/`,
`client/src/canvas-v2/`). Because K adds a real contract, the honest form is a
**contract reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `line-creates-a-line-shape`
   (interaction-contracts/src/contracts/line-creates-a-line-shape.ts),
   reusing the existing `Obs.shapeKind` (no Obs change this cycle).
   RED (verbatim, W1 toolset `line` reverted to a no-op): <paste>
   GREEN (after restore): <paste>
   Reviewer reproduced red→green by reverting the toolset `line` entry.
```

If tasks land across multiple PRs, any PR shipping a gated task (T1/R1/W1) ahead
of K carries `ux-contract: none — line sub-cycle; governing contract
line-creates-a-line-shape lands with this sub-cycle (see plan)`.

---

## Sub-cycle sign-off (all three, no shortcuts)

1. `cd /home/stag/src/projects/ensembleworks && bun run typecheck` → exit 0.
2. `UX_CONTRACT_PR_BODY='<the K contract reference>' bun run test` → exit 0 (read
   the exit code on its own line, not a piped tail — zsh has no `PIPESTATUS`).
3. **FULL** e2e (NOT filtered): `cd e2e && bunx playwright test --project=e2e`;
   redirect to a file and read `$?` on its own line → all green. (See READ-THIS:
   a filtered sign-off already slipped a regression.)

---

## Risks & unknowns

1. **BIGGEST RISK — dropping real synced v1 lines by mis-typing `points`.**
   The installed tldraw schema stores line `points` as a **keyed map**, not an
   array (verified against `TLLineShape.ts`). Typing `points` as `z.array` would
   silently DROP every synced v1 line at the write boundary. Mitigation: M1's
   RED includes a full keyed-map v1 line that must stay `ok:true`, and the mutant
   table's "type points as array" row must be RUN to confirm it drops that
   shape. This is the direct analogue of draw's base64-`path` finding — the one
   place to be most careful.
2. **Runner-up — cubic spline endpoints/NaN.** A wrong Catmull-Rom tangent makes
   the curve miss its endpoints or emit `NaN` for coincident points. G1's
   endpoints-through + no-NaN property tests are the guards; if a property is
   unreachable, STOP and report (usually a wrong belief about the formula).
3. **Body-vs-overlay was a real fork.** Chosen: BODY (no cross-shape reads, so
   the ShapeBody memo model fits — the arrow's overlay reason does not apply).
   If a future feature makes a line's geometry depend on ANOTHER shape (e.g.
   line bindings), that decision would need revisiting; not in scope now.
4. **K fake-RED via the `element` anchor.** Reaching K's RED by removing the
   Line button throws a locator error (fake RED). The only clean RED is a
   present-but-inert button (revert W1's toolset entry) — spelled out in K.
5. **`ToolId` / schema union ripples.** The `line` ToolId and the schema change
   trip typecheck across workspaces (tool-loop, both contract adapters already
   have `shapeKind`); `bun run typecheck` is the backstop after M1/T1/W1.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **Confirmed — tldraw line `points` IS a keyed map** `{ [id]: { id, index, x,
  y } }` (the brief's ground truth is CORRECT here; verified against installed
  `@tldraw/tlschema/src/shapes/TLLineShape.ts` `points: T.dict(T.string, …)`).
  This is load-bearing: the schema types `points` as `z.record`, and OUR tool
  writes the same keyed-map form — no divergence/deferral like draw's base64
  `path`. tldraw line ALSO carries `color/dash/size/spline/scale` (no `w/h`;
  we add `w/h` as our own passthrough for tight bounds — judgment call #4).
- **Correction — `line`'s empty schema already accepts v1 shapes.** Like draw,
  `line: z.looseObject({})` is *maximally permissive* today, so no schema change
  is *required* for shapes to validate/sync. M1's value is (a) explicit
  keyed-map point + closed-enum style/spline validation and (b) intent; the
  drop-risk is real only if you over-type (e.g. array `points`), which D-1
  avoids. M1's RED is therefore a *positive* one (a bad-color/bad-spline/
  malformed-point line must now be **rejected**), not "a v1 shape stopped being
  dropped."
- **Correction — `line`'s props entry is at `propsByKind` `line: z.looseObject({})`**
  (the brief said `~shape.ts:193`; the actual line moved — describe it by the
  `line:` key, not a line number).
- **Correction — no geometry.ts change is needed for OUR lines.** `size()`'s
  generic branch reads `props.w/h`, and `line` has no `DEFAULTS` entry, so a
  normalized line writing `w/h` gets exact `localBounds` with zero geometry
  edits; v1 lines (no `w/h`) fall back to 100×100 (documented gap, same as
  draw). Verified in `geometry.ts`.
- **Correction — NO new Obs.** The brief said "confirm no new Obs needed" —
  confirmed: `shapeKind(id)` already exists for real in BOTH adapters
  (`canvas-editor/src/contracts/fsm-runner.ts` + `e2e/lib/contracts.ts`'s
  `kinds` sample over the `styleIds`/selection union), landed with the draw
  sub-cycle. K reuses it; there is **no H task**.
- **Correction — the line tool must AUTO-SELECT** (unlike arrow, which does
  not). Verified `arrow.ts` emits no `SetSelection`; `create.ts`/`draw.ts` do.
  K discovers the created id via `selectedShapeIds()`, so T1 follows create/draw
  and emits `SetSelection([id])` on create + finalize.
- **Confirmed accurate:** `line` is in `SHAPE_KINDS` (`shape.ts`) with empty
  props and is a structural (non-text) kind; there is no line tool in
  `canvas-editor/src/tools/` and no `line` `ToolId`/button; `line` renders via
  the `BoxShape` fallback (`lookupShapeComponent` → `?? BoxShape`);
  `GEO_COLORS`/`colorEntry`/`STROKE_WIDTH_PX`/`DASH_VALUES`/`dashArray` are
  exported from `GeoShape.tsx` and already reused by `Arrows.tsx`; the toolbar
  renders `data-canvas-v2-tool={btn.id}` (so K's selector is
  `[data-canvas-v2-tool="line"]`, no new attribute); `makeId`/`topIndex`/
  `whitelistStyleProps` are module-private per-tool helpers (arrow.ts + draw.ts
  each reimplement them); `shapeCount`/`selectedShapeIds` exist in both
  adapters.
```
## Execution status — LANDED (2026-07-22)

All 6 tasks landed and reviewed. Convergence + data-loss crux independently
certified (flattenLinePoints orders by (index,id) not key order; keyed-map
schema so synced v1 lines validate; linePathData deterministic + no-NaN).
Sign-off: typecheck green, 232 unit suites green, full e2e 48/48 (exit 0),
line browser contract teeth-verified.

| Task | Commit |
|---|---|
| M1 schema | `c0d4f96` |
| G1 linePathData | `4d6d532` |
| R1 LineShape + flattenLinePoints | `2e81d88` |
| T1 line tool FSM | `9676ef0` |
| W1 toolbar/wiring | `1744d6e` |
| K browser contract | `f2c2204` |

MVP = 2-point straight line; renderer supports cubic spline (reachable via
synced/authored v1 lines); multi-point creation + post-creation handle
editing + arming cubic from the panel are documented deferrals.

**Step 3 (draw + line + arrow-styling) COMPLETE.** Image moved to step 4
(with the asset store it depends on).
