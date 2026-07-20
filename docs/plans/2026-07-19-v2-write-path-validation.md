# Canvas v2 Write-Path Validation + Proportionate Repair — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task.

**Goal:** Stop a single malformed prop write from silently, durably deleting a
frame and every shape inside it on every peer.

**Architecture:** Two independent defects, fixed in two independent halves.
(A) *Origination* — `LoroCanvasDoc.putShape` / `updateProps` currently write
anything they are handed; they will run `validateShape` (the zod schema that
already exists and is already what `repair()` judges by) at the write boundary
and reject invalid writes as a counted, logged no-op. (B) *Proportionality* —
`repair()`'s response to a `validProps` violation currently cascade-deletes the
offending shape's entire subtree; it will instead remove only the offending
shape and rescue its direct children to the canonical page root, reusing the
deterministic target `reparentToRoot` already uses.

**Tech Stack:** TypeScript, Bun, zod v4, loro-crdt 1.13.6. Packages touched:
`canvas-model` (pure model/repair), `canvas-doc` (Loro wrapper). No server, no
React, no tools.

---

## READ THIS BEFORE TASK 1 — non-negotiable working rules

### Toolchain

- `bun` is at `~/.bun/bin/bun` and is **often not on `PATH`**. Use the absolute
  path in every command.
- Always `cd /home/stag/src/projects/ensembleworks` **explicitly** in each
  Bash invocation. Working-directory drift has caused real failures here.
- **`bun test` is NOT the test runner and must never be used.** It invokes
  bun's built-in test framework; this repo's tests are self-executing
  `node:assert` scripts.
  - Full suite: `bun run test` (runs `scripts/run-tests.ts`).
  - One package: `cd <pkg> && ~/.bun/bin/bun test.ts`.
  - One file: `~/.bun/bin/bun canvas-doc/src/repair.test.ts`.
- Typecheck (13 workspaces): `bun run typecheck`.
- A local full-suite run needs `UX_CONTRACT_PR_BODY` set, or
  `scripts/ux-contract-presence.test.ts` may fail on the real-diff check. Use:
  ```
  UX_CONTRACT_PR_BODY='ux-contract: none — see plan' bun run test
  ```
  (This work does not touch an interaction surface, so the gate should pass
  either way — see "PR body" at the end. Setting it removes the variable.)

### Git

- You are on branch `fix/v2-write-validation`, forked from
  `perf/v2-first-shape-harness` at `0388900`.
- **Do NOT rebase onto `main`.** PR 48 and PR 50 are stacked and unmerged; this
  work stacks on top of them.
- Commit after every task. Small commits.

### Clean-room boundary (hard constraint)

`canvas-model`, `canvas-doc`, `canvas-sync`, `canvas-editor` are clean-room
packages. They must never import from `server/`, `tldraw`, or `ws`.
`canvas-sync/src/boundary.test.ts` **text-scans** source files and rejects the
literal strings `from 'ws'`, `express`, `@tldraw/`, `../server`, `Date.now(`
and `Math.random(` — **including inside comments**. Do not type those literals
anywhere in those packages, not even in prose you are writing into a comment.
(This is a purity boundary, not a freeze: editing these packages is expected.)

### RED-first — mandatory and enforced

Every task below writes the failing test **first**, **runs it**, and records the
**verbatim** failure output before any implementation is written.

- Paste the actual failure text into the commit message or task notes. Do not
  paraphrase it.
- **If RED is unreachable — the test passes before you write the fix — STOP and
  report.** Do not force redness by weakening the test. Do not skip ahead to the
  implementation. Every "unreachable RED" in this repo's history turned out to
  be a wrong belief worth catching.
- **Every RED in this plan lands on a runtime assertion, never on a missing
  export.** These tests import types with `import type`, which bun **erases**
  before execution — so referencing a type that does not exist yet cannot fail
  at runtime. A wrong type-only import surfaces at `bun run typecheck` instead.
  If a task's predicted failure text does not match what you see but the test
  *is* failing on the assertion the task names, that is a correct RED: proceed.
  Only a **passing** test is grounds to stop.

### House test style

Tests are **plain self-executing scripts** using `node:assert/strict`, with a
`// Run: bun src/<name>.test.ts` header comment. They are NOT `bun:test`. They
print an `ok: …` line at the end. Copy the shape of an existing neighbour (e.g.
`canvas-doc/src/repair.test.ts`) rather than inventing a new one.

Sections of a test are separated by bare `{ … }` blocks, so each section gets
its own scope and can reuse names like `doc` and `seen`.

#### A `tsc` parse trap this style walks straight into

**Rule: any statement ending in a parenthesized object literal `({ … })` MUST
carry a trailing semicolon** when a bare `{` block follows it.

```ts
const base = () => ({ x: 0 })   // ← no semicolon

{                               // ← bare section block
  …
}
```

`tsc` rejects the above with a bogus `TS1003: Identifier expected` /
`TS1005`. Mechanism (verified against a matrix of minimal repros): tsc's
speculative "is this an arrow parameter list?" lookahead sees `( … )` followed
by `{`, commits to parsing the parens as a **binding pattern**, then demands
`=>` at the block. As a destructuring pattern, `x: 0` means "bind property `x`
to target `0`" — and `0` is not a valid binding target, hence TS1003.

Two things that make it worse than it looks:

- It is **not arrow-specific.** A plain `const v = ({ a: 1 })` followed by a
  bare block errors identically. It is also **not** about string values — an
  all-numeric object triggers it too.
- **bun's parser accepts it.** So the test goes RED and then GREEN exactly as
  the plan predicts, and the error only surfaces at `bun run typecheck`,
  detached from the change that caused it.

An intervening comment line does **not** save you — comments are erased before
this lookahead runs. Add the `;`.

---

## Background — what is actually broken (verified 2026-07-19)

Reproduced against `0388900` with a throwaway script:

```
before: [ "shape:c1", "shape:c2", "shape:f" ] text: "precious content"
plan:   [{"op":"dropShape","id":"shape:f"}]
after:  []                                    text: ""
```

The script created a frame `shape:f` with a note `shape:c1` inside it (holding
text) and a note `shape:c2` inside that, then called
`doc.updateProps('shape:f', { w: '100' })` — one wrong-typed prop — then
`doc.repair()`. Result: all three shapes gone, text container wiped. Loro
tombstones make this unrecoverable.

The chain, with exact locations:

| Location | Behaviour |
|---|---|
| `canvas-doc/src/loro-canvas-doc.ts:124` `putShape` | writes `s.props` verbatim; validates nothing |
| `canvas-doc/src/loro-canvas-doc.ts:143` `updateProps` | blind `{ ...cur, ...props }` merge; validates nothing |
| `canvas-model/src/shape.ts:97` `validateShape` | exists, is a `shapeSchema.safeParse`; **never called on the write path** |
| `canvas-model/src/invariants.ts:16` | calls `validateShape` per shape → `{ rule: 'validProps', id, detail }` |
| `canvas-model/src/repair.ts:24-25` `opFor` | `validProps` → `{ op: 'dropShape', id }` |
| `canvas-model/src/repair.ts:113` `applyRepairToModel` | `cascadeDropSet(doc.shapes, drop)` — drops the whole descendant closure |
| `canvas-doc/src/loro-canvas-doc.ts:367` | `dropShape` → `deleteNode` per physical node; `deleteNode` cascade-deletes the real subtree and clears each descendant's text container |
| `canvas-sync/src/client-peer.ts:170`, `canvas-sync/src/server-peer.ts:161`, `server/src/canvas-v2/actor.ts:146` | `repair()` runs on every *changed* inbound frame and once on room load |

So: one bad prop write, from any local code path or the agent API, executes the
shape's whole subtree on every peer, durably.

---

## Design decisions (settled — do not re-open during implementation)

### D1. "Reject" means a counted, logged **no-op** — never a throw.

**Decision.** An invalid `putShape` or `updateProps` writes nothing at all,
increments `LoroCanvasDoc.invalidWrites`, and reports through an injected
`onInvalidWrite` callback (defaulting to a `console.warn`). It does not throw
and does not partially write.

**Why not throw.** `Editor.applyAll` (`canvas-editor/src/editor.ts:249-256`)
loops `applyOne` over a batch of intents with **no `try`/`catch`**, and only
calls `this.doc.commit()` after the loop. A throw from `putShape` mid-batch
escapes `applyAll` with the earlier intents' mutations sitting **uncommitted**
in the Loro doc, where the next unrelated `commit()` sweeps them up and
attributes them to the wrong batch. That is exactly the failure mode
`Editor.replay`'s "TOLERANCE CONTRACT" comment (`editor.ts:322-338`) already
documents and guards against for the inverse path. Throwing here would
reintroduce it on the forward path. In the browser it would additionally
propagate out of a React event handler and can unmount the canvas.

The inbound-frame concern raised in the brief does **not** apply: remote frames
arrive via `doc.import(bytes)`, which never routes through `putShape` or
`updateProps`. So no throw could drop an inbound frame. The editor-batch hazard
is the binding one.

**Why a no-op is nevertheless acceptable.** Silence is only bought by
observability, and both halves are mandatory:

1. `LoroCanvasDoc.invalidWrites` — a monotonic, test-assertable counter,
   modelled on the existing `SyncServerPeer.malformedFrames`
   (`canvas-sync/src/server-peer.ts:67`).
2. `onInvalidWrite(w: InvalidWrite)` — an optional injected callback. When it is
   absent the doc emits a `console.warn` carrying the op, the shape id, and the
   verbatim zod error.

`updateProps` already has a documented silent-no-op contract for an unknown id
(`canvas-doc/src/canvas-doc.ts:28`), so "no-op on invalid" is contract-
consistent rather than novel.

### D2. `updateProps` validates the **merged** result, not the patch.

Confirmed: `updateProps` is `{ ...cur, ...props }`. A patch is meaningless in
isolation, so validation runs against `{ ...readNode(n), props: merged }`.

Two consequences, both intended and both to be written into the code comment:

- A patch that **repairs** an already-invalid shape (one that arrived over the
  wire) is **accepted**, because the merged shape validates. Good: it means a
  peer can heal remote damage.
- A patch that is individually harmless but leaves the shape still invalid is
  **rejected**. So a two-field breakage cannot be fixed one field at a time via
  `updateProps`; the caller must `putShape` a whole valid shape. Accepted.

### D3. Local validation is not sufficient — what stays exposed.

`import(bytes)` applies remote ops straight to the Loro tree. A peer running
older, buggy, or hostile code can still land invalid props in a converged doc,
and nothing in this plan changes that. **Therefore `repair()` must keep
responding to `validProps` destructively.** The fix is to make the response
*proportionate*, not to remove it.

To keep that path testable, Task 3 adds `LoroCanvasDoc.putShapeUnchecked` — a
concrete-class-only escape hatch (deliberately **not** on the `CanvasDoc`
interface) that bypasses write validation. Its purpose is precisely to stand in
for "what a remote peer's bytes can still deliver", and the existing repair
tests that seed invalid shapes will use it.

### D4. Repair stays a pure, deterministic function of converged state.

The new `dropShape` semantics: remove the named shape; reparent every shape
whose `parentId` is a dropped id to `canonicalPageId(pages)` — the
lexicographically smallest page id, which is **already** the deterministic
target `reparentToRoot` uses (`canvas-model/src/repair.ts:45-47`). No traversal
order, no container iteration order, no clock, no randomness. Every peer
computes and applies an identical plan.

`applyRepairToModel` (the pure reference) and `LoroCanvasDoc.repair()` (the Loro
application) change in the **same task**, and their agreement is already pinned
by `canvas-doc/src/repair.test.ts:187` and `canvas-sync/src/convergence.test.ts:168`.
Those two assertions are the drift guard; do not weaken them.

**Zero-page edge.** With no pages there is no rescue target. Rule: `repairPlan`
suppresses `dropShape` in a zero-page doc, exactly as it already suppresses
`reparentToRoot` (`repair.ts:56-60`). The invalid shape is left standing rather
than emitting an op that cannot be applied proportionately. A zero-page doc is
already degenerate.

**`cascadeDropSet` becomes dead.** It is used only by `applyRepairToModel` and
`LoroCanvasDoc.repair()`, both of which stop cascading. Task 5 deletes it. It is
re-exported from `canvas-model/src/index.ts` via `export * from './repair.js'`,
so Task 5 includes a repo-wide grep to prove nothing else consumes it.

### D5. Back-compat with live dogfood room data.

The room load path is `LoroCanvasDoc.fromSnapshot` → `import(u)` per stored
update → `repair()` (`server/src/canvas-v2/actor.ts:136-147`). **It never calls
`putShape` or `updateProps`.** Therefore write validation adds *zero* new
rejection on load — no existing room can fail to open because of half (A).

What *does* change on load is half (B), and it changes strictly in the safe
direction: a shape that is already invalid in a live room is today dropped
**with its entire subtree**; after this change only that shape drops and its
children survive at the page root. Nothing that survives today stops surviving.

One honest caveat to carry into the PR body: a child rescued out of a frame to
the page root keeps its parent-relative `x`/`y`, so it will appear at a
different on-screen position. That is inherited from `reparentToRoot`'s existing
behaviour for orphan/cycle repair, and it is unambiguously better than the shape
being deleted. **Owner-accepted 2026-07-20 (see Decisions, ruling 1).**
Coordinate-preserving rescue is **out of scope and recorded as a follow-up**,
not an open question — it would require `repair()` to do geometry, and
`repair()` must stay a cheap pure function.

### Deferred follow-ups (do NOT do these here)

- **Coordinate-preserving rescue.** Adjusting a rescued child's `x`/`y` so its
  world position is unchanged when it is rehomed from a frame to the page root.
  Deferred by owner ruling 1: it puts geometry into `repair()`. It would apply
  equally to today's `reparentToRoot` orphan/cycle path, so it is a single
  follow-up covering both, not something this branch should special-case.

### D6. Perf.

Measured on this machine at `0388900`, 5000 iterations:

```
validateShape only: 4.37 us/call
putShape only:     28.32 us/call
```

So write validation costs roughly **+15% on `putShape`**, ~4.4 µs per write —
about 4.4 ms across a 1000-shape bulk load. That is well inside the noise of
`repair()`'s own ~7.36 ms/call floor at 1k shapes. Task 9 re-runs the perf
harness to confirm no gate trips; no optimisation is planned or wanted here.

### D7. Scope.

This is step 1 of a 4-step sequence. Steps 2 (styling UI, copy/paste, z-order),
3 (draw/line/image renderers) and 4 (assets, pages) are **not** planned here and
must not be started. Nothing in this plan touches `canvas-editor/src/tools/`,
`canvas-react/src/`, or `client/src/canvas-v2/`.

---

---

## Decisions (settled 2026-07-20 — owner ruling; NOT open questions)

Four questions were escalated when this plan was written. All four are now
ruled. A fresh implementer or reviewer must **not** reopen any of them.

### Ruling 1 — Coordinate jump on rescue: **ACCEPTED.**

Rescued children keep their parent-relative `x`/`y` and may therefore appear at
a different on-screen position after being rehomed from a frame to the page
root. Recorded rationale:

- It matches `reparentToRoot`'s existing orphan/cycle behaviour, so `repair()`
  stays internally consistent — one rehoming rule, not two.
- A misplaced shape is strictly better than an unrecoverably deleted one.
- Coordinate-preserving rescue would put geometry into `repair()`, which must
  stay a cheap pure function.

Coordinate-preserving rescue is **out of scope** and is recorded as a follow-up
under "Deferred follow-ups" above. It is not an open question.

### Ruling 2 — Removing `cascadeDropSet` from `@ensembleworks/canvas-model`'s exports: **APPROVED.**

`canvas-model` is an internal workspace package with no external consumers.
Proceed with the deletion in Task 5. The repo-wide grep in Task 5 Step 5 remains
required — it proves the *internal* consumer list is what this plan assumes, not
that an external one exists.

### Ruling 3 — Zero-page policy: **the plan's choice stands.**

`repairPlan` suppresses `dropShape` in a zero-page doc and leaves the invalid
shape standing, mirroring the policy it already applies to `reparentToRoot`
(`canvas-model/src/repair.ts:56-60`). See decision D4.

### Ruling 4 — Scope: **land BOTH halves. Tasks 1–9, all of them.**

Half (B) is in scope, not conditional. Recorded rationale: after half (A) alone,
`doc.import` still bypasses validation entirely, so a remote peer running older
or buggy code can still ship invalid props and still trigger the subtree cascade
on **every** peer. **Most of the actual risk reduction lives in half (B).**

The Task-4 off-ramp below stays documented as a *fallback* — to be used only if
half (B) turns out worse than expected during execution — but the intent is to
land all nine tasks. Taking the off-ramp is an escalation, not a judgement call:
STOP and report rather than quietly shipping half the fix.

---

## Task order

Tasks 1–4 are half (A), origination. Tasks 5–8 are half (B), proportionality.
Task 9 is integration. **All nine are in scope** (ruling 4).

The two halves are technically independent — (A) is strictly additive and
independently landable — which is what makes the fallback possible. If half (B)
proves worse than expected mid-execution, STOP after Task 4, report, and let the
owner decide; do not silently narrow the branch to half (A).

---

## Task 1: Add the invalid-write reporting surface (counter + hook)

Types and plumbing only. No validation is wired up yet, so this task's test
asserts the *default* (zero) state — which is genuinely red today because the
members do not exist.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (add the two exported types)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (constructor, `create`,
  `fromSnapshot`, counter, `reject` helper)
- Create: `canvas-doc/src/write-validation.test.ts`

**Step 1: Write the failing test**

Create `canvas-doc/src/write-validation.test.ts`:

```ts
// Run: bun src/write-validation.test.ts
// The write boundary (Task 1-4): LoroCanvasDoc rejects locally-originated
// writes that would put a shape into a state repair() would later judge
// invalid, reporting each rejection through a counter and an injectable hook
// instead of throwing (see docs/plans/2026-07-19-v2-write-path-validation.md,
// decision D1).
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import type { InvalidWrite } from './canvas-doc.js'

// The trailing semicolon is LOAD-BEARING — a bare `{` section block follows.
// See "House test style" above for why tsc (but not bun) rejects it without.
const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

// --- Task 1: the reporting surface exists and starts empty ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 1n, onInvalidWrite: (w) => seen.push(w) })
  assert.equal(doc.invalidWrites, 0, 'a fresh doc has rejected nothing')
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(doc.invalidWrites, 0, 'a valid write is not counted as a rejection')
  assert.deepEqual(seen, [], 'a valid write does not fire the hook')
}

console.log('ok: write-validation')
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL with **`AssertionError: a fresh doc has rejected nothing`**
(`undefined !== 0`) — `doc.invalidWrites` does not exist yet, so it reads as
`undefined`.

> Do **not** expect a missing-export error for `InvalidWrite`. The import is
> `import type`, which bun **erases** before execution, so a type-only import of
> a not-yet-existing type can never fail at runtime. Every RED in this plan
> therefore lands on a runtime **assertion**, not a module-resolution error. A
> type-only import that is genuinely wrong surfaces at `bun run typecheck`, not
> here.

**Record the verbatim output.** (Observed on the real Task 1 implementation:
`AssertionError: a fresh doc has rejected nothing / undefined !== 0`.)

**Step 3: Add the types**

In `canvas-doc/src/canvas-doc.ts`, immediately after the `ImportResult`
interface, add:

```ts
/** A locally-originated write this doc REFUSED to apply because the resulting
 * shape would fail canvas-model's `validateShape` — i.e. exactly what
 * `repair()` would later judge a `validProps` violation and act on. Reported
 * rather than thrown: a throw from a write escapes `Editor.applyAll`'s
 * un-try/caught intent loop and strands that batch's earlier mutations
 * uncommitted (see the plan's decision D1). `error` is the verbatim zod
 * message. */
export interface InvalidWrite {
  op: 'putShape' | 'updateProps'
  id: string
  error: string
}

/** Sink for InvalidWrite reports, injected at doc construction. When none is
 * supplied the doc warns on the console instead — a rejection is never
 * silent. */
export type InvalidWriteHandler = (write: InvalidWrite) => void
```

**Step 4: Add the counter and hook to `LoroCanvasDoc`**

In `canvas-doc/src/loro-canvas-doc.ts`:

Extend the type-only import from `./canvas-doc.js`:

```ts
import type { CanvasDoc, ImportResult, InvalidWrite, InvalidWriteHandler } from './canvas-doc.js'
```

Change the constructor signature and both factories:

```ts
  private constructor(
    private doc: LoroDoc,
    private tree: LoroTree,
    private onInvalidWrite?: InvalidWriteHandler,
  ) {
    this.reindex()
  }

  static create(opts: { peerId: bigint; onInvalidWrite?: InvalidWriteHandler }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'), opts.onInvalidWrite)
  }
  static fromSnapshot(bytes: Uint8Array, opts: { peerId: bigint; onInvalidWrite?: InvalidWriteHandler }): LoroCanvasDoc {
    const doc = new LoroDoc()
    doc.setPeerId(opts.peerId)
    doc.import(bytes)
    return new LoroCanvasDoc(doc, doc.getTree('shapes'), opts.onInvalidWrite)
  }
```

Add the counter and the reporting helper. Put them directly above
`private static PROP_KEY = '__props'`:

```ts
  // Monotonic count of locally-originated writes this doc refused (see
  // InvalidWrite). Never reset. The assertable counterpart to the console
  // warning below — modelled on SyncServerPeer's malformedFrames, which
  // plays the same role for undecodable inbound frames.
  private invalidWriteCount = 0
  get invalidWrites(): number { return this.invalidWriteCount }

  // Count, then report. A rejection is a NO-OP at the call site, so this is
  // the only trace it leaves: silence at the boundary is only acceptable
  // because both the counter and the hook are unconditional.
  private rejectWrite(op: InvalidWrite['op'], id: string, error: string): void {
    this.invalidWriteCount++
    const write: InvalidWrite = { op, id, error }
    if (this.onInvalidWrite) this.onInvalidWrite(write)
    else console.warn(`[canvas-doc] rejected invalid ${op} for ${id}: ${error}`)
  }
```

**Step 5: Run the test to verify it passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: `ok: write-validation`

**Step 6: Typecheck the two affected packages**

```
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/canvas-doc' typecheck
```

Expected: no output, exit 0. If a caller of `create`/`fromSnapshot` broke,
fix the call site — the new field is optional, so nothing should break.

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "feat(canvas-doc): invalid-write reporting surface (counter + injectable hook)"
```

---

## Task 2: Validate `putShape` at the write boundary

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`putShape`, add `putShapeUnchecked`)
- Modify: `canvas-doc/src/canvas-doc.ts` (`putShape` JSDoc)
- Modify: `canvas-doc/src/write-validation.test.ts`

**Step 1: Write the failing test**

> **What Task 1's test did and did not prove.** Task 1's assertions are
> deliberately weak — they check the *default* zero state. Spec review confirmed
> their one real contribution is a **false-positive guard**: they fail
> immediately if this task's validation turns out to be over-eager and rejects a
> valid shape. (Review also confirmed the Task 1 fixture is genuinely
> schema-valid — `validateShape` returns `ok` on it — so there is no landmine
> tempting you to "fix" the test instead of the code.)
>
> But Task 1 leaves five real holes, and this test must close all five. Each is
> flagged inline below so you can see why it exists rather than treating it as
> assertion padding.

Append to `canvas-doc/src/write-validation.test.ts`, **before** the final
`console.log`:

```ts
// --- Task 2: putShape rejects an invalid shape, writes nothing, does not throw ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 2n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })
  // A neighbour that must survive untouched — see the no-op assertion below.
  doc.putShape({ id: 'shape:keep', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)

  // props.w must be a number for a frame (canvas-model shape.ts `box`).
  assert.doesNotThrow(() =>
    doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never),
  )

  // HOLE 1 (the biggest): Task 1 never CALLS onInvalidWrite. A doc that stores
  // the handler and never invokes it passes Task 1 completely. Prove it fires.
  assert.equal(seen.length, 1, 'the hook actually fired — storing the handler is not enough')
  assert.equal(seen[0]!.op, 'putShape')
  assert.equal(seen[0]!.id, 'shape:bad')

  // HOLE 5: the InvalidWrite doc comment promises the VERBATIM zod message.
  assert.match(seen[0]!.error, /expected number, received string/, 'the verbatim zod message is carried through')

  // HOLE 3 (the actual defect): the write is a TRUE no-op. The counter is only
  // a proxy for this — what matters is that nothing landed and nothing else
  // moved.
  assert.equal(doc.getShape('shape:bad'), undefined, 'the invalid shape was not written at all')
  assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:keep'], 'no partial node, and the neighbour is untouched')

  // HOLE 2: prove invalidWrites is a COUNTER, not a constant. Task 1 only ever
  // observed it at 0, which a hardcoded `get invalidWrites() { return 0 }`
  // would satisfy. Walk it 0 -> 1 -> 2.
  assert.equal(doc.invalidWrites, 1, 'the first rejection was counted')
  doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { h: 'nope' }, ...base() } as never)
  assert.equal(doc.invalidWrites, 2, 'the counter increments per rejection')
  assert.equal(seen.length, 2, 'and the hook fires per rejection')

  // The escape hatch still writes, unvalidated — this is how tests and rigs
  // reproduce what a remote peer's bytes can deliver (decision D3).
  doc.putShapeUnchecked({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
  assert.ok(doc.getShape('shape:bad'), 'putShapeUnchecked bypasses validation')
  assert.equal(doc.invalidWrites, 2, 'the escape hatch does not touch the counter')
}

// HOLE 4: with NO handler injected, the doc must fall back to console.warn.
// The InvalidWriteHandler doc comment claims a rejection is "never silent" and
// nothing has proven it. Capture console.warn rather than trusting the claim.
{
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const doc = LoroCanvasDoc.create({ peerId: 4n }) // no onInvalidWrite
    doc.putPage({ id: 'page:p', name: 'P' })
    doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(doc.invalidWrites, 1, 'still counted without a handler')
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 1, 'the console.warn fallback fired — a rejection is never silent')
  assert.match(String(warned[0]![0]), /rejected invalid putShape for shape:bad/, 'the warning names the op and the id')
}
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL at the **first** new assertion —
`AssertionError: the hook actually fired — storing the handler is not enough`
(`0 !== 1`). With no validation in place `putShape` simply writes the bad shape,
so the hook never fires. (`putShapeUnchecked` also does not exist yet, but
execution never reaches it.) **Record the verbatim output.**

> **Placement note.** All five holes are closed here in Task 2 rather than
> split with Task 4. Holes 1, 2, 4 and 5 are properties of the shared
> `rejectWrite` helper, so proving them once through `putShape` covers
> `updateProps` too — re-asserting them in Task 4 would be duplication, not
> coverage. Hole 3 (true no-op) is op-specific and *is* asserted again in Task 4
> in its `updateProps` form, because "no partial merge landed" is a genuinely
> different claim from "no node was created".

**Step 3: Implement**

In `canvas-doc/src/loro-canvas-doc.ts`, extend the value import from
`@ensembleworks/canvas-model` to include `validateShape`:

```ts
import { canonicalPageId, cascadeDropSet, repairPlan, stableStringify, validateShape, type Binding, type Page, type RepairOp, type Shape } from '@ensembleworks/canvas-model'
```

(Leave `cascadeDropSet` in place for now; Task 5 removes it.)

Replace the existing `putShape` method (currently `loro-canvas-doc.ts:124-142`)
with:

```ts
  putShape(s: Shape): void {
    // WRITE BOUNDARY. `validateShape` is the SAME predicate checkInvariants
    // uses for the validProps rule, so anything accepted here is something
    // repair() will not later act on — a locally-originated write can no
    // longer manufacture the state repair() is obliged to destroy.
    // Rejection is a total no-op (not a partial write, not a throw): a throw
    // escapes Editor.applyAll's un-try/caught intent loop and strands that
    // batch's earlier mutations uncommitted. Observability lives in
    // rejectWrite.
    const v = validateShape(s)
    if (!v.ok) {
      const id = typeof (s as { id?: unknown })?.id === 'string' ? (s as { id: string }).id : '<no id>'
      this.rejectWrite('putShape', id, v.error)
      return
    }
    this.putShapeUnchecked(s)
  }
  /**
   * putShape WITHOUT the write-boundary validation above. Deliberately NOT on
   * the CanvasDoc interface: it exists so tests and hostile-state rigs can
   * construct exactly the docs a REMOTE peer's bytes can still deliver
   * (import() applies remote ops straight to the tree and never passes
   * through putShape, so local validation cannot close that door). Do not
   * call it from production code.
   */
  putShapeUnchecked(s: Shape): void {
    // Placement FIRST, data second (same discipline as reparent): for an
    // existing node Loro's cycle guard throws if s.parentId names a real
    // descendant of it, and no data field may be modified in that case.
    // A freshly created node has no descendants, so its placement cannot cycle.
    let n = this.nodeByShapeId(s.id)
    let isNew = false
    if (!n) { n = this.tree.createNode(); isNew = true }
    this.placeInTree(n, s.parentId)
    const d = n.data
    d.set('shapeId', s.id); d.set('kind', s.kind); d.set('parentId', s.parentId)
    d.set('index', s.index); d.set('x', s.x); d.set('y', s.y)
    d.set('rotation', s.rotation); d.set('isLocked', s.isLocked); d.set('opacity', s.opacity)
    d.set('meta', s.meta as any); d.set(LoroCanvasDoc.PROP_KEY, s.props as any)
    if (isNew) {
      const arr = this.index.get(s.id)
      if (arr) arr.push(n); else this.index.set(s.id, [n])
    }
  }
```

Then update the `putShape` JSDoc in `canvas-doc/src/canvas-doc.ts` (currently
lines 17-26) by appending, inside the existing block comment, before its `*/`:

```
   * REJECTS (total no-op, no throw) a shape that fails canvas-model's
   * validateShape — the same predicate repair() judges by — reporting it via
   * the implementation's invalid-write hook. A local writer can therefore no
   * longer originate the state repair() is obliged to destroy. Remote ops
   * arriving through import() bypass this entirely; repair() remains the
   * defence there.
```

**Step 4: Run the test to verify it passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: `ok: write-validation`

**Step 5: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "fix(canvas-doc): validate shapes at the putShape write boundary"
```

---

## Task 3: Repoint the invalid-seed tests at `putShapeUnchecked`

Task 2 just made it impossible for the existing repair tests to seed the invalid
docs they exist to exercise. This task restores them. It has **no RED step of
its own** — it is a mechanical repair of tests Task 2 broke; the "red" is the
suite failure you are about to observe in Step 1.

**Files:**
- Modify: `canvas-doc/src/repair.test.ts`
- Modify: `canvas-doc/src/repair-cost.test.ts`

**Step 1: Observe the breakage**

```
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
```

Expected: FAIL in `src/repair.test.ts` and/or `src/repair-cost.test.ts` — the
seeded invalid shapes no longer exist, so the pre-repair invariant assertions
fail. **Record the verbatim output.**

**Step 2: Repoint the invalid seeds**

Change **only** the `putShape` calls that deliberately write an invalid shape.
Leave every valid-shape `putShape` alone — those must keep exercising the
validating path.

In `canvas-doc/src/repair.test.ts` these are the calls carrying
`opacity: 'no'` (as of `0388900`: lines 39, 64, 92). Change `doc2.putShape(`,
`doc3.putShape(`, `doc4.putShape(` to `…putShapeUnchecked(` **on those lines
only**. Note that on line 64/65 the *pair* forms a 2-cycle: only line 64 carries
`opacity: 'no'`, so only line 64 changes.

In `canvas-doc/src/repair-cost.test.ts`, line 43's loop writes
`invalidShape(...)` — change that one call to `putShapeUnchecked`.

Add a one-line comment above the first changed call in each file:

```ts
// putShapeUnchecked, not putShape: this seed is DELIBERATELY invalid — it
// stands in for what a remote peer's bytes can still deliver, which is the
// only way this state reaches a doc now that the write boundary validates.
```

**Step 3: Run the package suite**

```
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
```

Expected: `all 13 suites passed` (count will be 13 with the new
`write-validation.test.ts`).

**Step 4: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/repair.test.ts canvas-doc/src/repair-cost.test.ts
git commit -m "test(canvas-doc): seed deliberately-invalid repair fixtures via putShapeUnchecked"
```

---

## Task 4: Validate `updateProps` against the merged result

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`updateProps`)
- Modify: `canvas-doc/src/canvas-doc.ts` (`updateProps` JSDoc)
- Modify: `canvas-doc/src/write-validation.test.ts`

**Step 1: Write the failing test**

Append to `canvas-doc/src/write-validation.test.ts`, before the final
`console.log`:

```ts
// --- Task 4: updateProps validates the MERGED shape, not the patch ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 3n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)

  // The exact reported defect: a string where a number belongs.
  assert.doesNotThrow(() => doc.updateProps('shape:f', { w: '100' }))
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 100, h: 100 }, 'props are untouched — no partial merge landed')
  assert.equal(doc.invalidWrites, 1, 'the rejection was counted')
  assert.equal(seen[0]!.op, 'updateProps')
  assert.equal(seen[0]!.id, 'shape:f')

  // A VALID patch still merges (regression guard on the happy path).
  doc.updateProps('shape:f', { w: 250 })
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 250, h: 100 }, 'a valid patch merges as before')
  assert.equal(doc.invalidWrites, 1, 'a valid patch is not counted')

  // Merged-not-patch, the direction that MATTERS: a patch that HEALS an
  // already-invalid shape (one a remote peer delivered) must be accepted,
  // even though the pre-image is invalid.
  doc.putShapeUnchecked({ id: 'shape:g', kind: 'frame', parentId: 'page:p', props: { w: 'bad', h: 10 }, ...base() } as never)
  doc.updateProps('shape:g', { w: 42 })
  assert.deepEqual(doc.getShape('shape:g')!.props, { w: 42, h: 10 }, 'a patch that makes the merged shape valid is accepted')
  assert.equal(doc.invalidWrites, 1, 'healing a remote-delivered invalid shape is not a rejection')

  // Unknown id keeps its pre-existing silent-no-op contract — NOT a rejection.
  doc.updateProps('shape:nope', { w: 1 })
  assert.equal(doc.invalidWrites, 1, 'an unknown id is a no-op, not an invalid write')
}
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL at `props are untouched — no partial merge landed` — the actual
props will be `{ w: '100', h: 100 }`. **Record the verbatim output.**

**Step 3: Implement**

Replace `updateProps` (currently `loro-canvas-doc.ts:143-148`) with:

```ts
  updateProps(id: string, props: Record<string, unknown>): void {
    const n = this.nodeByShapeId(id)
    if (!n) return // unknown id: the pre-existing silent-no-op contract, NOT a rejection
    const cur = (n.data.get(LoroCanvasDoc.PROP_KEY) as Record<string, unknown>) ?? {}
    const merged = { ...cur, ...props }
    // Validate the MERGED result, never the patch alone: this is a partial
    // merge, so a patch only means something against what it lands on. Two
    // intended consequences: (1) a patch that HEALS an already-invalid shape
    // — one a remote peer delivered through import(), which bypasses this
    // boundary entirely — is accepted, because the merged shape validates;
    // (2) a patch that is individually harmless but leaves the shape still
    // invalid is rejected, so a two-field breakage cannot be healed one
    // field at a time here (use putShape with a whole valid shape).
    const v = validateShape({ ...this.readNode(n), props: merged })
    if (!v.ok) { this.rejectWrite('updateProps', id, v.error); return }
    n.data.set(LoroCanvasDoc.PROP_KEY, merged as any)
  }
```

Update the `updateProps` JSDoc in `canvas-doc/src/canvas-doc.ts` (line 28):

```ts
  /**
   * Merges `props` into the shape's existing props. Silent no-op if no shape
   * with this id exists.
   *
   * REJECTS (total no-op, no throw) a patch whose MERGED result would fail
   * canvas-model's validateShape, reporting it via the implementation's
   * invalid-write hook. Validation runs on the merge, not the patch — so a
   * patch that heals an already-invalid shape is accepted, and a patch that
   * leaves it invalid is not.
   */
  updateProps(id: string, props: Record<string, unknown>): void
```

**Step 4: Run the test to verify it passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: `ok: write-validation`

**Step 5: Run the whole canvas-doc + canvas-editor + canvas-sync suites**

```
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks/canvas-editor && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks/canvas-sync && ~/.bun/bin/bun test.ts
```

Expected: all pass. `canvas-sync`'s convergence/fuzz/soak rigs generate props
that are already schema-valid (`canvas-sync/src/rig/ops.ts` `randomProps` emits
`color`/`size`/`tags`/`z` onto `looseObject` schemas), so they should be
unaffected. **If a rig fails, STOP and report — do not loosen the schema.**

**Step 6: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "fix(canvas-doc): validate the merged result on updateProps"
```

---

**Half (A) is complete here — but the work is not.** Continue to Task 5; half
(B) is in scope by owner ruling 4, and it carries most of the risk reduction
(half (A) does nothing about invalid props arriving through `doc.import`). Only
skip to Task 9 if half (B) has proved worse than expected AND you have stopped
and reported first.

---

## Task 5: Make `dropShape` proportionate in the pure model

> **This task deliberately rewrites tests that currently pin the cascade as
> correct** (`canvas-model/src/repair.test.ts:37-58`). That is an **intended
> behaviour change with owner sign-off** (ruling 4, 2026-07-20) — not a
> regression, and not a failing test being papered over. The old assertions
> encoded the defect this branch exists to fix. Reviewers: the correct check is
> that the *new* assertions describe proportionate repair and that
> `applyRepairToModel` still agrees with `LoroCanvasDoc.repair()`, **not** that
> the old assertions survived.

**Files:**
- Modify: `canvas-model/src/repair.ts` (`opFor` comment, `repairPlan`,
  `applyRepairToModel`, delete `cascadeDropSet`)
- Modify: `canvas-model/src/repair.test.ts` (the cascade assertions this
  deliberately changes)

**Step 1: Write the failing test**

Add to `canvas-model/src/repair.test.ts`, immediately **after** the existing
"Cascade fixpoint (3 levels)" block (which ends around line 58 with
`'invariant-clean after ONE pass'`):

```ts
// PROPORTIONALITY (2026-07-19). A `validProps` violation removes ONLY the
// offending shape; its children are rescued to the canonical page root rather
// than executed alongside it. Rationale: a frame with one bad numeric prop
// must not take its innocent contents with it, and Loro tombstones make the
// loss unrecoverable. The rescue target is canonicalPageId — the same
// deterministic target reparentToRoot uses — so repair stays a pure function
// of converged state.
const rescue = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:badf', kind: 'frame', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:kid', kind: 'note', parentId: 'shape:badf', props: {}, ...base() } as any,
    { id: 'shape:grandkid', kind: 'note', parentId: 'shape:kid', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const rescuePlan = repairPlan(rescue)
assert.deepEqual(rescuePlan, [{ op: 'dropShape', id: 'shape:badf' }], 'only the invalid shape is in the plan')
const rescued = applyRepairToModel(rescue, rescuePlan)
assert.deepEqual(
  rescued.shapes.map((s) => s.id).sort(),
  ['shape:grandkid', 'shape:kid'],
  'the children survive — only the invalid shape is removed',
)
assert.equal(rescued.byId.get('shape:kid')!.parentId, 'page:p', 'the direct child is rescued to the canonical page')
assert.equal(rescued.byId.get('shape:grandkid')!.parentId, 'shape:kid', 'a grandchild keeps its (surviving) parent')
assert.deepEqual(checkInvariants(rescued), [], 'invariant-clean after ONE pass')

// Zero-page doc: there is no rescue target, so the drop is SUPPRESSED and the
// violation is left standing — exactly the policy repairPlan already applies
// to reparentToRoot. Emitting a drop we cannot apply proportionately would be
// the same disproportionate deletion by another route.
const noPage = makeDocument({
  pages: [],
  shapes: [
    { id: 'shape:badnp', kind: 'note', parentId: 'shape:badnp', props: {}, ...base(), opacity: 'no' as any } as any,
  ],
  bindings: [],
})
assert.deepEqual(repairPlan(noPage), [], 'a zero-page doc emits no dropShape (no rescue target)')
```

Then **change** the existing cascade block above it — this is the deliberate
behaviour change, not a regression. Replace its two `assert`s that pin the
cascade:

```ts
assert.deepEqual(chainRepaired.shapes.map((s) => s.id), ['shape:ar2'], 'bad2, child AND grandchild all dropped')
assert.deepEqual(chainRepaired.bindings, [], 'binding touching the cascaded grandchild dropped too')
```

with:

```ts
// CHANGED 2026-07-19 (proportionality): dropping bad2 no longer cascades.
// `child` is rescued to the canonical page, `grandchild` keeps `child` as its
// parent, and binding:g — whose endpoints (ar2, grandchild) BOTH still exist —
// survives with them.
assert.deepEqual(
  chainRepaired.shapes.map((s) => s.id).sort(),
  ['shape:ar2', 'shape:child', 'shape:grandchild'],
  'only bad2 is dropped; child and grandchild are rescued',
)
assert.equal(chainRepaired.byId.get('shape:child')!.parentId, 'page:p', 'child rescued to the canonical page')
assert.deepEqual(chainRepaired.bindings.map((b) => b.id), ['binding:g'], 'a binding whose endpoints both survive is kept')
```

Also rename the block's leading comment from "Cascade fixpoint (3 levels)" to
"Chain under a dropped shape (3 levels)" and delete its sentence about
`cascadeDropSet` needing to be a true fixpoint — that function is about to be
removed.

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected: FAIL at `only bad2 is dropped; child and grandchild are rescued` —
actual will be `[ 'shape:ar2' ]`. **Record the verbatim output.**

**Step 3: Implement in `canvas-model/src/repair.ts`**

(a) Update `opFor`'s `validProps` case comment. Change the `RepairOp` union's
`dropShape` line (line 8) from:

```ts
  | { op: 'dropShape'; id: string } // invalid envelope/props (quarantine)
```

to:

```ts
  // Invalid envelope/props. Removes ONLY this shape; every shape whose
  // parentId is a dropped id is reparented to the canonical page root (see
  // applyRepairToModel). Deliberately NOT a subtree cascade: a container with
  // one bad prop must not execute its innocent contents, and Loro tombstones
  // make that loss unrecoverable.
  | { op: 'dropShape'; id: string }
```

(b) In `repairPlan`, suppress `dropShape` alongside `reparentToRoot` when there
is no page. Replace:

```ts
    if (o.op === 'reparentToRoot' && !canReparent) continue
```

with:

```ts
    // Both ops need a rescue target: reparentToRoot by definition, and
    // dropShape because it rehomes the dropped shape's children to the same
    // canonical page. With no page, leave the violation standing rather than
    // emit an op that could only be applied by deleting the children too.
    if ((o.op === 'reparentToRoot' || o.op === 'dropShape') && !canReparent) continue
```

(c) Update the `canReparent` comment two lines above to say it gates drops too.

(d) Delete `cascadeDropSet` entirely (lines 84-100 as of `0388900`, comment
included).

(e) Rewrite the drop half of `applyRepairToModel`. Replace:

```ts
  // Drop invalid shapes AND their descendants (cascade). The filter below runs
  // before the toRoot map, so a shape both cascade-dropped and reparent-flagged
  // is DROPPED — same precedence as repair()'s skip of reparent ops in dropAll.
  const dropAll = cascadeDropSet(doc.shapes, drop)
```

with:

```ts
  // Drop ONLY the named shapes. Their children are rescued below by the same
  // map that serves reparentToRoot — see the dropShape variant's comment for
  // why a cascade is the wrong response to one bad prop.
```

and change the `shapes` pipeline's `.filter((s) => !dropAll.has(s.id))` to
`.filter((s) => !drop.has(s.id))`, and its `.map(...)` from:

```ts
    .map((s) => (toRoot.has(s.id) ? { ...s, parentId: pageId } : s))
```

to:

```ts
    // A shape is rehomed to the canonical page either because it was flagged
    // (orphan/cycle) or because its parent was just dropped. Same target,
    // same determinism.
    .map((s) => (toRoot.has(s.id) || drop.has(s.parentId) ? { ...s, parentId: pageId } : s))
```

and the `bindings` line from `dropAll` to `drop`:

```ts
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !drop.has(b.fromId) && !drop.has(b.toId))
```

**Step 4: Run the test to verify it passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected: the file's final `ok:` line.

**Step 5: Prove `cascadeDropSet` has no remaining consumers except canvas-doc**

```
cd /home/stag/src/projects/ensembleworks && grep -rn "cascadeDropSet" --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Expected: **only** hits in `canvas-doc/src/loro-canvas-doc.ts` (its import on
line 5 and its use around line 357 plus two comment mentions). Task 6 removes
those. If you see any other consumer, STOP and report.

**Step 6: Run the canvas-model suite**

```
cd /home/stag/src/projects/ensembleworks/canvas-model && ~/.bun/bin/bun test.ts
```

Expected: all suites pass. (`canvas-doc` will be red until Task 6 — that is
expected and is why these are separate commits.)

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-model/src/repair.ts canvas-model/src/repair.test.ts
git commit -m "fix(canvas-model): dropShape rescues children instead of cascading"
```

---

## Task 6: Mirror proportionate drop in `LoroCanvasDoc.repair()`

`applyRepairToModel` and `LoroCanvasDoc.repair()` must never drift. Task 5
changed the reference; this task changes the Loro application to match.

> **As in Task 5, this rewrites cascade-pinning assertions on purpose**
> (`canvas-doc/src/repair.test.ts:89-92`). Intended behaviour change, owner
> sign-off 2026-07-20 (ruling 4). The assertions that must NOT be weakened are
> the model-agreement one (`repair.test.ts:187`) and the order-independence
> structure — those are the drift guards, and they must keep passing on their
> own merits.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`repair()`, import line)
- Modify: `canvas-doc/src/repair.test.ts` (the cascade assertions)

**Step 1: Observe the failure**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair.test.ts
```

Expected: FAIL. Task 5 already made this red — most likely at the
model-agreement assertion (`'model-agreement: Loro repair == applyRepairToModel'`,
line 187) and/or the order-independence block. **Record the verbatim output.**

**Step 2: Write the direct proportionality test**

Add to `canvas-doc/src/repair.test.ts`, after the existing "Same-pass binding
cascade" block:

```ts
// PROPORTIONALITY through Loro (2026-07-19), the exact reported defect: one
// bad prop on a frame must not execute the frame's contents, and must not wipe
// their text containers.
const doc6 = LoroCanvasDoc.create({ peerId: 6n })
doc6.putPage({ id: 'page:p', name: 'P' })
doc6.putShapeUnchecked({ id: 'shape:f6', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as any)
doc6.putShape({ id: 'shape:k6', kind: 'note', parentId: 'shape:f6', props: {}, ...base() } as any)
doc6.putShape({ id: 'shape:gk6', kind: 'note', parentId: 'shape:k6', props: {}, ...base() } as any)
doc6.setText('shape:k6', 'precious content')
doc6.commit()

const plan6 = doc6.repair()
doc6.commit()
assert.deepEqual(plan6, [{ op: 'dropShape', id: 'shape:f6' }])
assert.deepEqual(
  doc6.listShapes().map((s) => s.id).sort(),
  ['shape:gk6', 'shape:k6'],
  'the frame is gone; its contents survive',
)
assert.equal(doc6.getShape('shape:k6')!.parentId, 'page:p', 'the direct child is rescued to the canonical page')
assert.equal(doc6.getText('shape:k6'), 'precious content', 'the rescued child keeps its text container')
assert.deepEqual(checkInvariants(dumpModel(doc6)), [], 'ONE repair() call converges')
assert.deepEqual(doc6.repair(), [], 'still idempotent')
// The drift guard that matters: Loro's application equals the pure reference.
const before6 = dumpModel(doc6)
assert.deepEqual(normalize(before6), normalize(applyRepairToModel(before6, repairPlan(before6))))
```

If `normalize` / `base` / `dumpModel` are declared later in the file than your
insertion point, move your block below their declarations rather than
duplicating them.

**Step 3: Update the existing cascade assertions in the same file**

The block seeded at lines 89-92 (`shape:ar4` / `shape:grandchild4` /
`shape:child4` / `shape:bad4`) pins the old cascade. Update its expectations the
same way Task 5 updated `canvas-model/src/repair.test.ts`: `child4` and
`grandchild4` now survive, `child4`'s `parentId` becomes `page:p`. Leave the
model-agreement assertion (line 187) and the order-independence structure
**untouched** — they must keep passing on their own merits.

**Step 4: Implement in `canvas-doc/src/loro-canvas-doc.ts`**

(a) Drop `cascadeDropSet` from the import on line 5:

```ts
import { canonicalPageId, repairPlan, stableStringify, validateShape, type Binding, type Page, type RepairOp, type Shape } from '@ensembleworks/canvas-model'
```

(b) In `repair()`, replace the `dropAll` computation and its comment block
(lines ~344-357) with:

```ts
    // The ids the plan drops. NOT a descendant closure any more: a dropShape
    // removes only the named shape and rehomes its children to the canonical
    // page (see canvas-model's applyRepairToModel — the pure reference this
    // must agree with byte-for-byte). Two uses:
    // 1. Skip-set: a reparentToRoot op whose id is also dropped is SKIPPED, so
    //    plan-application order can never matter.
    // 2. Binding sweep: a binding whose endpoint is dropped becomes dangling
    //    MID-pass (it wasn't when the plan was computed, so the plan has no
    //    deleteBinding op for it); delete it here so a SINGLE repair() call
    //    converges — not only the second.
    const dropped = new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id))
    // repairPlan emits no dropShape or reparentToRoot for a zero-page doc, so
    // this is defined whenever either branch below runs; the fallback is
    // dead-code safety only.
    const rootPageId = canonicalPageId(model.pages) ?? 'page:orphans'
```

(c) Replace the `dropShape` branch (line ~367) with:

```ts
      else if (o.op === 'dropShape') {
        for (const n of this.nodesByShapeId(o.id)) {
          // RESCUE FIRST, DELETE SECOND. deleteNode cascades over the REAL
          // subtree and clears every descendant's text container, so every
          // physical child must be out of that subtree before it runs. Each
          // child is moved to the Loro root and stamped with the canonical
          // page id — exactly what applyRepairToModel does to any shape whose
          // parentId is a dropped id.
          // Children that are THEMSELVES dropped are rescued here too and then
          // removed by their own turn in this loop; that makes the result
          // independent of the order the plan's dropShape ops are visited in.
          for (const c of [...(n.children() ?? [])]) {
            this.tree.move(c.id, undefined)
            c.data.set('parentId', rootPageId)
          }
          this.deleteNode(n)
        }
      }
```

(d) In the `dedupeShape` branch, the `dropAll.has(o.id)` guard becomes
`dropped.has(o.id)`. Replace its comment with:

```ts
        if (dropped.has(o.id)) {
          // Unreachable from repairPlan (dropShape SUBSUMES dedupeShape for the
          // same id, so the two never coexist in a plan) and, since drops no
          // longer cascade, no longer reachable via a cascade either. Kept as
          // dead-code safety for hand-built plans: if the id is model-dead,
          // remove every physical copy rather than electing a winner the model
          // would not keep.
          for (const n of this.nodesByShapeId(o.id)) this.deleteNode(n)
        } else {
```

(e) In the `reparentToRoot` branch, change `dropAll.has(o.id)` to
`dropped.has(o.id)`, and replace its two local lines computing `pageId` with a
use of `rootPageId`:

```ts
      else if (o.op === 'reparentToRoot') {
        if (dropped.has(o.id)) continue // this id is being dropped outright — see above
        for (const n of this.nodesByShapeId(o.id)) {
          this.tree.move(n.id, undefined) // page id ⇒ Loro root
          n.data.set('parentId', rootPageId)
        }
      }
```

(f) In the binding sweep, change both `dropAll.has(...)` to `dropped.has(...)`.

**Step 5: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair.test.ts
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
```

Expected: all pass, including the model-agreement assertion.

**Step 6: Run the convergence rig — the cross-peer determinism proof**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/convergence.test.ts
```

Expected: pass. This is the assertion that would catch a repair that is no
longer a pure function of converged state. **If it fails, STOP and report — do
not adjust the rig.**

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/repair.test.ts
git commit -m "fix(canvas-doc): repair() rescues a dropped shape's children instead of cascading"
```

---

## Task 7: Pin the end-to-end defect as a regression test

The reported defect is a *sequence*: bad write → repair → data loss. Tasks 2, 4
and 6 each close one link. This task asserts the whole sequence is dead, so a
future change that reopens any one link fails loudly and legibly.

**Files:**
- Modify: `canvas-doc/src/write-validation.test.ts`

**Step 1: Write the test**

Append, before the final `console.log`:

```ts
// --- REGRESSION: the reported defect, end to end ---
// updateProps(frameId, { w: '100' }) used to silently delete the frame AND
// every shape inside it, on every peer, durably (Loro tombstones make it
// unrecoverable). Two independent guards now stand in the way: the write is
// rejected at the boundary (Tasks 2/4), and even if it arrives from a remote
// peer that skipped that boundary, repair() removes only the frame (Task 6).
{
  const doc = LoroCanvasDoc.create({ peerId: 9n, onInvalidWrite: () => {} })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)
  doc.putShape({ id: 'shape:c1', kind: 'note', parentId: 'shape:f', props: {}, ...base() } as never)
  doc.putShape({ id: 'shape:c2', kind: 'note', parentId: 'shape:c1', props: {}, ...base() } as never)
  doc.setText('shape:c1', 'precious content')
  doc.commit()

  // GUARD 1 — origination.
  doc.updateProps('shape:f', { w: '100' })
  doc.commit()
  assert.deepEqual(doc.repair(), [], 'the bad write never landed, so repair has nothing to do')
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:c1', 'shape:c2', 'shape:f'])
  assert.equal(doc.getText('shape:c1'), 'precious content')

  // GUARD 2 — proportionality, given the write DID land (a remote peer's bytes).
  const stillValid = doc.getShape('shape:f')!
  doc.putShapeUnchecked({ ...stillValid, props: { w: '100', h: 100 } } as never)
  doc.commit()
  const plan = doc.repair()
  doc.commit()
  assert.deepEqual(plan, [{ op: 'dropShape', id: 'shape:f' }])
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:c1', 'shape:c2'], 'the contents survive the frame')
  assert.equal(doc.getText('shape:c1'), 'precious content', 'and keep their text')
}
```

**Step 2: Run it**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: `ok: write-validation`.

This test is a **characterisation** test of work already done, so it is green on
first run by design — that is not a RED-first violation. To satisfy yourself it
has teeth, temporarily revert one guard (comment out the `if (!v.ok)` early
return in `updateProps`), re-run, observe the failure, restore. Record that
observation.

**Step 3: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/write-validation.test.ts
git commit -m "test(canvas-doc): pin the frame-cascade data-loss defect end to end"
```

---

## Task 8: Refresh the stale comments the change invalidated

Several comments in these files now describe behaviour that no longer exists.
Leaving them is worse than having no comment.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (`repair()` JSDoc, `deleteShape` JSDoc)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`deleteNode` comment if it
  overclaims)

**Step 1: Update `repair()`'s JSDoc**

In `canvas-doc/src/canvas-doc.ts` (lines ~74-89), the phrase
"drop shapes with invalid props (cascades to their subtree AND to bindings whose
endpoint drops in the same pass)" is now wrong. Replace that clause with:

```
   * drop shapes with invalid props — removing ONLY the offending shape and
   * rehoming its children to the canonical page root, never cascading over
   * its subtree (one bad prop must not execute a container's contents) — and
   * delete bindings whose endpoint drops in the same pass.
```

**Step 2: Check `deleteShape`'s JSDoc is still accurate**

`deleteShape` (line ~35) documents a cascade. That is **still true and must
remain true** — a user deleting a frame does mean to delete its contents. Do not
change it. Add one clarifying sentence so the asymmetry is not read as a bug:

```
   * (Unchanged by the repair-proportionality work: an EXPLICIT delete cascades
   * on purpose — deleting a frame means deleting what's in it. Only repair()'s
   * automatic response to invalid props stopped cascading.)
```

**Step 3: Verify no stale "cascade" claim survives**

```
cd /home/stag/src/projects/ensembleworks && grep -rn "cascade" --include='*.ts' canvas-model/src canvas-doc/src | grep -v '\.test\.ts'
```

Read each remaining hit and confirm it describes either `deleteShape`'s
intentional cascade or `dedupeShapeNodes`'s child-rescue — not `dropShape`.
Fix any that still describe a `dropShape` cascade.

**Step 4: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts
git commit -m "docs(canvas-doc): correct the repair/delete cascade contracts"
```

---

## Task 9: Full verification

**Step 1: Typecheck all 13 workspaces**

```
cd /home/stag/src/projects/ensembleworks && bun run typecheck
```

Expected: exit 0, no errors.

**Step 2: Full test suite**

```
cd /home/stag/src/projects/ensembleworks && UX_CONTRACT_PR_BODY='ux-contract: none — confined to canvas-model/canvas-doc' bun run test
```

> **Known inherited failure — `scripts/ux-contract-presence.test.ts`.** This
> gate **already fails at commit `aa6a115`**, before any task in this plan was
> implemented. The cause is inherited from PR 48, which is in this branch's
> stack: its changes to `client/src/canvas-v2/` (`CanvasV2App.tsx`,
> `boot-sync-ready.test.ts`, `bootstrap-page.ts`) touch an interaction-bearing
> path, and the gate requires a `ux-contract: none — <reason>` marker in the PR
> body to cover them.
>
> This is **not** caused by any task here — this plan's own files
> (`canvas-doc/`, `canvas-model/`) are correctly *not* interaction-bearing
> surfaces, and Task 1's three files were verified to pass the gate cleanly.
>
> Handle it deliberately: the marker in the PR body (see below) covers the
> inherited PR-48 files. Do **not** "fix" it by editing
> `scripts/ux-contract-presence.test.ts`, by reverting PR-48 files, or by
> declaring a contract for `canvas-doc`. If the gate fails for any file
> *outside* that inherited set, STOP and report — that would be a real
> violation, not this known one.

Expected: every suite passes **except** the known inherited
`ux-contract-presence` failure described above. Pay particular attention to:

- `canvas-sync/src/convergence.test.ts` — cross-peer repair determinism.
- `canvas-sync/src/fuzz.test.ts` — its `malformedFrames` count is **pinned to
  an exact number** for `SEED=1`. This work changes no wire format and no frame
  decoding, so that number must be unchanged. If it moved, STOP and report.
- `canvas-sync/src/soak-smoke.test.ts`.
- `server/src/canvas-v2/*` — the actor/store/crash-recovery suites exercise the
  real load path.
- `scripts/exposure-audit.test.ts` and `scripts/ux-contract-presence.test.ts`.

**Step 3: Clean-room boundary**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/boundary.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-editor/src/boundary.test.ts
```

Expected: both print their `ok: boundary` line.

**Step 4: Perf sanity**

Run the branch's perf harness (see `docs/` for the current invocation on
`perf/v2-first-shape-harness`; it is the load/first-shape harness added by
PR 50). Confirm nothing trips a hard gate. Expected impact per decision D6:
~+4.4 µs per `putShape`, ~+15% on that call alone, ~4.4 ms on a 1000-shape bulk
load — inside noise. **Do NOT rewrite baselines** (`EW_CAPTURE`) to make a
number pass; if a gate trips, report it with the measured delta.

**Step 5: Confirm the working tree is clean and the branch is right**

```
cd /home/stag/src/projects/ensembleworks && git status --short && git log --oneline perf/v2-first-shape-harness..HEAD
```

Expected: clean tree; the commit list contains only this plan's commits, and
nothing was committed to `perf/v2-first-shape-harness`.

---

## PR body — required content

**The `ux-contract` marker is REQUIRED for CI to pass** — and specifically to
clear a failure this branch **inherits**, not one it causes.
`scripts/ux-contract-presence.test.ts` already fails at `aa6a115` because PR 48
(in this branch's stack) touches `client/src/canvas-v2/` —
`CanvasV2App.tsx`, `boot-sync-ready.test.ts`, `bootstrap-page.ts`. The marker
below covers **those inherited files**. This plan's own work is confined to
`canvas-doc` and `canvas-model`, which are correctly not interaction-bearing
surfaces and would need no marker on their own.

The PR must include, verbatim:

```
ux-contract: none — this branch's own change is confined to canvas-model
(repair/invariants) and canvas-doc (the CRDT write boundary). It touches no tool
FSM, no renderer, and no client input surface, so there is no gesture to seed
and no interaction invariant to observe.

This marker additionally covers the client/src/canvas-v2/ files inherited from
PR 48 in this stack (CanvasV2App.tsx, boot-sync-ready.test.ts,
bootstrap-page.ts), which the presence gate flags on this branch's diff. Those
changes belong to PR 48, not to this work.
```

Plus:

- The verbatim RED output recorded for Tasks 1, 2, 4, 5 and 6, and the
  revert-and-observe note from Task 7.
- The behaviour change owners must know about (decision D5, accepted by ruling
  1): a shape rescued out of a dropped frame keeps its parent-relative `x`/`y`
  and will therefore appear at a different on-screen position. It is still
  strictly better than being deleted, and it matches `reparentToRoot`'s existing
  behaviour for orphan and cycle repair. Coordinate-preserving rescue is a
  recorded follow-up.
- A note that `cascadeDropSet` was removed from `@ensembleworks/canvas-model`'s
  public exports (approved by ruling 2 — internal workspace package, no external
  consumers).
- A note that Tasks 5 and 6 intentionally rewrote tests which previously pinned
  the subtree cascade as correct, under owner ruling 4 — those assertions
  encoded the defect, and their replacement is the point of the branch.

## Reviewer obligations

The reviewer verifies the red-then-green evidence **independently** — revert
each fix, observe the failure, restore. Never accept the implementer's report of
it. Specifically worth re-deriving by hand:

1. That `LoroCanvasDoc.repair()` and `applyRepairToModel` still agree, by
   running `canvas-doc/src/repair.test.ts:187` and
   `canvas-sync/src/convergence.test.ts` after temporarily reverting **only**
   the canvas-doc half of Task 6 (they must fail).
2. That the new `repair()` remains a pure function of converged state — no
   traversal order, no container iteration order, no clock, no randomness enters
   the rescue path.
