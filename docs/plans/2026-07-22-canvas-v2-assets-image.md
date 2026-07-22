# Canvas v2 — ASSETS + IMAGE (drop / paste) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give canvas-v2 a first-class **image** shape backed by a separate,
tldraw-parity **asset record** — a new top-level `assets` Loro map (mirroring
`bindings`/`pages`), an `Asset` schema + `AssetId` in canvas-model, `putAsset`/
`getAsset`/`listAssets` on `CanvasDoc`, a validated **`PutAsset`** editor intent,
an `ImageShape` renderer that resolves `assetId → src`, a client upload helper
(PUT `/uploads/:id`), **drop** and **paste-image** DOM handlers that run one
async create flow, and the browser contract that pins drop → an image shape.

**Architecture:** Four clean-room layers plus client wiring. (1) canvas-model
gains an `Asset` schema + `AssetId` branded type + `validateAsset`, and the
image shape's props gain a typed `assetId`. (2) canvas-doc gains a top-level
`assets` Loro map with `putAsset`/`getAsset`/`listAssets` (an exact mirror of
`bindings`/`pages`), and `assets`/`assetById` round-trip through
`CanvasDocument`/`makeDocument`/`dumpModel`/`loadModel`. (3) canvas-editor gains
a `PutAsset` intent — validated in `applyOne` via `assetSchema.safeParse`
exactly like `PutBinding`, batched with `CreateShape` in ONE `applyAll` so the
asset and the image commit atomically. (4) canvas-react gains an `ImageShape`
BODY that reads `snapshot.assetById`, resolves `assetId → asset.props.src`, and
paints `<img>`. (5) The client owns the DOM/async: an upload helper (dimensions
+ PUT `/uploads/:id`), a `createImageFromBlob` flow, an `onDrop`/`onDragOver`
handler, a document-level `paste` handler, and the browser interaction contract.

**Tech stack:** TypeScript pure-model/editor, Zod (`validateShape`/
`validateAsset` in canvas-model), Loro CRDT (canvas-doc), React 18 (client/
canvas-react), Bun test runner, Playwright (browser contract),
`@ensembleworks/interaction-contracts`.

**Scope (decided — see Decisions):** the asset RECORD + `assets` map + round-
trip + validation, the image shape `assetId` prop, the `ImageShape` renderer
(resolves `assetId`, tolerates missing/loading/broken), the upload helper, an
**upload-then-create** flow (the image appears only once the upload resolves —
no loading-placeholder shape this cycle), a **drop** surface and a **paste-image**
surface, and the browser contract. **Out of this cycle (deferred, flagged to
owner):** a file-picker toolbar button; a loading-placeholder shape that
resolves in place (tldraw-style optimistic create); `crop`/`flipX`/`flipY`
editing; asset garbage-collection (an undone image leaves an orphan asset —
tldraw does the same); video/bookmark asset kinds (the schema is permissive
enough that a synced foreign one round-trips, but no tool creates them).

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

These are the exact rules the line and draw sub-cycles
(`docs/plans/2026-07-22-canvas-v2-line.md`, `-draw.md`) were governed by; they
were violated repeatedly earlier on this branch (~15 false factual claims,
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
  Run the suite as its own command, then read `$?` **bare on its own line**
  (zsh has no bash `PIPESTATUS`; `suite | tail` leaves `$?` = tail's status),
  or redirect suite output to a file and check `$?`.
- The **full suite needs the ux-contract presence gate to pass**: export
  `UX_CONTRACT_PR_BODY='ux-contract: none — assets/image sub-cycle; governing
  contract dropping-an-image-creates-an-image-shape lands with this sub-cycle
  (see plan)'` before `bun run test` on any task whose diff touches a **gated
  path** (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/
  canvas-v2/`) but not the contracts module. Once **K** (which touches
  `interaction-contracts/`) is in the working tree, the gate passes on the
  sub-cycle's combined diff. **Note:** this sub-cycle's `PutAsset` intent lives
  in `canvas-editor/src/intents.ts` + `editor.ts` — NOT under `tools/` — so
  **E1 is NOT gated** (see the task table).
- Always `cd /home/stag/src/projects/ensembleworks` explicitly in every command
  block. Agent bash cwd resets between calls.
- `bun run typecheck` catches TS issues the single-file bun runner misses — run
  it after any signature/union change (the `Intent` union, the `Asset` schema,
  the `CanvasDoc` interface, the `GestureOp` union, `CanvasDocument`, the
  `makeDocument` signature ripple across workspaces).
- Browser contract runs: `cd e2e && bunx playwright test --project=e2e -g <name>`.

### FULL E2E SIGN-OFF (bake this in — a filtered sign-off already slipped a bug)
- The sub-cycle sign-off MUST run the **FULL** e2e suite —
  `cd e2e && bunx playwright test --project=e2e` — **not** a `-g`-filtered subset.
  A StylePanel regression slipped a filtered sign-off in step 2 and was only
  caught later. Per-task, filter for speed; for the sub-cycle's final green, run
  the whole e2e project plus the whole `bun run test` suite plus
  `bun run typecheck`. Redirect e2e output to a file and read `$?` on its own
  line.

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
   catches it). **THE RECURRING LESSON, BAKED IN PROMINENTLY: each mutant row
   must genuinely DISCRIMINATE — you must actually RUN the test against that
   wrong impl if you are not certain it fails.** This is the single most
   repeated finding from the draw and line sub-cycles: first-pass mutant tables
   shipped rows that did NOT discriminate. Draw's geometry tasks found **2**
   escaping mutants, its tool task found **4**, its renderer found **1**, line's
   array mutant "died harder than expected" — every one caught ONLY because the
   implementer ran each mutant. Do the same here: every non-trivial task below
   ships a mutant table, and you RUN each row.
4. **If a RED is unreachable, STOP and report.** Do not force redness, do not
   skip to the fix. Every "unreachable RED" during the pilot build-out turned
   out to be a wrong belief worth catching (see the plan docs' dated CHANGE
   NOTEs).

### Clean-room boundary (canvas-model / canvas-doc / canvas-sync / canvas-editor)
- `canvas-editor/src/boundary.test.ts` scans **raw file text** (comments
  included; only `*.test.ts` exempt). Forbidden: imports of `loro-crdt`, `ws`,
  `@tldraw/`, `react`, `canvas-sync`; `from '../server'`; and the literals
  `document.`, `window.`, `navigator.`, `fetch`, `Date.now(`, `Math.random(`.
  The `PutAsset` intent and its `applyOne` case are pure model/editor code — no
  DOM, no clock, no PRNG, no `fetch`. **The upload helper, the create flow, the
  drop/paste DOM handlers, dimension-reading, and `<img>` render live in
  `client`/`canvas-react`, where DOM/`fetch` are allowed.** Do NOT put any
  `fetch`/`navigator`/`document`/`URL.createObjectURL`/`createImageBitmap` in
  canvas-model/canvas-doc/canvas-editor.
- **canvas-model / canvas-doc have NO text-scan boundary test** (only
  canvas-editor scans). Keep them pure by construction anyway: the `Asset`
  schema, `validateAsset`, the `assets` map, and `makeDocument`'s `assetById`
  are pure functions of their inputs — no clock, no PRNG, no I/O.
- `canvas-react` and `client` MAY touch the DOM (the `<img>` renderer, the
  upload helper, the drop/paste handlers).

### Interaction contracts (CLAUDE.md — mandatory; carry into EVERY gated brief)
- The presence gate (`scripts/ux-contract-presence.test.ts`) fires on diffs
  touching `canvas-editor/src/tools/`, `canvas-react/src/`, or
  `client/src/canvas-v2/`. In THIS plan the **gated** tasks are **R1**
  (`canvas-react/src/shapes/ImageShape.tsx`), **U1/C1/W1/W2** (all
  `client/src/canvas-v2/…`). The model/doc/intent tasks (M1, M2, A1, E1) are
  NOT under a gated prefix. Satisfy the gate for the sub-cycle by landing **K**;
  until then, gated tasks carry the `UX_CONTRACT_PR_BODY` opt-out above.
- **The image create path is a DOM drop/paste, NOT a tool FSM.** The FSM runner
  (`canvas-editor/src/contracts/fsm-runner.ts`) only drives `select`/`select+
  transform` tool FSMs and cannot synthesize a file drop, so **K is
  `level: 'browser'`** — it dispatches a real HTML5 drag-drop with a
  `DataTransfer` carrying a fixture `File`, then polls for the image shape.
- **This sub-cycle ADDS interaction-contract surface in three places — carry
  all three into K's brief:**
  1. a new **`GestureOp` kind `dropFile`** (`interaction-contracts/src/types.ts`)
     — the vocabulary is `down/move/up/wheel/key` only, with NO file-drop
     primitive, so the contract cannot be expressed without it;
  2. its handling in the **browser runner** (`e2e/lib/contracts.ts`) — build a
     `File` from the op's data-URL, construct a `DataTransfer`, dispatch
     `dragenter`/`dragover`/`drop` on `[data-canvas-v2-viewport]` at the anchor;
  3. a **throw-stub** in the **FSM runner** (`canvas-editor/src/contracts/
     fsm-runner.ts`) — a file drop is genuinely unavailable at the FSM level
     (no DOM), which is exactly the case CLAUDE.md rule 3 permits a throw-stub
     for. Typecheck will force both runners to handle the new op.
- **New Obs `assetSrc(id)` (DECIDED — include; both adapters).** See D-8. It
  proves the created image's `assetId` resolves to a stored `src`, not merely
  that a shape of kind `image` exists — sharper teeth than `shapeKind` alone.
  Implement it for real in BOTH adapters (`fsm-runner.ts` reads `editor.doc`;
  `e2e/lib/contracts.ts` samples via `window.__ew.doc`). `shapeKind`,
  `shapeCount`, `selectedShapeIds` already exist in both — reuse verbatim.
- **Obligations 2 & 4 (RED, reviewer-verified):** K runs RED against an inert
  predecessor and the reviewer independently reproduces red→green (revert, see
  the failure, restore) — never accept the implementer's report. K's exact RED
  handle is named in its task (revert W1's `onDrop` wiring to a no-op — the
  viewport still renders so the `dropFile` op's anchor still resolves and
  `shapeCount()` stays 0: a clean assertion RED, never a locator error).

### Verify-before-asserting
- Any comment or claim about code elsewhere must be checked against source
  before you write it. This branch caught ~15 false factual claims; the dominant
  failure mode is confident *quantitative/locational* claims. **Prefer wording
  that cannot rot** — describe by argument/behavior, not raw line numbers.

---

## Decisions (settled — do not re-litigate)

### D-1. The `Asset` schema + `AssetId` — Task M1
A separate asset record, tldraw-parity (NOT src-on-shape). `AssetId` is a
branded template-literal id like the existing ones, and the schema mirrors
`bindingSchema`/`pageSchema`'s home in `canvas-model/src/document.ts`.

- **`ids.ts`:** add `export type AssetId = `asset:${string}``, `assetIdField =
  z.templateLiteral(['asset:', z.string()])`, and `isAssetId = (s) =>
  s.startsWith('asset:')` — same shape as `shapeIdField`/`bindingIdField`.
- **`document.ts`:** add, beside `bindingSchema`/`pageSchema`:

```ts
// A canvas asset (tldraw parity: dropped/pasted images live as a SEPARATE
// record referenced by the image shape's assetId, not inline on the shape).
// LOOSE envelope + LOOSE props so a synced/foreign v1 asset (video/bookmark,
// extra props like `fileSize`/`isAnimated`) rides through untouched. `type`
// is a plain string (NOT a closed enum) so a foreign kind is not dropped —
// our own tool only ever writes 'image'. `src` is REQUIRED-when-present a
// string (rejects a non-string src — the one field the renderer resolves),
// OPTIONAL because a bookmark-style asset legitimately carries none.
const assetProps = z.looseObject({
  src: z.string().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
})
export const assetSchema = z.looseObject({
  id: assetIdField,
  type: z.string(),
  props: assetProps,
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type Asset = z.infer<typeof assetSchema>

export type AssetValidation = { ok: true; asset: Asset } | { ok: false; error: string }
export function validateAsset(input: unknown): AssetValidation {
  const res = assetSchema.safeParse(input)
  return res.success ? { ok: true, asset: res.data } : { ok: false, error: res.error.message }
}
```

- **Compile-time drift guard** (same pattern as `_BindingIdMatches`): assert
  `Asset['id']` is mutually assignable to `AssetId`.
- **Permissiveness is the whole point** (analogue of line's keyed-map risk): a
  converted v1 image-asset MUST validate. The `src` string check is the only
  teeth — everything else rides through.

### D-2. The image shape `assetId` prop — Task M2
`image` is `image: box` today (only `w`/`h`; `box` is a `looseObject`, so
`assetId` currently rides through UNTYPED as a passthrough key → `assetId: 123`
wrongly validates). Type it permissively:

```ts
// tldraw's TLImageShape stores `assetId: TLAssetId | null` plus w/h/crop/
// playing/url/flipX/flipY/altText. Type ONLY assetId (nullable+optional so a
// v1 image with an unset asset — assetId:null — and one with no assetId key
// both still validate); crop/flip/etc keep riding through `box`'s looseObject.
image: box.extend({ assetId: z.string().nullable().optional() }),
```

- **`image` is NOT added to `TEXT_CAPABLE_KINDS`** (already excluded — it is a
  structural kind with no text body). No change to that allowlist.
- **Reference by `assetId`, not `src`** (owner decision). The renderer resolves
  `assetId → asset.props.src` via the assets map (D-4/D-6).

### D-3. The `assets` Loro map + doc round-trip — Task A1
Mirror `bindings`/`pages` EXACTLY (a new top-level flat Loro map — assets are
not tree-shaped).

- **`CanvasDoc` interface** (`canvas-doc/src/canvas-doc.ts`): add `putAsset(asset:
  Asset): void` (upsert), `getAsset(id: string): Asset | undefined`,
  `listAssets(): Asset[]`. **No `deleteAsset`** (YAGNI this cycle — orphan
  assets are accepted, D-5 judgment call #3). `putAsset` is a plain upsert with
  **NO doc-boundary validation gate** — exactly like `putBinding`/`putPage`,
  which do not gate either; the validation lives in the `PutAsset` intent (D-4,
  the `PutBinding` precedent). This means **`InvalidWrite.op` and `rejectWrite`
  are NOT touched** (a genuine correction to the brief — see Ground-truth).
- **`LoroCanvasDoc`** (`loro-canvas-doc.ts`): add `private assets(): LoroMap {
  return this.doc.getMap('assets') }` and the three methods, byte-for-byte
  parallel to `putBinding`/`listBindings`/`getShape`:

```ts
putAsset(a: Asset): void { this.assets().set(a.id, a as any) }
getAsset(id: string): Asset | undefined { return (this.assets().get(id) as Asset | undefined) ?? undefined }
listAssets(): Asset[] { const m = this.assets(); return m.keys().map((k) => m.get(k) as Asset).filter(Boolean) }
```

- **`CanvasDocument`** (`document.ts`): add `readonly assets: readonly Asset[]`
  and `readonly assetById: ReadonlyMap<string, Asset>` (mirror `byId`).
- **`makeDocument`**: accept `assets` (DEFAULT `[]` so existing callers —
  `repair.ts`, `applyRepairToModel`, tests — keep compiling without change),
  and build `assetById` the same way `byId` is built (last-writer or
  smallest-`stableStringify` on a dup — dups are not expected for assets, so a
  simple last-wins `Map` is fine; match `byId`'s dedupe rule for consistency).
- **`dumpModel`** (`canvas-doc/src/bridge.ts`): pass `assets: doc.listAssets()`
  into `makeDocument`. **This is the load-bearing wiring**: `toolContext.
  snapshot()` IS `dumpModel(editor.doc)` (verified), so once `dumpModel` carries
  assets, the snapshot handed to every `ShapeBody` carries `assets`/`assetById`
  — that is exactly how the `ImageShape` renderer (D-6) resolves `assetId → src`
  with **no new prop-threading**.
- **`loadModel`** (`bridge.ts`): add `for (const a of model.assets) doc.putAsset(a)`
  after the pages/bindings loops, so a full model round-trips.

### D-4. The `PutAsset` intent (validated, batched, no-undo) — Task E1
Mirror `PutBinding` (owner: "for undo parity, a PutAsset intent is cleaner").

- **`intents.ts`:** `export interface PutAsset { readonly type: 'PutAsset';
  readonly asset: Asset }` and add it to the `Intent` union. Import `Asset` from
  canvas-model.
- **`editor.ts` `applyOne`:** a `PutAsset` case that mirrors `PutBinding`
  EXACTLY — validate via `assetSchema.safeParse(intent.asset)`; on failure a
  TOTAL no-op (`{ state, docMutated: false, stateChanged: false }` — no doc
  write, no undo entry, no throw); on success `this.doc.putAsset(asset)`. **This
  `safeParse` IS the untrusted-data validation gate** (constraint 5) — a
  pasted/dropped/foreign asset that fails the schema never reaches the doc.
- **NO undo/redo ops** (deliberate divergence from `PutBinding`, which carries
  `deleteBinding`/`putBinding` inverses): return `{ …, docMutated: true }` with
  NO `undo`/`redo` arrays. There is no `deleteAsset` to invert with (D-3), and
  an undone image should leave its asset as harmless orphan garbage — **exactly
  tldraw's behavior** (tldraw never GCs assets on undo). Because the create flow
  batches `PutAsset` + `CreateShape` in ONE `applyAll` (D-7), the batch's undo
  entry is formed from `CreateShape`'s own `deleteShape`/`putShape` inverses, so
  undo removes the image and redo restores it; the asset persists across both
  (an idempotent upsert). Verify this in E1's test.
- **Why an intent, not a direct `doc.putAsset`:** batching the asset write and
  the shape create into ONE `applyAll` = ONE `doc.commit()` = ONE sync frame, so
  a peer never sees the image shape arrive before its asset (which would flash an
  unresolved image). Two separate writes would not be atomic.

### D-5. The upload helper + create flow (upload-THEN-create) — Tasks U1, C1
All client DOM/`fetch` — clean-room-exempt.

- **Upload helper** (`client/src/canvas-v2/asset-upload.ts`, U1): port
  `client/src/assetStore.ts`'s PUT verbatim into a v2 helper that ALSO reads
  the blob's natural dimensions:

```ts
// Returns everything the Asset needs. `src` is the same `/uploads/<blobId>`
// convention v1 uses (relative — same-origin; the client Vite proxy already
// routes /uploads → the sync server, verified in client/vite.config). The
// blobId (the /uploads path segment) is a SANITIZED filename, ≤64 chars,
// matching the server's sanitizeAssetId regex — DISTINCT from the Loro
// AssetId (`asset:<...>`, minted in C1).
export async function uploadImage(file: File | Blob): Promise<{ src: string; w: number; h: number; mimeType: string; name: string }>
```

  - Dimensions via `createImageBitmap(blob)` (preferred; `close()` after) or an
    `Image()` + `URL.createObjectURL` fallback — DOM, client-only.
  - PUT: `const res = await fetch(`/uploads/${blobId}`, { method: 'PUT', body:
    file }); if (!res.ok) throw …; return { src: `/uploads/${blobId}`, … }`.
  - `blobId` sanitation copies v1's rule: `` `${randomId}-${name.replace(/[^a-zA-Z0-9_.-]/g,'_')}`.slice(0,64) `` — must pass `^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$` (the server's `sanitizeAssetId`). Use `crypto.getRandomValues` for `randomId` (client edge — real entropy, like `CanvasV2App`'s `randomPeerId`).
- **Create flow** (`client/src/canvas-v2/image-create.ts`, C1):

```ts
// upload-then-create: await the upload, THEN emit ONE atomic batch. No
// loading-placeholder shape this cycle (D — judgment call #1).
export async function createImageFromBlob(
  editor: Editor, blob: File | Blob, worldPoint: { x: number; y: number }, pageId: string,
): Promise<void>
```

  - `const up = await uploadImage(blob)` → build `asset: Asset = { id:
    `asset:${mintId()}`, type: 'image', props: { src: up.src, w: up.w, h: up.h,
    mimeType: up.mimeType, name: up.name }, meta: {} }`.
  - Build the image `Shape`: `id: `shape:${mintId()}``, `kind: 'image'`,
    `parentId: pageId`, `index: topIndex-equivalent` (see below), CENTERED on
    `worldPoint` (`x = worldPoint.x - w/2`, `y = worldPoint.y - h/2` — same
    centering `create.ts`'s `clickShape` uses), `props: { w, h, assetId:
    asset.id }`, envelope defaults (`rotation:0, isLocked:false, opacity:1,
    meta:{}`). Clamp very large images to a sane max (e.g. fit within
    ~`MAX_IMAGE_DIM` while preserving aspect) so a 4000px paste isn't page-sized.
  - z-order `index`: reuse the top-of-stack idea. The client already has
    `editor.doc.listShapes()`; compute the lexical-max sibling index on
    `pageId` and call canvas-model's exported `indexBetween(max, null)` (the
    same helper `create.ts`'s `topIndex` uses) — this is a client helper, so
    importing `indexBetween` from canvas-model is fine.
  - Emit ONE batch: `editor.applyAll([{ type:'PutAsset', asset }, { type:
    'CreateShape', shape }, { type:'SetSelection', ids:[shape.id] }])`.
    Auto-select so K can discover the id via `selectedShapeIds()`.
  - `mintId()`: a small client id factory (`crypto.getRandomValues`), NOT
    canvas-editor's `makeId` (that's module-private to the tools). Distinct
    random draws for the asset id and the shape id.

### D-6. The `ImageShape` renderer — Task R1 (GATED)
A BODY (`canvas-react/src/shapes/ImageShape.tsx`), registered in
`registerCoreShapes.ts` (replacing `image`'s `BoxShape` fallback).

- Reads `props.assetId` (string) and resolves it against **`snapshot.assetById`**
  (available because D-3 wired `assets` through `dumpModel` → `snapshot` — no
  new prop threading; `ShapeBodyProps` already carries `snapshot:
  CanvasDocument`). Reading `snapshot` forfeits content-memo — acceptable for a
  plain `<img>` (it holds no heavy session state).
- `const asset = assetId ? snapshot.assetById.get(assetId) : undefined; const
  src = typeof asset?.props?.src === 'string' ? asset.props.src : undefined`.
- Render `<img src={src} … style={{ width:'100%', height:'100%', objectFit:
  'contain', display:'block' }}>` filling the body wrapper (ShapeBody sizes the
  wrapper to `localBounds`, driven by the image's `props.w/h` — geometry.ts's
  generic branch reads `w/h`; verify a bare image with `w/h` gets exact bounds,
  and a `w/h`-less v1 image falls back to 100×100, a documented loose-bounds gap
  like line/draw). Set `data-shape-body="image"`.
- **Graceful states** (all render `data-shape-body="image"`, never throw):
  - no `assetId` / asset-not-found / no `src` → a placeholder div (e.g. a
    dashed box or a muted background), NO `<img>` — the "asset not yet synced /
    unresolved" case.
  - broken image (`onError`) → optional; MVP may just let the browser's broken-
    image glyph show. Do NOT add error state machinery this cycle unless trivial.
- **XSS note** (constraint 5): a foreign/untrusted `asset.props.src` flows into
  `<img src>`. An `<img src>` does NOT execute script — a `javascript:` URL in
  `img src` is inert in modern browsers, and there is no `srcdoc`/`innerHTML`
  here. So a hostile `src` is a broken image at worst, not a script vector. The
  schema's string-typed `src` (D-1) plus this note is the posture; no
  sanitization beyond "it is a string" is warranted.

### D-7. Drop + paste-image surfaces — Tasks W1, W2 (GATED)
Both run the SAME `createImageFromBlob` flow (D-5); each has its own DOM-free
extract helper (unit-testable) plus its DOM wiring in `CanvasV2App`.

- **Drop** (W1): `onDragOver` (calls `preventDefault` so the browser allows a
  drop) + `onDrop` on the viewport container (`containerRef`, which already
  carries `data-canvas-v2-viewport`). `onDrop`: `preventDefault`; extract image
  `File`s from `e.dataTransfer.files` (a DOM-free `extractImageFiles(files):
  File[]` helper filtering `type.startsWith('image/')`); convert the drop point
  to world — `local = { x: e.clientX - rect.left, y: e.clientY - rect.top }`
  (rect from `containerRef.current.getBoundingClientRect()`), then
  `screenToWorld(editor.get().camera, local)` (import `screenToWorld` from
  canvas-editor — already exported); for each file, `void createImageFromBlob(…,
  world, editor.pageId)`. Multiple files: offset each slightly or stack — MVP may
  drop them all at the same world point (acceptable).
- **Paste-image** (W2): a SEPARATE document-level `paste` listener (mirrors the
  existing document-level keydown fallback effect), NOT an extension of the
  Ctrl+V→`readText` path (which is TEXT-only and stays untouched). On `paste`:
  a DOM-free `extractImageBlobs(clipboardData): Blob[]` helper reads
  `e.clipboardData.items`, keeps `item.kind === 'file' && type.startsWith(
  'image/')`, `getAsFile()`. If any image is found: `preventDefault`, and for
  each, `void createImageFromBlob(…, center, editor.pageId)` where `center` is
  the current viewport center in world space (paste has no pointer position;
  `screenToWorld(camera, { x: size.width/2, y: size.height/2 })`).
  **No double-handling:** copying an IMAGE puts no EW-clipboard text on the
  clipboard, so the Ctrl+V `readText` path's `pasteIntents` returns `[]` (a
  no-op); copying EW SHAPES puts no image on the clipboard, so this listener
  finds no image items and no-ops. The two paths handle disjoint content types —
  document this in W2.

### D-8. The contract + `assetSrc` Obs + `dropFile` gesture — Task K
- **Contract `dropping-an-image-creates-an-image-shape`**, `level:'browser'`,
  `when:'at-end'`, empty scene. Gesture: ONE new `dropFile` op targeting a point
  over empty canvas, carrying a tiny fixture image as a **data-URL** (a 1×1 or
  2×2 PNG data-URL constant in the contract file — no external fixture file, no
  network dependency beyond the real `/uploads` PUT). `check`:
  `selectedShapeIds()` is exactly one id `iid`; `shapeCount() === 1`;
  `shapeKind(iid) === 'image'`; **and `assetSrc(iid)` is a non-empty string**
  starting `/uploads/` (proves the full pipeline: drop → upload → PutAsset →
  CreateShape → `assetId` resolves to a stored src). The `at-end` poll
  (`pollUntilPass`, 10s) absorbs the async upload — the image appears once the
  localhost PUT resolves (ms).
- **New `GestureOp` `dropFile`** (`interaction-contracts/src/types.ts`):
  `{ readonly kind: 'dropFile'; readonly at: Anchor; readonly dataUrl: string;
  readonly mimeType: string; readonly name: string }`.
- **Browser runner** (`e2e/lib/contracts.ts`): a `case 'dropFile'` that, at the
  resolved anchor point over `[data-canvas-v2-viewport]`, builds a `File` from
  `op.dataUrl` and dispatches `dragenter`/`dragover`/`drop` with a
  `DataTransfer` carrying it (the standard `page.evaluate`/`evaluateHandle`
  DataTransfer recipe — this is the one genuinely fiddly bit; see Risks).
- **FSM runner** (`canvas-editor/src/contracts/fsm-runner.ts`): a `case
  'dropFile'` that `throw`s "dropFile is a browser-level op; not available to the
  FSM runner" — genuinely unavailable at the FSM level (CLAUDE.md rule 3's
  throw-stub allowance). No FSM contract ever plays it (K is browser-level), so
  the throw is unreachable in practice; it exists to satisfy the exhaustive
  switch and document the boundary.
- **New Obs `assetSrc(id): string | null`** in BOTH adapters + the `Obs`
  interface (`interaction-contracts/src/types.ts`):
  - `fsm-runner.ts`: implement for real — read the shape's `props.assetId` off
    `editor.doc.getShape(id)`, resolve against `editor.doc.listAssets()`, return
    the asset's `props.src` (or null).
  - `e2e/lib/contracts.ts`: sample via `window.__ew.doc` in the actor sampler
    (same page-evaluate pattern as `sampleShapeKinds`) — read the image's
    `assetId`, resolve against `doc.listAssets()`, return `src`. Add an
    `assetSrcById` field to the sample and `assetSrc: (id) => sample.assetSrcById[id] ?? null`.

### Judgment calls surfaced to the owner
1. **Upload-THEN-create (recommend: accept).** The image shape appears only
   after the upload resolves (a brief delay on a large paste), NOT an optimistic
   loading-placeholder shape that fills in when the upload completes. Simpler,
   atomic (one commit), no placeholder/loading state to sync or reconcile. The
   tldraw-style optimistic create is a documented deferral. **OK to ship
   upload-then-create and defer the placeholder?** (recommend yes.)
2. **`PutAsset` carries NO undo op → an undone image leaves an orphan asset
   (recommend: accept — tldraw parity).** Adding `deleteAsset` + an inverse
   would let undo GC the asset, but tldraw itself never GCs assets on undo
   (orphans accumulate harmlessly), and an orphan asset is invisible (no shape
   references it) and cheap. **OK to leave orphans and skip `deleteAsset` this
   cycle?** (recommend yes.)
3. **The validation "gate" lives in the `PutAsset` INTENT, not the doc boundary
   (recommend: accept — `PutBinding` parity).** `doc.putAsset` is a plain
   `.set()` like `doc.putBinding`/`doc.putPage` (neither gates); `assetSchema.
   safeParse` in `applyOne` is the gate for the client create path (the untrusted
   drop/paste entry point). A remote/imported asset bypasses it (like bindings),
   but a bad asset just fails to resolve (renderer tolerates it) and an `<img
   src>` is not an XSS vector. This keeps `InvalidWrite`/`rejectWrite`
   untouched. **OK to gate at the intent, not the doc boundary?** (recommend
   yes.)
4. **Drop AND paste both ship, but only DROP is the browser contract (recommend:
   accept).** Both surfaces call the same `createImageFromBlob`, so the drop
   contract proves the shared end-to-end flow; the paste-image blob extraction
   gets DOM-free unit coverage (W2) rather than a second (harder-to-synthesize)
   browser paste contract. **OK to prove drop end-to-end and unit-test paste
   extraction?** (recommend yes.)
5. **One new Obs (`assetSrc`) + one new `GestureOp` (`dropFile`) (recommend:
   accept both).** `assetSrc` gives the contract real teeth (resolution, not
   just kind); `dropFile` is unavoidable (no file-drop primitive exists). Both
   touch shared adapters/vocabulary. **OK to add both?** (recommend yes — could
   drop `assetSrc` to `shapeKind`-only teeth if the owner wants zero new Obs,
   but `dropFile` is mandatory regardless.)

---

## Task-order table

| # | Task | Package (gated?) | Depends on | RED handle |
|---|------|------------------|-----------|-----------|
| M1 | `Asset` schema + `AssetId` + `validateAsset` | canvas-model (no) | — | bad-src (non-string) asset wrongly validates; a bad AssetId prefix wrongly validates |
| M2 | image shape `assetId` prop | canvas-model (no) | — | `assetId: 123` wrongly validates; typing it required drops a v1 `assetId:null` image |
| A1 | `assets` Loro map + doc methods + `CanvasDocument`/`makeDocument`/`dumpModel`/`loadModel` round-trip | canvas-doc + canvas-model (no) | M1 | putAsset→dumpModel drops the asset; snapshot has no `assetById` |
| E1 | `PutAsset` intent (validated, batched, no-undo) | canvas-editor (**not** tools/ → no) | M1, A1 | invalid asset written; PutAsset+CreateShape not atomic; undo GCs the asset |
| R1 | `ImageShape` body (resolve `assetId→src`) + registry | canvas-react (**YES**) | M2, A1 | image renders BoxShape fallback, no `<img>`; unresolved asset crashes |
| U1 | `uploadImage` helper (dims + PUT `/uploads/:id`) | client/canvas-v2 (**YES**) | — | no PUT issued / wrong URL / dims not read |
| C1 | `createImageFromBlob` flow (PutAsset+CreateShape+SetSelection) | client/canvas-v2 (**YES**) | E1, U1 | no image shape / no assetId / not one atomic batch / not selected |
| W1 | drop handler (`onDrop`/`onDragOver` + `extractImageFiles`) | client/canvas-v2 (**YES**) | C1 | drop creates no image / wrong world coords |
| W2 | paste-image handler (document `paste` + `extractImageBlobs`) | client/canvas-v2 (**YES**) | C1 | image paste creates no image / steals text paste |
| K | browser contract + `dropFile` op + `assetSrc` Obs (both adapters) | interaction-contracts + e2e (satisfies gate) | R1, W1 | drop wiring inert → no image shape created |

Land **W1 before K** (the drop handler must be wired so K's RED is a clean
assertion failure, not a fake locator error). E1/R1/W1/W2 order: E1 before C1
(C1 emits `PutAsset`); R1 independent of C1 but both need A1. Gated tasks
(R1/U1/C1/W1/W2) run their suites with the `UX_CONTRACT_PR_BODY` opt-out until K
lands.

---

## Task M1 — `Asset` schema + `AssetId` + `validateAsset` (canvas-model, pure)

**Files:**
- Modify: `canvas-model/src/ids.ts` (`AssetId`, `assetIdField`, `isAssetId`)
- Modify: `canvas-model/src/document.ts` (`assetSchema`, `Asset`, `validateAsset`, drift guard)
- Modify: `canvas-model/src/index.ts` (export `Asset`, `assetSchema`, `validateAsset`, `AssetId`, `assetIdField`, `isAssetId`)
- Test: `canvas-model/src/document.test.ts` (or the schema test file — match where `bindingSchema`/`pageSchema` are tested)

**Step 1 — RED test.** Add a **stub export first** (`validateAsset` returning
`{ok:false}`) so the RED is an assertion, not a load error, then:
- `validateAsset({ id:'asset:a', type:'image', props:{ src:'/uploads/x', w:10, h:10 } })` → **`ok:true`** (the permissiveness guard — a real created asset).
- a converted v1 image-asset with extra props (`props:{ src:'…', w,h, mimeType, name, fileSize:123, isAnimated:false }`, `meta:{}`) → **`ok:true`** (loose passthrough guard).
- `validateAsset({ id:'asset:a', type:'image', props:{ src: 123 } })` → **`ok:false`** — **RED** (non-string src).
- `validateAsset({ id:'binding:a', type:'image', props:{} })` → **`ok:false`** — **RED** (bad id prefix).
- `validateAsset({ type:'image', props:{} })` → **`ok:false`** — **RED** (missing id).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| `props: z.any()` / omit `src` typing | non-string-src wrongly `ok:true` |
| `id: z.string()` not `assetIdField` | `binding:`-prefixed id wrongly `ok:true` |
| `src: z.string()` REQUIRED (not optional) | a bookmark-style asset with no src wrongly dropped (add a `props:{}` no-src case → must be `ok:true`) |
| `type: z.enum(['image'])` | a foreign `type:'video'` asset wrongly dropped (add a video-asset case → must be `ok:true`) |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): Asset schema + AssetId + validateAsset (permissive, tldraw-parity)`).

---

## Task M2 — image shape `assetId` prop (canvas-model, pure)

**Files:**
- Modify: `canvas-model/src/shape.ts` (the `image:` entry in `propsByKind`)
- Test: `canvas-model/src/shape.test.ts`

Replace `image: box` with `image: box.extend({ assetId: z.string().nullable().optional() })`.

**Step 1 — RED test:**
- `validateShape(imageWithAsset)` where props `{ w:10, h:10, assetId:'asset:x' }` → **`ok:true`** (guard).
- `validateShape(v1ImageNullAsset)` props `{ w:10, h:10, assetId:null, crop:null, playing:true }` → **`ok:true`** (guard — a real v1 image; kills the "assetId required" mutant).
- `validateShape(imageNoAssetKey)` props `{ w:10, h:10 }` → **`ok:true`** (guard).
- `validateShape(badAssetId)` props `{ assetId: 123 }` → **`ok:false`** — **RED** (today `image: box` rides `assetId` through untyped → wrongly `ok:true`).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Leave `image: box` | `assetId:123` wrongly `ok:true` |
| `assetId: z.string()` (required, non-null) | v1 `assetId:null` and no-key images wrongly dropped |
| `assetId: z.string()` (required, nullable) | no-`assetId`-key image wrongly dropped |

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-model): type the image shape's assetId prop, permissively`).

---

## Task A1 — `assets` map + doc methods + round-trip (canvas-doc + canvas-model)

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (interface: `putAsset`/`getAsset`/`listAssets`)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`assets()` map + the three methods)
- Modify: `canvas-model/src/document.ts` (`CanvasDocument.assets`/`.assetById`; `makeDocument` `assets` param + `assetById` build)
- Modify: `canvas-doc/src/bridge.ts` (`dumpModel` passes `assets`; `loadModel` puts assets)
- Test: `canvas-doc/src/loro-canvas-doc.test.ts` (or the existing doc test file) + `canvas-model/src/document.test.ts` for `makeDocument`

Per D-3. `makeDocument`'s new `assets` param DEFAULTS to `[]` so every existing
caller (`repair.ts`, `applyRepairToModel`, fixtures) compiles unchanged —
verify by `bun run typecheck` after the signature change.

**Step 1 — RED tests:**
- `makeDocument({ pages:[], shapes:[], bindings:[], assets:[a] })` → `.assets`
  contains `a` and `.assetById.get(a.id) === a` — **RED** before the field exists.
- doc round-trip: `doc.putAsset(a); doc.getAsset(a.id)` deep-equals `a`;
  `doc.listAssets()` = `[a]` — **RED** before the methods exist (stub them
  first so the RED is the assertion).
- `dumpModel` round-trip: `doc.putAsset(a); dumpModel(doc).assets` contains `a`
  and `dumpModel(doc).assetById.get(a.id)` = `a` — **RED**: `dumpModel` must
  pass `assets` into `makeDocument` (the load-bearing wiring for the renderer).
- `loadModel` round-trip: `loadModel(doc, makeDocument({…, assets:[a]}))` then
  `dumpModel(doc).assets` = `[a]` — **RED**.
- upsert: `putAsset(a); putAsset({...a, props:{...a.props, src:'/uploads/y'}})`
  → `getAsset(a.id).props.src === '/uploads/y'` (last-writer upsert, like
  `putBinding`).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| `getMap('bindings')` reused for assets | asset written into the bindings map → `listBindings` polluted / `listAssets` empty (assert both) |
| `makeDocument` ignores `assets` | `.assets` empty / `.assetById` empty |
| `dumpModel` omits `assets` | `dumpModel(doc).assets` empty though `listAssets()` has it (THE renderer-blocking mutant) |
| `loadModel` omits the asset loop | round-trip drops assets |
| `assetById` not built | `.assetById.get(id)` undefined though `.assets` has it |

**Step 2–5:** implement, GREEN, `bun run typecheck` (watch the `makeDocument`
ripple across workspaces), commit (`feat(canvas-doc): assets Loro map +
put/get/listAssets + CanvasDocument round-trip`).

---

## Task E1 — `PutAsset` intent (canvas-editor — NOT gated)

**Files:**
- Modify: `canvas-editor/src/intents.ts` (`PutAsset` interface + `Intent` union + `Asset` import)
- Modify: `canvas-editor/src/editor.ts` (`applyOne` `PutAsset` case)
- Test: `canvas-editor/src/editor.test.ts`

Per D-4. Mirror the `PutBinding` case's structure (validate → no-op-on-fail →
`doc.putAsset`) but with NO undo/redo arrays.

**Step 1 — RED tests** (fake/real `CanvasDoc`; stub the intent first so the RED
is the assertion):
- `editor.applyAll([{ type:'PutAsset', asset: validAsset }])` → `editor.doc.
  listAssets()` = `[validAsset]` — **RED** before the case exists.
- invalid asset (`props:{ src: 123 }`) → `applyAll([PutAsset])` writes NOTHING
  (`listAssets()` empty), no throw — **RED** (pins the validation gate).
- **atomic batch:** `applyAll([{PutAsset asset}, {CreateShape image}, {SetSelection [image.id]}])`
  → exactly ONE `doc.commit()` for the batch (assert via a commit-count spy or
  the editor's own single-commit contract), `listAssets()` has the asset AND
  `getShape(image.id)` exists AND the image is selected.
- **undo leaves the asset (orphan):** after the batch, `editor.undo()` →
  `getShape(image.id)` is `undefined` (image removed) but `listAssets()` STILL
  has the asset (no `deleteAsset` inverse — orphan accepted); `editor.redo()` →
  the image is back.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| No `safeParse` gate | invalid asset written |
| `docMutated:false` on a valid PutAsset | batch not committed / undo entry never forms |
| Add a `deleteAsset` undo op | undo test's "asset still present" assertion (also fails to compile — no `deleteAsset` exists) |
| Emit two commits (call `doc.putAsset` outside `applyAll`) | single-commit-count assertion |

**Step 2–5:** implement, GREEN, `bun run typecheck`, run
`canvas-editor/src/boundary.test.ts` (clean-room still holds — no
`fetch`/`document.`), commit (`feat(canvas-editor): PutAsset intent (validated,
batched, no undo op)`).

---

## Task R1 — `ImageShape` body + registry (canvas-react — GATED)

**Files:**
- Create: `canvas-react/src/shapes/ImageShape.tsx`
- Modify: `canvas-react/src/shapes/registerCoreShapes.ts` (import + `registerShape('image', ImageShape)`)
- Test: `canvas-react/src/shapes/image-shape.test.ts`

Per D-6. Resolve `props.assetId` against `snapshot.assetById`; render `<img>`
when a `src` resolves, else a placeholder; `data-shape-body="image"`; never
throw. Use `renderToStaticMarkup` + `createElement` (no JSX) like the other
`*-shape.test.ts` files so the test file stays `.test.ts`. The test builds a
`snapshot` (a `CanvasDocument` via `makeDocument({…, assets:[asset]})`) carrying
the referenced asset.

**Step 1 — RED test:**
- Render an `image` shape (`props:{ w:100, h:80, assetId:'asset:x' }`) with a
  snapshot whose `assetById` has `asset:x → { props:{ src:'/uploads/x' } }`:
  - output has `[data-shape-body="image"]` — **RED** before registration
    (registry falls back to `BoxShape`, whose body is not `image`; assert via
    `lookupShapeComponent('image')` and/or the rendered attribute).
  - an `<img>` with `src="/uploads/x"` is present.
- Render an image whose `assetId` resolves to NOTHING (empty `assetById`): output
  is `[data-shape-body="image"]` with NO `<img>` (the placeholder), no throw.
- Render an image with NO `assetId` key: same graceful placeholder, no throw.

**Mutant table (RUN each — draw/line R1 each found an escaper):**
| Wrong impl | Killed by |
|---|---|
| Forget to register `image` | `[data-shape-body="image"]` absent (BoxShape) |
| Resolve `props.src` directly (ignore the asset record) | `<img src>` absent when src lives on the ASSET, not the shape |
| Crash on unresolved asset (`asset.props.src` on undefined) | empty-`assetById` case renders placeholder, no throw |
| Read `snapshot.byId` instead of `assetById` | asset never found → no `<img>` in the resolvable case |

**ux-contract:** GATED (`canvas-react/src/`). Opt-out (`UX_CONTRACT_PR_BODY`)
until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-react): ImageShape body resolves assetId→src and renders <img>`).

---

## Task U1 — `uploadImage` helper (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/asset-upload.ts`
- Test: `client/src/canvas-v2/asset-upload.test.ts`

Per D-5. `uploadImage(file): Promise<{ src, w, h, mimeType, name }>` — reads
dimensions (DOM) and PUTs the blob to `/uploads/<blobId>`. Isolate `fetch`,
`createImageBitmap`/`Image`, and `URL.createObjectURL` behind this one module so
the create flow (C1) is testable without a real network/DOM. Consider a tiny
injectable seam (a `deps` param defaulting to the real `fetch`/dimension reader)
so the unit test can assert the PUT and dims without a live server.

**Step 1 — RED test** (mock the `fetch`/dimension seam):
- `uploadImage(fakeBlob)` issues `PUT /uploads/<id>` with the blob as body; the
  `<id>` matches `^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$` (the server's
  `sanitizeAssetId`) — **RED** before the module exists (stub first).
- the returned `src` is `/uploads/<that same id>`.
- the returned `w`/`h` are the dimensions the (mocked) reader reported.
- a non-ok PUT response → the promise rejects (not a silent success).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| POST instead of PUT / wrong path | method/URL assertion |
| id not sanitized (spaces/slashes) | regex assertion |
| dims hardcoded / not read | dimensions assertion |
| swallow a non-ok response | reject assertion |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): uploadImage helper — dimensions + PUT /uploads/:id`).

---

## Task C1 — `createImageFromBlob` flow (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/image-create.ts`
- Test: `client/src/canvas-v2/image-create.test.ts`

Per D-5. `createImageFromBlob(editor, blob, worldPoint, pageId)` — awaits
`uploadImage` (inject a mock in the test), builds the `Asset` + image `Shape`,
and emits ONE `applyAll([PutAsset, CreateShape, SetSelection])`. Centered on
`worldPoint`, sized to the uploaded `w`/`h` (clamped to a max). Mint distinct
`asset:`/`shape:` ids via a client `crypto`-seeded factory. z-order via
canvas-model's exported `indexBetween` over the page's current sibling max.

**Step 1 — RED test** (fake `Editor` capturing `applyAll` batches; mock
`uploadImage`):
- after `await createImageFromBlob(editor, blob, {x:100,y:100}, 'page:p')`:
  the doc has exactly ONE `image` shape whose `props.assetId` names an asset in
  `listAssets()` whose `props.src` = the mocked upload src — **RED** before the
  module exists.
- the batch is ONE `applyAll` call containing a `PutAsset` AND a `CreateShape`
  (atomic — assert the captured batch, not two separate calls).
- the image is SELECTED (`SetSelection([image.id])` in the batch).
- the image is CENTERED: `shape.x === 100 - w/2`, `shape.y === 100 - h/2`.
- the asset id and shape id have the right prefixes and differ.

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Emit CreateShape without PutAsset | assetId names a missing asset |
| Two `applyAll` calls (asset then shape) | single-batch assertion (non-atomic) |
| No SetSelection | selected assertion → K would have no id to find |
| Top-left placement (not centered) | centering assertion |
| Same random draw for both ids | distinct-ids assertion |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): createImageFromBlob — upload-then-create atomic batch`).

---

## Task W1 — drop handler (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/image-drop.ts` (DOM-free `extractImageFiles(files): File[]`)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`onDragOver`/`onDrop` on the viewport container)
- Test: `client/src/canvas-v2/image-drop.test.ts`

Per D-7. `extractImageFiles` is pure/DOM-free (unit-tested). The DOM wiring
(`preventDefault`, `getBoundingClientRect`, `screenToWorld`, per-file
`createImageFromBlob`) lives in `CanvasV2App` on `containerRef`.

**Step 1 — RED tests:**
- DOM-free unit: `extractImageFiles([pngFile, txtFile, jpegFile])` → `[pngFile,
  jpegFile]` (filters non-image by `type`) — **RED** before the module exists.
- integration (CanvasV2App.test.ts, if a mount test exists): dispatch a `drop`
  with a `DataTransfer` carrying an image `File` at a viewport point → an
  `image` shape appears at the mapped world point. (If the mount test harness
  can't synthesize a `DataTransfer`, this coverage is K's job — do NOT fake it.)

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| No `type` filter (accepts .txt) | extract returns the non-image |
| `onDragOver` missing `preventDefault` | browser never fires `drop` (caught by K, not unit — note it) |
| Wrong coord math (client vs viewport-local) | integration/K world-point assertion |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): drop an image file onto the canvas creates an image shape`).

---

## Task W2 — paste-image handler (client/canvas-v2 — GATED)

**Files:**
- Create: `client/src/canvas-v2/image-paste.ts` (DOM-free `extractImageBlobs(clipboardData): Blob[]`)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (a document-level `paste` listener effect)
- Test: `client/src/canvas-v2/image-paste.test.ts`

Per D-7. `extractImageBlobs` is pure/DOM-free. The `paste` listener
`preventDefault`s ONLY when an image is found, dropping the image at the viewport
center in world space; text paste stays on the existing Ctrl+V→`readText` path
(disjoint content — document the no-double-handling reasoning).

**Step 1 — RED tests:**
- DOM-free unit: `extractImageBlobs({ items:[imageItem, stringItem] })` →
  `[imageBlob]` (keeps `kind:'file' && type.startsWith('image/')`,
  `getAsFile()`) — **RED** before the module exists.
- a clipboard with only a `string` item → `[]` (no image → the listener must
  NOT `preventDefault` / must not steal the text paste path).

**Mutant table (RUN each):**
| Wrong impl | Killed by |
|---|---|
| Read `items` without the `kind:'file'` guard | a string item wrongly yields a blob |
| `preventDefault` unconditionally | text-only paste's `[]` case still prevents default → steals text paste |

**ux-contract:** GATED. Opt-out until K.

**Step 2–5:** implement, GREEN, `bun run typecheck`, commit
(`feat(canvas-v2): paste an image from the clipboard creates an image shape`).

---

## Task K — browser contract + `dropFile` op + `assetSrc` Obs (satisfies the gate)

**Files:**
- Create: `interaction-contracts/src/contracts/dropping-an-image-creates-an-image-shape.ts`
- Modify: `interaction-contracts/src/index.ts` (import + append to `CONTRACTS`)
- Modify: `interaction-contracts/src/types.ts` (`GestureOp` `dropFile` variant; `Obs.assetSrc`)
- Modify: `e2e/lib/contracts.ts` (browser runner: `case 'dropFile'`; `assetSrc` sample)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (throw-stub `case 'dropFile'`; real `assetSrc`)

Per D-8. Model the contract file on `interaction-contracts/src/contracts/
draw-creates-a-draw-shape.ts` (read it — same structure). Embed a tiny PNG
data-URL constant (a 2×2 image) so there is no external fixture and the only
network is the real `/uploads` PUT (the client Vite proxy already routes
`/uploads` → the sync server — VERIFIED in `client/vite.config`; the e2e server
serves `/uploads` via `createUploadsRouter`, EW_CANVAS_SYNC=1 by default).

```ts
const IMG_DATA_URL = 'data:image/png;base64,<2x2 png>'
gesture: () => [
  { kind: 'dropFile', at: { ref: 'point', x: 520, y: 400 }, dataUrl: IMG_DATA_URL, mimeType: 'image/png', name: 'fixture.png' },
],
check: (obs) => {
  const ids = obs.selectedShapeIds()
  if (ids.length !== 1) return `expected exactly one shape after dropping an image, got ${JSON.stringify(ids)}`
  if (obs.shapeCount() !== 1) return `expected shapeCount 1 after one image, got ${obs.shapeCount()}`
  const kind = obs.shapeKind(ids[0]!)
  if (kind !== 'image') return `expected the created shape to be kind 'image', got ${JSON.stringify(kind)}`
  const src = obs.assetSrc(ids[0]!)
  if (typeof src !== 'string' || !src.startsWith('/uploads/')) return `expected the image's assetId to resolve to an /uploads src, got ${JSON.stringify(src)}`
  return null
},
```

**`dropFile` in the browser runner** (`e2e/lib/contracts.ts`): resolve the
anchor to a viewport point, then dispatch a real HTML5 drag-drop with a
`DataTransfer` carrying a `File` built from `op.dataUrl`. The reliable recipe is
`page.evaluateHandle` to construct the `DataTransfer` + `File` in-page, then
dispatch `dragenter`/`dragover`/`drop` `DragEvent`s on the
`[data-canvas-v2-viewport]` element at the point (Playwright's `mouse` cannot
carry a file payload). See Risks — this is the one genuinely fiddly bit.

**`dropFile` in the FSM runner** (`canvas-editor/src/contracts/fsm-runner.ts`):
`throw new Error('dropFile is browser-level; not available to the FSM runner')`
— genuinely unavailable at the FSM level; no FSM contract plays it.

**`assetSrc` Obs** (both adapters, per D-8): interface method
`assetSrc(id): string | null`; real impl in the FSM runner (read
`editor.doc.getShape(id).props.assetId` → resolve against
`editor.doc.listAssets()` → `props.src`); sampled impl in the browser runner
(add `assetSrcById` to the actor sample via `window.__ew.doc`).

**RED (Obligation 2/4 — name it precisely):** the genuine, clean RED is reached
by **reverting W1's `onDrop` wiring** in `CanvasV2App` to a no-op (drop does
nothing) — the viewport still renders, so the `dropFile` op's `point` anchor
still resolves and the drop dispatch succeeds, but no image is created →
`shapeCount()` stays 0 and `selectedShapeIds()` stays `[]` → a clean ASSERTION
failure ("expected exactly one shape after dropping an image, got []"), never a
locator error. Capture the **verbatim** RED. The reviewer independently reverts
that same `onDrop` wiring, observes the identical RED, and restores. Run:
`cd e2e && bunx playwright test --project=e2e -g dropping-an-image-creates-an-image-shape`.
Commit (`test(contracts): dropping an image creates an image shape (+ dropFile op, assetSrc Obs)`).

> **Why not point the RED at "the viewport is absent"?** That would make the
> anchor/`drop` dispatch throw a locator error — a FAKE (load/locator) RED that
> proves nothing about the assertion. Reaching the RED through a present-but-
> inert drop handler (W1 `onDrop` revert) is the only clean path, exactly the
> draw/line contract's own RED discipline.

---

## PR body — required content

The sub-cycle is interaction-bearing (`canvas-react/src/`, `client/src/
canvas-v2/`). Because K adds a real contract, the honest form is a **contract
reference**, not an opt-out:

```
## Interaction contracts
1. browser contract `dropping-an-image-creates-an-image-shape`
   (interaction-contracts/src/contracts/dropping-an-image-creates-an-image-shape.ts),
   adding GestureOp `dropFile` (both runners: real in e2e/lib/contracts.ts,
   throw-stub in canvas-editor/src/contracts/fsm-runner.ts) and Obs `assetSrc`
   (real in both adapters).
   RED (verbatim, W1 onDrop reverted to a no-op): <paste>
   GREEN (after restore): <paste>
   Reviewer reproduced red→green by reverting the onDrop wiring.
```

If tasks land across multiple PRs, any PR shipping a gated task (R1/U1/C1/W1/W2)
ahead of K carries `ux-contract: none — assets/image sub-cycle; governing
contract dropping-an-image-creates-an-image-shape lands with this sub-cycle (see
plan)`.

---

## Sub-cycle sign-off (all three, no shortcuts)

1. `cd /home/stag/src/projects/ensembleworks && bun run typecheck` → exit 0.
2. `UX_CONTRACT_PR_BODY='<the K contract reference>' bun run test` → exit 0 (read
   the exit code on its own line, not a piped tail — zsh has no `PIPESTATUS`).
3. **FULL** e2e (NOT filtered): `cd e2e && bunx playwright test --project=e2e`;
   redirect to a file and read `$?` on its own line → all green. (A filtered
   sign-off already slipped a regression once.)

---

## Risks & unknowns

1. **BIGGEST RISK — synthesizing a real file DROP in Playwright (`dropFile`).**
   Playwright's `mouse` cannot carry a file payload; the drop must be dispatched
   as `DragEvent`s with an in-page `DataTransfer`/`File` (via
   `evaluateHandle`). This is finicky (event sequence `dragenter`→`dragover`→
   `drop`, the `dataTransfer.files`/`items` shape the handler reads). Mitigation:
   K's `case 'dropFile'` is small and self-contained; if the DataTransfer recipe
   proves unreliable, an acceptable fallback is a document-level `paste`-event
   dispatch instead (same create flow, W2's surface) — but drop is the primary.
   If neither can be made to fire the real handler, STOP and report (do not fake
   the drop via a `window.__ew` debug hook — that would bypass the gated DOM
   handler the contract exists to prove).
2. **Async upload settling in the contract — MITIGATED.** `when:'at-end'`
   contracts `pollUntilPass` for 10s (`AT_END_POLL_TIMEOUT_MS`), and the
   `/uploads` PUT is a localhost round-trip of a 2×2 PNG (ms), so the image
   appears well within the poll window. No mock needed. If the poll ever times
   out, suspect the proxy (risk 3), not the timeout.
3. **`/uploads` reachability from the e2e client — MITIGATED (verified).** The
   client Vite proxy already routes `/uploads` → the sync server (:8788), and
   the e2e server serves `/uploads` via `createUploadsRouter` with
   EW_CANVAS_SYNC=1 by default. No server work, no proxy change. Re-verify the
   proxy line survives before landing K.
4. **`makeDocument` signature ripple.** Adding `assets` to `makeDocument`'s
   input touches every constructor (`repair.ts`, `applyRepairToModel`, fixtures,
   `dumpModel`). Defaulting `assets` to `[]` keeps them compiling; `bun run
   typecheck` across all workspaces is the backstop after A1.
5. **Renderer forfeits content-memo by reading `snapshot`.** `ImageShape` reads
   `snapshot.assetById`, so it re-renders every commit. Acceptable — an `<img>`
   is cheap and holds no session state (unlike the embed shapes). Do NOT try to
   memo it against the whole snapshot (no per-shape comparator can prove the
   assets map irrelevant — see `shapeRegistry.ts`'s MEMO STRATEGY note).
6. **Orphan assets accumulate.** An undone image (and a deleted image) leaves
   its asset in the map forever (no `deleteAsset`, no GC). Owner-accepted
   (tldraw parity, judgment call #2); a GC pass is a documented deferral.

---

## Ground-truth corrections (verified against the tree at plan time, 2026-07-22)

- **CONFIRMED — the assets map mirrors `bindings`/`pages` exactly.**
  `loro-canvas-doc.ts` has `getMap('bindings')`/`getMap('pages')` with
  `putBinding`/`putPage`/`listBindings`/`listPages`; `canvas-doc.ts` declares
  them on the interface; `document.ts` has `bindingSchema`/`pageSchema` +
  `CanvasDocument.bindings`/`.pages`. The `assets` map + `assetSchema` +
  `CanvasDocument.assets`/`.assetById` follow this precedent verbatim.
- **CONFIRMED — `image: box` (only `w`/`h`), and `box` is a `looseObject`**, so
  `assetId` currently rides through UNTYPED (a bad `assetId` wrongly validates
  today). M2's RED is a *positive* one (a bad `assetId` must now be rejected),
  not "a v1 image stopped being dropped."
- **CORRECTION — `putAsset` does NOT need a doc-boundary validation gate.** The
  brief asked "does putAsset need a gate like putShape/putBinding?" —
  `putBinding`/`putPage` do NOT gate at the doc boundary (plain `.set()`);
  only `putShape`/`updateProps` do (via `rejectWrite`/`InvalidWrite`). The
  binding validation lives in the `PutBinding` INTENT (`bindingSchema.safeParse`
  in `editor.ts` `applyOne`). So the asset "gate" is the `PutAsset` intent's
  `assetSchema.safeParse`, and **`InvalidWrite.op`/`rejectWrite` are NOT
  touched**.
- **CONFIRMED — the renderer gets assets for free via the snapshot.**
  `toolContext.snapshot()` IS `dumpModel(editor.doc)` (verified in
  `tool-context.ts`), and `ShapeBodyProps.snapshot` is that `CanvasDocument`.
  Once A1 wires `assets` through `dumpModel`, the `ImageShape` resolves
  `assetId → src` off `snapshot.assetById` with NO new prop threading. The
  brief's "extend if needed" resolves to: extend `dumpModel`/`makeDocument`/
  `CanvasDocument`, and the existing `snapshot` prop carries it.
- **CONFIRMED — the e2e /uploads story needs NO server work and NO mock.** The
  e2e server (`scripts/start-server.ts`) sets `EW_CANVAS_SYNC=1` by default and
  wires `createUploadsRouter` (real PUT/GET `/uploads`); the client Vite proxy
  ALREADY routes `/uploads` → :8788 (`client/vite.config`). The `at-end` poll
  (`pollUntilPass`, 10s) absorbs the async upload.
- **NEW — the gesture vocabulary has no file-drop primitive.** `GestureOp` is
  `down/move/up/wheel/key` only, so K MUST add a `dropFile` op handled in both
  runners (real in the browser runner, throw-stub in the FSM runner). This is the
  real "both adapters" work of the sub-cycle, alongside the new `assetSrc` Obs.
- **CONFIRMED accurate:** `image` is in `SHAPE_KINDS`, structural (excluded from
  `TEXT_CAPABLE_KINDS`), renders via the `BoxShape` fallback today; the upload
  path to port is `client/src/assetStore.ts`'s PUT `/uploads/:id` (v1, TLAssetStore);
  the server blob store (`server/src/features/uploads.ts`) is reusable as-is;
  no v2 asset/upload/drop/paste-image code exists; the v2 clipboard
  (`clipboard-dom.ts`) is TEXT-only (`navigator.clipboard.readText`) and does not
  touch image blobs; `screenToWorld(camera, {x,y}) = { x/z - camera.x, y/z -
  camera.y }` (`input.ts`); the toolbar container carries
  `data-canvas-v2-viewport`; `shapeKind`/`shapeCount`/`selectedShapeIds` exist
  in both contract adapters.
```
