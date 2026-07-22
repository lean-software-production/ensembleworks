# Canvas v2 — Working Z-Order (Sub-cycle 2c) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 the FOUNDATIONAL z-order tldraw has — (a) every newly
created shape gets a MEANINGFUL fractional index (lands on top), (b) the
renderer PAINTS siblings in `(index, id)` order, and (c) the four Arrange
operations work: **bring-to-front, send-to-back, bring-forward, send-backward**
over the selection, among siblings — so a user can reorder overlapping shapes
and SEE the change.

**Architecture:** The ordering math is clean-room and pure. A new
`canvas-model/src/fractional-index.ts` hand-rolls the DETERMINISTIC base-62
fractional-indexing algorithm (`generateKeyBetween` / `generateNKeysBetween`,
aliased `indexBetween`) — the non-jittered variant, so it reads no
`Math.random` and no clock; two peers computing "between A and B" get the
IDENTICAL string (a z-tie), which the renderer resolves deterministically by
tie-breaking on shape id. A new pure `canvas-model/src/paint-order.ts`
(`orderForPaint`) produces a DFS-preorder over a (possibly culled) shape set,
sorting each parent's children by `(index, id)`; `canvas-react`'s `ShapeLayer`
swaps its depth-only sort for it. A minimal `SetIndex` intent (an
index-only whole-shape write, full-shape-inverse undo) plus a pure
`reorderSelectionIntents(editor, op)` emitter in `canvas-editor` compute the
four ops via `indexBetween`/`generateNKeysBetween` and batch into one commit /
one undo step — exactly the shape of the landed `deleteSelectionIntents` /
`duplicateSelectionIntents` helpers. Create/arrow tools assign a top-of-stack
index at creation. Only `client/src/canvas-v2/` touches the `KeyboardEvent`s
(bracket keys). One browser-level interaction contract pins the end-to-end
"bring-to-front moves a shape to the top of paint order."

**Tech stack:** TypeScript pure-FSM editor, Zod (`canvas-model`), React 18
(`canvas-react` / client), Bun test runner, Playwright (browser contract),
`@ensembleworks/interaction-contracts`.

**Scope (decided — see Decisions):** meaningful indices on create (note/text/
geo/frame + arrow); renderer paints by `(index, id)`; the four reorder ops over
the selection among siblings, with local undo/redo, one commit per batch;
`(index, id)` render tie-break for the all-`'a1'` legacy corpus (NON-destructive
— no data migration). **Out of 2c / follow-ups:** paste/duplicate landing
ABOVE existing content (a small emitter change — recommended task E3, may be cut,
see judgment call #2); a right-click context menu hosting the Arrange submenu
(keyboard shortcuts ship instead — judgment call #1); making `document.ts`'s
`childrenOf`/`rootShapes` index-sorted (left untouched to keep blast radius
small — see Decision 3).

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These rules were violated repeatedly on this branch (~15 false factual claims,
several fake REDs caught). Read every line before writing any code.

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
  Run the suite as its own command, then `echo $?` on its own line. This exact
  mistake was made on this branch.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — z-order sub-cycle 2c; see plan'`
  before `bun run test` on any task whose diff touches a **gated path**
  (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`)
  but not the contracts module. Once **H1/Z1** (which touch
  `interaction-contracts/`) are in the working tree, the gate passes on the
  diff alone.
- `server`'s typecheck is `bunx tsc --noEmit`; if `bunx` is off PATH it exits
  127 and looks like a failure. No `server/` changes here, but the full
  `bun run typecheck` covers all workspaces.
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every command
  block. Agent bash cwd resets between calls.
- Browser contracts run: `cd e2e && bunx playwright test --project=e2e -g <name>`.
- `bun run typecheck` catches TS issues a `~/.bun/bin/bun <file>` run misses.

### RED-first discipline (TDD is mandatory, every task)
1. Write the failing test. **RUN it. Capture the VERBATIM failure** into the
   task's commit message / execution note. An assertion already true at the
   parent commit proves nothing.
2. **A missing or renamed import throws at module-load and manufactures a FAKE,
   green-looking RED** (the module never runs, so "it failed" tells you nothing
   about your assertion). Caught repeatedly on this branch. After writing a RED
   test, confirm the failure is your *assertion* failing — not `SyntaxError` /
   `Cannot find name` / `is not a function` / Playwright `locator … not found` /
   `undefined is not an object`. If it is a load/lookup error, the RED is fake:
   fix the wiring until the test *runs* and the *assertion* is what fails.
3. Where a test pins a choice, name the wrong implementations it kills (a
   **mutant table** — each row: a plausible wrong impl → the assertion that
   catches it). Every non-trivial task below ships one.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). The **actual** forbidden patterns
  (verified against the test at plan time, `boundary.test.ts:35-47`): imports
  of `loro-crdt`, `ws`, `@tldraw/`, `react`, `canvas-sync` /
  `@ensembleworks/canvas-sync`; `from '../server'`; and the literals
  `document.`, `window.`, `Date.now(`, `Math.random(`.
- **THE fractional-index algorithm MUST NOT use `Math.random(`.** The classic
  `fractional-indexing` library's *jittered* key generator adds a
  `Math.random`-derived suffix to reduce concurrent-insert collisions — we
  deliberately DO NOT port that path. The base `generateKeyBetween` /
  `generateNKeysBetween` are already fully deterministic (pure string/integer
  math, zero randomness); that is exactly what we implement. `Math.random(` in
  a *comment* fails the scan too — don't even name it in the new module without
  the trailing space broken up as this rule does.
- **`canvas-model` has NO boundary test** (verified — only `canvas-editor`
  scans text). The new `fractional-index.ts` / `paint-order.ts` are still pure
  by construction: no DOM, no clock, no PRNG. Keep them that way regardless.
- `canvas-react` / `client` MAY touch the DOM (they are not clean-room).

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught ~15 false factual claims; the
  dominant failure mode is confident *quantitative / locational* claims.
  **Prefer wording that cannot rot** — describe by argument/behavior, not raw
  line numbers or counts.

### Interaction contracts (CLAUDE.md — mandatory)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan the gated tasks are **R1** (renderer
  sort, `canvas-react/src/`), **C1** (create/arrow index, `canvas-editor/src/
  tools/`), and **D1** (DOM wiring, `client/src/canvas-v2/`). The pure
  model/editor tasks (A1, A2, E1, E2, E3) touch `canvas-model/` or
  `canvas-editor/src/` *outside* `tools/` — **not** gated. Landing **H1 + Z1**
  (which touch `interaction-contracts/` and `e2e/`) satisfies the gate for the
  whole sub-cycle's diff.
- **Obligation 3:** the new `paintOrder()` Obs is **browser-only by
  construction** (it reads the RENDERER's DOM sibling order — a rendering
  concept the headless FSM runner has no notion of). Implement it FOR REAL in
  `e2e/lib/contracts.ts` (reads `[data-shape-id][data-shape-kind]` document
  order) and as a **throw-stub in `canvas-editor/src/contracts/fsm-runner.ts`**
  (`throw new Error('not observable at fsm level')`) — the SAME precedent as
  `textSelectionSpans` / `peerEditingIndicator` / the `'element'` anchor.
  library.test.ts filters CONTRACTS to `level === 'fsm'`, so the throw-stub is
  never reached by a browser-only contract. This throw-stub is correct, NOT a
  shortcut: paint order is genuinely unavailable without a renderer.
- **Obligations 2 & 4:** Z1 runs RED against the un-wired predecessor and the
  reviewer independently reproduces red→green (revert, see the failure,
  restore) — never accept the implementer's report of it. Z1's exact RED
  handles are named in its task.
- **Reorder is keyboard-driven (not a tool FSM)** — like Delete/undo/copy, it
  routes through `handleGlobalShortcut`, never a tool's `onEvent`. So Z1 is
  **`level: 'browser'`** (the FSM runner drives tool FSMs only and never sees
  it). This mirrors the copy/paste K1-K3 and styling P3/AS4 browser-only
  precedent exactly.
- **Create-path (C1) is pinned by the tool unit tests, not a dedicated
  contract.** `create.test.ts` already asserts `created.index === 'a1'` in two
  places (verified: the "armed style never touches index" and "a stray index
  in nextShapeStyle can never corrupt the envelope index" cases) — those flip
  to the RED for C1 and the new positive assertion ("created index sorts AFTER
  the existing max sibling") is the GREEN. The gated `tools/` diff rides the
  sub-cycle's `ux-contract:` accounting (Z1 governs the *visible* on-top effect
  end-to-end; C1's exact index value is a model property the unit test pins).
  See judgment call #3.

---

## Decisions (settled — do not re-litigate)

### D-1. The fractional-index algorithm — DETERMINISTIC base-62, no jitter
- **What:** hand-roll the well-known base-62 fractional-indexing algorithm in a
  new pure module `canvas-model/src/fractional-index.ts`, exposing:
  - `generateKeyBetween(a: string | null, b: string | null): string` — a key
    strictly between `a` and `b` (lexicographically), with `null` meaning
    "unbounded" on that side. `(null, null) → 'a0'`, `(k, null) →` a key after
    `k`, `(null, k) →` a key before `k`, `(a, b) →` a midpoint.
  - `generateNKeysBetween(a: string | null, b: string | null, n: number):
    string[]` — `n` evenly-spread keys strictly between `a` and `b`, each `<`
    the next (used for multi-select bring-to-front / send-to-back).
  - `indexBetween` — a re-export alias of `generateKeyBetween`, for readable
    call sites.
- **Alphabet:** base-62 `0-9A-Za-z` (the reference's `BASE_62_DIGITS`), with the
  integer-part length header the reference uses (`'a'..'z'` for positive
  magnitudes, `'Z'..'A'` for negative). The header is what makes **repeated
  send-to-back** (generating ever-smaller keys below the current minimum)
  terminate cleanly instead of running out of room below `'0'` — do NOT
  substitute a naive header-less "average the digit strings" scheme, which
  cannot represent a key below the smallest digit and breaks send-to-back.
- **No randomness — CLEAN-ROOM HARD CONSTRAINT.** Port ONLY the deterministic
  generator. The reference lib's `generateJitteredKeyBetween` (which appends a
  `Math.random`-derived suffix to make concurrent-insert collisions rarer) is
  DELIBERATELY NOT ported. Determinism is what our convergence story relies on
  (D-2); jitter would *reduce* collisions but is unnecessary given our
  `(index, id)` render tie-break, and is forbidden by the boundary anyway.
- **Collision / convergence behavior (the crux — state it in the module
  header):** because there is no jitter, two peers that concurrently insert
  "between A and B" compute the **IDENTICAL** key → a z-tie. This is CORRECT
  and CONVERGENT for us: the renderer sorts by `(index, id)` (D-2/D-3), so a
  z-tie is broken by shape id — a total, deterministic order every peer agrees
  on regardless of Loro merge order. We accept occasional ties in exchange for
  determinism; ties are visually a stable stacking, never a divergence.
- **Where it lives:** `canvas-model` (pure, the module that already owns the
  `index` string's schema). `canvas-editor` imports it for the reorder math;
  `canvas-react` does not need it (it only *compares* index strings, which is
  plain lexical `<`).
- **RISK NOTE for the implementer:** getting the integer-header edge cases
  right is the single biggest correctness risk in this plan (Risks §1). Port
  the reference algorithm FAITHFULLY and pin it with the algorithm's PUBLISHED
  test vectors (A1 lists a starter set) plus property tests
  (`indexBetween(a,b)` is always strictly between; `generateNKeysBetween`
  yields a strictly-increasing run). Do not improvise the midpoint math.

### D-2. The all-`'a1'` legacy corpus — tie-break on id, NO migration
Every existing shape (and, until C1 lands, every newly-created one) carries
`index: 'a1'`. **Decision: (a) NON-destructive.** The renderer sorts siblings
by `(index ASC lexical, then id ASC lexical)`, so equal indices produce a
stable, convergent paint order; distinct indices are minted only for shapes
going FORWARD (C1's create-path, E2's reorder, E3's paste-on-top). We do NOT
rewrite existing shapes' indices — no data migration, no touching the write
boundary, no risk to stored SQLite rooms. `'a1'` is a valid base-62 key, so all
three "generate a key relative to the max/min `'a1'` sibling" paths
(`indexBetween('a1', null)`, `indexBetween(null, 'a1')`, `indexBetween('a1',
'a1'…)`) work directly. Rejected: (b) migrate the corpus to distinct indices —
a doc rewrite through the write boundary, strictly riskier, and unnecessary
because the `(index, id)` tie-break already gives a total convergent order.

### D-3. Renderer sort — a new pure `orderForPaint`, in the RENDERER's paint step
- **Where:** the sort lives at the renderer's paint step (`ShapeLayer.tsx`),
  operating on the CULLED visible subset it already builds — NOT in
  `document.ts`'s `childrenOf`/`rootShapes`. `ShapeLayer` does not consume
  `childrenOf`; it consumes `queryViewport` + a flat depth sort
  (`orderParentBeforeChild`). Re-ordering `childrenOf` (consumed by geometry/
  cluster/neighbors/…) would be a broad, unnecessary blast radius. Keeping the
  sort in the renderer's own step is the minimal correct change.
- **What:** a new pure `canvas-model/src/paint-order.ts` exporting
  `orderForPaint(shapes: Shape[], byId: ReadonlyMap<string, Shape>): Shape[]`.
  It produces a **DFS-preorder** over the input set: the input's "forest roots"
  (shapes whose `parentId` is NOT itself in the input set — mirrors
  `orderParentBeforeChild`'s "ancestor outside the set is a root for ordering"
  rule) sorted by `(index, id)`, then each shape's children (those in the input
  whose `parentId` is that shape) recursively, each level sorted by
  `(index, id)`.
- **Why DFS, not "sort the flat list by (index,id) then depth-sort":** a flat
  depth-sort does NOT group a subtree together. Example: roots F (a frame,
  index `a1`) and S (index `a2`), F has child `fc`. True paint order is
  `[F, fc, S]` (S, higher index, on top of everything in F's subtree). A flat
  "depth then index" sort yields `[F, S, fc]` — `fc` painting on top of S,
  WRONG (S must occlude F's whole subtree). DFS-preorder with per-parent
  `(index, id)` sibling sort is the only ordering that gives BOTH
  parent-before-child (container occlusion) AND correct cross-subtree z. Put
  `orderForPaint` in the model (pure, unit-testable, no editor dep);
  `canvas-react` already imports `Shape`/`queryViewport` from `canvas-model`,
  so no new import surface.
- **Purity/convergence:** `orderForPaint` is a pure function of converged CRDT
  state (`index` + `id` only) — never cull order, never iteration order. The
  module header's existing "cull order carries no correctness meaning" comment
  stays TRUE and is reinforced: cull order is the *input* multiset, and
  `orderForPaint` imposes the deterministic `(index, id)` order on top of it.
- **Cost:** the sort is per-render on the CULLED (visible) set — the same set
  `orderParentBeforeChild` already sorts. `orderForPaint` is `O(n log n)` on
  that set (per-level sorts) vs the old `O(n·depth)` — comparable at
  editor-interaction scale, and it REPLACES the old sort (not additive). Watch
  it as the hot-path risk (Risks §2) but do not micro-optimize preemptively.

### D-4. Reorder — a minimal `SetIndex` intent + a pure `reorderSelectionIntents` emitter
No `ReorderShapes` mega-intent that recomputes at apply time. Instead, mirror
`duplicateSelectionIntents`:
- **New intent `SetIndex { type: 'SetIndex'; id: string; index: string }`** — an
  index-only whole-shape write. `applyOne`: read the shape (silent no-op /
  `docMutated:false` on an unknown id, per the TOLERANCE CONTRACT, exactly like
  `UpdateProps`); if the new index equals the current, no-op; else
  `putShape({ ...shape, index })`. Undo `[{op:'putShape', shape}]` (the
  pre-image — the same full-shape-inverse convention Resize/Rotate/UpdateProps/
  SetStyle use); redo `[{op:'putShape', shape:{...shape, index}}]`. The
  `putShape` InverseOp already exists in `editor.ts`'s `InverseOp` union
  (verified).
- **Pure emitter `reorderSelectionIntents(editor: Editor, op: ReorderOp):
  Intent[]`** in `canvas-editor/src/reorder-intents.ts` (or extend
  `clipboard-intents.ts`), `ReorderOp = 'toFront' | 'toBack' | 'forward' |
  'backward'`. It reads `editor.get().selection` (empty → `[]`) and
  `editor.doc.listShapes()`, groups the selected shapes BY PARENT (a shape
  reorders only among its own siblings — a multi-parent selection reorders each
  group independently), computes new indices per op via `indexBetween` /
  `generateNKeysBetween`, and returns one `SetIndex` per shape whose index
  actually changes. `CanvasV2App` applies the batch via `editor.applyAll(…)` →
  **one commit / one undo step** (verified: `applyAll` is one commit per call).
  Computing the literal index at emission time and freezing it into the
  `SetIndex` intent keeps replay deterministic (a recorded script replays the
  exact value, never recomputes against a different doc).
- **Per-op index math (siblings = shapes with the same parent, sorted
  `(index ASC, id ASC)`; movers = the selected siblings in that same sorted
  order, so relative order is PRESERVED — tldraw parity):**
  - **toFront:** `others` = siblings not selected. `newKeys =
    generateNKeysBetween(lastOtherIndex ?? null, null, movers.length)`; assign
    `newKeys[i]` to `movers[i]`.
  - **toBack:** `newKeys = generateNKeysBetween(null, firstOtherIndex ?? null,
    movers.length)`; assign in order.
  - **forward (one step up):** process `movers` in DESCENDING sibling position.
    For each mover at sorted position `p`: let `above = siblings[p+1]`. If
    `above` exists AND is not selected, move the mover to just above it:
    `indexBetween(above.index, siblings[p+2]?.index ?? null)`, and splice the
    mover to its new position in the local sorted array so the next mover sees
    the updated arrangement (prevents selected shapes leapfrogging each other).
    If `above` is selected or absent, the mover is blocked/at-top → no change.
  - **backward:** symmetric — process `movers` ASCENDING; `below =
    siblings[p-1]`; if it exists and is unselected,
    `indexBetween(siblings[p-2]?.index ?? null, below.index)`.
  Single-shape selection is the unambiguous common case of all four. Emit
  `SetIndex` only for shapes whose computed index differs from their current.

### D-5. Create-path index — top of the target parent's stack
`makeShape` (create.ts) and the arrow tool hardcode `index: 'a1'`. Replace with
a top-of-stack index so a new shape lands ON TOP (tldraw parity). A tiny helper
`topIndex(ctx | editor, parentId): string` reads the current siblings of
`parentId` (from `ctx.snapshot()` / `editor.doc.listShapes()`, filtered by
`parentId`), takes the lexical max index (or `null` if none), and returns
`indexBetween(max, null)`. Determinism during a DRAG-create: compute the index
ONCE when the shape id is first minted (thread it into the `Dragging` state
alongside `id`/`downWorld`) and reuse it for every per-pointermove re-emission —
NOT recomputed each move (which would need self-exclusion and could drift). For
CLICK-create (single emission from `pointing`→`pointerup`) compute inline. The
throwaway `probeShape` (used only to ask `localBounds` a kind's default size)
keeps `'a1'` — any valid key works there; it never reaches the doc.

### D-6. UI surface — keyboard shortcuts (JUDGMENT CALL #1, recommend ship these)
v2 has no context menu. Ship tldraw-style bracket-key shortcuts wired in
`handleGlobalShortcut`, gated on `editingId === null` exactly like Delete/
copy/paste. tldraw's Arrange bindings are the bracket keys; because Shift
changes the delivered `event.key` (Shift+`]` arrives as `event.key === '}'`,
the SAME shifted-key subtlety the undo code's `key.toLowerCase()` comment
already documents), **match on the delivered character directly** — no separate
shift flag:
- `']'` → **bring-forward**
- `'['` → **send-backward**
- `'}'` (Shift+`]`) → **bring-to-front**
- `'{'` (Shift+`[`) → **send-to-back**

**VERIFY at implementation time (toolchain gotcha):** confirm the exact
`event.key` string the browser/Playwright deliver for each combination
(`page.keyboard.press('}')` vs `press('Shift+]')`) before finalizing the
mapping — this is precisely the class of "confident but unverified" claim the
working rules forbid. The reorder shortcuts do NOT need `preventDefault` (bare
brackets have no competing native canvas action when `editingId === null`),
consistent with Delete/undo. **Recommend shipping the shortcuts; defer a
right-click context menu (and its Arrange submenu) as a follow-up** — it needs a
v2 menu component that does not exist yet, and the shortcuts already deliver
full functional parity.

### D-7. New Obs — `paintOrder()`, browser-only
The contract needs to observe the RENDERER's actual paint order (to prove
"bring-to-front moves a shape to the top"). Add `paintOrder(): readonly
string[]` to `Obs` — the shape ids in **paint order** (first painted → last
painted; last = on top). Browser adapter reads the DOM: `document.
querySelectorAll('[data-shape-id][data-shape-kind]')` in document order IS paint
order (ShapeBody renders `position: absolute` FLAT SIBLINGS — the module header
states DOM order = paint order; the `[data-shape-kind]` qualifier excludes the
arrow overlay `<g>` which carries `data-shape-id` but no `data-shape-kind`).
FSM adapter throw-stubs (`'not observable at fsm level'`) — paint order is a
render concept with no headless equivalent (precedent: `textSelectionSpans` /
`peerEditingIndicator`). This is the ONE new Obs. (No `shapeIndex` Obs is
added: C1's create-path index is pinned by `create.test.ts`, and `paintOrder`
proves the reorder end-to-end.)

### Judgment calls surfaced to the owner
1. **UI surface = keyboard shortcuts, context menu deferred (recommend yes).**
   D-6. Bracket-key Arrange shortcuts ship; a right-click Arrange menu is a
   clean follow-up needing a v2 menu component. **OK to ship 2c
   keyboard-only?** (recommend yes.)
2. **Paste/duplicate landing ABOVE existing content (task E3 — recommend
   include, but cuttable).** The copy/paste sub-cycle (2b) explicitly deferred
   "z-order-above-source"; this is that follow-up. It is a small emitter change
   (reassign each cloned ROOT's index to top-of-stack in `duplicate/
   pasteIntents`, children keep their now-meaningful relative indices), pinned
   by a `clipboard-intents.test.ts` unit test. **Include E3 in 2c, or defer
   again?** (recommend include — small, real parity.)
3. **Create-path (C1) pinned by unit tests, no dedicated contract (recommend
   yes).** The visible on-top effect is governed end-to-end by Z1 (which
   depends on meaningful indices existing); C1's exact index value is a model
   property `create.test.ts`/`arrow.test.ts` pin directly (the existing
   `index === 'a1'` assertions are the RED). **OK to pin C1 by unit tests and
   ride the sub-cycle contract accounting?** (recommend yes.)

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| A1 | `fractional-index.ts` (`generateKeyBetween`/`generateNKeysBetween`/`indexBetween`, deterministic, no jitter) | canvas-model (no) | — | fn absent / wrong midpoint / non-strict between |
| A2 | `paint-order.ts` (`orderForPaint` DFS-preorder, per-parent `(index,id)`) | canvas-model (no) | — | returns input/depth order, not `(index,id)`; subtree not grouped |
| R1 | `ShapeLayer` paints via `orderForPaint` | canvas-react (**YES**) | A2 | rendered DOM order ignores `index` |
| E1 | `SetIndex` intent + `applyOne` case + undo/redo | canvas-editor/src (no) | — | `SetIndex` unhandled in switch |
| E2 | `reorderSelectionIntents(editor, op)` (4 ops via A1) | canvas-editor/src (no) | A1, E1 | helper absent; wrong index for each op |
| C1 | create.ts + arrow.ts assign top-of-stack index | canvas-editor/src/tools (**YES**) | A1 | `create.test.ts` `index==='a1'` assertions flip |
| E3 | *(optional, JC#2)* paste/duplicate roots → top-of-stack index | canvas-editor/src (no) | A1 | duplicated root keeps source index, not above |
| D1 | DOM wiring: `[ ] { }` in `handleGlobalShortcut` → `reorderSelectionIntents` | client/canvas-v2 (**YES**) | E2 | bracket keys do nothing |
| H1 | `paintOrder()` Obs (e2e real + fsm throw-stub) | interaction-contracts + e2e + canvas-editor/contracts (satisfies gate) | — | Obs absent |
| Z1 | browser contract `bring-to-front-paints-on-top` | interaction-contracts + e2e (**YES**/satisfies gate) | D1, H1, R1 | Ctrl-less Shift+] leaves paint order unchanged |

Land **A1/A2** first (pure, everything depends on them). **R1** needs A2;
**E2** needs A1+E1; **C1** needs A1. Land **H1 before Z1** so the Obs exists.
**D1** is the only pre-contract gated task besides R1/C1 — run those tasks'
suites with the `UX_CONTRACT_PR_BODY` opt-out until H1/Z1 are in the tree.

---

## Task A1 — `fractional-index.ts` (canvas-model, pure, deterministic)

**Files:**
- Create: `canvas-model/src/fractional-index.ts`
- Test: `canvas-model/src/fractional-index.test.ts`
- Modify: `canvas-model/src/index.ts` (`export * from './fractional-index.js'`)

Implement the deterministic base-62 fractional-indexing algorithm:
`generateKeyBetween(a, b)`, `generateNKeysBetween(a, b, n)`, and
`export const indexBetween = generateKeyBetween`. Port the reference algorithm
FAITHFULLY (integer-part length header + fractional midpoint over the
`0-9A-Za-z` alphabet); **omit the jitter path entirely** — no `Math.random`, no
clock, pure string/integer math. Add a module header stating the
no-jitter/deterministic decision and the convergence-via-`(index,id)`-tie-break
rationale (D-1/D-2).

**Step 1 — RED test.** Pin the algorithm with PUBLISHED vectors + properties:
```
generateKeyBetween(null, null) === 'a0'
generateKeyBetween('a0', null)  === 'a1'
generateKeyBetween(null, 'a0')  === 'Zz'
generateKeyBetween('a0', 'a1')  === 'a0V'
generateKeyBetween('a1', null)  === 'a2'
```
plus PROPERTY assertions (the load-bearing invariants, robust to any faithful
port): for many `(a,b)` drawn by walking the space, `a < indexBetween(a,b) < b`
(strict lexical); `generateNKeysBetween(a, b, n)` returns `n` keys, strictly
increasing, each strictly between `a` and `b`; and a **stress loop** that
repeatedly generates keys BEFORE the current minimum (send-to-back pathology)
and AFTER the current maximum 100+ times, asserting the run stays strictly
ordered and never throws — this is what proves the integer header works. Run
`~/.bun/bin/bun canvas-model/src/fractional-index.test.ts`; if you see
`generateKeyBetween is not a function` before any impl, add a stub export first
so the RED is your *assertion*, not a load error.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Header-less "average the digit strings" | send-to-back stress loop runs out of room / non-strict order |
| Returns `a` or `b` (inclusive, off-by-one midpoint) | strict `a < mid < b` property |
| `generateNKeysBetween` returns equal/duplicate keys | strictly-increasing run assertion |
| Uses `Math.random` jitter suffix | `boundary`-style scan of the file for `Math.random(` (add an explicit test asserting the source text has no jitter) + non-determinism across two calls with identical args |
| Wrong alphabet ordering (e.g. `A<a` vs `a<A`) | published vector `(null,'a0')==='Zz'` |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): deterministic fractional-index key generation`).

---

## Task A2 — `paint-order.ts` (canvas-model, pure DFS-preorder)

**Files:**
- Create: `canvas-model/src/paint-order.ts`
- Test: `canvas-model/src/paint-order.test.ts`
- Modify: `canvas-model/src/index.ts` (export)

`orderForPaint(shapes: Shape[], byId: ReadonlyMap<string, Shape>): Shape[]` —
DFS-preorder over the input set: forest roots (shapes whose `parentId` is not a
key present in the input set) sorted `(index ASC lexical, id ASC lexical)`, then
each shape's in-set children (input shapes whose `parentId === shape.id`)
recursively, each level sorted the same way. Cycle-safe (a `visited` set, same
discipline as `orderParentBeforeChild`). Comparator: `a.index < b.index ? -1 :
a.index > b.index ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)`.

**Step 1 — RED test.** Cases:
1. **Sibling index order:** three roots input in scrambled order with indices
   `a3, a1, a2` → output ids in `a1, a2, a3` order.
2. **`(index,id)` tie-break (the all-`'a1'` corpus):** two roots both index
   `'a1'`, ids `shape:b` then `shape:a` in input → output `[shape:a, shape:b]`
   (id asc), deterministic regardless of input order.
3. **Subtree grouping (the DFS teeth — kills the flat depth-sort):** root F
   (index `a1`) with child `fc` (index `a1`), and root S (index `a2`) →
   output `[F, fc, S]` (S last / on top of F's whole subtree), NOT
   `[F, S, fc]`.
4. **Parent-before-child always:** a parent always precedes its descendants.
5. **Culled subset:** a child whose parent is NOT in the input set is treated
   as a forest root (present, ordered among roots) — never dropped, never
   throws.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Sort flat list by `(index,id)` only (no DFS) | case 3: `fc` sorts before S by index, breaking `[F, fc, S]` |
| Flat `(index,id)` then stable depth-sort | case 3: yields `[F, S, fc]` |
| Sort by index only, no id tie-break | case 2: nondeterministic order for equal indices |
| Drops shapes whose parent absent from set | case 5: a culled-parent child vanishes |
| Reverses order (last = bottom) | case 1/3 assert first=bottom, last=top |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): orderForPaint — DFS paint order by (index, id)`).

---

## Task R1 — `ShapeLayer` paints via `orderForPaint` (canvas-react — GATED)

**Files:**
- Modify: `canvas-react/src/ShapeLayer.tsx` (replace the `orderParentBeforeChild`
  call with `orderForPaint`; update the import from `@ensembleworks/canvas-model`)
- Test: `canvas-react/src/shape-layer.test.ts` (the existing paint-order test
  file) — add a `(index,id)`-order assertion

Swap `orderParentBeforeChild(visibleShapes, snapshot.byId)` for
`orderForPaint(visibleShapes, snapshot.byId)`. Update the PAINT ORDER comment
block to describe `(index, id)` DFS ordering (the current comment describes the
depth-only fix — rewrite it to match, verify-before-asserting). `orderForPaint`
subsumes the parent-before-child guarantee, so the occlusion fix the old sort
provided is preserved.

**ux-contract:** GATED (`canvas-react/src/`). Run this task's suite with
`UX_CONTRACT_PR_BODY='ux-contract: none — renderer paints siblings in (index,
id) order; governing browser contract Z1 lands with this sub-cycle (see plan)'`
until H1/Z1 are in the tree.

**Step 1 — RED test.** Seed a doc snapshot with two overlapping root shapes
whose indices force an order OPPOSITE to their spatial/insertion order (e.g.
`shape:top` index `a2` inserted first, `shape:bot` index `a1` inserted second),
render `ShapeLayer`, and assert the emitted DOM `data-shape-id` order is
`[shape:bot, shape:top]` (index order), NOT insertion order. **Confirm the RED
is the ORDER assertion failing, not a render/import error** (fake-RED trap: an
`orderForPaint` import typo throws at module load — that is not a real RED).

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Still calls `orderParentBeforeChild` | DOM order follows insertion/depth, not index |
| Sorts descending (top first) | asserted `[bot, top]` order |
| Sorts by id only (ignores index) | index `a2 < a1`-by-id would mis-order |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-react): paint shapes in (index, id) order`).

---

## Task E1 — `SetIndex` intent + `applyOne` case (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/intents.ts` (add `SetIndex` to the union + doc comment)
- Modify: `canvas-editor/src/editor.ts` (`applyOne` `case 'SetIndex'`)
- Test: `canvas-editor/src/editor.test.ts` (or the apply-path test file)

Add `export interface SetIndex { readonly type: 'SetIndex'; readonly id:
string; readonly index: string }` to the `Intent` union. `applyOne` `case
'SetIndex'`: `const shape = this.doc.getShape(intent.id); if (!shape) return
{state, docMutated:false, stateChanged:false}`; if `shape.index === intent.index`
return the no-op result (avoids empty undo entries); else `const next = {...shape,
index: intent.index}; this.doc.putShape(next)` with `undo:
[{op:'putShape', shape}]`, `redo: [{op:'putShape', shape: next}]`,
`docMutated: true`. This mirrors `UpdateProps`'s full-shape-inverse convention
exactly.

**Step 1 — RED test.** Seed a shape with index `'a1'`; apply `SetIndex` to
`'a2'`; assert `doc.getShape(id).index === 'a2'` and one `undo()` restores
`'a1'` and one `redo()` re-applies `'a2'`. Apply `SetIndex` to an unknown id →
assert doc unchanged, no throw. Run the apply-path test file; confirm RED is
"SetIndex unhandled" (switch falls through / returns undefined), not a type
import error.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| No `SetIndex` case | index never changes |
| Writes via `updateProps` (props merge) | index is an ENVELOPE field — updateProps can't reach it; index stays `a1` |
| No inverse | undo leaves the new index |
| Throws on unknown id | unknown-id no-op assertion |

**Step 2–5:** implement, GREEN, `bun run typecheck` (the `Intent` union change
ripples — fix any exhaustiveness switch, incl. the fsm-runner/replay), commit
(`feat(canvas-editor): SetIndex intent (index-only whole-shape write)`).

---

## Task E2 — `reorderSelectionIntents(editor, op)` (canvas-editor, pure emitter)

**Files:**
- Create: `canvas-editor/src/reorder-intents.ts`
- Test: `canvas-editor/src/reorder-intents.test.ts`
- Modify: `canvas-editor/src/index.ts` (export the helper + `ReorderOp`)

Implement `reorderSelectionIntents(editor, op)` exactly per D-4's per-op index
math (siblings grouped by parent, sorted `(index, id)`, movers preserve relative
order, `indexBetween`/`generateNKeysBetween` from A1). Return one `SetIndex`
per changed shape.

**Step 1 — RED test** (fake `Editor` with a real in-memory `LoroCanvasDoc` +
constant `random`, like the copy/paste helper tests). Seed four sibling geo
shapes with KNOWN distinct indices (use A1 to mint a clean `i0<i1<i2<i3` run so
the assertions are about ORDER, not the exact `'a1'` corpus). Cases:
- **toFront** on the bottom shape → its new index sorts strictly AFTER all
  other siblings (compare via lexical `<`); no other shape emits a `SetIndex`.
- **toBack** on the top shape → new index sorts strictly BEFORE all others.
- **forward** on a middle shape → after applying the emitted `SetIndex`, the
  shape sits exactly one position higher in `(index,id)` order (swapped with
  its former upper neighbor); shapes two-or-more away are untouched.
- **backward** symmetric.
- **multi-select toFront** (two of four) → both land above the unselected two,
  and their RELATIVE order is preserved (the one that was lower stays lower
  within the moved pair).
- **empty selection** → `[]`. **single only-child** toFront/back → `[]` (no
  siblings to move past; no spurious `SetIndex`).
Assert against the RESULTING `(index,id)` ordering after applying the intents
to the doc, not the raw index strings (robust to A1's exact midpoints). Confirm
the RED is your ordering assertion, not `reorderSelectionIntents is not a
function`.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| toFront uses `null,null` (ignores max sibling) | new index not guaranteed above existing top |
| Doesn't sort movers before assigning | multi-select relative order scrambled |
| forward moves past a SELECTED neighbor | multi-select forward leapfrogs / re-orders the pair |
| Reorders across parents as one group | a two-parent selection mis-scopes siblings |
| Emits `SetIndex` for unchanged shapes | only-child / no-op cases emit spurious intents |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts` (prove clean-room still holds — no
`Math.random(` crept in via A1's usage), `bun run typecheck`, commit
(`feat(canvas-editor): reorderSelectionIntents — the four Arrange ops`).

---

## Task C1 — create.ts + arrow.ts assign a top-of-stack index (canvas-editor tools — GATED)

**Files:**
- Modify: `canvas-editor/src/tools/create.ts` (`makeShape` + thread the computed
  index through `Dragging` state; a `topIndex(ctx, parentId)` helper)
- Modify: `canvas-editor/src/tools/arrow.ts` (the arrow shape's hardcoded `'a1'`)
- Test: `canvas-editor/src/tools/create.test.ts`, `canvas-editor/src/tools/arrow.test.ts`

Replace the hardcoded `index: 'a1'` in `makeShape` and the arrow shape with a
top-of-stack index (D-5): `topIndex` reads the target parent's current siblings
(`ctx.snapshot()` / `editor.doc.listShapes()` filtered by `parentId`), takes the
lexical max (or `null`), returns `indexBetween(max, null)`. For DRAG-create,
compute once at the `pointing`→`dragging` transition and store on `Dragging`
state (`{ mode, id, downWorld, index }`); reuse it for every per-move
re-emission. For CLICK-create compute inline. Leave `probeShape`'s `'a1'`.

**ux-contract:** GATED (`tools/`). Run with `UX_CONTRACT_PR_BODY='ux-contract:
none — new shapes get a top-of-stack fractional index; value pinned by
create.test.ts/arrow.test.ts, visible on-top effect governed by browser
contract Z1 (see plan)'` until H1/Z1 land.

**Step 1 — RED test.** The two existing `create.test.ts` assertions
`assert.equal(created.index, 'a1', …)` are the RED — update them to the new
truth: seed ONE existing root sibling (index `'a1'`), create a shape, assert
`created.index` sorts strictly AFTER `'a1'` (`'a1' < created.index`). Add: with
NO existing siblings, `created.index` is a valid key (`indexBetween(null,null)
=== 'a0'`). Add the arrow analogue in `arrow.test.ts`. **Confirm the RED is the
ordering assertion, not a `topIndex is not a function` load error.** Verify the
drag path threads the SAME index across multiple pointermoves (assert the shape
re-emitted on the second move carries the identical index as the first).

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Still hardcodes `'a1'` | `'a1' < created.index` fails |
| Recomputes index each pointermove including self | drag re-emission index drifts across moves |
| Reads wrong parent's siblings | index not above the correct-parent max |
| `indexBetween(null, max)` (below, not above) | created shape sorts BELOW existing, not on top |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts`, `bun run typecheck`, commit
(`feat(canvas-editor): new shapes land on top with a fractional index`).

---

## Task E3 — *(optional, JC#2)* paste/duplicate roots land on top (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/clipboard-intents.ts` (`duplicateSelectionIntents`
  / `pasteIntents` — after `cloneWithNewIds`, reassign each ROOT shape's index)
- Test: `canvas-editor/src/clipboard-intents.test.ts`

After `cloneWithNewIds` returns `{shapes, bindings, rootIds}`, rewrite each root
shape's `index` (only the `rootIds` — children keep their now-meaningful
relative indices) to a top-of-stack run via `generateNKeysBetween(maxRootSibling
?? null, null, rootIds.length)`, preserving the roots' relative order. Keep
`cloneWithNewIds` itself PURE (no doc access) — the reindex happens in the
editor-level emitter, which already reads `editor.doc`.

**Step 1 — RED test.** Duplicate a single root over a doc that has an existing
higher-indexed sibling; assert the duplicated root's index sorts strictly ABOVE
that sibling (not merely equal to the source's index). RED: current code keeps
the source index (the `...s` spread in `cloneWithNewIds` — verified), so the
duplicate ties with / sits below the existing top.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Reindexes children too | a pasted frame's child z-order scrambled |
| Reassigns before knowing max sibling | duplicate not guaranteed above existing top |
| Loses root relative order | multi-root paste stacking order wrong |

**Step 2–5:** implement, GREEN, boundary test, `bun run typecheck`, commit
(`feat(canvas-editor): pasted/duplicated shapes land on top`).

> **If cutting E3 (JC#2):** skip this task; pasted/duplicated shapes keep their
> (now-meaningful) source indices and can be re-fronted with Shift+]. Note the
> deferral in the PR body.

---

## Task D1 — DOM wiring: bracket-key Arrange shortcuts (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/reorder-dom.ts` (`reorderShortcut(event,
  editingId): { op: ReorderOp } | null` — the pure key→op mapping, mirroring
  `clipboard-dom.ts`'s `clipboardShortcut`)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`handleGlobalShortcut` branch)
- Test: `client/src/canvas-v2/reorder-dom.test.ts` (DOM-free decision logic)

`reorderShortcut` (D-6): `editingId !== null` → `null`; else map `event.key`:
`']'→forward`, `'['→backward`, `'}'→toFront`, `'{'→toBack`, else `null`.
**VERIFY the exact `event.key` strings the browser delivers** before finalizing.
In `handleGlobalShortcut`, after the clipboard branch, add: `const reorder =
reorderShortcut(event, editingId); if (reorder) { const intents =
reorderSelectionIntents(editor, reorder.op); if (intents.length > 0)
editor.applyAll(intents); return true }`. No `preventDefault` (bare brackets,
no competing native action). Import `reorderSelectionIntents` /`ReorderOp` from
`@ensembleworks/canvas-editor`.

**ux-contract:** GATED. Run with `UX_CONTRACT_PR_BODY='ux-contract: none —
reorder key wiring; governing contract Z1 lands with this sub-cycle (see plan)'`
until Z1 is in the tree.

**Step 1 — RED test.** `reorder-dom.test.ts` asserts `']'→forward`,
`'}'→toFront`, `'['→backward`, `'{'→toBack`, an unrelated key → `null`, and
`editingId !== null` → `null` (text editor owns the keyboard). RED = helper
absent. **Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): wire bracket keys to the four Arrange ops`).

---

## Task H1 — `paintOrder()` Obs (both adapters: e2e real + fsm throw-stub)

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `paintOrder(): readonly
  string[]` to `Obs`, with the browser-only doc comment)
- Modify: `e2e/lib/contracts.ts` (sample DOM paint order; add to `ActorSample`
  + `sampleActor` + `pageObs`)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (`paintOrder` throw-stub
  in `makeObs`)

Browser adapter: a `samplePaintOrder(page)` that
`page.evaluate(() => [...document.querySelectorAll('[data-shape-id][data-shape-kind]')]
.map(el => el.getAttribute('data-shape-id')))`, wired into `ActorSample` and
read synchronously by `pageObs`. FSM adapter: `paintOrder() { throw new
Error('not observable at fsm level') }` (precedent: `textSelectionSpans`). No
`shapeIndex` Obs.

**Step 1 — RED:** add a temporary `level:'browser'` micro-contract asserting
`obs.paintOrder().length === N` for a seeded N-shape scene; run it via
`cd e2e && bunx playwright test --project=e2e -g <micro>` → RED (`paintOrder is
not a function`). Implement, GREEN, remove the scaffold. (No FSM run needed —
`paintOrder` never runs at fsm level; the throw-stub only exists to satisfy the
shared `Obs` interface's typecheck.) Commit (`test(contracts): paintOrder Obs
(browser DOM order; fsm throw-stub)`).

---

## Task Z1 — browser contract `bring-to-front-paints-on-top`

**Files:** create
`interaction-contracts/src/contracts/bring-to-front-paints-on-top.ts`; register
in `interaction-contracts/src/index.ts` (append to `CONTRACTS`).

`level:'browser'`, `when:'at-end'`, `tool:'select'`. Seed THREE
non-overlapping geo shapes with ids that sort `shape:a < shape:b < shape:c`
(all index `'a1'`, so initial paint order = id order `[a, b, c]`, `c` on top).
Gesture: click `shape:a` (down+up on its centre → `SetSelection([a])`), then
`{kind:'key', key:'}'}` (Shift+`]` → bring-to-front — **use whatever key string
D1 verified the browser delivers for Shift+`]`**). `check`: `const order =
obs.paintOrder(); order[order.length - 1] === 'shape:a'` (the brought-to-front
shape is now painted LAST / on top), with a clear failure message including the
observed order.

**RED (Obligation 2/4):** with D1's reorder branch reverted, the key does
nothing → `shape:a` keeps index `'a1'` → paint order stays `[a, b, c]` → last is
`shape:c ≠ shape:a` → a clean, specific COUNT/ORDER assertion failure, never a
Playwright locator error (all three shapes are always present). Reviewer reverts
D1's reorder branch, observes the same RED, restores. Also confirm the SECOND
revert path: with R1 reverted (renderer still depth-sorts), even a successful
reorder leaves DOM order not tracking `index`, so `shape:a` is not DOM-last →
same clean RED. Run: `cd e2e && bunx playwright test --project=e2e -g
bring-to-front-paints-on-top`. Commit (`test(contracts): bring-to-front moves a
shape to the top of paint order`).

> **RED reachability note:** Z1's teeth depend on BOTH R1 (renderer sorts by
> index) and D1 (the key changes the index). Land R1 and H1 before Z1; the
> genuine RED for the WIRING is reached by reverting D1's branch (documented
> above). Capture the verbatim RED/GREEN pair in the execution log.

---

## PR body — required content

The sub-cycle is interaction-bearing (`canvas-react/src/`, `canvas-editor/src/
tools/`, `client/src/canvas-v2/`). Because Z1 adds a real contract, the honest
form is a **contract reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `bring-to-front-paints-on-top`
   (interaction-contracts/src/contracts/bring-to-front-paints-on-top.ts)
   + new browser-only `Obs.paintOrder` (e2e/lib/contracts.ts real; canvas-
   editor/src/contracts/fsm-runner.ts throw-stub — paint order is a render
   concept with no headless equivalent, same precedent as textSelectionSpans).
   RED (verbatim, D1 reorder branch reverted): <paste>  GREEN (after D1): <paste>
   Reviewer reproduced red→green by reverting D1's reorder branch (and,
   separately, R1's orderForPaint call).

The gated tasks that ride this accounting (no separate contract each):
- R1 (canvas-react ShapeLayer paint order) — proven end-to-end by Z1; unit-
  pinned by canvas-react/src/shape-layer.test.ts.
- C1 (canvas-editor create/arrow top-of-stack index) — value pinned by
  create.test.ts / arrow.test.ts; visible on-top effect governed by Z1.
- D1 (client bracket-key wiring) — the contract's subject.
```

If tasks land across multiple PRs, any PR that ships a gated task **ahead** of
Z1 carries `ux-contract: none — z-order wiring; governing contract Z1 lands
with this sub-cycle (see plan)`. If E3 is cut (JC#2), note the paste-on-top
deferral in the PR body.

---

## Risks & unknowns

1. **BIGGEST RISK — the fractional-index algorithm's correctness under repeated
   inserts + its convergence under CONCURRENT inserts.** The integer-header
   edge cases (repeated send-to-back generating ever-smaller keys) are where a
   hand-roll most easily goes wrong; A1's send-to-back/front stress loop and
   the strict-between property tests are the guard — port the reference
   faithfully, do not improvise the midpoint math. Convergence: with no jitter,
   two peers inserting "between A and B" get the IDENTICAL key (a z-tie); this
   is CORRECT because the renderer breaks ties on `id` (a total, convergent
   order every peer agrees on). The failure mode to guard is the renderer
   sorting by index ALONE (no id tie-break) — A2 case 2 pins the tie-break, and
   without it equal-index shapes would paint in nondeterministic/divergent
   order across peers. This is the whole ballgame; get A1 + the `(index,id)`
   tie-break right and the rest follows.
2. **Renderer hot-path sort (R1).** `orderForPaint` runs on every render over
   the culled set — it REPLACES `orderParentBeforeChild` (not additive) and is
   `O(n log n)` on the visible set, comparable to the old `O(n·depth)`. Do not
   pre-optimize; if a perf regression shows up it is the H3 perf rig's job to
   flag. The correctness risk (DFS vs flat sort — A2 case 3) matters far more
   than the constant factor here.
3. **Shifted-key delivery (D1).** `Shift+]` arrives as `event.key === '}'`, not
   `']'` + a shift flag — the same platform quirk the undo code's
   `key.toLowerCase()` comment documents. D1 matches the delivered character
   directly and MUST verify the exact strings Playwright/the browser deliver
   before finalizing (and Z1's gesture must press the matching key). An
   unverified guess here yields a contract that never fires the shortcut.
4. **`Intent` union change ripples (E1).** Adding `SetIndex` may trip
   exhaustiveness switches (fsm-runner, replay, any intent-dispatch map);
   `bun run typecheck` across workspaces is the backstop.
5. **Create-path replay determinism (C1).** The drag path re-emits `CreateShape`
   per pointermove; the index MUST be computed once and threaded through
   `Dragging` state, not recomputed per move (which would need self-exclusion
   and could drift). C1's "same index across moves" assertion is the guard.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **Confirmed accurate:** `envelope.index` is `z.string().min(1)`
  (`shape.ts:206`, "fractional-index string (z-order), kept verbatim");
  `makeShape` hardcodes `index: 'a1'` (`create.ts:130`) and the arrow tool does
  too (`arrow.ts:125`); `document.ts`'s `rootShapes`/`childrenOf` filter by
  parent with NO index sort; `ShapeLayer` paints via `queryViewport` +
  `orderParentBeforeChild` (depth, not index — `index` never consulted during
  paint); NO fractional-indexing library is imported anywhere in the v2
  packages (no `generateKeyBetween`/`indexBetween`); the `Intent` union has no
  reorder member (styling added `SetStyle`/`SetNextStyle`, copy/paste added
  `PutBinding` — re-read, none is a reorder intent); `applyAll` is one commit /
  one undo per call; the `putShape` InverseOp exists; `create.test.ts` asserts
  `created.index === 'a1'` in two places (the C1 RED handles); the browser
  adapter already exposes `window.__ew.doc`/`editor` and samples Obs fields
  pre-`check`.
- **Correction 1 — `cloneWithNewIds` PRESERVES the source index; it does not
  "hardcode `'a1'`".** The brief lists copy/paste's clone among the
  `index:'a1'` hardcoders. Verified: `cloneWithNewIds` (`clipboard.ts`) spreads
  `...s` and rewrites only `id`/`parentId`/`x`/`y` — the source shape's `index`
  rides through verbatim. So pasted shapes keep whatever index the source had
  (which, for v2-created shapes today, IS `'a1'`, but that is coincidence, not
  a hardcode). This is why E3 reassigns the ROOT indices in the editor-level
  emitter (which has doc access) rather than in the pure `cloneWithNewIds`.
- **Correction 2 — the paint-order Obs is browser-only by nature, so its FSM
  adapter is a THROW-STUB, not a "real in both."** The brief's Obligation-3
  framing ("BOTH adapters") holds, but paint order is a RENDER concept the
  headless FSM has no notion of — the correct, precedent-backed implementation
  is a real e2e adapter + an fsm throw-stub (like `textSelectionSpans`/
  `peerEditingIndicator`/the `'element'` anchor), NOT a doc-derived fake. The
  `Obs` interface is shared so typecheck still forces the throw-stub to exist.
- **Correction 3 — no `shapeIndex` Obs is needed.** The brief floated
  `paintOrder()` OR `shapeIndex(id)`. This plan adds only `paintOrder`
  (browser). The create-path index (C1) is pinned by the tool unit tests, and
  `paintOrder` proves reorder end-to-end — a doc-level `shapeIndex` read would
  add surface without teeth the unit tests don't already provide.
- **Correction 4 — `boundary.test.ts` does NOT scan `express`/`navigator`.**
  As CLAUDE.md's brief notes, the real forbidden set is `loro-crdt`/`ws`/
  `@tldraw/`/`react`/`canvas-sync`/`../server` imports plus the literals
  `document.`/`window.`/`Date.now(`/`Math.random(` (verified `boundary.test.ts:
  35-47`). The fractional-index module's only relevant constraint is
  `Math.random(` — which the deterministic (non-jittered) algorithm never uses.
- **No other rot found** in the ground-truth claims.
```