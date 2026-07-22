# Canvas v2 — FULL Multi-Page Support (Step 4, final sub-cycle) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 real, full-parity multi-page support: a reactive
`currentPageId` in editor state, tools that parent new content onto the CURRENT
page, a renderer that PAINTS ONLY the current page, create/switch/delete/rename/
reorder page intents (with undo/redo), and a page-switcher UI — so a user can
have many pages in a v2 room and see only one at a time, exactly like v1/tldraw.

**Architecture:** The model/CRDT substrate already exists (`Page` schema,
`CanvasDoc.putPage`/`deletePage`/`listPages`, a `pages` Loro map). This
sub-cycle adds the three missing layers, all composing with the landed z-order
work: (1) `currentPageId` becomes editor-local state (per-peer, reactive, set
via a new `SetCurrentPage` VIEW intent, read LIVE by every create tool exactly
the way they already read `camera`) — replacing the readonly constructor-fixed
`editor.pageId` at every tool/clipboard/image parenting site; (2) a pure render
FILTER (`pageIdOf(shape) === currentPageId`) in `canvas-react`'s `ShapeLayer`
AND `EmbedLayer`, composed with the existing `orderForPaint` z-sort + culling;
(3) four MUTATION intents (`CreatePage`/`DeletePage`/`RenamePage`/`ReorderPage`)
in `canvas-editor`, each with a precomputed undo/redo inverse (extending the
`InverseOp` union with `putPage`/`deletePage`), where `DeletePage` reuses the
DeleteShapes cascade machinery to delete the page's whole shape subtree and its
undo restores BOTH the page record AND every shape. Page ORDER is convergent:
`Page.index` becomes a typed fractional string; pages sort by `(index, id)` (the
same non-migrating tie-break the z-order corpus uses). A new client-side
`PageSwitcher` component (v2's own, informed by v1's `PanelPages` layout) is the
UI. One browser interaction contract pins "switching pages changes the rendered
shapes" end-to-end.

**Tech Stack:** TypeScript pure-FSM editor, Zod (`canvas-model`), React 18
(`canvas-react` / client), Bun test runner, Playwright (browser contract),
`@ensembleworks/interaction-contracts`. Reuses the landed
`canvas-model/src/fractional-index.ts` (`generateKeyBetween`) and
`orderForPaint` / `pageIdOf`.

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These rules were violated repeatedly on this branch (~15 false factual claims,
several fake REDs caught; EVERY prior sub-cycle on this branch — draw, line,
assets — had first-pass mutants ESCAPE). Read every line before writing code.

### Test runner (this is where people lose hours)
- **`bun test` is NOT our runner. NEVER run it.** It ignores our harness.
  - Full suite: `bun run test`
  - One file: `~/.bun/bin/bun <path/to/file.test.ts>`
  - One package's suite: `cd <pkg> && bun test.ts` (the package's own entry)
  - Always `export PATH="$HOME/.bun/bin:$PATH"` first.
- **Both runners are FAIL-FAST** — `process.exit(1)` on the first failing file.
  Neither prints "N passed, 1 failed." **Judge pass/fail by the EXIT CODE, not
  the output tail.**
- **`$?` in a compound command is the LAST command's status, not the suite's,
  and in zsh `$?` piped through `tail` is WRONG.** Run the suite as its own
  command and read `$?` on its OWN bare line, or redirect to a file and read it.
  This exact mistake was made on this branch.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — multi-page sub-cycle; see plan'`
  before `bun run test` on any task whose diff touches a **gated path**
  (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`)
  but not the contracts module. Once **H1/Z1** (which touch
  `interaction-contracts/` + `e2e/`) are in the tree, the gate passes on the
  diff alone.
- `server`'s typecheck is `bunx tsc --noEmit`. No `server/` changes here, but the
  full `bun run typecheck` covers all workspaces (run it every task).
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every command
  block. Agent bash cwd resets between calls.
- Browser contracts run: `cd e2e && bunx playwright test --project=e2e -g <name>`.

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
   catches it). **RUN each mutant by hand** — write the wrong impl, watch the
   test go RED, revert. EVERY cycle on this branch found first-pass mutants that
   ESCAPED a table that was never actually executed. A mutant table you did not
   RUN is a mutant table that lies. This is THE recurring lesson of this branch.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). Forbidden patterns (verified against the
  test at plan time, `boundary.test.ts:35-47`): imports of `loro-crdt`, `ws`,
  `@tldraw/`, `react`, `canvas-sync` / `@ensembleworks/canvas-sync`;
  `from '../server'`; and the literals `document.`, `window.`, `Date.now(`,
  `Math.random(`. It does **NOT** scan `express`/`navigator` — don't chase those.
- All page STATE/INTENTS/ORDERING land in clean-room packages (`canvas-model`,
  `canvas-editor`) and must stay pure — no DOM, no clock, no PRNG. Page ids and
  indices are minted by the CLIENT (the composition edge) and carried verbatim
  in the intent payload, exactly as `CreateShape` carries a fully-formed shape.
- `canvas-react` / `client` MAY touch the DOM (the switcher UI + render filter).

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. Prefer wording that cannot rot — describe by
  argument/behavior, not raw line numbers or counts.

### Interaction contracts (CLAUDE.md — mandatory)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. **Gated tasks here: E2** (tools read current page),
  **R1** (render filter, `canvas-react/src/`), **U1** (switcher UI,
  `client/src/canvas-v2/`). The pure model/editor tasks (A1, E1, E3, E2b) touch
  `canvas-model/` or `canvas-editor/src/` *outside* `tools/` — **not** gated.
  Landing **H1 + Z1** satisfies the gate for the whole sub-cycle's diff.
- **Obligation 3 (both adapters):** the ONE new Obs `pageCount()` reads doc
  state, so it is REAL in BOTH adapters — `editor.doc.listPages().length` (fsm)
  and `window.__ew.doc.listPages().length` (browser). No throw-stub (it is not a
  render/DOM concept). The render-filter proof itself reuses the EXISTING
  browser-only `paintOrder()` Obs (no change to it).
- **Obligations 2 & 4:** Z1 runs RED against the un-filtered renderer (R1's
  filter reverted) and the reviewer INDEPENDENTLY reproduces red→green (revert
  R1's filter, observe the failure, restore) — never accept the implementer's
  report of it. Z1's exact RED handle is named in its task.
- **Page switch/create is driven from DOM (the switcher), not a tool FSM** — so
  Z1 is **`level: 'browser'`** and drives the switcher via `'element'`-anchor
  clicks (same precedent as the style-panel swatch P3 contracts). The FSM runner
  never sees it (library.test.ts filters `level==='fsm'`).

---

## Decisions (settled — do not re-litigate)

### D-1. `currentPageId` is EDITOR-LOCAL state, initialized from `opts.pageId`, read LIVE (the crux)
- **Add `currentPageId: string` to `EditorState`** (`editor.ts`) — reactive,
  per-peer, NEVER persisted to the CRDT (each collaborator views their own
  current page; the DOC's `pages` set is what's shared). It sits alongside
  `camera`/`selection`/`hover`/`editingId`/`nextShapeStyle`.
- **Initialized from `opts.pageId` at construction.** `INITIAL_STATE` cannot
  reference `opts`, so construct the store IN the constructor:
  `this.store = createStore<EditorState>({ ...INITIAL_STATE, currentPageId: opts.pageId })`
  (change `store` from an inline field-initializer to a constructor assignment).
  `INITIAL_STATE` carries a documented placeholder `currentPageId: ''` that the
  constructor ALWAYS overwrites before any subscriber exists — it is never a
  live value. `get()` adds `currentPageId: s.currentPageId` to the frozen
  snapshot.
- **`editor.pageId` STAYS** as the readonly constructor field — it is the
  INITIAL currentPageId, the bootstrap/replay home page, and the `EditorOpts`
  contract. It is no longer read by any tool for parenting; `editor.get().
  currentPageId` is. There is NO `?? editor.pageId` fallback needed:
  currentPageId is always a non-empty string (seeded from `opts.pageId`, only
  ever reassigned to a real page id by `SetCurrentPage`). Decision 1(a) chosen
  over 1(b) — the cleaner path.
- **THE RIPPLE — every parenting site reads the current page LIVE.** The tools
  currently do `const pageId = editor.pageId` ONCE at tool-factory construction
  (a captured, fixed value — that IS the single-page bug). Replace with a LIVE
  read at each USE (the same way `worldOf` already reads `editor.get().camera`
  live per event). Exhaustive site list (verified against the tree — all must
  change to `editor.get().currentPageId`):
  - `canvas-editor/src/tools/create.ts:241` (note/text/geo/frame)
  - `canvas-editor/src/tools/arrow.ts:102`
  - `canvas-editor/src/tools/line.ts:155`
  - `canvas-editor/src/tools/draw.ts:170`
  - `canvas-editor/src/clipboard-intents.ts:78` (paste-on-top max-sibling scan
    target page), `:114` (duplicate clone parent), `:136` (paste clone parent)
  - `client/src/canvas-v2/CanvasV2App.tsx:1116` + `:1165` (image drop/paste →
    `createImageFromBlob(editor, …, editor.get().currentPageId)`)
- **Replay determinism preserved.** currentPageId is editor state, set via a
  VIEW intent and read live — identical purity posture to `camera`. `replay.ts`
  seeds the Editor with `pageId: session.meta.pageId`, so a replayed session's
  initial current page matches; any `SetCurrentPage` in a recorded script
  reproduces deterministically.

### D-2. `SetCurrentPage` is a VIEW intent — no undo (like `SetCamera`)
`SetCurrentPage { type; pageId }`: `applyOne` returns
`{ state: { ...state, currentPageId: intent.pageId }, docMutated: false,
stateChanged: true }` — no doc write, no undo/redo arrays, mirroring
`SetCamera`/`SetSelection`/`SetHover`/`BeginEdit`/`EndEdit`/`SetNextStyle`
exactly. **Switching pages is a VIEW change, not undoable** — undoing a switch
would be a surprising "jump the user's viewport" step, and view intents have no
inverse machinery in this editor by construction.

### D-3. Four MUTATION page intents; `InverseOp` grows `putPage`/`deletePage`
Extend the `InverseOp` union (`editor.ts`) with
`{ op: 'putPage'; page: Page }` and `{ op: 'deletePage'; id: string }`, and
handle both in `replay()` (`this.doc.putPage(op.page)` / `this.doc.deletePage(
op.id)`, each already no-throw by CanvasDoc contract, so they ride the existing
try/catch tolerance). The four intents:
- **`CreatePage { type; page: Page }`** — `doc.putPage(intent.page)`; undo
  `[{op:'deletePage', id: page.id}]`; redo `[{op:'putPage', page}]`. The client
  mints the full `Page` (id via `random`, `name`, and a top-of-stack `index`)
  and carries it verbatim — same "caller builds the fully-formed record" posture
  as `CreateShape`. CreatePage does NOT change `currentPageId` itself (doc
  mutation and view change stay separate); the switcher batches CreatePage +
  SetCurrentPage in ONE `applyAll` (see D-6 for the undo-strands-currentPageId
  edge and its client-side clamp).
- **`DeletePage { type; id }`** — the hard one. `CanvasDoc.deletePage` removes
  ONLY the page record (verified: `loro-canvas-doc.ts:466-469`, no shape
  cascade). So this intent must ALSO cascade-delete the page's shapes, and its
  undo must restore BOTH:
  1. **Refuse deleting the last page:** `if (doc.listPages().length <= 1)
     return { state, docMutated: false, stateChanged: false }`.
  2. **Collect + delete the shape subtree** using the EXISTING DeleteShapes
     machinery: roots on the page = `doc.listShapes().filter(s => s.parentId ===
     intent.id)`; for each root, `collectSubtreeParentFirst(doc, root.id)`; union
     (dedupe by id); `deleteShape(root.id)` per root (each cascades its subtree).
  3. **Delete the page record:** `doc.deletePage(intent.id)`.
  4. **Undo** (parent-before-child, page first):
     `[{op:'putPage', page}, ...orderParentBeforeChild(union, byId).map(s =>
     ({op:'putShape', shape: s}))]` — putPage FIRST so the shapes rehome onto an
     existing page. **Redo:** `[...roots.map(r => ({op:'deleteShape', id: r.id})),
     {op:'deletePage', id: intent.id}]`.
  5. `page` for the undo = the pre-image from `doc.listPages().find(p => p.id ===
     intent.id)` captured BEFORE deletion. If it doesn't resolve → no-op.
  - DeletePage does NOT touch `currentPageId`. When the user deletes the page
    they're ON, the SWITCHER computes an adjacent page and batches
    `SetCurrentPage(adjacent)` in the same `applyAll` (D-6).
- **`RenamePage { type; id; name }`** — `const page = doc.listPages().find(...);
  if (!page) no-op; doc.putPage({ ...page, name: intent.name })`; undo
  `[{op:'putPage', page}]` (pre-image); redo `[{op:'putPage', page:{...page,
  name}}]`. The `{...page}` spread preserves `index` and any passthrough tldraw
  fields (looseObject). Mirrors `SetText`'s pre-image-inverse convention.
- **`ReorderPage { type; id; index }`** — `const page = find; if (!page ||
  page.index === intent.index) no-op; doc.putPage({ ...page, index: intent.index
  })`; undo/redo full-page-inverse pair, exactly like `SetIndex` does for shapes.
  The client computes the fractional `index` (D-4).

All four are per-id tolerant (silent no-op on an unknown/last-page id — never
throw), consistent with the applyAll TOLERANCE CONTRACT.

### D-4. `Page.index` typed as a fractional string; pages order by `(index, id)`, NO migration
- **Type it:** `pageSchema = z.looseObject({ id: pageIdField, name: z.string(),
  index: z.string().optional() })`. Optional so pre-existing pages (the v2
  bootstrap `page:p`, which carries no index; a synced tldraw room's pages,
  which carry their own fractional `index` via looseObject passthrough) stay
  valid. **No migration** — same non-destructive posture as the all-`'a1'`
  z-order corpus (z-order Decision D-2).
- **Order:** a new pure `orderedPages(pages: readonly Page[]): Page[]` in
  `canvas-model` (co-locate with `document.ts` or a small `pages.ts`), sorting by
  `(index ?? '', id)` — lexical `index`, then `id` tie-break. A missing index
  (`''`) sorts BEFORE any real fractional key (`'a0'`…), so the un-indexed
  bootstrap page sorts first and every CREATED page (which always gets a real
  index) appends after it — convergent, a pure function of `(index, id)`, no
  dependence on `listPages()`/map iteration order.
- **Minting on create/reorder (client, D-6):** new page index =
  `generateKeyBetween(maxExistingIndex ?? null, null)` (append after the last);
  reorder index = `generateKeyBetween(prevNeighborIndex ?? null,
  nextNeighborIndex ?? null)` — exactly v1 `PanelPages`'s `getIndexBetween`
  pattern, using the landed `canvas-model/src/fractional-index.ts`.

### D-5. The render filter — in the RENDERER's paint step, composed with z-order + culling
- **Where:** `canvas-react/src/ShapeLayer.tsx` AND
  `canvas-react/src/embed/EmbedLayer.tsx`. BOTH render shapes and BOTH must
  filter — otherwise another page's embeds/shapes pile onto the current screen.
  (Confirmed both currently render EVERY shape in the snapshot with NO page
  filter.)
- **How:** read `currentPageId` from editor state (both layers already call
  `useEditorState(toolContext.editor)`), and keep only shapes whose page
  ancestor IS the current page: `pageIdOf(snapshot, shape) === currentPageId`.
  `pageIdOf` (`canvas-model/src/geometry.ts`, already EXPORTED via `export * from
  './geometry.js'`) walks parents to the `page:` ancestor — a shape on another
  page returns that other page's id (filtered out); a shape on a ghost/broken
  chain returns a non-matching id or `undefined` (filtered out; repair rehomes
  it). **Migration-safe:** in a single-page room every shape's `pageIdOf ===
  'page:p' === currentPageId`, so ALL shapes still render.
- **Compose with what's there:** in `ShapeLayer`, the filter is applied to the
  culled shape set BEFORE (or interleaved with) `orderForPaint` — the visible ∩
  current-page set, then z-ordered. Filtering before `orderForPaint` is fine:
  `orderForPaint` already treats a shape whose parent is absent from the input
  set as a forest root, so dropping cross-page shapes never orphans an in-page
  child's ordering. In `EmbedLayer`, add the page predicate to its existing
  `isEmbedKind && worldBounds-intersect` filter.
- **Purity/convergence:** the filter is a pure function of `(currentPageId,
  shapes)` — no cull order, no iteration order.

### D-6. The switcher UI — a compact page TAB BAR (JUDGMENT CALL #1, recommend this surface)
A NEW v2 component `client/src/canvas-v2/PageSwitcher.tsx` (v2's own, wired to
the v2 intents — v1's `PanelPages` is entirely tldraw and NOT reusable, but its
LAYOUT informs this). **Recommended surface: a thin horizontal tab bar** in the
top chrome (beside/under the existing tool toolbar) — the smallest
parity-adequate surface, always visible, trivially addressable by
`data-*`-anchored contract clicks. Contents:
- One tab per page, in `orderedPages` order; current page highlighted
  (`data-canvas-v2-page="<pageId>"`, `aria-pressed`). Click →
  `editor.applyAll([{ type:'SetCurrentPage', pageId }])`.
- A **"＋" new-page button** (`data-canvas-v2-new-page`): mint `id`
  (`page:${random}`), `name` (`Page N`), `index`
  (`generateKeyBetween(maxIndex ?? null, null)`), then
  `editor.applyAll([{type:'CreatePage', page}, {type:'SetCurrentPage',
  pageId: page.id}])` (create AND switch, one commit — tldraw parity).
- Per-tab **rename** (double-click the tab or a ⋯ menu → `window.prompt`) →
  `RenamePage`; **delete** (⋯ → `window.confirm`, disabled when only one page) →
  compute an adjacent page id from `orderedPages`, then
  `editor.applyAll([{type:'DeletePage', id}, ...(deletingCurrent ?
  [{type:'SetCurrentPage', pageId: adjacent}] : [])])`; **reorder** (◂ ▸ move
  buttons or ⋯ Move left/right) → `ReorderPage` with a `generateKeyBetween`
  index between neighbors.
- Reads pages from `useDocSnapshot(toolContext).pages` (verified: `dumpModel`
  populates `pages` via `doc.listPages()`, so the snapshot re-renders the
  switcher on every page commit) and `currentPageId` from
  `useEditorState(editor)`.
- **Undo-strands-currentPageId edge + clamp (D-3):** `SetCurrentPage` is a view
  intent with no inverse, so undoing a `CreatePage`+`SetCurrentPage` batch
  deletes the page but leaves `currentPageId` naming it → the render filter shows
  an empty canvas. Handle it the SAME way the existing undo path prunes dangling
  selection (`pruneDanglingSelectionIntents`): after `editor.undo()`/`redo()` in
  `handleGlobalShortcut`, if `editor.get().currentPageId` is not a live page id,
  dispatch `SetCurrentPage(canonicalPageId(pages))`. Add a tiny
  `clampCurrentPageIntents(editor)` helper (client) alongside the prune call.

### D-7. Presence-by-page — DEFERRED (JUDGMENT CALL #2, recommend defer)
v1 groups collaborators by their `currentPageId` (`PanelPages` /
`AvOverlay.participants`) and hides cross-page cursors. v2 presence
(`Cursors`/`EditingIndicators`) is per-ROOM; page-scoping it (publish each
peer's `currentPageId` in the canvas-sync `Presence` payload, then hide cursors
of peers on other pages) is a NICETY that needs a canvas-sync `Presence` field
change and is NOT required for a shippable multi-page feature. **Recommend
DEFER**; flag to owner. Out of scope: this sub-cycle ships per-peer page views
with room-wide cursors (a peer on page 2 still sees a peer-on-page-1's cursor —
harmless, cursors are world-space and simply land off the visible content).

### D-8. New Obs — `pageCount()` (both adapters, real); reuse existing `paintOrder()`
The render-filter PROOF (Z1) reads the existing browser-only `paintOrder()` (DOM
shape order = what's painted = the filter's visible output). The ONE new Obs is
`pageCount(): number` — `editor.doc.listPages().length`, REAL in both adapters
(doc read, no throw-stub) — so a contract can assert "create added a page" /
"delete removed one" at the model level. No `currentPageId()` Obs is added
(paintOrder already proves the switch's visible effect; a direct state read would
add surface without teeth the filter proof doesn't already give).

### Judgment calls surfaced to the owner
1. **Switcher surface = a thin horizontal TAB BAR in the top chrome (D-6).**
   Recommend this over a dropdown or a side panel: smallest parity-adequate,
   always-visible, easy to drive from contracts. **OK?** (recommend yes.)
2. **Presence-by-page DEFERRED (D-7).** Ship per-peer page views with room-wide
   cursors; page-scoped presence is a follow-up needing a canvas-sync Presence
   field. **OK to defer?** (recommend yes.)
3. **Undo does NOT restore a page switch (D-2); a CreatePage-undo clamps
   `currentPageId` to the canonical page (D-6).** Reasonable? (recommend yes.)

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| A1 | `Page.index` typed + `orderedPages(pages)` `(index,id)` sort | canvas-model (no) | — | `orderedPages` absent / wrong order / no id tie-break |
| E1 | `currentPageId` in `EditorState` (init from `opts.pageId`) + `SetCurrentPage` view intent | canvas-editor/src (no) | — | `EditorState` has no `currentPageId`; `SetCurrentPage` unhandled |
| E3 | `CreatePage`/`DeletePage`/`RenamePage`/`ReorderPage` intents + `putPage`/`deletePage` InverseOps + `replay()` cases | canvas-editor/src (no) | — | intent unhandled; DeletePage leaves shapes / undo loses shapes |
| E2 | create/arrow/line/draw parent onto `editor.get().currentPageId` | canvas-editor/src/tools (**YES**) | E1 | shape created after switch still lands on the old page |
| E2b | clipboard-intents paste/duplicate target the current page | canvas-editor/src (no) | E1 | paste after switch lands on the old page |
| R1 | `ShapeLayer` + `EmbedLayer` paint ONLY `pageIdOf===currentPageId` | canvas-react (**YES**) | E1 | other-page shapes still painted; single-page room hides nothing |
| U1 | `PageSwitcher.tsx` (tabs/new/rename/delete/reorder) + mount in `CanvasV2App` + image-drop uses currentPageId + undo clamp | client/canvas-v2 (**YES**) | A1, E1, E3 | switcher absent; "+ new page" doesn't switch/create |
| H1 | `pageCount()` Obs (both adapters real) | interaction-contracts + e2e + canvas-editor/contracts (satisfies gate) | — | Obs absent |
| Z1 | browser contract `switching-page-changes-rendered-shapes` | interaction-contracts + e2e (**YES**/satisfies gate) | R1, U1, E1, E3, H1 | render filter absent → other-page shapes stay painted |

Land **A1/E1/E3** first (pure foundations, no gate). **E2/E2b/R1** need E1.
**U1** needs A1+E1+E3. Land **H1 before Z1** so the Obs exists. Run the gated
pre-Z1 tasks (E2, R1, U1) with the `UX_CONTRACT_PR_BODY` opt-out until H1/Z1 are
in the tree.

---

## Task A1 — `Page.index` typed + `orderedPages` (canvas-model, pure)

**Files:**
- Modify: `canvas-model/src/document.ts` (`pageSchema` gains
  `index: z.string().optional()`; add `orderedPages`)
- Modify: `canvas-model/src/index.ts` (already `export *`s `document.js` —
  confirm `orderedPages` is exported)
- Test: `canvas-model/src/document.test.ts` (or a new `pages.test.ts`)

Add `index: z.string().optional()` to `pageSchema`. Implement
`orderedPages(pages: readonly Page[]): Page[]` sorting by
`(a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1
: a.id < b.id ? -1 : a.id > b.id ? 1 : 0`.

**Step 1 — RED test.** Cases:
1. Three pages input scrambled with indices `a3, a1, a2` → output ids in
   `a1, a2, a3` order.
2. `(index, id)` tie-break: two pages both index `'a1'`, ids `page:b` then
   `page:a` in input → output `[page:a, page:b]`, deterministic regardless of
   input order.
3. **Missing-index page sorts FIRST** (the un-indexed bootstrap `page:p`
   alongside an indexed `page:x` index `'a0'`) → `[page:p, page:x]`.
4. `pageSchema.parse({ id:'page:p', name:'Canvas', index:'a0' })` keeps `index`;
   `parse({ id:'page:p', name:'Canvas' })` succeeds with `index === undefined`.

Run `~/.bun/bin/bun canvas-model/src/document.test.ts`; if `orderedPages is not a
function` before any impl, add a stub export so the RED is your *assertion*.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Sort by `index` only, no id tie-break | case 2 nondeterministic |
| Missing index sorts LAST / throws on undefined | case 3 order |
| Sort by `id` only (ignores index) | case 1 |
| Reverse order | case 1/3 |

**Step 2–5:** implement, GREEN, `bun run typecheck` (the `pageSchema` change
ripples — the `_PageIdMatches` drift guard still holds; check no consumer breaks
on the now-typed optional `index`), commit
(`feat(canvas-model): type Page.index and add orderedPages ((index,id) sort)`).

---

## Task E1 — `currentPageId` in `EditorState` + `SetCurrentPage` (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/editor.ts` (`EditorState`, `INITIAL_STATE`, store
  construction in the constructor, `get()`, `applyOne` `case 'SetCurrentPage'`)
- Modify: `canvas-editor/src/intents.ts` (add `SetCurrentPage` to the union +
  doc comment, next to the other view intents)
- Test: `canvas-editor/src/editor.test.ts`

Add `readonly currentPageId: string` to `EditorState`. `INITIAL_STATE` gets a
documented placeholder `currentPageId: ''`. Change `private readonly store =
createStore<EditorState>(INITIAL_STATE)` to a constructor-assigned
`this.store = createStore<EditorState>({ ...INITIAL_STATE, currentPageId:
opts.pageId })`. `get()` adds `currentPageId: s.currentPageId`. Add
`export interface SetCurrentPage { readonly type: 'SetCurrentPage'; readonly
pageId: string }` to the `Intent` union; `applyOne` `case 'SetCurrentPage':
return { state: { ...state, currentPageId: intent.pageId }, docMutated: false,
stateChanged: true }`.

**Step 1 — RED test.**
- `new Editor({ …, pageId: 'page:p' }).get().currentPageId === 'page:p'` (init).
- After `editor.apply({ type:'SetCurrentPage', pageId:'page:x' })`,
  `editor.get().currentPageId === 'page:x'`, `docMutated` false (no commit — assert
  via a `doc.subscribe` spy count unchanged or the doc unchanged), a subscriber
  DID fire (view change).
- A `SetCurrentPage` in an `applyAll` batch pushes NO undo entry
  (`editor.canUndo() === false` after only view intents).

Run the editor apply-path test file; confirm RED is "currentPageId undefined" /
"SetCurrentPage unhandled" (switch falls through), not a type import error.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| `currentPageId` never initialized (stays `''`) | init assertion |
| `SetCurrentPage` writes the doc / pushes undo | `docMutated`/`canUndo` assertions |
| `SetCurrentPage` doesn't notify subscribers | subscriber-fired assertion |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts`, `bun run typecheck` (the `Intent` union
change may trip exhaustiveness — fix any switch), commit
(`feat(canvas-editor): currentPageId editor state + SetCurrentPage intent`).

---

## Task E3 — page mutation intents + InverseOp growth (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/intents.ts` (`CreatePage`/`DeletePage`/
  `RenamePage`/`ReorderPage` + doc comments; add to the union)
- Modify: `canvas-editor/src/editor.ts` (`InverseOp` gains `putPage`/
  `deletePage`; `replay()` handles both; four `applyOne` cases). Import `Page`
  from `@ensembleworks/canvas-model`.
- Test: `canvas-editor/src/editor.test.ts` (or a new `page-intents.test.ts`)

Implement exactly per D-3. Reuse `collectSubtreeParentFirst` /
`orderParentBeforeChild` for DeletePage's cascade + undo. `CanvasDoc` already
exposes `putPage`/`deletePage`/`listPages`.

**Step 1 — RED test** (real in-memory `LoroCanvasDoc`). Seed a doc with pages
`page:p` (with content: a frame + child + a loose note on it) and `page:q`
(empty). Cases:
- **CreatePage:** apply `CreatePage({id:'page:r', name:'R', index:'a5'})` →
  `doc.listPages()` includes `page:r`; `undo()` removes it; `redo()` restores it.
- **DeletePage cascade:** apply `DeletePage('page:p')` → `page:p` gone from
  `listPages()`, AND every shape on `page:p` (the frame, its child, the note) is
  gone from `listShapes()`; `page:q`'s shapes (none) untouched. `undo()` restores
  `page:p` AND every deleted shape with its ORIGINAL parentId (assert the child
  is physically back under the frame, not detached to root — the
  parent-before-child ordering teeth); `redo()` re-deletes both.
- **DeletePage last-page refusal:** with only ONE page, `DeletePage` is a total
  no-op (page + shapes untouched, `canUndo()` unchanged).
- **RenamePage:** name changes; `index` and any passthrough field survive the
  `{...page}` spread; undo restores the old name.
- **ReorderPage:** index changes; no-op when the new index equals the current
  (no undo entry); undo restores the old index.
- **Unknown id:** each of DeletePage/RenamePage/ReorderPage on an absent id is a
  silent no-op, no throw.

Run the file; confirm RED is the behavior assertion (intent unhandled / shapes
survive a page delete / undo detaches the child), not an import error.

**Mutant table (RUN each — this is the highest-mutant-risk task):**
| Wrong impl | Killed by |
|---|---|
| DeletePage removes only the page record (no shape cascade) | cascade case: shapes survive |
| DeletePage undo restores shapes child-BEFORE-parent | undo case: child detached to root, not under the frame |
| DeletePage undo omits `putPage` | undo case: shapes rehome onto a missing page / repair strands them |
| DeletePage doesn't refuse the last page | last-page case leaves zero pages |
| CreatePage has no inverse | undo leaves the page |
| RenamePage full-overwrites (drops `index`) | rename case: index vanishes |
| ReorderPage emits an undo entry on a no-op | no-op case: spurious undo step |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts`, `bun run typecheck`, commit
(`feat(canvas-editor): CreatePage/DeletePage/RenamePage/ReorderPage intents`).

---

## Task E2 — tools parent onto the current page (canvas-editor/src/tools — GATED)

**Files:**
- Modify: `canvas-editor/src/tools/create.ts`, `arrow.ts`, `line.ts`, `draw.ts`
  (each: delete `const pageId = editor.pageId`; read `editor.get().currentPageId`
  LIVE at the parenting sites — inside the event handlers, exactly where
  `worldOf`/`editor.get().camera` are already read live)
- Test: `canvas-editor/src/tools/create.test.ts` (+ arrow/line/draw analogues)

Each tool currently binds `pageId` ONCE at factory construction. Replace with a
live read so the shape's `parentId` reflects the CURRENT page at creation time.
For `create.ts`, the cleanest is to read `const pageId = editor.get().
currentPageId` at the top of the `pointing`/`dragging` branches that mint a shape
(before `clickShape`/`dragShape`/`topIndex(ctx, pageId)`), rather than the
factory-scope const. Do the equivalent in arrow/line/draw.

**ux-contract:** GATED (`tools/`). Run with `UX_CONTRACT_PR_BODY='ux-contract:
none — tools parent new shapes onto the current page; visible effect governed by
browser contract Z1 (see plan)'` until H1/Z1 land.

**Step 1 — RED test.** In `create.test.ts`: construct the tool with
`pageId:'page:p'`, apply `SetCurrentPage('page:q')`, then run a create gesture;
assert the created shape's `parentId === 'page:q'`. RED: the tool captured
`editor.pageId` at construction, so `parentId` is still `'page:p'`. Add the same
for arrow/line/draw. **Confirm RED is the `parentId` assertion, not a load
error.** Verify a drag-create threads the current page consistently across
pointermoves (the re-emitted shape keeps `parentId === 'page:q'`).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Still reads `editor.pageId` (factory const) | shape lands on `page:p` after switch |
| Reads current page but at factory scope (once) | a switch mid-session doesn't take effect |
| topIndex scans the wrong page's siblings | index not top-of-stack on the new page |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts`, `bun run typecheck`, commit
(`feat(canvas-editor): create tools parent onto the current page`).

---

## Task E2b — clipboard paste/duplicate target the current page (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/clipboard-intents.ts` (`:78` max-sibling scan
  page, `:114` duplicate clone parent, `:136` paste clone parent → all
  `editor.get().currentPageId`)
- Test: `canvas-editor/src/clipboard-intents.test.ts`

`reindexRootsToTop`'s max-sibling scan and the two `cloneWithNewIds` parent
arguments read `editor.pageId`; change to `editor.get().currentPageId` so a paste
or duplicate lands on the page the user is looking at (and its top-of-stack index
is computed against THAT page's siblings). NOT gated (`clipboard-intents.ts` is
outside `tools/`).

**Step 1 — RED test.** With a doc holding shapes on `page:p` and `page:q`, a
selection on `page:p`, and `currentPageId` switched to `page:q`, assert
`duplicateSelectionIntents(editor)` emits `CreateShape`s whose root `parentId ===
'page:q'` (RED: current code clones onto `editor.pageId` = `page:p`). Same for
`pasteIntents`.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Clones onto `editor.pageId` | duplicated root lands on `page:p` after switch |
| max-sibling scan uses `editor.pageId` | paste-on-top index computed vs the wrong page |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun
canvas-editor/src/boundary.test.ts`, `bun run typecheck`, commit
(`feat(canvas-editor): paste/duplicate target the current page`).

---

## Task R1 — render filter in `ShapeLayer` + `EmbedLayer` (canvas-react — GATED)

**Files:**
- Modify: `canvas-react/src/ShapeLayer.tsx` (filter the culled set by
  `pageIdOf(snapshot, shape) === currentPageId` before `orderForPaint`; read
  `currentPageId` from the `useEditorState` value it already computes; import
  `pageIdOf` from `@ensembleworks/canvas-model`)
- Modify: `canvas-react/src/embed/EmbedLayer.tsx` (add the same page predicate to
  its `isEmbedKind` + `worldBounds`-intersect filter; it already calls
  `useEditorState`)
- Test: `canvas-react/src/shape-layer.test.ts` (+ an embed-layer page-filter test
  if one exists; otherwise extend shape-layer)

`ShapeLayer` already binds `const editorState = useEditorState(toolContext.
editor)`; use `editorState.currentPageId`. Filter:
`.filter(s => pageIdOf(snapshot, s) === editorState.currentPageId)` on the
`Shape[]` fed to `orderForPaint`. Update the PAINT ORDER / module comment to note
the page filter composes with cull + z-order (verify-before-asserting).

**ux-contract:** GATED. Run with `UX_CONTRACT_PR_BODY='ux-contract: none —
renderer paints only the current page; governing browser contract Z1 lands with
this sub-cycle (see plan)'` until H1/Z1 are in the tree.

**Step 1 — RED test.** Seed a snapshot with two overlapping root shapes on
DIFFERENT pages (`shape:onP` parent `page:p`, `shape:onQ` parent `page:q`), an
editor whose `currentPageId === 'page:p'`, render `ShapeLayer`, and assert the
emitted DOM `data-shape-id` set is `['shape:onP']` ONLY (`shape:onQ` absent).
Add a **migration-safety case:** a single-page room (`shape:a`, `shape:b`, a
frame + child all on `page:p`, `currentPageId === 'page:p'`) renders ALL of
them (the filter hides NOTHING). **Confirm RED is the presence/absence
assertion, not an `pageIdOf` import error** (fake-RED trap).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| No filter (paints all pages) | `shape:onQ` still in the DOM |
| Filters by `shape.parentId === currentPageId` (direct parent only, not ancestor) | a nested child on the current page vanishes (single-page case's frame child) |
| Inverts the predicate (paints OTHER pages) | `shape:onP` absent, `shape:onQ` present |
| Reads a stale/missing currentPageId | single-page case hides everything |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-react): paint only the current page`).

---

## Task U1 — `PageSwitcher` UI + mount + wiring (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/PageSwitcher.tsx`
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (render `<PageSwitcher …/>` in
  the top chrome; image drop `:1116` / paste `:1165` →
  `editor.get().currentPageId`; add the undo-clamp — D-6 — in
  `handleGlobalShortcut`'s undo/redo branches)
- Create: `client/src/canvas-v2/page-switcher-dom.ts` (pure helpers:
  `newPageIntents(editor)`, `deletePageIntents(editor, id)`,
  `movePageIntents(editor, id, dir)`, `clampCurrentPageIntents(editor)` — the
  intent-building logic, DOM-free and unit-testable, mirroring `reorder-dom.ts`/
  `clipboard-dom.ts`)
- Test: `client/src/canvas-v2/page-switcher-dom.test.ts` (pure logic),
  `client/src/canvas-v2/PageSwitcher.test.ts` (component render/click via the
  house happy-dom rig, mirroring `StylePanel.test.ts`)

Build the tab bar per D-6. Keep the intent MATH in `page-switcher-dom.ts` (pure,
reads `editor` for pages/current/indices, returns `Intent[]`); the component is a
thin renderer that calls `editor.applyAll(helper(...))`. `newPageIntents` mints
`id`/`name`/`index` (index via `generateKeyBetween(maxIndex ?? null, null)` from
`@ensembleworks/canvas-model`) and returns `[CreatePage, SetCurrentPage]`.
`deletePageIntents` refuses the only page, computes the adjacent page from
`orderedPages`, returns `[DeletePage, …(deletingCurrent ? [SetCurrentPage] :
[])]`. `movePageIntents` returns `[ReorderPage]` with a `generateKeyBetween`
index between neighbors. `clampCurrentPageIntents` returns
`[SetCurrentPage(canonicalPageId(pages))]` when `currentPageId` names no live
page, else `[]`.

In `handleGlobalShortcut`, after `editor.undo()`/`redo()` (both branches) and the
existing `pruneDanglingSelectionIntents` call, add:
`const clamp = clampCurrentPageIntents(editor); if (clamp.length) editor.applyAll(
clamp)`.

**ux-contract:** GATED. Run with `UX_CONTRACT_PR_BODY='ux-contract: none — page
switcher UI; governing contract Z1 lands with this sub-cycle (see plan)'` until
Z1 is in the tree.

**Step 1 — RED tests.**
- `page-switcher-dom.test.ts`: `newPageIntents` yields a `CreatePage` (new id,
  index sorting after the max existing) + a `SetCurrentPage` to that id;
  `deletePageIntents` on the only page → `[]`; on a non-current page →
  `[DeletePage]` only; on the CURRENT page → `[DeletePage, SetCurrentPage(adj)]`;
  `movePageIntents(id,'left'|'right')` yields a `ReorderPage` whose index moves
  the page one slot in `orderedPages`; `clampCurrentPageIntents` returns a
  `SetCurrentPage` iff `currentPageId` is dangling. RED = helpers absent.
- `PageSwitcher.test.ts`: render with a 2-page snapshot, click a page tab →
  asserts `editor.applyAll` called with `SetCurrentPage(thatId)`; click "+ new
  page" → `CreatePage`+`SetCurrentPage`. RED = component/handlers absent.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| new-page index ignores existing max | new page sorts below / ties existing |
| delete doesn't refuse the only page | only-page case emits a DeletePage |
| delete-current omits the SetCurrentPage | current-page delete strands currentPageId |
| clamp fires when currentPageId is valid | spurious SetCurrentPage on a normal undo |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): page switcher UI wired to the page intents`).

---

## Task H1 — `pageCount()` Obs (both adapters, real)

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `pageCount(): number` to
  `Obs` with a both-levels doc comment, next to `shapeCount`)
- Modify: `e2e/lib/contracts.ts` (`ActorSample` + `sampleActor` + `pageObs`:
  sample `window.__ew.doc.listPages().length`)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (`makeObs`:
  `pageCount() { return editor.doc.listPages().length }` — REAL, no throw-stub;
  it is a doc read like `shapeCount`)

**Step 1 — RED:** a temporary `level:'browser'` micro-contract asserting
`obs.pageCount() === 1` for a fresh scene → RED (`pageCount is not a function`).
Implement in both adapters, GREEN, remove the scaffold. Commit
(`test(contracts): pageCount Obs (both adapters, doc read)`).

---

## Task Z1 — browser contract `switching-page-changes-rendered-shapes`

**Files:** create
`interaction-contracts/src/contracts/switching-page-changes-rendered-shapes.ts`;
register in `interaction-contracts/src/index.ts` (append to `CONTRACTS`).

`level:'browser'`, `when:'at-end'`, `tool:'select'`. Seed TWO non-overlapping
geo shapes on the default page (`page:p`): `shape:a`, `shape:b`. Gesture:
1. Click the "+ new page" switcher control via an `'element'` anchor
   (`selector: '[data-canvas-v2-new-page]'`, a `down` then `up`) — creates a new
   page AND switches to it (empty).
2. Click the `page:p` tab back via `'element'`
   (`selector: '[data-canvas-v2-page="page:p"]'`, `down`/`up`).

`check(obs)`: capture is at-end after BOTH clicks — so the FINAL state is "back
on page:p" and `obs.paintOrder()` must again list both `shape:a`/`shape:b`
(length 2, both present). AND assert `obs.pageCount() === 2` (the new page was
created). Give a clear failure message including the observed order/count.

**RED (Obligation 2/4):** with R1's render filter reverted (renderer paints all
pages), the intermediate "empty new page" never actually hides the shapes AND —
more to the point for a stable RED — revert R1 and instead assert the
INTERMEDIATE state via a `when:'every-event'` variant OR (simpler, chosen here)
keep `at-end` and reason about the filter directly: the crisp, stable RED for the
FILTER is a SEPARATE assertion path — **seed the two shapes, create+switch to the
empty page, and assert `paintOrder().length === 0` at that point.** To make this
a clean at-end contract, DROP step 2 (the switch-back) and assert
`paintOrder().length === 0 && pageCount() === 2` at end (current page = the new
empty page → filter hides both seeded shapes). RED with R1 reverted: the filter
is absent → both shapes still painted → `paintOrder().length === 2 ≠ 0` — a
clean COUNT assertion failure, never a Playwright locator error (the "+ new page"
control is always present once U1 lands). Reviewer reverts R1's filter, observes
the same RED, restores.

> **Final contract shape (chosen):** seed `shape:a`+`shape:b` on `page:p`;
> gesture = click `[data-canvas-v2-new-page]` (create+switch to empty page);
> `check`: `pageCount() === 2` AND `paintOrder().length === 0`. This proves
> create + switch + FILTER in one at-end assertion. The switch-back round-trip is
> NOT needed for teeth (the empty-page filter is the load-bearing observation)
> and keeps the gesture minimal. RED is reached by reverting R1's filter (the
> gated visible behavior this contract governs).

Run: `cd e2e && bunx playwright test --project=e2e -g
switching-page-changes-rendered-shapes`. Commit
(`test(contracts): switching pages paints only the current page`).

---

## PR body — required content

The sub-cycle is interaction-bearing (`canvas-editor/src/tools/`,
`canvas-react/src/`, `client/src/canvas-v2/`). Z1 adds a real contract, so the
honest form is a **contract reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `switching-page-changes-rendered-shapes`
   (interaction-contracts/src/contracts/switching-page-changes-rendered-shapes.ts)
   + new both-levels `Obs.pageCount` (e2e/lib/contracts.ts real; canvas-editor/
   src/contracts/fsm-runner.ts real — a doc read, not a throw-stub). Reuses the
   existing browser-only `Obs.paintOrder`.
   RED (verbatim, R1 render filter reverted): <paste>  GREEN (after R1): <paste>
   Reviewer reproduced red→green by reverting R1's page filter.

The gated tasks that ride this accounting (no separate contract each):
- E2 (canvas-editor tools parent onto the current page) — proven end-to-end by
  Z1; unit-pinned by create/arrow/line/draw.test.ts.
- R1 (canvas-react ShapeLayer/EmbedLayer page filter) — the contract's subject;
  unit-pinned by shape-layer.test.ts.
- U1 (client PageSwitcher wiring) — the switcher the contract drives.

Deferred (JC#2, owner-flagged): presence-by-page (per-peer cursor page-scoping)
— needs a canvas-sync Presence field; out of this sub-cycle.
```

If tasks land across multiple PRs, any PR shipping a gated task **ahead** of Z1
carries `ux-contract: none — multi-page wiring; governing contract Z1 lands with
this sub-cycle (see plan)`.

---

## FULL E2E SIGN-OFF — MANDATORY, NOT NEGOTIABLE

**The sub-cycle sign-off MUST run the FULL e2e suite**, not a grep-filtered
subset:

```
cd /home/stag/src/projects/ensembleworks/e2e
UX_CONTRACT_PR_BODY='ux-contract: none — multi-page sign-off' \
  bunx playwright test --project=e2e > /tmp/e2e-pages.log 2>&1
echo $?        # <- read this BARE line; zsh has no PIPESTATUS, $?-through-tail is WRONG
```

**Why this is load-bearing HERE specifically:** the z-order sub-cycle's filtered
sign-off MISSED a StylePanel regression that broke multi-client drag/edit/delete
(`canvas-v2.spec.ts` 132/220/308). **This cycle's render-filter change (R1) is
EXACTLY the class of change that can break the multi-client render-CONVERGENCE
e2e tests** — those tests assert two clients render the same shapes, and a page
filter that reads a per-peer `currentPageId` is precisely where "peer A sees
shapes, peer B doesn't" divergence could hide. If any multi-client render/
convergence spec regresses, it is R1's filter interacting with a peer whose
`currentPageId` differs — investigate BEFORE claiming done. A green FILTERED run
is NOT a sign-off.

Also run, at sign-off: `bun run typecheck` (all workspaces) and the full unit
suite `UX_CONTRACT_PR_BODY='…' bun run test` (read `$?` bare), plus all browser
contracts `cd e2e && bunx playwright test --project=e2e` green.

---

## Risks & unknowns

1. **BIGGEST RISK — the `currentPageId` ripple across every parenting site
   (D-1).** Six tool/clipboard sites plus two client image sites read the FIXED
   `editor.pageId`; every one must become a LIVE `editor.get().currentPageId`
   read, and each tool captured it at FACTORY scope (once), so a naive "read
   currentPageId at factory scope" fix still bakes in the first page. E2/E2b's
   "create/paste AFTER a switch lands on the new page" assertions are the guard —
   they only pass if the read is live PER EVENT. Miss one site and that path
   silently keeps writing to page 1.
2. **The render filter breaking multi-client convergence e2e (R1).** See the
   FULL E2E SIGN-OFF section — this is the second-biggest risk and the reason the
   filtered sign-off is banned. currentPageId is per-peer; the DOC is shared; two
   peers on different pages legitimately render different subsets — but a
   convergence test that assumes both peers render identically could flag it.
   Confirm the convergence specs seed both peers on the SAME (default) page (they
   do today — single-page rooms), so parity holds.
3. **DeletePage's cascade + undo correctness (E3).** `deletePage` does NOT
   cascade shapes, so the intent must; and the undo must restore the page AND
   every shape PARENT-BEFORE-CHILD (or a restored child detaches to root — the
   same split-brain DeleteShapes' cascade-inverse comment already documents).
   Reuse `collectSubtreeParentFirst`/`orderParentBeforeChild` verbatim; the
   "child is back UNDER the frame after undo" assertion is the teeth.
4. **`Intent`/`InverseOp` union growth ripples (E1/E3).** Adding five intents +
   two InverseOps may trip exhaustiveness switches (only `editor.ts`'s `applyOne`
   and `replay()` switch exhaustively today — verified; fsm-runner/replay do not
   switch on `intent.type`). `bun run typecheck` across workspaces is the
   backstop.
5. **Undo strands `currentPageId` after a CreatePage-undo (D-6).** Handled by
   `clampCurrentPageIntents` in the undo/redo branches; if omitted, undoing a new
   page leaves an empty canvas until the user manually switches.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **Confirmed accurate:** `Page` schema is `z.looseObject({ id: pageIdField,
  name })` (`document.ts:20`) — tldraw's `index` rides through untyped;
  `canonicalPageId` = lexicographically smallest page id (`repair.ts:56`);
  `rootShapes` = `parentId.startsWith('page:')` (`document.ts:129-130`);
  `CanvasDoc.putPage`/`deletePage`/`listPages` exist and `deletePage` removes
  ONLY the page record with NO shape cascade (`loro-canvas-doc.ts:465-473`);
  `EditorState` has NO `currentPageId` and the `Intent` union has NO page
  intents (`editor.ts:46-52`, `intents.ts:262-283`); `editor.pageId` is a
  readonly constructor field never reassigned; `create/arrow/line/draw` all bind
  `const pageId = editor.pageId` at factory scope; `ShapeLayer` and `EmbedLayer`
  paint EVERY shape with no page filter; `pageIdOf` exists (`geometry.ts:218`)
  and is exported via `export * from './geometry.js'`; `dumpModel` populates
  `pages` from `listPages()` (`bridge.ts:40`) so the ToolContext snapshot carries
  pages; `orderParentBeforeChild`/`collectSubtreeParentFirst` are in `editor.ts`;
  `generateKeyBetween`/`indexBetween` landed in `fractional-index.ts`;
  `applyAll` is one commit / one undo per call; the browser adapter exposes
  `window.__ew.doc`/`editor`; the `'element'` anchor drives a DOM control via a
  bounding-box click.
- **Correction 1 — the `editor.pageId` consumer list is LARGER than the brief's
  "create/arrow/line/draw."** It ALSO includes `clipboard-intents.ts` (three
  sites: `:78`/`:114`/`:136`) and `CanvasV2App.tsx`'s image drop/paste
  (`:1116`/`:1165`, via `createImageFromBlob(…, editor.pageId)`). All eight are
  in D-1's exhaustive list and covered by E2/E2b/U1. (`replay.ts:283` and
  `editor.ts`'s own field/`EditorOpts` are the legitimate INITIAL-value readers —
  they stay.)
- **Correction 2 — the render filter must cover `EmbedLayer` too, not just
  `ShapeLayer`.** The brief names `ShapeLayer`; `EmbedLayer` is a culling-EXEMPT
  SIBLING that also renders shapes (the embed kinds) and would otherwise paint
  another page's terminals/iframes onto the current screen. R1 filters BOTH.
- **Correction 3 — no new `currentPageId()` Obs is needed; the render-filter
  proof reuses the EXISTING `paintOrder()`.** The ONE new Obs is `pageCount()`
  (both adapters real). `paintOrder().length === 0` on the new empty page is the
  filter's teeth; `pageCount() === 2` proves the create. (The brief floated
  `currentPageId()`/`pageCount()` — only `pageCount` is added.)
- **Correction 4 — page ORDER needs a tie-break because the v2 bootstrap page
  carries NO `index`.** A synced tldraw room's pages DO carry a fractional
  `index` (looseObject passthrough), but `page:p` (crash-writer/bootstrap) does
  not, so `orderedPages` sorts by `(index ?? '', id)` — the missing-index page
  sorts first and created pages append after (D-4). No migration, matching the
  all-`'a1'` z-order corpus posture.
- **No other rot found** in the ground-truth claims.
