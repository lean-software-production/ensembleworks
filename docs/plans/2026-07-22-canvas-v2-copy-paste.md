# Canvas v2 — Copy / Cut / Paste / Duplicate (Sub-cycle 2b) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 users the same clipboard authoring tldraw gives v1 —
**Ctrl/Cmd+C** copy, **Ctrl/Cmd+X** cut, **Ctrl/Cmd+V** paste, **Ctrl/Cmd+D**
duplicate — over the **system clipboard** (paste survives reload, other tabs,
other rooms), with multi-select and frame-subtree fidelity, new ids, and the
pasted/duplicated shapes becoming the selection, in one undo step.

**Architecture:** Paste is treated as an **untrusted write path**. The pure,
clean-room half lives in `canvas-model/src/clipboard.ts` (serialize a
selection's subtree to a versioned JSON envelope; decode + **re-validate every
foreign shape through `validateShape`** dropping anything invalid; clone with
fresh ids, parentId remap, arrow-binding-endpoint remap, positional offset).
`canvas-editor` gains thin intent-emitter helpers
(`duplicateSelectionIntents` / `pasteIntents`) that mint ids from the injected
`editor.random` and emit existing `CreateShape` + a new validated `PutBinding`
+ `SetSelection`, batched into one commit / one undo step — exactly the shape
of the landed `deleteSelectionIntents` path. Only `client/src/canvas-v2/`
touches `navigator.clipboard` and the `KeyboardEvent`s. Three browser-level
interaction contracts pin duplicate, paste, and — the through-line —
**malformed clipboard data is rejected safely**.

**Tech stack:** TypeScript pure-FSM editor, Zod (`validateShape`/`bindingSchema`
in `canvas-model`), React 18 (client), Bun test runner, Playwright (browser
contracts, real clipboard), `@ensembleworks/interaction-contracts`.

**Scope (decided — see Decisions):** copy/cut/paste/duplicate of shapes and
frame-subtrees; arrow bindings **internal to the pasted set are preserved**
(dangling ones dropped); pasted shapes selected. **Out of 2b:** a v2
paste-at-cursor **toggle UI** (2b ships one default placement and a
cursor-aware `pasteIntents` seam for the follow-up — judgment call #1);
z-order-above-source (pasted shapes keep the source `index`, may z-tie —
follow-up); rich cross-app interop (pasting foreign non-EnsembleWorks JSON /
plain text as a note — a no-op in 2b, judgment call #3).

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
  `UX_CONTRACT_PR_BODY='ux-contract: none — copy/paste sub-cycle 2b; see plan'`
  before `bun run test` on any task whose diff touches a **gated path**
  (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`)
  but not the contracts module. Once K1 (which touches
  `interaction-contracts/`) is in the working tree, the gate passes on the diff
  alone.
- `server`'s typecheck is `bunx tsc --noEmit`; if `bunx` is off PATH it exits
  127 and looks like a failure. No `server/` changes here, but the full
  `bun run typecheck` covers all workspaces.
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
   catches it). Every non-trivial task below ships one.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching.

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). The **actual** forbidden patterns
  (verified against the test at plan time): imports of `loro-crdt`, `ws`,
  `@tldraw/`, `react`, `canvas-sync` / `@ensembleworks/canvas-sync`;
  `from '../server'`; and the literals `document.`, `window.`, `Date.now(`,
  `Math.random(`.
  - **`navigator.` is NOT currently forbidden by the scan** — but the *intent*
    holds: `canvas-editor` reads no clock/PRNG/DOM/clipboard directly.
    `navigator.clipboard` lives ONLY in `client/src/canvas-v2/`. Do not put a
    `navigator.` even in a comment inside `canvas-editor` (keeps the intent
    unambiguous; costs nothing).
  - The id-mint **must** use `editor.random`, never `Math.random(` — the scan
    fails the literal, and `Math.random(` in a comment fails it too.
- **`canvas-model` has NO boundary test** (verified — only `canvas-editor`
  scans text). The new `canvas-model/src/clipboard.ts` is still pure by
  construction: no DOM, no clock, no PRNG (the id-mint is *injected* into the
  clone primitive as a `() => string`, never read there).

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught ~15 false factual claims; the
  dominant failure mode is confident *quantitative / locational* claims.
  **Prefer wording that cannot rot** — describe by argument/behavior, not raw
  line numbers or counts.

### Interaction contracts (CLAUDE.md — mandatory)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan that means **D1** (the DOM wiring) is
  gated; the pure model/editor tasks (C1–C3, E1, E2) and the Obs/harness task
  (H1) touch `canvas-editor/src/` *outside* `tools/`, `canvas-model/`,
  `interaction-contracts/`, and `e2e/` — **not** gated. Satisfy the gate for
  the sub-cycle by landing the contracts (K1–K3, which touch
  `interaction-contracts/`).
- **Obligation 3:** the new `shapeCount()` Obs MUST be implemented in BOTH
  adapters — `canvas-editor/src/contracts/fsm-runner.ts` AND
  `e2e/lib/contracts.ts`. It reads doc state at both levels (fsm:
  `editor.doc.listShapes().length`; browser: `window.__ew.doc.listShapes()`),
  so implement it **for real in both — no throw-stub.**
- **Obligations 2 & 4:** each K* contract runs RED against the un-wired
  predecessor and the reviewer independently reproduces red→green (revert, see
  the failure, restore) — never accept the implementer's report of it. The
  exact RED handles are named per task below.
- **Copy/paste/duplicate are keyboard + clipboard driven (not tool FSMs)** —
  like Delete they route through `handleGlobalShortcut`, never a tool's
  `onEvent`. So all three K* contracts are **`level: 'browser'`** (the FSM
  runner drives tool FSMs only and never sees these). This mirrors the styling
  P3/AS4 browser-only precedent exactly.

---

## Decisions (settled — do not re-litigate)

### D-1. Clipboard serialization format
- **Transport: `text/plain` via `navigator.clipboard.writeText`/`readText`.**
  Rationale: `writeText`/`readText` are the broadly-permitted, simplest
  clipboard APIs and Playwright can grant them. Custom MIME types
  (`ClipboardItem` with `web application/...`) have spottier browser support and
  stricter permission/security semantics. The brief explicitly frees us from
  matching tldraw's exact types; robustness wins.
- **Envelope (the bytes):** a JSON object with a recognizable marker key and a
  version:
  ```json
  { "ensembleworks/clipboard": 1, "shapes": [ <full Shape envelopes> ],
    "bindings": [ <Binding objects internal to the selection> ] }
  ```
  The top-level marker key `"ensembleworks/clipboard"` (a value === the format
  version, currently `1`) is how paste tells **our** payload from arbitrary
  foreign clipboard junk. `shapes` are **full shape envelopes verbatim**
  (id/kind/parentId/index/x/y/rotation/isLocked/opacity/meta/props) so paste is
  lossless. `bindings` carries only bindings whose **both** endpoints are within
  the serialized set (see D-4).
- **Decode is a no-op for non-matching input** (missing/wrong marker, wrong
  version, non-JSON, non-object) — pasting foreign data creates nothing and
  never throws. (Pasting foreign plain text as a note is a possible future
  nicety — **out of 2b**, judgment call #3.)

### D-2. Validation / security boundary on paste (THE #1 REQUIREMENT)
Foreign clipboard data is arbitrary and possibly hostile. **Two independent
layers, both must hold:**
1. **Pure layer — `decodeClipboard` (canvas-model, Task C2).** `JSON.parse` in
   try/catch (malformed JSON → `null`, never throws). Marker + version check.
   Then **each** shape in `payload.shapes` is run through
   `validateShape(shape)` (canvas-model/src/shape.ts:237 — takes `unknown`,
   returns `{ok:true,shape}` | `{ok:false,error}`); **only `ok:true` shapes are
   kept**, invalid ones are silently dropped. Each binding is run through
   `bindingSchema.safeParse` and dropped unless it parses AND both endpoints
   resolve to a kept shape (D-4). Cyclic `parentId` among the payload is broken
   in the clone step (C3) by re-rooting a shape whose ancestor chain doesn't
   terminate at a payload root. **Nothing invalid ever leaves this function.**
2. **Doc layer — defense in depth (already landed by step 1 of this branch).**
   Every kept shape is still emitted as `CreateShape` → `editor.applyAll` →
   `applyOne` → `doc.putShape`, which **re-validates via `validateShape` and
   rejects (total no-op, no throw)** anything invalid
   (`canvas-doc/src/loro-canvas-doc.ts` putShape write boundary). A bug in
   layer 1 therefore *still* cannot corrupt the doc. Bindings are emitted via
   the **new `PutBinding` intent (Task E2), which structurally validates with
   `bindingSchema` before `doc.putBinding`** — closing the pre-existing gap
   that raw `doc.putBinding` performs **no** validation (verified:
   `loro-canvas-doc.ts` `putBinding` is a plain `.set()`).

The exhaustive adversarial cases (malformed JSON, non-object, array, wrong
marker/version, shape with junk props, shape missing required fields, cyclic
`parentId`, dangling binding, binding with junk fields) are pinned as **pure
unit tests in C2/C3** (the strongest, most complete coverage), and the
end-to-end guarantee that the wired paste path actually routes through them is
pinned by browser contract **K3**.

### D-3. Id-mint scheme (unique, replay-deterministic, `editor.random`, no `Math.random`)
Paste/duplicate mint **N** ids at once with no pointer event to salt from. The
create tool's `makeId` folds InputEvent `(t,x,y)` + one `random()` draw and has
a documented collision precondition; paste has no event and production tests
inject a **constant** `random` (`FIXED_RANDOM`, verified in
`client/src/canvas-v2/tool-loop.test.ts`), so a `random()`-only scheme would
mint N identical ids and `CreateShape`'s upsert would silently merge them.
**Scheme (Task E1):**
```
mintId(i) = `shape:${base36(floor(editor.random() * 1e9))}-${i}`
```
one `editor.random()` draw **per node**, plus the node's **batch index `i`** as
a hard uniqueness salt. The `-${i}` guarantees N distinct ids **within one
paste even under a constant PRNG**; the per-node random draw separates ids
**across** paste operations and sessions. Cross-session uniqueness under
*colliding entropy* stays UNGUARANTEED — the exact same caveat `create.ts`
documents, deferred to the same real-entropy follow-up (G3). Document this
precondition in the code, do not paper over it.

### D-4. Subtree, parentId & binding remap (Task C3)
- Serialize (C1) collects, for each selected id, that shape **and its full
  subtree** (BFS over `parentId`, cycle-safe — the same walk
  `canvas-model/src/document.ts`'s `descendantsOf` documents). De-dupe when a
  selected parent and a selected child overlap.
- Clone (C3): build an **old→new id map** across every collected shape. For
  each shape: `id` → new id; `parentId` → mapped id **if the parent is in the
  set**, else re-rooted to the paste target parent (the page) — this is what
  makes a "root of the pasted subtree" and also **breaks cycles** (a shape
  whose parent chain never reaches a payload root is re-rooted). Positional
  **offset (D-5) applies only to re-rooted (root) shapes**; children keep their
  local x/y and ride the parent.
- Bindings: rewrite `fromId`/`toId` through the map; **keep a binding only if
  BOTH endpoints are in the map** (a binding pointing outside the pasted set is
  **dropped** — the safe handling the security requirement demands for dangling
  bindings). Binding `id` is freshly minted too (via the injected mint).

### D-5. Positioning
- **Duplicate (Ctrl+D):** fixed diagonal nudge of **`+DUP_OFFSET` = 20 world
  units** on x and y (our choice, matching tldraw's small diagonal duplicate
  offset feel). No clipboard involved.
- **Paste (Ctrl+V):** 2b default = **same fixed `+DUP_OFFSET` from the source
  position** (deterministic, pointer-independent, trivially testable).
  `pasteIntents` takes an **optional `at?: {x,y}`** so cursor-centered paste
  (paste-at-cursor mode) is a thin follow-up that centers the pasted bounds on
  the pointer — the seam exists now, the toggle UI does not (judgment call #1).

### D-6. Intents — pure helpers over existing intents (+ one new binding intent)
No `PasteShapes`/`DuplicateShapes` mega-intent. Instead, **pure emitter helpers
in `canvas-editor`** that produce a batch of **existing** intents, exactly like
the landed `deleteSelectionIntents`:
- `duplicateSelectionIntents(editor): Intent[]` and
  `pasteIntents(editor, text, opts?): Intent[]` each emit
  `CreateShape` × N (validated at `putShape`) + `PutBinding` × M (new, Task E2,
  validated by `bindingSchema`) + one `SetSelection(newRootIds)`.
- `editor.applyAll(batch)` rolls the whole batch into **one `doc.commit()` /
  one undo entry** (verified: `applyAll` is one commit per call). Reuses the
  create/apply path wholesale — no new apply machinery except the small
  `PutBinding` case.
- **Selection after paste/duplicate = the new ROOT ids** (shapes re-rooted to
  the page), matching tldraw selecting the pasted top-level shapes.

### D-7. Cut & copy ordering
- **Copy:** serialize selection → `encodeClipboard` → `navigator.clipboard.writeText`.
- **Cut:** `writeText` **first**, then on success apply `deleteSelectionIntents`
  (never delete before the clipboard write resolves — a failed write must not
  lose shapes).

### Judgment calls surfaced to the owner
1. **Paste-at-cursor toggle (recommend: defer the UI to a follow-up).** v1 has
   `TogglePasteAtCursorItem` in `client/src/chrome/MainMenu.tsx`; v2 has no menu
   to host it. 2b ships **offset paste** as the single default and leaves a
   cursor-aware `pasteIntents(at?)` seam. Full parity (the toggle + a v2 menu
   item + cursor-centered placement) is a small, clean follow-up. **Ship 2b
   without the toggle?** (recommend yes.)
2. **Arrow-binding preservation (recommend: keep it, as planned).** Preserving
   bindings internal to the pasted set needs the new validated `PutBinding`
   intent (E2), which also *hardens* the un-validated `doc.putBinding`. It adds
   ~1 task. The alternative — drop all bindings on paste — is simpler but loses
   fidelity for pasted bound arrows. **Keep binding preservation in 2b?**
   (recommend yes; the security win on `putBinding` is worth it regardless.)
3. **Foreign (non-EnsembleWorks) clipboard content is a no-op in 2b.** Pasting
   plain text as a note, or importing another app's shape JSON, is out of
   scope. **OK to no-op foreign content?** (recommend yes.)

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| C1 | `serializeSelection` (subtree collect + envelope) | canvas-model (no) | — | helper absent / subtree/bindings not collected |
| C2 | `encodeClipboard` + `decodeClipboard` (**security gate**) | canvas-model (no) | C1 | hostile payload survives decode (junk shape kept) |
| C3 | `cloneWithNewIds` (id/parent/binding remap + offset + cycle-break) | canvas-model (no) | C1 | parentId/binding endpoints not remapped; ids collide |
| E2 | `PutBinding` intent + `applyOne` case (bindingSchema-validated) | canvas-editor/src (no) | — | `PutBinding` unhandled in switch; junk binding reaches doc |
| E1 | `duplicateSelectionIntents` + `pasteIntents` (mint via `editor.random`) | canvas-editor/src (no) | C1,C2,C3,E2 | helpers absent; N ids collide under constant PRNG |
| D1 | DOM wiring: Ctrl+C/X/V/D in `handleGlobalShortcut` + `navigator.clipboard` | client/canvas-v2 (**YES**) | E1 | key combos do nothing / no clipboard I/O |
| H1 | `shapeCount()` Obs (**both adapters**) + `clipboard?` browser-only Contract field + Playwright clipboard permission | interaction-contracts + e2e + canvas-editor/contracts (satisfies gate) | — | Obs/field absent |
| K1 | browser contract `duplicate-reids-and-offsets` | interaction-contracts + e2e (**YES**/satisfies gate) | D1,H1 | Ctrl+D creates no distinct second shape |
| K2 | browser contract `paste-places-and-selects` | interaction-contracts + e2e (**YES**/satisfies gate) | D1,H1 | Ctrl+C/V creates no new selected shapes |
| K3 | browser contract `malformed-clipboard-rejected` (**the through-line**) | interaction-contracts + e2e (**YES**/satisfies gate) | D1,H1 | hostile clipboard payload creates junk shapes / corrupts doc |

Land **H1 before K1** so the Obs and clipboard permission exist when the first
contract runs. C1–C3, E1, E2 are pure and un-gated (run the suite with the
`UX_CONTRACT_PR_BODY` opt-out until K1 lands). D1 is the only pre-contract gated
task.

---

## Task C1 — `serializeSelection` (canvas-model, pure)

**Files:**
- Create: `canvas-model/src/clipboard.ts`
- Test: `canvas-model/src/clipboard.test.ts`
- Modify: `canvas-model/src/index.ts` (export the new surface)

`serializeSelection(shapes: readonly Shape[], bindings: readonly Binding[],
selectedIds: readonly string[]): ClipboardPayload` — build a
`Map<parentId, Shape[]>` from `shapes`, BFS each selected id's subtree
(cycle-safe via a `seen` set — mirror `descendantsOf`), union + de-dupe the
collected shapes, then keep every binding whose `fromId` AND `toId` are both in
the collected id set. Return
`{ 'ensembleworks/clipboard': 1, shapes: collected, bindings: kept }`.

**Step 1 — RED test.** Seed a frame with two child notes + an arrow bound
between the two children + an unrelated outside note with an arrow binding to a
collected child (dangling-out). `serializeSelection(all, allBindings,
[frameId])` must return: all three frame-subtree shapes, the internal
child↔child binding, and **NOT** the outside note nor the dangling-out binding.
Run `~/.bun/bin/bun canvas-model/src/clipboard.test.ts`; expect
`serializeSelection is not a function` **only after** the export line exists —
if you see that before writing any impl, add the stub export first so the RED
is your *assertion*, not a load error.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Collects only selected ids, not descendants | frame's child notes missing from `shapes` |
| Includes bindings with any endpoint outside the set | dangling-out binding wrongly present |
| No de-dupe when parent+child both selected | duplicate shape entries when selecting frame+child |
| Omits the marker/version key | `payload['ensembleworks/clipboard'] !== 1` |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): serialize a selection subtree to a clipboard payload`).

---

## Task C2 — `encodeClipboard` / `decodeClipboard` (canvas-model, the SECURITY gate)

**Files:** `canvas-model/src/clipboard.ts`, `canvas-model/src/clipboard.test.ts`.

- `encodeClipboard(payload): string` = `JSON.stringify(payload)`.
- `decodeClipboard(text: string): { shapes: Shape[]; bindings: Binding[] }`
  (always returns arrays; **empty** on any rejection):
  1. `JSON.parse` inside `try/catch` → on throw, return `{shapes:[],bindings:[]}`.
  2. Reject if not a plain object, or
     `parsed['ensembleworks/clipboard'] !== 1` → empty.
  3. For each entry of `parsed.shapes` (guard it is an array): `validateShape`
     → keep `ok:true`, drop the rest.
  4. Build the kept-id set. For each entry of `parsed.bindings`:
     `bindingSchema.safeParse` → keep only if it parses **and** both endpoints
     are in the kept-id set.
  5. Return the kept shapes + bindings.

**Step 1 — RED test (adversarial; this is the through-line, be exhaustive).**
Assert `decodeClipboard` returns empty (never throws) for: `'{ not json'`,
`'null'`, `'[]'`, `'{}'`, wrong marker `{'ensembleworks/clipboard':2,...}`, a
payload whose one shape has a junk `props`/`kind` (dropped, others kept), a
payload with a dangling binding (dropped), a payload with a binding carrying
junk fields (dropped). Assert a **valid** payload round-trips
(`decodeClipboard(encodeClipboard(p))` returns the same shapes/bindings). Run
the file; confirm the RED is the *kept-junk assertion* failing, not a parse
throw escaping the test.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| `JSON.parse` without try/catch | malformed-JSON case throws instead of returning empty |
| Skips per-shape `validateShape` | junk-props shape survives decode |
| Skips marker/version check | `'[]'` / foreign object yields shapes |
| Keeps bindings without endpoint check | dangling binding survives |
| Validates binding but not endpoints | binding to a dropped shape survives |

**Step 2–5:** implement, GREEN, typecheck, commit
(`feat(canvas-model): decode+validate foreign clipboard data, dropping junk`).

---

## Task C3 — `cloneWithNewIds` (canvas-model, pure remap)

**Files:** `canvas-model/src/clipboard.ts`, `canvas-model/src/clipboard.test.ts`.

`cloneWithNewIds(input: { shapes: Shape[]; bindings: Binding[] },
mint: (i: number) => string, rootParentId: string, offset: {x:number;y:number}):
{ shapes: Shape[]; bindings: Binding[]; rootIds: string[] }`:
- Assign a new id to every shape (`mint(i)` in stable order) → `idMap`.
- Fresh id for every binding too.
- Per shape: `id`→new; `parentId`→`idMap.get(parentId)` if present, else
  `rootParentId` (this defines a **root** — collect its new id into `rootIds` —
  and **breaks cycles**: a shape whose parent isn't in the map is re-rooted).
- **Offset applies only to root shapes** (`x+offset.x`, `y+offset.y`); children
  unchanged.
- Bindings: `fromId`/`toId` → `idMap` (both guaranteed present — C1/C2 already
  dropped externally-pointing bindings; assert-and-skip if somehow absent).

**Step 1 — RED test.** Frame + 2 children + internal binding. Clone with a
deterministic `mint = (i) => 'new:'+i`, `rootParentId='page:p'`,
`offset={x:20,y:20}`. Assert: every new id differs from every old id; the two
children's new `parentId` === the frame's new id; the frame's new `parentId` ===
`'page:p'`; frame is the only `rootId`; frame x/y shifted by 20, children x/y
unchanged; the binding's `fromId`/`toId` are the children's **new** ids. Add a
constant-`mint`-collision guard test: `mint` folding a batch index means N nodes
get N distinct ids (the E1 scheme's index salt is what this exercises —
here the test's own `mint` uses `i`, proving the primitive threads the index).

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| parentId not remapped | children point at old frame id |
| Offset applied to children too | child x/y drifted |
| Offset applied to nothing | frame x/y unchanged |
| Binding endpoints not remapped | binding references old ids |
| Re-roots to page but forgets rootIds | `rootIds` empty → paste selects nothing |

**Step 2–5:** implement, GREEN, typecheck, commit
(`feat(canvas-model): clone clipboard shapes with fresh ids + binding remap`).

---

## Task E2 — `PutBinding` intent + `applyOne` case (canvas-editor)

**Files:**
- Modify: `canvas-editor/src/intents.ts` (add `PutBinding` to the union)
- Modify: `canvas-editor/src/editor.ts` (`applyOne` case)
- Test: `canvas-editor/src/editor.test.ts` (or the existing apply-path test file)

Add `export interface PutBinding { readonly type: 'PutBinding'; readonly binding:
Binding }` to the `Intent` union. In `applyOne`, `case 'PutBinding'`:
**`bindingSchema.safeParse(intent.binding)`; on failure return a no-op result
(no undo/redo op)**; on success `this.doc.putBinding(binding)` with the
InverseOp pair (`{op:'putBinding', binding}` — the `putBinding` InverseOp
already exists in editor.ts's `InverseOp` union; verified). This closes the
unvalidated-`doc.putBinding` gap noted in Decisions D-2.

**Step 1 — RED test.** Apply a `PutBinding` with a valid binding → assert
`doc.listBindings()` contains it and one undo reverses it. Apply a `PutBinding`
with a junk binding (`fromId: 42`) → assert `doc.listBindings()` unchanged (no
throw). Run the apply-path test file; confirm RED is "PutBinding unhandled"
(the switch falls through / returns undefined), not a type import error.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| No `PutBinding` case | valid binding never appears in doc |
| Skips `bindingSchema` validation | junk binding reaches `doc.putBinding` |
| Validates but no inverse | undo leaves the binding behind |

**Step 2–5:** implement, GREEN, `bun run typecheck` (the `Intent` union change
ripples — fix any exhaustiveness switch), commit
(`feat(canvas-editor): PutBinding intent, bindingSchema-validated`).

---

## Task E1 — `duplicateSelectionIntents` + `pasteIntents` (canvas-editor)

**Files:**
- Create: `canvas-editor/src/clipboard-intents.ts`
- Test: `canvas-editor/src/clipboard-intents.test.ts`
- Modify: `canvas-editor/src/index.ts` (export both helpers)

Both are pure `(editor, …) => Intent[]`, mirroring `deleteSelectionIntents`.
Shared internals:
- `allShapes = editor.doc.listShapes()`, `allBindings = editor.doc.listBindings()`.
- Mint factory (D-3):
  `const mint = (i) => 'shape:' + Math.floor(editor.random()*1e9).toString(36) + '-' + i`
  (binding ids use a `'binding:'` prefix variant; keep the same index salt).
- Assemble intents from a `{shapes,bindings,rootIds}` clone:
  `[...shapes.map(s=>({type:'CreateShape',shape:s})),
    ...bindings.map(b=>({type:'PutBinding',binding:b})),
    {type:'SetSelection', ids: rootIds}]`.

`duplicateSelectionIntents(editor)`: read `editor.get().selection`; empty →
`[]`. `serializeSelection(allShapes, allBindings, selection)` →
`cloneWithNewIds(payload, mint, editor.pageId, {x:DUP_OFFSET,y:DUP_OFFSET})` →
assemble.

`pasteIntents(editor, text, opts?)`: `decodeClipboard(text)` → empty → `[]`.
`cloneWithNewIds(decoded, mint, editor.pageId, offset)` where `offset` =
`{x:DUP_OFFSET,y:DUP_OFFSET}` by default (D-5; `opts.at` reserved for
cursor-paste, unused in 2b). Assemble.

`export const DUP_OFFSET = 20`.

**Step 1 — RED test** (fake `Editor` with a real in-memory doc + a **constant**
`random` to mirror production tests): seed a frame subtree with an internal
binding; `SetSelection([frameId])`; call `duplicateSelectionIntents`; assert the
returned `CreateShape` ids are **all distinct** (the constant-PRNG killer — the
`-${i}` salt is what makes this pass), the `SetSelection` targets the new root,
a `PutBinding` is present with remapped endpoints, and the new frame is offset
by 20. Then build a payload string via `encodeClipboard(serializeSelection(...))`
and assert `pasteIntents(editor, text)` yields the analogous batch. Also assert
`pasteIntents(editor, 'garbage')` === `[]`. Confirm the RED is your assertion,
not `duplicateSelectionIntents is not a function`.

**Mutant table:**
| Wrong impl | Killed by |
|---|---|
| Mint without index salt | distinct-ids assertion fails under constant `random` |
| `SetSelection(allNewIds)` not roots | selection includes children |
| Forgets to emit `PutBinding` | duplicated arrow unbound |
| Offset 0 / applied wrong | frame position assertion fails |
| `pasteIntents` doesn't guard bad text | `'garbage'` throws instead of `[]` |

**Step 2–5:** implement, GREEN, `~/.bun/bin/bun canvas-editor/src/boundary.test.ts`
(prove clean-room still holds — **no** `Math.random(`/`navigator.` crept in),
`bun run typecheck`, commit
(`feat(canvas-editor): duplicate/paste intent emitters over the clipboard model`).

---

## Task D1 — DOM wiring (client/src/canvas-v2 — GATED)

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`handleGlobalShortcut` +
  imports)
- Possibly: a small `client/src/canvas-v2/clipboard-dom.ts` for the async
  copy/paste helpers (keeps `navigator.clipboard` isolated + unit-mockable)
- Test: `client/src/canvas-v2/tool-loop.test.ts` (or a new
  `clipboard-dom.test.ts`) for the DOM-free decision logic; the end-to-end
  behavior is pinned by K1–K3.

Extend `handleGlobalShortcut` (the existing single policy site both keydown
entry points call — verified) with `(event.ctrlKey || event.metaKey)` branches,
gated on `editingId === null` exactly like Delete/Backspace (so Ctrl+C inside a
text editor does native text copy, never shape copy):
- **`c`** → serialize `editor` selection → `encodeClipboard` →
  `navigator.clipboard.writeText`. Consume.
- **`x`** → `writeText` **then** `editor.applyAll(deleteSelectionIntents(editor))`
  (D-7 ordering). Consume.
- **`v`** → `navigator.clipboard.readText()` →
  `editor.applyAll(pasteIntents(editor, text))`. Consume. (Paste is async;
  keep the async read isolated in the DOM helper; the intent application stays
  synchronous once text is in hand.)
- **`d`** → `editor.applyAll(duplicateSelectionIntents(editor))`. Consume.
- **`preventDefault`** on C/X/V/D so the browser's native clipboard/bookmark
  actions don't also fire (unlike undo, these DO have competing native
  behavior — Ctrl+D bookmarks, Ctrl+V may paste into a focused field).

`import { duplicateSelectionIntents, pasteIntents } from
'@ensembleworks/canvas-editor'` and the copy serializer from
`@ensembleworks/canvas-model`.

**ux-contract:** GATED. Run this task's suite with
`UX_CONTRACT_PR_BODY='ux-contract: none — copy/paste wiring; governing
contracts K1–K3 land next (see plan)'` until K1 is in the tree.

**Step 1 — RED:** a DOM-free unit test on the decision helper (e.g.
`clipboardShortcut(event, editingId)` returning a discriminated
`{action:'copy'|'cut'|'paste'|'duplicate'|null}`) asserting Ctrl+D→duplicate,
Cmd+C→copy, and that `editingId!==null` yields `null`. RED = helper absent.
**Step 2–5:** implement, GREEN, typecheck, commit
(`feat(canvas-v2): wire Ctrl+C/X/V/D to the clipboard intent emitters`).

---

## Task H1 — `shapeCount()` Obs + `clipboard?` field + Playwright clipboard permission

**Files:**
- Modify: `interaction-contracts/src/types.ts` (add `shapeCount(): number` to
  `Obs`; add `clipboard?(rng: Rng): string` to `Contract` — browser-only)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (`shapeCount` →
  `editor.doc.listShapes().length`)
- Modify: `e2e/lib/contracts.ts` (`shapeCount` sampled from
  `window.__ew.doc.listShapes().length`; **before the gesture**, if
  `contract.clipboard` is set, `await page.evaluate((t)=>navigator.clipboard.writeText(t), contract.clipboard(rng))`)
- Modify: `e2e/playwright.config.ts` (grant `['clipboard-read','clipboard-write']`
  permissions on the `e2e` project context) — verify the exact config shape
  against the current file before editing.

`clipboard` is **browser-only by construction**: only `e2e/lib/contracts.ts`
reads it, and the FSM runner never runs `level:'browser'` contracts (verified:
`library.test.ts` filters `c.level === 'fsm'`). So **no throw-stub is needed in
fsm-runner** for `clipboard`. `shapeCount` IS an `Obs` method → implement **for
real in both** adapters (Obligation 3).

**Step 1 — RED:** add a temporary `level:'fsm'` micro-contract asserting
`shapeCount()===N` for a seeded scene; run
`~/.bun/bin/bun canvas-editor/src/contracts/library.test.ts` → RED
(`shapeCount is not a function`). Implement in both adapters, GREEN, then remove
the scaffold. Verify the clipboard permission by a throwaway
`page.evaluate(()=>navigator.clipboard.writeText('x'))` in an e2e sanity run
(no `NotAllowedError`). Commit
(`test(contracts): shapeCount Obs (both adapters) + browser clipboard seeding`).

---

## Task K1 — browser contract `duplicate-reids-and-offsets`

**Files:** create
`interaction-contracts/src/contracts/duplicate-reids-and-offsets.ts`; register
in `interaction-contracts/src/index.ts` (append to `CONTRACTS`).

`level:'browser'`, empty-ish gesture: seed one geo shape offset from origin;
`{kind:'down', at:{ref:'shape', id, dx:0, dy:0}}` + `up` to select it (a click
on the shape selects); then `{kind:'key', key:'d', modifiers:{ctrl:true}}`.
`check`: `obs.shapeCount() === 2` AND `obs.selectedShapeIds()` is exactly one id
that **!==** the seeded id (proves a *distinct, re-id'd* shape, not a re-select).
(Precise +20 offset is covered by C3's pure test; the contract pins the
end-to-end re-id + count + selection.)

**RED (Obligation 2/4):** runs RED before D1 wires Ctrl+D (the key does nothing
→ `shapeCount` stays 1, `selectedShapeIds` stays the seeded id → clean
assertion failure, never a locator error). Reviewer reverts D1's `d` branch,
observes the same RED, restores. Run:
`cd e2e && bunx playwright test --project=e2e -g duplicate-reids-and-offsets`.
Commit (`test(contracts): duplicate re-ids and selects the new shape`).

---

## Task K2 — browser contract `paste-places-and-selects`

**Files:** create
`interaction-contracts/src/contracts/paste-places-and-selects.ts`; register it.

`level:'browser'`. Seed two geo shapes (offset from origin). Gesture: marquee
both (down on empty canvas above-left, move past both, up — copy P3's proven
marquee down-point rationale), `Ctrl+C`, `Ctrl+V`. `check`:
`obs.shapeCount() === 4` (two originals + two pasted) AND `obs.selectedShapeIds()`
has length 2, none of which is a seeded id.

**RED:** before D1 wires copy+paste, both keys are inert → `shapeCount` stays 2
→ assertion failure. Reviewer reverts D1's `c`/`v` branches, restores. Commit
(`test(contracts): paste creates new selected shapes from the clipboard`).

---

## Task K3 — browser contract `malformed-clipboard-rejected` (THE THROUGH-LINE)

**Files:** create
`interaction-contracts/src/contracts/malformed-clipboard-rejected.ts`; register
it.

`level:'browser'`. **`clipboard: () => '<hostile payload>'`** — a string that is
either non-JSON, or a well-formed-envelope payload whose shapes carry junk props
/ a cyclic `parentId` / a dangling binding (use the *envelope* form so it passes
the marker check and forces the per-shape `validateShape` drop to be what
protects the doc — the strongest version of the test). Seed **nothing**.
Gesture: `{kind:'key', key:'v', modifiers:{ctrl:true}}`. `check`:
`obs.shapeCount() === 0` (nothing hostile was created) — and the contract
completing at all (no thrown page error, `shapeCount` still answers) is itself
the "did not crash / did not corrupt" proof.

**RED (Obligation 2/4 — name it precisely):** the genuine RED is reached by
reverting the **per-shape `validateShape` filter in `decodeClipboard` (C2)** so
the hostile envelope's shapes flow through to `CreateShape` — the doc layer
(`putShape`) still rejects the truly-invalid ones, so to see a *clean* RED the
reviewer reverts C2's validation **and** stages one hostile shape that is
`validateShape`-invalid but not `putShape`-rejected-identically… simpler and
sufficient: revert C2's filter and assert the RED via a hostile payload shape
that decode-without-validation would keep and count would rise, OR (preferred,
avoids depending on two layers) point the RED at the **wiring**: land K3 while
D1's paste calls a *stubbed* `decodeClipboard` that skips validation, observe
`shapeCount > 0`, then restore the real `decodeClipboard`. Document whichever
path is used with the **verbatim** RED output. Reviewer independently
reproduces red→green. Run:
`cd e2e && bunx playwright test --project=e2e -g malformed-clipboard-rejected`.
Commit (`test(contracts): malformed clipboard data is rejected, doc unharmed`).

> **Note on layered security & RED reachability:** because BOTH the pure
> (`decodeClipboard`) and doc (`putShape`) layers reject junk, a naive K3 could
> be green from birth (a fake RED). The exhaustive adversarial coverage lives
> in **C2/C3's pure unit tests** (which have a real RED — the un-written
> validator keeps junk). K3's job is the end-to-end wiring proof; reach its RED
> by disabling the pure filter as above, never by asserting against a payload
> both layers happen to pass.

---

## PR body — required content

The sub-cycle is interaction-bearing (`client/src/canvas-v2/`). The PR body MUST
carry the interaction-contract accounting. Because K1–K3 add real contracts, the
honest form is a **contract reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `duplicate-reids-and-offsets`
   (interaction-contracts/src/contracts/duplicate-reids-and-offsets.ts)
   + new `Obs.shapeCount` (BOTH adapters: canvas-editor/src/contracts/
   fsm-runner.ts, e2e/lib/contracts.ts).
   RED (verbatim, Ctrl+D unwired): <paste>   GREEN (after D1): <paste>
   Reviewer reproduced red→green by reverting D1's `d` branch.
2. browser contract `paste-places-and-selects`
   (interaction-contracts/src/contracts/paste-places-and-selects.ts).
   RED (verbatim, Ctrl+C/V unwired): <paste>  GREEN: <paste>
   Reviewer reproduced red→green by reverting D1's `c`/`v` branches.
3. browser contract `malformed-clipboard-rejected`
   (interaction-contracts/src/contracts/malformed-clipboard-rejected.ts)
   + new browser-only `Contract.clipboard` seed field (e2e adapter only).
   RED (verbatim, decode validation disabled): <paste>  GREEN: <paste>
   Reviewer reproduced red→green by reverting decodeClipboard's per-shape
   validateShape filter.
```

If tasks land across multiple PRs, any PR that ships a gated task **ahead** of
K1 carries `ux-contract: none — copy/paste wiring; governing contracts K1–K3
land with this sub-cycle (see plan)`.

---

## Risks & unknowns

1. **BIGGEST RISK — the foreign-data (paste) security path.** A single missed
   validation lets hostile clipboard bytes into the doc. Mitigation is the
   whole architecture: the pure `decodeClipboard`/`cloneWithNewIds` layer
   (exhaustively unit-tested in C2/C3) **plus** the already-landed `putShape`
   write boundary **plus** the new `bindingSchema`-validated `PutBinding` —
   three independent gates, none trusting the clipboard. K3 proves the wiring
   routes through them. Runner-up: the **subtree id-remap + binding-endpoint
   rewrite** (C3) — an off-by-one in the old→new map silently mis-parents
   children or dangles bindings; C3's mutant table targets exactly these.
2. **K3 fake-RED (layered defenses).** Both security layers reject junk, so K3
   can be green-from-birth. Addressed explicitly in K3's RED note: reach the RED
   by disabling the pure filter; keep the exhaustive coverage in C2/C3's pure
   tests where the RED is real.
3. **Id collisions under constant PRNG.** Production/unit tests inject a constant
   `random`; a random-only mint collides across N nodes. The `-${i}` index salt
   (D-3) is the fix; E1's distinct-ids assertion is the guard.
4. **Clipboard in Playwright.** `readText`/`writeText` are permission-gated and
   async. H1 grants `clipboard-read`/`clipboard-write` on the e2e context and
   seeds hostile data via `page.evaluate(navigator.clipboard.writeText)`.
   Verify no `NotAllowedError` before relying on K1–K3.
5. **`Intent` union change ripples (E2).** Adding `PutBinding` may trip
   exhaustiveness switches elsewhere; `bun run typecheck` across workspaces is
   the backstop.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **Confirmed accurate:** no copy/paste/duplicate/clipboard anywhere in
  `canvas-editor`, `client/src/canvas-v2`, `canvas-doc`; `Intent` union has no
  clipboard member (styling added `SetStyle`/`SetNextStyle` — re-read, no
  clipboard entry); `deleteSelectionIntents` lives in
  `client/src/canvas-v2/tool-loop.ts` and is the split-precedent; `descendantsOf`
  is cycle-safe BFS; `create.ts` mints via `makeId` folding event fields + one
  `editor.random()` draw with a documented collision precondition; `applyAll` =
  one commit / one undo per call; `putShape` re-validates via `validateShape`
  and rejects as a total no-op; `validateShape(input: unknown)` returns
  `{ok,shape}|{ok:false,error}`; production wires `cryptoRandom`, contract runner
  injects seeded mulberry32; the `key` GestureOp variant + modifiers are handled
  in **both** adapters.
- **Correction 1 — `deleteSelectionIntents` is in `client/`, not `canvas-editor`.**
  The brief calls it "the DOM-free `deleteSelectionIntents(editor)` in
  `client/src/canvas-v2/tool-loop.ts`" — correct, but note it therefore lives in
  the **client** workspace, not canvas-editor. This plan puts the *new* emitters
  in `canvas-editor` (`clipboard-intents.ts`) so the pure model tasks can unit-
  test them without the client, and re-exports for the client. (Either home is
  clean-room-legal; canvas-editor keeps them closer to their `canvas-model`
  deps.)
- **Correction 2 — `doc.putBinding` performs NO validation.** The brief frames
  the write boundary around `putShape`; verified that `putShape` validates but
  `loro-canvas-doc.ts`'s `putBinding` is a plain `.set()` with no `validateShape`/
  `bindingSchema` gate. This is why Task **E2** introduces a
  `bindingSchema`-validated `PutBinding` intent rather than emitting bindings
  through raw `putBinding` — otherwise paste would have an *unvalidated* write
  path for bindings, defeating the whole point.
- **Correction 3 — there is no generic binding-create intent to reuse.** Bindings
  are created today only inside `StartArrow`/`CompleteArrow` in
  `applyOne`/`editor.ts`; the brief's "paste emits one `CreateShape` per node"
  is right for shapes but silent on bindings — E2 fills that gap.
- **Correction 4 — a `shapeCount()` Obs must be added; the existing Obs set does
  not include it.** The brief suggests reusing `selectedShapeIds`/`shapeStyle`;
  those exist and are reused, but proving "N shapes created" / "0 created after
  hostile paste" needs a total count. `CanvasDoc.listShapes()` exists at both
  levels, so `shapeCount()` is implementable for real in both adapters.
- **No rot found** in the remaining ground-truth claims.
