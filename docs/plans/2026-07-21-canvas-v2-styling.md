# Canvas v2 — Full Shape-Styling Parity (Sub-cycle 2a) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 users the same style controls tldraw gives v1 —
color, fill, dash, size, font, text-align, opacity, geo variant, and
arrow-head variants — applied to the current selection, with local undo/redo.

**Architecture:** Style *application* is clean-room: tldraw's closed style
value-sets become typed Zod enums in `canvas-model`; a new batch `SetStyle`
intent in `canvas-editor` writes a style patch (plus envelope opacity) across
the whole selection with a full-shape-inverse undo entry; `canvas-react`
bodies grow to honor the props they currently ignore (opacity, dash, align).
Style *authoring* is DOM: a new contextual `StylePanel` in
`client/src/canvas-v2/` (clean-room-free, cannot import tldraw's panel)
mirrors v1's `ContextualStylePanel` layout and value-sets, reads the
selection, and dispatches `SetStyle`. One browser-level interaction contract
pins the end-to-end invariant.

**Tech stack:** Zod (model), TypeScript pure-FSM editor, React 18
(renderer/client), Bun test runner, Playwright (browser contract),
`@ensembleworks/interaction-contracts`.

**Scope boundary (decided — see Decisions):** This sub-cycle ships
**selection styling** for the four rendered body kinds (note/text/geo/frame)
plus stored-prop styling for arrows. It does **not** ship *armed / next-shape*
styling (planned as an optional appendix — pull in only if the owner scopes it
into 2a) and does **not** ship arrow/line *visual* re-rendering of
arrow-specific styles (arrows render through the SVG overlay, not a shape
body — flagged as a follow-up; the panel still *stores* those props
losslessly).

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These are the rules that were violated repeatedly on this branch. Read every
line before writing any code.

### Test runner (this is where people lose hours)
- **`bun test` is NOT our runner. NEVER run it.** It ignores our harness.
  - Full suite: `bun run test`
  - One file: `~/.bun/bin/bun <path/to/file.test.ts>`
  - One package's suite: `cd <pkg> && bun test.ts` (the package's own entry)
  - Always `export PATH="$HOME/.bun/bin:$PATH"` first.
- **Both runners are FAIL-FAST** — `process.exit(1)` on the first failing
  file. Neither prints "N passed, 1 failed." **Judge pass/fail by the EXIT
  CODE, never the output tail.**
- **`$?` in a compound command is the LAST command's status, not the suite's.**
  Run the suite as its own command, then check `echo $?` on its own line. This
  exact mistake was made on this branch.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — styling sub-cycle 2a; see plan'`
  before `bun run test` on any task whose diff touches a gated path but not
  the contracts module (i.e. every R* and P1/P2 task before P3 lands). Once
  P3 (which touches `interaction-contracts/`) is in the working tree, the gate
  passes on the diff alone.
- `server`'s typecheck is `bunx tsc --noEmit`; if `bunx` is off PATH it exits
  127 and looks like a failure. Not relevant to most tasks here (no `server/`
  changes), but the full `bun run typecheck` covers all workspaces.
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every
  command block. Agent bash cwd resets between calls.

### RED-first discipline (TDD is mandatory, every task)
1. Write the failing test. **RUN it. Capture the VERBATIM failure** into the
   task's commit message / execution note. An assertion already true at the
   parent commit proves nothing.
2. **A missing or renamed import throws at module-load and manufactures a
   FAKE, green-looking RED** (the module never runs, so "it failed" tells you
   nothing about your assertion). This was caught repeatedly on this branch.
   After writing a RED test, confirm the failure message is your *assertion*
   failing — not `SyntaxError` / `Cannot find name` / `is not a function` /
   Playwright `locator … not found`. If the failure is a load/lookup error,
   the RED is fake: fix the wiring until the test *runs* and the *assertion*
   is what fails.
3. Where a test pins a choice, name the wrong implementations it kills (a
   **mutant table** — each row: a plausible wrong impl → the assertion that
   catches it). The step-1 plan used these heavily; keep the bar.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the earlier pilot build-out
   turned out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` files are exempt). The **actual** forbidden
  patterns it enforces — verified against the test at plan time, narrower than
  folklore: imports of `loro-crdt`, `ws`, `@tldraw/`, `react`, `canvas-sync`
  / `@ensembleworks/canvas-sync`; `from '../server'`; and the literals
  `document.`, `window.`, `Date.now(`, `Math.random(`.
  - It does **NOT** currently forbid the substrings `express` or `navigator.`.
    Don't waste effort contorting comments around phantom bans — but do keep
    the *intent*: this package reads no clock/PRNG/DOM directly.
- `canvas-model` has **no** boundary test (verified — only `canvas-editor`
  scans text). The model typing tasks (M1/M2) add only Zod enums; no boundary
  risk.
- `canvas-react` and `client/` MAY touch the DOM. Style *rendering* and the
  style *panel* live there. Style *logic* (the intent, the patch, undo) is
  clean-room in `canvas-editor` / `canvas-model`.

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught **thirteen** false factual claims;
  the dominant failure mode is confident *quantitative / locational* claims.
  **Prefer wording that cannot rot** — describe by argument/behavior, not by
  raw line numbers or counts.
- The tldraw value-sets below are the *parity target*. Before hard-coding any
  enum, **read the corresponding `Default*Style` in
  `node_modules/@tldraw/tlschema/`** and match it exactly. A mismatch here is
  the single biggest risk in this feature (see Risks).

### Interaction contracts (CLAUDE.md — mandatory)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan that means **every R\* and P\* task**
  is gated. (M\* touch `canvas-model` and E\* touch `canvas-editor/src/`
  *outside* `tools/` — **not** gated.)
- Satisfy the gate for the sub-cycle by landing the **P3** contract (it
  touches `interaction-contracts/`, `canvas-editor/src/contracts/`, and
  `e2e/lib/contracts.ts`). Until P3 is in the tree, gated task-commits pass
  the suite only with the `UX_CONTRACT_PR_BODY` opt-out env set (above).
- **Obligation 3:** the new `shapeStyle` Obs MUST be implemented in BOTH
  adapters — `canvas-editor/src/contracts/fsm-runner.ts` AND
  `e2e/lib/contracts.ts`. It is genuinely available at both levels (it reads
  doc state), so implement it for real in both — **no throw-stub**.
- **Obligation 2 & 4:** P3's contract runs RED against the *unwired* panel
  from P2 (the swatch renders but its click does nothing → the shape's style
  is unchanged → a clean assertion failure, not a DOM-not-found error). A
  reviewer independently reverts P4's wiring, observes the same RED, restores.

---

## Decisions (settled — do not re-litigate)

### Parity value-sets (the target; verify each against `@tldraw/tlschema` at implement time)
Single-source the names we already own where they exist:
- **color** — the 13 `NOTE_COLORS` in `contracts/src/constants.ts`
  (`DefaultColorStyle`). Shared by note/text/geo/arrow.
- **geo variant** — the 20 `GEO_TYPES` in `contracts/src/constants.ts`
  (`GeoShapeGeoStyle`, default `rectangle`).
- **fill** — `DefaultFillStyle`. Renderer already honors
  `none`/`semi`/`solid`/`pattern`/`fill`/`lined-fill` (GeoShape). Confirm the
  enum against tlschema; type exactly its values.
- **dash** — `draw`, `solid`, `dashed`, `dotted` (`DefaultDashStyle`, default
  `draw`).
- **size** — `s`, `m`, `l`, `xl` (`DefaultSizeStyle`, default `m`).
- **font** — `draw`, `sans`, `serif`, `mono` (`DefaultFontStyle`, default
  `draw`). (The webfonts ARE loaded in v2 now — `client/src/canvas-v2/
  fonts.css` aliases `tldraw_draw/sans/serif/mono` via `@font-face`. See
  Ground-truth corrections.)
- **text-align (text kind)** — `props.textAlign`: `start`/`middle`/`end`
  (`DefaultTextAlignStyle`, default `start`). Renderer already honors this.
- **horizontal align (geo/note/arrow labels)** — `props.align`:
  `start`/`middle`/`end` (`DefaultHorizontalAlignStyle`, default `middle`).
  Renderer currently hard-centers; R3 makes it honor `align`.
- **vertical align** — `props.verticalAlign` (`DefaultVerticalAlignStyle`).
  Typed in the model; renderer-honor is a small extension folded into R3 only
  if cheap, else explicitly deferred in R3's note.
- **arrowhead start/end** — `props.arrowheadStart` / `props.arrowheadEnd`
  (`DefaultArrowheadStyle`). Typed + panel-settable; **not** visually
  re-rendered this cycle (no arrow body — see scope boundary).
- **opacity** — envelope `number`, already `z.number()`. Panel offers
  tldraw's five discrete steps `0.1 / 0.25 / 0.5 / 0.75 / 1`.

### Typed props (M1/M2)
- Add each style field as an **optional** enum (`z.enum([...]).optional()`) on
  the kinds that support it, wired through a shared `styleProps` fragment.
  Keep the per-kind schemas `z.looseObject` — unknown tldraw props still pass
  through losslessly.
- **`color` tightens from `z.string().optional()` to an enum.** This is the
  one field whose acceptance *narrows*; it carries the write-boundary risk
  (see Risks) and gets the explicit round-trip test in M1.
- Kind→axis map (type only what the kind actually supports; parity with
  tldraw's per-shape props): note = color, size, font, align, verticalAlign;
  text = color, size, font, textAlign; geo = color, fill, dash, size, font,
  align, verticalAlign, geo; arrow = color, fill, dash, size, font,
  arrowheadStart, arrowheadEnd; (frame carries none of these — name only.)

### New intent — `SetStyle` (E1)
```ts
/** Batch style write across a whole selection. Shallow-merges `props` into
 *  each id's props map (like UpdateProps, but multi-id) AND, when `opacity`
 *  is present, sets each id's ENVELOPE opacity (which UpdateProps cannot
 *  reach). Per-id tolerant: an unresolved id is SKIPPED (applyAll TOLERANCE
 *  CONTRACT), never thrown. The intent is DUMB about relevance — it applies
 *  the given patch to every id; the PANEL decides which props a kind
 *  supports before emitting. */
interface SetStyle {
  readonly type: 'SetStyle'
  readonly ids: readonly string[]
  readonly props?: Record<string, unknown>
  readonly opacity?: number
}
```
- **Undo/redo:** full-shape `putShape` inverse per id, exactly the convention
  `UpdateProps`/`Resize`/`Rotate` already use (read the pre-image *before*
  mutating; `putShape(pre)` undoes, `putShape(next)` redoes). One `UndoEntry`
  per batch (one `doc.commit()`).
- **Why a new intent, not extending `UpdateProps`:** `UpdateProps` is
  single-id and cannot touch envelope opacity; it stays reserved for embeds.

### Renderer honoring (R1–R3)
- **opacity** — applied once, kind-agnostically, on the `ShapeBody` wrapper
  div (`style.opacity = shape.opacity`). Covers every body incl. embeds.
- **dash** — `GeoShape` maps `dashed`/`dotted` to `strokeDasharray`;
  `solid`/`draw` stay solid (the hand-wobble `draw` path remains a documented
  deferral).
- **align** — `GeoShape` + `NoteShape` honor `props.align` for label
  horizontal alignment (center stays the default).

### Panel (P1/P2/P4)
- New component `client/src/canvas-v2/StylePanel.tsx`, mounted in
  `CanvasV2Session`. **Contextual**, mirroring v1's `ContextualStylePanel`:
  anchored above the selection bounds when a selection exists (armed-tool
  mode is the appendix). Hidden mid-gesture (a simple `isGesturing` flag set
  on pointerdown / cleared on pointerup/cancel).
- Pure, DOM-free helper module `style-axes.ts` computes *which* axes are
  relevant (union of selected kinds' supported axes — parity: show a control
  iff ≥1 selected shape supports it) and the *current* value per axis
  (`value | 'mixed' | undefined`). Unit-tested without React.
- On change, dispatch `SetStyle` over `editorState.selection`. The panel emits
  only kind-relevant props per axis (relevance lives in the panel; the intent
  stays dumb).

### The interaction contract (P3)
- **One browser-level contract**, `style-applies-to-selection`: seed shapes,
  select them, click the panel's blue color swatch, assert every selected
  shape's `props.color === 'blue'` (and, as a second leg, that undo restores
  the prior color). Browser-level because the panel is DOM — there is no
  "style tool" FSM a gesture could drive at fsm level (same reason
  `cross-widget-selection` / `editing-indicator` are browser-level).
- **New Obs: `shapeStyle(id, key): string | number | null`** — reads
  `props[key]`, or the envelope `opacity` when `key === 'opacity'`, or `null`
  when the shape/prop is absent. This is the observation the existing Obs
  vocabulary can't express (displacement/size/editing/spans say nothing about
  stored style). One method covers all axes uniformly.

### Armed / next-shape style — DEFERRED (owner judgment call, see below)
Recommendation: ship selection-styling as 2a; treat armed-style as sub-cycle
2b. It needs a new editor-local `nextShapeStyle` store (new `EditorState`
field + `SetNextStyle` intent), `create.ts` wiring to stamp it into new
shapes' props, and a nothing-selected panel mode — a coherent but roughly
size-doubling addition. Fully sketched in the **Appendix** so it can be pulled
into 2a without re-planning.

---

## Judgment calls surfaced to the owner

1. **Armed / next-shape styling in 2a or 2b?** The owner chose *full parity*,
   and tldraw does arm the tool. This plan **defers** it (Appendix) to keep 2a
   bite-sized and shippable, delivering full value-set parity for existing
   shapes first. Pull the Appendix into 2a if "full parity" must include
   next-shape arming now.
2. **Arrow/line visual styling.** Arrows render through the SVG **overlay**,
   not a shape body (there is no `ArrowShape` — verified;
   `registerCoreShapes` registers only note/frame/text/geo). Line has **no
   creation tool** in v2 at all. So the panel can *store* arrow/line style
   props (lossless round-trip), but *re-rendering* arrow-specific styles
   (color/dash/arrowheads on the drawn arrow) needs overlay work outside the
   shape-body renderer. This plan stores-but-doesn't-render them; closing the
   overlay gap is a follow-up. Confirm this is acceptable for "parity" or
   scope the overlay work in.
3. **`color` enum narrows validation.** Tightening `color` from `z.string()`
   to a 13-value enum means any doc value outside the enum now *fails*
   `validateShape` and is dropped by repair / rejected at the write boundary.
   Real tldraw/v1 data never carries an out-of-enum color, so this is safe
   today — but a future tldraw palette extension would require a model bump.
   Accepted as the parity cost; flagged so it's a decision, not a surprise.

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| M1 | `styleProps` fragment + tighten `color` to enum | canvas-model (no) | — | junk color now validates (was `z.string`) |
| M2 | Remaining style enums (fill/dash/size/font/align/verticalAlign/geo/arrowheads) | canvas-model (no) | M1 | junk enum value passes as loose string |
| E1 | `SetStyle` intent type + `applyOne` handler + undo/redo | canvas-editor/src (no) | M1 | `SetStyle` unhandled in switch |
| R1 | `ShapeBody` honors `shape.opacity` | canvas-react (YES) | — | opacity never in wrapper style |
| R2 | `GeoShape` honors `props.dash` | canvas-react (YES) | — | dash ignored, always solid |
| R3 | `GeoShape`+`NoteShape` honor `props.align` | canvas-react (YES) | — | label always centered |
| P1 | pure `style-axes.ts` helpers | client/canvas-v2 (YES) | M1,M2 | helpers absent |
| P2 | `StylePanel.tsx` renders + mounts (UNWIRED) | client/canvas-v2 (YES) | P1 | panel/swatch absent from DOM |
| P3 | browser contract `style-applies-to-selection` + `shapeStyle` Obs (both adapters) | interaction-contracts + e2e + fsm-runner (YES/satisfies gate) | E1,P2 | swatch click leaves shape color unchanged |
| P4 | wire panel → `SetStyle` (+ opacity steps) | client/canvas-v2 (YES) | P3 | turns P3 GREEN |

Ten core tasks. Land in table order (M→E→R→P). R\* are independent of E\*
(they only read props) and may interleave, but keep the numbering for review
sanity. Appendix A1–A4 optional.

---

## Task M1 — `styleProps` fragment + tighten `color` to an enum

**Files:**
- Modify: `canvas-model/src/shape.ts` (the `withText` helper + `propsByKind`)
- Test: `canvas-model/src/shape.test.ts` (create if absent; else extend)

**Step 1 — Write the failing test.** Assert the *narrowed* acceptance:
```ts
// a real palette color validates on a note
assert.ok(validateShape(noteWith({ color: 'blue' })).ok)
// a junk color is now REJECTED (this is the behavior change M1 introduces)
assert.ok(!validateShape(noteWith({ color: 'chartreuse' })).ok)
// unknown NON-style keys still pass through (looseObject preserved)
assert.ok(validateShape(noteWith({ color: 'blue', wobble: 7 })).ok)
```
(`noteWith(props)` = a minimal valid note envelope with those props merged in.)

**Step 2 — Run it, expect RED.** `cd /home/stag/src/projects/ensembleworks &&
export PATH="$HOME/.bun/bin:$PATH" && ~/.bun/bin/bun canvas-model/src/shape.test.ts;
echo "exit=$?"`. Expected: the `chartreuse` assertion FAILS (today `color` is
`z.string()`, so junk validates). Confirm it's the *assertion* failing, not a
load error. **Capture verbatim.**

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| leave `color: z.string()` | `chartreuse` accepted → assertion fails |
| switch kind schema to `z.object` (strict) | `wobble` passthrough key rejected → third assertion fails |
| enum missing a real name (e.g. drop `white`) | add a `white` acceptance row |

**Step 3 — Implement.** Introduce a shared `COLOR = z.enum(NOTE_COLORS)`
(import the 13 names — re-export from `contracts` or inline the verified list
with a comment pointing at `DefaultColorStyle`). Replace `color:
z.string().optional()` in `withText` with `color: COLOR.optional()`. Keep
`withText` a `z.looseObject`.

**Step 4 — Run, expect GREEN.** Same command, `exit=0`. Then
`bun run typecheck` (model changes ripple to importers).

**Step 5 — Commit.**
```bash
git add canvas-model/src/shape.ts canvas-model/src/shape.test.ts
git commit -m "feat(canvas-model): type shape color as a tldraw-parity enum"
```

---

## Task M2 — Remaining style enums

**Files:** same as M1.

**Step 1 — Failing test.** For each new axis, one accept + one reject row, on a
kind that supports it:
```ts
assert.ok(validateShape(geoWith({ fill: 'solid' })).ok)
assert.ok(!validateShape(geoWith({ fill: 'plaid' })).ok)
assert.ok(validateShape(geoWith({ dash: 'dotted' })).ok)
assert.ok(!validateShape(geoWith({ dash: 'wiggly' })).ok)
assert.ok(validateShape(geoWith({ size: 'xl', font: 'mono', align: 'end', geo: 'ellipse' })).ok)
assert.ok(!validateShape(geoWith({ size: 'enormous' })).ok)
assert.ok(validateShape(arrowWith({ arrowheadStart: 'triangle', arrowheadEnd: 'none' })).ok)
assert.ok(!validateShape(arrowWith({ arrowheadEnd: 'grappling-hook' })).ok)
// a kind that does NOT support an axis ignores it as a passthrough key (still ok)
assert.ok(validateShape(textWith({ geo: 'ellipse' })).ok) // text has no geo axis; loose passthrough
```

**Step 2 — RED.** Run the file; expect the reject rows to FAIL (these values
pass today as loose strings). Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| type `fill`/`dash`/… as `z.string()` | the reject rows accept junk |
| put every axis on every kind (over-broad) | fine for accepts, but keep the "text supports no geo axis, still passes as loose key" row honest — don't assert text *rejects* `geo` |
| enum values not matching tlschema | verify each `Default*Style` before hard-coding; a wrong member fails an accept row |

**Step 3 — Implement.** Add a `styleProps(...axes)` builder returning a
`z.looseObject` fragment with the requested optional enums, and compose per
kind per the Decisions kind→axis map. Verify every enum against
`node_modules/@tldraw/tlschema/` first (record the file you read in a
rot-proof comment — cite the `Default*Style` name, not a line number).

**Step 4 — GREEN + `bun run typecheck`.**

**Step 5 — Commit.**
```bash
git commit -am "feat(canvas-model): type fill/dash/size/font/align/geo/arrowhead props to tldraw enums"
```

---

## Task E1 — `SetStyle` intent + handler + undo/redo

**Files:**
- Modify: `canvas-editor/src/intents.ts` (interface + `Intent` union)
- Modify: `canvas-editor/src/editor.ts` (`applyOne` switch)
- Test: `canvas-editor/src/editor.test.ts` (extend — find the `UpdateProps`
  cases and mirror them)

**Step 1 — Failing test.** Drive a real `Editor` over a `LoroCanvasDoc` with
two seeded shapes:
```ts
editor.applyAll([{ type: 'SetStyle', ids: [a, b], props: { color: 'blue' }, opacity: 0.5 }])
// both shapes got the prop AND the envelope opacity
assert.equal(doc.getShape(a)!.props.color, 'blue')
assert.equal(doc.getShape(b)!.props.color, 'blue')
assert.equal(doc.getShape(a)!.opacity, 0.5)
// unresolved id is skipped, not thrown
editor.applyAll([{ type: 'SetStyle', ids: ['shape:ghost'], props: { color: 'red' } }]) // no throw
// undo restores BOTH shapes' prior color and opacity, in one step
editor.undo()
assert.equal(doc.getShape(a)!.props.color, <priorColorA>)
assert.equal(doc.getShape(a)!.opacity, <priorOpacityA>)
// redo reapplies
editor.redo()
assert.equal(doc.getShape(a)!.props.color, 'blue')
```
Also assert **one commit per batch** (e.g. spy/count via a doc commit hook the
existing editor tests already use, or assert a single `UndoEntry` was pushed —
mirror whatever `UpdateProps`'s existing test does).

**Step 2 — RED.** Run `canvas-editor`'s suite entry (`cd canvas-editor &&
~/.bun/bin/bun test.ts` or the single test file). Expected failure: `SetStyle`
is not in the union / hits the switch default → a type error or an unhandled
intent. **If it's a *type* error preventing the file from loading, that's a
fake RED** — add the `SetStyle` interface + union member FIRST (so it compiles
and the switch genuinely lacks the case), then the RED is the *runtime*
"nothing changed" assertion. Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| apply to `ids[0]` only | shape `b` unchanged |
| merge props but ignore `opacity` | `a.opacity` still prior |
| overwrite props (not shallow-merge) | seed each shape with an extra prop and assert it survives |
| no undo entry pushed | `undo()` no-ops, color stays blue |
| `commit()` per id | one-commit / single-UndoEntry assertion fails |
| throw on unknown id | ghost-id batch throws |

**Step 3 — Implement.** In `applyOne`, a `case 'SetStyle'`: for each id, read
`shape = this.doc.getShape(id)`; skip if absent; compute `next = { ...shape,
props: intent.props ? { ...shape.props, ...intent.props } : shape.props,
opacity: intent.opacity ?? shape.opacity }`; `this.doc.putShape(next)`; push
`undo: { op:'putShape', shape }`, `redo: { op:'putShape', shape: next }`.
Return `docMutated: true` iff at least one id resolved. (Follows the exact
`UpdateProps` pre-image/full-shape-inverse pattern already in the file.)

**Step 4 — GREEN + `bun run typecheck`.**

**Step 5 — Commit.**
```bash
git commit -am "feat(canvas-editor): SetStyle intent — batch style patch + envelope opacity with undo"
```

---

## Task R1 — `ShapeBody` honors `shape.opacity`

**Files:**
- Modify: `canvas-react/src/ShapeBody.tsx`
- Test: `canvas-react/src/shape-layer.test.ts` (or a new `shape-body.test.ts`)

> **ux-contract:** gated path. Run gated tasks with
> `UX_CONTRACT_PR_BODY='ux-contract: none — styling sub-cycle 2a; see plan'`
> until P3 lands. The final PR body carries the real contract (P3).

**Step 1 — Failing test.** Render a `ShapeBody` (renderToStaticMarkup, the
package's existing idiom) for a shape with `opacity: 0.3`; assert the wrapper
div's inline style includes `opacity:0.3`. Second row: `opacity: 1` → the
style is `opacity:1` (or omitted — pick one and assert it precisely).

**Step 2 — RED.** `~/.bun/bin/bun canvas-react/src/shape-layer.test.ts;
echo exit=$?`. Expected: no `opacity` in the rendered style. Confirm it's the
assertion, not a render error. Capture verbatim.

**Mutant table:** apply opacity to the inner `<Component>` instead of the
wrapper (embeds would double-dim / miss it) → assert it's on the
`[data-shape-id]` wrapper specifically.

**Step 3 — Implement.** Add `opacity: shape.opacity` to the wrapper div's
`style` in `ShapeBody`.

**Step 4 — GREEN** (`UX_CONTRACT_PR_BODY` set) **+ `bun run typecheck`.**

**Step 5 — Commit.**
```bash
git commit -am "feat(canvas-react): ShapeBody applies shape.opacity to every body"
```

---

## Task R2 — `GeoShape` honors `props.dash`

**Files:**
- Modify: `canvas-react/src/shapes/GeoShape.tsx` (extend `geoStyle` +
  `geoPath` to carry a `strokeDasharray`)
- Test: `canvas-react/src/shapes/geo-shape.test.ts`

**Step 1 — Failing test.** For a geo shape:
- `dash: 'dashed'` → rendered SVG stroke element carries a `stroke-dasharray`
  (non-empty).
- `dash: 'dotted'` → a *different* dasharray (dotted pattern) than dashed.
- `dash: 'solid'` and `dash: 'draw'` (default) → no `stroke-dasharray`.
Pin the actual arrays against tldraw's dash resolution (read
`node_modules/tldraw/.../shared/` — cite the source; the dash arrays scale
with `strokeWidth`, so express them relative to `style.strokeWidth`, not as a
raw magic number that will rot).

**Step 2 — RED.** Run the geo test file; expected: dashed/dotted render solid
(no dasharray). Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| same array for dashed & dotted | the "different from each other" row |
| apply dasharray to `draw`/`solid` too | the solid/draw "no dasharray" rows |
| fixed array ignoring strokeWidth | assert array scales with `size` (compare `m` vs `xl`) |

**Step 3 — Implement.** Resolve a `strokeDasharray` from `props.dash` +
`strokeWidth` in `geoStyle`; thread it into the stroke element in `geoPath`.
Keep the `draw` wobble deferral documented (draw → solid, unchanged).

**Step 4 — GREEN + typecheck. Step 5 — Commit.**
```bash
git commit -am "feat(canvas-react): GeoShape honors props.dash (dashed/dotted stroke arrays)"
```

---

## Task R3 — `GeoShape` + `NoteShape` honor `props.align`

**Files:**
- Modify: `canvas-react/src/shapes/GeoShape.tsx`,
  `canvas-react/src/shapes/NoteShape.tsx`
- Test: `geo-shape.test.ts`, `note-shape.test.ts`

**Step 1 — Failing test.** For each of geo and note: `align: 'start'` → label
container `text-align:left` / `justify-content:flex-start`; `align: 'end'` →
right/flex-end; absent → center (default preserved). (Map
start→left/flex-start, middle→center, end→right/flex-end.)

**Step 2 — RED.** Both label bodies currently hard-center
(`GEO_LABEL_TEXT_ALIGN='center'`, `NOTE_TEXT_ALIGN='center'`). Expected:
`start`/`end` still render centered. Capture verbatim.

**Mutant table:** honor `align` on geo but not note (or vice-versa) → the
un-fixed body's row fails; map `end`→left (inverted) → the end row fails.

**Step 3 — Implement.** Resolve horizontal alignment from `props.align`
(default `middle`→center) in both bodies. If honoring `verticalAlign` is
cheap in the same edit, include it with its own test rows; otherwise leave a
one-line documented deferral note and DO NOT assert it.

**Step 4 — GREEN + typecheck. Step 5 — Commit.**
```bash
git commit -am "feat(canvas-react): geo/note labels honor props.align"
```

---

## Task P1 — pure `style-axes.ts` helpers

**Files:**
- Create: `client/src/canvas-v2/style-axes.ts`
- Test: `client/src/canvas-v2/style-axes.test.ts`

> gated path — `UX_CONTRACT_PR_BODY` opt-out until P3.

**Step 1 — Failing test** (pure, no React/DOM):
```ts
// relevance = union of selected kinds' supported axes
relevantAxes([note]) // -> ['color','size','font','align','opacity', ...]
relevantAxes([geo]) includes 'fill','dash','geo'
relevantAxes([note, geo]) === union of both
relevantAxes([]) === []           // nothing selected -> no axes (armed mode is the appendix)
// current value: agreeing selection -> the value; disagreeing -> 'mixed'; unset -> undefined
currentValue([blueNote, blueNote], 'color') === 'blue'
currentValue([blueNote, redNote], 'color') === 'mixed'
currentValue([bareNote], 'color') === undefined  // or the kind default — pick one, assert it
// opacity reads the ENVELOPE, not props
currentValue([{...note, opacity: 0.5}], 'opacity') === 0.5
```
Define the value-sets (`STYLE_VALUE_SETS`) and per-kind support map here; keep
them in sync with the model enums (import the shared name lists, don't
re-type).

**Step 2 — RED.** `~/.bun/bin/bun client/src/canvas-v2/style-axes.test.ts;
echo exit=$?` — module/functions absent. This is the *expected* absent-symbol
RED for a brand-new pure module; write minimal stubs returning `[]`/`undefined`
FIRST if you want the assertion (not the import) to be what fails, then flesh
out. Capture verbatim.

**Mutant table:** intersection instead of union for relevance (a mixed
selection would hide controls a subset supports) → the `[note, geo]` union
row; reading `props.opacity` instead of the envelope → the opacity row.

**Step 3 — Implement** the helpers purely. **Step 4 — GREEN. Step 5 — Commit.**
```bash
git commit -am "feat(client): pure style-axes helpers (relevance + current-value + value-sets)"
```

---

## Task P2 — `StylePanel.tsx` renders + mounts (UNWIRED)

**Files:**
- Create: `client/src/canvas-v2/StylePanel.tsx`
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (mount in `CanvasV2Session`;
  add the `isGesturing` flag)
- Test: `client/src/canvas-v2/StylePanel.test.ts`

> gated path — `UX_CONTRACT_PR_BODY` opt-out until P3.

**Step 1 — Failing test.** Render `StylePanel` with a props-injected
selection + snapshot (don't boot the whole app):
- a single blue note selected → a color-swatch row renders, the blue swatch
  marked current (`aria-pressed` / `data-current`); a `[data-testid="ew-style-
  panel"]` (or `[data-canvas-v2-style-panel]`) container is present.
- empty selection → panel renders nothing (returns null).
- controls are present for every relevant axis (color/size/font/align for a
  note; also fill/dash/geo when a geo is selected).
- **give each control a stable, queryable hook** the P3 browser contract will
  target, e.g. `data-style-control="color"` and per-swatch
  `data-style-value="blue"`. (P3 depends on these selectors existing here.)

**Step 2 — RED.** Run the file; component absent → assertion (or, initially,
absent-symbol) failure. Capture verbatim.

**Step 3 — Implement.** Build the panel reading `relevantAxes` /
`currentValue` from P1. Render swatch/segmented-button rows. **Wire onClick to
a `onStyleChange(axis, value)` PROP that the parent does NOT yet act on**
(unwired — P4 wires it). Contextual positioning mirroring
`ContextualStylePanel` (above selection bounds; hidden when `isGesturing`).
Mount `<StylePanel selection=… snapshot=… onStyleChange={noop-for-now} />` in
`CanvasV2Session` next to the other overlays, and add `isGesturing` state
(set on pointerdown in `handleInput`, cleared on pointerup / `cancelAndReset`).

**Step 4 — GREEN** (opt-out env set) **+ `bun run typecheck`.**

**Step 5 — Commit.**
```bash
git commit -am "feat(client): contextual StylePanel renders selection styles (unwired)"
```

---

## Task P3 — browser contract `style-applies-to-selection` + `shapeStyle` Obs

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `shapeStyle` to `Obs`)
- Create: `interaction-contracts/src/contracts/style-applies-to-selection.ts`
- Modify: `interaction-contracts/src/index.ts` (register in `CONTRACTS`)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (implement `shapeStyle`
  for real — reads `editor.doc.getShape`)
- Modify: `e2e/lib/contracts.ts` (pre-sample style values; implement
  `shapeStyle`)
- Modify: `e2e/tests/contracts.spec.ts` if it enumerates contracts explicitly

> This task touches `interaction-contracts/` + `canvas-editor/src/contracts/`
> + `e2e/lib/contracts.ts` — it **satisfies the presence gate for the whole
> sub-cycle**. From here, `bun run test` passes on the diff without the
> opt-out env.

**Step 1 — Extend `Obs`.** Add:
```ts
/** A shape's stored style value: props[key], or the envelope opacity when
 *  key === 'opacity', or null when the shape/prop is absent. Available at
 *  BOTH levels (reads doc state) — no throw-stub. */
shapeStyle(id: string, key: string): string | number | null
```
Implement in `fsm-runner.ts`'s `makeObs` (trivial: `getShape(id)` → `key ===
'opacity' ? shape.opacity : shape.props[key] ?? null`). Implement in
`e2e/lib/contracts.ts` by pre-sampling each scene shape's props+opacity in
`sampleActor` (via `window.__ew.doc.getShape`) and reading from that snapshot
in `pageObs` (synchronous, like the other pre-sampled fields).

**Step 2 — Write the contract.** `level: 'browser'`, `tool: 'select'`,
`when: 'at-end'`. Scene: two geo shapes. Gesture: marquee-select both, then a
`down`/`up` on the panel's blue color swatch (anchor: a `point` resolved to
the `[data-style-control="color"] [data-style-value="blue"]` element — follow
`resolveAnchor`; you may need a small `ref: 'element'` selector extension, OR
seed the panel at a known screen spot and use a point anchor — prefer the
smallest change; if a selector anchor is needed, extend `Anchor` and BOTH
adapters, mirroring the Pilot-2 shape-anchor precedent). `check`: for each
seeded id, `obs.shapeStyle(id, 'color') === 'blue'` else a failure string;
second leg (optional, same contract or a sibling): after an undo op in the
gesture, color is back to the seeded value.

**Step 3 — RUN IT RED against P2's unwired panel.** The swatch renders (P2)
but its click does nothing (unwired), so `shapeStyle(id,'color')` stays the
seeded default → a **clean assertion failure** ("expected blue, got …"), NOT a
locator-not-found error. If you get locator-not-found, the RED is *fake* — the
selector/anchor is wrong; fix until the swatch is actually clicked and the
*assertion* is what fails. Run via the e2e contract spec against a live
`?engine=v2` room (see `e2e/` README / existing `contracts.spec.ts`
invocation). **Capture the verbatim RED** — this is the evidence P4 turns
GREEN and the reviewer independently reproduces.

**Step 4 — Do NOT implement the fix here.** P3 lands the contract + Obs RED.
`bun run typecheck` must pass (both adapters implement `shapeStyle`, so the
shared `Obs` interface typechecks). The fsm-runner `shapeStyle` can be
exercised by a tiny fsm-level unit if you want green coverage of the adapter
itself, but the *contract* stays RED until P4.

**Step 5 — Commit** (RED contract + working Obs in both adapters):
```bash
git commit -am "test(contracts): style-applies-to-selection contract + shapeStyle Obs (RED)"
```

---

## Task P4 — wire `StylePanel` → `SetStyle` (turns P3 GREEN)

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (the `onStyleChange` handler)
- Modify: `client/src/canvas-v2/StylePanel.tsx` (opacity step buttons →
  `onStyleChange('opacity', 0.5)` etc., if not already emitted in P2)
- Test: the P3 browser contract (now GREEN) + a `StylePanel.test.ts` unit that
  `onStyleChange('color','blue')` calls the injected dispatch with
  `SetStyle{ ids: selection, props: { color: 'blue' } }`, and
  `onStyleChange('opacity',0.5)` emits `SetStyle{ ids, opacity: 0.5 }`.

**Step 1 — Failing unit test** for the wiring: inject a spy dispatch, fire
`onStyleChange`, assert the exact `SetStyle` intent (ids = current selection;
`props` for prop axes; `opacity` for the opacity axis — NOT `props.opacity`).

**Step 2 — RED.** Handler is a noop (P2). Assertion: dispatch never called /
wrong intent. Capture verbatim. Also note the P3 contract is currently RED.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| put opacity in `props` | opacity assertion (envelope vs props) |
| dispatch `UpdateProps` (single id) | multi-id selection → only first changes; contract's second-shape check fails |
| emit ids = whole doc, not selection | seed an unselected third shape, assert it's untouched |

**Step 3 — Implement.** In `CanvasV2Session`, define `onStyleChange(axis,
value)` → build a `SetStyle` over `editor.get().selection` (opacity axis →
`{opacity}`; every other axis → `{props: {[axis]: value}}`) and `dispatch`
it. Pass it to `<StylePanel>`. Emit opacity steps from the panel.

**Step 4 — GREEN.** The unit passes AND the P3 contract now passes
(re-run it). `bun run test` (now the gate passes on the diff — P3's contracts
touch is in the tree) with `echo $?` on its own line; `bun run typecheck`.

**Step 5 — Commit.**
```bash
git commit -am "feat(client): wire StylePanel to SetStyle over the selection (contract GREEN)"
```

---

## PR body — required content

The whole sub-cycle is interaction-bearing (`canvas-react/src/`,
`client/src/canvas-v2/`). The PR body MUST contain, verbatim, an interaction-
contract accounting. Because P3 adds a real contract, the honest form is a
*contract reference*, not an opt-out:

```
## Interaction contracts
Adds browser contract `style-applies-to-selection`
(interaction-contracts/src/contracts/style-applies-to-selection.ts) + a new
`Obs.shapeStyle` observation implemented in BOTH adapters
(canvas-editor/src/contracts/fsm-runner.ts, e2e/lib/contracts.ts).
RED (verbatim, against P2's unwired panel): <paste>
GREEN (after P4 wiring): <paste>
Reviewer reproduced red→green by reverting P4. 
```

If, and only if, the reviewer splits P1/P2 into their own PR *ahead* of P3,
that earlier PR carries `ux-contract: none — panel scaffolding only; the
governing contract lands with the wiring in a follow-up PR (see plan P3)` —
but the intended shape is one PR for the whole sub-cycle, contract included.

---

## Risks & unknowns

1. **BIGGEST RISK — the enum-vs-write-boundary coupling.** Tightening `color`
   (and typing the other axes) means the model's enums become a *gate*: any
   value outside them fails `validateShape` and is dropped by repair /
   rejected at the write boundary. If an enum doesn't *exactly* match tldraw's
   `Default*Style`, real synced v1 shapes get silently dropped. Mitigation:
   verify every enum against `@tldraw/tlschema` at implement time (M1/M2), and
   the P3 contract exercises a real round-trip. This is why M1's reject-junk
   test and the "cite the `Default*Style`, not a line number" rule exist.
2. **Contract anchor onto a DOM control.** The existing `Anchor` union
   resolves `point` and `shape` anchors; clicking a panel *swatch* may need an
   `element`/selector anchor. Extending `Anchor` ripples into BOTH runner
   adapters (Pilot-2 precedent). Prefer the smallest viable approach (fixed
   panel position + point anchor) before growing the vocabulary.
3. **Arrow/line visual styling gap** (judgment call #2) — the panel stores
   arrow style props but nothing re-renders them (no arrow body). If "parity"
   must include visibly-styled arrows, that overlay work is unplanned here.
4. **`ContextualStylePanel` positioning depends on tldraw hooks** v2 can't
   use (`getSelectionRotatedScreenBounds`, `useMidGesture`). The v2 panel must
   compute selection screen-bounds from `editorState` + camera +
   `worldBounds`/`worldTransform` (canvas-model) itself. Straightforward but
   net-new; keep P2's positioning simple (a bounding box from the selected
   shapes' world bounds → screen) and don't gold-plate the flip logic.

---

## Ground-truth corrections (verified against the tree at plan time)

The brief's ground truth was accurate except:
- **Font webfonts ARE loaded in v2 now.** `client/src/canvas-v2/fonts.css`
  (Task C6b) defines `@font-face` for `tldraw_draw/sans/serif/mono` (backed by
  self-hosted IBM Plex / Shantell Sans faces) and is imported by
  `CanvasV2App.tsx`. The in-file "parity gap" comments in `NoteShape.tsx` /
  `TextShape.tsx` are now stale at the app layer. (The `font` axis still needs
  no renderer change — bodies already emit the right family strings.)
- **`canvas-editor`'s boundary forbidden-set is narrower than stated.** It
  does NOT forbid `express` or `navigator.`; the enforced patterns are imports
  of `loro-crdt`/`ws`/`@tldraw/`/`react`/`canvas-sync`, `from '../server'`,
  and the literals `document.` / `window.` / `Date.now(` / `Math.random(`.
- **`props.dash` is not literally read today.** `GeoShape`'s header documents
  the dash deferral, but `geoStyle` never reads `props.dash` into a variable —
  R2 is the first code to read it (a fresh, not a modified, code path).
- Everything else — `opacity` as envelope (`shape.ts`), `UpdateProps`
  single-id/shallow-merge, `SetStyle`'s absence from the `Intent` union, the
  `ShapeBody` never applying `opacity`, `TOOL_BUTTONS` and the
  Escape/Delete/Undo/Redo-only shortcuts, and v1's `StylePanel: null` +
  `ContextualStylePanel` — verified accurate.

---

## Appendix (OPTIONAL) — armed / next-shape styling (sub-cycle 2b, or pull into 2a)

Only if the owner scopes arming into 2a. Sketch, same TDD bar as the core:

- **A1 (canvas-editor):** add `nextShapeStyle: Record<string, unknown>` to
  `EditorState` (editor-local view state, like camera/selection) + a
  `SetNextStyle` view intent that merges into it. No doc mutation, no undo
  entry (it's view state). RED: field/intent absent.
- **A2 (canvas-editor/src/tools/create.ts — GATED):** `propsFor` stamps
  `editor.get().nextShapeStyle` into a newly-created shape's props. RED: a
  new shape ignores the armed style. **Touches `tools/` → needs a contract**
  (A4).
- **A3 (client/canvas-v2 — GATED):** `StylePanel` gains a nothing-selected
  mode — when a `STYLE_TOOLS` tool is armed with an empty selection, show the
  armed `nextShapeStyle` and write `SetNextStyle` instead of `SetStyle`.
  `relevantAxes([])` gains a "for this armed tool" overload.
- **A4 (contract):** browser contract `armed-style-applies-to-created-shape` —
  arm a style with nothing selected, create a shape, assert its
  `shapeStyle(newId,'color')` matches the armed value (reuses P3's
  `shapeStyle` Obs). RED reachable against A3-before-A2 wiring.
