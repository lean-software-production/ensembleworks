# Replacing tldraw with open-source components — feasibility analysis

- **Status:** Investigation (no decision)
- **Date:** 2026-07-02
- **Motivation:** tldraw is not open source. This AGPL-3.0 project wants to
  understand the cost of removing that dependency — either by switching to
  another canvas or by writing a custom implementation of the functionality we
  actually use.
- **Companion docs:**
  - Reference architecture: [`architecture-spec.md`](./architecture-spec.md)
  - Canvas sync plane: [`canvas-on-cloudflare-design.md`](./canvas-on-cloudflare-design.md)

## Context

EnsembleWorks is a multiplayer infinite-canvas team room: tldraw for the canvas,
tmux-backed terminals, LiveKit spatial audio. tldraw is used in both the
`client` and `server` workspaces. The tldraw npm package ships under a
non-open-source licence, which is awkward for an AGPL-3.0 project.

This document (1) maps exactly how deeply the app depends on tldraw, tier by
tier, and (2) surveys AGPL-compatible open-source replacements for the hardest
tier — the multiplayer sync layer — plus a note on `coder/ghostty-web` as it
relates to the most tldraw-entangled shape (the terminal).

The headline: the canvas and shapes are very achievable to replace; the sync
layer is a real project on both client and server; and the part **no
off-the-shelf CRDT hands you** — typed shape schema + validation + migrations +
scoped undo — is the actual wall.

---

## 1. What we depend on

### 1.1 Packages

| Package | Workspace | Role |
|---|---|---|
| `tldraw` | client | Editor, React canvas, `ShapeUtil` framework, UI chrome, reactive store |
| `@tldraw/sync` | client | `useSync` — the multiplayer store hook |
| `@tldraw/sync-core` | server | `TLSocketRoom`, `SQLiteSyncStorage` — authoritative CRDT room + persistence |
| `@tldraw/tlschema` | server | `createTLSchema`, record factories, `createShapeId`, `toRichText` |
| `@tldraw/validate` | server | prop validators (`T`) |
| `@tldraw/utils` | server | fractional-index helpers (`getIndexAbove`, `sortByIndex`) |

**Key point for the licensing goal:** tldraw is *not* confined to client
rendering. The **server is a first-class participant in tldraw's CRDT** — it
mints validated records, mutates the store transactionally, and owns
persistence. Replacing tldraw is a client **and** server undertaking.

### 1.2 The four tiers of coupling

The dependency splits cleanly into four tiers, from load-bearing foundation down
to cosmetic integration.

#### Tier 1 — Foundational: the multiplayer document model (hardest)

This is the spine; everything else sits on it.

- **Client store** — `useSync({ uri, assets, shapeUtils, bindingUtils,
  onCustomMessageReceived })` in `client/src/App.tsx`. This *is* the networking,
  presence, and undo/redo layer — not a component rendered around the app, but
  where the whole document lives.
- **Server room** — `server/src/app.ts` holds `Map<roomId, TLSocketRoom>`, each
  backed by `SQLiteSyncStorage` over Node's `node:sqlite` (one `.sqlite` file
  per room). Persistence is commit-on-every-change and survives restarts.
- **Server authors the document** — REST endpoints (`/api/roadmap`, note-create,
  terminal-status, kick) call `room.updateStore(store => …)`, build records via
  `schema.types.shape.create(...)`, compute fractional indices with
  `getIndexAbove`/`sortByIndex`, and generate rich text with `toRichText`.
  Server-authored shapes flow to clients over the same CRDT.
- **Two parallel schemas kept in lockstep by hand** — `server/src/schema.ts`
  (via `createTLSchema` + `T` validators) mirrors the client `ShapeUtil` prop
  definitions. Comments explicitly say "keep in sync with client." Optional
  props exist specifically to avoid migrations.

**To replace:** a CRDT/OT sync engine, presence, per-room persistence, a shared
schema/validation layer, server-side document authoring, and undo/redo. This is
the bulk of the work and has no shortcuts.

#### Tier 2 — Building blocks: five custom shapes on `BaseBoxShapeUtil`

All five follow one idiom: extend `BaseBoxShapeUtil<T>`, declare `T.*` prop
validators, render into `HTMLContainer`, read edit state via `useEditor()` +
`useValue()`, resize via `resizeBox`, draw a `Path2D` indicator. Ranked by how
far each reaches past "a positioned, resizable HTML box":

| Shape | Coupling | What it needs beyond a box |
|---|---|---|
| **iframe** | Shallow | editing flag + pointer-event gating |
| **screenshare** | Shallow | aspect-locked resize + read/write synced props (`getShape`/`updateShape`) + `data-*` hooks for the AV viewport loop |
| **neko** | Shallow–moderate | aspect-locked resize + custom toolbar-icon/tool registration |
| **roadmap** | Moderate | `canScroll` + **capture-phase** drag/drop handlers to *beat tldraw's* document-level event interception (`useDocumentEvents`) |
| **terminal** | **Deep** | live zoom subscription (`getZoomLevel`), selection (`setSelectedShapes`), editing-focus handoff (`setEditingShape`, `getContainer().focus()`), undo batching (`editor.run(fn, {history:'ignore'})`), direct translate/rename via `updateShape`, `canScroll`, cursor-override workaround, re-implements tldraw's frame-heading DOM |

**Insight:** four of five are *thin* over the box abstraction — their real
complexity (WebRTC audio, xterm.js, LiveKit, HTML5 DnD) is already
tldraw-agnostic and ports unchanged. **Terminal is the one genuinely entangled**
with Editor internals. Notably, roadmap actively *fights* tldraw (capture-phase
DnD to escape document event interception) — a simpler canvas would make it
*easier*.

#### Tier 3 — Editor API surface used directly by features

The concrete `editor.*` surface a replacement's canvas API must cover:

- **Shapes:** `createShape`, `updateShape`, `getShape`, `getCurrentPageShapes`,
  `getShapePageBounds`, `getEditingShapeId`, `setEditingShape`,
  `setSelectedShapes`
- **Camera/viewport:** `getViewportPageBounds`, `getCamera`, `getZoomLevel`,
  `pageToViewport`, `zoomToFit`, `zoomToUser`
- **Pages/presence:** `getPages`, `getCurrentPageId`, `getCollaborators`,
  `getCollaboratorsOnCurrentPage`
- **User/prefs:** `user.getId/getName/getColor/getIsDarkMode/updateUserPreferences`
- **Store/reactivity:** `store.allRecords`, `useValue`,
  `sideEffects.register{Before,After}DeleteHandler` (the before-delete handler
  vetoes terminal deletion)
- **Batching/history:** `editor.run(fn, { history })`
- **External content:** `registerExternalContentHandler`,
  `defaultHandleExternalUrlContent`
- **Helpers/types:** `createShapeId`, `toRichText`, `uniqueId`,
  `stopEventPropagation`, `DefaultColorStyle`, `TLAssetStore`, `TLShapeId`,
  `Editor`

Two facts that reduce the work: a lot of feature code is **deliberately
tldraw-free and pure** (`colors.ts`, `identity.ts`, `terminal/grid.ts`,
`screenshare/{helpers,visibility,store}.ts`) — several files call this out for
node-testability. And `AvOverlay`/spatial audio drive off a **150 ms
`setInterval` polling `getViewportPageBounds`**, not tldraw reactivity — so it
only needs viewport bounds + shape bounds + presence, from any canvas.

#### Tier 4 — Just integrated with (droppable / cosmetic)

- **UI chrome** (`ui.tsx`): additive only — wraps `DefaultToolbar`/
  `DefaultMainMenu`, appends custom tool buttons + a menu group, replaces
  `SharePanel` with `AvOverlay`. Replaceable with our own toolbar.
- **Theme** (`theme.css`): overrides `--tl-color-*` variables and `.tlui-*`
  fonts. Pure cosmetics.
- **Asset store** (`assetStore.ts`): a ~10-line `TLAssetStore` (PUT to
  `/uploads/:id`, resolve `src`). Our own HTTP endpoint — trivially portable.
- **Colour palette** (`colors.ts`): identity colours are the "colourful subset
  of `DefaultColorStyle`" names with hexes copied from tldraw's
  `DefaultColorThemePalette`. We'd own those strings/hexes outright.

### 1.3 Effort shape

**Tier 4 ≈ trivial. Tiers 2–3 ≈ substantial but bounded. Tier 1 ≈ a project in
itself.** The pragmatic sequencing is Tier 1 first (prove a sync + schema engine
with server-authoring), since Tiers 2–3 are just an API contract on top of it.
The sharpest single blocker is the **terminal shape's** deep reliance on editor
camera/selection/editing/history internals — the shape API must expose live
zoom, editing-focus handoff, undo batching, and programmatic move/select, not
just "render a box."

---

## 2. Sync/CRDT engine survey (Tier-1 replacement)

Research date 2026-07-02; licensing/CRDT facts verified against primary sources
(project repos, LICENSE files, official docs) with unanimous adversarial votes.

### 2.1 Licensing — the AGPL question

Every serious candidate is safe to ship inside an AGPL-3.0 project. **MIT and
Apache-2.0 are one-directionally compatible** — they can be bundled *into* an
AGPL work (not vice-versa). Licensing does **not** narrow the field; Tier-1 fit
does.

### 2.2 Candidates

| Engine | Licence | Model | Server authoring | Per-room SQLite persistence | Verdict |
|---|---|---|---|---|---|
| **Yjs (core)** | MIT | CRDT | ✅ headless `Y.Doc` | via adapters | **Foundation** — awareness/presence built in |
| **Hocuspocus** (Yjs backend) | MIT | CRDT | ✅ lifecycle hooks | ✅ `@hocuspocus/extension-sqlite` | **Best direct fit** |
| **y-sweet** (Yjs store) | MIT | CRDT | ✅ `DocumentManager.updateDoc()` | ❌ S3 / local-file only | Strong, but not SQLite |
| **Automerge** (+ `automerge-repo`) | MIT | CRDT | ✅ | pluggable | Viable alt ecosystem |
| **Loro** | MIT | CRDT | ✅ | pluggable | Viable alt (Rust/WASM) |
| **Triplit** | **AGPL-3.0** | CRDT (property-level) | ✅ | its own store | Licence-matched, but **Supabase-acquired 2025** |
| **Liveblocks** | server **AGPL-3.0**, client Apache-2.0 | Storage *or* Yjs | ✅ | its own | **Now self-hostable OSS** (see below) |
| y-leveldb | MIT | persistence adapter | — | LevelDB, not SQLite | **Archived Mar 2026** — avoid |

### 2.3 Two brief assumptions corrected by the evidence

- **Liveblocks is no longer commercial-only.** As of Feb 2026 its sync-engine
  server (`@liveblocks/server`) and CLI are open-sourced under **AGPL-3.0**,
  clients under Apache-2.0, and the server speaks *both* Liveblocks Storage and
  Yjs. A self-hostable OSS tier now exists (comments/notifications/AI and the
  hosted platform remain closed). Very recent — re-verify package boundaries
  before betting on it.
- **y-leveldb** — a natural "just persist Yjs" pick — was **archived read-only
  in Mar 2026**. Dead end.

### 2.4 Recommendation: Yjs + Hocuspocus

Closest structural match to what we run today; near one-to-one mapping:

| Current tldraw mechanism | Yjs + Hocuspocus equivalent |
|---|---|
| `@tldraw/sync` `useSync` | Yjs doc + Hocuspocus/`y-websocket` provider |
| `TLSocketRoom` per room | Hocuspocus document per room |
| `SQLiteSyncStorage`, one `.sqlite`/room | `@hocuspocus/extension-sqlite` (per-doc binary update, keyed by doc name) |
| server `room.updateStore(...)` writing shapes | headless `Y.Doc` mutated in Hocuspocus hooks, or y-sweet `DocumentManager.updateDoc()` |
| presence/cursors/colours | **Yjs awareness protocol** (built in) |

**The catch — the real cost, not the sync engine.** tldraw doesn't just give us
sync. It gives a **typed shape schema with validation + migrations**
(`createTLSchema`, `T.*` validators, optional-prop migration story) and
**scoped/batched undo** (`editor.run(fn, {history})`). **Raw Yjs gives none of
that** — a `Y.Doc` is an untyped shared map. We would rebuild:

- the shape schema + runtime validation (today `server/src/schema.ts` mirroring
  client `ShapeUtil`s),
- a migration strategy for evolving shape props,
- undo/redo scoping (Yjs has `Y.UndoManager`, but the batching the terminal drag
  relies on is ours to re-implement).

This is exactly the Tier-1 work flagged in §1.3. The survey confirms
sync/persistence/presence/server-authoring are all checkable with MIT parts;
**schema + validation + migration + scoped-undo is the part no off-the-shelf
CRDT provides.**

**Server-authoring nuance worth a spike.** y-sweet has the most *ergonomic*
server-write API (`DocumentManager.updateDoc()` — build a `Y.Doc`, mutate,
`encodeStateAsUpdate`, push), but persists to S3/local files, not SQLite.
Hocuspocus has SQLite but server writes go through a headless `Y.Doc` against its
hooks. Since we need *both* SQLite-per-room *and* server-side shape authoring
(our REST endpoints), the open question is whether Hocuspocus's server-write
path is as clean as y-sweet's — worth a prototype before committing.

---

## 3. `coder/ghostty-web` and the terminal shape

Fetched and cross-checked from the repo and deepwiki, 2026-07-02.

**What it is.** A real, **MIT-licensed** npm package (`ghostty-web`), ~2.6k
stars, v0.4.0 (Dec 2025), actively developed, originally built for Coder's "Mux"
agentic-dev tool. It is a **WASM build of Ghostty's VT100 parser (Zig core,
~400 KB WASM)** wrapped in JS, rendering the grid to a **2D HTML Canvas**
(dirty-cell two-pass pipeline — *not* WebGL/WebGPU, despite Ghostty's native GPU
renderer). It requires an **external PTY over WebSocket** exactly like xterm.js,
and its public API is a deliberate **drop-in xterm.js replacement**
(`new Terminal()`, `term.open(el)`, `term.onData()`, `term.write()`).

**Does it reduce tldraw coupling? No — it is orthogonal.**

The terminal shape's coupling to tldraw does **not** live in xterm.js. It lives
in the **`TerminalShapeUtil` wrapper** — the live zoom subscription
(`getZoomLevel` counter-scaling), `setSelectedShapes`, `setEditingShape` /
`getContainer().focus()` handoff, `editor.run(…, {history:'ignore'})` undo
batching, and the title-drag `updateShape` move. Every one of those is about
*the shape hosting a terminal*, not *which library draws the terminal*.
ghostty-web embeds through the identical model (instantiate → `.open(element)` →
wire `.onData`/`.write` to the PTY socket), so swapping xterm→ghostty leaves all
of that coupling exactly where it is.

If anything the specific pain point is unchanged: the zoom counter-scaling hack
exists because xterm renders fixed-size cells and we rescale against tldraw's
camera. ghostty-web also renders fixed-size cells to a canvas — same problem, no
relief.

**Conclusion.** ghostty-web is a legitimate, licence-clean (MIT),
production-trending xterm.js alternative with genuinely better Unicode/grapheme
handling — worth considering **on its own merits** for terminal quality. But it
is **not a lever on tldraw decoupling.** That coupling only dissolves when we
replace the *canvas/shape host*; at that point the terminal library inside is a
free choice.

---

## 4. Bottom line & open items

- **Sync layer:** achievable with **MIT parts (Yjs + Hocuspocus)**, licence-clean
  under AGPL. Sync / presence / persistence / server-authoring all check out. The
  hidden cost is **schema + validation + migration + scoped-undo**, which we
  rebuild — the Tier-1 wall.
- **Liveblocks** is now a real self-hostable AGPL option that could shortcut some
  of that (bundles storage + presence), but it is brand-new-OSS (Feb 2026) —
  validate scope before trusting it.
- **Canvas + shapes:** four of five shapes are thin HTML boxes and port with
  little friction; **terminal** is the deep one and sets the shape-API contract.
- **ghostty-web:** real and good, but **orthogonal** to tldraw coupling.
  Decouple the canvas first; then pick the terminal lib freely.

### Open questions (spike, don't search)

1. Concrete undo/redo scoping per engine — does Yjs `UndoManager` (or
   Automerge/Loro history) give the batched/scoped undo the terminal currently
   gets from `editor.run(…, {history})`?
2. Schema/validation/migration for the leading Yjs options — tldraw enforces a
   typed shape schema with migrations that a raw `Y.Doc` does not.
3. Does Hocuspocus (SQLite + hooks) expose server-side mutation as ergonomically
   as y-sweet's `DocumentManager.updateDoc()`, or must the server run a headless
   `Y.Doc`?

**Suggested next step:** a minimal Yjs + Hocuspocus room that (1) persists
per-room SQLite and (2) has the server author a shape via a headless `Y.Doc`, to
size the schema/undo gap concretely.

---

## Appendix — primary sources

- Yjs — <https://github.com/yjs/yjs> (MIT, CRDT, awareness protocol)
- Hocuspocus — <https://github.com/ueberdosis/hocuspocus>,
  <https://tiptap.dev/docs/hocuspocus/server/extensions/sqlite> (MIT, SQLite
  persistence extension)
- y-sweet — <https://github.com/jamsocket/y-sweet>,
  <https://docs.jamsocket.com/y-sweet/features/storage> (MIT, S3/local storage,
  `DocumentManager` server authoring)
- Automerge — <https://github.com/automerge/automerge> (MIT, JSON-like CRDT)
- Loro — <https://github.com/loro-dev/loro> (MIT, Fugue CRDT)
- Triplit — <https://github.com/aspen-cloud/triplit> (AGPL-3.0; Supabase-acquired
  2025)
- Liveblocks open-sourcing —
  <https://liveblocks.io/blog/open-sourcing-the-liveblocks-sync-engine-and-dev-server>,
  <https://github.com/liveblocks/liveblocks> (server AGPL-3.0, client Apache-2.0)
- y-leveldb — <https://github.com/yjs/y-leveldb> (MIT; archived Mar 2026)
- ghostty-web — <https://github.com/coder/ghostty-web>,
  <https://deepwiki.com/coder/ghostty-web> (MIT, WASM Ghostty parser, 2D canvas,
  xterm.js-compatible API)
