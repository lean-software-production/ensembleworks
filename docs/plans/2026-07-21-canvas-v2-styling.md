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
**selection styling** for the four rendered body kinds (note/text/geo/frame),
stored-prop styling for arrows, **and armed / next-shape styling** (owner
decision 2026-07-21 — full parity, so the tool arms the next-created shape's
style when nothing is selected, exactly as tldraw does). It does **not** ship
arrow/line *visual* re-rendering of arrow-specific styles (arrows render
through the SVG overlay, not a shape body — flagged as a follow-up; the panel
still *stores* those props losslessly).

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

### Panel (P1/P2/P4; armed mode AS3)
- New component `client/src/canvas-v2/StylePanel.tsx`, mounted in
  `CanvasV2Session`. **Contextual**, mirroring v1's `ContextualStylePanel`:
  anchored above the selection bounds when a selection exists (the armed-tool,
  nothing-selected mode is added in AS3). Hidden mid-gesture (a simple
  `isGesturing` flag set on pointerdown / cleared on pointerup/cancel).
- Pure, DOM-free helper module `style-axes.ts` computes *which* axes are
  relevant (union of selected kinds' supported axes — parity: show a control
  iff ≥1 selected shape supports it) and the *current* value per axis
  (`value | 'mixed' | undefined`). Unit-tested without React.
- On change, dispatch `SetStyle` over `editorState.selection`. The panel emits
  only kind-relevant props per axis (relevance lives in the panel; the intent
  stays dumb).

### The interaction contracts (P3 + AS4)
Two browser-level contracts. **P3** (`style-applies-to-selection`) pins
selection styling; **AS4** (`armed-style-applies-to-created-shape`) pins armed
styling. P3 adds the `shapeStyle` Obs; AS4 adds a `selectedShapeIds` Obs and
reuses `shapeStyle`.
- **P3 — `style-applies-to-selection`**: seed shapes,
  select them, click the panel's blue color swatch, assert every selected
  shape's `props.color === 'blue'` (and, as a second leg, that undo restores
  the prior color). Browser-level because the panel is DOM — there is no
  "style tool" FSM a gesture could drive at fsm level (same reason
  `cross-widget-selection` / `editing-indicator` are browser-level).
- **New Obs (P3): `shapeStyle(id, key): string | number | null`** — reads
  `props[key]`, or the envelope `opacity` when `key === 'opacity'`, or `null`
  when the shape/prop is absent. This is the observation the existing Obs
  vocabulary can't express (displacement/size/editing/spans say nothing about
  stored style). One method covers all axes uniformly.
- **AS4 — `armed-style-applies-to-created-shape`**: with nothing selected,
  arm a style tool (e.g. geo), click the panel's blue swatch (armed mode →
  `SetNextStyle`), then click empty canvas to create a shape; assert the new
  shape is blue. Because the new id is minted from crypto-random and cannot be
  predicted, the contract discovers it via the create tool's auto-selection
  (create.ts:137) and the new Obs below, then reuses `shapeStyle` for the
  value.
- **New Obs (AS4): `selectedShapeIds(): readonly string[]`** — the current
  editor selection (fsm: `[...editor.get().selection]`; browser: read
  `window.__ew.editor.get().selection`). General and reusable, not a
  styling-specific probe. AS4 reuses `shapeStyle` for the value assertion —
  the armed contract needs NO style-specific new observation beyond this
  selection reader.

### Armed / next-shape style — CORE (owner decision 2026-07-21: full parity)
Tasks AS1–AS4. Design, verified against disk:
- **Representation:** a new editor-local field
  `EditorState.nextShapeStyle: Record<string, unknown>` (editor.ts:42-47 is
  where `EditorState` is declared — camera/selection/hover/editingId, all
  `readonly`, never persisted to the CRDT; `nextShapeStyle` belongs exactly
  here, alongside them, INITIAL_STATE at editor.ts:49). **NOT** in the create
  tool's `CreateState` (create.ts:35 — `Idle | Pointing | Dragging`): putting
  style in per-tool FSM state would (a) not be shared across tools and (b)
  risk replay purity. tldraw likewise keeps `stylesForNextShape` in
  instance-global state, not per-tool.
- **Set it:** a `SetNextStyle` **view** intent (touches only the editor-local
  store — no doc mutation, no `commit()`, no undo entry, exactly like
  `SetCamera`/`SetSelection`) that shallow-merges its patch into
  `nextShapeStyle`.
- **Read it:** the create tool reads `editor.get().nextShapeStyle` live inside
  `onEvent` and merges it into a new shape's props in `makeShape`/`propsFor`
  (create.ts:63-72). This is the SAME live-editor-read the tool already does
  for the camera (`worldOf` → `screenToWorld(editor.get().camera, …)`), so it
  needs no `CreateState` change and keeps the FSM a pure function of
  `(state, event)` reading the injected editor — armed style rides the camera
  precedent, not the recorded-script state.
- **Panel:** when `editorState.selection.size === 0` AND a style-bearing tool
  is armed (`activeToolId` ∈ note/text/geo/arrow/frame — CanvasV2Session's
  `activeToolId` state), the panel shows the armed `nextShapeStyle` and writes
  `SetNextStyle` instead of `SetStyle`. Parity with tldraw: style the
  selection if there is one, else arm the tool.
- **Discovering the created shape (contract):** the create tool auto-selects
  the shape it mints (`finalizeIntents` pushes `SetSelection([shape.id])`,
  create.ts:137). The browser runner cannot predict the new id (it's minted
  from crypto-random `random()`), so AS4's contract reads the newly-selected
  id via a **new `selectedShapeIds()` Obs** and then reuses **`shapeStyle`**
  (from P3) for the value assertion. See AS4.

---

## Judgment calls surfaced to the owner

1. **Armed / next-shape styling in 2a or 2b? — RESOLVED (owner, 2026-07-21):
   IN SCOPE for 2a.** Full parity means the tool arms the next-created shape's
   style when nothing is selected. Promoted from an appendix into core tasks
   **AS1–AS4** (see the task table and their sections). Design settled in the
   Decisions "Armed / next-shape style — CORE" block.
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
| AS1 | `EditorState.nextShapeStyle` + `SetNextStyle` view intent | canvas-editor/src (no) | E1 | field/intent absent |
| AS3 | `StylePanel` armed mode (empty selection + armed tool → renders + writes `SetNextStyle`) | client/canvas-v2 (YES) | AS1,P4 | armed panel renders nothing / click sets nothing |
| AS4 | browser contract `armed-style-applies-to-created-shape` + `selectedShapeIds` Obs | interaction-contracts + e2e + fsm-runner (YES/satisfies gate) | AS3 (and RED against un-landed AS2) | armed → created shape stays default color |
| AS2 | create tool reads `nextShapeStyle` into new-shape props | canvas-editor/src/tools/ (YES) | AS1 | created shape ignores armed style |

Fourteen core tasks. Land in table order (M→E→R→P→AS). R\* are independent of
E\* (they only read props) and may interleave, but keep the numbering for
review sanity.

**Armed-style ordering subtlety (read before touching AS\*):** AS2 (the
create-path read) depends only on AS1, yet is sequenced **last** — after
AS3/AS4 — on purpose. AS4's browser contract must have a *reachable RED*, and
the only way the "arm tool → create inherits" invariant fails cleanly is:
arming WORKS (AS3 landed, so `nextShapeStyle` is set) but the create path
IGNORES it (AS2 not yet landed) → the created shape renders its default color
→ a clean "expected blue, got black" assertion failure. If AS2 landed first,
AS4 would be born GREEN with no RED. So AS3 → AS4(RED) → AS2(GREEN). AS2 still
carries its OWN fsm-level unit RED inside its task (the one-line read is the
fix for that unit test too), so the create-path change is independently
red-then-green, not merely proven by the browser contract.

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
relevantAxes([]) === []           // nothing selected -> no axes (armed mode uses relevantAxesForTool, added in AS3)
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

## Task AS1 — `EditorState.nextShapeStyle` + `SetNextStyle` view intent

**Files:**
- Modify: `canvas-editor/src/editor.ts` (`EditorState` interface :42-47,
  `INITIAL_STATE` :49, `applyOne`)
- Modify: `canvas-editor/src/intents.ts` (interface + `Intent` union — the
  view-intents group next to `SetCamera`/`SetSelection`)
- Test: `canvas-editor/src/editor.test.ts` (extend, near the `SetSelection`
  view-intent cases)

> Not gated (`canvas-editor/src`, outside `tools/`).

**Step 1 — Failing test.**
```ts
// starts empty
assert.deepEqual([...Object.keys(editor.get().nextShapeStyle)], [])
editor.apply({ type: 'SetNextStyle', props: { color: 'blue' } })
assert.equal(editor.get().nextShapeStyle.color, 'blue')
// shallow-merges, does not replace
editor.apply({ type: 'SetNextStyle', props: { size: 'l' } })
assert.equal(editor.get().nextShapeStyle.color, 'blue')
assert.equal(editor.get().nextShapeStyle.size, 'l')
// it's a VIEW intent — no doc mutation, no undo entry
const before = editor.canUndo()
editor.apply({ type: 'SetNextStyle', props: { color: 'red' } })
assert.equal(editor.canUndo(), before) // unchanged — nothing pushed to the undo stack
```
`get()` must also return `nextShapeStyle` as a fresh, frozen/detached copy per
the snapshot-immutability contract already documented on `get()` (editor.ts —
the same defensive-copy posture as `selection`).

**Step 2 — RED.** `cd /home/stag/src/projects/ensembleworks && export
PATH="$HOME/.bun/bin:$PATH" && cd canvas-editor && bun test.ts; echo
"exit=$?"`. Expected: `nextShapeStyle` absent / `SetNextStyle` unhandled. **If
the file won't compile because `SetNextStyle` isn't in the union, that is a
fake RED** — add the interface + union member first so the switch genuinely
lacks the case and `nextShapeStyle` is genuinely absent from state, then the
RED is the runtime assertion. Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| replace instead of shallow-merge | second `SetNextStyle` drops `color` |
| push an undo entry (treat as mutation) | `canUndo()` changed |
| return the live `nextShapeStyle` from `get()` (not a copy) | add a "mutating the snapshot doesn't corrupt the editor" row, mirroring the `selection` probe |

**Step 3 — Implement.** Add `readonly nextShapeStyle: Record<string, unknown>`
to `EditorState`, `{}` in `INITIAL_STATE`, a fresh copy in `get()`. Add
`SetNextStyle` to `intents.ts` (view-intents group + union) and an `applyOne`
`case 'SetNextStyle'` that returns `{ state: { ...state, nextShapeStyle: {
...state.nextShapeStyle, ...intent.props } }, docMutated: false, stateChanged:
true }` — no `undo`/`redo` arrays.

**Step 4 — GREEN + `bun run typecheck`. Step 5 — Commit.**
```bash
git commit -am "feat(canvas-editor): editor-local nextShapeStyle + SetNextStyle view intent"
```

---

## Task AS3 — `StylePanel` armed mode

**Files:**
- Modify: `client/src/canvas-v2/StylePanel.tsx` (armed-mode render + write)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (pass `activeToolId` +
  `nextShapeStyle` into the panel; an armed-mode `onStyleChange` →
  `SetNextStyle`)
- Modify: `client/src/canvas-v2/style-axes.ts` (P1) — an armed-relevance
  overload `relevantAxesForTool(toolId)` (which axes a to-be-created shape of
  that tool's kind supports)
- Test: `client/src/canvas-v2/StylePanel.test.ts`

> Gated path. Run with the `UX_CONTRACT_PR_BODY` opt-out env until AS4 lands.

**Step 1 — Failing test.** With `selection` empty and `activeToolId: 'geo'`:
- the panel RENDERS armed swatches (a `[data-style-panel-mode="armed"]`
  container; the color/fill/dash/size/font/geo controls for geo), reflecting
  `nextShapeStyle` as current;
- `onStyleChange('color','blue')` in this mode dispatches
  `SetNextStyle{ props: { color: 'blue' } }` (NOT `SetStyle`).
- With empty selection AND a non-style tool (`activeToolId: 'select'`), the
  panel renders null.

**Step 2 — RED.** Run the file. Expected: armed mode not rendered / click
dispatches nothing (or `SetStyle`). Confirm assertion failure, not
absent-symbol. Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| armed mode dispatches `SetStyle` (over empty selection → no-op) | assert intent type is `SetNextStyle` |
| render armed panel for `select`/`hand` too | the `activeToolId: 'select'` → null row |
| ignore `nextShapeStyle` (always show defaults as current) | seed `nextShapeStyle: {color:'red'}`, assert red is marked current |

**Step 3 — Implement.** In `StylePanel`, branch: `selection.size > 0` →
selection mode (P2/P4, dispatch `SetStyle`); else if `activeToolId` is a style
tool → armed mode (dispatch `SetNextStyle`, read current from
`nextShapeStyle`); else null. Thread `activeToolId` + `nextShapeStyle` from
`CanvasV2Session`.

**Step 4 — GREEN** (opt-out env) **+ `bun run typecheck`. Step 5 — Commit.**
```bash
git commit -am "feat(client): StylePanel armed mode — arm next-shape style when nothing is selected"
```

---

## Task AS4 — browser contract `armed-style-applies-to-created-shape` + `selectedShapeIds` Obs

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `selectedShapeIds` to
  `Obs`)
- Create:
  `interaction-contracts/src/contracts/armed-style-applies-to-created-shape.ts`
- Modify: `interaction-contracts/src/index.ts` (register in `CONTRACTS`)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (implement
  `selectedShapeIds` — `[...editor.get().selection]`)
- Modify: `e2e/lib/contracts.ts` (pre-sample the selection; implement
  `selectedShapeIds`)

> Touches `interaction-contracts/` + adapters — **satisfies the presence gate**
> for the armed-style task cluster (AS2/AS3).

**Step 1 — Extend `Obs`.** Add `selectedShapeIds(): readonly string[]`. Doc
comment: available at both levels (reads editor selection); no throw-stub.
Implement in `fsm-runner.ts`'s `makeObs` (`[...editor.get().selection]`) and in
`e2e/lib/contracts.ts` by pre-sampling `window.__ew.editor.get().selection`
into the per-actor `ActorSample` (synchronous read in `pageObs`, like the
other pre-sampled fields).

**Step 2 — Write the contract.** `level: 'browser'`, `when: 'at-end'`. **Empty
scene** (no seeded shapes — the created shape must be the only one carrying the
armed color, so the assertion is unambiguous). Gesture: click the geo tool
button (`[data-canvas-v2-tool="geo"]`), click the panel's armed blue swatch
(`[data-style-panel-mode="armed"] [data-style-control="color"]
[data-style-value="blue"]`), then click empty canvas to create a geo (a
`down`/`up` at a `point` anchor on empty canvas). `check`: `const ids =
obs.selectedShapeIds()` (the create tool auto-selects the new shape) →
`ids.length === 1` else fail → `obs.shapeStyle(ids[0], 'color') === 'blue'`
else fail. (Anchoring onto the tool button / swatch: same selector-anchor
approach P3 settles — reuse whatever P3 established; do not invent a second
mechanism.)

**Step 3 — RUN IT RED against un-landed AS2.** AS3 is in the tree (arming
sets `nextShapeStyle` to blue), but AS2 (create reads it) is NOT — so the new
geo is created with its **default** color and `shapeStyle(id,'color')` is
tldraw's default `'black'`, not `'blue'` → a **clean** "expected blue, got
black" assertion failure. **If instead the failure is a locator-not-found (no
armed swatch, no created shape, empty `selectedShapeIds`), the RED is fake** —
that means AS3's armed panel or the create gesture isn't wired; fix until the
swatch is really clicked and a shape is really created, so the *value*
assertion is what fails. Capture the verbatim RED.

**Step 4 — Do NOT implement AS2's fix here.** AS4 lands the contract + both
Obs adapters RED. `bun run typecheck` passes (both adapters implement
`selectedShapeIds`, so the shared `Obs` interface typechecks).

**Step 5 — Commit** (RED contract + working `selectedShapeIds` Obs):
```bash
git commit -am "test(contracts): armed-style-applies-to-created-shape + selectedShapeIds Obs (RED)"
```

---

## Task AS2 — create tool reads `nextShapeStyle` into new-shape props

**Files:**
- Modify: `canvas-editor/src/tools/create.ts` (`propsFor` / `makeShape`,
  :63-72)
- Test: `canvas-editor/src/tools/create.test.ts` (extend)

> Gated path (`canvas-editor/src/tools/`). AS4's contract is already in the
> tree, so the presence gate passes on the diff.

**Step 1 — Failing test (fsm-level unit).** Arm a style, run a click-create
gesture through the real create tool + editor, assert the minted shape carries
the armed props:
```ts
editor.apply({ type: 'SetNextStyle', props: { color: 'blue', size: 'l' } })
// run a click-create of a geo through createCreateTool(ctx, 'geo') + script.ts
const created = doc.listShapes().find(s => s.kind === 'geo')!
assert.equal(created.props.color, 'blue')
assert.equal(created.props.size, 'l')
// armed style does NOT clobber the tool's own geometry props
assert.equal(typeof created.props.w, 'number')
```

**Step 2 — RED.** `cd canvas-editor && bun test.ts; echo "exit=$?"`. Expected:
`created.props.color` is `undefined` (create ignores `nextShapeStyle`). Confirm
it's the assertion, not a load error. Capture verbatim.

**Mutant table:**
| Wrong impl | Caught by |
|---|---|
| armed props overwrite the whole props map | `props.w` assertion (geometry survives) |
| geometry overwrites armed props (wrong merge order) | `color` assertion |
| read a stale/captured style instead of live `editor.get()` | arm AFTER tool construction, before the gesture; live read must see it |

**Step 3 — Implement.** In `makeShape`/`propsFor`, merge
`editor.get().nextShapeStyle` UNDER the kind's geometry props (armed style
first, geometry second so `w`/`h` always win): `props: { ...nextShapeStyle,
...geometryProps }`. Read `editor.get()` live inside the factory (the tool
already reads the camera this way via `worldOf` — same pattern, same purity
posture; do NOT add style to `CreateState`).

**Step 4 — GREEN.** The unit passes; **re-run AS4's browser contract — now
GREEN** (arm → create inherits). `bun run test` (gate satisfied by AS4's
contracts touch) with `echo $?` on its own line; `bun run typecheck`.

**Step 5 — Commit.**
```bash
git commit -am "feat(canvas-editor): create tool stamps armed nextShapeStyle onto new shapes (contract GREEN)"
```

---

## PR body — required content

The whole sub-cycle is interaction-bearing (`canvas-editor/src/tools/`,
`canvas-react/src/`, `client/src/canvas-v2/`). The PR body MUST contain,
verbatim, an interaction-contract accounting. Because P3 and AS4 add real
contracts, the honest form is a *contract reference*, not an opt-out:

```
## Interaction contracts
1. browser contract `style-applies-to-selection`
   (interaction-contracts/src/contracts/style-applies-to-selection.ts) + new
   `Obs.shapeStyle`, implemented in BOTH adapters
   (canvas-editor/src/contracts/fsm-runner.ts, e2e/lib/contracts.ts).
   RED (verbatim, against P2's unwired panel): <paste>
   GREEN (after P4 wiring): <paste>
   Reviewer reproduced red→green by reverting P4.
2. browser contract `armed-style-applies-to-created-shape`
   (interaction-contracts/src/contracts/armed-style-applies-to-created-shape.ts)
   + new `Obs.selectedShapeIds` (both adapters); reuses `Obs.shapeStyle`.
   RED (verbatim, against un-landed AS2 — armed but create ignores): <paste>
   GREEN (after AS2's create-path read): <paste>
   Reviewer reproduced red→green by reverting AS2.
```

If the reviewer splits scaffolding tasks (P1/P2, or AS3) into a PR *ahead* of
their governing contract (P3 / AS4), that earlier PR carries `ux-contract:
none — panel scaffolding only; the governing contract lands with the wiring in
a follow-up PR (see plan P3/AS4)` — but the intended shape is one PR for the
whole sub-cycle, both contracts included.

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
5. **Armed-style purity (AS2).** The create tool is a pure `(state, event) →
   intents` FSM; AS2 reads `editor.get().nextShapeStyle` live inside the
   factory. That is fine *because it mirrors the tool's existing live camera
   read* (`worldOf`), but it means armed style — like the camera — is NOT
   part of the recorded `CreateState`, so a replayed script depends on the
   editor's live `nextShapeStyle` at replay time. Do NOT "fix" this by moving
   style into `CreateState` (that was considered and rejected — see the
   Decisions armed-style block); a recorded script that must pin an armed
   value should `SetNextStyle` as its first op.

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
- **Armed-style touch points re-verified for AS1–AS4 (2026-07-21):**
  `EditorState` at editor.ts:42-47 / `INITIAL_STATE` :49 (home for
  `nextShapeStyle`); `CreateState = Idle|Pointing|Dragging` at create.ts:35
  (deliberately NOT extended); `makeShape`/`propsFor` at create.ts:63-72 (the
  stamp point); the create tool's existing live editor read (`worldOf` →
  `screenToWorld(editor.get().camera, …)`); and the auto-select on create
  (`finalizeIntents` → `SetSelection([shape.id])`, create.ts:137). All
  confirmed against disk.
