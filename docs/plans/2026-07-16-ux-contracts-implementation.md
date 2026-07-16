# UX Interaction Contracts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the generic "interaction contracts" harness described in
`docs/plans/2026-07-16-ux-contracts-design.md` and use it to fix the five QA
findings on the v2 canvas, in the design's bootstrap order. A contract is a
declaration (name + seeded gesture + invariant expressed against an
observation interface + level + scope). One FSM runner plays it through the
real `canvas-editor` tool FSMs; one browser runner plays the *same*
declaration through Playwright. The contract library is the accumulated UX
knowledge; specific checks come into existence as a byproduct of the pilots.

**Architecture:**
- A new pure, dependency-free workspace `@ensembleworks/interaction-contracts`
  (directory `interaction-contracts/`) holds the contract *types*, the seeded
  PRNG, the gesture-op vocabulary, the `Obs` observation interface, and the
  contract *declarations*. It imports nothing (see "Contracts-module
  placement" below).
- The **FSM runner** lives in `canvas-editor/src/contracts/` beside the
  `script()` rig. It resolves a declaration's gesture into `InputEvent[]`,
  drives a real `Editor` + tool FSM through `run()`, and evaluates the
  invariant against an FSM-backed `Obs` adapter — after every event
  (`when: 'every-event'`) or once at the end (`when: 'at-end'`).
- The **browser runner** lives in `e2e/lib/contracts.ts` beside the parity
  harness. It interprets the same gesture ops as real Playwright
  pointer/wheel/keyboard input against a live `?engine=v2` room, samples the
  invariant per animation frame, and evaluates it against a page-backed `Obs`
  adapter. It is built only when Pilot 3 forces it.
- A CI **presence check** (`scripts/ux-contract-presence.test.ts`, in the
  `exposure-audit.ts` family) fails a diff that touches interaction-bearing
  paths without touching the contracts module or carrying a
  `ux-contract: none — <reason>` marker.

**Tech Stack:** Bun workspaces; TypeScript (`nodenext` in the clean-room
packages, `bundler` in e2e). Tests are **self-executing `node:assert`
scripts** run as `bun <file>` — *not* `bun:test`. Playwright for the browser
lane (`@playwright/test`, project `e2e`). loro-crdt behind `canvas-doc`.

---

## Contracts-module placement (decision — read before Phase A)

A `contracts/` workspace **already exists** (`@ensembleworks/contracts`) but it
is the *terminal/session/tool* contracts module and it depends on `zod` and
`@tldraw/validate`. It is **not** a candidate: the design requires a module
that "imports nothing", and reusing this one would pull `@tldraw/validate` into
`canvas-editor`'s dependency graph — exactly what the clean-room rule exists to
prevent. (The text-scan `boundary.test.ts` would not *catch* a transitive dep,
but the design's intent is a genuinely pure module, not one that merely dodges
the regex.)

`canvas-model` was also considered and rejected: it is scoped to "pure typed
canvas model" geometry and carries a `zod` dep; adding interaction-contract
vocabulary there muddies its single responsibility, and having e2e import
`@ensembleworks/canvas-model` just to reach the contracts would drag in the
whole geometry surface.

**Decision: a new zero-dependency workspace `@ensembleworks/interaction-contracts`.**
- It is importable identically by `canvas-editor` (`nodenext`, via the package
  `exports` map — the same mechanism it already uses for
  `@ensembleworks/canvas-model`) and by `e2e` (`bundler` resolution). Verified:
  e2e currently imports **no** `@ensembleworks/*` package at the Node level, so
  adding one is a new-but-clean dependency, resolved via the workspace
  `exports` map.
- Its `src/**/*.test.ts` is auto-discovered by `scripts/run-tests.ts`'s
  existing `**/src/**/*.test.ts` glob — no runner change.
- `canvas-editor/src/boundary.test.ts` forbids specific packages by name
  (`loro-crdt`, `ws`, `@tldraw/`, `react`, `canvas-sync`, `server`) plus DOM
  globals and wall-clock/PRNG reads. `@ensembleworks/interaction-contracts` is
  not forbidden and, being pure/zero-dep, introduces no forbidden transitive
  import. The FSM runner (a non-test `src` file) is scanned by that test and
  must stay clean — it uses the injected clock/PRNG, never `Date.now`/
  `Math.random`.

---

## Toolchain gotchas (read once; they will bite otherwise)

> **`bun test` ≠ `bun run test`.** `bun test` invokes Bun's built-in Jest-like
> runner, which this repo does **not** use and which will misbehave on the
> self-executing assert scripts. Always use **`bun run test`** (repo-wide, →
> `bun scripts/run-tests.ts`) or a per-workspace **`bun test.ts`** /
> `bun run --filter '<pkg>' test`.
>
> **Run one test file:** `bun <path>.test.ts` from the repo root, e.g.
> `bun canvas-editor/src/camera.test.ts`. Verified working (exit 0). Each test
> file is a standalone script with relative `./x.js` imports that Bun resolves
> to `.ts`.
>
> **Clean-room boundary tests will fail on a bad import.**
> `canvas-editor/src/boundary.test.ts` and `canvas-sync/src/boundary.test.ts`
> raw-text-scan every non-test `src` file for forbidden import spellings **and
> forbidden spellings inside comments** (no comment stripping). If you write
> `@tldraw/` or `Date.now(` or `Math.random(` or `document.` or `window.`
> anywhere in a scanned file — even a comment — the boundary test fails. Phrase
> around it, as the existing headers do.
>
> **`camera.test.ts` pins the OLD (inverted) scroll convention.** Its case 4
> asserts `applyWheel(...) === { x: 3, y: 2, z: 2 }` for a wheel that pans
> `camera + delta/z`. Pilot 1 (Phase B) flips that sign; **updating those
> pinned cases is part of Phase B**, not a regression. Do not "fix" the test
> back.
>
> **`bunx tsc` needs the workspace linked first.** After adding the new
> workspace or a new dependency edge, run `bun install` from the repo root so
> the `@ensembleworks/interaction-contracts` symlink exists in `node_modules`
> before `bun run typecheck`.
>
> **CLAUDE.md is a symlink** (`ls -l CLAUDE.md` shows it points into the
> `.claude` tree). Edit the file through its path as normal; just be aware an
> editor "new file" would break the link.

---

## Phase ordering and checkpoints

Phase A (substrate) → B (scroll) → C (cursor-lock) → D (cross-widget
selection, builds the browser runner) → E (drag-while-typing) → F (editing
lock) → G (process wiring). **After each pilot phase (B–F) there is an explicit
STOP checkpoint** — the orchestrating session runs a trustability assessment
before the next phase begins. Implementers halt at those blocks.

Task counts: Phase A = 6, B = 6, C = 7, D = 8, E = 5, F = 8, G = 6. Total = 46
tasks across 7 phases, plus 5 checkpoint STOP blocks.

---

# Phase A — Minimal substrate (no browser runner yet)

Build the pure contracts module (types, seeded PRNG, gesture ops, `Obs`
interface, registry) and the FSM runner. Prove the runner mechanics with a
throwaway inline contract in the runner's own test; the first *library*
contract lands in Phase B. **YAGNI:** no browser runner, no shape-anchor
resolution, no multi-actor vocabulary yet — pilots 2/3/5 add those.

### Task A1 — Create the `interaction-contracts` workspace skeleton

**Files:**
- Create: `interaction-contracts/package.json`
- Create: `interaction-contracts/tsconfig.json`
- Modify: `package.json` (repo root) — `workspaces` array + `typecheck` script

1. Write `interaction-contracts/package.json`:

```json
{
  "name": "@ensembleworks/interaction-contracts",
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
  "devDependencies": {
    "@types/node": "^22.0.0",
    "bun-types": "1.3.14",
    "typescript": "^5.7.0"
  }
}
```

2. Write `interaction-contracts/tsconfig.json` (copy `canvas-model/tsconfig.json`'s shape):

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

3. In the repo-root `package.json`, add `"interaction-contracts"` to the
   `workspaces` array (put it right after `"contracts"`), and add its typecheck
   to the `typecheck` script chain — insert
   `bun run --filter '@ensembleworks/interaction-contracts' typecheck && `
   immediately after the `@ensembleworks/contracts` typecheck and before
   `@ensembleworks/canvas-model`.

4. Create `interaction-contracts/test.ts` by copying `canvas-model/test.ts`
   verbatim (the per-package discovery runner — globs `src/**/*.test.ts`).

5. Run: `bun install`
   Expect: completes without error; `node_modules/@ensembleworks/interaction-contracts` symlink now exists (`ls -l node_modules/@ensembleworks/ | grep interaction-contracts`).

6. **Commit:** `git add interaction-contracts package.json bun.lock && git commit -m "feat(interaction-contracts): empty workspace skeleton"`

### Task A2 — Seeded PRNG + gesture-op vocabulary + Obs interface (types)

**Files:**
- Create: `interaction-contracts/src/types.ts`

1. Write `interaction-contracts/src/types.ts`. This file **imports nothing**
   (purity rule). Match the repo's heavy-comment house style; the essentials:

```ts
// The pure contract vocabulary — imports NOTHING (the design's "one pure,
// dependency-free module both runners import"). Everything a contract
// declaration needs (PRNG, gesture ops, the observation interface) is defined
// here structurally, so canvas-editor's FSM runner and e2e's browser runner
// both compile against the SAME types without either package leaking into the
// other.

/** A deterministic uniform [0,1) source. Seeded so one declaration yields a
 * fixed CI smoke case and a reproducible fuzz campaign. */
export interface Rng {
  next(): number
}

/** mulberry32 — a tiny, well-known, fully deterministic PRNG. Pure integer
 * math; no wall clock, no Math.random (this module is imported by the
 * clean-room FSM runner, whose boundary test forbids both). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return {
    next(): number {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** Structural modifiers (NOT imported from canvas-editor — purity). */
export interface GestureModifiers {
  readonly shift?: boolean
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
}

/** A screen-space anchor a gesture op resolves against. Phase A ships only the
 * absolute point form; Pilot 2 (Phase C) extends this union with a shape
 * anchor (the library grows per unit — design's bootstrap principle). */
export type Anchor = { readonly ref: 'point'; readonly x: number; readonly y: number }

/** One primitive gesture step. SCREEN space, exactly like input.ts's
 * InputEvent coordinates — the FSM runner turns these into InputEvents via
 * script.ts, the browser runner into Playwright input. */
export type GestureOp =
  | { readonly kind: 'down'; readonly at: Anchor; readonly modifiers?: GestureModifiers }
  | { readonly kind: 'move'; readonly at: Anchor; readonly steps?: number; readonly modifiers?: GestureModifiers }
  | { readonly kind: 'up'; readonly modifiers?: GestureModifiers }
  | { readonly kind: 'wheel'; readonly dx: number; readonly dy: number; readonly at: Anchor; readonly modifiers?: GestureModifiers }
  | { readonly kind: 'key'; readonly key: string; readonly modifiers?: GestureModifiers }

/** The scene a contract wants seeded before its gesture runs. Phase A ships an
 * empty scene (pilot 1 needs no shapes); Pilot 2 adds shapes. Runner-agnostic:
 * the FSM runner seeds the doc directly, the browser runner seeds via
 * window.__ew.doc.putShape (lib/canvas-v2.ts's seedGrid pattern). */
export interface SceneShape {
  readonly id: string
  readonly kind: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The observation interface — the ONLY thing invariants may read. Grows one
 * method per pilot; Phase A ships just what Pilot 1 needs. Never expose FSM
 * internals or DOM nodes here — that is what lets one declaration run at either
 * level. */
export interface Obs {
  /** The world-space rectangle currently visible in the viewport. Pilot 1. */
  visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number }
}

/** A contract declaration = data. */
export interface Contract {
  readonly name: string
  readonly level: 'fsm' | 'browser'
  readonly when: 'every-event' | 'at-end'
  /** Optional: instantiate once per registered shape kind (design's per-kind
   * conformance-suite subsumption). Unused until a later unit needs it. */
  readonly scope?: 'per-kind'
  /** Shapes to seed before the gesture. Default: none. */
  scene?(): readonly SceneShape[]
  /** Build the gesture ops from a seeded RNG — deterministic per seed. */
  gesture(rng: Rng): readonly GestureOp[]
  /** Return null if the observation satisfies the contract, or a human failure
   * message. Evaluated after every event (when === 'every-event') or once
   * after the last (at-end). Returning a message (not throwing) keeps the
   * declaration data-shaped and lets the runner attach the seed for repro. */
  check(obs: Obs): string | null
}
```

2. Run: `bun install >/dev/null 2>&1; bun run --filter '@ensembleworks/interaction-contracts' typecheck`
   Expect: no output / no error (tsc clean).

3. **Commit:** `git add interaction-contracts/src/types.ts && git commit -m "feat(interaction-contracts): contract types, seeded PRNG, gesture ops, Obs"`

### Task A3 — The registry (index) + a unit test for the PRNG

**Files:**
- Create: `interaction-contracts/src/index.ts`
- Create: `interaction-contracts/src/types.test.ts`

1. Write `interaction-contracts/src/index.ts`:

```ts
// Public surface of the pure contracts module. Re-exports the vocabulary and
// aggregates every registered contract into ONE array both runners iterate.
// Registration = adding a declaration to CONTRACTS below (no mutable global —
// the array is the registry). Pilots append their declarations here.
export * from './types.js'
import type { Contract } from './types.js'

export const CONTRACTS: readonly Contract[] = [
  // Pilot declarations are added here, one per phase (B–F).
]
```

2. Write `interaction-contracts/src/types.test.ts` (self-executing assert
   script — copy the `// Run:` header idiom from any existing `.test.ts`):

```ts
// Run: bun src/types.test.ts
import assert from 'node:assert/strict'
import { mulberry32 } from './types.js'

// Determinism: same seed -> identical stream.
{
  const a = mulberry32(42)
  const b = mulberry32(42)
  const seqA = [a.next(), a.next(), a.next()]
  const seqB = [b.next(), b.next(), b.next()]
  assert.deepEqual(seqA, seqB, 'same seed produces the same stream')
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `value ${v} is in [0,1)`)
  console.log('ok: mulberry32 is deterministic and in-range')
}

// Different seeds diverge (a smoke check, not a statistical claim).
{
  assert.notEqual(mulberry32(1).next(), mulberry32(2).next(), 'different seeds diverge')
  console.log('ok: mulberry32 seeds diverge')
}
```

3. Run: `bun interaction-contracts/src/types.test.ts`
   Expect: `ok: mulberry32 is deterministic and in-range` then `ok: mulberry32 seeds diverge`, exit 0.

4. **Commit:** `git add interaction-contracts/src/index.ts interaction-contracts/src/types.test.ts && git commit -m "feat(interaction-contracts): registry aggregate + PRNG determinism test"`

### Task A4 — Wire the new workspace into `canvas-editor` and add the runner dir

**Files:**
- Modify: `canvas-editor/package.json` — add dependency
- Create: `canvas-editor/src/contracts/` (directory via the first file below)

1. In `canvas-editor/package.json`, add to `dependencies`:
   `"@ensembleworks/interaction-contracts": "*"` (keep alphabetical-ish with the
   other `@ensembleworks/*` deps).

2. Run: `bun install`
   Expect: succeeds; the dependency edge is now linked.

3. Run: `bun canvas-editor/src/boundary.test.ts`
   Expect: `ok: boundary (scanned N file(s): ...)` — confirms adding the dep did
   **not** trip the clean-room scan (nothing new is imported in `src` yet).

4. **Commit:** `git add canvas-editor/package.json bun.lock && git commit -m "chore(canvas-editor): depend on interaction-contracts"`

### Task A5 — The FSM runner

**Files:**
- Create: `canvas-editor/src/contracts/fsm-runner.ts`

1. Write `canvas-editor/src/contracts/fsm-runner.ts`. It is a **non-test `src`
   file → scanned by `boundary.test.ts`** — keep it clean (no `Date.now`,
   `Math.random`, `document.`, `window.`, `@tldraw/`; note in comments phrased
   to avoid those literal spellings). Complete code:

```ts
// The FSM runner: play a contract's seeded gesture through a REAL Editor + the
// select tool's FSM (via script.ts's run()), evaluating the invariant against
// an FSM-backed Obs adapter after every event (when: 'every-event') or once at
// the end (when: 'at-end'). Deterministic: the injected clock is fixed and the
// injected id source is the same seeded PRNG the gesture uses, so a failing
// seed reproduces exactly. Mirrors the design's "FSM runner beside the script()
// rig". The browser runner (e2e) interprets the SAME GestureOp[].
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import type { Shape } from '@ensembleworks/canvas-model'
import type { Anchor, Contract, GestureOp, Obs, Rng } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { Editor } from '../editor.js'
import type { InputEvent, Modifiers } from '../input.js'
import { screenToWorld } from '../input.js'
import { run, script } from '../script.js'
import { createSelectTool } from '../tools/select.js'
import { createToolContext } from '../tools/tool-context.js'

// A fixed viewport for FSM-level visibility observations. The browser runner
// reads the real viewport box instead; both must agree on the CONVENTION
// (screenToWorld of the four corners), not the exact pixel size.
const FSM_VIEWPORT = { w: 1280, h: 720 } as const

const NEUTRAL: Modifiers = { shift: false, alt: false, ctrl: false, meta: false }
function mods(over?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }): Partial<Modifiers> {
  return { ...over }
}

function resolveAnchor(a: Anchor): { x: number; y: number } {
  // Phase A: only the absolute point form exists. Pilot 2 (Phase C) extends
  // this to resolve a shape anchor via worldToScreen(editor.get().camera, ...).
  return { x: a.x, y: a.y }
}

/** Turn the abstract gesture ops into a concrete InputEvent[] via script.ts's
 * builder (which stamps deterministic timestamps). */
function opsToEvents(ops: readonly GestureOp[]): InputEvent[] {
  const b = script()
  for (const op of ops) {
    switch (op.kind) {
      case 'down': { const p = resolveAnchor(op.at); b.down(p.x, p.y, { modifiers: mods(op.modifiers) }); break }
      case 'move': { const p = resolveAnchor(op.at); b.move(p.x, p.y, { steps: op.steps ?? 0, modifiers: mods(op.modifiers) }); break }
      case 'up': { b.up({ modifiers: mods(op.modifiers) }); break }
      case 'wheel': { const p = resolveAnchor(op.at); b.wheel(op.dx, op.dy, { at: [p.x, p.y], modifiers: mods(op.modifiers) }); break }
      case 'key': { b.key(op.key, { modifiers: mods(op.modifiers) }); break }
    }
  }
  return b.events()
}

function makeObs(editor: Editor): Obs {
  return {
    visibleWorldRect() {
      const cam = editor.get().camera
      const tl = screenToWorld(cam, { x: 0, y: 0 })
      const br = screenToWorld(cam, { x: FSM_VIEWPORT.w, y: FSM_VIEWPORT.h })
      return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
    },
  }
}

function seedScene(doc: LoroCanvasDoc, contract: Contract): void {
  doc.putPage({ id: 'page:p', name: 'P' })
  for (const s of contract.scene?.() ?? []) {
    doc.putShape({
      id: s.id, kind: s.kind, parentId: 'page:p', index: 'a1',
      x: s.x, y: s.y, rotation: 0, isLocked: false, opacity: 1, meta: {},
      props: { w: s.w, h: s.h },
    } as Shape)
  }
  doc.commit()
}

export interface FsmRunResult {
  readonly contract: string
  readonly seed: number
  readonly failure: string | null
}

/** Run one contract at one seed through the FSM. Returns the first invariant
 * failure (with the seed for repro) or null. */
export function runContractFsm(contract: Contract, seed: number): FsmRunResult {
  const rng: Rng = mulberry32(seed)
  const doc = LoroCanvasDoc.create({ peerId: 1n })
  seedScene(doc, contract)
  // Injected clock/PRNG: fixed clock, and an id source derived from a SECOND
  // seeded stream so run() stays deterministic without consuming the gesture's
  // own rng draws.
  const idRng = mulberry32(seed ^ 0x9e3779b9)
  const editor = new Editor({ doc, now: () => 0, random: () => idRng.next(), pageId: 'page:p' })
  const ctx = createToolContext(editor)
  const tool = createSelectTool(ctx)
  const obs = makeObs(editor)

  const events = opsToEvents(contract.gesture(rng))
  let state = tool.initialState
  for (const event of events) {
    const result = tool.onEvent(state, event)
    state = result.state
    if (result.intents.length > 0) editor.applyAll(result.intents)
    // Wheel events are NOT consumed by the select tool (it ignores them) — the
    // runner applies the camera policy itself so a scroll contract observes a
    // camera change, mirroring CanvasV2App.handleInput's wheel branch.
    if (event.type === 'wheel') {
      const { applyWheel } = require('../camera.js')
      const next = applyWheel(editor.get().camera, event)
      editor.apply({ type: 'SetCamera', ...next })
    }
    if (contract.when === 'every-event') {
      const failure = contract.check(obs)
      if (failure) return { contract: contract.name, seed, failure }
    }
  }
  if (contract.when === 'at-end') {
    const failure = contract.check(obs)
    if (failure) return { contract: contract.name, seed, failure }
  }
  return { contract: contract.name, seed, failure: null }
}
```

   NOTE on the `require('../camera.js')` line: the boundary test forbids
   `require(` **with a forbidden package name** — `forbiddenImport('loro-crdt')`
   etc. build `(?:from|require\(|import\(|import\s)\s*['"]<pkg>['"]`. A local
   `require('../camera.js')` is a *relative* path, not a forbidden package, so
   it does **not** match any `FORBIDDEN` entry. But prefer a top-level
   `import { applyWheel } from '../camera.js'` instead to avoid CommonJS in an
   ESM file — **do that**: add `import { applyWheel } from '../camera.js'` at
   the top and delete the inline `require`. (Written inline above only to flag
   the wheel-policy seam; the clean form is the static import.)

2. Run: `bun canvas-editor/src/boundary.test.ts`
   Expect: `ok: boundary (scanned N file(s): ...)` with N increased by 1
   (fsm-runner.ts now scanned and clean). If it fails, you left a forbidden
   spelling — fix it.

3. Run: `bun run --filter '@ensembleworks/canvas-editor' typecheck`
   Expect: tsc clean (no output).

4. **Commit:** `git add canvas-editor/src/contracts/fsm-runner.ts && git commit -m "feat(canvas-editor): FSM contract runner"`

### Task A6 — Runner test with a throwaway inline contract (prove mechanics)

**Files:**
- Create: `canvas-editor/src/contracts/fsm-runner.test.ts`

1. Write `canvas-editor/src/contracts/fsm-runner.test.ts` — proves (a) a passing
   contract returns `failure: null`, (b) a deliberately-wrong contract returns a
   failure carrying the seed, (c) determinism (same seed → same verdict). Uses
   an **inline** throwaway contract so no library entry is needed yet:

```ts
// Run: bun src/contracts/fsm-runner.test.ts
import assert from 'node:assert/strict'
import type { Contract } from '@ensembleworks/interaction-contracts'
import { runContractFsm } from './fsm-runner.js'

// A contract that always holds: after a plain wheel, the visible world rect is
// a well-formed rectangle (minX < maxX). Proves the runner drives events,
// applies the wheel camera policy, and evaluates the invariant.
const alwaysHolds: Contract = {
  name: 'smoke-visible-rect-wellformed',
  level: 'fsm',
  when: 'every-event',
  gesture: () => [{ kind: 'wheel', dx: 0, dy: 50, at: { ref: 'point', x: 100, y: 100 } }],
  check: (obs) => {
    const r = obs.visibleWorldRect()
    return r.maxX > r.minX && r.maxY > r.minY ? null : `degenerate rect ${JSON.stringify(r)}`
  },
}

// A contract that always fails: asserts an impossible visible rect.
const alwaysFails: Contract = {
  ...alwaysHolds,
  name: 'smoke-impossible',
  check: () => 'deliberate failure',
}

{
  const r = runContractFsm(alwaysHolds, 1)
  assert.equal(r.failure, null, 'a holding contract passes')
  console.log('ok: FSM runner reports a passing contract')
}
{
  const r = runContractFsm(alwaysFails, 7)
  assert.equal(r.failure, 'deliberate failure', 'a failing contract surfaces its message')
  assert.equal(r.seed, 7, 'the failing seed is attached for repro')
  console.log('ok: FSM runner reports a failing contract with its seed')
}
{
  const a = runContractFsm(alwaysHolds, 123)
  const b = runContractFsm(alwaysHolds, 123)
  assert.deepEqual(a, b, 'same seed -> same verdict (determinism)')
  console.log('ok: FSM runner is deterministic per seed')
}
```

2. Run: `bun canvas-editor/src/contracts/fsm-runner.test.ts`
   Expect: three `ok:` lines, exit 0.

3. Run the whole editor suite to confirm nothing regressed:
   `bun run --filter '@ensembleworks/canvas-editor' test`
   Expect: `all N suites passed`.

4. **Commit:** `git add canvas-editor/src/contracts/fsm-runner.test.ts && git commit -m "test(canvas-editor): FSM runner mechanics (pass/fail/determinism)"`

**STOP — session owner runs a trustability assessment before Phase B begins.**
The substrate now exists and is proven mechanically. Before writing the first
real contract, confirm: the runner drives real FSMs (not a mock), the invariant
is evaluated per event, and the seed reproduces a failure.

---

# Phase B — Pilot 1: scroll-direction contract

Semantic invariant: **"wheel-down reveals content below."** Currently
`applyWheel` pans `camera + delta/z`; with `screen = (world + camera)·z`,
wheel-down (positive `dy`) *raises* the visible world top → reveals content
*above* → inverted. Fix: flip the pan sign. Then update `camera.test.ts`'s
pinned case.

### Task B1 — Write the failing scroll contract (declaration)

**Files:**
- Create: `interaction-contracts/src/contracts/scroll-direction.ts`
- Modify: `interaction-contracts/src/index.ts` — register it

1. Write `interaction-contracts/src/contracts/scroll-direction.ts`:

```ts
// Pilot 1 — the scroll-direction contract. A wheel-down gesture (positive DOM
// deltaY, input.ts's SIGN CONVENTION) must REVEAL CONTENT BELOW: the top edge
// of the visible world rectangle moves DOWN in world space (its minY
// increases). This is the user-meaningful semantics, independent of the camera
// formula's internals.
import type { Contract, Obs, Rng } from '../types.js'

let beforeMinY = Number.NaN

export const scrollDirection: Contract = {
  name: 'scroll-direction-reveals-below',
  level: 'fsm',
  when: 'every-event',
  gesture: (_rng: Rng) => [
    // A single wheel-DOWN tick at the viewport centre. (Seeding the magnitude
    // is a Pilot-2 concern; direction is all pilot 1 needs.)
    { kind: 'wheel', dx: 0, dy: 100, at: { ref: 'point', x: 640, y: 360 } },
  ],
  check: (obs: Obs): string | null => {
    const r = obs.visibleWorldRect()
    // First observation is the pre-wheel baseline (the runner evaluates AFTER
    // each event; with a one-event gesture we compare against the initial
    // camera by capturing here). Capture-then-compare within a single run:
    if (Number.isNaN(beforeMinY)) { beforeMinY = r.minY; return null }
    return r.minY > beforeMinY
      ? null
      : `wheel-down did not reveal content below: visible top minY went ${beforeMinY} -> ${r.minY} (expected to INCREASE)`
  },
}
```

   > **Reviewer note for the implementer:** the module-level `beforeMinY` is a
   > code smell (a stateful declaration is not "data"). It works for a
   > one-event gesture but is not reusable. **Do not ship it.** Instead, give
   > the gesture two events — an initial no-op `move` to the anchor to capture
   > the baseline, then the wheel — OR (cleaner) add a `before`/`after` pair to
   > the runner. The simplest clean form: make the gesture
   > `[{move to centre}, {wheel down}]` and have `check` compare the CURRENT
   > `visibleWorldRect` against the camera-at-origin baseline the runner
   > exposes. **Chosen clean form for this plan:** extend `Obs` in Task B2 with
   > `visibleWorldRectAtStart()` (captured by the runner before any event), so
   > `check` is pure: `return after.minY > start.minY ? null : '...'`. Rewrite
   > this file to use that, deleting the module-level variable.

2. In `interaction-contracts/src/index.ts`, import `scrollDirection` and add it
   to `CONTRACTS`.

3. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck`
   Expect: FAILS — `visibleWorldRectAtStart` is not yet on `Obs`. That failure
   is the cue to do Task B2 first. (If you kept the smelly module-level form,
   typecheck passes but you owe the rewrite — do B2 regardless.)

### Task B2 — Extend `Obs` with a start-baseline; implement in the FSM adapter

**Files:**
- Modify: `interaction-contracts/src/types.ts` — add method to `Obs`
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` — implement it
- Modify: `interaction-contracts/src/contracts/scroll-direction.ts` — use it

1. In `types.ts`, add to the `Obs` interface:

```ts
  /** The visible world rect captured ONCE before the gesture's first event —
   * the baseline a "did this gesture move the view?" invariant compares
   * against. Runner-provided; both adapters snapshot it at start. */
  visibleWorldRectAtStart(): { minX: number; minY: number; maxX: number; maxY: number }
```

2. In `fsm-runner.ts`, in `makeObs`, capture the start rect before the event
   loop and return it. Change `makeObs(editor)` to `makeObs(editor, startRect)`
   where `startRect` is computed in `runContractFsm` (via a temporary `Obs`
   built pre-loop, or inline the four-corner math). Concretely: compute
   `const startRect = { ... }` from the initial camera right after constructing
   `editor`, pass it in, and implement `visibleWorldRectAtStart: () => startRect`.

3. Rewrite `scroll-direction.ts`'s `check` to the pure form and delete the
   module-level `beforeMinY`:

```ts
  check: (obs: Obs): string | null => {
    const start = obs.visibleWorldRectAtStart()
    const now = obs.visibleWorldRect()
    return now.minY > start.minY
      ? null
      : `wheel-down did not reveal content below: visible top minY ${start.minY} -> ${now.minY} (expected to INCREASE)`
  },
```

4. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck`
   then `bun run --filter '@ensembleworks/canvas-editor' typecheck`
   Expect: both clean.

5. **Commit:** `git add interaction-contracts canvas-editor/src/contracts/fsm-runner.ts && git commit -m "feat(interaction-contracts): scroll-direction contract + start-baseline obs"`

### Task B3 — Run the contract RED against current code

**Files:**
- Create: `canvas-editor/src/contracts/library.test.ts`

1. Write `canvas-editor/src/contracts/library.test.ts` — iterates every
   `fsm`-level contract in `CONTRACTS` at a fixed seed set and asserts each
   passes. This is the standing FSM-lane gate the library grows into:

```ts
// Run: bun src/contracts/library.test.ts
// The FSM lane: every level:'fsm' contract in the library must hold across a
// fixed seed set. Seeds are deterministic; a failure prints the contract name
// + seed for exact repro.
import assert from 'node:assert/strict'
import { CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractFsm } from './fsm-runner.js'

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]
let ran = 0
for (const contract of CONTRACTS.filter((c) => c.level === 'fsm')) {
  for (const seed of SEEDS) {
    const r = runContractFsm(contract, seed)
    assert.equal(r.failure, null, `contract '${r.contract}' violated at seed ${r.seed}: ${r.failure}`)
    ran++
  }
}
console.log(`ok: ${ran} fsm-contract runs held (${CONTRACTS.filter((c) => c.level === 'fsm').length} contract(s) x ${SEEDS.length} seeds)`)
```

2. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **FAIL** — assertion error like `contract
   'scroll-direction-reveals-below' violated at seed 1: wheel-down did not
   reveal content below: visible top minY 0 -> -50 (expected to INCREASE)`.
   This is the red that pins the bug.

3. Do **not** commit a failing test as green. Proceed to the fix.

### Task B4 — Fix the pan sign in `applyWheel`

**Files:**
- Modify: `canvas-editor/src/camera.ts` (~line 126, the pan return)

1. In `camera.ts`'s `applyWheel`, change the plain-wheel pan return from
   `camera.x + (event.dx * PAN_SPEED) / camera.z` /
   `camera.y + (event.dy * PAN_SPEED) / camera.z` to **subtract**:

```ts
  return { x: camera.x - (event.dx * PAN_SPEED) / camera.z, y: camera.y - (event.dy * PAN_SPEED) / camera.z, z: camera.z }
```

2. Update the surrounding comment (the block above `applyWheel` and the inline
   `PLAIN wheel pans` note) to state the corrected semantics: "a plain
   wheel-down (positive DOM `dy`) DECREASES `camera.y`, which raises the visible
   world's top edge — i.e. reveals content BELOW, matching the OS scroll
   convention. Pinned by interaction-contracts' scroll-direction contract."
   Do not leave a forbidden spelling in the comment.

3. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **PASS** — `ok: N fsm-contract runs held (...)`.

### Task B5 — Update `camera.test.ts`'s pinned (old-convention) cases

**Files:**
- Modify: `canvas-editor/src/camera.test.ts` (case 4, ~line 76)

1. `applyWheel({x:0,y:0,z:2}, {dx:6,dy:4,...})` now returns `{x:-3,y:-2,z:2}`
   (was `{x:3,y:2,z:2}`). Change the assertion:

```ts
  assert.deepEqual(panned, { x: -3, y: -2, z: 2 }, 'plain wheel pans by dx/dy divided by z (subtracted — wheel-down reveals content below), z unchanged')
```

2. Scan the rest of `camera.test.ts` for any other pan-sign assumption (the
   zoom cases use `zoomAboutPoint`/`ctrl`/`meta` and are unaffected; the poison
   guard cases assert `deepEqual(..., camera)` no-ops and are unaffected).
   Confirm by reading — only case 4 pins the pan sign.

3. Run: `bun canvas-editor/src/camera.test.ts`
   Expect: all `ok:` lines including `ok: camera math (...)`, exit 0.

4. Run the full editor suite: `bun run --filter '@ensembleworks/canvas-editor' test`
   Expect: `all N suites passed`.

### Task B6 — Full typecheck + commit the pilot-1 fix

**Files:** none (verification + commit)

1. Run: `bun run typecheck`
   Expect: clean across all workspaces (this also proves the new workspace is in
   the chain).

2. Run: `bun run test`
   Expect: `all N suites passed` (repo-wide; includes the new
   `interaction-contracts` and `canvas-editor/src/contracts` suites, and
   `scripts/*.test.ts`).

3. **Commit:** `git add canvas-editor/src/camera.ts canvas-editor/src/camera.test.ts canvas-editor/src/contracts/library.test.ts && git commit -m "fix(canvas-editor): wheel-down reveals content below (pilot 1); pin via scroll-direction contract"`

**STOP — session owner runs a trustability assessment before Phase C begins.**
Confirm: the contract ran RED against the real bug (Task B3 output captured),
GREEN after the one-line fix, and the old pinned test was corrected (not
worked around).

---

# Phase C — Pilot 2: cursor-lock contract (seeded fuzz)

The fuzz generator earns its keep. Two mechanisms cause the observed drift
(design finding 5): (a) per-move snap offsets accumulate because the delta is
incremental from `lastScreen` and re-snapped each move; (b) a mid-drag camera
change reinterprets the stored **screen** anchor under the new camera. Fix:
port the translate path to `transform.ts`'s **absolute-anchor** pattern — carry
the grab point in **world** space, recompute the shape's total displacement
absolutely each move, snap the absolute target, and emit only the incremental
step. World-anchoring inherently re-anchors on camera change, so no separate
`SetCamera` gate is needed (YAGNI).

**Invariants** (both against `Obs`):
- **Unsnapped:** `shapeDisplacement(id) ≡ cursorWorldDisplacement()` (exact).
- **Snapped:** `|shapeDisplacement(id) − cursorWorldDisplacement()| ≤ snapRadius`.

### Task C1 — Extend the vocabulary: shape anchors, `moveBy`, and the drag Obs

**Files:**
- Modify: `interaction-contracts/src/types.ts` — extend `Anchor`; add `Obs` methods
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` — resolve shape anchors; implement new Obs

1. In `types.ts`, extend `Anchor`:

```ts
export type Anchor =
  | { readonly ref: 'point'; readonly x: number; readonly y: number }
  /** A seeded shape's centre, plus an optional SCREEN-space offset. The FSM
   * runner resolves this via worldToScreen(camera, centre); the browser runner
   * via the element's bounding box. */
  | { readonly ref: 'shape'; readonly id: string; readonly dx?: number; readonly dy?: number }
```

2. In `types.ts`, add to `Obs`:

```ts
  /** Total world-space displacement of a shape from the gesture's start. */
  shapeDisplacement(id: string): { dx: number; dy: number }
  /** Total world-space displacement of the cursor from the gesture's start
   * (last pointer position, mapped through the CURRENT camera minus the
   * grab-time world point). */
  cursorWorldDisplacement(): { dx: number; dy: number }
  /** The snap threshold radius in world units at the current scene's median
   * shape size — the tolerance the snapped invariant compares against. */
  snapRadius(): number
```

3. In `fsm-runner.ts`:
   - `resolveAnchor` gains editor access. For `ref: 'shape'`, compute the
     shape's world centre from `editor.doc.getShape(id)` +
     `worldBounds`/`localBounds`, then `worldToScreen(editor.get().camera,
     centre)` and add `dx/dy`. Import `worldToScreen` from `../input.js` and
     `worldBounds` from `@ensembleworks/canvas-model`.
   - Track the grab world point and start shape positions: capture each seeded
     shape's start `{x,y}` before the loop; capture the cursor's grab world
     point at the first `down` (screenToWorld at that event). Implement
     `shapeDisplacement(id)` = current shape `{x,y}` − start `{x,y}`;
     `cursorWorldDisplacement()` = screenToWorld(currentCamera, lastPointer) −
     grabWorld; `snapRadius()` = `medianSize / 5` (match snapping.ts's
     threshold — read the constant from `@ensembleworks/canvas-model`'s
     snapping module; if not exported, compute `medianSize/5` and cite
     select.ts's `medianSize` note). Track `lastPointer` from the most recent
     pointer event in the loop.

4. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck && bun run --filter '@ensembleworks/canvas-editor' typecheck`
   Expect: clean.

5. Run: `bun canvas-editor/src/boundary.test.ts`
   Expect: still `ok: boundary` (no forbidden spellings introduced).

6. **Commit:** `git add interaction-contracts/src/types.ts canvas-editor/src/contracts/fsm-runner.ts && git commit -m "feat(interaction-contracts): shape anchors + drag observations"`

### Task C2 — Write the cursor-lock contract with the audit's drift repro

**Files:**
- Create: `interaction-contracts/src/contracts/cursor-lock.ts`
- Modify: `interaction-contracts/src/index.ts` — register it

1. Write `cursor-lock.ts`. The gesture seeds one shape and drags it with a
   seeded sequence of screen jumps (the fuzz). Include the audit's worked
   example as a fixed low seed so it reliably reproduces the drift: **a shape
   whose edge sits at world 0, a snap target line at world 3, snap radius 5, and
   a cursor jump sequence that repeatedly crosses the snap band** — accumulated
   snap offsets under the old incremental path produce a shape displacement that
   diverges from the cursor displacement by more than the radius.

```ts
// Pilot 2 — the cursor-lock contract. While dragging, the shape stays locked
// to the cursor: its total world displacement equals the cursor's total world
// displacement (exactly when nothing snaps; within the snap radius when it
// does). The seeded generator is the point — one declaration is a fixed CI
// case at low seeds AND a fuzz campaign when run wide.
import { snapCandidatesThreshold } from '../types.js' // if exposed; else compute in-runner
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const SHAPE_ID = 'shape:drag'

export const cursorLock: Contract = {
  name: 'drag-cursor-lock',
  level: 'fsm',
  when: 'every-event',
  scene: () => [
    // A 100x100 shape at the origin, plus a second shape whose left edge lands
    // near a snap line so the drag repeatedly enters/exits the snap band (the
    // audit's edge-at-0 / target-line / radius-5 repro).
    { id: SHAPE_ID, kind: 'geo', x: 0, y: 0, w: 100, h: 100 },
    { id: 'shape:snap-target', kind: 'geo', x: 3, y: 400, w: 100, h: 100 },
  ],
  gesture: (rng: Rng): GestureOp[] => {
    const ops: GestureOp[] = [{ kind: 'down', at: { ref: 'shape', id: SHAPE_ID } }]
    // A seeded walk of 8 pointer jumps, each a few px past the drag threshold,
    // wandering across the snap band so accumulated snap offsets (old bug) show.
    let x = 50, y = 50
    for (let i = 0; i < 8; i++) {
      x += Math.round((rng.next() - 0.5) * 40)
      y += Math.round((rng.next() - 0.5) * 40)
      ops.push({ kind: 'move', at: { ref: 'point', x: 50 + x, y: 50 + y }, steps: 2 })
    }
    ops.push({ kind: 'up' })
    return ops
  },
  check: (obs: Obs): string | null => {
    const s = obs.shapeDisplacement(SHAPE_ID)
    const c = obs.cursorWorldDisplacement()
    const err = Math.hypot(s.dx - c.dx, s.dy - c.dy)
    const tol = obs.snapRadius() + 1e-6 // snapped: within one snap radius
    return err <= tol
      ? null
      : `shape drifted from cursor by ${err.toFixed(3)} world units (> snap radius ${obs.snapRadius()}): shapeΔ=${JSON.stringify(s)} cursorΔ=${JSON.stringify(c)}`
  },
}
```

   > **Implementer:** if `snapping.ts` does not export the threshold constant,
   > delete the `snapCandidatesThreshold` import and rely solely on
   > `obs.snapRadius()` (implemented in the runner in Task C1). Do not invent an
   > export.

2. Register `cursorLock` in `index.ts`.

3. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck`
   Expect: clean.

### Task C3 — Run the contract RED (reproduce the drift)

1. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **FAIL** on `drag-cursor-lock` at one or more seeds — the message
   shows `err` exceeding the snap radius (the accumulated-snap-offset drift).
   Capture the exact failing seed(s) for the checkpoint.

2. If it unexpectedly passes at all seeds, the fuzz is too gentle — widen the
   jump magnitude (`* 60` instead of `* 40`) or add more moves until the drift
   reproduces, then re-run. Do not proceed to the fix until you have a RED.

### Task C4 — Fix `select.ts`: absolute world anchoring for translate

**Files:**
- Modify: `canvas-editor/src/tools/select.ts` — `Dragging` interface,
  `onPointing` transition (~line 316-341), `onDragging` (~line 387-418),
  `computeSnappedDelta` (~line 229-243)

1. Replace the incremental `lastScreen` model with an absolute-anchor model.
   Change the `Dragging` interface: **remove** `lastScreen`; **add**
   `grabWorld: { x: number; y: number }` (cursor world point at the pointerdown
   that started the drag), `startBounds: Bounds` (union world bounds of
   `movingIds` at drag start), and `applied: { dx: number; dy: number }` (total
   delta committed so far). Keep `targetId`, `movingIds`, `excludedIds`,
   `snapshot`, `snapIndex`, `snapResult`.

2. Rewrite `computeSnappedDelta` to snap an **absolute** target against fixed
   start bounds (drop the live-bounds read):

```ts
function computeSnappedDelta(
  startBounds: Bounds,
  frozenSnap: CanvasDocument,
  frozenIndex: SpatialIndex,
  movingIds: readonly string[],
  excluded: ReadonlySet<string>,
  rawDx: number,
  rawDy: number,
): { dx: number; dy: number; snapResult: SnapResult } {
  const bounds: Bounds = {
    minX: startBounds.minX + rawDx, minY: startBounds.minY + rawDy,
    maxX: startBounds.maxX + rawDx, maxY: startBounds.maxY + rawDy,
  }
  const snapResult = snapCandidates(frozenIndex, frozenSnap, movingIds, bounds, { excludedIds: excluded })
  return { dx: rawDx + snapResult.dx, dy: rawDy + snapResult.dy, snapResult }
}
```

   `rawDx/rawDy` is now the **absolute** intended translation from the grab
   (`cursorWorld − grabWorld`), not a per-move increment. `startBounds` is
   captured once at drag start. This removes both the live-bounds read and the
   snap accumulation.

3. In `onPointing`'s Pointing→Dragging transition: compute `grabWorld =
   screenToWorld(camera, state.downScreen)` and `startBounds` = union of
   `movingIds`' `worldBounds` under the frozen `snapshot` (reuse
   `candidateBoundsAfterDelta(snapshot-as-doc, movingIds, 0, 0)` or a small
   local union). The first move's raw delta = `screenToWorld(camera, here) −
   grabWorld`. Compute the snapped total via the new `computeSnappedDelta`,
   emit `TranslateShapes(dx, dy)`, set `applied = { dx, dy }` and carry
   `grabWorld`/`startBounds` on the Dragging state.

4. Rewrite `onDragging`'s pointermove branch to absolute anchoring:

```ts
  function onDragging(state: Dragging, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointermove') {
      const camera = editor.get().camera
      const cursorWorld = screenToWorld(camera, { x: event.x, y: event.y })
      // ABSOLUTE target translation from the grab point (world-anchored — a
      // mid-drag camera change re-derives cursorWorld under the new camera, so
      // the grabbed world point stays under the cursor; the drift-prone
      // incremental screen anchor is gone). Mirrors transform.ts's
      // recompute-from-gesture-start-anchors pattern.
      const rawDx = cursorWorld.x - state.grabWorld.x
      const rawDy = cursorWorld.y - state.grabWorld.y
      const { dx: totalDx, dy: totalDy, snapResult } = computeSnappedDelta(
        state.startBounds, state.snapshot, state.snapIndex, state.movingIds, state.excludedIds, rawDx, rawDy,
      )
      const stepDx = totalDx - state.applied.dx
      const stepDy = totalDy - state.applied.dy
      const intents: Intent[] = []
      if (stepDx !== 0 || stepDy !== 0) {
        intents.push({ type: 'TranslateShapes', ids: state.movingIds, dx: stepDx, dy: stepDy })
      }
      return { state: { ...state, applied: { dx: totalDx, dy: totalDy }, snapResult }, intents }
    }
    if (event.type === 'pointerup') {
      return { state: IDLE, intents: [] }
    }
    return { state, intents: [] }
  }
```

5. Delete the now-unused `liveBoundsAdapter`/`candidateBoundsAfterDelta` **only
   if** nothing else references them (grep first: `grep -n
   'candidateBoundsAfterDelta\|liveBoundsAdapter' canvas-editor/src/tools/select.ts`).
   If `startBounds` is computed via a small local union you added, the live
   adapters may be fully dead — remove them and their doc comments. Update the
   module-header comment blocks that describe the incremental `lastScreen`
   model to describe the absolute-anchor model instead (the SNAP-DURING-DRAG and
   Dragging-state comments).

### Task C5 — Run the contract GREEN + regression-check select's own suite

1. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **PASS** — `drag-cursor-lock` now holds at every seed.

2. Run: `bun canvas-editor/src/tools/select.test.ts`
   Expect: all `ok:` lines. **If any select case pinned the old incremental
   delta behavior, it fails here** — read the failure. The absolute model is
   observationally identical for a well-formed drag (same net displacement), so
   a failure means a test pinned an intermediate per-move delta value. If so,
   update that pinned intermediate to the correct absolute-anchored value
   (verify by hand-computing `cursorWorld − grabWorld`), and note in the commit
   that the pin tracked an implementation detail the fix corrected.

3. Run the full editor suite: `bun run --filter '@ensembleworks/canvas-editor' test`
   Expect: `all N suites passed`.

### Task C6 — Widen the fuzz seed set for cursor-lock (campaign)

**Files:**
- Modify: `canvas-editor/src/contracts/library.test.ts` — add a wide-seed loop

1. Add a second loop that runs **only** the `drag-cursor-lock` contract across a
   larger seed range (e.g. `for (let seed = 0; seed < 200; seed++)`) — cheap at
   the FSM level, and the fuzz campaign the design promises. Keep the existing
   fixed-seed loop for all contracts.

2. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: PASS, with a line like `ok: drag-cursor-lock held across 200 seeds`.

### Task C7 — Typecheck + commit the pilot-2 fix

1. Run: `bun run typecheck` — expect clean.
2. Run: `bun run test` — expect `all N suites passed`.
3. **Commit:** `git add interaction-contracts canvas-editor/src/tools/select.ts canvas-editor/src/contracts/library.test.ts canvas-editor/src/tools/select.test.ts && git commit -m "fix(canvas-editor): absolute-anchor translate keeps shape locked to cursor (pilot 2); pin via cursor-lock fuzz contract"`

**STOP — session owner runs a trustability assessment before Phase D begins.**
Confirm: the fuzz reproduced the drift RED (seed captured), the transform.ts
absolute-anchor port fixed it, the fix survives a 200-seed campaign, and no
select behavior regressed beyond corrected intermediate-value pins.

---

# Phase D — Pilot 3: cross-widget selection (builds the browser runner)

> ### CHANGE NOTE — 2026-07-16 (marquee repro; translate gesture retired)
>
> **What happened.** An implementer took the original D1 contract to a real
> browser and verified, across ~20 controlled variants, that its gesture —
> `down` on shape A → `move` onto shape B → `up` — **cannot reach RED**. That
> gesture is a *translate*: the select tool commits a `TranslateShapes` intent
> on every pointermove (`select.ts` `onDragging`), and the synchronous
> re-render *mutates the dragged body's DOM transform in the same event cycle*,
> which is exactly what stops Chromium from extending a native text selection
> into a second element. Verified specifics they reported: selection extends
> fine WITHIN one continuously-dragged shape; two *static* non-editor DOM
> elements in the same viewport DO cross-select; every failing-to-extend case
> had a live editor gesture mutating the DOM mid-cycle. Current code carries NO
> `user-select` suppression anywhere (`getComputedStyle` → `user-select:auto`)
> and the viewport does not `preventDefault` pointerdown. So the contract, as
> written, **PASSES against unfixed code** — RED is unreachable, and the
> implementer correctly stopped.
>
> **The real repro is a MARQUEE, not a translate.** The QA bug was "clicking to
> select selects text across multiple widgets." The gesture that produces it is
> a marquee/brush: `pointerdown` on **empty canvas** → drag sweeping across two
> shapes' text → `pointerup`. Verified against the code: `select.ts`'s
> `onPointing` routes a threshold-crossing move whose press target was empty
> (`targetId === null`) into `marquee` mode, and `onMarquee` emits **no intents
> on pointermove** ("no live-preview intent exists yet") — no doc mutation, no
> moved shape, not even a live brush rectangle. Nothing re-renders or mutates a
> body's DOM during the sweep, so Chromium's native selection runs from the
> empty-canvas anchor straight across both static note bodies. That is the RED.
>
> **What this note revises (below):** D1's gesture (translate → marquee, with a
> scene of two *texted* notes and an empty-canvas start point); D3's
> `textSelectionSpans` sampler (endpoint-walk → range-**intersect**, because a
> marquee's start endpoint is on empty canvas and an endpoint-only sampler would
> never see the first body — it would under-count to 1 and mask the bug); D4's
> RED evidence; and D5's fix (the primary fix is `user-select:none` on static
> shape bodies; the plan's original **pointerdown `preventDefault`** step is
> DROPPED as incorrect — see D5 for why it is a no-op against this bug). The
> already-committed D1-D3 work (`850432c`, `ba0d771`, `e8760ce`) is REUSED:
> `seedScene` already seeds selectable text on every shape, and the `check`
> line is unchanged — only the `gesture`, the sampler body, and the fix change.

The invariant — **native text selection must never span two shape bodies** — is
only falsifiable in a real browser (`window.getSelection()`). This is the first
`level: 'browser'` contract and it **forces the browser runner into existence**:
a gesture interpreter over Playwright, a per-rAF sampler for `when:
'every-event'`, and a page-backed `Obs` adapter. The repro is a **marquee**
(pointerdown on empty canvas, sweep across two notes' text, up); because the
marquee tool mutates nothing during the sweep, Chromium sweeps a native
selection across both note bodies. Fix: `user-select: none` on the static shape
bodies (matching how tldraw makes its whole canvas non-selectable), verified not
to break the editing textarea's own caret/selection.

### Task D1 — Add the browser-level Obs method + the cross-widget contract

**Files:**
- Modify: `interaction-contracts/src/types.ts` — add `textSelectionSpans` to `Obs`
- Create: `interaction-contracts/src/contracts/cross-widget-selection.ts`
- Modify: `interaction-contracts/src/index.ts` — register it

1. In `types.ts`, add to `Obs`:

```ts
  /** How many distinct shape bodies the current native text selection
   * intersects (0 when nothing is selected). Browser-only; the FSM adapter may
   * throw 'not observable at fsm level' — a browser-tagged contract never runs
   * on the FSM lane. */
  textSelectionSpans(): number
```

2. Write `cross-widget-selection.ts` — **the committed file (`850432c`) used a
   translate gesture that cannot reach RED (see this phase's CHANGE NOTE). Edit
   its header comment and `gesture` to the MARQUEE below; the `scene` (two
   notes) and the `check` line are unchanged and are reused verbatim:**

```ts
// Pilot 3 — the first browser-tagged contract. A MARQUEE that starts on empty
// canvas and sweeps across two shape bodies' text must NEVER produce a native
// text selection spanning both (the sweep is a canvas gesture — it selects
// SHAPES, not text). This is the falsifiable form of the QA bug "clicking to
// select selects text across multiple widgets." A translate drag (down ON a
// shape) canNOT reproduce it — the per-move TranslateShapes re-render mutates
// the dragged body's DOM mid-cycle and Chromium drops the cross-element
// selection; only the marquee, whose onMarquee emits NO intents on pointermove
// (select.ts — "no live-preview intent exists yet"), leaves the DOM untouched
// long enough for the native selection to sweep across both bodies.
// Falsifiable only in a real browser via window.getSelection().
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const A = 'shape:cw-a', B = 'shape:cw-b'

export const crossWidgetSelection: Contract = {
  name: 'no-cross-widget-text-selection',
  level: 'browser',
  when: 'every-event',
  // Two notes side by side (world coords; identity camera == 1:1 screen). The
  // browser runner's seedScene sets each shape's live text, so both bodies
  // render selectable text centred at (200,200) and (500,200).
  scene: () => [
    { id: A, kind: 'note', x: 100, y: 100, w: 200, h: 200 },
    { id: B, kind: 'note', x: 400, y: 100, w: 200, h: 200 },
  ],
  // MARQUEE: down on EMPTY canvas (x=60, left of A — targetId===null routes
  // select.ts to marquee mode), then sweep RIGHT at y=200 through A's centred
  // text (~200,200) and into B's (~500,200), then up. steps:12 makes the sweep
  // a continuous drag so the native selection extends the whole way.
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 60, y: 200 } },
    { kind: 'move', at: { ref: 'point', x: 560, y: 200 }, steps: 12 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null =>
    obs.textSelectionSpans() <= 1 ? null : `native selection spans ${obs.textSelectionSpans()} shape bodies (expected <= 1)`,
}
```

**Design decision — should the invariant also forbid selecting even ONE
shape's text from a canvas drag?** The *checked* invariant stays
`textSelectionSpans() <= 1` (unchanged from the committed file): the QA bug, and
the safety property worth pinning, is "text spanning **multiple** widgets."
tldraw goes further and suppresses **all** native text selection on its canvas
(a marquee selects shapes, never text), and **the D5 fix here matches that** —
after the fix a canvas marquee selects zero text, so `spans === 0`, which
satisfies `<= 1`. We deliberately do NOT tighten the assertion to `=== 0`:
`<= 1` pins the actual bug without coupling the contract to the particular
suppression mechanism, so a future "select a single note's text via a canvas
affordance" design would not have to fight this contract. Recommend the
stronger fix (0 text from canvas drags); assert only the weaker, load-bearing
invariant.

3. Register it in `index.ts` (already done in `850432c` — no change).

4. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck` — expect clean.

5. **Commit:** `git add interaction-contracts && git commit -m "feat(interaction-contracts): cross-widget-selection contract (browser-level)"`

### Task D2 — Depend on the contracts module from `e2e`

**Files:**
- Modify: `e2e/package.json` — add dependency

1. Add `"@ensembleworks/interaction-contracts": "*"` to `e2e`'s `devDependencies`
   (e2e has only devDependencies today).

2. Run: `bun install` — expect the edge links.

3. Run: `bun run --filter '@ensembleworks/e2e' typecheck` — expect clean (the
   import isn't used yet, so this just proves resolution works).

4. **Commit:** `git add e2e/package.json bun.lock && git commit -m "chore(e2e): depend on interaction-contracts"`

### Task D3 — The browser runner: gesture interpreter + page Obs adapter

**Files:**
- Create: `e2e/lib/contracts.ts`

1. Write `e2e/lib/contracts.ts` — the browser runner. It reuses the existing
   `waitForBoot`/`viewportBox`/`seedGrid` conventions from `e2e/lib/canvas-v2.ts`
   and the `window.__ew` hook. Structure:

```ts
// The BROWSER runner (design's "same vocabulary, two runners"). Interprets a
// contract's GestureOp[] as real Playwright pointer/wheel/keyboard input
// against a live ?engine=v2 room, samples the invariant per animation frame
// (when: 'every-event'), and evaluates it against a PAGE-backed Obs adapter
// (bounding boxes, window.getSelection(), focus). Only level:'browser'
// contracts pay this cost. Mirrors lib/canvas-v2.ts's helpers — same
// window.__ew.doc.putShape seeding, same viewport-relative screen math.
import type { Page } from '@playwright/test'
import type { Anchor, Contract, GestureOp, Obs } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { viewportBox, waitForBoot } from './canvas-v2'

// Seed the scene through the live doc (same mechanism as seedGrid).
async function seedScene(page: Page, contract: Contract): Promise<void> {
  const shapes = contract.scene?.() ?? []
  if (shapes.length === 0) return
  await page.evaluate((shapes) => {
    const ew = (window as any).__ew
    for (const s of shapes) {
      ew.doc.putShape({
        id: s.id, kind: s.kind, parentId: ew.editor.pageId, index: 'a1',
        x: s.x, y: s.y, rotation: 0, isLocked: false, opacity: 1, meta: {},
        props: { w: s.w, h: s.h },
      })
    }
    ew.doc.commit()
  }, shapes as any)
}

// Resolve an anchor to a viewport-relative SCREEN point.
async function resolveAnchor(page: Page, box: { x: number; y: number }, a: Anchor): Promise<{ x: number; y: number }> {
  if (a.ref === 'point') return { x: box.x + a.x, y: box.y + a.y }
  const rect = await page.locator(`[data-shape-id="${a.id}"][data-shape-kind]`).boundingBox()
  if (!rect) throw new Error(`shape anchor ${a.id} has no bounding box`)
  return { x: rect.x + rect.width / 2 + (a.dx ?? 0), y: rect.y + rect.height / 2 + (a.dy ?? 0) }
}

function pageObs(page: Page, startRect: { minX: number; minY: number; maxX: number; maxY: number }): Obs {
  return {
    visibleWorldRectAtStart: () => startRect,
    visibleWorldRect: () => { throw new Error('sync obs unavailable in browser adapter — use the async sampler') },
    shapeDisplacement: () => { throw new Error('use async sampler') },
    cursorWorldDisplacement: () => { throw new Error('use async sampler') },
    snapRadius: () => { throw new Error('use async sampler') },
    textSelectionSpans: () => { throw new Error('use async sampler') },
  }
}
```

   > **Design tension the implementer must resolve:** `Obs` methods are
   > synchronous, but page observations are async (Playwright `evaluate`).
   > Rather than forcing every `Obs` method async (which would ripple into the
   > FSM adapter for no benefit), the browser runner samples the **specific**
   > observation a browser contract needs into a plain snapshot object BEFORE
   > calling `check`. For Pilot 3, that is `textSelectionSpans`. Implement a
   > per-contract async sampler that reads exactly the fields the contract's
   > `check` will touch, builds a synchronous `Obs` whose methods return those
   > pre-read values, and calls `check`. Keep the sampler minimal (YAGNI) —
   > Pilot 5 extends it with multi-actor `obs.on('B')`. The `textSelectionSpans`
   > sampler must count every shape body the selection **range intersects** —
   > NOT just its two endpoints. **The committed sampler (`e8760ce`) walked only
   > `startContainer`/`endContainer`; that is wrong for the marquee repro and
   > must be replaced with the range-intersect version below (see the CHANGE
   > NOTE).** Why the endpoint walk fails: the marquee starts on **empty
   > canvas**, so the selection's start endpoint is not inside any shape body —
   > an endpoint-only sampler would see only the end (inside B) and report `1`,
   > masking the bug. A range from an empty-canvas anchor to a point in B
   > *contains* body A (A lies between the boundaries in document order) even
   > though neither endpoint is inside it; `Range.intersectsNode` catches exactly
   > that, and it matches the `Obs` doc comment's word "**intersects**":

```ts
async function sampleTextSelectionSpans(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return 0
    const hit = new Set<string>()
    const bodies = document.querySelectorAll('[data-shape-id][data-shape-kind]')
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i)
      // Count every shape body the selection RANGE intersects (fully-contained
      // OR partially-overlapping — Range.intersectsNode returns true for both),
      // not just the two endpoints: a marquee anchored on empty canvas never
      // puts an endpoint inside the first body it sweeps over, so an
      // endpoint-only walk would miss it.
      bodies.forEach((body) => {
        if (range.intersectsNode(body)) hit.add((body as HTMLElement).getAttribute('data-shape-id')!)
      })
    }
    return hit.size
  })
}
```

   The `runContractBrowser(page, contract)` driver: `await waitForBoot(page)`,
   `seedScene`, `viewportBox`, then for each `GestureOp` translate to
   `page.mouse.move/down/up`/`page.mouse.wheel`/`page.keyboard`, and — for
   `when: 'every-event'` — after each op `await page.evaluate(() => new
   Promise(r => requestAnimationFrame(() => r(null))))` (the per-rAF sample)
   then read the needed observation and call `check`. Return the first failure
   message or null.

2. Run: `bun run --filter '@ensembleworks/e2e' typecheck`
   Expect: clean.

3. **Commit:** `git add e2e/lib/contracts.ts && git commit -m "feat(e2e): browser contract runner (gesture interpreter + per-rAF sampler)"`

### Task D4 — The browser-lane spec: run the cross-widget contract RED

**Files:**
- Create: `e2e/tests/contracts.spec.ts`

1. Write `e2e/tests/contracts.spec.ts` — iterates every `level: 'browser'`
   contract and runs it through `runContractBrowser` against a fresh
   `?engine=v2` room (never `team`). Follow `canvas-v2.spec.ts`'s conventions
   (import from `../lib/fixtures`, `test.setTimeout`, room-not-`team` assertion):

```ts
import { test, expect } from '../lib/fixtures'
import { CONTRACTS } from '@ensembleworks/interaction-contracts'
import { runContractBrowser } from '../lib/contracts'

for (const contract of CONTRACTS.filter((c) => c.level === 'browser')) {
  test(`interaction contract [browser]: ${contract.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    const room = `contract-${contract.name}`
    expect(room).not.toBe('team')
    await page.goto(`/?room=${room}&engine=v2`)
    const failure = await runContractBrowser(page, contract)
    expect(failure, failure ?? 'contract held').toBeNull()
  })
}
```

2. Run (from `e2e/`, with the dev stack per `e2e/README.md` — the Playwright
   `webServer` boots the real stack automatically):
   `cd e2e && bunx playwright test --project=e2e -g "no-cross-widget-text-selection"`
   Expect: **FAIL** — the assertion prints `native selection spans 2 shape
   bodies (expected <= 1)`. This is the red proving the missing
   `user-select: none`: the marquee (empty-canvas anchor → sweep across both
   notes' text → up) leaves the DOM untouched during the sweep (`onMarquee`
   emits no intents), so Chromium extends one native selection across both note
   bodies.

   > **Prerequisite — the range-intersect sampler.** RED is only observable with
   > the range-intersect `sampleTextSelectionSpans` from D3 (as revised). If the
   > committed endpoint-only sampler is still in place, the marquee's
   > empty-canvas start endpoint is outside every body and the sampler reports
   > `1` (only B's end endpoint), so the contract would PASS against unfixed code
   > and mask the bug. Confirm the D3 sampler amendment landed before trusting
   > this step.
   >
   > **Two ways this can fail to reproduce, and the fix for each:**
   > (a) *No selectable text.* Both notes must render real text. The committed
   >     `seedScene` (`e8760ce`) already calls `ew.doc.setText(s.id, …)` for every
   >     seeded shape, so this is already handled — do not re-add it. If a body
   >     still shows no text, check `label.ts`'s live-text-wins order resolved the
   >     seeded text.
   > (b) *The sweep never crosses both bodies.* Confirm identity camera at boot
   >     (world == screen offset by the viewport box) so the world-coord scene
   >     (A at 100–300, B at 400–600, text centred at y≈200) actually sits under
   >     the `y=200` sweep from x=60 to x=560. Verify the RED reproduces before
   >     fixing.

### Task D5 — Fix: `user-select: none` on the static shape bodies (NOT a pointerdown `preventDefault`)

**Files:**
- Modify: `canvas-react/src/ShapeBody.tsx` (~line 108-118, the wrapper `div` style)

> **Correction to the original plan (see the CHANGE NOTE).** The original D5
> added a pointerdown `e.preventDefault()` on the viewport as a second layer.
> **Drop it — it is a no-op against this bug.** In Chromium, starting a native
> text selection by dragging is a default action of the compatibility
> **`mousedown`** event. Calling `preventDefault()` on the **`pointerdown`**
> event does NOT cancel that compatibility `mousedown` (Pointer Events spec: a
> pointer event's `preventDefault` suppresses only a specific subset of
> compatibility mouse behaviour, and the selection-starting `mousedown` default
> is not in it). So the guard would run, feel principled, and change nothing.
> The correct and sufficient mechanism is CSS `user-select: none` — which is
> exactly how tldraw makes its own canvas non-selectable. If a JS suppressor
> were ever genuinely needed on top of the CSS, the correct event to cancel is
> `selectstart` (or `mousedown`), never `pointerdown`; it is not needed here.

1. In `ShapeBody.tsx`, add `userSelect: 'none'` (and `WebkitUserSelect: 'none'`
   for Safari) to the wrapper `div`'s inline `style`. This makes every static
   shape body's own text non-selectable. **What each part does:** a body's text
   can no longer be added to a native selection, so the marquee sweep has
   nothing selectable to extend into; Chromium keeps the selection focus pinned
   at the (text-less) empty-canvas anchor, and the marquee produces a
   **collapsed / empty** selection → `sampleTextSelectionSpans` returns 0 →
   GREEN, and (matching tldraw) a canvas marquee selects **shapes, not text**.
   **Do not** add it to the embed bodies or to the `TextEditor` textarea — the
   textarea must keep its own caret/selection (double-click-to-edit, word
   select, select-all), and inline embeds (terminal/xterm) keep their own text
   selection. `ShapeBody`'s wrapper is a static body only; the textarea lives in
   `TextEditor` (a separate positioned overlay inside `WorldLayer`) and the
   embeds render through `EmbedHost`, so scoping the rule to `ShapeBody` alone
   is the editable-target exemption — no per-event guard required.

   > **Fallback, apply ONLY if GREEN does not reproduce (empty-canvas anchor
   > still leaves a stray non-collapsed range):** move the suppression up to the
   > `WorldLayer` container (`userSelect: 'none'` on its `style`) so the marquee
   > anchor itself lands in non-selectable content and no selection can start,
   > then RE-ENABLE selection on the two descendants that need it —
   > `userSelect: 'text'` on the `TextEditor` `<textarea>` and on the
   > `EmbedHost` wrapper (so an inline terminal keeps native selection). This is
   > the same editable-target exemption expressed as CSS overrides. Prefer the
   > per-body rule above; reach for this only if the browser leaves a stray
   > range. (Do not put `user-select:none` on `WorldLayer` WITHOUT the embed
   > override — it would inherit into and break inline terminal/xterm selection.)

2. Run: `bun run --filter '@ensembleworks/canvas-react' typecheck` — expect clean.

### Task D6 — Run the cross-widget contract GREEN + verify editing still works

1. Run: `cd e2e && bunx playwright test --project=e2e -g "no-cross-widget-text-selection"`
   Expect: **PASS** (the marquee now selects zero text; `spans` is 0).

2. Run the existing editing-loop case to confirm the fix did not break
   double-click-to-edit / textarea focus / in-textarea text selection:
   `cd e2e && bunx playwright test --project=e2e -g "the editing loop"`
   Expect: PASS (the D1/H2 editing case in `canvas-v2.spec.ts` still green).

   > **Why in-textarea selection is structurally safe with the per-body fix.**
   > The `user-select:none` rule is on `ShapeBody`'s static wrapper only; the
   > editing `<textarea>` lives in `TextEditor`, a sibling overlay, so it never
   > inherits the rule — its caret, word-select and select-all are untouched.
   > Note also that `window.getSelection()` (what the contract samples) does NOT
   > report a textarea's internal selection, so the contract can neither observe
   > nor forbid in-editor selection — which is why editing must be verified by
   > this real editing test, not by the contract. (If the D5 *fallback*
   > `WorldLayer` rule is ever applied, this test is where you confirm the
   > `userSelect:'text'` textarea override actually re-enabled caret/word-select
   > inside the editor.)

3. Also run the terminal write-back case (its rename input relies on focus, and
   an inline terminal relies on native selection):
   `cd e2e && bunx playwright test --project=e2e -g "terminal title-bar write-back"`
   Expect: PASS.

### Task D7 — Component-golden guard (structural, per the README gotcha)

**Files:** none new — verification

1. `e2e/README.md` warns pixel goldens are hue-blind; `user-select: none` is not
   a visual change, so no golden should shift. Run the visual + component-golden
   suites to confirm:
   `cd e2e && bunx playwright test --project=e2e -g "visual" && bunx playwright test --project=e2e -g "component"`
   Expect: PASS with no golden updates needed. (If a golden shifts, something
   else regressed — investigate, do not blindly `--update-snapshots`.)

### Task D8 — Typecheck + commit the pilot-3 fix

1. Run: `bun run typecheck` — expect clean.
2. Run: `bun run test` — expect `all N suites passed` (unit lane; the browser
   lane runs under Playwright separately).
3. **Commit** (note the file list vs. the original plan: `Viewport.tsx` is NOT
   touched — the pointerdown `preventDefault` was dropped — while the revised
   contract gesture and the range-intersect sampler ARE part of this fix):
   `git add canvas-react/src/ShapeBody.tsx interaction-contracts/src/contracts/cross-widget-selection.ts e2e/lib/contracts.ts e2e/tests/contracts.spec.ts && git commit -m "fix(canvas-react): no cross-widget native text selection (pilot 3, marquee repro); pin via browser contract"`

**STOP — session owner runs a trustability assessment before Phase E begins.**
Confirm: the browser runner exists and interprets the shared vocabulary, the
contract ran RED (2-body selection) then GREEN, and editing/rename/focus flows
all still pass.

---

# Phase E — Pilot 4: drag-while-typing (modality exclusivity)

Invariant: **`editingShape() ≠ null ⇒ the edited shape is never translated.`**
Today the select FSM has no edit-state concept, `TextEditor`'s textarea does not
`stopPropagation`, and `CanvasV2App.handleInput` gates only keydown on
`editingId`. Fix: gate the **pointer** path on `editingId`. Choose the seam
below and justify.

### Task E1 — Add `editingShape()` to `Obs`; implement in the FSM adapter

**Files:**
- Modify: `interaction-contracts/src/types.ts` — add `editingShape` to `Obs`
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` — implement it

1. In `types.ts`, add to `Obs`:

```ts
  /** The shape currently being text-edited, or null. (editor.get().editingId
   * at fsm level; the mounted [data-text-editor-input] element in the browser
   * adapter.) */
  editingShape(): string | null
```

2. In `fsm-runner.ts`'s `makeObs`, implement `editingShape: () =>
   editor.get().editingId`.

3. Run: `bun run --filter '@ensembleworks/interaction-contracts' typecheck && bun run --filter '@ensembleworks/canvas-editor' typecheck` — expect clean.

### Task E2 — Write the modality-exclusivity contract; run it RED

**Files:**
- Create: `interaction-contracts/src/contracts/modality-exclusivity.ts`
- Modify: `interaction-contracts/src/index.ts` — register it
- Note: this is `level: 'fsm'` (the select FSM + editingId are fully
  observable headlessly — cheapest falsifying level).

1. The gesture: double-click a text-capable shape to begin editing (select.ts's
   double-click-to-edit → `BeginEdit`), then attempt a drag on that same shape.
   Invariant `check`: whenever `editingShape() === SHAPE_ID`,
   `shapeDisplacement(SHAPE_ID)` must be `{dx:0, dy:0}`.

```ts
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:edit-drag'

export const modalityExclusivity: Contract = {
  name: 'no-drag-while-typing',
  level: 'fsm',
  when: 'every-event',
  scene: () => [{ id: ID, kind: 'note', x: 0, y: 0, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Two completed clicks on the shape within the double-click window ->
    // BeginEdit (select.ts). script.ts stamps t at dt=16ms/event, comfortably
    // inside DOUBLE_CLICK_MS (450). Then a drag attempt on the same shape.
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'move', at: { ref: 'shape', id: ID, dx: 120, dy: 90 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (obs.editingShape() !== ID) return null
    const d = obs.shapeDisplacement(ID)
    return d.dx === 0 && d.dy === 0
      ? null
      : `shape moved by ${JSON.stringify(d)} while being edited (editing must be modal)`
  },
}
```

2. Register in `index.ts`.

3. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **FAIL** on `no-drag-while-typing` — the select FSM happily
   translates the shape mid-edit because nothing gates the pointer path.

   > **Caveat to check:** the FSM runner drives only the select tool, not
   > `CanvasV2App`'s dispatch layer. If the FSM `run()` loop translates the
   > shape regardless of `editingId` (it does — select.ts has no edit
   > awareness), the contract is RED at the FSM level, which is what we want:
   > the cleanest fix is in the FSM (see E3), making it falsifiable and fixable
   > at the cheapest level.

### Task E3 — Fix: gate the pointer path on editing (seam decision)

**Files:**
- Modify: `canvas-editor/src/tools/select.ts` — `onIdle`/`onPointing` guard

**Seam decision (justify in the commit):** there are two candidate seams —
(1) the **dispatch layer** (`CanvasV2App.handleInput`, gate pointer events when
`editor.get().editingId !== null`), or (2) the **select FSM** (refuse to enter a
drag when the pressed shape is the one being edited). Choose **the FSM**:
- The FSM is the clean-room seam the contract observes (Pilot 4 is `level:
  'fsm'`); fixing it there makes the contract falsifiable and fixable at the
  cheapest level, and the fix is covered by fast unit runs, not only the e2e
  lane.
- `CanvasV2App` already gates *keydown* on `editingId`; a pointer gate there
  would split the modality rule across two files. The FSM already reads
  `editor.get()` for camera/selection — reading `editingId` is the same
  closure, no new dependency.
- Every consumer of the select tool (client and any future host) inherits the
  guard for free, rather than each dispatch layer re-implementing it.

1. In `select.ts`'s `onIdle` pointerdown branch (or at the top of `onEvent`),
   read `editor.get().editingId`. When it is non-null **and** equals the
   pressed target (the shape being edited), do **not** begin a
   pointing→dragging translate on that shape: treat the pointerdown as a no-op
   for translation (the textarea owns the pointer while editing). Minimal form —
   guard the Pointing→Dragging translate transition in `onPointing`:

```ts
      if (state.targetId !== null) {
        // MODALITY: never drag the shape currently being text-edited (pilot 4).
        // The editing textarea owns the pointer; a drag on it would move the
        // shape out from under the caret.
        if (editor.get().editingId === state.targetId) return { state, intents: [] }
        // ... existing translate-start logic ...
```

   (Placing the guard at the drag-start transition, not at pointerdown, keeps
   click-to-place-caret working — only the *drag* is suppressed.)

2. Run: `bun canvas-editor/src/contracts/library.test.ts`
   Expect: **PASS** — `no-drag-while-typing` holds.

3. Run: `bun canvas-editor/src/tools/select.test.ts`
   Expect: PASS. If a select test exercised dragging a shape that happened to be
   editingId (unlikely — the existing suite predates editingId-aware select),
   reconcile it.

### Task E4 — Belt-and-suspenders: TextEditor `stopPropagation` (browser-level)

**Files:**
- Modify: `canvas-react/src/TextEditor.tsx` — textarea `onPointerDown`

1. The FSM guard fixes the logic, but the textarea should also stop pointer
   events from bubbling to the viewport so the canvas never even sees them.
   Add `onPointerDown={(e) => e.stopPropagation()}` (and `onPointerUp` likewise
   if needed) to the `<textarea>` in `TextEditor.tsx`. Keep it minimal — do not
   `preventDefault` (that would break caret placement).

2. Run: `bun run --filter '@ensembleworks/canvas-react' typecheck` — expect clean.

3. Optional browser confirmation (the existing `canvas-v2.spec.ts` "delete
   during text-editing" case already exercises the edit-modality path):
   `cd e2e && bunx playwright test --project=e2e -g "Delete during text-editing"`
   Expect: PASS.

### Task E5 — Typecheck + commit the pilot-4 fix

1. Run: `bun run typecheck` — expect clean.
2. Run: `bun run test` — expect `all N suites passed`.
3. **Commit:** `git add interaction-contracts canvas-editor/src/tools/select.ts canvas-react/src/TextEditor.tsx canvas-editor/src/contracts/fsm-runner.ts && git commit -m "fix(canvas-editor): editing is modal — no drag of the shape being typed (pilot 4); pin via modality contract"`

**STOP — session owner runs a trustability assessment before Phase F begins.**
Confirm: the modality contract ran RED at the FSM level, the FSM-seam fix
(justified over the dispatch seam) turned it GREEN, and the textarea
stopPropagation belt did not break caret/focus.

---

# Phase F — Pilot 5: editing lock (product decision first, then multi-actor)

The design mandates a **product decision before implementation**: a
presence-based "someone is editing" *indicator* vs. a *hard lock*. The decision
task's only step is to present options + a recommendation to the session owner
and **STOP**. Then the first multi-actor browser contract, the presence-payload
`editing` field, and the fix.

### Task F1 — PRODUCT DECISION (present options, then STOP)

**Files:** none — this task produces a decision, recorded by the owner.

1. Present the following to the session owner and **STOP for their answer**. Do
   not write any code in this task.

   **The question:** when peer A is text-editing a shape, what happens on peer
   B?

   **Option 1 — Indicator (soft).** B sees a non-blocking "A is editing" badge
   on the shape (from A's presence). B *can* still open the editor; concurrent
   `setText` remains an LWW stomp (the documented, already-deferred rich-text
   merge is the real fix). Cheapest; no new failure modes; contract asserts
   only that the indicator appears.
   - Pros: tiny surface, no lock state machine, no stuck-lock recovery, ships
     the *visibility* users actually asked for. Cons: does not *prevent* the
     stomp; two people can still clobber.

   **Option 2 — Hard lock.** While A edits, B's double-click-to-edit on that
   shape is refused (BeginEdit suppressed) until A ends. Requires lock lifetime
   tied to presence expiry (presence.ts's 30s timeout) so a crashed A does not
   wedge the shape forever.
   - Pros: actually prevents concurrent edits. Cons: new state machine;
     stuck-lock recovery on disconnect; a laggy lock feels broken; still needs
     presence expiry to be safe.

   **Recommendation:** **Option 1 (indicator).** It delivers the requested
   visibility with the smallest, safest surface, composes with the
   already-deferred rich-text merge as the eventual real answer, and needs no
   lock-recovery machinery. The contract then asserts the *presence-driven
   observable* (B can see A is editing), not a prevention guarantee.

2. **STOP.** Record the owner's decision in the unit spec before continuing.
   The tasks below are written for **Option 1 (indicator)**; if the owner picks
   Option 2, revise F3's contract to assert BeginEdit-refusal-on-B and F4's fix
   to suppress BeginEdit while a peer's `editing` presence covers the shape.

### Task F2 — Add the `editing` field to the presence payload

**Files:**
- Modify: `canvas-sync/src/presence.ts` (~line 7-12, the `Presence` interface)
- Modify: `canvas-sync/src/presence.test.ts` (extend the wire-contract test)

1. Add an optional `editing` field to `Presence`:

```ts
export interface Presence {
  cursor: { x: number; y: number } | null
  viewport: { x: number; y: number; w: number; h: number; z: number } | null
  stamp: { at: { x: number; y: number } } | null
  presenting: string[]
  /** The shape id this peer is currently text-editing, or null. Drives the
   * "someone is editing" indicator (pilot 5). Plain JSON (EphemeralStore
   * requires Loro Values). */
  editing: string | null
}
```

   > **Check first:** `Presence` values go through `EphemeralStore` which
   > requires Loro Values (plain JSON). `string | null` is fine. Existing
   > publishers construct a full `Presence` — adding a required field would
   > break them; make it `editing: string | null` and update every construction
   > site (grep `presencePublisher`/`PresenceStore`/`publish(` in `client/` and
   > `canvas-sync/`), OR make it optional (`editing?: string | null`) to avoid
   > touching every site. Prefer **optional** to keep the change surgical, and
   > note that consumers must treat absent as null.

2. Run `canvas-sync`'s boundary + presence tests:
   `bun canvas-sync/src/boundary.test.ts && bun run --filter '@ensembleworks/canvas-sync' test`
   Expect: PASS. Extend `presence.test.ts` with a case asserting a published
   `editing` round-trips through `encodeAll`/`apply` (mirror an existing
   round-trip case in that file).

3. Run: `bun run --filter '@ensembleworks/canvas-sync' typecheck` — expect clean.

4. **Commit:** `git add canvas-sync/src/presence.ts canvas-sync/src/presence.test.ts && git commit -m "feat(canvas-sync): presence.editing field for the editing indicator (pilot 5)"`

### Task F3 — Multi-actor vocabulary + the editing-indicator contract (RED)

**Files:**
- Modify: `interaction-contracts/src/types.ts` — actors in gestures + `Obs.on`
- Modify: `e2e/lib/contracts.ts` — provision one context per actor; `obs.on`
- Create: `interaction-contracts/src/contracts/editing-indicator.ts`
- Modify: `interaction-contracts/src/index.ts` — register it

1. Extend the gesture vocabulary with an optional `actor` on each `GestureOp`
   (default `'A'`), and add an observation-point selector to `Obs`:

```ts
// In types.ts — each GestureOp gains an optional actor:
export type Actor = string
// add `readonly actor?: Actor` to every GestureOp variant.

// Obs gains a peer selector for multi-actor contracts:
export interface Obs {
  // ...existing methods (A's view by default)...
  /** Observe from a named actor's client. Single-actor contracts never call
   * this. */
  on(actor: Actor): Obs
  /** Does this actor's view show a "peer is editing" indicator for `shapeId`? */
  peerEditingIndicator(shapeId: string): boolean
}
```

2. Write `editing-indicator.ts` (`level: 'browser'`, `when: 'at-end'`):

```ts
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:lock'

export const editingIndicator: Contract = {
  name: 'peer-editing-is-visible',
  level: 'browser',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'note', x: 100, y: 100, w: 200, h: 200 }],
  gesture: (_rng: Rng): GestureOp[] => [
    // Actor A opens the editor on the shape (double-click-to-edit).
    { actor: 'A', kind: 'down', at: { ref: 'shape', id: ID } }, { actor: 'A', kind: 'up' },
    { actor: 'A', kind: 'down', at: { ref: 'shape', id: ID } }, { actor: 'A', kind: 'up' },
    { actor: 'A', kind: 'key', key: 'x' }, // type something so editing is unambiguous
  ],
  check: (obs: Obs): string | null =>
    obs.on('B').peerEditingIndicator(ID)
      ? null
      : `peer B does not see that A is editing ${ID} (no editing indicator)`,
}
```

3. Register in `index.ts`. Extend `e2e/lib/contracts.ts`'s
   `runContractBrowser` to: detect the set of distinct actors in the gesture;
   provision one browser context per actor joined to the same room (reuse
   `canvas-v2.spec.ts`'s two-context pattern — `browser.newContext({
   storageState: identityState(...) })`); route each op to its actor's page;
   implement `obs.on('B')` to sample B's page; implement
   `peerEditingIndicator(shapeId)` by querying B's DOM for the indicator element
   (define its selector in F4). `runContractBrowser` will need the `browser`
   fixture — thread it through from the spec.

4. Run the browser lane (from `e2e/`):
   `cd e2e && bunx playwright test --project=e2e -g "peer-editing-is-visible"`
   Expect: **FAIL** — B has no indicator (nothing renders it yet; A's `editing`
   presence is not even published). Capture the RED.

### Task F4 — Fix: publish `editing` presence + render B's indicator

**Files:**
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` — publish `editing` on BeginEdit/EndEdit
- Modify: the presence-overlay renderer (grep for where peer cursors render —
  `[data-overlay="cursor"]` in `canvas-v2.spec.ts` points to it) — add an
  editing badge on shapes a peer is editing.

1. On `BeginEdit`/`EndEdit` (or whenever `editor.get().editingId` changes), have
   `CanvasV2App` publish the local `editing` value through the presence
   publisher (the same publisher wiring that already publishes cursor/viewport —
   grep `presencePublisher` in `CanvasV2App.tsx`). Add `editingId` to the
   republish trigger set (the effect already republishes on state changes — see
   the comment near line 588 "camera/selection/hover/editingId").

2. In the presence-overlay renderer, for every peer whose `editing` is a shape
   id currently visible, render a small badge element on that shape carrying a
   stable marker, e.g. `data-overlay="editing" data-editing-shape-id="<id>"`.
   Keep it minimal — the contract only asserts presence, not styling.

3. Implement `peerEditingIndicator(shapeId)` in `e2e/lib/contracts.ts` to query
   `[data-overlay="editing"][data-editing-shape-id="<id>"]` on the observed
   actor's page.

4. Run: `cd e2e && bunx playwright test --project=e2e -g "peer-editing-is-visible"`
   Expect: **PASS** — B sees A's editing indicator.

### Task F5 — Typecheck the whole tree

1. Run: `bun run typecheck` — expect clean (new presence field + client render
   + e2e all typecheck).

2. Run: `bun run test` — expect `all N suites passed` (unit lane).

### Task F6 — Regression-run the multiplayer + presence e2e cases

1. Run: `cd e2e && bunx playwright test --project=e2e -g "presence"` and
   `-g "multi-client"` (the H2 convergence + presence cursor cases).
   Expect: PASS — adding an `editing` presence field did not disturb cursor
   presence.

### Task F7 — Update the unit spec with the recorded decision

**Files:**
- Modify: the pilot-5 unit spec (wherever the session records specs) — add the
  **Interaction Contract** section and the recorded product decision from F1.

1. Record: chosen option (indicator vs lock), the contract name
   (`peer-editing-is-visible`), its level (`browser`) and the observation it
   asserts. This is the concrete first use of the spec-template section Phase G
   generalizes.

### Task F8 — Commit the pilot-5 fix

1. **Commit:** `git add interaction-contracts client/src/canvas-v2 e2e/lib/contracts.ts canvas-sync && git commit -m "feat: peer editing indicator over presence (pilot 5); pin via multi-actor contract"`

**STOP — session owner runs a trustability assessment before Phase G begins.**
Confirm: the product decision was made by the owner (not assumed), the
multi-actor browser contract ran RED then GREEN, presence gained `editing`
cleanly, and existing presence/multiplayer cases still pass.

---

# Phase G — Process wiring (mandate lands; CI presence check turns on)

The pilots proved the substrate on real work. Now the mandate: a CI presence
check, the spec-template section, and the CLAUDE.md paragraph.

### Task G1 — CI presence-check script (RED against a synthetic offender)

**Files:**
- Create: `scripts/ux-contract-presence.test.ts` (named `.test.ts` so
  `run-tests.ts`'s `scripts/*.test.ts` glob runs it — same trick as
  `exposure-audit.test.ts`)

1. Write the check. It must: (a) compute the set of files changed in the PR
   (against the merge base — for local runs, `git diff --name-only
   origin/main...HEAD`), (b) if any changed path matches an interaction-bearing
   glob (`canvas-editor/src/tools/`, `canvas-react/src/`,
   `client/src/canvas-v2/` input/tool files), require that the same diff also
   touches the contracts module
   (`interaction-contracts/`, `canvas-editor/src/contracts/`, `e2e/lib/contracts.ts`,
   `e2e/tests/contracts.spec.ts`) **or** that the PR body carries the marker
   `ux-contract: none — <reason>`. Model the structure on
   `exposure-audit.test.ts` (self-executing assert, positive-control assertions
   so it can't pass vacuously).

   > **Determinism / CI wiring:** read the changed-file list from an env var
   > (`UX_CONTRACT_CHANGED_FILES`, newline-separated) when set, falling back to
   > `git diff` — so CI can inject the PR's file list and the PR body via env,
   > and a local run works too. The PR body comes from `UX_CONTRACT_PR_BODY`.
   > When neither the git base nor the env is available (e.g. a shallow CI
   > checkout with no `origin/main`), the check must **skip with a clear
   > message**, never false-fail.

2. Include a self-test in the same file: construct a synthetic "changed files"
   list containing an interaction-bearing path but no contracts path and no
   marker, assert the checker reports a violation; then add a contracts path,
   assert it passes; then drop the contracts path but supply the marker, assert
   it passes. This is the RED→GREEN evidence baked into the gate itself.

3. Run: `bun scripts/ux-contract-presence.test.ts`
   Expect: PASS (the self-tests exercise both branches). If the real-diff branch
   flags the current PR, either the diff genuinely lacks a contracts touch (it
   doesn't — this very phase adds them) or add the marker; verify by reading the
   output.

4. **Commit:** `git add scripts/ux-contract-presence.test.ts && git commit -m "ci: UX interaction-contract presence check"`

### Task G2 — Wire the presence check into CI

**Files:**
- Modify: the CI workflow that runs unit tests (grep `.github/workflows/` for
  where `bun run test` / `scripts/run-tests.ts` runs; `e2e.yml` runs the e2e
  lane — the unit lane runs elsewhere).

1. Because the script is a `scripts/*.test.ts`, `bun run test` already runs it
   repo-wide — so if CI runs `bun run test`, the gate is live automatically. Add
   the env wiring so CI passes the PR's changed-file list and body:
   set `UX_CONTRACT_CHANGED_FILES` (from
   `git diff --name-only ${{ github.event.pull_request.base.sha }}...HEAD`) and
   `UX_CONTRACT_PR_BODY` (`${{ github.event.pull_request.body }}`) in the job
   env for the step that runs `bun run test`.

2. Verify the workflow YAML parses (grep the existing job for the `bun run test`
   step; mirror its shape). Do not invent a new job — extend the existing unit
   step's env.

3. **Commit:** `git add .github/workflows && git commit -m "ci: feed PR diff + body to the ux-contract presence check"`

### Task G3 — Spec-template: mandatory Interaction Contract section

**Files:**
- Modify: the SDD unit-spec template (grep `docs/` / `CONTRIBUTING.md` for the
  spec template; if none exists as a file, add the section to `CONTRIBUTING.md`).

1. Add a mandatory **Interaction Contract** section with exactly two legal
   forms: (a) one or more contract declarations (name; gesture sketch;
   invariant in prose + the `obs` expression; level; scope), or (b)
   `No interaction surface — <one-line justification>`. State that silence means
   the spec is incomplete, and that spec review judges substance while the CI
   presence check (G1) guarantees the declaration-or-opt-out exists.

2. **Commit:** `git add <template-file> && git commit -m "docs: mandatory Interaction Contract section in the unit-spec template"`

### Task G4 — CLAUDE.md mandate paragraph

**Files:**
- Modify: `CLAUDE.md` (repo root; it's a symlink — edit through the path)

1. Add a short paragraph under a new `### Interaction contracts` heading (near
   the canvas workspace notes): every unit touching an interaction surface
   (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`
   input/tool files) declares an interaction contract in
   `@ensembleworks/interaction-contracts` (or records `ux-contract: none —
   <reason>` in the PR body). Contracts are seeded gestures + invariants over an
   `obs` interface; the FSM runner
   (`canvas-editor/src/contracts/fsm-runner.ts`) and the browser runner
   (`e2e/lib/contracts.ts`) play the same declaration at two levels. Point to
   `docs/plans/2026-07-16-ux-contracts-design.md` and this implementation plan.

2. Run: `bun run typecheck && bun run test` — expect clean / `all N suites
   passed` (no code change, but confirms nothing broke).

3. **Commit:** `git add CLAUDE.md && git commit -m "docs: CLAUDE.md interaction-contracts mandate"`

### Task G5 — Full-suite green sweep

**Files:** none — verification

1. Run: `bun run typecheck` — expect clean.
2. Run: `bun run test` — expect `all N suites passed`.
3. Run the browser lane: `cd e2e && bunx playwright test --project=e2e`
   Expect: all pass, including the new `contracts.spec.ts` browser contracts and
   every pre-existing `canvas-v2.spec.ts` case.

### Task G6 — PR body marker + final commit

**Files:** none — the PR body

1. This PR touches interaction-bearing paths **and** the contracts module, so
   the presence check passes without a marker. Confirm by running
   `bun scripts/ux-contract-presence.test.ts` one final time with the PR's real
   diff.

2. Ensure the PR description summarizes the five pilots and links the design +
   this implementation plan. (No commit needed unless the repo tracks PR bodies
   in-tree.)

---

## Deferred (mirrors the design doc)

- **Rich-text / per-character CRDT merge** for concurrent editing — a separate,
  already-deferred workstream. Pilot 5's indicator (or lock, per the owner's F1
  decision) is the v1 answer; it does **not** resolve the documented `setText`
  LWW stomp.
- **FSM-level multi-actor runner** — Pilot 5's multi-actor contract runs only in
  the browser lane. A protocol-level FSM variant over the in-memory transport
  the convergence rig uses is built only on demonstrated need (a multi-actor
  contract that actually hurts in the e2e lane).
- **`scope: 'per-kind'` auto-instantiation** — the type and field exist
  (Phase A), but no pilot needs the shape-registry fan-out yet; wire it when a
  contract must hold for every registered shape kind.
- **Retrofitting contracts onto already-shipped Phase-4 behavior** beyond the
  five pilots — the library grows per unit from here, not by back-filling.
- **`document.visibilitychange` / additional abandonment triggers**, and any
  gesture-atomic-undo interplay with drag contracts — untouched here.
