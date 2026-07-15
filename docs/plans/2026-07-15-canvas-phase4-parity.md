# Canvas Phase 4: Visible Parity + Stability — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan
> task-by-task.

**Goal:** Make a real v2 room look and behave like a room the team can live
in — replace the blue-wireframe `BoxShape` fallback with rich core-shape
bodies, wire Delete + local undo/redo + total gesture cancellation, give the
six embeds a write-back channel, surface connection state, and prove all of
it with a cross-renderer visual-diff harness plus re-calibrated perf and
stability gates.

**Architecture:** The clean-room five-package split stays intact. New rich
bodies (note/frame/text/geo) land in `canvas-react/src/shapes/` and register
through `canvas-react/src/shapeRegistry.ts` exactly as the six embeds do from
`client/src/canvas-v2/shapes/index.ts`. Interaction completeness (undo,
delete, cancel, transform-revert) lands in the headless `canvas-editor`
(a new undo stack + an `UpdateProps` intent) and is wired to the DOM only in
`canvas-react/src/Viewport.tsx` + `client/src/canvas-v2/CanvasV2App.tsx`. The
embed write path is a new `dispatch` channel on `ShapeBodyProps` (canvas-react
surface, emitting canvas-editor `Intent`s) that the client-owned embeds
consume. Test infra is REUSED, never reinvented: a new
`e2e/tests/parity.spec.ts` rides the existing Playwright config + seeding, the
perf suite gains three scenarios on the existing rig, and the soak/fuzz/
convergence rigs gain a `setText` op and a re-calibration pass.

**Tech Stack:** Bun 1.3.14, Node 22.12.0 (asdf), TypeScript 5.7, `zod` ^4,
`loro-crdt` **1.13.6 (pin exact — DO NOT upgrade; the fuzz corpus pin is
coupled to it)**, React 19 + Vite 7 (client), the retained legacy `@tldraw/*`
5.1.0 (v1 engine, used by the parity harness as the reference renderer), `ws`
8, Playwright (`e2e` + `perf` projects).

---

## House rules (read before Task 0 — these override habits)

- **bun is NOT on PATH in fresh shells.** Every `Bash` invocation must begin
  with `export PATH="$HOME/.bun/bin:$PATH"`. bun is 1.3.14; node 22.12.0 via
  asdf.
- **Run the suite with `bun run test`** (root → `scripts/run-tests.ts`),
  **never raw `bun test`.** Tests are plain self-executing scripts using
  `node:assert/strict` + a top-level body + `console.log('ok: …')`, run as
  `bun <file>`. A `bun:test` (`describe/it`) file run this way errors with
  "Cannot use test outside of the test runner." Match the house style exactly.
- **Any test that boots the app/server/a browser must end with
  `process.exit(0)`** (WASM ephemeral timers, ws handles, and Playwright
  contexts otherwise hold the process open — the Phase 2
  `PresenceStore.destroy()` hang is the precedent).
- **Typecheck:** `bun run typecheck` from the repo root covers every
  workspace; no new workspace is added this phase. `client` **build** is
  `bunx tsc --noEmit && vite build` — the bundle-size gate (Seam G) runs the
  real `vite build`.
- **Determinism rule (design):** no `Date.now`/`Math.random`/I/O in
  `canvas-model`, `canvas-doc`, `canvas-sync` core, **or `canvas-editor`
  core.** Clocks, ids, PRNG, and input timestamps are injected. Every
  interaction is a replayable event sequence; the replay is the regression
  test. `canvas-react` may touch the DOM (it is the renderer) but holds no
  editor logic (ESLint boundary rule + `boundary.test.ts`).
- **`loro-crdt` is exact-pinned at 1.13.6.** `canvas-*` packages never import
  from `server` or `tldraw`. `canvas-editor` never imports `loro-crdt` or the
  DOM. `canvas-react` never imports `loro-crdt`, `ws`, `express`, `server`, or
  `tldraw`. **The clean-room boundary tests (`*/src/boundary.test.ts`) are the
  enforcement — they must stay green after every task.**
- **`CLAUDE.md` is a symlink to `AGENTS.md`** (`readlink CLAUDE.md` →
  `AGENTS.md`). Edit **`AGENTS.md`** if any doc note is needed.
- **Commits:** small, frequent, conventional-commit style, each ending with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  Repo uses **TRUE MERGE COMMITS (never squash).**
- **This phase adds NO agent tools.** Tool-count assertions live in FOUR
  lock-step files, all asserting **27**: `server/src/tools-api.test.ts`,
  `cli/src/cli-api.test.ts`, `cli/src/render/manifest.test.ts`,
  `contracts/src/tools/tools.test.ts`. No task here touches them. Agent
  writes stay on the tldraw/v2-read path (Agent write-path v2 cutover is
  OWNER-DEFERRED — see the bounds doc §2). If any task ever seems to need a
  new agent tool, STOP — it is out of scope.
- **The `team` room is HARD-EXCLUDED from v2** in `client/src/engine.ts` and
  is UNTOUCHABLE this phase. `client/src/engine.test.ts` +
  `client/scripts/exposure-audit.ts` must stay green, unmodified in intent.
- **e2e rig facts:** ports 8788/5273 must be free; specs in `e2e/tests`;
  perf specs in `e2e/perf`; goldens in `e2e/goldens`; baselines in
  `e2e/baselines`. `e2e/scripts/start-server.ts` already defaults
  `EW_CANVAS_SYNC=1`, so the shared e2e server always mounts `/sync/v2`.
  A v2 room is dialed by appending `?engine=v2` to the room URL.
- **`canvas-v2.spec.ts` is a naming collision, NOT a stub:** it holds BOTH
  the Agent-API-v2 tests (`/api/v2/canvas/*`, a tldraw-store read API) AND
  the Phase-3 new-engine editing-loop E2E. EXTEND it; never rename/split it.

---

## Scope ceiling (binding)

This plan implements **exactly** `docs/plans/2026-07-15-canvas-phase4-bounds.md`
and nothing beyond it. That document is the authority; where this plan and the
bounds disagree, the bounds win. In particular, the following are OUT and
appear in NO task: agent write-path v2 cutover; ink/draw/eraser/line/highlight
tools; full rich text via `loro-prosemirror`; multi-pointer / pointer-kind
(touch/pen) beyond the single `pointercancel` stability fix; SQLite `VACUUM`
implementation (OBSERVE only); `pendingImports` re-request, reconnect
since-acked delta, lossy-repair-edge fixes (all OBSERVE only); v2 chrome
shell / LiveKit spatial audio in v2 rooms; collaborative/selective undo;
`loro-crdt` upgrade; any Phase-5 item.

**Straddler rulings this plan implements (bounds §3):** S1 undo/redo (local
only) — IN; S2 `pointercancel` — IN; S4 Escape-cancel — IN; S5 transform
cancel-revert — IN; S7 connection banner — IN. **OBSERVE (measure + record a
dated verdict, do NOT fix unless a threshold trips):** S6 SQLite VACUUM, S8
lossy repair edges, S9 `pendingImports`, S10 reconnect delta.

---

## Preflight verdicts (record durably here BEFORE Seam B)

Per bounds §6 and §3-S1, the undo mechanism is mechanism-risk and gets a
Phase-3-style probe with its verdict committed into THIS file before the
dependent seam (B) is built. Task A1 fills this in.

### P1: `loro-crdt` 1.13.6 `UndoManager` vs `LoroCanvasDoc` — VERDICT: **fall back to an editor-level inverse-intent stack**

**Probe (Task A1, `canvas-editor/src/__probe/undo-probe.ts`, scratch — reverted after this write-up):**

```ts
const canvasDoc = LoroCanvasDoc.create({ peerId: 1n })
const loroDoc = (canvasDoc as any).doc as LoroDoc   // reach the private field; the whole probe question
const undoManager = new UndoManager(loroDoc, {})
undoManager.setMergeInterval(0)                     // one undo step per commit()
```

`UndoManager` constructs fine against the `LoroDoc` a `LoroCanvasDoc` wraps
(reached via its private `doc` field — `canvas-doc` exposes no public getter
for it today). Four checks were run; here is what actually happened:

1. **create → undo → redo.** `undo()` correctly removes the shape (both
   `listShapes()` and `getShape()` agree: gone). `redo()` restores it in the
   raw Loro tree — `listShapes()` (a fresh `tree.nodes()` scan) sees it again
   — **but `getShape('shape:a')` returns `undefined` after redo.** `setText`/
   `updateProps`/`putShape` on that id would silently no-op too, since they
   all resolve through the same lookup.
2. **setText → undo.** Passed cleanly: `v1` → `v2` → undo → reads back `v1`.
3. **move (`putShape` new x/y) → undo.** Passed cleanly: reverts to the prior
   `x`/`y`, correct via both `getShape()` and `listShapes()`.
4. **remote update imported between local ops → undo.** Passed cleanly: a
   peer-2 `LoroCanvasDoc` created `shape:remote`, exported an update, and the
   probe doc imported it *between* creating `shape:local` and calling
   `undo()`. `undo()` reverted only `shape:local`; `shape:remote` survived
   untouched under both read paths. **Loro's local-peer-only scope holds** —
   this is not the failure.

**Root cause of the (1) failure, confirmed with additional throwaway
diagnostics (not committed):** `LoroCanvasDoc` keeps a private
`id → LoroTreeNode` index (`nodeByShapeId`) that every read/mutate method
(`getShape`, `setText`, `getText`, `putShape`, …) resolves through. That index
is maintained *incrementally* by `LoroCanvasDoc`'s own mutators and rebuilt
*wholesale* by `reindex()` — but `reindex()` only runs inside `import()` (when
`ImportResult.changed`) and `repair()` (when the plan is non-empty). Undo/redo
via `UndoManager` mutates the underlying tree directly (create/delete a
physical node) **without going through either path**, so any undo/redo that
recreates or re-deletes a tree node — i.e. undoing a *create*, redoing a
*create*, or undoing a *delete* — leaves the index pointing at a stale/dead
node while `listShapes()`'s raw scan is fine. Confirmed a symmetric case
(delete → undo(delete)): `listShapes()` sees the shape restored,
`getShape()` still reports `undefined`. Confirmed there is no public
workaround: `canvasDoc.repair()` after an undo/redo returns an **empty**
plan (the CRDT state has no real drift — only the JS-side cache is wrong) and
therefore never triggers its own `reindex()`. Property-level undo (case 2:
`LoroText` edits; case 3: field edits on an already-indexed, never
recreated/deleted node) never touches node identity, so those two cases are
unaffected and pass.

**Verdict:** loro-crdt's `UndoManager` is real and its local-peer-only
semantics are proven correct end-to-end against `LoroCanvasDoc` — but
integrating it directly today would silently break `getShape`/`setText`/
`getText`/`putShape` after undoing or redoing any shape **create or delete**,
which is a core case any undo feature must support, not an edge case. Fixing
it would require changing `canvas-doc` itself (e.g. unconditionally
`reindex()` on its own `subscribe()` callback, or exposing a public
invalidate/reindex hook the editor can call after every `undo()`/`redo()`) —
out of scope for a preflight probe, and not attempted here. B1 therefore
builds local undo/redo as an **editor-level inverse-intent stack**: record the
inverse of each local `Intent` (create ↔ delete, prior x/y, prior text, …) and
replay inverses through the existing `CanvasDoc` mutator methods (`putShape`/
`deleteShape`/`setText`), which already keep `LoroCanvasDoc`'s index correct
on every call — sidestepping the index-staleness gap entirely while
preserving the same local-peer-only guarantee (the stack only ever records
this peer's own intents, so a remote import in between is never touched,
matching what `UndoManager` itself already proved holds at the CRDT layer).

---

## Seam & Unit map

| Seam | What it delivers | Bounds ref |
|---|---|---|
| **A** Preflight + baseline | Green baseline; undo-mechanism probe verdict | §6, S1 |
| **B** Editor interaction completeness | Undo/redo, Delete, total gesture cancel, transform-revert | §1.2, S1/S2/S4/S5 |
| **C** Rich core-shape bodies | note/frame/text/geo renderers + registry + goldens + editor styling | §1.1, §1.4 |
| **D** Embed write-path dispatch channel | `UpdateProps` intent + `dispatch` on `ShapeBodyProps` + the 3 features | §1.3 |
| **E** Connection banner | connection-state banner in CanvasV2App + E2E | S7 |
| **F** Cross-renderer visual-diff harness | `parity.spec.ts`, masked diff, parity-score artifact, regression guard | §1.5 |
| **G** Performance gates | dense-seed, select-all@1k, drag-cadence, bundle-size | §1.6 |
| **H** Stability/multiplayer gates | op-mix extension, K re-cal, actor soak ≥20k + disk metric, crash, presence | §1.7 |
| **I** OBSERVE verdicts + closeout | S6/S8/S9/S10 dated verdicts; DoD checklist; invariants | §3, §4 |

Each Task below is one Unit. Every feature Unit names the existing rig it
extends and carries an explicit test task.

---

## Seam A — Preflight + baseline

### Task A0: Green baseline

**Files:** none (verification only).

**Step 1: Confirm branch + clean tree.**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase4
git branch --show-current   # expect: canvas-phase4
git status --porcelain      # expect: only the two Phase-4 plan docs, if anything
```

**Step 2: Install + full green gate.**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run typecheck
bun run test
bun run build
```
Expected: typecheck exit 0 across all workspaces; `bun run test` → `all N
suites passed`; build succeeds. **Record the exact suite count and the client
entry-chunk size (raw + gzip) from the build output** — the entry chunk is the
Seam G bundle baseline (~215.4 kB raw / ~63.1 kB gzip per Phase 3 Unit 12).

**Step 3: Commit** (docs only, if the plan docs aren't yet committed):
```bash
git add docs/plans/2026-07-15-canvas-phase4-*.md
git commit -m "docs(canvas-phase4): scope bounds + implementation plan"
```

---

### Task A1: Undo-mechanism preflight probe (S1) — record the verdict

**Files:**
- Create (scratch, reverted after): `canvas-editor/src/__probe/undo-probe.ts`
- Modify (record verdict): `docs/plans/2026-07-15-canvas-phase4-parity.md`
  (the P1 section above)

**Step 1: Write the probe.** A self-executing house-style script that
constructs a `LoroCanvasDoc` (from `@ensembleworks/canvas-doc`), attempts to
construct loro-crdt's `UndoManager` against the underlying Loro doc, and
exercises: create a shape → undo → assert gone → redo → assert back; set text
on a shape → undo → assert prior text; move (putShape with new x/y) → undo →
assert prior position; and — critically for the local-only semantic — import a
simulated "remote" update between local ops and assert undo does NOT revert
the remote change. Use `node:assert/strict`, end with `process.exit(0)`.

```ts
// canvas-editor/src/__probe/undo-probe.ts  (SCRATCH — reverted in Step 4)
import assert from 'node:assert/strict'
// construct LoroCanvasDoc, reach its underlying Loro doc, try new UndoManager(...)
// run the four checks above, console.log('ok: ...') per check
process.exit(0)
```

**Step 2: Run it.**

Run:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase4
bun canvas-editor/src/__probe/undo-probe.ts
```
Expected: either all four `ok:` lines (→ verdict "integrate `UndoManager`")
OR a specific failure (movable-tree container not tracked, text container not
inverted, or remote ops reverted → verdict "inverse-intent fallback").

**Step 3: Record the verdict** in this file's P1 section — the exact
construction, what worked/failed, and the chosen mechanism. This is a
committed deliverable (bounds §6), not an agent message.

**Step 4: Revert scratch + commit the verdict.**
```bash
rm -f canvas-editor/src/__probe/undo-probe.ts
git status --porcelain   # expect: only the plan doc changed
git add docs/plans/2026-07-15-canvas-phase4-parity.md
git commit -m "docs(canvas-phase4): record P1 undo-mechanism preflight verdict"
```

---

## Seam B — Editor interaction completeness

> All of Seam B's editor logic lands in `canvas-editor` (headless, injected
> clock/PRNG, unit-tested with the house `run()`/script DSL). DOM wiring is
> confined to `canvas-react/src/Viewport.tsx` and
> `client/src/canvas-v2/CanvasV2App.tsx`. Escape today only ends TEXT editing
> (`TextEditor.tsx`); this seam makes it (and blur, and `pointercancel`)
> cancel in-flight gestures too — via the EXISTING `cancelActiveTool`
> (`client/src/canvas-v2/tool-loop.ts:240`).

### Task B1: Local undo/redo stack in canvas-editor (S1)

**Mechanism:** decided by Task A1's P1 verdict. If "integrate `UndoManager`",
B1 wraps it; if "inverse-intent fallback", B1 builds an editor-level stack
that records the inverse of each committed mutation batch. Either way the
public surface is `editor.undo()` / `editor.redo()` and the observable
semantic is **local-ops-only** (never reverts a peer's committed ops).

**Files:**
- Modify: `canvas-editor/src/editor.ts` (add `undo()`/`redo()`; if
  inverse-intent, capture pre-images inside `applyAll` at `editor.ts:184`)
- Modify: `canvas-editor/src/index.ts` (export any new types)
- Test: `canvas-editor/src/undo.test.ts` (new)

**Step 1: Write failing tests.** Cover, per bounds DoD #4, undo AND redo of:
create, move (TranslateShapes), resize (ResizeShapes), delete (DeleteShapes),
and text edit (SetText). Plus the local-only proof: apply a local create,
then import a remote update creating a second shape, then `undo()` — assert
ONLY the local shape is gone and the remote shape remains.

```ts
// canvas-editor/src/undo.test.ts
import assert from 'node:assert/strict'
// build Editor over a LoroCanvasDoc; apply a CreateShape; editor.undo();
// assert doc.getShape(id) === undefined; editor.redo(); assert it is back.
// repeat for move/resize/delete/setText.
// local-only: local create A; simulate remote create B (doc.import(remoteUpdate));
// editor.undo(); assert A gone, B present.
console.log('ok: undo/redo create/move/resize/delete/text + local-only')
```

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-editor/src/undo.test.ts
```
Expected: FAIL (`editor.undo is not a function`).

**Step 3: Implement** the chosen mechanism in `editor.ts`. If inverse-intent:
snapshot the affected shapes' pre-images before each mutating `applyOne`,
push an inverse batch onto an undo stack in `applyAll` (only when
`docMutated`), and have `undo()`/`redo()` apply the inverse/redo batch through
the same `doc.commit()` path. Keep view-only intents (camera/selection/hover/
edit) OUT of the undo stack. Respect the TOLERANCE CONTRACT (never throw
mid-batch). If `UndoManager`: construct it in the ctor, gate its scope to this
peer, delegate.

**Step 4: Run — passes.**
```bash
bun canvas-editor/src/undo.test.ts
```
Expected: PASS. Then `bun run typecheck` and
`bun canvas-editor/src/boundary.test.ts` (no new forbidden imports) green.

**Step 5: Commit.**
```bash
git add canvas-editor/src/editor.ts canvas-editor/src/index.ts canvas-editor/src/undo.test.ts
git commit -m "feat(canvas-editor): local undo/redo stack (create/move/resize/delete/text)"
```

---

### Task B2: Delete/Backspace → DeleteShapes wiring (§1.2)

The `DeleteShapes` intent already exists (`canvas-editor/src/intents.ts:117`,
applied at `editor.ts:316`). It has NO user emitter — the only emitters are
`cancelActiveTool`'s cleanup paths. This task binds the key.

**Files:**
- Modify: `client/src/canvas-v2/tool-loop.ts` (add a pure helper
  `deleteSelectionIntents(editor)` → `Intent[]`; keep the DOM out of tool-loop)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (a keydown branch in
  `handleInput` at `CanvasV2App.tsx:436`, gated on NOT editing text)
- Test: `client/src/canvas-v2/tool-loop.test.ts` (extend) and
  `client/src/canvas-v2/CanvasV2App.test.ts` (extend, suppression case)

**Step 1: Write failing unit test.** In `tool-loop.test.ts`: given a selection
of two shape ids, `deleteSelectionIntents` returns `[{type:'DeleteShapes',
ids:[...]},{type:'SetSelection',ids:[]}]`; empty selection → `[]`. In
`CanvasV2App.test.ts`: a `keydown` InputEvent for `Delete` (and `Backspace`)
with a non-empty selection and `editingId === null` deletes the selected shapes
from the doc; with `editingId !== null` it does NOT (TextEditor owns the
keyboard then).

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun client/src/canvas-v2/tool-loop.test.ts
bun client/src/canvas-v2/CanvasV2App.test.ts
```
Expected: FAIL.

**Step 3: Implement.** `deleteSelectionIntents(editor)` reads
`editor.get().selection`. In `CanvasV2App.handleInput`, on
`event.type === 'keydown'` && (`event.key === 'Delete' || event.key ===
'Backspace'`) && `editor.get().editingId === null`, apply those intents and
return (do NOT also forward the key to the active tool). When `editingId !==
null`, fall through so TextEditor handles it.

**Step 4: Run — passes.** Both files PASS; `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add client/src/canvas-v2/tool-loop.ts client/src/canvas-v2/CanvasV2App.tsx client/src/canvas-v2/tool-loop.test.ts client/src/canvas-v2/CanvasV2App.test.ts
git commit -m "feat(canvas-v2): Delete/Backspace deletes selection (suppressed while text-editing)"
```

---

### Task B3: Total gesture cancellation — Escape + pointercancel + blur (S2, S4)

Extends the EXISTING abandonment path (`cancelActiveTool`,
`client/src/canvas-v2/tool-loop.ts:240`; wired via `onViewportBlur` at
`CanvasV2App.tsx:469`). Adds two NEW triggers to the SAME path: an Escape
keydown and a `pointercancel` DOM event. **Both create-drag AND arrow-draw
in-flight gestures must cancel** (bounds DoD #5 names arrow-draw explicitly;
the `active === 'arrow'` branch in `cancelActiveTool` already emits
`DeleteShapes([s.id])` for a `drawing`-mode arrow — this task PROVES it).

**Files:**
- Modify: `canvas-react/src/Viewport.tsx` (add an `onPointerCancel?: () =>
  void` prop + a `pointercancel` handler on the div — release capture, call
  the prop; the div already owns keydown so Escape needs no new listener)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (route Escape keydown — when
  NOT editing text — and the new `onPointerCancel` prop to `cancelAndReset` at
  `CanvasV2App.tsx:460`)
- Test: `client/src/canvas-v2/tool-loop.test.ts` (extend — the unit core) and
  `canvas-react/src/viewport.test.ts` (extend — the DOM wiring)

**Step 1: Write failing unit tests** in `tool-loop.test.ts`. THREE
cancellation assertions, one of which is arrow-draw (guard-required):
1. **create-drag** (note tool driven into `dragging` mode carrying an id):
   `cancelActiveTool` returns a `DeleteShapes([id])` intent AND a fully reset
   `ToolStates`; applying the intent removes the preview from the doc.
2. **arrow-draw** (arrow tool driven into `drawing` mode carrying an arrow id):
   `cancelActiveTool` returns `DeleteShapes([arrowId])` AND reset states;
   applying it removes the in-flight arrow. This pins that arrow-draw
   cancellation is covered (closes the guard's named gap).
3. select/hand/transform in-flight: reset to idle, no delete (per the coverage
   table) — transform's revert behavior is Task B5's concern.

In `viewport.test.ts`: a `pointercancel` DOM event on the viewport div invokes
the `onPointerCancel` prop exactly once.

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun client/src/canvas-v2/tool-loop.test.ts
bun canvas-react/src/viewport.test.ts
```
Expected: FAIL (arrow-draw assertion unproven; `onPointerCancel` unwired).

**Step 3: Implement.** In `Viewport.tsx`, add the `onPointerCancel` prop +
handler. In `CanvasV2App.tsx`: pass `onPointerCancel={cancelAndReset}` to
`Viewport`, and in `handleInput`, on a keydown with `event.key === 'Escape'` &&
`editor.get().editingId === null`, call `cancelAndReset()` and return (do not
forward to the active tool; when `editingId !== null`, fall through so
TextEditor's own Escape ends editing).

**Step 4: Run — passes.** Both PASS; `bun run typecheck` +
`canvas-react/src/boundary.test.ts` green.

**Step 5: Commit.**
```bash
git add canvas-react/src/Viewport.tsx canvas-react/src/viewport.test.ts client/src/canvas-v2/CanvasV2App.tsx client/src/canvas-v2/tool-loop.test.ts
git commit -m "feat(canvas-v2): Escape + pointercancel cancel in-flight create-drag AND arrow-draw"
```

---

### Task B4: Ctrl+Z / Ctrl+Shift+Z keyboard wiring

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (keydown routing in
  `handleInput`, gated on NOT editing text)
- Test: `client/src/canvas-v2/CanvasV2App.test.ts` (extend)

**Step 1: Write failing test.** A keydown with `ctrlKey||metaKey` && `key==='z'`
&& `!shiftKey` && `editingId===null` calls `editor.undo()`; with `shiftKey`
(or `key==='y'`) calls `editor.redo()`; both are no-ops while editing text.

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun client/src/canvas-v2/CanvasV2App.test.ts
```

**Step 3: Implement** the keydown branch (before the tool dispatch), calling
`editor.undo()`/`editor.redo()` and returning.

**Step 4: Run — passes.**

**Step 5: Commit.**
```bash
git add client/src/canvas-v2/CanvasV2App.tsx client/src/canvas-v2/CanvasV2App.test.ts
git commit -m "feat(canvas-v2): Ctrl+Z / Ctrl+Shift+Z drive local undo/redo"
```

---

### Task B5: Transform cancel-revert (S5)

Today `cancelActiveTool` resets the transform leg to idle but leaves a
half-applied resize/rotate committed (documented Phase-4 parity item,
`tool-loop.ts:225-233`). With B1 in place, cancelling an in-flight transform
must leave the shape at its **gesture-start geometry**. Mechanism: capture a
gesture-start snapshot of the affected shapes on transform START (or mark a
transform-start undo checkpoint); on cancel, restore it. Planner's choice of
snapshot-vs-undo, but the observable behavior (no half-applied resize/rotate
left behind on cancel) is required.

**Files:**
- Modify: `canvas-editor/src/tools/transform.ts` (carry gesture-start
  pre-images on the transform state, OR mark an undo checkpoint at gesture
  start)
- Modify: `client/src/canvas-v2/tool-loop.ts` (`cancelActiveTool`'s transform
  branch emits the revert — intents or an `editor.undo()`-to-checkpoint call;
  update the doc comment at `tool-loop.ts:225-233`)
- Test: `canvas-editor/src/tools/transform.test.ts` (extend) +
  `client/src/canvas-v2/tool-loop.test.ts` (extend)

**Step 1: Write failing test** (canvas-editor): begin a resize (pointerdown on
a handle → N pointermoves that grow the shape), then cancel mid-gesture →
assert `props.w/h/x/y` equal the pre-gesture values. Same for a rotate (assert
`rotation` reverts). Update the existing `cancelActiveTool` transform
expectation in `tool-loop.test.ts` ("reset to idle only" → "reverts to
gesture start").

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-editor/src/tools/transform.test.ts
bun client/src/canvas-v2/tool-loop.test.ts
```
Expected: FAIL.

**Step 3: Implement** the gesture-start capture + revert-on-cancel.

**Step 4: Run — passes.** `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add canvas-editor/src/tools/transform.ts client/src/canvas-v2/tool-loop.ts canvas-editor/src/tools/transform.test.ts client/src/canvas-v2/tool-loop.test.ts
git commit -m "feat(canvas-editor): cancelling an in-flight transform reverts to gesture-start geometry"
```

---

### Task B6: E2E — delete, undo/redo (two-client local-only), cancellation

Extends `e2e/tests/canvas-v2.spec.ts` (the multi-client editing-loop pattern
Phase-3 H2 added) — do NOT rename it. Reuses `e2e/playwright.config.ts`,
`e2e/scripts/start-server.ts` (EW_CANVAS_SYNC=1 default), the `?engine=v2`
dial, and the `window.__ew.editor`/`window.__ew.doc` hook.

**Files:**
- Modify: `e2e/tests/canvas-v2.spec.ts` (add cases)

**Step 1: Write failing E2E cases:**
1. **Delete loop:** client A creates a note, selects it, presses `Delete` →
   gone in A AND in a second connected client B; then create + `Backspace` →
   same. Delete while a note is being text-edited does NOT delete it.
2. **Undo/redo loop:** after a delete, `Ctrl+Z` restores the shape (A and B);
   after a drag, `Ctrl+Z` restores prior position.
3. **Two-client local-only undo:** A creates shape X, B creates shape Y; A
   presses `Ctrl+Z` → X gone, **Y still present in both clients** (undo never
   reverts a peer's op).
4. **Cancellation:** begin a create-drag then dispatch `Escape` → no preview
   persists; begin a create-drag then blur the viewport → none persists;
   **begin an arrow-draw then `Escape` → no arrow persists** (arrow-draw E2E,
   per bounds DoD #5); a `pointercancel` dispatched mid-create-drag → none
   persists.

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && bunx playwright test tests/canvas-v2.spec.ts
```
Expected: FAIL (new cases).

**Step 3:** implementation already landed in B1–B5 — make the specs pass; any
gap routes back to the relevant B task.

**Step 4: Run — passes.** The full `canvas-v2.spec.ts` (incl. pre-existing
Agent-API-v2 + editing-loop cases) stays green.

**Step 5: Commit.**
```bash
git add e2e/tests/canvas-v2.spec.ts
git commit -m "test(e2e): delete, undo/redo two-client local-only, Escape/pointercancel/blur (create-drag + arrow-draw)"
```

---

## Seam C — Rich core-shape bodies (the wireframe fix)

> New bodies live in `canvas-react/src/shapes/` (clean-room — no client/
> server/tldraw imports). They read the SAME model props tldraw v1 uses
> (`canvas-model/src/shape.ts`: `withText` carries `richText?` + `color?`;
> `frame` carries `{w,h,name?}`; `geo` adds `box`). They MUST keep the
> Phase-3 `getText` live-doc path (`ShapeBodyProps.getText`,
> `ShapeLayer.tsx:108`) so live `LoroText` renders (the `SetText`-had-no-
> consumer bug from Phase 3 Unit 14 stays fixed). The acceptance bar is the
> Seam F parity harness.

### Task C1: NoteShape (sticky) — color, author badge, handwriting font

**Files:**
- Create: `canvas-react/src/shapes/label.ts` (extract `BoxShape.labelOf`'s
  live-text→richText→name→kind resolver, DRY-shared by every body)
- Create: `canvas-react/src/shapes/NoteShape.tsx`
- Modify: `canvas-react/src/shapes/BoxShape.tsx` (use the extracted resolver)
- Test: `canvas-react/src/shapes/note-shape.test.ts` (new)

**Step 1: Write failing test.** A pure `noteStyle(shape)` (or the rendered DOM
via the house render helper) reflects: `props.color` → the sticky background
(map tldraw palette names → the v1 sticky fill); the author badge derived from
`shape.meta` (confirm the meta key against a real seeded note — see A0/seed);
the handwriting font-family; and the label from the shared resolver (live
`getText` first).

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-react/src/shapes/note-shape.test.ts
```
Expected: FAIL (module missing).

**Step 3: Implement** `NoteShape({shape, getText})` using `shapes/label.ts`. No
`snapshot` read (content-memo friendly).

**Step 4: Run — passes.** `bun run typecheck` + `boundary.test.ts` green.

**Step 5: Commit.**
```bash
git add canvas-react/src/shapes/label.ts canvas-react/src/shapes/NoteShape.tsx canvas-react/src/shapes/BoxShape.tsx canvas-react/src/shapes/note-shape.test.ts
git commit -m "feat(canvas-react): NoteShape body (color, author badge, handwriting font, live text)"
```

---

### Task C2: FrameShape — chrome + label

**Files:**
- Create: `canvas-react/src/shapes/FrameShape.tsx`
- Test: `canvas-react/src/shapes/frame-shape.test.ts` (new)

**Step 1: Write failing test.** Frame renders its `props.name` label in a
header bar, a bordered translucent body, and clips nothing (children render as
flat siblings — see `ShapeBody.tsx`'s FLAT SIBLINGS note; the frame body is
purely visual chrome, it does NOT DOM-nest its children).

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-react): FrameShape body (label header + chrome)"
```

---

### Task C3: TextShape

**Files:**
- Create: `canvas-react/src/shapes/TextShape.tsx`
- Test: `canvas-react/src/shapes/text-shape.test.ts` (new)

**Step 1: Write failing test.** Renders live `getText` content with v1 text
styling (font/size/color/align read from props), transparent background, no
box border. Empty text renders an empty body (not the kind-string label) so it
visually matches v1's empty text shape.

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-react): TextShape body (live text, v1 styling)"
```

---

### Task C4: GeoShape — variants

**Files:**
- Create: `canvas-react/src/shapes/GeoShape.tsx`
- Test: `canvas-react/src/shapes/geo-shape.test.ts` (new)

**Step 1: Write failing test.** Renders the geo variant (rectangle, ellipse,
diamond, … — read the variant discriminator from `props`; confirm the key
against a seeded geo shape), the fill/stroke `color`, and the live label. SVG
for non-rect variants so the shape is not always a box.

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-react): GeoShape body (geo variants, fill/stroke, live label)"
```

---

### Task C5: Register core kinds + registry proof (bounds DoD #1)

**Files:**
- Create: `canvas-react/src/shapes/registerCoreShapes.ts` (a
  `registerCoreShapes()` mirroring `registerCanvasV2Shapes()`)
- Modify: `canvas-react/src/index.ts` (export it)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (call `registerCoreShapes()`
  next to `registerCanvasV2Shapes()` at `CanvasV2App.tsx:247`)
- Test: `canvas-react/src/shape-registry.test.ts` (new)

**Step 1: Write failing test.** After `registerCoreShapes()`,
`lookupShapeComponent('note') !== BoxShape`, same for `frame`/`text`/`geo`; the
"no core kind falls back" assertion iterates `['note','frame','text','geo']`
and confirms each resolves to its dedicated component. (Unregistered kinds like
`group`/`line` still resolve to `BoxShape` — correct and unchanged.)

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-react/src/shape-registry.test.ts
```
Expected: FAIL.

**Step 3: Implement** `registerCoreShapes()` (idempotent guard like the v2
one) registering the four bodies (non-embed); call it from CanvasV2App.

**Step 4: Run — passes.** `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add canvas-react/src/shapes/registerCoreShapes.ts canvas-react/src/index.ts canvas-react/src/shape-registry.test.ts client/src/canvas-v2/CanvasV2App.tsx
git commit -m "feat(canvas-react): register core note/frame/text/geo bodies; prove no core kind hits BoxShape"
```

---

### Task C6: TextEditor styling parity (§1.4 — plain-text polish)

The editing mount must not "jump" visually vs the rich bodies: font/size/color
match, Enter/Escape semantics preserved, caret/selection sane. Storage stays
flat `LoroText` — NO `loro-prosemirror`.

**Files:**
- Modify: `canvas-react/src/TextEditor.tsx` (derive font/size/color from the
  shape props so the textarea/contentEditable matches C1/C3/C4)
- Test: `canvas-react/src/text-editor.test.ts` (extend)

**Step 1: Write failing test.** Editing a note shows the same font-family/size/
color the NoteShape body renders; Enter inserts a newline (not commit) for
note/text; Escape ends editing (existing); double-click enters editing for all
of note/text/geo (`isTextCapableKind`).

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-react): TextEditor styling matches rich bodies (no edit-view jump)"
```

---

### Task C7: Component goldens for the rich bodies (bounds §5.1, DoD #1)

Extends the EXISTING component-golden rig: `client/src/canvas-v2/goldens/`
(`shape-fixtures.ts`, `GoldenHarness.tsx`, `main.tsx`),
`client/component-goldens.html`, and `e2e/tests/component-goldens.spec.ts` —
the SAME fixture-screenshot pattern the six embeds already use.

**Files:**
- Modify: `client/src/canvas-v2/goldens/shape-fixtures.ts` (add fixtures)
- Modify: `e2e/tests/component-goldens.spec.ts` (add the new fixture ids)
- Goldens: written under the spec's golden dir on first `--update-snapshots`

**Step 1: Add fixtures** for each representative state named in bounds DoD #1:
note (each color, with/without author badge, handwriting font), frame (with
label), text, geo (each variant). Register them in the harness.

**Step 2: Run to generate + verify.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && bunx playwright test tests/component-goldens.spec.ts --update-snapshots
bunx playwright test tests/component-goldens.spec.ts   # re-run: PASS against fresh goldens
```
Expected: goldens created, second run PASS.

**Step 3: Commit** (include the generated golden PNGs).
```bash
git add client/src/canvas-v2/goldens/shape-fixtures.ts e2e/tests/component-goldens.spec.ts e2e/tests/**/*.png
git commit -m "test(goldens): component goldens for note/frame/text/geo rich bodies"
```

---

## Seam D — Embed write-path dispatch channel (§1.3)

> All three dropped features (terminal rename/drag; screenshare stillUrl +
> aspect relock; file-viewer rev-bump + peer-follow) are blocked by the SAME
> structural gap: `ShapeBodyProps` is read-only — no doc-write handle
> (grep-confirmed in `TerminalShape.tsx:30-34`, `ScreenshareShape.tsx:12-19`,
> `FileViewerShape.tsx:14-33`). This seam adds (D1) a generic `UpdateProps`
> intent to canvas-editor, then (D2) a `dispatch` channel on `ShapeBodyProps`
> (canvas-react surface, emitting canvas-editor `Intent[]`), threaded through
> BOTH `ShapeLayer`→`ShapeBody` and `EmbedLayer`→`EmbedHost`→Component
> (mirroring the `getText` threading). The embed IMPLEMENTATIONS stay in
> `client/src/canvas-v2/shapes/`. Respect the `ShapeBody.tsx`/`EmbedHost.tsx`
> CONTENT-memo constraint (`dispatch` must be a STABLE reference, excluded from
> the content comparator) and the `EphemeralStore` same-millisecond LWW hazard
> (single-write-publisher, `client/src/canvas-v2/presence.ts`).

### Task D1: `UpdateProps` intent in canvas-editor

`canvas-doc` already has `updateProps(id, props)`. The Intent union has no
generic prop-write (only `SetText` + the transform intents). Add one.

**Files:**
- Modify: `canvas-editor/src/intents.ts` (add `UpdateProps` to the union)
- Modify: `canvas-editor/src/editor.ts` (`applyOne` case — silent-skip on
  unresolved id, real `docMutated` flag, per the `SetText`/`DeleteShapes`
  template at `editor.ts:316-343`)
- Modify: `canvas-editor/src/index.ts` (export)
- Test: `canvas-editor/src/editor.test.ts` (extend)

**Step 1: Write failing test.** `apply({type:'UpdateProps', id, props:{title:'x'}})`
merges into the shape's props (shallow merge, like `doc.updateProps`); an
unknown id is a silent no-op with `docMutated:false`; it participates in
undo/redo (B1).

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-editor/src/editor.test.ts
```
Expected: FAIL.

**Step 3: Implement** the `UpdateProps` case (gate `docMutated` on the id
resolving).

**Step 4: Run — passes.** `bun run typecheck` +
`canvas-editor/src/boundary.test.ts` green.

**Step 5: Commit.**
```bash
git add canvas-editor/src/intents.ts canvas-editor/src/editor.ts canvas-editor/src/index.ts canvas-editor/src/editor.test.ts
git commit -m "feat(canvas-editor): UpdateProps intent (generic shape-prop write)"
```

---

### Task D2: `dispatch` channel on ShapeBodyProps + threading

**Files:**
- Modify: `canvas-react/src/shapeRegistry.ts` (add `readonly dispatch?:
  (intents: Intent[]) => void` to `ShapeBodyProps`, documented like `getText`;
  import `Intent` from `@ensembleworks/canvas-editor` — canvas-react already
  depends on canvas-editor, so no boundary breach)
- Modify: `canvas-react/src/ShapeBody.tsx` (forward `dispatch`)
- Modify: `canvas-react/src/ShapeLayer.tsx` (thread `dispatch` beside `getText`
  at `ShapeLayer.tsx:102-109`)
- Modify: `canvas-react/src/embed/EmbedLayer.tsx` (thread `dispatch` to
  `EmbedHost` at `EmbedLayer.tsx:94-98`)
- Modify: `canvas-react/src/embed/EmbedHost.tsx` (forward `dispatch`; EXCLUDE
  it from `embedBodyPropsEqual` — a stable ref, not content — so the
  content-memo win survives)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (build one stable `dispatch =
  useCallback((intents) => editor.applyAll(intents), [editor])`, pass to
  `ShapeLayer` + `EmbedLayer` at `CanvasV2App.tsx:514-522`)
- Test: `canvas-react/src/shape-layer.test.ts` +
  `canvas-react/src/embed/embed.test.ts` (extend)

**Step 1: Write failing tests.** `ShapeBody`/`ShapeLayer` forward a `dispatch`
prop to the resolved component; `EmbedHost` forwards `dispatch` AND its memo
comparator does NOT re-render when only `dispatch`'s (stable) identity is
present and content is unchanged; a component calling `dispatch([{type:
'UpdateProps',...}])` reaches `editor.applyAll`.

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-react/src/shape-layer.test.ts
bun canvas-react/src/embed/embed.test.ts
```
Expected: FAIL.

**Step 3: Implement** the threading. Keep `dispatch` optional (fakes/goldens
omit it, exactly like `getText`).

**Step 4: Run — passes.** `bun run typecheck` + ALL `boundary.test.ts` green
(confirm no `loro-crdt`/`ws`/tldraw import crept into canvas-react).

**Step 5: Commit.**
```bash
git add canvas-react/src/shapeRegistry.ts canvas-react/src/ShapeBody.tsx canvas-react/src/ShapeLayer.tsx canvas-react/src/embed/EmbedLayer.tsx canvas-react/src/embed/EmbedHost.tsx client/src/canvas-v2/CanvasV2App.tsx canvas-react/src/shape-layer.test.ts canvas-react/src/embed/embed.test.ts
git commit -m "feat(canvas-react): dispatch channel on ShapeBodyProps threaded to ShapeLayer + EmbedLayer"
```

---

### Task D3: Terminal title rename + title-drag-to-move

Restores the gap named in `TerminalShape.tsx:30-34`.

**Files:**
- Modify: `client/src/canvas-v2/shapes/TerminalShape.tsx` (rename →
  `dispatch([{type:'UpdateProps', id, props:{title}}])`; title-bar drag →
  `dispatch([{type:'TranslateShapes', ids:[id], dx, dy}])`)
- Test: `client/src/canvas-v2/shapes/TerminalShape.test.ts` (extend)

**Step 1: Write failing test** (fake `dispatch` spy): renaming via the title
field dispatches `UpdateProps` with the new title; a title-bar drag dispatches
`TranslateShapes` with the pointer delta.

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-v2): terminal title rename + title-drag-to-move via dispatch"
```

---

### Task D4: Screenshare stillUrl stamp-back + aspect relock

Restores `ScreenshareShape.tsx:12-19`.

**Files:**
- Modify: `client/src/canvas-v2/shapes/ScreenshareShape.tsx` (on capture, if
  this viewer should stamp, `dispatch([{type:'UpdateProps', id,
  props:{stillUrl}}])`; on track-dimension/resize change, relock aspect via
  `dispatch([{type:'UpdateProps', id, props:{w,h}}])` — reuse the legacy
  `lockScreenShareAspect` math)
- Test: `client/src/canvas-v2/shapes/ScreenshareShape.test.ts` (extend)

**Step 1: Write failing test.** A captured last-frame stamps `stillUrl` back
via `dispatch` (peer/reload sees the tombstone); an aspect-relock computes and
dispatches corrected `w/h`. Guard against a stamp loop (only stamp when the
prop actually changes).

**Step 2–5:** run-fail → implement → run-pass → commit.
```bash
git commit -m "feat(canvas-v2): screenshare stillUrl stamp-back + aspect relock via dispatch"
```

---

### Task D5: File-viewer rev-bump (dispatch) + peer-follow (presence)

Restores `FileViewerShape.tsx:14-33`. Rev-bump is a doc write (dispatch);
peer-follow reads a peer's presenting state; the presenting WRITE rides
canvas-sync presence via a client-owned publisher — respect the
single-write-publisher pattern (`client/src/canvas-v2/presence.ts`).

**Files:**
- Modify: `client/src/canvas-v2/shapes/FileViewerShape.tsx` (refresh →
  `dispatch([{type:'UpdateProps', id, props:{rev: rev+1}}])`; read peers'
  presenting state from a client presence accessor; publish own presenting via
  the single-write publisher)
- Modify: `client/src/canvas-v2/shapes/presentStoreV2.ts` and/or
  `client/src/canvas-v2/presence.ts` (wire the presenting field onto the v2
  presence surface — ONE combined store write, never two)
- Test: `client/src/canvas-v2/shapes/FileViewerShape.test.ts` +
  `client/src/canvas-v2/presence.test.ts` (extend)

**Step 1: Write failing test.** Refresh dispatches an `UpdateProps` bumping
`rev` (a peer re-fetches on rev change); a peer's presenting state, when
present in the presence map, drives this viewer's scroll follow; publishing own
presenting goes out as ONE presence write (no same-ms LWW second-write loss —
assert the combined-write shape).

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun client/src/canvas-v2/shapes/FileViewerShape.test.ts
bun client/src/canvas-v2/presence.test.ts
```
Expected: FAIL.

**Step 3: Implement.**

**Step 4: Run — passes.** `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add client/src/canvas-v2/shapes/FileViewerShape.tsx client/src/canvas-v2/shapes/presentStoreV2.ts client/src/canvas-v2/presence.ts client/src/canvas-v2/shapes/FileViewerShape.test.ts client/src/canvas-v2/presence.test.ts
git commit -m "feat(canvas-v2): file-viewer rev-bump (dispatch) + peer-follow (presence, single-write)"
```

---

### Task D6: Two-client embed write-path E2E through /sync/v2 (bounds DoD #6)

Extends `e2e/tests/canvas-v2.spec.ts` (or `e2e/tests/multiplayer.spec.ts` —
whichever the seeding fits; both reuse the same server).

**Files:**
- Modify: `e2e/tests/canvas-v2.spec.ts`

**Step 1: Write failing E2E.** Seed a room with a terminal shape (a title
`UpdateProps` is observable without a live gateway). Client A renames it → the
new title is visible in client B (prop persisted in the doc, rendered on the
peer). At least one two-client case exercising the `dispatch` → `/sync/v2` →
peer path (per bounds DoD #6).

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && bunx playwright test tests/canvas-v2.spec.ts
```

**Step 3–5:** make pass → commit.
```bash
git commit -m "test(e2e): two-client embed write-back (terminal rename) through /sync/v2"
```

---

## Seam E — Connection banner (S7)

### Task E1: Connection-state banner in CanvasV2App

A half-configured dogfood (e.g. `EW_CANVAS_SYNC` unset server-side) currently
renders a dead canvas with no error. Surface connection state.

**Files:**
- Modify: `client/src/canvas-v2/ws-client-transport.ts` (expose a
  connection-state signal — `connecting`/`open`/`reconnecting`/`failed` —
  driven by the existing `onopen`/`onclose`/`onerror` funnel at
  `ws-client-transport.ts:115-144`; additive, does NOT change the idempotent
  `close()` or the `onClose`-at-most-once contract)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (a `ConnectionBanner` shown
  when state !== connected; today `connectionState` is a naive
  `session ? 'connected':'connecting'` at `CanvasV2App.tsx:306` — drive it from
  the transport instead)
- Test: `client/src/canvas-v2/ws-client-transport.test.ts` +
  `client/src/canvas-v2/CanvasV2App.test.ts` (extend)

**Step 1: Write failing test.** The transport reports `failed` when the socket
errors/closes before open; the banner renders a visible reconnecting/failed
message when state !== connected and disappears on recovery.

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun client/src/canvas-v2/ws-client-transport.test.ts
bun client/src/canvas-v2/CanvasV2App.test.ts
```

**Step 3: Implement.** Keep `close()` idempotent and the `onClose`-at-most-once
contract intact — the state callback is additive.

**Step 4: Run — passes.** `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add client/src/canvas-v2/ws-client-transport.ts client/src/canvas-v2/CanvasV2App.tsx client/src/canvas-v2/ws-client-transport.test.ts client/src/canvas-v2/CanvasV2App.test.ts
git commit -m "feat(canvas-v2): connection-state banner (connecting/reconnecting/failed)"
```

---

### Task E2: Connection-banner E2E (bounds DoD #7)

**Files:**
- Modify: `e2e/tests/canvas-v2.spec.ts`

**Step 1: Write failing E2E.** Load a v2 room, then stop/kill the sync server
(or point at a dead port) → a visible error/reconnecting banner appears within
a stated bound (assert ≤ ~10s, seconds not minutes); restoring the server
clears it. Reuse `e2e/scripts/start-server.ts` lifecycle.

**Step 2–5:** run-fail → make pass → commit.
```bash
git commit -m "test(e2e): connection banner appears on dead sync server, clears on recovery"
```

---

## Seam F — Cross-renderer visual-diff harness (NEW test infra, required §1.5)

> The design's UI tier-3, not built yet. Render the SAME seeded room under v1
> (tldraw) and v2, screenshot both, diff with per-feature masks + per-region
> tolerances, emit a parity SCORE as a per-run artifact, and FAIL CI on a
> deliberate sticky-body regression. REUSES the existing rig — NOT a new
> runner: `e2e/playwright.config.ts`, `e2e/scripts/start-server.ts`
> (EW_CANVAS_SYNC=1 default), the seeding proven in `e2e/tests/seed.spec.ts` +
> `e2e/lib/seed.ts`, and the screenshot conventions of `e2e/tests/visual.spec.ts`.

### Task F1: Parity spec + masked diff + score artifact

**Files:**
- Create: `e2e/tests/parity.spec.ts`
- Create: `e2e/lib/parity.ts` (masked pixel-diff + score helper — reuse
  `visual.spec.ts`'s screenshot approach; drive per-region masks via
  Playwright's `mask`/`clip` if it uses `toHaveScreenshot`, else a small
  pixelmatch-style diff over the two buffers)
- Goldens/masks: `e2e/goldens/parity/`

**Step 1: Write the failing spec.** Seed ONE room (reuse `seedGoldenBoard` /
`e2e/lib/seed.ts` — core kinds: note per color, frame, text, geo, an arrow).
Open it under v1 (default engine) and under v2 (`?engine=v2`), screenshot the
world region in both, mask the six embeds (rendered as placeholders — masked)
and any known-non-parity regions with fixed tolerances, compute a per-region +
overall parity score, WRITE it as a run artifact (JSON under a results dir,
like `e2e/lib/perf.ts`'s `record`), and assert overall parity ≥ the fixed
threshold this task sets (start conservative; tighten as bodies land). Include
a **deliberate-regression guard**: given an intentionally broken sticky
fixture, the score drops below threshold (so CI would fail) — prove the gate
has teeth (bounds DoD #2).

**Step 2: Run — establish baseline.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && bunx playwright test tests/parity.spec.ts --update-snapshots
bunx playwright test tests/parity.spec.ts
```
Expected: baseline captured; second run PASS; the deliberate-regression case
FAILs the gate as designed.

**Step 3: Implement** `e2e/lib/parity.ts` + the score artifact write.

**Step 4: Run — passes** (real parity case green; regression-guard case proven
to fail on a broken fixture).

**Step 5: Commit** (include baseline goldens + masks).
```bash
git add e2e/tests/parity.spec.ts e2e/lib/parity.ts e2e/goldens/parity/
git commit -m "test(e2e): cross-renderer v1-vs-v2 parity harness with masked diff + score artifact + regression guard"
```

---

### Task F2: Wire parity into CI (renderer-PR + nightly)

**Files:**
- Modify: `.github/workflows/e2e.yml` (or the nightly workflow that runs the
  `e2e` project) — add the `parity.spec.ts` run + upload the score artifact

**Step 1:** Add the parity spec to the renderer-touching-PR + nightly job,
uploading the parity-score JSON as a build artifact (the "dashboard number").

**Step 2:** Validate the workflow YAML parses.
```bash
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/e2e.yml")); print("ok")'
```

**Step 3: Commit.**
```bash
git add .github/workflows/e2e.yml
git commit -m "ci: run cross-renderer parity harness on renderer PRs + nightly, upload score artifact"
```

---

## Seam G — Performance gates (reuse + extend + re-calibrate §1.6)

> REUSES `e2e/perf/canvas-v2-perf.spec.ts`, `e2e/lib/perf.ts`,
> `e2e/baselines/{canvas-v2,tldraw}-perf.json`, `.github/workflows/
> canvas-v2-perf.yml`. Keep the gated 60 fps @ 1k (the existing pan/zoom @ 1k
> case, `canvas-v2-perf.spec.ts:97`; `assertBudget`/`CI_MARGIN_MULTIPLIER`
> pattern). Phase-3 found viewport culling makes the spread-out pan/zoom
> scenario FLAT at every scale — so it can't show degradation; the new
> scenarios fix that. **Re-baseline honestly AFTER the rich bodies (Seam C)
> land** — do not inherit BoxShape-era numbers.**

### Task G1: Dense-seed scenario (baselined + ≤15% gated)

**Files:**
- Modify: `e2e/perf/canvas-v2-perf.spec.ts`
- Modify: `e2e/lib/seed.ts` (a DENSE seed — many shapes packed into the
  visible viewport, not spread out — so render cost reflects on-screen count)
- Modify: `e2e/baselines/canvas-v2-perf.json`

**Step 1: Write the failing scenario.** A dense grid (e.g. 1k shapes packed
into the default viewport) pan/zoom sweep; measure p95 frame time via the
existing `installSampler`/`measure` (`e2e/lib/perf.ts`); assert against a
recorded baseline with **≤15% regression gating** (design-doc budget).

**Step 2: Establish baseline (AFTER Seam C).**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && EW_CAPTURE=1 bunx playwright test perf/canvas-v2-perf.spec.ts
```
Record the number into `canvas-v2-perf.json`; re-run to confirm the gate is
green within 15%.

**Step 3–5:** implement seed + assertion → confirm green → commit.
```bash
git commit -m "test(perf): dense-seed pan/zoom scenario, baselined + <=15% gated"
```

---

### Task G2: Select-all @ 1k scenario (baselined + ≤15% gated)

Targets the ~8.7 ms/render `Selection.tsx` watch-item (Phase-3 note) — a real
1k select-all, not the 15-shape marquee the current rig runs.

**Files:**
- Modify: `e2e/perf/canvas-v2-perf.spec.ts`
- Modify: `e2e/baselines/canvas-v2-perf.json`

**Step 1: Write the failing scenario.** Seed 1k shapes, drive a select-all (via
`window.__ew.editor` SetSelection of every id, or Ctrl+A if wired), measure
render p95 while the full-selection overlay is live; baseline + ≤15% gate.

**Step 2–5:** baseline → confirm green → commit.
```bash
git commit -m "test(perf): select-all @ 1k scenario (Selection.tsx watch-item), baselined + <=15% gated"
```

---

### Task G3: Single-shape drag commit-cadence scenario (baselined + ≤15% gated)

Isolates the four-tool "COMMIT CADENCE WATCH-ITEM" (`canvas-editor/src/tools/
{create,transform,arrow,select}.ts`): every pointermove during an in-flight
drag commits immediately (N commits / N notifies / N renders).

**GATING DECISION (resolves the guard's G3 concern):** this scenario is
**baselined AND ≤15%-regression gated**, exactly like G1/G2 — per bounds DoD
#8, which requires recorded baselines AND ≤15% gating for ALL THREE new
scenarios. It is NOT left as a document-only micro-benchmark. If, and only if,
the scenario proves too noisy to gate reliably in CI, that is a deviation from
DoD #8 and MUST be recorded as an explicit owner decision in this file's
Execution notes — never silently landed ungated.

**Files:**
- Modify: `e2e/perf/canvas-v2-perf.spec.ts`
- Modify: `e2e/baselines/canvas-v2-perf.json`

**Step 1: Write the failing scenario.** Seed one shape; drag it a long path
with many small `mouse.move` steps (forcing per-move commits); measure p95
frame time; baseline + ≤15% gate on p95.

**Step 2: Establish baseline.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd e2e && EW_CAPTURE=1 bunx playwright test perf/canvas-v2-perf.spec.ts
```
Record; re-run to confirm the gate is green.

**Step 3–5:** implement + assertion → confirm green → commit.
```bash
git commit -m "test(perf): single-shape drag commit-cadence scenario, baselined + <=15% gated"
```

---

### Task G4: Bundle-size gate (entry chunk within ~2% of 215.4 kB / 63.1 kB)

New bodies + undo + dispatch must not bloat the eager bundle (bounds §1.6,
DoD #8).

**Files:**
- Create: `client/scripts/bundle-size-check.ts` (run `vite build`, locate the
  entry chunk, assert raw ≤ ~2% over 215.4 kB and gzip ≤ ~2% over 63.1 kB —
  use the exact Task A0 numbers as the true baseline)
- Modify: `.github/workflows/canvas-v2-perf.yml` (or the build workflow) to
  run it

**Step 1: Write the failing check.**

**Step 2: Run.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run --filter '@ensembleworks/client' build
bun client/scripts/bundle-size-check.ts
```
Expected: PASS within tolerance (or FAIL loudly if a task bloated the bundle —
then investigate before proceeding).

**Step 3: Commit.**
```bash
git add client/scripts/bundle-size-check.ts .github/workflows/canvas-v2-perf.yml
git commit -m "ci: gate client entry-chunk size against the Unit-12 baseline"
```

---

## Seam H — Stability / multiplayer gates (reuse + re-calibrate §1.7)

> REUSES `canvas-sync/src/{convergence,fuzz,soak,soak-smoke}.test.ts`,
> `canvas-sync/src/soak.ts` + `canvas-sync/soak-cli.ts` (via the
> `@ensembleworks/canvas-sync/soak` subpath — NEVER re-export from the main
> index; that regression is documented), `canvas-sync/src/rig/ops.ts`
> (the weighted op generator: `Op` union + `randomOps` + `applyOp`),
> `server/src/canvas-v2/{soak-actor,crash-recovery,crash-writer}.ts` +
> `soak-actor-cli.ts`, and `.github/workflows/canvas-soak.yml`.

### Task H1: Extend the op mix — `setText` + weighted deletes/embed-prop-writes

`rig/ops.ts` already has `putShape`/`updateProps`/`reparent`/`deleteShape`/
`putBinding`/`deleteBinding`. Missing: `setText` (text edits). `updateProps`
already covers embed prop writes; ensure deletes + prop-writes are exercised
at meaningful weight for the new write surfaces (bounds §5.3).

**Files:**
- Modify: `canvas-sync/src/rig/ops.ts` (add a `setText` op kind to the `Op`
  union at `ops.ts:16-22` + `randomOps` generation + `applyOp` case →
  `doc.setText`)
- Test: `canvas-sync/src/convergence.test.ts` + `canvas-sync/src/fuzz.test.ts`
  (they consume `randomOps`; extend so the new op is exercised and converges)

**Step 1: Write failing test.** Convergence with a `setText`-inclusive op mix
still converges byte-identically across shuffled merge orders and passes
invariants post-repair. Fuzz: a `setText` on a garbage/vanished id never
crashes the host. **Corpus pin `malformedFrames=999/1000` UNCHANGED — no loro
upgrade.**

**Step 2: Run — fails.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-sync/src/convergence.test.ts
bun canvas-sync/src/fuzz.test.ts
```

**Step 3: Implement** the `setText` op.

**Step 4: Run — passes.** `bun run typecheck` green.

**Step 5: Commit.**
```bash
git add canvas-sync/src/rig/ops.ts canvas-sync/src/convergence.test.ts canvas-sync/src/fuzz.test.ts
git commit -m "test(canvas-sync): op mix gains setText; convergence + fuzz cover text edits (corpus pin untouched)"
```

---

### Task H2: Bounded-growth K re-calibration on the new op mix

`soak.ts` exposes `BOUNDED_GROWTH_K = 30` (`soak.ts:185`), calibrated for the
old mix. The actor-backed compacting soak now exists; re-calibrate K for the
`setText`-inclusive mix (Phase-2 carried item).

**Files:**
- Modify: `canvas-sync/src/soak.ts` (re-derive `BOUNDED_GROWTH_K` from a
  calibration run on the new mix; update the CALIBRATION comment)
- Test: `canvas-sync/src/soak-smoke.test.ts` (stays green under the new K)

**Step 1: Calibrate** via the CLI subpath.
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-sync/soak-cli.ts   # observe the growth curve on the new mix
```
Record the empirical K; set `BOUNDED_GROWTH_K` with documented headroom.

**Step 2: Run — smoke green.**
```bash
bun canvas-sync/src/soak-smoke.test.ts
```

**Step 3: Commit.**
```bash
git add canvas-sync/src/soak.ts canvas-sync/src/soak-smoke.test.ts
git commit -m "test(canvas-sync): re-calibrate BOUNDED_GROWTH_K on the setText-inclusive op mix"
```

---

### Task H3: Actor soak ≥20k ops — tighten FLAT_RSS_TOLERANCE + disk high-water metric (S6)

`FLAT_RSS_TOLERANCE = 15` (`soak-actor-cli.ts:71`) was set with headroom
because it wasn't verified beyond 15k ops. `DISK_GROWTH_MULTIPLIER = 12`
(`soak-actor.ts:155`) already bounds disk high-water; S6 wants an explicit
disk-file-size metric + assertion + a decision threshold, and to RUN at ≥20k.

**Files:**
- Modify: `server/src/canvas-v2/soak-actor-cli.ts` (run scale ≥20k ops; tighten
  `FLAT_RSS_TOLERANCE` to an empirically-derived bound)
- Modify: `server/src/canvas-v2/soak-actor.ts` (assert the disk high-water
  metric already computed in `diskSamples`/`finalDiskBytes`; set the S6
  decision threshold, e.g. disk > 10x live snapshot bytes sustained)

**Step 1: Run the ≥20k calibration.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun server/src/canvas-v2/soak-actor-cli.ts   # at >=20k ops; record RSS quartile ratio + disk high-water
```

**Step 2: Tighten** `FLAT_RSS_TOLERANCE` to the observed bound + modest
headroom; wire the disk high-water assertion + threshold.

**Step 3: Re-run — green** at the tightened settings; record the numbers in
this file's Execution notes (the S6 verdict feeds Task I1).

**Step 4: Commit.**
```bash
git add server/src/canvas-v2/soak-actor-cli.ts server/src/canvas-v2/soak-actor.ts
git commit -m "test(server): actor soak at >=20k ops; tighten FLAT_RSS_TOLERANCE; disk high-water metric + threshold (S6)"
```

---

### Task H4: Surface live SQLite disk-file-size on the deployment — S6 dogfood visibility (bounds §3-S6)

Task H3 asserts disk high-water in the *soak*; the S6 OBSERVE ruling ALSO
requires the disk metric to be visible on the *running dogfood deployment*, so
Task I1's S6 verdict is decidable on real traffic — exactly how S8/S9/S10 are
decided from live dev-overlay counters. Today `GET /api/canvas/metrics`
(`server/src/features/canvas-metrics.ts`) exposes per-room `sync`/`evictions`
but NOT the live per-room SQLite file size vs live snapshot bytes. Close that
half: add a `diskBytes` accessor, thread it through the D3 metrics endpoint,
and render it beside `tainted`/`repairCount` in the dev overlay.

**Files:**
- Modify: `server/src/canvas-v2/store.ts` (store the DB path in the constructor
  — `store.ts:36` already builds `path.join(dir, roomId + '.sqlite')`; add a
  `diskBytes(): number` accessor via `fs.statSync(dbPath).size`, and a live
  `snapshotBytes()` if not already reachable)
- Modify: `server/src/canvas-v2/actor.ts` + `server/src/canvas-v2/actors.ts`
  (expose `diskBytes` + live `snapshotBytes` in the D3 introspection the
  metrics endpoint reads — same surface as the existing per-actor stats)
- Modify: `server/src/features/canvas-metrics.ts` (add `diskBytes` +
  `snapshotBytes` to each room's payload entry — the same per-room shape the
  overlay already scrapes)
- Modify: `client/src/canvas-v2/DevOverlay.tsx` (extend `CanvasMetricsSyncEntry`
  / payload types + render a `diskBytes` and `disk:snapshot` ratio `Field`,
  `'—'` when absent — mirror the existing `tainted`/`pendingImports` fields)
- Test: `server/src/features/canvas-metrics.test.ts` (payload includes numeric
  `diskBytes`/`snapshotBytes` for a live room) + `client/src/canvas-v2/
  DevOverlay.test.ts` (renders the disk field; `'—'` fallback when metrics null)

**Step 1: Write the failing server test.** GET /api/canvas/metrics for a room
with a live actor returns numeric `diskBytes` and `snapshotBytes`.

Run (self-executing test script — never raw `bun test`):
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun server/src/features/canvas-metrics.test.ts   # end with process.exit(0) — SQLite handles
```
Expected: FAIL (field absent).

**Step 2: Implement** the `diskBytes()` store accessor + thread it through the
actor/`actors.ts` introspection and the metrics endpoint. **Step 3:** re-run —
green.

**Step 4: Client field** — failing `DevOverlay.test.ts` (renders the disk
field + `'—'` fallback), implement, green:
```bash
bun client/src/canvas-v2/DevOverlay.test.ts
```

**Step 5: Commit.**
```bash
git add server/src/canvas-v2/store.ts server/src/canvas-v2/actor.ts server/src/canvas-v2/actors.ts server/src/features/canvas-metrics.ts server/src/features/canvas-metrics.test.ts client/src/canvas-v2/DevOverlay.tsx client/src/canvas-v2/DevOverlay.test.ts
git commit -m "feat(canvas-v2): surface live SQLite disk-file-size in /api/canvas/metrics + dev overlay (S6 dogfood visibility)"
```

---

### Task H5: Crash recovery — mid-delete + mid-embed-write (bounds §5.3)

Extends `server/src/canvas-v2/crash-recovery.test.ts` + `crash-writer.ts` so a
`kill -9` mid-delete and mid-embed-write (`UpdateProps`) replays to a valid,
convergent doc.

**Files:**
- Modify: `server/src/canvas-v2/crash-writer.ts` (op loop includes deletes +
  prop-writes)
- Modify: `server/src/canvas-v2/crash-recovery.test.ts` (kill mid-delete /
  mid-embed-write → recover → invariant-clean + convergeable)

**Step 1: Write failing test.** Kill the writer while it's deleting /
prop-writing; the fresh actor reopens, replays the append-log, and the
recovered doc is invariant-clean and convergeable (re-entrant kill/recover
cycle stays correct).

**Step 2: Run.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun server/src/canvas-v2/crash-recovery.test.ts
```
End with `process.exit(0)` (subprocess + SQLite handles).

**Step 3–5:** implement → green → commit.
```bash
git commit -m "test(server): crash recovery replays mid-delete + mid-embed-write to a convergent doc"
```

---

### Task H6: Presence single-write-publisher unit for the new embed presence writer

The file-viewer presenting writer (D5) is a NEW presence writer — it must not
trip the `EphemeralStore` same-millisecond LWW tie. Unit-test the combined
single-write pattern.

**Files:**
- Modify: `client/src/canvas-v2/presence.test.ts` (extend)

**Step 1: Write failing test.** Publishing presenting + any co-published field
D5 touches goes out as ONE store write; two writes in the same wall-clock ms
would lose the second — assert the publisher combines them (like
`setViewportAndRefreshCursor`).

**Step 2–5:** run-fail → confirm the D5 publisher combines → commit.
```bash
git commit -m "test(canvas-v2): file-viewer presenting rides a single presence write (no same-ms LWW loss)"
```

---

### Task H7: Nightly soak workflow green on recalibrated settings (bounds DoD #9)

**Files:**
- Modify: `.github/workflows/canvas-soak.yml` (confirm it runs the actor soak
  at the ≥20k scale + tightened tolerance; keep the soak subpath
  `@ensembleworks/canvas-sync/soak`, never the main index)

**Step 1:** Verify the workflow invokes the recalibrated CLIs; the commands
match H2/H3.

**Step 2:** YAML parses.
```bash
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/canvas-soak.yml")); print("ok")'
```

**Step 3: Commit.**
```bash
git add .github/workflows/canvas-soak.yml
git commit -m "ci: nightly soak runs recalibrated actor soak (>=20k ops, tightened tolerance)"
```

---

## Seam I — OBSERVE verdicts + closeout

### Task I1: Record OBSERVE straddler verdicts (S6/S8/S9/S10) — bounds DoD #10

"Observe" is a deliverable, not a shrug. Each gets a DATED decision (fix
triggered or explicitly re-deferred) WITH counter/metric evidence, written
into this file's Execution notes.

**Files:**
- Modify: `docs/plans/2026-07-15-canvas-phase4-parity.md` (Execution notes)

**Step 1: Gather evidence.**
- **S6 (VACUUM):** the disk high-water numbers from Task H3 (soak) + the
  threshold, AND the live disk:snapshot ratio from the dogfood dev overlay
  (Task H4); verdict = re-defer (threshold not tripped) OR implement
  compaction+VACUUM (only if tripped).
- **S8 (lossy repair edges):** review the repair-firing counter in the dogfood
  dev overlay + the extended soak; verdict = re-defer if no firing, fix if a
  real firing occurred.
- **S9 (`pendingImports` re-request):** review the dev-overlay counter; verdict.
- **S10 (reconnect since-acked delta):** review the reconnect-backfill byte
  counter (dev overlay); verdict = implement only if bytes are materially
  painful (multi-MB routine reconnects).

**Step 2: Write** each dated verdict + evidence into Execution notes.

**Step 3: Commit.**
```bash
git add docs/plans/2026-07-15-canvas-phase4-parity.md
git commit -m "docs(canvas-phase4): record OBSERVE verdicts S6/S8/S9/S10 with evidence"
```

---

### Task I2: Final invariants gate (bounds DoD #11)

**Files:** none (verification) + `AGENTS.md` if a doc note is warranted.

**Step 1: Full green gate.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase4
bun run typecheck
bun run test
bun run build
```
Expected: all green.

**Step 2: Clean-room + exposure invariants.**
```bash
bun canvas-model/src/boundary.test.ts
bun canvas-doc/src/boundary.test.ts
bun canvas-editor/src/boundary.test.ts
bun canvas-react/src/boundary.test.ts
bun client/src/engine.test.ts
bun client/scripts/exposure-audit.ts
```
Expected: no server/tldraw imports in `canvas-*`; `team` room proven to resolve
`'tldraw'` unconditionally.

**Step 3: E2E + perf smoke.**
```bash
cd e2e && bunx playwright test tests/parity.spec.ts tests/canvas-v2.spec.ts perf/canvas-v2-perf.spec.ts
```

**Step 4:** Tick the Done-criteria checklist below (only items independently
verified this session, with an inline pointer to the evidence).

**Step 5: Commit** any doc note.
```bash
git commit -m "docs(canvas-phase4): final invariants gate green" --allow-empty
```

---

## Execution notes (2026-07-15, Phase 4)

_Placeholder — the implementing agent fills this in as it goes, mirroring the
Phase-3 plan's "Execution notes" section: cross-unit findings, any ratified
deviations from this plan's literal text, the P1 undo-mechanism verdict
outcome as-built, the S6/S8/S9/S10 OBSERVE verdicts with dated evidence (Task
I1), the re-baselined perf numbers (Seam G) and re-calibrated stability
constants (Seam H, with the empirical `BOUNDED_GROWTH_K`,
`FLAT_RSS_TOLERANCE`, and disk-threshold numbers), and — IF Task G3's
commit-cadence scenario proved too noisy to gate — the explicit owner-recorded
deviation from DoD #8 (never a silent ungated landing)._

### Carried cross-unit findings (accumulate as units land)

- **B1 (undo/redo):** shipped as the editor-level inverse-intent stack (A1
  verdict). Quality review caught + fixed two bugs before B4/B5 built on it:
  (1) `replay()` now try/catches per-op (a `ReparentShapes` inverse could hit
  Loro's cycle guard and throw under concurrent remote reparent — broke the
  tolerance contract); (2) multi-id cascade-delete undo now globally
  depth-sorts the deduped subtree union (`orderParentBeforeChild`) so a child
  listed before its ancestor is no longer detached to root on undo. Regression
  tests verified with teeth. NOTE for anyone touching canvas-doc: raw-tree
  mutation outside `LoroCanvasDoc`'s public mutators corrupts its private
  id→node index (why UndoManager was rejected) — a latent hazard beyond undo.
- **B2 (delete wiring):** DECISION — Delete/Backspace delete regardless of
  modifiers (matches v1; B4 owns `Ctrl+Z`'s explicit modifier check). No
  change made; recorded as a conscious sign-off, not an oversight.
- **CARRIED TO B3 (must-fix) — keyboard delivery is focus-scoped:** the v2
  keydown listener lives on `Viewport`'s own div, but the toolbar buttons are
  DOM *siblings* of `Viewport`, so a keydown fired while a toolbar `<button>`
  holds focus (e.g. select a shape, click a tool button, press Delete/Escape)
  never bubbles to `handleInput` — the shortcut silently no-ops. Pre-existing,
  but it undermines Delete (B2), Escape-cancel (B3), AND `Ctrl+Z` (B4). B3
  fixes keyboard delivery once (so global shortcuts survive toolbar-button
  focus) with a regression test that focuses a toolbar button, then asserts
  Escape/Delete still reach the editor.
- **B4 (Ctrl+Z keybinding):** undo granularity is per-pointermove-commit — the
  tool-loop create/arrow-draw path commits incrementally, one batch per
  pointermove. So `Ctrl+Z` after DRAG-creating a shape undoes one size
  increment, not the whole gesture; multiple `Ctrl+Z` are needed to remove a
  drag-created shape. This is the pre-existing per-move commit cadence (an H3
  watch-item), NOT introduced by B4 — but it is now reachable via the
  keybinding. Gesture-atomic undo is the open "full undo-to-gesture-start"
  parity item; B6's undo E2E should judge whether per-increment undo is
  acceptable for dogfood, else a follow-up coalesces a gesture into one undo
  entry. (Redo scoping fix landed in B4: `Ctrl+Y` requires `ctrl`
  specifically, never `meta` — `Cmd+Y` is Safari's native "Show All History"
  and nothing here calls preventDefault; Mac redo is `Cmd+Shift+Z`.)
- **B5 (transform cancel-revert) — over-revert of non-geometry fields:**
  transform cancel-revert (and B1's undo) restore shapes via a FULL-shape
  `putShape` overwrite of the gesture-start/pre-mutation snapshot, not a
  field-surgical inverse. Consequence: a concurrent remote edit to a
  NON-geometry field (color/opacity/isLocked/meta/parentId/frame name) of a
  shape being transformed-then-cancelled (or undone) is stomped back to the
  snapshot value. Text is safe (separate Loro container). Judged non-blocking
  by both B5 reviews: narrow window (same-shape concurrent cross-field edit
  mid-gesture), and consistent with B1's established inverse convention —
  fixing only cancel would make cancel/undo inconsistent. FIX RECIPE (its own
  future unit, applies to BOTH B1's undo inverses and B5's cancel): compute a
  per-intent surgical inverse that restores ONLY the fields each intent
  changed (geometry x/y/rotation/w/h for resize/rotate; parentId for reparent;
  etc.), merged onto the CURRENT live shape rather than overwriting the whole
  shape. Tied to the undo-quality / gesture-atomic-undo family.
- **OWNER DECISION (2026-07-15) — undo-quality work DEFERRED to a separate
  follow-up, NOT Phase 4.** B6 empirically confirmed per-increment undo (a
  3-move drag → 3 undo entries; one `Ctrl+Z` steps back one move, not the whole
  gesture) — owner acknowledged this "*is* very painful" but chose to do the
  fix as separate work rather than expand Phase 4. So BOTH the gesture-atomic
  undo (coalesce a gesture's per-move commits into one undo entry) AND the
  field-surgical inverse (over-revert fix above) are OUT of Phase 4 scope,
  tracked here as the first item of a dedicated "undo-quality" follow-up.
  Phase 4 ships per-increment undo + whole-shape restore knowingly. B6's E2E
  encodes the current (per-increment) behavior honestly, so it will need
  updating when the follow-up lands.
- **C1 (NoteShape) — handwriting-font webfont not loaded on the v2 client
  (MUST fix within Seam C, before C7 goldens).** v1 stickies use font-family
  `tldraw_draw`, but that webfont is registered at runtime only by tldraw's
  `FontManager` inside a live `<Tldraw>` editor — which the v2 client
  (`CanvasV2App`) never mounts, and `client/index.html` doesn't load it. So
  today NoteShape/TextShape/TextEditor declare the right family but fall
  through to `sans-serif` on the actual v2 client. This is a shared parity
  prerequisite for C1/C3/C6 and MUST land BEFORE C7 captures component
  goldens (else the goldens bake in the wrong, sans-serif rendering). Fix =
  load the tldraw draw/handwriting webfont asset into the v2 client bundle
  (client-workspace `@font-face`/index.html or a canvas-v2 font-load module) —
  fold into C6 (or a small dedicated Seam-C task) ahead of C7.

---

## Done criteria (bounds §4 — every line has a check)

- [ ] **#1 No core kind renders as BoxShape.** note/frame/text/geo resolve to
  dedicated components via `shapeRegistry.ts`; `shape-registry.test.ts` asserts
  it; component goldens exist for each kind's representative states. _(C1–C5, C7)_
- [ ] **#2 Cross-renderer parity gate exists and passes.** `parity.spec.ts`
  renders the seeded room under v1 + v2 in CI, masked diff within per-region
  tolerances, parity score emitted as a per-run artifact; a deliberate sticky
  regression fails CI. _(F1, F2)_
- [ ] **#3 Delete works end-to-end.** select + Delete/Backspace → gone in the
  acting client AND a second client; Delete while text-editing does NOT delete.
  _(B2, B6)_
- [ ] **#4 Undo/redo works end-to-end.** canvas-editor units cover undo/redo of
  create/move/resize/delete/text; E2E covers Ctrl+Z after delete and after
  drag; a two-client test proves undo never reverts the peer's ops; P1 verdict
  recorded. _(A1, B1, B4, B6)_
- [ ] **#5 Gesture cancellation is total.** Escape, pointercancel, and blur each
  cancel an in-flight create-drag AND arrow-draw (unit + E2E); cancelling an
  in-flight transform reverts to gesture-start geometry. _(B3, B5, B6)_
- [ ] **#6 The three embed write-path features work.** terminal rename (+drag);
  screenshare stillUrl stamp-back + aspect relock; file-viewer rev-bump +
  peer-follow — each unit-tested against the dispatch channel + a two-client
  E2E through `/sync/v2`. _(D1–D6)_
- [ ] **#7 Connection banner proven.** E2E: dead sync server → visible banner
  within seconds; recovery clears it. _(E1, E2)_
- [ ] **#8 Perf gates green under honest budgets.** 60 fps @ 1k retained; NEW
  dense-seed, select-all@1k, drag-cadence scenarios baselined in
  `canvas-v2-perf.json` with ≤15% gating; entry chunk within ~2% of the
  215.4 kB / 63.1 kB baseline. _(G1–G4)_
- [ ] **#9 Stability gates green under tightened calibration.** actor soak
  ≥20k ops with a tightened empirical `FLAT_RSS_TOLERANCE`; K re-calibrated;
  op mix includes deletes + text edits + embed writes; convergence/fuzz/
  crash-recovery green; `canvas-soak.yml` nightly green. _(H1–H7)_
- [ ] **#10 Every OBSERVE straddler has a recorded verdict.** S6/S8/S9/S10 each
  dated with counter/metric evidence in Execution notes. _(I1)_
- [ ] **#11 Repo invariants intact.** typecheck/build/`bun run test` green;
  clean-room boundary tests pass; `engine.test.ts` + `exposure-audit.ts` still
  prove `team` can never run v2; bite-sized TDD commits, true merge commits.
  _(I2)_
