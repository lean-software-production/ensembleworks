# Canvas v2 — Freehand DRAW (pen) full parity (Step 3 sub-cycle) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 a pressure-sensitive freehand **pen** tool with full
tldraw-parity feel — press-drag-release lays down a variable-width ink stroke
(pressure-tapered outline), synced as a first-class `draw` shape that also
round-trips real v1 draw shapes.

**Architecture:** Four clean-room layers plus the wiring. (1) The `draw` shape's
props schema gets **typed permissively** in `canvas-model/src/shape.ts` (a
`segments[].points[{x,y,z}]` list + the `color/fill/dash/size` style axes +
`isPen/isClosed/w/h`) so our own strokes AND synced v1 draw shapes both validate.
(2) A **pure, deterministic freehand geometry** module,
`canvas-model/src/draw-geometry.ts`, reimplements perfect-freehand's outline
algorithm clean-room (input points → smoothed stroke points with running length
→ pressure-modulated variable-width outline polygon → SVG path) — **no
`@tldraw/` import** (tldraw vendors perfect-freehand internally; the clean-room
boundary forbids importing it, so it is reconstructed here and pinned by
property tests). (3) A **pen tool FSM**, `canvas-editor/src/tools/draw.ts`,
accumulates world points (with per-point pressure carried on a new
replay-safe `PointerInputEvent.pressure` field), re-emitting one upserted
`CreateShape` per move, finalizing to a selected draw shape. (4) A **`DrawShape`
body** in `canvas-react` builds the SVG path from the stored points via the pure
geometry, reusing GeoShape's exported color table. (5) The toolbar/tool-loop
gain a **Draw button**; a **browser interaction contract** pins that drawing a
stroke creates a draw shape.

**Tech stack:** TypeScript pure-FSM editor, Zod (`validateShape` in
`canvas-model`), React 18 (client), Bun test runner, Playwright (browser
contract), `@ensembleworks/interaction-contracts`.

**Scope (decided — see Decisions):** a single-segment freehand pen (`type:'free'`);
pressure-sensitive width via a faithful perfect-freehand reimplementation;
real pen pressure when the device provides it, velocity-**simulated** pressure
for mouse (tldraw's own split); color reused from the shared palette. **Out of
this cycle:** straight-line draw segments (Shift-drag `type:'straight'`);
multi-segment strokes (pen-up-pen-down continuation); the `draw`/`highlight`
distinction (highlight kind stays a `BoxShape` fallback, untouched); dash/fill
fidelity on freehand ink (documented simplification — a freehand stroke renders
as a filled outline in its color); a tight selection/cull box for **synced v1**
draw shapes (our own strokes get exact bounds; see Decision 1's v1-bounds note).

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These rules were violated repeatedly on this branch (~15 false factual claims,
several fake REDs, one filtered-sign-off regression). Read every line before
writing any code.

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
  Run the suite as its own command, then `echo $?` on its own line (zsh: read it
  bare, or redirect suite output to a file and check `$?`). This exact mistake
  was made on this branch.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — draw sub-cycle; governing contract
  draw-creates-a-draw-shape lands with this sub-cycle (see plan)'` before
  `bun run test` on any task whose diff touches a **gated path**
  (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`) but
  not the contracts module. Once **K** (which touches `interaction-contracts/`)
  is in the working tree, the gate passes on the sub-cycle's combined diff.
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every command
  block. Agent bash cwd resets between calls.
- `bun run typecheck` catches TS issues the single-file bun runner misses — run
  it after any signature/union change (the `PointerInputEvent` field, the `Obs`
  method, the `ToolId` union all ripple).
- Browser contract runs: `cd e2e && bunx playwright test --project=e2e -g <name>`.

### FULL E2E SIGN-OFF (bake this in — a filtered sign-off already slipped a bug)
- The sub-cycle sign-off MUST run the **FULL** e2e suite —
  `cd e2e && bunx playwright test --project=e2e` — **not** a `-g`-filtered subset.
  A StylePanel regression slipped a filtered sign-off in the styling step and was
  only caught later. Per-task, filter for speed; for the sub-cycle's final
  green, run the whole e2e project plus the whole `bun run test` suite plus
  `bun run typecheck`.

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
   error, the RED is fake: fix the wiring until the test *runs* and the
   *assertion* is what fails.
3. Where a test pins a choice, name the wrong implementations it kills (a
   **mutant table** — each row: a plausible wrong impl → the assertion that
   catches it). **Each mutant row must genuinely discriminate — RUN the test
   against that wrong impl if unsure.** Every non-trivial task below ships one.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). Forbidden patterns (verified against the
  test): imports of `loro-crdt`, `ws`, `@tldraw/`, `react`, `canvas-sync`;
  `from '../server'`; and the literals `document.`, `window.`, `Date.now(`,
  `Math.random(`. The freehand algorithm is **reimplemented clean** — **no
  `@tldraw/` import, no `perfect-freehand` import** (there is no standalone
  `perfect-freehand` package; tldraw vendors it internally under `@tldraw/`).
  The id-mint uses `editor.random`, never `Math.random(` (the scan fails the
  literal even in a comment).
- **`canvas-model` has NO boundary test** (verified — only `canvas-editor` scans
  text). `canvas-model/src/draw-geometry.ts` is still pure by construction: no
  DOM, no clock, no PRNG, no I/O — a pure function of its point/options inputs.
  Do not reach for `Math.random`/`Date.now` there either; the algorithm is
  fully deterministic without them.
- `canvas-react` and `client` MAY touch the DOM (the renderer + the toolbar).

### Interaction contracts (CLAUDE.md — mandatory; carry into EVERY gated brief)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan the **gated** tasks are **T1** (`tools/
  draw.ts`), **R1** (`canvas-react/src/shapes/DrawShape.tsx`), and **W1**
  (`client/src/canvas-v2/…`). The pure model/geometry tasks (M1, G1–G3), the
  Obs task (H, `interaction-contracts` + `e2e` + `canvas-editor/src/contracts/`),
  and the contract (K, `interaction-contracts` + `e2e`) are **not** under a gated
  prefix. Satisfy the gate for the sub-cycle by landing **K** (the real
  contract); until then, gated tasks carry the `UX_CONTRACT_PR_BODY` opt-out
  above.
- **Obligation 3 (both adapters):** the new `shapeKind(id)` Obs MUST be
  implemented **for real in BOTH** adapters — `canvas-editor/src/contracts/
  fsm-runner.ts` (`editor.doc.getShape(id)?.kind ?? null`) AND `e2e/lib/
  contracts.ts` (pre-sampled from `window.__ew.doc.getShape`). It reads doc
  state at both levels, so **no throw-stub** (unlike `paintOrder`).
- **Obligations 2 & 4 (RED, reviewer-verified):** K runs RED against the
  un-wired predecessor and the reviewer independently reproduces red→green
  (revert, see the failure, restore) — never accept the implementer's report.
  K's exact RED handle is named in its task (revert W1's toolset `draw` entry to
  a no-op — the Draw button stays present so the `element` anchor still resolves,
  and `shapeCount()` stays 0: a clean assertion RED, never a locator error).
- **The pen tool is a tool FSM** (unlike copy/paste's keyboard path), so K is
  **`level: 'browser'`**: it must click the real toolbar Draw button (there is no
  FSM-runner path for the `draw` tool — the runner only drives `select` /
  `select+transform`, see `Contract.tool`). The tool's own FSM behavior is pinned
  by unit tests in **T1** at the FSM level; K is the end-to-end browser proof.

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught ~15 false factual claims; the dominant
  failure mode is confident *quantitative / locational* claims. **Prefer wording
  that cannot rot** — describe by argument/behavior, not raw line numbers.

---

## Decisions (settled — do not re-litigate)

### D-1. The stroke model (schema permissiveness) — Task M1
`draw`'s props schema is EMPTY today (`draw: z.looseObject({})` — verified), which
means it accepts **everything** (our shapes AND v1 shapes already validate — an
empty `looseObject` drops nothing). So the risk here is the *opposite* of the
COLOR-enum cycle: typing too **strictly** would start dropping synced v1 draw
shapes at the write boundary. Decision — type it **permissively**, matching v1's
real shape:

```ts
// A stroke point: v1 VecModel {x, y, z} where z = pressure 0..1. LOOSE so a
// point carrying extra keys still passes; x/y REQUIRED numbers so a malformed
// point (missing/non-number coord) is caught; z OPTIONAL (v1 pen points always
// have it, simulated-pressure points may not).
const drawPoint = z.looseObject({ x: z.number(), y: z.number(), z: z.number().optional() })
// A segment: v1 { type: 'free' | 'straight', points: [...] }. `type` a loose
// string (NOT a closed enum — future/unknown segment types must ride through),
// points optional (a degenerate empty segment still validates).
const drawSegment = z.looseObject({ type: z.string().optional(), points: z.array(drawPoint).optional() })
// draw props: segments + the four style axes real tldraw draw carries (closed
// enums, geo/arrow-consistent — v1 draw colors/dash/size/fill are ALWAYS in
// these sets, so this never drops a real v1 shape) + isPen/isClosed + our own
// w/h (see the coordinate note below). Everything optional; looseObject so v1's
// isComplete/scale/etc ride through untouched.
draw: z.looseObject({ segments: z.array(drawSegment).optional(), isPen: z.boolean().optional(), isClosed: z.boolean().optional() })
  .extend(box.shape)                                    // w?/h?
  .extend(styleProps('color', 'fill', 'dash', 'size').shape),
```

- **Segments, not a flat points array** — match tldraw's `props.segments:
  [{type,points}]` verbatim so a synced v1 draw shape validates against exactly
  the field it carries, and our own tool writes one `{type:'free', points}`
  segment. The renderer/geometry concatenate all segments' points.
- **`draw` is NOT added to `TEXT_CAPABLE_KINDS`** (it stays a structural kind —
  no text body). No change to that allowlist.
- **Coordinate convention (load-bearing):** OUR pen tool **normalizes** — on
  every emission it sets `shape.x/y` to the point-cloud's min corner and stores
  each point **relative to that min**, so all local points are in `[0,w]×[0,h]`
  and it writes `props.w/h` = the point bbox size. This makes `localBounds`
  (`{minX:0,minY:0,maxX:w,maxY:h}`, geometry.ts) exact for our strokes with **no
  geometry.ts change** (`size()`'s generic branch reads `props.w/h`). **Synced
  v1** draw shapes carry no `w/h` and un-normalized (possibly negative) local
  points → `size()` falls back to 100×100, so their *selection/cull box* is
  loose, but the **body still paints the true stroke** via `overflow:visible`
  (Decision 4). Tight bounds for v1 draw shapes = a documented follow-up, not
  this cycle (would need a `localBounds` contract change to admit a non-`{0,0}`
  origin — too invasive here).

### D-2. The freehand algorithm (faithfulness + location) — Tasks G1–G3
Owner chose **full parity → pressure-sensitive**. Decision — a **faithful
clean-room reimplementation of perfect-freehand's outline algorithm**, pure and
deterministic, living in **`canvas-model/src/draw-geometry.ts`** (with the other
pure geometry modules — `geometry.ts`, `arrow-route.ts`, `spatial-index.ts` — all
pure, all clean-room; canvas-model imports nothing but `zod` and its own types).
The renderer (canvas-react) imports it. Three stages, each its own task + property
tests:

1. **`getStrokePoints(points, options)` (G1)** — low-pass **streamline** filter
   (`t = 0.15 + (1 - streamline) * 0.85`; each point pulled toward the previous
   by `t`), consecutive-duplicate dedupe, and per-point derived fields:
   `{ point:{x,y}, pressure, vector (unit vector toward the previous point),
   distance (to previous), runningLength }`.
2. **`getStrokeOutline(strokePoints, options)` (G2)** — per-point **radius** from
   pressure (`thinning`-modulated: `radius = (size/2) * clamp(easing(0.5 -
   thinning*(0.5 - pressure)), 0.01, 1)` when `thinning>0`, else `size/2`), with
   **`simulatePressure`** deriving pressure from local velocity/running-length
   when the device gives none (mouse); left/right offset points **perpendicular
   to `vector`**; round **caps** at the two ends (and a start/end **taper**). The
   result is a single **closed outline polygon** (`Point[]`) — a filled shape,
   the perfect-freehand model, NOT a stroked centerline.
3. **`getSvgPathFromOutline(outline)` (G3)** — the quadratic-midpoint smoothing
   walk (`M … Q p0 mid(p0,p1) Q p1 mid(p1,p2) … Z`). Plus convenience
   **`getStrokePath(points, options)`** (G1∘G2∘G3) and **`strokeOptionsForSize(
   size, isPen)`** mapping our `size` axis (`s/m/l/xl`) + `isPen` to
   perfect-freehand options (`size` px, `thinning:0.5`, `smoothing:0.5`,
   `streamline:0.5`, `simulatePressure: !isPen`, tapered ends) — tldraw's own
   DrawShapeUtil defaults.

Pixel-exact match to tldraw's vendored copy is neither testable (the vendored
code is un-importable) nor required. **Property tests** pin the invariants
instead: determinism (same input → identical path string), empty input → `''`,
single point → a closed round dot, monotonic `runningLength`, outline bbox
contains every input point, **higher pressure at a point widens the local
outline** (the pressure-parity assertion), and no `NaN`/`Infinity` for any finite
input (duplicates, collinear, two identical points).

### D-3. Pressure input (replay-safe) — Task T1
`PointerInputEvent` has **NO** pressure field today (verified). Add one:
`readonly pressure?: number` (0..1). Replay-safe because it is a **recorded**
field on the deterministic event, **injected not sampled** — exactly like `t`
(input.ts's header: "`t` is ALWAYS caller-injected, never read from a wall
clock").

- **Device semantics with ONE field, no `pointerType` enum leak:** canvas-react's
  DOM→InputEvent normalization (in `client/src/canvas-v2`, Task W1) sets
  `pressure: e.pointerType === 'pen' ? e.pressure : undefined` — i.e. it
  populates `pressure` ONLY for a real stylus; mouse/touch leave it `undefined`.
  So `event.pressure !== undefined` ⇔ "a real pen signal."
- **The pen tool** records, per captured point, `z = event.pressure ?? 0.5`
  (mouse points get the neutral 0.5), and sets `props.isPen = downEvent.pressure
  !== undefined`. The renderer maps `isPen → simulatePressure: !isPen`
  (Decision 2), so mouse strokes get the nice velocity-tapered width and pen
  strokes get true pressure. Clean, one new field, fully replay-safe.
- `canvas-editor/src/script.ts`'s `StepOptions` gains `readonly pressure?:
  number` (flows onto the emitted `pointerdown`/`pointermove`/`pointerup`) so
  the FSM tool tests inject deterministic pressure.

### D-4. The renderer — Task R1
A `DrawShape` body component (`canvas-react/src/shapes/DrawShape.tsx`), registered
in `registerCoreShapes.ts` (replacing `draw`'s current `BoxShape` fallback).
Reads `props.segments` → flatten to points → `getStrokePath(points,
strokeOptionsForSize(size, isPen))` → renders a **filled** `<path fill={color}
d=…/>` inside an `<svg style={{overflow:'visible', position:'absolute',
inset:0}}>` drawn at **1:1 local coordinates** (NOT a scaling `viewBox` like
GeoShape — freehand points are already in world-unit local space; the WorldLayer
applies the camera scale). `overflow:visible` lets a stroke that overflows the
wrapper box (always, by ~radius; and always for un-normalized v1 shapes) paint
correctly. Color reuses the **exported** `GEO_COLORS[color].solid` from
`GeoShape.tsx` (same tolerant `typeof x === 'string' && x in GEO_COLORS` guard,
same absent→'black' default). `dash`/`fill` on freehand ink are a documented
simplification (a stroke is a filled colored outline). The body sets
`data-shape-body="draw"` so tests/contracts can find it.

### D-5. Toolbar + tool wiring — Task W1 (GATED)
- `client/src/canvas-v2/tool-loop.ts`: add `'draw'` to the `ToolId` union,
  `draw: Tool<DrawState>` to `ToolSet`, `draw: createDrawTool(ctx)` to
  `createToolSet`, and `draw: tools.draw.initialState` to
  `createInitialToolStates`. In `cancelActiveTool`, add `draw` to the
  in-flight-delete branch (its `'drawing'` state carries `id` — like arrow/create,
  an abandoned mid-stroke shape is deleted).
- `client/src/canvas-v2/CanvasV2App.tsx`: append `{ id: 'draw', label: 'Draw' }`
  to `TOOL_BUTTONS` (renders `<button data-canvas-v2-tool="draw">` — the existing
  attribute, no new selector needed), and in the DOM→InputEvent normalization set
  `pressure` per D-3.
- **Click-creates-a-dot** is intended (tldraw parity): the draw tool commits from
  `pointerdown` (no drag threshold), so a bare click leaves a round dot. This is
  a deliberate divergence from create/arrow's threshold gate — documented in the
  tool.

### D-6. The contract + Obs — Tasks H, K
- **New Obs `shapeKind(id): string | null`** (H): general, reusable, reads doc
  state → implemented for real in BOTH adapters (no throw-stub). `shapeStyle`
  can't answer this (kind is an envelope field, not `props`, and its value
  isn't a string/number prop).
- **Contract `draw-creates-a-draw-shape`** (K), `level:'browser'`, `when:'at-end'`,
  empty scene: click the Draw button (`[data-canvas-v2-tool="draw"]` via the
  `element` anchor — the armed-style contract's proven pattern), then
  down→move(steps)→up over empty canvas. `check`: `selectedShapeIds()` is exactly
  one id `did` (the pen tool auto-selects on finalize), `shapeCount() === 1`, and
  `shapeKind(did) === 'draw'`. (Exact stroke geometry is pinned by G1–G3's pure
  property tests and R1's renderer test; the contract pins the end-to-end
  tool→doc creation.)

### Judgment calls surfaced to the owner
1. **Faithful reimplementation vs. pragmatic pressure path (recommend: faithful,
   as planned).** Full parity was chosen, so G1–G3 reconstruct perfect-freehand's
   real outline algorithm. It is the biggest task and the biggest risk; the
   mitigation is property-tested invariants, not pixel-matching an un-importable
   vendored file. **OK to accept "parity in behavior/feel, pinned by properties"
   rather than byte-identical output?** (recommend yes — byte-identity is
   untestable here.)
2. **v1 draw-shape bounds (recommend: defer tight bounds).** Our own strokes get
   exact `localBounds` (normalized + `w/h`); synced **v1** draw shapes render
   correctly but get a loose 100×100 selection/cull box until a follow-up teaches
   `localBounds` a non-`{0,0}` origin. **OK to ship v1 with loose bounds this
   cycle?** (recommend yes — rendering parity is the requirement; the box is
   cosmetic and rare.)
3. **dash/fill on freehand ink (recommend: simplify).** A freehand stroke renders
   as a filled colored outline; `dash`/`fill` axes are typed (for round-trip) but
   not visually honored on ink (matching how most freehand renderers treat them).
   **OK to no-op dash/fill visually on draw?** (recommend yes.)
4. **Pen `pressure` field on `PointerInputEvent` (decided, low-risk).** One
   optional field, injected not sampled, populated only for `pointerType==='pen'`.
   Surfaced for visibility; no owner action expected.

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| M1 | `draw` props schema (segments/points + style axes, permissive) | canvas-model (no) | — | bad-color / malformed-point draw shape wrongly validates |
| G1 | `getStrokePoints` (streamline + running length + vectors) | canvas-model (no) | — | not smoothed / no runningLength / dup not deduped |
| G2 | `getStrokeOutline` (pressure→radius, perp offsets, caps, simulate) | canvas-model (no) | G1 | width constant vs pressure; outline not closed |
| G3 | `getSvgPathFromOutline` + `getStrokePath` + `strokeOptionsForSize` | canvas-model (no) | G1,G2 | non-deterministic path; empty input throws |
| T1 | pen tool FSM `tools/draw.ts` + `pressure` on event/script | canvas-editor (**tools/ = YES**) | M1 | drawing emits no draw-kind CreateShape; pressure dropped |
| R1 | `DrawShape` body + registry | canvas-react (**YES**) | M1,G3 | draw renders BoxShape fallback, no path |
| W1 | toolbar + tool-loop wiring + DOM pressure | client/canvas-v2 (**YES**) | T1 | no Draw button / draw tool unrouted / cancel leaks |
| H | `shapeKind(id)` Obs (**both adapters**) | interaction-contracts + e2e + canvas-editor/contracts | — | Obs method absent |
| K | browser contract `draw-creates-a-draw-shape` | interaction-contracts + e2e (satisfies gate) | R1,W1,H | Draw button inert → no draw shape created |

Land **H before K** (the Obs must exist). Land **W1 before K** (the Draw button
must render so K's `element` anchor resolves — otherwise K's RED is a fake
locator error). R1 and W1 are independent of each other. T1/R1/W1 are gated: run
their suites with the `UX_CONTRACT_PR_BODY` opt-out until K lands.

---

## Task M1 — `draw` props schema (canvas-model, pure)

**Files:**
- Modify: `canvas-model/src/shape.ts` (the `draw:` entry in `propsByKind`, ~line 194)
- Test: `canvas-model/src/shape.test.ts` (the existing schema test file)

Replace `draw: z.looseObject({})` with the D-1 schema (add the `drawPoint` /
`drawSegment` loose objects near the other prop fragments; compose the four style
axes via `styleProps('color','fill','dash','size')` and `box.shape` exactly like
`geo`).

**Step 1 — RED test.** Add three assertions:
- `validateShape(v1Draw)` where `v1Draw` is a full v1-shaped draw shape —
  `props: { segments: [{ type: 'free', points: [{x:0,y:0,z:0.5},{x:10,y:8,z:0.7}] }],
  color: 'blue', fill: 'none', dash: 'draw', size: 'm', isPen: true, isComplete:
  true, isClosed: false, scale: 1 }` — must return **`ok: true`** (the permissiveness
  guard; passes today too — this is the guard, not the RED).
- `validateShape(badColorDraw)` (same but `color: 'chartreuse'`) must return
  **`ok: false`** — **RED** (empty `looseObject` returns `ok:true` today).
- `validateShape(malformedPointDraw)` (a segment point `{x:0}` — missing `y`, or
  `y:'nope'`) must return **`ok: false`** — **RED**.

Run `~/.bun/bin/bun canvas-model/src/shape.test.ts`; confirm the RED is the
*value/structure assertion* failing (`ok:true` where `ok:false` expected), not a
load error.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Leave `looseObject({})` | bad-color and malformed-point both wrongly `ok:true` |
| Type color as `z.string()` not the enum | bad-color `'chartreuse'` wrongly `ok:true` |
| Type points as `z.any()` / omit x/y | malformed-point wrongly `ok:true` |
| Make `segments` REQUIRED | a v1 draw shape lacking segments wrongly dropped (regression) |
| Type `type` as a closed enum `'free'\|'straight'` | a future/unknown segment type drops a real shape |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): type the draw shape's stroke points + style axes, permissively`).

---

## Task G1 — `getStrokePoints` (canvas-model, pure)

**Files:**
- Create: `canvas-model/src/draw-geometry.ts`
- Test: `canvas-model/src/draw-geometry.test.ts`
- Modify: `canvas-model/src/index.ts` (export the new surface)

Define the input/option types and the first stage:

```ts
export interface DrawInputPoint { readonly x: number; readonly y: number; readonly z?: number }
export interface StrokeOptions {
  readonly size: number; readonly thinning: number; readonly smoothing: number
  readonly streamline: number; readonly simulatePressure: boolean
  readonly capStart: boolean; readonly capEnd: boolean
  readonly taperStart: number; readonly taperEnd: number
}
export interface StrokePoint {
  readonly point: { x: number; y: number }; readonly pressure: number
  readonly vector: { x: number; y: number }; readonly distance: number; readonly runningLength: number
}
export function getStrokePoints(points: readonly DrawInputPoint[], options: StrokeOptions): StrokePoint[]
```

`getStrokePoints` (perfect-freehand's stage 1, reconstructed): map inputs to
`{x,y,pressure = z ?? 0.5}`; drop consecutive exact duplicates; **streamline**
with `t = 0.15 + (1 - streamline) * 0.85`, pulling each point toward the previous
(`p = prev + (curr - prev) * t`); then walk the smoothed points computing each
`vector` (unit vector from this point to the previous — the first point's vector
is a duplicate of the second's, per perfect-freehand), `distance`, and cumulative
`runningLength`. Empty input → `[]`; single input → one `StrokePoint` with
`vector {x:1,y:0}`, `distance 0`, `runningLength 0`.

**Step 1 — RED property tests** (`~/.bun/bin/bun canvas-model/src/draw-geometry.test.ts`):
- `getStrokePoints([], opts)` → `[]`.
- three collinear points → `runningLength` strictly increases; each `vector` is
  unit length (`hypot ≈ 1`, tolerance 1e-9) except the degenerate zero-distance case.
- a point immediately repeated is **deduped** (output length < input length).
- streamline moves an interior point toward its predecessor (the smoothed point
  is closer to `prev` than the raw point was) — pins that streamlining actually happened.
- determinism: two calls with the same input are deep-equal.

Confirm the RED is `getStrokePoints is not a function` **only after** you have
added a stub export (so the RED becomes your *assertion*, not a load error), per
the fake-RED rule.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Return inputs unchanged (no streamline) | smoothed-point-moved-toward-prev assertion |
| Skip dedupe | deduped-length assertion; a zero-distance vector becomes `NaN` |
| Vector points forward not backward | (documented direction) sign assertion in G2's perp test |
| Forget `runningLength` accumulation | monotonic-runningLength assertion |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): getStrokePoints — streamline + running length for freehand`).

---

## Task G2 — `getStrokeOutline` (canvas-model, pure)

**Files:** `canvas-model/src/draw-geometry.ts`, `canvas-model/src/draw-geometry.test.ts`.

```ts
export function getStrokeOutline(strokePoints: readonly StrokePoint[], options: StrokeOptions): { x: number; y: number }[]
```

Perfect-freehand's stage 2, reconstructed: for each `StrokePoint`, compute a
**radius** from pressure. With `thinning > 0`:
`radius = (size/2) * clamp(easeInOut(0.5 - thinning*(0.5 - pressure)), 0.01, 1)`
(use a simple `easeInOut` — perfect-freehand's default easing is linear; a linear
`t => t` is acceptable and keeps it deterministic). With `thinning === 0`,
`radius = size/2`. When `simulatePressure`, derive `pressure` per point from local
velocity/running-length (perfect-freehand: a running mix of `min(1, distance/size)`
eased against the previous pressure) rather than the stored `z`. Offset a
**left** and **right** point at each stroke point, `±radius` along the
**perpendicular** to `vector` (`perp = {x: -vector.y, y: vector.x}`). Add round
**caps** at the first and last points (a short arc of interpolated points), and
apply the start/end **taper** (radius ramps from 0 over `taperStart/taperEnd`
length). Return the left side forward + the right side backward as ONE closed
polygon.

**Step 1 — RED property tests:**
- **Pressure widens the stroke (the parity assertion):** build two 3-point
  strokes identical except the middle point's `z` (0.2 vs 0.9), `thinning:0.5`,
  `simulatePressure:false`. Measure the outline width near the middle point (max
  pairwise distance of outline points local to that x) — the high-pressure stroke
  is **strictly wider**. This is the single most important test in the cycle.
- **Closed & non-degenerate:** a real multi-point stroke yields an outline with
  ≥ 6 points; first and last outline points are close (closed loop).
- **Bbox contains inputs:** every input point lies within the outline's bounding
  box (inflated by `size/2`).
- **Single point → a dot:** one input point yields a roughly circular closed
  outline of radius ≈ `size/2` (min/max pairwise ≈ `size`).
- **No NaN/Infinity** for: two identical points, all-collinear points, a single point.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Ignore pressure (constant radius) | pressure-widens assertion |
| Offset along `vector` not its perpendicular | outline collapses to a line → bbox/width assertions |
| No caps at ends | single-point-dot assertion (no closed circle) |
| Divide by zero on identical points | no-NaN assertion |
| `thinning` sign flipped (high pressure → thin) | pressure-widens assertion (wrong direction) |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): getStrokeOutline — pressure-tapered variable-width outline`).

---

## Task G3 — `getSvgPathFromOutline` + `getStrokePath` + `strokeOptionsForSize`

**Files:** `canvas-model/src/draw-geometry.ts`, `canvas-model/src/draw-geometry.test.ts`, `canvas-model/src/index.ts`.

```ts
export function getSvgPathFromOutline(outline: readonly { x: number; y: number }[]): string
export function getStrokePath(points: readonly DrawInputPoint[], options: StrokeOptions): string
export function strokeOptionsForSize(size: string, isPen: boolean): StrokeOptions
```

- `getSvgPathFromOutline`: perfect-freehand's `getSvgPathFromStroke` — `M` to the
  first point, then a `Q control mid(control,next)` walk over the polygon, closing
  with `Z`. Empty outline → `''`.
- `getStrokePath = getSvgPathFromOutline(getStrokeOutline(getStrokePoints(points, o), o), )`.
  Empty `points` → `''` (never throws).
- `strokeOptionsForSize`: map our `size` axis to a base px (`s→2*... ` — reuse the
  feel of `STROKE_WIDTH_PX` from GeoShape but a larger ink size, e.g.
  `{ s: 4, m: 8, l: 12, xl: 20 }`; pick and document values), with
  `thinning:0.5, smoothing:0.5, streamline:0.5, simulatePressure: !isPen,
  capStart:true, capEnd:true, taperStart:0, taperEnd:0`. Unknown size → `'m'`.

**Step 1 — RED tests:**
- `getStrokePath([], opts)` → `''` (no throw).
- `getStrokePath(oneStroke, opts)` twice → **identical** string (determinism).
- the returned string starts with `M` and contains `Q` for a multi-point stroke.
- `strokeOptionsForSize('l', false).simulatePressure === true` and
  `strokeOptionsForSize('l', true).simulatePressure === false`; unknown size →
  the `'m'` base.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Emit `L` line segments not `Q` curves | contains-`Q` assertion |
| Non-deterministic ordering (Set/Map iteration) | determinism assertion |
| Throw on empty | empty→`''` assertion |
| `simulatePressure = isPen` (flipped) | the two simulatePressure assertions |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): freehand SVG path + size→options mapping`).

---

## Task T1 — pen tool FSM + pressure on the input event (canvas-editor — tools/ GATED)

**Files:**
- Modify: `canvas-editor/src/input.ts` (add `readonly pressure?: number` to
  `PointerInputEvent`) — **not** under a gated prefix.
- Modify: `canvas-editor/src/script.ts` (add `pressure?` to `StepOptions`; thread
  onto the emitted pointer events) — **not** gated.
- Create: `canvas-editor/src/tools/draw.ts` — **GATED** (`tools/`).
- Test: `canvas-editor/src/tools/draw.test.ts`
- Modify: `canvas-editor/src/index.ts` (`export * from './tools/draw.js'`)

`createDrawTool(ctx: ToolContext): Tool<DrawState>`, FSM `idle → drawing`:
- **`pointerdown`** (idle): mint `id` (reuse create.ts's `makeId` shape — event
  `{t,x,y}` + one `editor.random()` draw; module-private, so reimplement the
  five-line helper, same as arrow.ts does), compute `index` via `topIndex(ctx,
  pageId)` (reuse create.ts's shape, once), record the first world point with
  `z = event.pressure ?? 0.5`, capture `isPen = event.pressure !== undefined`,
  and emit one `CreateShape` for a one-point (dot) draw shape + `SetSelection([id])`.
  Enter `drawing` with `{ id, index, isPen, worldPoints: [pt] }`.
- **`pointermove`** (drawing): append `worldOf(event)` + `z` **immutably**
  (`worldPoints: [...state.worldPoints, pt]`); re-emit **one upserted**
  `CreateShape` for the whole stroke (see the shape builder below). One commit per
  move — the same per-pointermove cadence create/arrow document.
- **`pointerup`** (drawing): append the final point, emit the final `CreateShape`
  + `SetSelection([id])`, return to `idle`.

Shape builder (pure, deterministic — the D-1 normalization): compute the bbox of
`worldPoints`; `x = minX, y = minY`; local points = `{x: wx - minX, y: wy - minY,
z}`; `props = { segments: [{ type: 'free', points: localPoints }], isPen, w: maxX
- minX, h: maxY - minY, ...whitelisted armed style }`. Stamp armed style exactly
as create.ts does (`whitelistStyleProps(editor.get().nextShapeStyle)` — `color`
etc. ride through the shared `STYLE_VALUE_SETS` whitelist).

**Step 1 — RED tests** (fake `Editor`/`ToolContext` + `script()` with injected
pressure; run `~/.bun/bin/bun canvas-editor/src/tools/draw.test.ts`):
- a `down→move→move→up` script yields intents whose net effect creates **one
  shape of kind `'draw'`** whose `props.segments[0].points.length === 4` (down +
  2 moves + up). RED before the tool exists → after stub export, RED is the
  kind/points assertion.
- **pressure is recorded:** inject `pressure: 0.9` on a move → that point's `z ===
  0.9`; a mouse move (no pressure) → `z === 0.5`; the down event with a pressure
  set → `props.isPen === true`; without → `false`.
- **normalization/determinism:** draw the same script twice → deep-equal shapes;
  local points are all `>= 0` and `props.w/h` equal the point bbox.
- **z-order:** with a pre-existing sibling of index `'a5'`, the draw shape's
  `index > 'a5'` (reuses `topIndex`).
- **click = dot:** `down→up` (no move) still creates a one-point draw shape (no
  threshold gate) — pins the deliberate divergence from create/arrow.
- run `~/.bun/bin/bun canvas-editor/src/boundary.test.ts` — clean-room still holds
  (no `Math.random(`/`@tldraw/` crept in; the id-mint uses `editor.random`).

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Threshold-gate like create (no dot on click) | click=dot assertion |
| Drop `event.pressure`, always 0.5 | pressure-recorded assertion (0.9 point) |
| Don't normalize (raw world points) | local-points-≥0 / bbox `w/h` assertion |
| Recompute `topIndex` per move | non-deterministic index / z-order churn |
| Mutate `worldPoints` in place | replay determinism (deep-equal) assertion |
| `isPen` always true/false | isPen pen-vs-mouse assertions |

**ux-contract:** GATED (`tools/draw.ts`). Run this task's full suite with the
`UX_CONTRACT_PR_BODY` opt-out from READ-THIS until K lands.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-editor): pressure-aware freehand pen tool FSM`).

---

## Task R1 — `DrawShape` body + registry (canvas-react — GATED)

**Files:**
- Create: `canvas-react/src/shapes/DrawShape.tsx`
- Modify: `canvas-react/src/shapes/registerCoreShapes.ts` (import + `registerShape('draw', DrawShape)`)
- Test: `canvas-react/src/shapes/draw-shape.test.ts`

Per D-4: flatten `props.segments` → points; `getStrokePath(points,
strokeOptionsForSize(size, isPen))`; render `<div data-shape-body="draw"><svg
overflow:visible …><path fill={GEO_COLORS[color].solid} d={path}/></svg></div>`.
Empty/absent segments → render nothing (an empty `<div data-shape-body="draw">`
is fine). Reuse `GEO_COLORS`/`geoVariant`-style color guard from `GeoShape.tsx`
(imported, not re-copied). Pure/presentational — no `snapshot` read (content-memo
friendly).

**Step 1 — RED test.** Render a draw shape (via the same test harness the other
`*-shape.test.ts` files use) with a real multi-point segment and assert:
- the rendered output has `[data-shape-body="draw"]` (BoxShape fallback would
  render `[data-shape-body]` for a box, not `draw`) — **RED** before registration
  (registry falls back to `BoxShape`).
- an `<path>` with a non-empty `d` starting `M` is present.
- the path `fill` is `GEO_COLORS['blue'].solid` when `props.color==='blue'`.
Confirm the RED is the missing-`draw`-body assertion, not a render/import crash.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Forget to register `draw` | `[data-shape-body="draw"]` absent (BoxShape) |
| Stroke the centerline (`stroke=` not `fill=`) | fill-color assertion (perfect-freehand is a filled outline) |
| Scaling `viewBox` like GeoShape | path coords wrong scale (assert a known point maps 1:1) |
| Empty segments crash | empty-segments renders nothing without throwing |

**ux-contract:** GATED (`canvas-react/src/`). Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-react): DrawShape body renders pressure freehand strokes`).

---

## Task W1 — toolbar + tool-loop wiring + DOM pressure (client/canvas-v2 — GATED)

**Files:**
- Modify: `client/src/canvas-v2/tool-loop.ts` (`ToolId`, `ToolSet`,
  `createToolSet`, `createInitialToolStates`, `cancelActiveTool`)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`TOOL_BUTTONS` +
  DOM→InputEvent `pressure`)
- Test: `client/src/canvas-v2/tool-loop.test.ts`

Per D-5. Import `createDrawTool`, `type DrawState` from
`@ensembleworks/canvas-editor`. Wire all five sites. `cancelActiveTool`: add
`draw` to the `id`-carrying delete branch. In CanvasV2App's pointer normalization
set `pressure: e.pointerType === 'pen' ? e.pressure : undefined`.

**Step 1 — RED test** (DOM-free, in `tool-loop.test.ts`):
- `createToolSet(ctx).draw` is defined and `createInitialToolStates(tools)` has a
  `draw` entry (RED: `ToolSet` has no `draw`).
- `dispatchToActiveTool(tools, states, 'draw', editor, downEvent)` routes to the
  draw tool and applies a `CreateShape` (assert a shape now exists in the fake
  editor's doc). RED before wiring.
- `cancelActiveTool(tools, drawingStates, 'draw', editor)` returns a
  `DeleteShapes` intent for the in-flight id (RED: draw not in the delete branch →
  the in-flight shape leaks).

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Forget `draw` in `createToolSet`/states | `tools.draw` undefined → dispatch crashes/no shape |
| `cancelActiveTool` omits `draw` | leaked-in-flight-shape assertion |
| DOM pressure populated for mouse too | (covered by T1's isPen semantics; note in review) |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): wire the Draw pen tool into the toolbar and tool loop`).

---

## Task H — `shapeKind(id)` Obs (both adapters)

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `shapeKind(id: string):
  string | null` to `Obs`, with a doc comment naming BOTH adapters' mechanisms)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (`shapeKind: (id) =>
  editor.doc.getShape(id)?.kind ?? null`)
- Modify: `e2e/lib/contracts.ts` (pre-sample kinds for the union of scene ids +
  selection — mirror `sampleShapeStyles`/`sampleSelection` exactly; add a
  `kinds` field to `ActorSample`; `shapeKind: (id) => sample.kinds[id] ?? null`)

`shapeKind` reads doc state at both levels → **no throw-stub** (Obligation 3).
Note the browser adapter must sample kinds for the **union** of `sceneShapeIds`
and the current `selection` (the drawn shape's id is gesture-minted from
crypto-random and only discoverable via `selectedShapeIds()` — same reason
`sampleActor` already unions selection into `styleIds`).

**Step 1 — RED:** add a **temporary** `level:'fsm'` micro-contract asserting
`shapeKind(seededId) === 'geo'` for a one-geo scene; run
`~/.bun/bin/bun canvas-editor/src/contracts/library.test.ts` → RED (`shapeKind is
not a function`). Implement in both adapters, GREEN, **remove the scaffold**.

**Step 2–5:** `bun run typecheck` (the `Obs` addition ripples into both adapters —
typecheck forces both), commit
(`test(contracts): shapeKind Obs (both adapters)`).

---

## Task K — browser contract `draw-creates-a-draw-shape` (satisfies the gate)

**Files:**
- Create: `interaction-contracts/src/contracts/draw-creates-a-draw-shape.ts`
- Modify: `interaction-contracts/src/index.ts` (append to `CONTRACTS`)

Per D-6. `level:'browser'`, `when:'at-end'`, `scene: () => []`. Gesture: click the
Draw button, then draw a stroke on empty canvas well clear of the toolbar/panel:

```ts
const DRAW_TOOL_SELECTOR = '[data-canvas-v2-tool="draw"]'
gesture: () => [
  { kind: 'down', at: { ref: 'element', selector: DRAW_TOOL_SELECTOR } },
  { kind: 'up' },
  { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
  { kind: 'move', at: { ref: 'point', x: 640, y: 600 }, steps: 8 },
  { kind: 'up' },
],
check: (obs) => {
  const ids = obs.selectedShapeIds()
  if (ids.length !== 1) return `expected exactly one shape after drawing, got ${JSON.stringify(ids)}`
  if (obs.shapeCount() !== 1) return `expected shapeCount 1 after one stroke, got ${obs.shapeCount()}`
  const kind = obs.shapeKind(ids[0]!)
  if (kind !== 'draw') return `expected the created shape to be kind 'draw', got ${JSON.stringify(kind)}`
  return null
},
```

**RED (Obligation 2/4 — name it precisely):** the genuine, clean RED is reached
by **reverting W1's toolset entry** `draw: createDrawTool(ctx)` to a no-op (e.g.
`draw: tools.hand` or a stub tool) — the Draw button **still renders**, so the
`element` anchor resolves and the click succeeds, but drawing produces no shape →
`shapeCount()` stays 0 and `selectedShapeIds()` stays `[]` → a clean
**assertion** failure ("expected exactly one shape after drawing, got []"), never
a locator error. Capture the **verbatim** RED. The reviewer independently reverts
that same toolset entry, observes the identical RED, and restores. Run:
`cd e2e && bunx playwright test --project=e2e -g draw-creates-a-draw-shape`.
Commit (`test(contracts): drawing a stroke creates a draw shape`).

> **Why not point the RED at "the Draw button is absent"?** That would make the
> `element` anchor throw `boundingBox() … null` — a FAKE (load/locator) RED that
> proves nothing about the assertion. Reaching the RED through a present-but-inert
> button (W1 toolset revert) is the only clean path, exactly the armed-style
> contract's own RED discipline.

---

## PR body — required content

The sub-cycle is interaction-bearing (`tools/`, `canvas-react/src/`,
`client/src/canvas-v2/`). Because K adds a real contract, the honest form is a
**contract reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `draw-creates-a-draw-shape`
   (interaction-contracts/src/contracts/draw-creates-a-draw-shape.ts)
   + new `Obs.shapeKind` (BOTH adapters: canvas-editor/src/contracts/
   fsm-runner.ts, e2e/lib/contracts.ts).
   RED (verbatim, W1 toolset `draw` reverted to a no-op): <paste>
   GREEN (after restore): <paste>
   Reviewer reproduced red→green by reverting the toolset `draw` entry.
```

If tasks land across multiple PRs, any PR shipping a gated task (T1/R1/W1) ahead
of K carries `ux-contract: none — draw sub-cycle; governing contract
draw-creates-a-draw-shape lands with this sub-cycle (see plan)`.

---

## Sub-cycle sign-off (all three, no shortcuts)

1. `cd /home/stag/src/projects/ensembleworks && bun run typecheck` → exit 0.
2. `UX_CONTRACT_PR_BODY='<the K contract reference>' bun run test` → exit 0 (read
   the exit code on its own line, not a piped tail).
3. **FULL** e2e (NOT filtered): `cd e2e && bunx playwright test --project=e2e` →
   all green. (See READ-THIS: a filtered sign-off already slipped a regression.)

---

## Risks & unknowns

1. **BIGGEST RISK — the freehand outline algorithm (G1–G3).** A faithful
   perfect-freehand reimplementation has many subtle constants (streamline factor,
   thinning/easing radius curve, cap arcs, simulate-pressure velocity mix) and no
   importable reference to diff against (tldraw's copy is under the forbidden
   `@tldraw/` boundary). Mitigation: the whole design is property-tested —
   determinism, closed outline, bbox containment, **pressure-widens-the-stroke**,
   and no-NaN — pinning *behavioral* parity rather than byte-identical output
   (judgment call #1). If a property is unreachable, STOP and report (it usually
   means a wrong belief about the algorithm).
2. **Runner-up — pressure through the replay-safe event (T1/D-3).** Getting the
   device split right (real pen `z` vs mouse `0.5` + `simulatePressure`) hinges on
   populating `pressure` ONLY for `pointerType==='pen'` in the DOM normalization
   and deriving `isPen` from its presence. T1's isPen pen-vs-mouse assertions and
   G3's `simulatePressure: !isPen` assertion are the guards; the boundary test
   guards that no clock/PRNG sneaks into the "capture" path.
3. **v1 draw-shape bounds (Decision 1, judgment call #2).** Our strokes get exact
   bounds; synced v1 draw shapes render but get a loose box. Deferred, documented.
4. **K fake-RED via the `element` anchor.** Reaching K's RED by removing the Draw
   button throws a locator error (fake RED). The only clean RED is a
   present-but-inert button (revert W1's toolset entry) — spelled out in K.
5. **`Obs`/`ToolId`/`PointerInputEvent` union ripples.** Each addition trips
   typecheck across workspaces (both contract adapters; the tool-loop; the DOM
   normalizer); `bun run typecheck` is the backstop after M1/T1/H.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **Correction 1 — `draw`'s empty schema already accepts v1 shapes.** The brief
  frames typing as protecting against dropping v1 draw shapes; but
  `draw: z.looseObject({})` is *maximally permissive* today (an empty loose object
  drops nothing), so no schema change is *required* for shapes to validate/sync.
  M1's value is (a) explicit stroke-point + closed-enum style-axis validation
  (geo/arrow-consistent) and (b) intent; the drop-risk is real only if you
  over-type, which D-1 avoids. M1's RED is therefore a *positive* one (a bad-color
  / malformed-point shape must now be **rejected**), not "a v1 shape stopped being
  dropped."
- **Correction 2 — no geometry.ts change is needed for OUR strokes.** `size()`'s
  generic branch already reads `props.w/h`, so a normalized draw shape that writes
  `w/h` gets exact `localBounds` with zero geometry edits. Only v1 shapes (no
  `w/h`) fall back to 100×100 (Decision 1's documented gap). The brief left the
  bounds question open; this is the resolution.
- **Correction 3 — `PointerInputEvent` has NO `pressure` field** (verified,
  input.ts). It must be added (D-3). `script.ts`'s builders (`down/move/up`) also
  carry no pressure — `StepOptions` must gain it for FSM tests.
- **Correction 4 — the toolbar button selector already exists.** Buttons render
  `data-canvas-v2-tool={btn.id}` (verified, CanvasV2App.tsx), so K's Draw button
  is `[data-canvas-v2-tool="draw"]` with **no** new attribute — the armed-style
  contract uses this exact selector shape.
- **Correction 5 — `shapeStyle` cannot observe the shape kind.** Kind is an
  envelope field (not `props`) and not a string/number *prop*, so K needs the new
  `shapeKind(id)` Obs (H); reusing `shapeStyle` would read `null`.
- **Confirmed accurate:** `draw` is in `SHAPE_KINDS` with empty props and is a
  structural (non-text) kind; there is no draw/pen tool, `CreateKind` is
  note|text|geo|frame, no `draw` `ToolId`/button; `draw` renders via `BoxShape`
  fallback (`lookupShapeComponent` → `?? BoxShape`); `GEO_COLORS`/`STROKE_WIDTH_PX`/
  `dashArray`/`DASH_VALUES` are exported from `GeoShape.tsx` (commit `12b2809`);
  create.ts's `makeId`/`topIndex`/`whitelistStyleProps` (over `STYLE_VALUE_SETS`)
  patterns; `ShapeBody` sizes the wrapper by `localBounds` and positions by
  `worldTransform`; the browser runner's `element` anchor resolves a CSS selector
  to a bounding box; `shapeCount`/`selectedShapeIds` exist in both adapters.
```

## Execution status — LANDED (2026-07-22)

All 9 tasks landed and reviewed. Geometry crux independently certified
(determinism, no-NaN across 16 degenerate cases + 500-trial fuzz,
pressure-widens). Sign-off: typecheck green, 229 unit suites green, full
e2e 47/47 (exit 0), draw browser contract teeth-verified.

| Task | Commit |
|---|---|
| M1 schema | `8092b9f` |
| G1/G2/G3 geometry | `78b9d4c` |
| T1 pen tool + pressure | `b9573f3` |
| R1 DrawShape renderer | `1c5b71e` |
| W1 toolbar/routing/DOM-pressure | `5bed568` |
| H shapeKind Obs + K contract | `560a156` |

Known deferrals (per plan judgment calls): synced v1 draw shapes carry a
base64 `path` (not `points`) and render empty (documented, no crash) until
a decoder lands; loose 100x100 selection bounds for synced v1 strokes;
dash/fill visually no-op on freehand ink; the armed-style panel does not
yet show for the draw tool (`TOOL_TO_KIND` omits draw — no crash).
