# Canvas Rewrite Phase 1: Model + Doc + Converter + Agent API v2 (read side)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the foundation packages for the agent-first canvas — a pure typed
document model (`canvas-model`), a swappable CRDT wrapper around Loro
(`canvas-doc`), a lossless tldraw↔model converter, and versioned read-only Agent
API v2 endpoints (including spatial-semantics queries) that serve the NEW model
by converting the live tldraw store on demand. **No changes to the live editing
path, no client UI changes.** See `docs/plans/2026-07-10-canvas-rewrite-design.md`
(Phase 1) — do not re-litigate its settled decisions.

**Architecture:** Two new clean-room Bun workspaces beside `contracts`:
`canvas-model` (zero runtime deps but `zod`; schema, invariants, and pure
spatial-semantics query functions — the vocabulary shared by everything
downstream) and `canvas-doc` (depends on `canvas-model` + `loro-crdt`; a
`CanvasDoc` interface with a Loro-backed implementation, kept swappable for Yjs).
The tldraw↔model **converter lives in the `server` workspace** (it is inherently
tldraw-coupled; keeping it out of the `canvas-*` packages preserves the design's
rule that those packages stay clean-room and tldraw-free). Agent API v2 read
endpoints live in `server`, declared as `ToolDef`s in `contracts`; each request
reads the live `TLSocketRoom` snapshot, converts it to a `canvas-model`
`CanvasDocument`, and runs the pure query functions. **Loro is NOT on the Phase 1
hot read path** — `canvas-doc` is built and unit-tested in isolation, ready for
Phase 2 sync/shadow mode.

**Tech Stack:** Bun 1.3.14, Node 22.12.0 (asdf), TypeScript 5.7, `zod` ^4,
`loro-crdt` 1.13.6 (pin exact), the existing `@tldraw/*` 5.1.0 server packages,
Express 5.

---

## Context you need (zero-assumption briefing)

Read this whole section before Task 0. It replaces prior knowledge of the
codebase and of Loro.

### Toolchain & test discipline (learned the hard way — trust these)

- **bun is NOT on PATH in fresh shells.** Every `Bash` invocation must begin with
  `export PATH="$HOME/.bun/bin:$PATH"`. bun is 1.3.14; node is 22.12.0 via asdf
  (`.tool-versions`).
- **Run the full suite with `bun run test`** (the root script → `scripts/run-tests.ts`),
  **never raw `bun test`.** Raw `bun test` discovers only ~2 of ~80 suites because
  this repo's tests are **plain self-executing scripts** (they use
  `node:assert/strict` + a `main()` + `process.exit`, NOT `bun:test`'s
  `describe/it`). The root runner globs `**/src/**/*.test.ts` and runs each with
  `bun <file>`. **Your new tests MUST follow this house style** — running a
  `bun:test` file with `bun <file>` errors with "Cannot use test outside of the
  test runner." (Verified 2026-07-11.)
- **Typecheck:** `bun run typecheck` from the repo root covers every workspace.
- **KNOWN PRE-EXISTING FAILURE — do not fix, do not be blocked by it.**
  `bun run test` fails in `server/src/tools-api.test.ts` with
  `mounted route not declared: GET /api/discord/bindings`. It belongs to
  unrelated Discord work (`contracts/src/tools/index.ts` exports `discord.ts` but
  omits `discordTools` from `allTools`, so the Discord routes are mounted yet
  undeclared). **Treat this one failure as the accepted baseline.** Every other
  suite must pass. Task E1/E5 below deliberately keeps the manifest count
  assertion consistent so that this stays the *only* failure.

### The worktree

All work happens in
`/home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1` on branch
`canvas-phase1`. Use absolute paths in every command. The plan file itself is
already committed here.

### How the server exposes the canvas today (v1, the thing we convert FROM)

- **Rooms:** `server/src/kernel/rooms.ts` — `createRoomHost(dir)` returns
  `{ rooms, getOrCreateRoom(roomId) }`. Each room is a `TLSocketRoom` (from
  `@tldraw/sync-core`) backed by per-room SQLite (`<dir>/<roomId>.sqlite` via
  `SQLiteSyncStorage` + `NodeSqliteWrapper`), using the schema in
  `server/src/schema.ts`.
- **Reading a room without a browser:** `room.getCurrentSnapshot().documents` is
  an array of `{ state }`; `.map(d => d.state)` yields flat **tldraw records**.
  Every read endpoint uses exactly this (see `server/src/features/frames.ts`).
- **A tldraw record** has: `typeName` (`'shape' | 'binding' | 'page' | 'asset' |
  'document'`), `id` (`'shape:...'`, `'binding:...'`, `'page:...'`), and for
  shapes: `type` (`'note' | 'text' | 'geo' | 'arrow' | 'frame' | 'line' | 'draw'
  | 'highlight' | 'image'` + the 6 custom types below), `parentId` (a `page:` id
  or a parent `shape:` id — the tree edge), `index` (a fractional-index string
  giving z-order among siblings), `x`, `y` (parent-relative top-left),
  `rotation`, `isLocked`, `opacity`, `meta`, `props` (per-type). A **binding**
  record has `type: 'arrow'`, `fromId` (the arrow shape), `toId` (the bound
  shape), and `props` (`terminal`, `normalizedAnchor`, …).
- **The 6 custom shapes** (all `BaseBoxShapeUtil` HTML boxes; props defined ONCE
  in `contracts/src/shapes.ts`, assembled into the schema in
  `server/src/schema.ts`): `terminal`, `iframe`, `neko`, `roadmap`,
  `screenshare`, `file-viewer`.
- **Rich text:** `note`/`text`/`geo`/`arrow` labels store `props.richText` — a
  ProseMirror-JSON doc (`{ type:'doc', content:[{type:'paragraph', content:[{type:'text', text:'…'}]}] }`).
  `server/src/canvas/geometry.ts` has `richTextToPlainText(rich)` (the read-side
  inverse of tldraw's `toRichText`). Reuse it; do not reinvent it.
- **Parent-relative coordinates:** a child's page-space top-left is the sum of its
  own `x/y` plus every ancestor shape's `x/y` (rotation ignored — an accepted
  limitation, "unrotated parents only"). `server/src/canvas/geometry.ts` has
  `pagePoint(shape, byId)` and `pageIdOf(shape, byId)`. Reuse them in the
  converter.
- **Write path (v1, UNCHANGED by this phase):** `POST /api/canvas/shape` etc. go
  through `room.updateStore(store => …)` in `server/src/features/shape.ts` /
  `sticky.ts`. Phase 1 does not touch these — but the e2e task seeds rooms
  through them.

### The tools manifest & the completeness test (important for API v2)

- `contracts/src/tools/*.ts` each export `ToolDef`s; `contracts/src/tools/index.ts`
  aggregates them into `allTools`. `GET /api/tools` (server
  `features/tools.ts`) serves a JSON-Schema manifest built from `allTools`.
- `server/src/tools-api.test.ts` asserts bidirectional completeness: (A) every
  declared tool verb is reachable (not 404), (B) every mounted non-exempt `/api`
  route is declared in `allTools`, and up top `manifest.tools.length === 17`.
  **Because you add new v2 endpoints, you must (a) declare them as `ToolDef`s in
  `allTools` so direction B still holds for them, and (b) bump that `=== 17`
  assertion to the new count.** After your change the *only* remaining failure in
  that file must be the pre-existing `GET /api/discord/bindings` one.

### Loro 1.13.6 API (verified by running it — do not guess from memory)

Install pins `loro-crdt@1.13.6`. Types live at
`node_modules/loro-crdt/nodejs/loro_wasm.d.ts` — **open it when in doubt.** The
primitives this phase uses, confirmed working:

```ts
import { LoroDoc, LoroTree, LoroMap, LoroText, EphemeralStore } from 'loro-crdt'

const doc = new LoroDoc()
doc.setPeerId(1n)                       // bigint; deterministic peer id for tests
const tree = doc.getTree('shapes')      // LoroTree — the movable tree (root container)
const node = tree.createNode()          // LoroTreeNode; node.id is a TreeID ("counter@peer")
node.data.set('type', 'note')           // node.data is a LoroMap of the node's props
const child = tree.createNode()
tree.move(child.id, node.id)            // reparent child under node; THROWS on a cycle
tree.move(child.id, node.id, 0)         // 3rd arg = sibling index (z-order)
node.parent()                           // LoroTreeNode | undefined
node.children()                         // LoroTreeNode[] in sibling order
node.index()                            // number | undefined (position among siblings)
node.isDeleted()                        // boolean
tree.roots()                            // top-level nodes
tree.nodes()                            // ALL nodes incl. deleted
tree.getNodeByID(id)                    // LoroTreeNode | undefined
tree.delete(node.id)                    // remove subtree
doc.getText('key')                      // LoroText; .insert(pos,str) .delete(pos,len) .toString()
doc.getMap('key')                       // LoroMap; .set/.get/.delete/.keys
doc.commit()                            // flush pending ops (call before export/read-after-write)
const snap = doc.export({ mode: 'snapshot' })   // Uint8Array — full state
const upd  = doc.export({ mode: 'update' })     // Uint8Array — ops delta
doc2.import(snap)                        // apply bytes from a peer/snapshot
doc.subscribe(listener)                  // () => Subscription; fires on commit/import
```

Notes that bite: `setPeerId` takes a **bigint**. `tree.move(a, b)` **throws** if
`b` is a descendant of `a` (Loro enforces no-cycles natively — lean on it).
`node.data` is a live `LoroMap`; setting a key is an op (commit to persist).
`EphemeralStore` is Loro's presence/awareness primitive (Phase 2 uses it; Phase 1
does not — do not build presence here).

### Package-boundary decisions locked for this phase (do not deviate)

1. `canvas-model` imports **nothing** but `zod`. No Loro, no tldraw, no DOM, no
   `Date.now`/`Math.random`/I/O (the design's determinism rule — every function
   is pure; ids/timestamps are inputs).
2. `canvas-doc` imports `canvas-model` + `loro-crdt` only. Never imports from
   `server`.
3. The **converter lives in `server`** (`server/src/canvas-v2/`), the one place
   tldraw records and `canvas-model` meet. It converts to/from the **pure
   `CanvasDocument`** (not into Loro). Round-trip fidelity is tested on the pure
   model.
4. API v2 read path: live snapshot → `convert` → `CanvasDocument` → pure
   `canvas-model` query fns → JSON. Loro is not invoked.
5. Model shape ids are the **verbatim tldraw ids** (`shape:…`) so round-trip is
   lossless and v2 responses reference the same ids agents already use.
6. Rich text: the model keeps the exact `props.richText` JSON in a passthrough
   props bag (lossless round-trip) **and** exposes a derived plain-`text` string
   for semantics. `canvas-doc`'s `LoroText` is exercised separately; the Phase 1
   converter does not translate richText into `LoroText`.

---

## Task 0: Preflight (no commit)

**Step 1: Verify toolchain and worktree**

```bash
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
export PATH="$HOME/.bun/bin:$PATH"
git branch --show-current   # expect: canvas-phase1
bun --version               # expect 1.3.14
node --version              # expect v22.12.0
```

**Step 2: Confirm the accepted baseline**

```bash
bun run typecheck   # expect: all workspaces pass (exit 0)
bun run test 2>&1 | tail -20
```
Expected: every suite passes **except** `server/src/tools-api.test.ts`, which
fails on `mounted route not declared: GET /api/discord/bindings`. That single
failure is the accepted baseline. If anything *else* fails, stop and report — the
worktree is not clean.

No commit.

---

# Seam A — Workspace scaffolding

## Task A1: Scaffold the `canvas-model` package

**Files:**
- Create: `canvas-model/package.json`
- Create: `canvas-model/tsconfig.json`
- Create: `canvas-model/test.ts` (package-local test runner, house-style)
- Create: `canvas-model/src/index.ts`
- Create: `canvas-model/src/version.test.ts` (a trivial smoke test to prove the rig)
- Modify: `package.json` (root — `workspaces` + `typecheck`)

**Step 1: Create `canvas-model/package.json`**

```json
{
  "name": "@ensembleworks/canvas-model",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test.ts"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "bun-types": "1.3.14",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create `canvas-model/tsconfig.json`** (mirrors `contracts/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node", "bun-types"]
  },
  "include": ["src", "test.ts"]
}
```

**Step 3: Create `canvas-model/test.ts`** — the package-local runner. It mirrors
the root `scripts/run-tests.ts` but scoped to this package, so
`bun run test` here runs exactly this package's house-style suites.

```ts
// Run: bun test.ts  (or: bun run test)
// Discovers this package's src/**/*.test.ts and runs each as a plain script
// under `bun`, failing on the first non-zero exit. House style: tests are
// self-executing node:assert scripts, NOT bun:test.
import { Glob } from 'bun'

const glob = new Glob('src/**/*.test.ts')
const files: string[] = []
for await (const f of glob.scan({ cwd: import.meta.dirname, onlyFiles: true })) files.push(f)
files.sort()

for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const proc = Bun.spawnSync(['bun', file], { cwd: import.meta.dirname, stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0) {
    console.error(`\nFAIL: ${file} (exit ${proc.exitCode})`)
    process.exit(1)
  }
}
console.log(`\nall ${files.length} suites passed`)
```

**Step 4: Create `canvas-model/src/index.ts`**

```ts
// @ensembleworks/canvas-model — the pure typed canvas document model: schema,
// validation, invariants, and spatial-semantics query functions. Zero runtime
// deps but zod; no Loro, no tldraw, no DOM, no Date.now/Math.random/I/O.
// Convention: intra-package relative imports use the `.js` extension
// (nodenext-style; resolves to the .ts source everywhere).
export const CANVAS_MODEL_VERSION = 1 as const
```

**Step 5: Create the smoke test `canvas-model/src/version.test.ts`** (house style)

```ts
// Run: bun src/version.test.ts
import assert from 'node:assert/strict'
import { CANVAS_MODEL_VERSION } from './index.js'

assert.equal(CANVAS_MODEL_VERSION, 1)
console.log('ok: canvas-model rig')
```

**Step 6: Wire into the root `package.json`**

- Add `"canvas-model"` to the `workspaces` array (put it right after `"contracts"`).
- Append to the root `typecheck` script (after the contracts entry, so a broken
  model fails fast):
  `&& bun run --filter '@ensembleworks/canvas-model' typecheck`

The root `scripts/run-tests.ts` already globs `**/src/**/*.test.ts`, so it will
auto-discover `canvas-model/src/**/*.test.ts` — no change needed there.

**Step 7: Install, typecheck, run the package suite**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun install
bun run --filter '@ensembleworks/canvas-model' typecheck   # exit 0
bun run --filter '@ensembleworks/canvas-model' test        # "all 1 suites passed"
```

**Step 8: Commit**

```bash
git add canvas-model package.json bun.lock
git commit -m "feat(canvas-model): scaffold pure model package + test rig"
```

## Task A2: Scaffold the `canvas-doc` package and pin loro-crdt

**Files:**
- Create: `canvas-doc/package.json`
- Create: `canvas-doc/tsconfig.json`
- Create: `canvas-doc/test.ts` (copy of the A1 runner)
- Create: `canvas-doc/src/index.ts`
- Create: `canvas-doc/src/loro-smoke.test.ts` (proves loro-crdt imports & works)
- Modify: `package.json` (root — `workspaces` + `typecheck`)

**Step 1: Create `canvas-doc/package.json`** (note the exact Loro pin)

```json
{
  "name": "@ensembleworks/canvas-doc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test.ts"
  },
  "dependencies": {
    "@ensembleworks/canvas-model": "*",
    "loro-crdt": "1.13.6"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "bun-types": "1.3.14",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create `canvas-doc/tsconfig.json`** — identical to `canvas-model/tsconfig.json` (Step A1.2).

**Step 3: Create `canvas-doc/test.ts`** — identical to `canvas-model/test.ts` (Step A1.3).

**Step 4: Create `canvas-doc/src/index.ts`**

```ts
// @ensembleworks/canvas-doc — the CRDT document engine. Wraps Loro behind our
// own CanvasDoc interface so the backend stays swappable (Yjs is the sanctioned
// fallback). Depends only on @ensembleworks/canvas-model + loro-crdt; never
// imports from server.
export const CANVAS_DOC_VERSION = 1 as const
```

**Step 5: Create `canvas-doc/src/loro-smoke.test.ts`** — proves the pinned Loro
API this phase relies on actually works under Bun.

```ts
// Run: bun src/loro-smoke.test.ts
import assert from 'node:assert/strict'
import { LoroDoc } from 'loro-crdt'

const doc = new LoroDoc()
doc.setPeerId(1n)
const tree = doc.getTree('shapes')
const a = tree.createNode()
a.data.set('type', 'note')
const b = tree.createNode()
tree.move(a.id, b.id) // reparent a under b
doc.commit()
assert.equal(tree.roots().length, 1, 'only b is a root after reparent')
assert.equal(tree.getNodeByID(a.id)!.parent()!.id, b.id)
assert.equal(a.data.get('type'), 'note')

// Loro enforces no-cycles natively.
assert.throws(() => tree.move(b.id, a.id), /cycle|ancestor|parent/i)

// snapshot round-trip
const snap = doc.export({ mode: 'snapshot' })
const doc2 = new LoroDoc()
doc2.import(snap)
assert.equal(doc2.getTree('shapes').roots().length, 1)

console.log('ok: loro-crdt 1.13.6 smoke')
```

**Step 6: Wire into the root `package.json`**

- Add `"canvas-doc"` to `workspaces` right after `"canvas-model"`.
- Append to the root `typecheck` script:
  `&& bun run --filter '@ensembleworks/canvas-doc' typecheck`

**Step 7: Install, typecheck, run**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun install   # pulls loro-crdt@1.13.6
bun run --filter '@ensembleworks/canvas-doc' typecheck   # exit 0
bun run --filter '@ensembleworks/canvas-doc' test        # "all 1 suites passed"
```
If the Loro smoke test's `assert.throws` regex fails, open the caught error's
message and widen the regex to match Loro's actual cycle-rejection wording — do
not delete the assertion (cycle rejection is load-bearing for Task C3).

**Step 8: Commit**

```bash
git add canvas-doc package.json bun.lock
git commit -m "feat(canvas-doc): scaffold CRDT package + pin loro-crdt 1.13.6"
```

---

# Seam B — canvas-model (pure model, invariants, spatial semantics)

All files in this seam are under `canvas-model/src/`. Every function is pure.

## Task B1: Shape envelope types + ids

**Files:**
- Create: `canvas-model/src/ids.ts`
- Create: `canvas-model/src/ids.test.ts`

**Step 1: Write the failing test `canvas-model/src/ids.test.ts`**

```ts
// Run: bun src/ids.test.ts
import assert from 'node:assert/strict'
import { isShapeId, isPageId, isBindingId, parentKind } from './ids.js'

assert.equal(isShapeId('shape:abc'), true)
assert.equal(isShapeId('page:1'), false)
assert.equal(isPageId('page:1'), true)
assert.equal(isBindingId('binding:x'), true)
assert.equal(parentKind('page:1'), 'page')
assert.equal(parentKind('shape:1'), 'shape')
console.log('ok: ids')
```

**Step 2: Run it — expect failure**

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun canvas-model/src/ids.test.ts
```
Expected: FAIL — `Cannot find module './ids.js'`.

**Step 3: Implement `canvas-model/src/ids.ts`**

```ts
// Branded id helpers. Ids are the verbatim tldraw ids ("shape:…", "page:…",
// "binding:…") so the model round-trips losslessly and v2 responses reference
// the same ids agents already hold.
export type ShapeId = `shape:${string}`
export type PageId = `page:${string}`
export type BindingId = `binding:${string}`
export type ParentId = ShapeId | PageId

export const isShapeId = (s: string): s is ShapeId => s.startsWith('shape:')
export const isPageId = (s: string): s is PageId => s.startsWith('page:')
export const isBindingId = (s: string): s is BindingId => s.startsWith('binding:')
export const parentKind = (id: string): 'shape' | 'page' | 'other' =>
  isShapeId(id) ? 'shape' : isPageId(id) ? 'page' : 'other'
```

**Step 4: Run — expect pass**

```bash
bun canvas-model/src/ids.test.ts   # "ok: ids"
```

**Step 5: Commit**

```bash
git add canvas-model/src/ids.ts canvas-model/src/ids.test.ts
git commit -m "feat(canvas-model): id helpers"
```

## Task B2: Shape schema — envelope + per-kind props (validated, lossless)

The model validates the **envelope** strictly and gives each shape kind a zod
props schema that **types the semantically load-bearing fields and passes the
rest through** (`.passthrough()`), so conversion is lossless without hand-writing
every tldraw prop.

**Files:**
- Create: `canvas-model/src/shape.ts`
- Create: `canvas-model/src/shape.test.ts`

**Step 1: Write the failing test `canvas-model/src/shape.test.ts`**

```ts
// Run: bun src/shape.test.ts
import assert from 'node:assert/strict'
import { SHAPE_KINDS, shapeSchema, validateShape, plainText } from './shape.js'

// Every kind the room can contain is enumerated (8 tldraw + image + 6 custom).
assert.deepEqual(
  [...SHAPE_KINDS].sort(),
  ['arrow','draw','file-viewer','frame','geo','highlight','iframe','image','line','neko','note','roadmap','screenshare','terminal','text'].sort(),
)

const note = {
  id: 'shape:n1', kind: 'note', parentId: 'page:p', index: 'a1',
  x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } },
}
const r = validateShape(note)
assert.equal(r.ok, true)
assert.equal(plainText(note as any), 'hi')

// Unknown props survive (lossless passthrough).
const kept = shapeSchema.parse({ ...note, props: { ...note.props, growY: 7, mystery: 'x' } })
assert.equal((kept.props as any).growY, 7)
assert.equal((kept.props as any).mystery, 'x')

// Bad envelope is rejected with a typed error, never thrown past validateShape.
const bad = validateShape({ ...note, id: 'nope', kind: 'note' })
assert.equal(bad.ok, false)
console.log('ok: shape schema')
```

**Step 2: Run — expect failure** (`Cannot find module './shape.js'`).

**Step 3: Implement `canvas-model/src/shape.ts`**

```ts
import { z } from 'zod'

// The shape kinds a room can contain: tldraw defaults we use + image + the six
// custom HTML-box shapes (contracts/src/shapes.ts).
export const SHAPE_KINDS = [
  'note', 'text', 'geo', 'arrow', 'frame', 'line', 'draw', 'highlight', 'image',
  'terminal', 'iframe', 'neko', 'roadmap', 'screenshare', 'file-viewer',
] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

// Rich text is ProseMirror JSON; we keep it verbatim for lossless round-trip and
// derive plain text for semantics. Structural (not exhaustively typed).
const richText = z.object({ type: z.literal('doc'), content: z.array(z.any()) })

// Per-kind props: type the fields semantics reads; passthrough the rest so no
// tldraw prop is lost. All keys optional except where a field is load-bearing.
const withText = z.object({ richText: richText.optional(), color: z.string().optional() }).passthrough()
const box = z.object({ w: z.number().optional(), h: z.number().optional() }).passthrough()

const propsByKind: Record<ShapeKind, z.ZodTypeAny> = {
  note: withText,
  text: withText,
  geo: withText.and(box),
  arrow: z.object({ richText: richText.optional(), color: z.string().optional() }).passthrough(),
  frame: z.object({ name: z.string().optional() }).and(box),
  line: z.object({}).passthrough(),
  draw: z.object({}).passthrough(),
  highlight: z.object({}).passthrough(),
  image: box,
  terminal: box, iframe: box, neko: box, roadmap: box, screenshare: box, 'file-viewer': box,
}

const idField = z.string().regex(/^shape:/)
const parentField = z.string().regex(/^(shape|page):/)

// The strict envelope shared by every shape. props is refined per-kind below.
const envelope = z.object({
  id: idField,
  kind: z.enum(SHAPE_KINDS),
  parentId: parentField,
  index: z.string().min(1),          // fractional-index string (z-order), kept verbatim
  x: z.number(),
  y: z.number(),
  rotation: z.number(),
  isLocked: z.boolean(),
  opacity: z.number(),
  meta: z.record(z.string(), z.unknown()),
  props: z.record(z.string(), z.unknown()),
})

export type Shape = z.infer<typeof envelope>

// Full schema: envelope + per-kind props refinement (superRefine keeps a single
// discriminant while validating props against the kind's schema).
export const shapeSchema = envelope.superRefine((s, ctx) => {
  const res = propsByKind[s.kind as ShapeKind].safeParse(s.props)
  if (!res.success) {
    ctx.addIssue({ code: 'custom', message: `invalid props for kind ${s.kind}: ${res.error.message}`, path: ['props'] })
  }
})

export type ShapeValidation = { ok: true; shape: Shape } | { ok: false; error: string }

export function validateShape(input: unknown): ShapeValidation {
  const res = shapeSchema.safeParse(input)
  return res.success ? { ok: true, shape: res.data } : { ok: false, error: res.error.message }
}

// Plain text from a shape's richText (paragraphs join on newline). Pure inverse
// of tldraw toRichText, matching server/src/canvas/geometry.ts richTextToPlainText.
export function plainText(shape: Shape): string {
  const rich = (shape.props as any)?.richText
  if (!rich || !Array.isArray(rich.content)) return ''
  const textOf = (n: any): string =>
    !n ? '' : typeof n.text === 'string' ? n.text : Array.isArray(n.content) ? n.content.map(textOf).join('') : ''
  return rich.content.map(textOf).join('\n')
}
```

**Step 4: Run — expect pass.** `bun canvas-model/src/shape.test.ts`

If zod v4's error `.message` shape differs, adjust the test's assertion on
`bad.ok === false` only (do not assert on error string contents).

**Step 5: Commit**

```bash
git add canvas-model/src/shape.ts canvas-model/src/shape.test.ts
git commit -m "feat(canvas-model): shape envelope + per-kind props (lossless passthrough)"
```

## Task B3: Binding schema + CanvasDocument container & accessors

**Files:**
- Create: `canvas-model/src/document.ts`
- Create: `canvas-model/src/document.test.ts`

**Step 1: Write the failing test `canvas-model/src/document.test.ts`**

```ts
// Run: bun src/document.test.ts
import assert from 'node:assert/strict'
import { makeDocument, childrenOf, rootShapes, shapeById, pageBoundsMissing } from './document.js'

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'Page' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { name: 'Planning', w: 400, h: 300 } },
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'yellow' } },
  ],
  bindings: [],
})

assert.equal(shapeById(doc, 'shape:n')!.kind, 'note')
assert.deepEqual(childrenOf(doc, 'shape:f').map((s) => s.id), ['shape:n'])
assert.deepEqual(rootShapes(doc).map((s) => s.id), ['shape:f'])
assert.equal(pageBoundsMissing, undefined) // placeholder export sanity
console.log('ok: document')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/document.ts`**

```ts
import { z } from 'zod'
import { type Shape, shapeSchema } from './shape.js'

export const bindingSchema = z.object({
  id: z.string().regex(/^binding:/),
  fromId: z.string().regex(/^shape:/),   // the arrow shape
  toId: z.string().regex(/^shape:/),     // the bound shape
  props: z.record(z.string(), z.unknown()),
}).passthrough()
export type Binding = z.infer<typeof bindingSchema>

export const pageSchema = z.object({ id: z.string().regex(/^page:/), name: z.string() }).passthrough()
export type Page = z.infer<typeof pageSchema>

export interface CanvasDocument {
  readonly pages: Page[]
  readonly shapes: Shape[]
  readonly bindings: Binding[]
  /** id → shape, built once at construction. */
  readonly byId: ReadonlyMap<string, Shape>
}

export function makeDocument(input: { pages: Page[]; shapes: Shape[]; bindings: Binding[] }): CanvasDocument {
  const byId = new Map(input.shapes.map((s) => [s.id, s]))
  return { pages: input.pages, shapes: input.shapes, bindings: input.bindings, byId }
}

export const shapeById = (doc: CanvasDocument, id: string): Shape | undefined => doc.byId.get(id)
export const childrenOf = (doc: CanvasDocument, parentId: string): Shape[] =>
  doc.shapes.filter((s) => s.parentId === parentId)
export const rootShapes = (doc: CanvasDocument): Shape[] =>
  doc.shapes.filter((s) => s.parentId.startsWith('page:'))
export const frames = (doc: CanvasDocument): Shape[] => doc.shapes.filter((s) => s.kind === 'frame')

// re-export so downstream imports one module
export { shapeSchema }
// (test-only sanity placeholder — remove if you prefer; harmless export)
export const pageBoundsMissing = undefined
```

**Step 4: Run — expect pass.** Then delete the `pageBoundsMissing` placeholder and
its test line (they only prove wiring); re-run.

```bash
bun canvas-model/src/document.test.ts   # "ok: document"
```

**Step 5: Commit**

```bash
git add canvas-model/src/document.ts canvas-model/src/document.test.ts
git commit -m "feat(canvas-model): CanvasDocument container, bindings, tree accessors"
```

## Task B4: Invariants (executable predicates)

**Files:**
- Create: `canvas-model/src/invariants.ts`
- Create: `canvas-model/src/invariants.test.ts`

**Step 1: Write the failing test `canvas-model/src/invariants.test.ts`**

```ts
// Run: bun src/invariants.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { checkInvariants } from './invariants.js'

const base = (over = {}) => ({ rotation: 0, isLocked: false, opacity: 1, meta: {}, ...over })

// Healthy doc → no violations.
const good = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { name: 'F', w: 100, h: 100 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 0, y: 0, props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})
assert.deepEqual(checkInvariants(good), [])

// Orphan: parent id doesn't exist.
const orphan = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:x', kind: 'note', parentId: 'shape:ghost', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
], bindings: [] })
assert.ok(checkInvariants(orphan).some((v) => v.rule === 'noOrphans'))

// Cycle: a→b→a.
const cycle = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:a', kind: 'frame', parentId: 'shape:b', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
  { id: 'shape:b', kind: 'frame', parentId: 'shape:a', index: 'a1', x: 0, y: 0, props: { w: 1, h: 1 }, ...base() } as any,
], bindings: [] })
assert.ok(checkInvariants(cycle).some((v) => v.rule === 'noCycles'))

// Dangling binding.
const dangling = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
], bindings: [{ id: 'binding:1', fromId: 'shape:ar', toId: 'shape:gone', props: {} }] })
assert.ok(checkInvariants(dangling).some((v) => v.rule === 'noDanglingBindings'))

// Invalid props (note with a non-string color would fail props schema — use a
// clearly bad envelope: opacity as a string).
const badProps = makeDocument({ pages: [{ id: 'page:p', name: 'P' }], shapes: [
  { id: 'shape:z', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 'nope' as any, meta: {}, props: {} } as any,
], bindings: [] })
assert.ok(checkInvariants(badProps).some((v) => v.rule === 'validProps'))

console.log('ok: invariants')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/invariants.ts`**

```ts
import { type CanvasDocument } from './document.js'
import { validateShape } from './shape.js'

export type InvariantRule = 'noOrphans' | 'noCycles' | 'noDanglingBindings' | 'validProps'
export interface Violation { rule: InvariantRule; id: string; detail: string }

// All four executable predicates in one pass. Pure; deterministic order (input
// order). The design's canvas-doc repair pass (Phase 2) will consume these.
export function checkInvariants(doc: CanvasDocument): Violation[] {
  const out: Violation[] = []
  const ids = new Set(doc.shapes.map((s) => s.id))
  const pageIds = new Set(doc.pages.map((p) => p.id))

  for (const s of doc.shapes) {
    // validProps (also catches a malformed envelope)
    const v = validateShape(s)
    if (!v.ok) out.push({ rule: 'validProps', id: s.id, detail: v.error })

    // noOrphans: parent must be an existing shape or page.
    const p = s.parentId
    if (!(ids.has(p) || pageIds.has(p))) out.push({ rule: 'noOrphans', id: s.id, detail: `missing parent ${p}` })
  }

  // noCycles: walking parents from each shape must reach a page within N steps.
  for (const s of doc.shapes) {
    const seen = new Set<string>()
    let cur: string | undefined = s.id
    while (cur && cur.startsWith('shape:')) {
      if (seen.has(cur)) { out.push({ rule: 'noCycles', id: s.id, detail: `cycle via ${cur}` }); break }
      seen.add(cur)
      cur = doc.byId.get(cur)?.parentId
    }
  }

  // noDanglingBindings: both endpoints must be existing shapes.
  for (const b of doc.bindings) {
    if (!ids.has(b.fromId)) out.push({ rule: 'noDanglingBindings', id: b.id, detail: `missing fromId ${b.fromId}` })
    if (!ids.has(b.toId)) out.push({ rule: 'noDanglingBindings', id: b.id, detail: `missing toId ${b.toId}` })
  }
  return out
}
```

**Step 4: Run — expect pass.** `bun canvas-model/src/invariants.test.ts`

**Step 5: Export from index & commit.** Add to `canvas-model/src/index.ts`:

```ts
export * from './ids.js'
export * from './shape.js'
export * from './document.js'
export * from './invariants.js'
```

```bash
bun run --filter '@ensembleworks/canvas-model' typecheck
git add canvas-model/src/invariants.ts canvas-model/src/invariants.test.ts canvas-model/src/index.ts
git commit -m "feat(canvas-model): executable invariants (orphans, cycles, dangling bindings, props)"
```

## Task B5: Geometry (page bounds, centroid, median size)

**Files:**
- Create: `canvas-model/src/geometry.ts`
- Create: `canvas-model/src/geometry.test.ts`

**Step 1: Write the failing test `canvas-model/src/geometry.test.ts`**

```ts
// Run: bun src/geometry.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { pageBounds, centroid, medianSize } from './geometry.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 100, y: 100, props: { name: 'F', w: 200, h: 200 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 20, props: { w: 40, h: 40, color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})

// Child page-space origin = frame origin + child offset.
const b = pageBounds(doc, doc.byId.get('shape:n')!)
assert.deepEqual({ x: b.minX, y: b.minY }, { x: 110, y: 120 })
assert.deepEqual(centroid(b), { x: 130, y: 140 })
assert.equal(medianSize(doc.shapes.filter((s) => s.kind === 'note')), 40)
console.log('ok: geometry')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/geometry.ts`**

```ts
import { type CanvasDocument } from './document.js'
import { type Shape } from './shape.js'

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

const DEFAULTS: Partial<Record<Shape['kind'], { w: number; h: number }>> = {
  note: { w: 200, h: 200 }, geo: { w: 220, h: 120 }, frame: { w: 800, h: 600 },
  text: { w: 200, h: 40 }, image: { w: 200, h: 200 },
}
function size(s: Shape): { w: number; h: number } {
  const p = s.props as any
  const w = typeof p?.w === 'number' ? p.w : DEFAULTS[s.kind]?.w ?? 100
  const h = typeof p?.h === 'number' ? p.h : DEFAULTS[s.kind]?.h ?? 100
  return { w, h }
}

// Page-space top-left: sum this shape's x/y with every ancestor shape's x/y.
// Rotation ignored (unrotated-parents-only, matching server geometry.pagePoint).
function pageOrigin(doc: CanvasDocument, s: Shape): { x: number; y: number } {
  let x = s.x, y = s.y, guard = 0
  let parent = doc.byId.get(s.parentId)
  while (parent && guard++ < 50) { x += parent.x; y += parent.y; parent = doc.byId.get(parent.parentId) }
  return { x, y }
}

export function pageBounds(doc: CanvasDocument, s: Shape): Bounds {
  const o = pageOrigin(doc, s)
  const { w, h } = size(s)
  return { minX: o.x, minY: o.y, maxX: o.x + w, maxY: o.y + h }
}

export const centroid = (b: Bounds) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })

// Median of max(w,h) over the given shapes — the scale-relative unit the semantic
// layer measures gaps against (design: "gaps relative to median sticky size").
export function medianSize(shapes: Shape[]): number {
  const sizes = shapes.map((s) => { const { w, h } = size(s); return Math.max(w, h) }).sort((a, b) => a - b)
  if (sizes.length === 0) return 100
  const mid = Math.floor(sizes.length / 2)
  return sizes.length % 2 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2
}
```

**Step 4: Run — expect pass.** `bun canvas-model/src/geometry.test.ts`

**Step 5: Commit**

```bash
git add canvas-model/src/geometry.ts canvas-model/src/geometry.test.ts
git commit -m "feat(canvas-model): geometry — page bounds, centroid, scale-relative median size"
```

## Task B6: Neighbor query

**Files:**
- Create: `canvas-model/src/neighbors.ts`
- Create: `canvas-model/src/neighbors.test.ts`

**Step 1: Write the failing test `canvas-model/src/neighbors.test.ts`**

```ts
// Run: bun src/neighbors.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { neighbors } from './neighbors.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number) =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 40, h: 40, color: 'yellow' }, ...base() }) as any
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [note('shape:a', 0, 0), note('shape:b', 50, 0), note('shape:c', 500, 0)],
  bindings: [],
})

// Within radius 100 of a's centroid, b is a neighbor but c is not.
const near = neighbors(doc, 'shape:a', 100)
assert.deepEqual(near.map((n) => n.id), ['shape:b'])
console.log('ok: neighbors')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/neighbors.ts`**

```ts
import { type CanvasDocument } from './document.js'
import { centroid, pageBounds } from './geometry.js'

export interface Neighbor { id: string; distance: number }

// Shapes whose centroid falls within `radius` of the target's centroid, nearest
// first, excluding the target. Deterministic (ties break by id).
export function neighbors(doc: CanvasDocument, id: string, radius: number): Neighbor[] {
  const self = doc.byId.get(id)
  if (!self) return []
  const c0 = centroid(pageBounds(doc, self))
  const out: Neighbor[] = []
  for (const s of doc.shapes) {
    if (s.id === id) continue
    const c = centroid(pageBounds(doc, s))
    const d = Math.hypot(c.x - c0.x, c.y - c0.y)
    if (d <= radius) out.push({ id: s.id, distance: d })
  }
  return out.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
}
```

**Step 4: Run — expect pass.** **Step 5: Commit**

```bash
git add canvas-model/src/neighbors.ts canvas-model/src/neighbors.test.ts
git commit -m "feat(canvas-model): neighbor query (scale-agnostic radius)"
```

## Task B7: Clustering + arrangement + confidence + label

Density (single-linkage) clustering of a frame's notes, using a scale-relative
gap threshold; then classify each cluster's arrangement, score confidence, and
attach a nearest label. All deterministic.

**Files:**
- Create: `canvas-model/src/cluster.ts`
- Create: `canvas-model/src/cluster.test.ts`

**Step 1: Write the failing test `canvas-model/src/cluster.test.ts`**

```ts
// Run: bun src/cluster.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { clusterShapes } from './cluster.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number, color = 'yellow') =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 100, h: 100, color }, ...base() }) as any

// Two tight vertical columns far apart, plus one lone outlier.
const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:a1', 0, 0), note('shape:a2', 0, 120), note('shape:a3', 0, 240),   // column A
    note('shape:b1', 800, 0), note('shape:b2', 800, 120),                          // column B
    note('shape:z', 2000, 2000),                                                   // outlier
  ],
  bindings: [],
})

const { clusters, outliers } = clusterShapes(doc, doc.shapes)
assert.equal(clusters.length, 2)
assert.deepEqual(outliers.sort(), ['shape:z'])
// The 3-member column is classified 'column'.
const colA = clusters.find((c) => c.members.includes('shape:a1'))!
assert.equal(colA.arrangement, 'column')
assert.ok(colA.confidence > 0.5) // aligned + uniform colour
console.log('ok: cluster')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/cluster.ts`**

```ts
import { type CanvasDocument } from './document.js'
import { type Shape } from './shape.js'
import { type Bounds, centroid, medianSize, pageBounds } from './geometry.js'
import { plainText } from './shape.js'

export type Arrangement = 'column' | 'grid' | 'loose'
export interface Cluster {
  members: string[]           // shape ids
  arrangement: Arrangement
  confidence: number          // 0..1
  label: string | null        // nearest heading-ish text, if any
  bounds: Bounds
}
export interface ClusterResult { clusters: Cluster[]; outliers: string[] }

// Gap between two axis-aligned rects (0 if they overlap).
function gap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX))
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY))
  return Math.hypot(dx, dy)
}

// k: gap threshold as a multiple of median size. Tunable; 0.9 groups adjacent
// stickies (a one-sticky gap) while keeping distant ones apart.
const GAP_K = 0.9

export function clusterShapes(doc: CanvasDocument, shapes: Shape[], k = GAP_K): ClusterResult {
  const notes = shapes.filter((s) => s.kind === 'note')
  const threshold = medianSize(notes) * k
  const bounds = new Map(notes.map((s) => [s.id, pageBounds(doc, s)]))

  // Single-linkage union-find on gap ≤ threshold.
  const parent = new Map(notes.map((s) => [s.id, s.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++)
      if (gap(bounds.get(notes[i]!.id)!, bounds.get(notes[j]!.id)!) <= threshold) union(notes[i]!.id, notes[j]!.id)

  const groups = new Map<string, string[]>()
  for (const s of notes) { const r = find(s.id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(s.id) }

  const clusters: Cluster[] = []
  const outliers: string[] = []
  // Deterministic order: sort groups by their first member id.
  for (const members of [...groups.values()].sort((a, b) => a[0]!.localeCompare(b[0]!))) {
    if (members.length === 1) { outliers.push(members[0]!); continue }
    const bs = members.map((id) => bounds.get(id)!)
    const cb: Bounds = {
      minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)),
      maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)),
    }
    clusters.push({
      members: [...members].sort((a, b) => a.localeCompare(b)),
      arrangement: classify(bs, medianSize(notes)),
      confidence: confidence(doc, members),
      label: nearestLabel(doc, shapes, centroid(cb)),
      bounds: cb,
    })
  }
  return { clusters, outliers }
}

// column: one vertical stack (x-centroids aligned within half a median).
// grid: multiple distinct rows AND columns. else loose.
function classify(bs: Bounds[], unit: number): Arrangement {
  const cx = bs.map((b) => (b.minX + b.maxX) / 2)
  const cy = bs.map((b) => (b.minY + b.maxY) / 2)
  const buckets = (vals: number[]) => new Set(vals.map((v) => Math.round(v / (unit * 0.75)))).size
  const cols = buckets(cx), rows = buckets(cy)
  if (cols === 1 && rows > 1) return 'column'
  if (cols > 1 && rows > 1 && bs.length >= cols * rows - 1) return 'grid'
  return 'loose'
}

// confidence = 0.5 * colour uniformity + 0.5 * axis alignment.
function confidence(doc: CanvasDocument, members: string[]): number {
  const shapes = members.map((id) => doc.byId.get(id)!)
  const colors = shapes.map((s) => String((s.props as any)?.color ?? ''))
  const modal = Math.max(...[...new Set(colors)].map((c) => colors.filter((x) => x === c).length))
  const colourUniformity = modal / members.length
  const cs = shapes.map((s) => centroid(pageBounds(doc, s)))
  const spread = (vals: number[]) => { const m = vals.reduce((a, b) => a + b, 0) / vals.length; return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) }
  const unit = medianSize(shapes) || 1
  const alignment = 1 - Math.min(1, Math.min(spread(cs.map((c) => c.x)), spread(cs.map((c) => c.y))) / unit)
  return Number((0.5 * colourUniformity + 0.5 * alignment).toFixed(3))
}

// Nearest text/geo-with-text shape to the cluster centroid (a "heading-ish"
// label), else null. Deterministic (nearest, ties by id).
function nearestLabel(doc: CanvasDocument, shapes: Shape[], c: { x: number; y: number }): string | null {
  const candidates = shapes
    .filter((s) => (s.kind === 'text' || s.kind === 'geo') && plainText(s).trim().length > 0)
    .map((s) => { const cc = centroid(pageBounds(doc, s)); return { id: s.id, text: plainText(s), d: Math.hypot(cc.x - c.x, cc.y - c.y) } })
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
  return candidates[0]?.text ?? null
}
```

**Step 4: Run — expect pass.** `bun canvas-model/src/cluster.test.ts`

If `classify` mislabels the 3-note column (e.g. returns `loose`), inspect the
bucket math with the actual centroids and adjust the `0.75` bucket factor — keep
the change deterministic and note why in a comment. Do not add randomness.

**Step 5: Commit**

```bash
git add canvas-model/src/cluster.ts canvas-model/src/cluster.test.ts
git commit -m "feat(canvas-model): density clustering + arrangement/confidence/label"
```

## Task B8: Relations + the assembled semantic view

**Files:**
- Create: `canvas-model/src/semantic.ts`
- Create: `canvas-model/src/semantic.test.ts`
- Modify: `canvas-model/src/index.ts`

**Step 1: Write the failing test `canvas-model/src/semantic.test.ts`**

```ts
// Run: bun src/semantic.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from './document.js'
import { semanticView } from './semantic.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const note = (id: string, x: number, y: number) =>
  ({ id, kind: 'note', parentId: 'page:p', index: 'a1', x, y, props: { w: 100, h: 100, color: 'yellow' }, ...base() }) as any

const doc = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    note('shape:a1', 0, 0), note('shape:a2', 0, 120),        // cluster A
    note('shape:b1', 900, 0), note('shape:b2', 900, 120),    // cluster B
    { id: 'shape:ar', kind: 'arrow', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: {}, ...base() } as any,
  ],
  bindings: [
    { id: 'binding:1', fromId: 'shape:ar', toId: 'shape:a1', props: {} },
    { id: 'binding:2', fromId: 'shape:ar', toId: 'shape:b1', props: {} },
  ],
})

const view = semanticView(doc, doc.shapes)
assert.equal(view.clusters.length, 2)
// The arrow bridges the two clusters → one relation between distinct clusters.
assert.equal(view.relations.length, 1)
assert.notEqual(view.relations[0]!.fromCluster, view.relations[0]!.toCluster)
console.log('ok: semantic')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-model/src/semantic.ts`**

```ts
import { type CanvasDocument } from './document.js'
import { type Shape } from './shape.js'
import { clusterShapes, type Cluster } from './cluster.js'

export interface Relation { arrowId: string; fromCluster: number; toCluster: number }
export interface SemanticView { clusters: Cluster[]; outliers: string[]; relations: Relation[] }

// The design's spatial-semantics view: clusters + outliers + arrow relations
// between clusters. `shapes` is the subset to analyse (a frame's descendants, or
// a whole page). Pure.
export function semanticView(doc: CanvasDocument, shapes: Shape[]): SemanticView {
  const { clusters, outliers } = clusterShapes(doc, shapes)
  const clusterOf = (shapeId: string): number => clusters.findIndex((c) => c.members.includes(shapeId))

  const relations: Relation[] = []
  const inScope = new Set(shapes.map((s) => s.id))
  for (const b of doc.bindings) {
    // An arrow's two bindings share fromId (the arrow). Pair them up by arrow.
  }
  // Group bindings by arrow (fromId), then relate the two endpoints' clusters.
  const byArrow = new Map<string, string[]>()
  for (const b of doc.bindings) {
    if (!inScope.has(b.fromId)) continue
    ;(byArrow.get(b.fromId) ?? byArrow.set(b.fromId, []).get(b.fromId)!).push(b.toId)
  }
  for (const [arrowId, targets] of byArrow) {
    if (targets.length < 2) continue
    const [c1, c2] = [clusterOf(targets[0]!), clusterOf(targets[1]!)]
    if (c1 >= 0 && c2 >= 0 && c1 !== c2) relations.push({ arrowId, fromCluster: c1, toCluster: c2 })
  }
  return { clusters, outliers, relations }
}
```

Delete the empty `for (const b of doc.bindings) {}` stub left in the sketch above
before running (it is a no-op placeholder). Run:

**Step 4: Run — expect pass.** `bun canvas-model/src/semantic.test.ts`

**Step 5: Export & commit.** Append to `canvas-model/src/index.ts`:

```ts
export * from './geometry.js'
export * from './neighbors.js'
export * from './cluster.js'
export * from './semantic.js'
```

```bash
bun run --filter '@ensembleworks/canvas-model' typecheck
bun run --filter '@ensembleworks/canvas-model' test   # all suites pass
git add canvas-model/src/semantic.ts canvas-model/src/semantic.test.ts canvas-model/src/index.ts
git commit -m "feat(canvas-model): semantic view — clusters, outliers, arrow relations"
```

---

# Seam C — canvas-doc (Loro-backed CRDT engine, built & tested in isolation)

`canvas-doc` proves the CRDT layer works and provides model↔Loro bridging for
Phase 2. It is NOT wired into the server this phase.

## Task C1: The `CanvasDoc` interface + Loro skeleton (open/close, snapshot)

**Files:**
- Create: `canvas-doc/src/canvas-doc.ts` (the interface — engine-agnostic)
- Create: `canvas-doc/src/loro-canvas-doc.ts` (the Loro implementation)
- Create: `canvas-doc/src/loro-canvas-doc.test.ts`

**Step 1: Write the failing test `canvas-doc/src/loro-canvas-doc.test.ts`**

```ts
// Run: bun src/loro-canvas-doc.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
// Snapshot of an empty doc round-trips into a fresh doc.
const snap = doc.exportSnapshot()
const doc2 = LoroCanvasDoc.fromSnapshot(snap, { peerId: 2n })
assert.deepEqual(doc2.listShapes(), [])
console.log('ok: canvas-doc skeleton')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-doc/src/canvas-doc.ts`** (the swappable interface)

```ts
import type { Shape } from '@ensembleworks/canvas-model'

// The engine-agnostic contract. LoroCanvasDoc implements it today; a Yjs-backed
// impl could replace it without touching callers (design's swappability rule).
export interface CanvasDoc {
  listShapes(): Shape[]
  getShape(id: string): Shape | undefined
  putShape(shape: Shape): void
  updateProps(id: string, props: Record<string, unknown>): void
  deleteShape(id: string): void
  reparent(id: string, parentId: string, index?: number): void
  getText(id: string): string
  setText(id: string, text: string): void
  exportSnapshot(): Uint8Array
  exportUpdate(): Uint8Array
  import(bytes: Uint8Array): void
  subscribe(listener: () => void): () => void
  commit(): void
}
```

**Step 4: Implement `canvas-doc/src/loro-canvas-doc.ts`** (skeleton — CRUD lands
in C2)

```ts
import { LoroDoc, type LoroTree, type LoroTreeNode } from 'loro-crdt'
import type { Shape } from '@ensembleworks/canvas-model'
import type { CanvasDoc } from './canvas-doc.js'

// Node.data layout: we store the whole model shape envelope as flat keys on the
// Loro tree node's data map. The tldraw/model shape id lives under 'shapeId'
// (the Loro TreeID is separate). Loro's movable tree owns parent/child/z-order.
export class LoroCanvasDoc implements CanvasDoc {
  private constructor(private doc: LoroDoc, private tree: LoroTree) {}

  static create(opts: { peerId: bigint }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'))
  }
  static fromSnapshot(bytes: Uint8Array, opts: { peerId: bigint }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    doc.import(bytes)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'))
  }

  // id → Loro node, resolved from the tree each call (cheap; correctness over caching).
  protected nodeByShapeId(id: string): LoroTreeNode | undefined {
    return this.tree.nodes().find((n) => !n.isDeleted() && n.data.get('shapeId') === id)
  }

  listShapes(): Shape[] { return [] }       // C2
  getShape(_id: string): Shape | undefined { return undefined } // C2
  putShape(_s: Shape): void { throw new Error('C2') }
  updateProps(_id: string, _p: Record<string, unknown>): void { throw new Error('C2') }
  deleteShape(_id: string): void { throw new Error('C2') }
  reparent(_id: string, _parentId: string, _index?: number): void { throw new Error('C3') }
  getText(_id: string): string { throw new Error('C4') }
  setText(_id: string, _t: string): void { throw new Error('C4') }

  exportSnapshot(): Uint8Array { return this.doc.export({ mode: 'snapshot' }) }
  exportUpdate(): Uint8Array { return this.doc.export({ mode: 'update' }) }
  import(bytes: Uint8Array): void { this.doc.import(bytes) }
  subscribe(listener: () => void): () => void { return this.doc.subscribe(() => listener()) }
  commit(): void { this.doc.commit() }
}
```

**Step 5: Run — expect pass.** `bun canvas-doc/src/loro-canvas-doc.test.ts`

**Step 6: Commit**

```bash
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/loro-canvas-doc.test.ts
git commit -m "feat(canvas-doc): CanvasDoc interface + Loro skeleton (snapshot round-trip)"
```

## Task C2: Shape CRUD on the Loro tree

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts`
- Create: `canvas-doc/src/crud.test.ts`

**Step 1: Write the failing test `canvas-doc/src/crud.test.ts`**

```ts
// Run: bun src/crud.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = (id: string, over: any = {}) => ({
  id, kind: 'note', parentId: 'page:p', index: 'a1',
  x: 1, y: 2, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow' }, ...over,
})

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape(shape('shape:a') as any)
doc.putShape(shape('shape:b', { x: 9 }) as any)
doc.commit()

assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:a', 'shape:b'])
assert.equal(doc.getShape('shape:a')!.x, 1)

doc.updateProps('shape:a', { color: 'blue' })
assert.equal((doc.getShape('shape:a')!.props as any).color, 'blue')

doc.deleteShape('shape:b')
assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:a'])
console.log('ok: crud')
```

**Step 2: Run — expect failure** (throws `C2`).

**Step 3: Implement CRUD** in `loro-canvas-doc.ts` — replace the C2 stubs:

```ts
  private static PROP_KEY = '__props'
  private static ENVELOPE_KEYS = ['shapeId', 'kind', 'parentId', 'index', 'x', 'y', 'rotation', 'isLocked', 'opacity', 'meta', LoroCanvasDoc.PROP_KEY] as const

  private readNode(n: LoroTreeNode): Shape {
    const d = n.data
    return {
      id: d.get('shapeId') as string,
      kind: d.get('kind') as Shape['kind'],
      parentId: d.get('parentId') as any,
      index: d.get('index') as string,
      x: d.get('x') as number, y: d.get('y') as number,
      rotation: d.get('rotation') as number,
      isLocked: d.get('isLocked') as boolean,
      opacity: d.get('opacity') as number,
      meta: (d.get('meta') as Record<string, unknown>) ?? {},
      props: (d.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {},
    }
  }

  listShapes(): Shape[] {
    return this.tree.nodes().filter((n) => !n.isDeleted() && n.data.get('shapeId')).map((n) => this.readNode(n))
  }
  getShape(id: string): Shape | undefined {
    const n = this.nodeByShapeId(id)
    return n ? this.readNode(n) : undefined
  }
  putShape(s: Shape): void {
    let n = this.nodeByShapeId(s.id)
    if (!n) n = this.tree.createNode()
    const d = n.data
    d.set('shapeId', s.id); d.set('kind', s.kind); d.set('parentId', s.parentId)
    d.set('index', s.index); d.set('x', s.x); d.set('y', s.y)
    d.set('rotation', s.rotation); d.set('isLocked', s.isLocked); d.set('opacity', s.opacity)
    d.set('meta', s.meta as any); d.set(LoroCanvasDoc.PROP_KEY, s.props as any)
  }
  updateProps(id: string, props: Record<string, unknown>): void {
    const n = this.nodeByShapeId(id)
    if (!n) return
    const cur = (n.data.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {}
    n.data.set(LoroCanvasDoc.PROP_KEY, { ...cur, ...props } as any)
  }
  deleteShape(id: string): void {
    const n = this.nodeByShapeId(id)
    if (n) this.tree.delete(n.id)
  }
```

Loro `LoroMap.set` accepts JSON-serialisable values; storing `meta`/`props` as
plain objects is fine (they are `Value`s). Import `LoroTreeNode` type if not
already imported.

**Step 4: Run — expect pass.** `bun canvas-doc/src/crud.test.ts`

If Loro rejects a nested object in `.set` under this version, wrap the object as
a JSON string (`JSON.stringify`) on write and `JSON.parse` on read for the
`meta`/`__props` keys only — confirm the failure mode first by reading the thrown
error, and add a one-line comment explaining the workaround.

**Step 5: Commit**

```bash
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/crud.test.ts
git commit -m "feat(canvas-doc): shape CRUD over the Loro movable tree"
```

## Task C3: Tree ops — reparent & z-order (native movable-tree semantics)

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts`
- Create: `canvas-doc/src/tree-ops.test.ts`

**Step 1: Write the failing test `canvas-doc/src/tree-ops.test.ts`**

```ts
// Run: bun src/tree-ops.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const s = (id: string, parentId = 'page:p') => ({
  id, kind: 'frame', parentId, index: 'a1', x: 0, y: 0, rotation: 0,
  isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 },
})
const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape(s('shape:f') as any)
doc.putShape(s('shape:g') as any)
doc.putShape(s('shape:c', 'shape:f') as any) // c under f
doc.commit()

// Reparent c under g; its model parentId reflects the move.
doc.reparent('shape:c', 'shape:g')
assert.equal(doc.getShape('shape:c')!.parentId, 'shape:g')

// Reparenting into own descendant is rejected by Loro's native cycle guard.
assert.throws(() => doc.reparent('shape:g', 'shape:c'))
console.log('ok: tree ops')
```

**Step 2: Run — expect failure** (throws `C3`).

**Step 3: Implement `reparent`** — replace the C3 stub:

```ts
  reparent(id: string, parentId: string, index?: number): void {
    const node = this.nodeByShapeId(id)
    if (!node) return
    node.data.set('parentId', parentId)
    if (parentId.startsWith('page:')) {
      // A page is not a tree node; moving to a page = becoming a root.
      this.tree.move(node.id, undefined, index ?? undefined)
    } else {
      const parent = this.nodeByShapeId(parentId)
      if (!parent) throw new Error(`reparent: unknown parent ${parentId}`)
      // Loro throws if `parent` is a descendant of `node` (native cycle guard).
      this.tree.move(node.id, parent.id, index ?? undefined)
    }
  }
```

**Step 4: Run — expect pass.** `bun canvas-doc/src/tree-ops.test.ts`

**Step 5: Commit**

```bash
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/tree-ops.test.ts
git commit -m "feat(canvas-doc): reparent + z-order via Loro movable tree (native cycle guard)"
```

## Task C4: Rich text via LoroText

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts`
- Create: `canvas-doc/src/text.test.ts`

**Step 1: Write the failing test `canvas-doc/src/text.test.ts`**

```ts
// Run: bun src/text.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
doc.setText('shape:n', 'hello')
doc.commit()
assert.equal(doc.getText('shape:n'), 'hello')
doc.setText('shape:n', 'hello world')
assert.equal(doc.getText('shape:n'), 'hello world')
console.log('ok: text')
```

**Step 2: Run — expect failure** (throws `C4`).

**Step 3: Implement text** — replace the C4 stubs. Each shape gets a dedicated
`LoroText` container keyed by shape id:

```ts
  private textKey(id: string): string { return `text:${id}` }
  getText(id: string): string { return this.doc.getText(this.textKey(id)).toString() }
  setText(id: string, text: string): void {
    const t = this.doc.getText(this.textKey(id))
    t.delete(0, t.length)
    t.insert(0, text)
  }
```

`LoroText.length` and `.delete(pos, len)` / `.insert(pos, str)` are confirmed in
the Loro d.ts. (Full ProseMirror binding is Phase 3; Phase 1 only needs
plain-text set/get to prove the container works.)

**Step 4: Run — expect pass.** `bun canvas-doc/src/text.test.ts`

**Step 5: Commit**

```bash
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/text.test.ts
git commit -m "feat(canvas-doc): per-shape LoroText rich-text container"
```

## Task C5: Change subscriptions + model bridge (fromModel / toModel)

**Files:**
- Create: `canvas-doc/src/bridge.ts`
- Create: `canvas-doc/src/bridge.test.ts`
- Modify: `canvas-doc/src/index.ts`

**Step 1: Write the failing test `canvas-doc/src/bridge.test.ts`**

```ts
// Run: bun src/bridge.test.ts
import assert from 'node:assert/strict'
import { makeDocument } from '@ensembleworks/canvas-model'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import { loadModel, dumpModel } from './bridge.js'

const base = () => ({ rotation: 0, isLocked: false, opacity: 1, meta: {} })
const model = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:f', kind: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, props: { name: 'F', w: 100, h: 100 }, ...base() } as any,
    { id: 'shape:n', kind: 'note', parentId: 'shape:f', index: 'a1', x: 5, y: 5, props: { color: 'yellow' }, ...base() } as any,
  ],
  bindings: [],
})

const doc = LoroCanvasDoc.create({ peerId: 1n })
loadModel(doc, model)
doc.commit()

// Subscription fires on a mutation.
let fired = 0
const unsub = doc.subscribe(() => { fired++ })
doc.updateProps('shape:n', { color: 'blue' })
doc.commit()
unsub()
assert.ok(fired >= 1)

// Model round-trips (order-insensitive) through Loro.
const back = dumpModel(doc)
assert.deepEqual(back.shapes.map((s) => s.id).sort(), ['shape:f', 'shape:n'])
assert.equal(back.byId.get('shape:n')!.parentId, 'shape:f')
console.log('ok: bridge')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `canvas-doc/src/bridge.ts`**

```ts
import { type CanvasDocument, makeDocument } from '@ensembleworks/canvas-model'
import type { LoroCanvasDoc } from './loro-canvas-doc.js'

// Load a pure model document into a CanvasDoc: put parents before children so
// reparent targets exist, then wire the tree edges.
export function loadModel(doc: LoroCanvasDoc, model: CanvasDocument): void {
  const ordered = topoByDepth(model)
  for (const s of ordered) doc.putShape(s)
  for (const s of ordered) doc.reparent(s.id, s.parentId)
}

// Dump the CanvasDoc back to a pure model document (pages/bindings are not held
// in the tree this phase — callers that need them keep them alongside).
export function dumpModel(doc: LoroCanvasDoc): CanvasDocument {
  return makeDocument({ pages: [], shapes: doc.listShapes(), bindings: [] })
}

// Shallowest-first so a child is never inserted before its parent.
function topoByDepth(model: CanvasDocument) {
  const depth = (id: string, guard = 0): number => {
    const s = model.byId.get(id)
    if (!s || !s.parentId.startsWith('shape:') || guard > 50) return 0
    return 1 + depth(s.parentId, guard + 1)
  }
  return [...model.shapes].sort((a, b) => depth(a.id) - depth(b.id))
}
```

**Step 4: Run — expect pass.** `bun canvas-doc/src/bridge.test.ts`

**Step 5: Export & full package check + commit.** Append to `canvas-doc/src/index.ts`:

```ts
export * from './canvas-doc.js'
export * from './loro-canvas-doc.js'
export * from './bridge.js'
```

```bash
bun run --filter '@ensembleworks/canvas-doc' typecheck
bun run --filter '@ensembleworks/canvas-doc' test   # all suites pass
git add canvas-doc/src/bridge.ts canvas-doc/src/bridge.test.ts canvas-doc/src/index.ts
git commit -m "feat(canvas-doc): change subscriptions + model bridge (loadModel/dumpModel)"
```

---

# Seam D — Converter (server-side: tldraw store ↔ canvas-model)

The converter lives in `server/src/canvas-v2/`. The server already depends on
`@tldraw/*`; add a dependency on `@ensembleworks/canvas-model`.

## Task D0: Wire canvas-model into the server workspace

**Files:**
- Modify: `server/package.json`

**Step 1:** Add to `server/package.json` `dependencies`:
`"@ensembleworks/canvas-model": "*"`.

**Step 2: Install & typecheck**

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun install
bun run --filter '@ensembleworks/server' typecheck   # exit 0
```

**Step 3: Commit**

```bash
git add server/package.json bun.lock
git commit -m "chore(server): depend on @ensembleworks/canvas-model for the converter"
```

## Task D1: tldraw records → CanvasDocument

**Files:**
- Create: `server/src/canvas-v2/convert.ts`
- Create: `server/src/canvas-v2/convert-from-tldraw.test.ts`

**Step 1: Write the failing test** `server/src/canvas-v2/convert-from-tldraw.test.ts`
(house style; boots nothing — pure record arrays that mirror what
`getCurrentSnapshot().documents.map(d => d.state)` yields).

```ts
// Run: bun src/canvas-v2/convert-from-tldraw.test.ts
import assert from 'node:assert/strict'
import { fromTldraw } from './convert.ts'

const records = [
  { typeName: 'document', id: 'document:document' },
  { typeName: 'page', id: 'page:p', name: 'Page 1', index: 'a1', meta: {} },
  { typeName: 'shape', id: 'shape:f', type: 'frame', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { name: 'Planning', w: 400, h: 300, color: 'black' } },
  { typeName: 'shape', id: 'shape:n', type: 'note', parentId: 'shape:f', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } } },
  { typeName: 'shape', id: 'shape:term', type: 'terminal', parentId: 'page:p', index: 'a2', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 640, h: 480, sessionId: 'abc', title: 't' } },
  { typeName: 'shape', id: 'shape:ar', type: 'arrow', parentId: 'page:p', index: 'a3', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { color: 'black' } },
  { typeName: 'binding', id: 'binding:1', type: 'arrow', fromId: 'shape:ar', toId: 'shape:f', props: { terminal: 'start' } },
  { typeName: 'binding', id: 'binding:2', type: 'arrow', fromId: 'shape:ar', toId: 'shape:n', props: { terminal: 'end' } },
  { typeName: 'asset', id: 'asset:x', props: { src: 'http://x' } },
]

const doc = fromTldraw(records)
assert.deepEqual(doc.pages.map((p) => p.id), ['page:p'])
assert.equal(doc.shapes.length, 4)                       // 4 shapes, asset/page/document excluded
assert.equal(doc.byId.get('shape:term')!.kind, 'terminal') // custom shape preserved
assert.equal((doc.byId.get('shape:n')!.props as any).richText.content[0].content[0].text, 'hi') // richText verbatim
assert.equal(doc.bindings.length, 2)
console.log('ok: fromTldraw')
```

**Step 2: Run — expect failure.**

**Step 3: Implement `server/src/canvas-v2/convert.ts`** (the `fromTldraw` half)

```ts
/**
 * Converter between the tldraw store (flat records) and the pure
 * @ensembleworks/canvas-model CanvasDocument. Lives server-side because it is
 * inherently tldraw-coupled; the canvas-* packages stay clean-room and
 * tldraw-free. Read path for Agent API v2, and the seed of the Phase 5 migration
 * tool.
 */
import {
  type Binding, type CanvasDocument, type Page, type Shape, SHAPE_KINDS, makeDocument,
} from '@ensembleworks/canvas-model'

const KINDS = new Set<string>(SHAPE_KINDS)

// tldraw shape record → model Shape. Envelope fields map 1:1; props pass through
// verbatim (lossless, incl. richText). Unknown shape types are dropped (they
// cannot be in this schema, but be defensive).
function shapeFromRecord(r: any): Shape | null {
  if (!KINDS.has(r.type)) return null
  return {
    id: r.id, kind: r.type, parentId: r.parentId, index: r.index,
    x: r.x ?? 0, y: r.y ?? 0, rotation: r.rotation ?? 0,
    isLocked: !!r.isLocked, opacity: r.opacity ?? 1,
    meta: r.meta ?? {}, props: r.props ?? {},
  }
}

export function fromTldraw(records: any[]): CanvasDocument {
  const pages: Page[] = []
  const shapes: Shape[] = []
  const bindings: Binding[] = []
  for (const r of records) {
    switch (r.typeName) {
      case 'page': pages.push({ id: r.id, name: r.name ?? '', index: r.index }); break
      case 'shape': { const s = shapeFromRecord(r); if (s) shapes.push(s); break }
      case 'binding':
        if (r.type === 'arrow') bindings.push({ id: r.id, fromId: r.fromId, toId: r.toId, props: r.props ?? {} })
        break
      // document / asset / instance* → out-of-band, ignored by the model.
    }
  }
  return makeDocument({ pages, shapes, bindings })
}
```

**Step 4: Run — expect pass.** `bun server/src/canvas-v2/convert-from-tldraw.test.ts`

**Step 5: Commit**

```bash
git add server/src/canvas-v2/convert.ts server/src/canvas-v2/convert-from-tldraw.test.ts
git commit -m "feat(server): tldraw records → canvas-model converter (custom shapes + bindings)"
```

## Task D2: CanvasDocument → tldraw records (the round-trip half)

**Files:**
- Modify: `server/src/canvas-v2/convert.ts`
- Create: `server/src/canvas-v2/roundtrip.test.ts`

**Step 1: Write the failing round-trip test** `server/src/canvas-v2/roundtrip.test.ts`.
It seeds a REAL room through `updateStore` with every used shape type + the 6
custom + a bound arrow, snapshots it, converts both directions, and asserts the
shape/binding records survive byte-for-byte on the fields the model carries.

```ts
// Run: bun src/canvas-v2/roundtrip.test.ts
// Boots createSyncApp, seeds one room with the full shape zoo via updateStore
// (the canvas-api.test.ts pattern), then asserts fromTldraw→toTldraw is lossless
// for shape envelopes + props + bindings.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBindingId, createShapeId, toRichText } from '@tldraw/tlschema'
import { createSyncApp } from '../app.ts'
import { fromTldraw, toTldraw } from './convert.ts'

const base = (over: any) => ({ typeName: 'shape', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, parentId: 'page:page', index: 'a1', ...over })

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rt-'))
  const { getOrCreateRoom } = createSyncApp({ dataDir })
  const room = getOrCreateRoom('rt')

  const noteId = createShapeId(), frameId = createShapeId(), termId = createShapeId()
  const geoId = createShapeId(), arrowId = createShapeId()
  await room.updateStore((store) => {
    store.put(base({ id: frameId, type: 'frame', index: 'a1', props: { w: 400, h: 300, name: 'Planning', color: 'black' } }) as any)
    store.put(base({ id: noteId, type: 'note', parentId: frameId, index: 'a1', props: { richText: toRichText('hi'), color: 'yellow', labelColor: 'black', size: 'm', font: 'draw', fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1, textFirstEditedBy: null } }) as any)
    store.put(base({ id: geoId, type: 'geo', index: 'a2', props: { geo: 'rectangle', dash: 'draw', url: '', w: 220, h: 120, growY: 0, scale: 1, labelColor: 'black', color: 'black', fill: 'semi', size: 's', font: 'draw', align: 'middle', verticalAlign: 'middle', richText: toRichText('A') } }) as any)
    store.put(base({ id: termId, type: 'terminal', index: 'a3', props: { w: 640, h: 480, sessionId: 'abc', title: 't' } }) as any)
    store.put(base({ id: arrowId, type: 'arrow', index: 'a4', props: { kind: 'arc', labelColor: 'black', color: 'black', fill: 'none', dash: 'draw', size: 's', arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, bend: 0, richText: toRichText(''), labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 } }) as any)
    for (const [terminal, target] of [['start', geoId], ['end', frameId]] as const)
      store.put({ id: createBindingId(), typeName: 'binding', type: 'arrow', fromId: arrowId, toId: target, meta: {}, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } } as any)
  })

  const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
  const model = fromTldraw(records)
  const back = toTldraw(model)
  const backById = new Map(back.map((r) => [r.id, r]))

  // Every model shape re-emits with identical envelope + props.
  for (const s of model.shapes) {
    const r = backById.get(s.id)
    assert.ok(r, `shape ${s.id} re-emitted`)
    assert.equal(r.type, s.kind)
    assert.equal(r.parentId, s.parentId)
    assert.equal(r.x, s.x); assert.equal(r.y, s.y)
    assert.deepEqual(r.props, s.props) // lossless props incl. richText
  }
  // Bindings survive.
  assert.equal(back.filter((r) => r.typeName === 'binding').length, 2)
  // Custom + default kinds all present.
  const kinds = new Set(model.shapes.map((s) => s.kind))
  for (const k of ['frame', 'note', 'geo', 'terminal', 'arrow']) assert.ok(kinds.has(k as any), `has ${k}`)

  console.log('ok: roundtrip')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

**Step 2: Run — expect failure** (`toTldraw` undefined).

**Step 3: Implement `toTldraw`** in `server/src/canvas-v2/convert.ts`:

```ts
// model Shape → tldraw shape record. Inverse of shapeFromRecord; props verbatim.
export function toTldraw(doc: CanvasDocument): any[] {
  const out: any[] = []
  for (const s of doc.shapes) {
    out.push({
      typeName: 'shape', id: s.id, type: s.kind, parentId: s.parentId, index: s.index,
      x: s.x, y: s.y, rotation: s.rotation, isLocked: s.isLocked, opacity: s.opacity,
      meta: s.meta, props: s.props,
    })
  }
  for (const b of doc.bindings) {
    out.push({ typeName: 'binding', id: b.id, type: 'arrow', fromId: b.fromId, toId: b.toId, props: b.props, meta: {} })
  }
  return out
}
```

**Step 4: Run — expect pass.** `bun server/src/canvas-v2/roundtrip.test.ts`

If `assert.deepEqual(r.props, s.props)` fails, the diff shows which prop the model
dropped — because props pass through verbatim, a failure means `shapeFromRecord`
or `toTldraw` mutated the object; fix the converter, never the assertion.

**Step 5: Commit**

```bash
git add server/src/canvas-v2/convert.ts server/src/canvas-v2/roundtrip.test.ts
git commit -m "feat(server): canvas-model → tldraw converter + lossless round-trip over the shape zoo"
```

---

# Seam E — Agent API v2 (read side)

Versioned, read-only endpoints that serve the NEW model by converting the live
store on each request. Declared as `ToolDef`s so agents discover them via
`GET /api/tools`.

## Task E1: Declare the v2 tools in contracts

**Files:**
- Create: `contracts/src/tools/canvas-v2.ts`
- Modify: `contracts/src/tools/index.ts`

**Step 1: Write `contracts/src/tools/canvas-v2.ts`.** Five read endpoints under
`/api/v2/canvas/*`. Outputs are described loosely (contracts must not depend on
`canvas-model`).

```ts
import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')
const ok = z.object({ ok: z.literal(true) }).passthrough()

export const canvasV2Document: ToolDef = {
  plugin: 'canvas-v2', id: 'document',
  http: { method: 'GET', path: '/api/v2/canvas/document' },
  help: 'Read the whole room as the new canvas-model document (pages, shapes, bindings), converted live from the tldraw store.',
  zodInput: z.object({ room }),
  zodOutput: ok,
}
export const canvasV2Frames: ToolDef = {
  plugin: 'canvas-v2', id: 'frames',
  http: { method: 'GET', path: '/api/v2/canvas/frames' },
  help: 'List frames (id, name, page, page-space bounds, child counts) from the new model.',
  zodInput: z.object({ room }),
  zodOutput: ok,
}
export const canvasV2Frame: ToolDef = {
  plugin: 'canvas-v2', id: 'frame',
  http: { method: 'GET', path: '/api/v2/canvas/frame' },
  help: "Read one fuzzy-matched frame's members (id, kind, text, bounds) from the new model.",
  zodInput: z.object({ room, name: z.string().min(1).describe('fuzzy frame name') }),
  zodOutput: ok,
}
export const canvasV2Semantic: ToolDef = {
  plugin: 'canvas-v2', id: 'semantic',
  http: { method: 'GET', path: '/api/v2/canvas/semantic' },
  help: 'Spatial semantics for a frame (or the whole page): clusters (members, arrangement, confidence, label), outliers, and arrow relations between clusters. Scale-relative thresholds.',
  zodInput: z.object({ room, frame: z.string().optional().describe('fuzzy frame name; omitted = whole first page') }),
  zodOutput: ok,
}
export const canvasV2Neighbors: ToolDef = {
  plugin: 'canvas-v2', id: 'neighbors',
  http: { method: 'GET', path: '/api/v2/canvas/neighbors' },
  help: 'Shapes within a radius of a given shape (nearest first). radius is in page units.',
  zodInput: z.object({ room, id: z.string().min(1).describe('shape id'), radius: z.coerce.number().default(400) }),
  zodOutput: ok,
}

export const canvasV2Tools: ToolDef[] = [
  canvasV2Document, canvasV2Frames, canvasV2Frame, canvasV2Semantic, canvasV2Neighbors,
]
```

**Step 2: Register in `contracts/src/tools/index.ts`.** Add the import, the
`export *`, and include `...canvasV2Tools` in `allTools` (after `...roadmapTools`):

```ts
import { canvasV2Tools } from './canvas-v2.js'
export * from './canvas-v2.js'
// …in allTools:  ...roadmapTools, ...canvasV2Tools,
```

**Step 3: Typecheck contracts**

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun run --filter '@ensembleworks/contracts' typecheck   # exit 0
```

**Step 4: Commit**

```bash
git add contracts/src/tools/canvas-v2.ts contracts/src/tools/index.ts
git commit -m "feat(contracts): declare Agent API v2 read tools (canvas-v2)"
```

## Task E2: The v2 router — document, frames, frame

**Files:**
- Create: `server/src/features/canvas-v2.ts`
- Modify: `server/src/app.ts` (mount the router)
- Create: `server/src/canvas-v2-api.test.ts`

**Step 1: Write the failing test** `server/src/canvas-v2-api.test.ts` (boots the
app, seeds via the v1 write API, hits v2 reads).

```ts
// Run: bun src/canvas-v2-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'v2-'))
  const { server } = createSyncApp({ dataDir })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as any
  const base = `http://127.0.0.1:${port}`
  const post = (p: string, b: any) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
  const get = (p: string) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }))

  // Seed via the v1 write API: a frame + two notes inside it.
  const frame = await post('/api/canvas/shape', { room: 'r', type: 'frame', name: 'Planning', x: 0, y: 0, w: 600, h: 400 })
  await post('/api/canvas/shape', { room: 'r', type: 'note', frame: 'Planning', x: 20, y: 20, text: 'alpha' })
  await post('/api/canvas/shape', { room: 'r', type: 'note', frame: 'Planning', x: 20, y: 140, text: 'beta' })
  assert.ok(frame.ok)

  // document
  const doc = await get('/api/v2/canvas/document?room=r')
  assert.equal(doc.status, 200)
  assert.equal(doc.body.shapes.length, 3)
  assert.equal(doc.body.model, 2) // model marker

  // frames
  const frames = await get('/api/v2/canvas/frames?room=r')
  assert.equal(frames.status, 200)
  assert.equal(frames.body.frames.length, 1)
  assert.equal(frames.body.frames[0].name, 'Planning')
  assert.equal(frames.body.frames[0].notes, 2)

  // frame contents
  const one = await get('/api/v2/canvas/frame?room=r&name=plan')
  assert.equal(one.status, 200)
  assert.deepEqual(one.body.members.map((m: any) => m.text).sort(), ['alpha', 'beta'])

  // 404 on unknown frame
  const miss = await get('/api/v2/canvas/frame?room=r&name=zzz')
  assert.equal(miss.status, 404)

  console.log('ok: canvas-v2 api (document/frames/frame)')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

**Step 2: Run — expect failure** (404s — router not mounted).

**Step 3: Implement `server/src/features/canvas-v2.ts`.**

```ts
/**
 * Agent API v2 (read side, Phase 1). Versioned read endpoints that serve the new
 * canvas-model, converted live from the tldraw store on each request. Read-only;
 * the live editing/write path is untouched. Endpoints declared as ToolDefs in
 * @ensembleworks/contracts (canvas-v2).
 */
import {
  canvasV2Document, canvasV2Frame, canvasV2Frames, canvasV2Neighbors, canvasV2Semantic,
} from '@ensembleworks/contracts'
import {
  childrenOf, frames as modelFrames, neighbors, pageBounds, plainText, rootShapes, semanticView, shapeById,
  type CanvasDocument, type Shape,
} from '@ensembleworks/canvas-model'
import express from 'express'
import { fromTldraw } from '../canvas-v2/convert.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

export function createCanvasV2Router(ctx: PluginServerContext): express.Router {
  const router = express.Router()

  // Live conversion: snapshot → model. One helper so every read is identical.
  const modelFor = (roomId: string): CanvasDocument => {
    const records = ctx.rooms.getOrCreateRoom(roomId).getCurrentSnapshot().documents.map((d) => d.state as any)
    return fromTldraw(records)
  }
  const roomOf = (req: express.Request) => sanitizeId(String(req.query.room ?? 'team'))

  // Fuzzy frame match (same rule as v1: case-insensitive substring on name).
  const findFrame = (doc: CanvasDocument, name: string): Shape | undefined =>
    modelFrames(doc).find((f) => String((f.props as any)?.name ?? '').toLowerCase().includes(name.toLowerCase()))

  const memberOf = (doc: CanvasDocument, s: Shape) => {
    const b = pageBounds(doc, s)
    return { id: s.id, kind: s.kind, text: plainText(s), bounds: b }
  }

  // GET /api/v2/canvas/document
  router.get(canvasV2Document.http.path, (req, res) => {
    const room = roomOf(req)
    if (!room) return void res.status(400).json({ error: 'bad room id' })
    const doc = modelFor(room)
    res.json({ ok: true, model: 2, pages: doc.pages, shapes: doc.shapes, bindings: doc.bindings })
  })

  // GET /api/v2/canvas/frames
  router.get(canvasV2Frames.http.path, (req, res) => {
    const room = roomOf(req)
    if (!room) return void res.status(400).json({ error: 'bad room id' })
    const doc = modelFor(room)
    const frames = modelFrames(doc).map((f) => {
      const kids = childrenOf(doc, f.id)
      const count = (k: Shape['kind']) => kids.filter((c) => c.kind === k).length
      return {
        id: f.id, name: String((f.props as any)?.name ?? ''),
        bounds: pageBounds(doc, f),
        notes: count('note'), texts: count('text'), geos: count('geo'),
        images: count('image'), terminals: count('terminal'), iframes: count('iframe'),
      }
    })
    res.json({ ok: true, model: 2, frames })
  })

  // GET /api/v2/canvas/frame?name=
  router.get(canvasV2Frame.http.path, (req, res) => {
    const room = roomOf(req)
    const name = typeof req.query.name === 'string' ? req.query.name : ''
    if (!room) return void res.status(400).json({ error: 'bad room id' })
    if (!name) return void res.status(400).json({ error: 'name is required' })
    const doc = modelFor(room)
    const frame = findFrame(doc, name)
    if (!frame) return void res.status(404).json({ error: 'frame not found' })
    res.json({ ok: true, model: 2, frame: { id: frame.id, name: String((frame.props as any)?.name ?? '') },
      members: childrenOf(doc, frame.id).map((c) => memberOf(doc, c)) })
  })

  // Semantic + neighbors land in Task E3 (added to this same router).
  attachSemantic(router, { modelFor, roomOf, findFrame })
  return router
}

// Declared here, implemented in E3; keeps E2's diff focused.
function attachSemantic(_router: express.Router, _deps: unknown): void { /* E3 */ }
```

For E2, make `attachSemantic` a no-op (as above). The semantic/neighbors routes
are added in E3 — but because their `ToolDef`s are already declared (E1), leaving
them unmounted now would 404. **Therefore E2 and E3 must land before running
`tools-api.test.ts`.** (E5 handles that.) To keep each task independently green,
E2's own test only exercises document/frames/frame.

**Step 4: Mount the router in `server/src/app.ts`.** After
`app.use(createFramesRouter(ctx))` (keep it grouped with the other canvas
readers, and above the static catch-all):

```ts
import { createCanvasV2Router } from './features/canvas-v2.ts'
// …
app.use(createCanvasV2Router(ctx))
```

**Step 5: Run — expect pass.** `bun server/src/canvas-v2-api.test.ts`

**Step 6: Commit**

```bash
git add server/src/features/canvas-v2.ts server/src/app.ts server/src/canvas-v2-api.test.ts
git commit -m "feat(server): Agent API v2 read endpoints — document, frames, frame"
```

## Task E3: Semantic + neighbors endpoints

**Files:**
- Modify: `server/src/features/canvas-v2.ts`
- Create: `server/src/canvas-v2-semantic.test.ts`

**Step 1: Write the failing test** `server/src/canvas-v2-semantic.test.ts`.

```ts
// Run: bun src/canvas-v2-semantic.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'v2s-'))
  const { server } = createSyncApp({ dataDir })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as any
  const base = `http://127.0.0.1:${port}`
  const post = (b: any) => fetch(`${base}/api/canvas/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'r', ...b }) }).then((r) => r.json())
  const get = (p: string) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }))

  await post({ type: 'frame', name: 'Planning', x: 0, y: 0, w: 1200, h: 800 })
  // A tight column of 3 notes near the top-left, one outlier far away.
  for (const [i, t] of ['alpha', 'beta', 'gamma'].entries())
    await post({ type: 'note', frame: 'Planning', x: 20, y: 20 + i * 120, text: t, color: 'yellow' })
  await post({ type: 'note', frame: 'Planning', x: 900, y: 700, text: 'lonely', color: 'blue' })

  const sem = await get('/api/v2/canvas/semantic?room=r&frame=plan')
  assert.equal(sem.status, 200)
  assert.equal(sem.body.model, 2)
  assert.ok(sem.body.clusters.length >= 1, 'at least one cluster')
  assert.ok(sem.body.outliers.length >= 1, 'the lonely note is an outlier')

  // neighbors: pass a real note id from the document read.
  const doc = await get('/api/v2/canvas/document?room=r')
  const aNote = doc.body.shapes.find((s: any) => s.kind === 'note')
  const near = await get(`/api/v2/canvas/neighbors?room=r&id=${encodeURIComponent(aNote.id)}&radius=300`)
  assert.equal(near.status, 200)
  assert.ok(Array.isArray(near.body.neighbors))

  console.log('ok: canvas-v2 semantic + neighbors')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

**Step 2: Run — expect failure** (semantic route 404 — `attachSemantic` is a no-op).

**Step 3: Implement the semantic + neighbors routes.** Replace the E2 no-op
`attachSemantic` with a real implementation, and add the imports at the top of
`canvas-v2.ts` (`canvasV2Semantic`, `canvasV2Neighbors`, `semanticView`,
`neighbors`, `shapeById`, `rootShapes` are already imported in E2's version).

```ts
function attachSemantic(
  router: express.Router,
  deps: {
    modelFor: (room: string) => CanvasDocument
    roomOf: (req: express.Request) => string
    findFrame: (doc: CanvasDocument, name: string) => Shape | undefined
  },
): void {
  // GET /api/v2/canvas/semantic?frame=
  router.get(canvasV2Semantic.http.path, (req, res) => {
    const room = deps.roomOf(req)
    if (!room) return void res.status(400).json({ error: 'bad room id' })
    const doc = deps.modelFor(room)
    const frameName = typeof req.query.frame === 'string' ? req.query.frame : ''
    let scope: Shape[]
    let frameInfo: { id: string; name: string } | null = null
    if (frameName) {
      const frame = deps.findFrame(doc, frameName)
      if (!frame) return void res.status(404).json({ error: 'frame not found' })
      frameInfo = { id: frame.id, name: String((frame.props as any)?.name ?? '') }
      scope = childrenOf(doc, frame.id)
    } else {
      scope = rootShapes(doc)
    }
    const view = semanticView(doc, scope)
    res.json({ ok: true, model: 2, frame: frameInfo, ...view })
  })

  // GET /api/v2/canvas/neighbors?id=&radius=
  router.get(canvasV2Neighbors.http.path, (req, res) => {
    const room = deps.roomOf(req)
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    const radius = Number(req.query.radius ?? 400)
    if (!room) return void res.status(400).json({ error: 'bad room id' })
    if (!id) return void res.status(400).json({ error: 'id is required' })
    const doc = deps.modelFor(room)
    if (!shapeById(doc, id)) return void res.status(404).json({ error: 'shape not found' })
    res.json({ ok: true, model: 2, id, radius, neighbors: neighbors(doc, id, Number.isFinite(radius) ? radius : 400) })
  })
}
```

`childrenOf` is imported in E2. Ensure it (and `rootShapes`, `shapeById`,
`semanticView`, `neighbors`) are in the import list.

**Step 4: Run — expect pass.** `bun server/src/canvas-v2-semantic.test.ts`

**Step 5: Commit**

```bash
git add server/src/features/canvas-v2.ts server/src/canvas-v2-semantic.test.ts
git commit -m "feat(server): Agent API v2 spatial semantics + neighbor endpoints"
```

## Task E4: Keep the tools-completeness test consistent

Now that five v2 routes are mounted AND declared, direction B stays satisfied for
them — but the top-level `manifest.tools.length === 17` assertion is stale.

**Files:**
- Modify: `server/src/tools-api.test.ts`

**Step 1:** Update the count assertion. There are 17 prior tools + 5 v2 tools = **22**.

Change:
```ts
	assert.equal(manifest.tools.length, 17, 'manifest declares 17 tools')
```
to:
```ts
	assert.equal(manifest.tools.length, 22, 'manifest declares 22 tools (17 + 5 canvas-v2)')
```

**Step 2: Run the completeness test and confirm the ONLY failure is the accepted
Discord baseline.**

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun server/src/tools-api.test.ts 2>&1 | tail -20
```
Expected: it fails on `mounted route not declared: GET /api/discord/bindings`
(the pre-existing baseline). It must **not** fail on any `/api/v2/canvas/*` route
(those are declared) nor on the count (now 22). If the count is different from 22,
the real number is `17 + <v2 tools you declared>`; set it to that and note why.

**Step 3: Commit**

```bash
git add server/src/tools-api.test.ts
git commit -m "test(server): bump tools-manifest count for canvas-v2 (discord baseline unchanged)"
```

## Task E5: E2E smoke — drive every v2 endpoint through the running server

The design's watchdog for "untyped consumers breaking silently" is an E2E smoke
suite driving every v2 endpoint. The `e2e` workspace already boots the real
server (:8788) + Vite via Playwright; add a **pure-HTTP** spec (no browser needed
for read endpoints) under `e2e/tests/`.

**Files:**
- Create: `e2e/tests/canvas-v2.spec.ts`

**Step 1: Read `e2e/lib/seed.ts` and `e2e/lib/fixtures.ts`** to reuse the `API`
constant and the `shape`/`sticky` seed helpers (they POST to the v1 API on
:8788). Then write `e2e/tests/canvas-v2.spec.ts`:

```ts
// Drives every Agent API v2 read endpoint against the real server (:8788). Pure
// HTTP — the read side needs no browser. This is the "untyped consumers" watchdog.
import { test, expect } from '../lib/fixtures'
import { API, shape } from '../lib/seed'

const get = (p: string) => fetch(`${API}${p}`).then(async (r) => ({ status: r.status, body: await r.json() as any }))

test('canvas-v2 read endpoints serve the new model', async () => {
  const room = 'v2-smoke'
  await shape(room, { type: 'frame', name: 'Planning', x: 0, y: 0, w: 1000, h: 800 })
  for (const [i, t] of ['alpha', 'beta', 'gamma'].entries())
    await shape(room, { type: 'note', frame: 'Planning', x: 20, y: 20 + i * 120, text: t, color: 'yellow' })
  await shape(room, { type: 'note', frame: 'Planning', x: 800, y: 700, text: 'lonely', color: 'blue' })

  const doc = await get(`/api/v2/canvas/document?room=${room}`)
  expect(doc.status).toBe(200)
  expect(doc.body.model).toBe(2)
  expect(doc.body.shapes.length).toBe(5)

  const frames = await get(`/api/v2/canvas/frames?room=${room}`)
  expect(frames.body.frames[0].name).toBe('Planning')
  expect(frames.body.frames[0].notes).toBe(4)

  const frame = await get(`/api/v2/canvas/frame?room=${room}&name=plan`)
  expect(frame.status).toBe(200)
  expect(frame.body.members.length).toBe(4)

  const sem = await get(`/api/v2/canvas/semantic?room=${room}&frame=plan`)
  expect(sem.status).toBe(200)
  expect(sem.body.clusters.length).toBeGreaterThanOrEqual(1)
  expect(sem.body.outliers.length).toBeGreaterThanOrEqual(1)

  const aNote = doc.body.shapes.find((s: any) => s.kind === 'note')
  const near = await get(`/api/v2/canvas/neighbors?room=${room}&id=${encodeURIComponent(aNote.id)}&radius=300`)
  expect(near.status).toBe(200)
  expect(Array.isArray(near.body.neighbors)).toBe(true)
})
```

**Step 2: Run the e2e project.** This boots the stack; ports 8788/5273 must be
free (stop `bin/dev` first if running — see `e2e/README.md`).

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1/e2e
bunx playwright test --project=e2e -g "canvas-v2"
cd ..
```
Expected: `1 passed`. If the seed helper signature differs from what this spec
assumes, reconcile with the real `e2e/lib/seed.ts` (that file is the source of
truth for the seed API).

**Step 3: Commit**

```bash
git add e2e/tests/canvas-v2.spec.ts
git commit -m "test(e2e): HTTP smoke driving every Agent API v2 read endpoint"
```

---

# Seam F — Integration, root wiring, final verification

## Task F1: Confirm root scripts cover the new packages

**Files:**
- Verify (already edited in A1/A2/E1): root `package.json`.

**Step 1:** Confirm the root `package.json`:
- `workspaces` includes `"canvas-model"` and `"canvas-doc"`.
- `typecheck` chains `bun run --filter '@ensembleworks/canvas-model' typecheck`
  and `… '@ensembleworks/canvas-doc' typecheck`.
- `build` needs NO change (the new packages are typecheck-only, like `contracts`;
  the server bundles them from source).
- `scripts/run-tests.ts` needs NO change (its `**/src/**/*.test.ts` glob already
  discovers the new packages' colocated tests and the new server tests).

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
grep -E 'canvas-model|canvas-doc' package.json
```
Expected: both names appear in `workspaces` and both `typecheck` filters appear.

If anything is missing, add it now and commit:

```bash
git add package.json && git commit -m "chore: ensure root typecheck covers canvas-model + canvas-doc"
```
(If nothing is missing, skip the commit.)

## Task F2: Full-repo verification (with the accepted baseline)

**Step 1: Typecheck everything**

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1
bun run typecheck
```
Expected: exit 0 across all workspaces (contracts, client, server, transcriber,
cli, bin, discord, e2e, canvas-model, canvas-doc).

**Step 2: Run the full suite**

```bash
bun run test 2>&1 | tail -30
```
Expected: every suite passes **except** the single accepted baseline
`server/src/tools-api.test.ts` → `mounted route not declared: GET /api/discord/bindings`.
Confirm the run reached and passed the new suites:
`canvas-model/src/*.test.ts`, `canvas-doc/src/*.test.ts`,
`server/src/canvas-v2/*.test.ts`, `server/src/canvas-v2-api.test.ts`,
`server/src/canvas-v2-semantic.test.ts`.

**Because `run-tests.ts` fails on the FIRST non-zero exit**, the pre-existing
`tools-api.test.ts` failure will halt the run before later suites. Verify the new
suites independently so their green status is proven:

```bash
bun run --filter '@ensembleworks/canvas-model' test
bun run --filter '@ensembleworks/canvas-doc' test
for f in server/src/canvas-v2/*.test.ts server/src/canvas-v2-api.test.ts server/src/canvas-v2-semantic.test.ts; do echo "== $f =="; bun "$f" || exit 1; done
```
Expected: all green.

**Step 3: Confirm the baseline is unchanged** (the failure is still ONLY the
Discord route, nothing this branch introduced):

```bash
bun server/src/tools-api.test.ts 2>&1 | tail -5
```
Expected: the error mentions `GET /api/discord/bindings` and nothing about
`/api/v2/canvas/*` or a tool-count mismatch.

**Step 4: Verify the live editing path is untouched** — grep confirms this branch
added no `updateStore` calls and no client changes:

```bash
git diff --stat main -- client/ | tail -3            # expect: no client files changed
git diff main -- server/src/features/shape.ts server/src/features/sticky.ts | head   # expect: empty (no v1 write-path edits)
```
Expected: no client diff; no diff in the v1 write handlers.

**Step 5: No commit** unless Step 1–4 surfaced a fix.

## Task F3: e2e sanity (optional but recommended before PR)

```bash
export PATH="$HOME/.bun/bin:$PATH"; cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase1/e2e
bunx playwright test --project=e2e -g "canvas-v2"   # 1 passed
cd ..
```
If `bin/dev`/the devcontainer is using :8788/:5273, stop it first (`bin/dev down`
in the main checkout).

---

## Done Criteria (Phase 1 exit)

- [ ] `canvas-model` package builds, typechecks, and its suite is green: ids,
      shape schema (lossless passthrough), document/accessors, invariants
      (orphans/cycles/dangling/props), geometry, neighbors, clustering, semantic
      view. Zero runtime deps but `zod`; no Loro/tldraw/DOM import; no
      `Date.now`/`Math.random`.
- [ ] `canvas-doc` package builds, typechecks, and its suite is green: `CanvasDoc`
      interface + `LoroCanvasDoc` (snapshot round-trip, CRUD, reparent + z-order
      via the movable tree with native cycle rejection, `LoroText`, subscriptions,
      `loadModel`/`dumpModel` bridge). Imports only `canvas-model` + `loro-crdt`
      (pinned `1.13.6`); never imports `server`.
- [ ] Converter (`server/src/canvas-v2/convert.ts`) round-trips tldraw ↔
      `canvas-model` losslessly over the full shape zoo (geo/text/note/arrow/
      frame/line/draw/highlight/image + the 6 custom shapes) **plus bindings**,
      proven against a real seeded room.
- [ ] Agent API v2 read endpoints live and green: `GET /api/v2/canvas/document`,
      `…/frames`, `…/frame`, `…/semantic` (clusters/outliers/relations with
      arrangement, confidence, label), `…/neighbors` — each serving the new model
      via live conversion; declared as `ToolDef`s in `contracts` and discoverable
      via `GET /api/tools`.
- [ ] E2E HTTP smoke drives every v2 endpoint against the real server and passes.
- [ ] `bun run typecheck` green across all workspaces (now including
      `canvas-model` + `canvas-doc`).
- [ ] `bun run test`: the **only** failure is the pre-existing accepted baseline
      `server/src/tools-api.test.ts` → `GET /api/discord/bindings`. All new suites
      verified green independently. The v2 additions did NOT introduce any new
      failure (count bumped to 22; v2 routes declared).
- [ ] No changes to the live editing/write path (`updateStore` handlers) and no
      client UI changes (`git diff` confirms).
- [ ] All work committed on branch `canvas-phase1` in reviewable, seam-aligned
      commits (canvas-model → canvas-doc → converter → API v2 → wiring).

---

## Open questions / risks flagged for the controller (resolve before or during execution)

1. **`/api/v2/canvas/neighbors` scope.** The design names "neighbor queries" as an
   example spatial query but does not commit to a specific endpoint. I included it
   (Task B6 + E3/E5) because it is a trivial wrapper over a tested pure function.
   If the controller wants the leanest Phase 1 surface, drop the neighbors
   *endpoint* (E3's second route + its ToolDef in E1) and keep `neighbors()` as an
   internal model primitive — then the manifest count in E4 is 21, not 22.
2. **Clustering calibration is a knob, not a proof.** The design explicitly says
   "calibration is the hard part, not code." `GAP_K=0.9`, the `0.75` grid-bucket
   factor, and the 50/50 confidence weighting are first-cut defaults chosen to make
   the deterministic tests pass, not tuned against real rooms. Phase 1 ships the
   *mechanism*; tuning against anonymized prod rooms is deferred (design says
   "expose confidence and granularity rather than one true clustering"). Confirm
   the controller accepts unturned defaults for Phase 1.
3. **Converter home = `server`, not a `canvas-*` package.** I placed the converter
   in `server/src/canvas-v2/` to keep the `canvas-*` packages clean-room and
   tldraw-free (design's Electron-readiness rule: "`canvas-*` packages never import
   from server" — and, symmetrically, they should not drag in tldraw). If the
   controller would rather have a standalone `canvas-convert` package (importing
   tldraw + canvas-model), that is a mechanical relocation of Seam D; flag before
   execution.
4. **Loro not on the Phase 1 read path.** API v2 converts straight to the pure
   `CanvasDocument` and runs pure queries; `canvas-doc`/Loro is built and
   unit-tested but not invoked by the server yet (that is Phase 2 sync/shadow
   mode). This is deliberate (simplest correct read path) and matches the design's
   phasing, but means Loro's *server-side* integration is unproven until Phase 2 —
   the isolated `canvas-doc` suite is the only Phase 1 evidence it works under Bun.
5. **`node.data` nested-object storage in Loro.** The `canvas-doc` CRUD stores
   `meta`/`props` as nested objects in a `LoroMap` (Task C2). The smoke test proves
   flat values; if this Loro build rejects nested objects in `.set`, C2's fallback
   (JSON-string the two keys) applies. Called out so a reviewer expects a possible
   one-line serialization workaround there.
6. **`run-tests.ts` halts on the first failure**, so the accepted `tools-api`
   baseline masks later suites in a single `bun run test` run. Task F2 works around
   this by verifying new suites independently. A cleaner fix (make `run-tests.ts`
   continue-on-error and summarize, or quarantine the known-failing suite) is out of
   scope here but worth a follow-up so CI can see the whole board.
7. **`ToolDef.zodOutput` for v2 is loose** (`{ ok: true }.passthrough()`), because
   `contracts` must not depend on `canvas-model` (dependency direction). If the
   controller wants strict, self-documenting v2 output contracts, the response
   types would need to live in (or be mirrored into) `contracts` — a small
   duplication cost flagged for a decision.
