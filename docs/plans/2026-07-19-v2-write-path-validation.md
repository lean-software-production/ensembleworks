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

### Cross-referencing comments must be verified — this branch has a track record

**Rule.** Any comment that asserts a fact about code **elsewhere in the repo** —
a call site, a file path, a line number, a count, a "the only X" claim, a
quantitative figure — **must be verified against the source before it is
written**, and the verification named in the task report ("grepped X, found N",
"ran a probe, got Y"). Prose that merely explains the *local* code needs no such
check.

**This is a defect class here, not a nicety.** This branch has produced **four**
false comments:

| Claim | Reality | Origin | Caught |
|---|---|---|---|
| "the only non-test console call in [four packages]" | there are three | a review, relayed through the plan | after landing |
| the powers-of-two log-volume figures | wrong arithmetic | the plan | after landing |
| "reaches the undo stack via import() **or** fromSnapshot" | one route, not two; the second is impossible client-side | an instruction, recorded into the plan | after landing |
| a fourth | — | — | in review, before landing |
| "`-0` round-trips faithfully through Loro" | Loro normalizes `-0` → `+0` | **the plan's own measurement table** | **before landing** |

Every one was a **confident factual assertion that nobody executed**, and four
of the five originated in *this plan or in the instructions driving it* — not in
an implementer's own work. So:

- **Implementers:** a plan sentence asserting a cross-file fact is not
  authority. Verify it, and say so. If it is wrong, report it rather than
  transcribing it faithfully — faithful transcription is how three of these
  shipped.
- **Reviewers:** treat a cross-referencing comment as something to check, at the
  same level as a test assertion. "The comment reads plausibly" is not review.

The cheapest version of this is usually one `grep`. Two of the five above would
have died to a single command.

#### The rule works — first outing, 2026-07-20

Entry 5 was caught **before landing**, by a Task 4N implementer who re-verified a
claim their brief handed them as established fact. Two things make it the best
argument for the rule as written:

- **It came from the plan's own measurement table** — a section whose entire
  purpose was to be the verified evidence. Measured claims are not exempt; a
  probe can be run correctly and still measure the wrong thing.
- **It was wrong because the measurement instrument was lossy**, not because
  nobody measured. So "I ran a probe" is not sufficient in a task report:
  say *how* you compared, because that is where this one failed.

This is also why the rule points at **plan text** as much as at implementer work.
Four of the five entries originated upstream of the implementer. An implementer
who transcribes faithfully is doing exactly what the fourth entry's implementer
did — and that is how three of these shipped.

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

---

## Why write validation cannot lose data — the structural argument

**This is the core safety argument for the whole branch.** It is more durable
than any test list, so read it before worrying about whether the new validation
is too aggressive.

The predicate that **rejects** a write and the predicate that **destroys** a
shape are *the same function*:

```
canvas-model/src/invariants.ts:16   const v = validateShape(s)
                                    if (!v.ok) push({ rule: 'validProps', … })
                                              │
canvas-model/src/repair.ts:24                 ▼
                                    case 'validProps': return { op: 'dropShape', id }
```

`putShape` and `updateProps` now reject on `validateShape` — the identical call.
So **anything the write boundary rejects is exactly something `repair()` would
have destroyed anyway**, on every peer, durably, taking the subtree with it
(pre-Task-5) and leaving Loro tombstones behind.

The consequence is worth stating as a standalone claim:

> **Over-eagerness cannot lose data the pre-fix code preserved.** The worst case
> for a false positive is converting *"write it, then cascade-delete the subtree
> everywhere, permanently"* into *"never write it."* There is no input for which
> the old behaviour retained something the new behaviour discards.

### The argument depends on a test, not on the predicate alone — read this

**Status: the argument above is sound, unqualified — as of Task 4N (`b5031d0`).**
It was *not* sound before that, and the reason is worth keeping visible rather
than quietly deleting, because it identifies what the guarantee actually rests
on.

The two predicates are the same *function*, but until Task 4N they were applied
to **different values**: `putShape`/`updateProps` validated the *pre*-
serialization JS object, while `repair()` judges what Loro *stored*. Loro
coerces `undefined` to `null`, and `z.number().optional()` accepts `undefined`
but rejects `null` — so this passed the boundary and then failed on read-back:

```
updateProps('shape:f', { w: undefined })  →  ACCEPTED, invalidWriteCount = 0
stored props   : {"w":null,"h":100}
validateShape  : INVALID (expected number, received null)
repairPlan     : [{ op: 'dropShape', id: 'shape:f' }]   ← the frame AND every child
```

**That is the original defect, reproduced through the freshly hardened call
site** — which is worse than an unhardened one, because the code claims to be
safe. `putShape` had the identical hole (pre-existing from Task 2, not
introduced by Task 4), and it extends to **envelope fields** as well as props:
`x: undefined` stores `x: null` and fails read-back the same way.

**Task 4N closed it** (`b5031d0`) by validating the post-serialization form via
`asStored`, so both predicates now see the same value and the structural
argument holds without qualification.

> **What the guarantee now rests on.** "Same predicate" is only true while
> `asStored` matches Loro's actual coercion. Nothing in the type system enforces
> that — **`canvas-doc/src/serialization-seam.test.ts`'s drift guard does**, by
> asserting `deepEqual(asStored(probes), stored)` against a real write and
> read-back. If Loro's coercion changes, that test fails; if someone weakens the
> test, the boundary silently reopens and this whole section becomes false
> again without anything else changing.
>
> So: **treat that drift guard as load-bearing infrastructure, not as a unit
> test.** It is the reason the argument above can be stated flatly.

Not reachable from production as written: the reviewer tried and failed to build
a live path (the screenshare relock write is guarded by
`if (!(videoWidth > 0) || !(videoHeight > 0)) return null`, and the other embed
writes pass concrete values). A completeness gap, not a live defect — but the
same failure mode the branch exists to close, and it reached a *freshly hardened*
call site, which is worse than an unhardened one because the code claimed to be
safe.

That is why this branch does not need an exhaustive proof that validation never
fires on legitimate shapes: the failure mode of being wrong is strictly bounded
by the failure mode it replaces.

### Empirical confirmation (spec review, 2026-07-20, executed not reasoned)

Driving the **real tool FSMs** produced **zero rejections**:

- click-create and drag-create for all four `CreateKind`s
- the arrow tool's `StartArrow`
- the transform path
- the undo/redo `replay()` path
- 29 golden fixtures — 0 invalid

Full suites green: `canvas-editor` 15/15, `canvas-sync` 11/11 (including the
fuzz rig's `randomShape` corpus), `server/src/canvas-v2` 7/7 — which covers the
`fromTldraw` → `reconcile.ts:77` `doc.putShape(s)` path. `bridge.ts loadModel`
has no production callers.

---

## Design decisions (settled — do not re-open during implementation)

### D1. "Reject" means a counted, logged **no-op** — never a throw.

**Decision.** An invalid `putShape` or `updateProps` writes nothing at all,
increments `LoroCanvasDoc.invalidWriteCount`, and reports through an injected
`onInvalidWrite` callback (defaulting to a **bounded** `console.warn`). It does
not throw and does not partially write.

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
observability, and **all three** halves are mandatory:

1. `LoroCanvasDoc.invalidWriteCount` — a monotonic, test-assertable counter,
   modelled on the existing `SyncServerPeer.malformedFrames`
   (`canvas-sync/src/server-peer.ts:67`).
2. `onInvalidWrite(w: InvalidWrite)` — an optional injected callback. When it is
   absent the doc emits a **bounded** `console.warn` (first 5 rejections only)
   carrying the op, the shape kind, the shape id, and the verbatim zod error.
3. **A pull path that actually reaches a human** — the client peer forwards the
   sink, and the v2 `DevOverlay` renders the count. Task 4A.

`updateProps` already has a documented silent-no-op contract for an unknown id
(`canvas-doc/src/canvas-doc.ts:28`), so "no-op on invalid" is contract-
consistent rather than novel.

#### D1a. A counter is not observability — the pull path is (code review, 2026-07-20)

The `malformedFrames` precedent cited above was originally cited too loosely,
and the correction matters. `SyncServerPeer.malformedFrames` is a **pure**
counter with no console output at all. It is observable because
`server/src/features/canvas-metrics.ts:81` pulls it into `/canvas/metrics` and
DevOverlay renders it. **The counter was never the observability mechanism
there — the pull path was.** Task 1 as landed copied the counter and substituted
a console line for the pull path, which is not the same thing.

Worse, the injected sink is currently **unreachable in the browser**:
`SyncClientPeer` builds its own doc internally
(`canvas-sync/src/client-peer.ts:50`, `LoroCanvasDoc.create({ peerId: opts.peerId })`),
`SyncClientOpts` has no `onInvalidWrite` field, and
`client/src/canvas-v2/CanvasV2App.tsx:349` constructs the *peer*, not the doc.
Since essentially every client-side rejection originates via `Editor.applyAll` →
`putShape`, `console.warn` is not a fallback on the client — it is the *only*
production behaviour. **Task 4A closes this.**

#### D1b. The default sink must be bounded

CLAUDE.md records that v2 commits at **per-pointermove granularity**. Combined
with D1a (console is the only client path today), a tool emitting an invalid
`updateProps` during a drag yields roughly **60 `console.warn`s per second,
indefinitely** — DevTools-hang grade, and it buries the first warning, which is
the diagnostically valuable one.

So the default sink logs on **powers of two only** — #1, #2, #4, #8, #16, … —
with the rejection's ordinal stamped into the line as `[#n]`. The **counter
stays exact** regardless, which is precisely why the counter and the log are
separate mechanisms rather than one.

> **Superseded (2026-07-20, Task 1A review finding 4).** This originally
> prescribed a lifetime cap of 5. That was wrong in a way worth recording,
> because the reasoning generalises: **a cap makes silence indistinguishable
> from health.** A developer who sees five warnings, undoes, and keeps working
> cannot tell whether that was five rejections or fifty thousand — the cap
> suppresses the flood *and the evidence that it was a flood*. It is also
> permanently silent afterwards, so a *different* bug an hour later never
> surfaces at all.
>
> Powers of two fix both: a ten-second 60/sec drag yields ~9 lines instead of
> 600, an hour of sustained garbage ~18, and the channel never closes. It
> preserves the first-warning-is-the-useful-one property better than the cap
> did, and needs no timer, no reset, and no extra state. The `[#n]` marker is
> independently load-bearing: it tells the reader they are seeing a **sample,
> not a census**. Keep it regardless of what mechanism ever replaces this one.

Precedent note, to be stated honestly in review: this `console.warn` is the
**only non-test `console.*` call across `canvas-doc`, `canvas-model`,
`canvas-sync` and `canvas-editor` combined.** It sets a precedent for those four
clean-room packages. Bounded, it is defensible; unbounded, it would not be.

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

### D3a. Undo/redo of a remotely-invalid shape is now a silent no-op

**A user-visible behaviour change, accepted, recorded here so it is never
debugged from scratch.**

`Editor.replay()` — the undo/redo path — replays `InverseOp`s by calling
`CanvasDoc`'s public mutators, and its `putShape` inverses carry **whole shapes
read back out of the doc** (see `editor.ts`'s "full-shape-inverse convention").
An already-invalid shape can therefore land on the undo stack. Replaying it now
hits the write boundary and is **silently dropped** rather than restored.

**There is exactly ONE route in: `import()`** — the only path into this peer's
doc that bypasses the write boundary. That single route covers both cases a
reader will think of:

- a **live remote peer** running older or buggy code, and
- a room whose **stored SQLite predates the write boundary** — the *server*
  loads such a room via `fromSnapshot` and relays it here as an ordinary
  `import()`.

> **Disambiguation, stated so nobody re-derives it.** This peer's own doc is
> **never** built by `fromSnapshot`. `canvas-sync/src/client-peer.ts` has exactly
> one `this.doc` assignment — line 50, an unconditional `LoroCanvasDoc.create`
> with no snapshot parameter — and exactly one ingestion path,
> `this.doc.import(payload)` at line 169. Both non-test `fromSnapshot` call sites
> (`server/src/canvas-v2/actor.ts:139`, `canvas-sync/src/server-peer.ts:82`) are
> server-side, and the server has no undo stack. The only production `Editor` is
> `client/src/canvas-v2/CanvasV2App.tsx:365`, built with `doc: peer.doc` from
> `SyncClientPeer`. *(All four facts verified against source, 2026-07-20.)*
>
> **CORRECTED 2026-07-20.** An earlier revision of this decision claimed two
> routes, naming `fromSnapshot` as a second, distinct one. That was false — one
> mechanism presented as two, with the second misnamed. It drove a false comment
> into `canvas-editor/src/editor.ts`, corrected at `792be65`. The pre-boundary
> *risk* is real; only the second mechanism was imaginary.
>
> **Do NOT propagate this correction to `canvas-doc/src/canvas-doc.ts`'s
> `putShape` JSDoc.** Its near-identical "or loaded from a pre-boundary
> snapshot" wording **is correct there**, because that sentence is scoped to
> `CanvasDoc.putShape` in general — not to the undo stack — and the server
> genuinely does load via `fromSnapshot`. Two similar sentences, one true and
> one false, and the difference is entirely one of scope. Check which one you
> are reading before editing it.

The user-visible symptom is *"my undo/redo did nothing"* for that shape.

**This is correct and deliberate.** Restoring it would re-manufacture exactly
the state `repair()` is obliged to destroy — the write boundary would be
laundering invalid data back into the doc through the one path that bypasses
the writer's own intent. Dropping it is the same judgement `replay()` already
makes for an inverse that cannot apply.

**The asymmetry that makes this safe** is worth spelling out, because it is the
mirror image of the reasoning behind D1's no-throw decision:

| Path | Guard | Consequence |
|---|---|---|
| `Editor.applyAll` (`editor.ts:249-256`) | **no** `try`/`catch` | a throw strands the batch's earlier mutations uncommitted — which is *why D1 forbids throwing* |
| `Editor.replay` (`editor.ts:343`) | per-op `try`/`catch`, documented TOLERANCE CONTRACT | an un-appliable op is skipped and the rest of the batch continues |

So `replay()` was **already** built to tolerate individual ops that cannot
apply; a rejected `putShape` is simply a new member of a category it already
handles. `applyAll` was not, which is precisely why rejection is a no-op rather
than a throw. One decision, two consequences.

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

- **The clean-room boundary test only guards one of the four packages.**
  (Noted 2026-07-20 during Task 1A spec review. **Pre-dates this branch — do NOT
  fix it here.**) `canvas-sync/src/boundary.test.ts` globs
  `**/*.ts` relative to `import.meta.dirname`, which is `canvas-sync/src`. So it
  would **not** catch a `from 'ws'`, `@tldraw/`, `Date.now(` or `Math.random(`
  violation in `canvas-doc`, `canvas-model`, or `canvas-editor` — even though
  CLAUDE.md describes all four packages as protected by this rule.
  `canvas-editor` and `canvas-react` do have their own boundary tests;
  `canvas-doc` and `canvas-model` have none at all. The enforcement gap is
  repo-wide and belongs in its own change, not smuggled into a data-loss fix.
  Until it is closed, the rule is upheld by convention in those two packages —
  which is exactly why this plan states the forbidden literals explicitly rather
  than relying on CI to catch them.

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

### Ruling 5 — Task 1 code-review findings (2026-07-20): **all four accepted.**

Task 1's implementation was reviewed ✅ APPROVED with four findings, two of
which the reviewer judged to be gaps in **this plan** rather than in Task 1's
execution. All four are accepted and folded in:

| # | Finding | Where it now lives |
|---|---|---|
| 1 | The injected sink is unreachable in the browser; a counter is not a pull path | D1a + **Task 4A** |
| 2 | The default `console.warn` is unbounded on a per-pointermove path | D1b + **Task 1A** |
| 3 | `InvalidWrite` needs `kind` — `id` is a non-greppable nanoid and envelope failures never name the kind | **Task 1A** |
| 4 | `invalidWrites: number` collides confusingly with the `InvalidWrite` type | **Task 1A** |

Because **Task 1's code is already committed** (`527c2a3`), findings 2–4 cannot
be applied by editing Task 1's text. Task 1A applies them as a RED-first delta;
Task 1's own section carries a forward pointer so the two never read as
contradictory.

### Ruling 7 — Task 1A code-review findings (2026-07-20): **six accepted, one moot.**

Task 1A's implementation returned ❌ CHANGES NEEDED from quality review. All
applied in **Task 1B**:

| # | Finding | Disposition |
|---|---|---|
| 1 | The `'<unknown>'` promise is unenforced; `rejectWrite` takes any `string` | **blocking** — coerce centrally from the offending value |
| 2 | Narrow `kind` to `ShapeKind \| '<unknown>'` | accepted, **only** paired with 1 |
| 3 | `writeRejections` → `invalidWriteCounter` (`repairCounter`/`repairCount` pattern) | accepted |
| 4 | Lifetime cap of 5 → powers-of-two logging with an `[#n]` ordinal | **blocking** |
| 5 | Cut the naming-rationale comment and "Do not lift the cap" | accepted |
| 6 | Extract a `WARN_CAP` constant | **moot** under 4 — do not add one |
| 7 | Log line reads as three bare tokens → `${op} (${kind}) ${id}` | accepted |

Also corrected here: an earlier claim that `clientCount` was a field-naming
precedent. It is not — `canvas-sync/src/server-peer.ts:76` is a getter over
`this.clients.size` with no backing counter. The sole precedent is
`repairCounter` / `repairCount`.

### Ruling 8 — Task 2 code-review findings (2026-07-20): **all five accepted.**

| # | Finding | Where |
|---|---|---|
| 1 | **CRITICAL** — a throwing `onInvalidWrite` escapes `putShape`, reopening the exact hole D1 exists to close | **Task 3A** |
| 2 | `reconcile()` cannot distinguish a refusal from a put, so it never converges on legacy rooms | **Task 4B** |
| 3 | `replay()`'s TOLERANCE CONTRACT comment omits `putShape`'s new silent-skip mode | **Task 3A** step 5 + D3a |
| 4 | `id` coercion belongs in `rejectWrite`, not duplicated per call site (and must catch `''`) | **Task 3A** |
| 5 | `putShapeUnchecked`'s JSDoc falsely implies production cannot reach it | JSDoc in **Task 3A**, CI gate in **Task 8A** |

Finding 5 explicitly **rejects** runtime machinery (symbol key, token argument,
separate `unsafe` module): all cost more than the bug they prevent, and the
clean-room constraint rules out the usual tricks. A presence-style CI gate is
the conventional answer here — the repo already has two.

### Ruling 9 — Task 4 review outcomes (2026-07-20)

| # | Finding | Disposition |
|---|---|---|
| 1 | `undefined` → `null` lets an invalid write pass **both** call sites, reproducing the original defect through the hardened path | **Task 4N** — option 3, validate the post-serialization form |
| 2 | `updateProps` JSDoc overclaims: healing works only for **props** invalidity, not envelope | Task 4N step 6(a) |
| 3 | `updateProps(id, {})` on an invalid shape is counted though it writes nothing | **Fixed** — Task 4N step 6(b); an empty patch is a no-op by definition |
| 4 | Zod abort-ordering hazard (below) | **Recorded, not fixed** |

### Ruling 10 — Latent hazard: `propsByKind` safety rests on Zod's abort ordering

**Recorded 2026-07-20. Do NOT fix on this branch.**

`canvas-model/src/shape.ts`'s `superRefine` does
`propsByKind[s.kind as ShapeKind].safeParse(s.props)`. For a shape whose stored
`kind` is garbage, `propsByKind[garbage]` is `undefined` and `.safeParse` would
throw a `TypeError`. It does not, because the envelope's `z.enum(SHAPE_KINDS)`
fails first and `superRefine` never runs.

So this is correct **by ordering, not by an explicit guard** — the kind of
correctness that survives until someone reorders the schema or makes `kind`
lenient. A one-line guard would make it structural. Out of scope here; it is a
`canvas-model` schema change with its own blast radius, and nothing on this
branch makes it more likely to fire.

### Ruling 6 — The optional third constructor parameter: **settled, leave it alone.**

Review explicitly confirmed that `LoroCanvasDoc`'s optional third positional
`private constructor` parameter is fine as-is: there are exactly two call sites,
both factories in the same file, so it cannot rot from outside the module. Do
**not** refactor it into an options object. Recorded here so it is not
re-opened.

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

Tasks 1, 1A, 1B, 2, 3, 3A, 4, 4A and 4B are half (A), origination. Tasks 5–8
are half (B), proportionality. Tasks 8A and 9 are integration. **All of them are
in scope** (rulings 4, 5, 7 and 8).

Lettered tasks were added after the plan was first written, so the many
"Tasks 2–9" references throughout this document stay valid:

| Task | Added | Source | Status |
|---|---|---|---|
| 1 | original | — | ✅ landed `527c2a3` |
| 1A | 2026-07-20 | Task 1 **quality** review (ruling 5) | ✅ landed `0a3ddd6`, 2 test sections deferred |
| 1B | 2026-07-20 | Task 1A **quality** review (ruling 7) | ✅ landed |
| 2 | original | — | ✅ landed `81fcc94` + `5060832` |
| 3 | original | — | ✅ landed `f93192f` |
| 3A | 2026-07-20 | Task 2 **quality** review (ruling 8) — findings 1, 3, 4, 5 | ✅ landed `d0e408c` + `792be65` |
| 4 | original | — | ✅ landed `d5a9237` |
| **4N** | 2026-07-20 | Task 4 review (ruling 9) — the serialization seam | ✅ landed `b5031d0` |
| 4A | 2026-07-20 | Task 1 quality review, finding 1 (ruling 5) | ⬅ **start here** |
| 4B | 2026-07-20 | Task 2 quality review, finding 2 (ruling 8) | pending |
| 8A | 2026-07-20 | Task 2 quality review, finding 5 (ruling 8) — the CI gate | pending |

**Execution order is the table's order, not alphabetical:**
1 → 1A → 1B → 2 → 3 → 3A → 4 → **4N** → 4A → 4B → 5 → 6 → 7 → 8 → 8A → 9.
`4N` is lettered out of sequence deliberately: renaming the existing `4A`/`4B`
would break this document's many cross-references to them.

**Start at Task 4A.** Half (A)'s write boundary is complete and its central
safety claim is restored (Task 4N, `b5031d0`). What remains in half (A) is
observability: making rejections reachable and visible (4A, 4B).

The two halves are technically independent — (A) is strictly additive and
independently landable — which is what makes the fallback possible. If half (B)
proves worse than expected mid-execution, STOP after Task 4, report, and let the
owner decide; do not silently narrow the branch to half (A).

---

## Task 1: Add the invalid-write reporting surface (counter + hook)

> ### ✅ LANDED at `527c2a3` — AMENDED BY TASK 1A. Read this section as a record, not as instructions.
>
> Task 1 is implemented, spec-reviewed and quality-reviewed (✅ APPROVED, four
> findings — see ruling 5). **The code below is what actually landed, and three
> details of it are deliberately superseded by Task 1A:**
>
> | Shown below | Task 1A changes it to | Why |
> |---|---|---|
> | `get invalidWrites(): number` | `get invalidWriteCount(): number` | name collided with the `InvalidWrite` type (finding 4) |
> | `private invalidWriteCount = 0` | `private invalidWriteCounter = 0` | frees the good name for the getter |
> | `InvalidWrite { op, id, error }` | `InvalidWrite { op, kind, id, error }` | `id` is a non-greppable nanoid (finding 3) |
> | unbounded `console.warn` | bounded to the first 5 | per-pointermove flood (finding 2) |
>
> Do **not** edit this section's code blocks to match. Do **not** re-do Task 1.
> Go to Task 1A.

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

## Task 1A: Amend the landed reporting surface (review findings 2, 3, 4)

Task 1 landed at `527c2a3` and was approved with findings. This task applies
three of them as a single RED-first delta **before** Task 2, so Task 2's test is
written once against the final API instead of being written and then rewritten.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (`InvalidWrite` gains `kind`)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (getter rename, backing-field
  rename, bounded warn, populate `kind`)
- Modify: `canvas-doc/src/write-validation.test.ts`

### What changes and why

**Finding 4 — the name collision.** `invalidWrites` returns a `number` while a
type named `InvalidWrite` lives in the same module. Task 1's own test writes
`const seen: InvalidWrite[] = []` two lines above `doc.invalidWrites`, which is
genuinely confusable. House style splits both ways — `malformedFrames` and
`pendingImports` are plural-noun counters, but **neither has a co-existing
singular type**, whereas `repairCount` uses the unambiguous form.
The private field is already called `invalidWriteCount`, so promote that name to
the getter and rename the backing field to `writeRejections`. Exactly one test
line consumes the getter today — this is as cheap as it will ever be.
`rejectWrite` and `InvalidWrite` are both fine and do **not** change.

> **Correction (2026-07-20).** An earlier draft cited `clientCount` as a second
> precedent here. That was wrong: `canvas-sync/src/server-peer.ts:76` is
> `get clientCount(): number { return this.clients.size }` — a getter over a
> collection, with **no backing counter at all**, so it says nothing about
> field-naming. The only real precedent is `repairCount`, and it is a
> *paired* one — see Task 1B finding 3, which is why `writeRejections` above is
> itself superseded.

**Finding 3 — add `kind`.** `id` is a nanoid: meaningless across sessions and
not greppable. `error` embeds the shape kind **only** on the props-refinement
path (`invalid props for kind ${s.kind}: …`, `canvas-model/src/shape.ts:91`).
An **envelope** failure — a bad `index`, a missing `x` — produces a zod message
that never names the kind. So for exactly the class of failure where you most
want to know which shape type the buggy tool was emitting, the payload cannot
tell you. `putShape` has the shape in hand and `updateProps` can read the
existing node, so it is free at both call sites today — and a breaking interface
change once Tasks 2–4 and any dashboard consume it.

> **Do NOT** add structured zod issue paths while you are here. That would mean
> changing `ShapeValidation` in `canvas-model` too, and the flattened message is
> what the rest of the repo already consumes. `kind` only.

**Finding 2 — bound the default warn.** See decision D1b. The cap is 5; the
counter stays exact.

**Step 1: Write the failing test**

Replace the Task 1 section of `canvas-doc/src/write-validation.test.ts` with the
version below, and add the two new sections after it. (The Task 1 section only
changes in that it uses the new getter name.)

```ts
// --- Task 1/1A: the reporting surface exists, is named unambiguously, starts empty ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 1n, onInvalidWrite: (w) => seen.push(w) })
  assert.equal(doc.invalidWriteCount, 0, 'a fresh doc has rejected nothing')
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 0, 'a valid write is not counted as a rejection')
  assert.deepEqual(seen, [], 'a valid write does not fire the hook')
}

// --- Task 1A finding 4: the OLD getter name is gone, not merely aliased ---
{
  const doc = LoroCanvasDoc.create({ peerId: 11n })
  assert.equal(
    (doc as unknown as Record<string, unknown>).invalidWrites,
    undefined,
    'the old `invalidWrites` name is removed — it collided with the InvalidWrite type',
  )
}

// --- Task 1A finding 3: InvalidWrite carries `kind` ---
// Two cases, because they fail on DIFFERENT zod paths. The props case embeds
// the kind in the message anyway; the ENVELOPE case does not, and that is the
// case `kind` exists for.
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 12n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  // Props-refinement failure: kind IS in the message, and must also be a field.
  doc.putShape({ id: 'shape:a', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  assert.equal(seen[0]!.kind, 'frame', 'kind is reported on a props failure')

  // Envelope failure (index must be a non-empty string): the zod message never
  // names the kind, so the field is the ONLY way to know what was being built.
  doc.putShape({ id: 'shape:b', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
  assert.equal(seen[1]!.kind, 'note', 'kind is reported on an envelope failure too')
  assert.doesNotMatch(seen[1]!.error, /note/, 'precondition: the envelope error genuinely does not name the kind')
}

// --- Task 1A finding 2 (as revised by Task 1B): the default console.warn logs
// on POWERS OF TWO, and the counter is unaffected ---
{
  const warned: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }
  try {
    const doc = LoroCanvasDoc.create({ peerId: 13n }) // no handler -> console path
    doc.putPage({ id: 'page:p', name: 'P' })
    // v2 commits at per-pointermove granularity, so a bad drag emits ~60/s
    // indefinitely. 20 stands in for "a drag that lasted a third of a second".
    for (let i = 0; i < 20; i++) {
      doc.putShape({ id: `shape:bad${i}`, kind: 'frame', parentId: 'page:p', props: { w: 'x' }, ...base() } as never)
    }
    assert.equal(doc.invalidWriteCount, 20, 'the counter stays EXACT regardless of how little is logged')
  } finally {
    console.warn = realWarn
  }
  // Assert WHICH rejections logged, not merely how many. A lifetime cap of 5
  // and powers-of-two BOTH yield 5 lines at n=20 (1,2,4,8,16), so a
  // count-only assertion cannot tell them apart — it would pass against the
  // capped implementation this replaces.
  const ordinals = warned.map((line) => Number(/\[#(\d+)\]/.exec(line)?.[1]))
  assert.deepEqual(ordinals, [1, 2, 4, 8, 16], 'logs on powers of two only — never 3, 5, 6, 7')
  assert.ok(!ordinals.includes(3) && !ordinals.includes(7), 'explicitly: non-powers-of-two are silent')
  // The ordinal marker tells the reader they are seeing a SAMPLE, not a census.
  assert.match(warned[0]!, /\[#1\]/, 'each line carries its ordinal')
}
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL at the **first** assertion —
`AssertionError: a fresh doc has rejected nothing` (`undefined !== 0`), because
`invalidWriteCount` is currently the *private field*, not a getter, so reading it
from outside yields `undefined`.

Note that the later sections cannot even be reached yet: `putShape` does not
validate until Task 2, so nothing is rejected. That is expected — this task's
RED is the first assertion, and the finding-3 / finding-2 sections go green only
once Task 2 lands. **Record the verbatim output.**

> **This is the one place in the plan where a test's later sections stay red
> across a task boundary.** Do not treat that as "unreachable RED" and do not
> stop. After Step 3 the *first* section must pass. Sections asserting
> rejections go green in Task 2. If you would rather not carry a red file across
> two commits, run only the first section now and paste the rest in during
> Task 2 — but keep the assertions verbatim.

**Step 3: Implement**

In `canvas-doc/src/canvas-doc.ts`, add `kind` to `InvalidWrite` and update its
doc comment:

```ts
export interface InvalidWrite {
  op: 'putShape' | 'updateProps'
  /** The shape's `kind`. Carried as its own field because `id` is a nanoid —
   * meaningless across sessions and not greppable — and because `error` only
   * names the kind on the props-refinement path. An ENVELOPE failure (bad
   * `index`, missing `x`) produces a zod message that never mentions it, which
   * is exactly when you most want to know which tool was emitting what.
   * `'<unknown>'` when the rejected value is too malformed to have one. */
  kind: string
  id: string
  error: string
}
```

In `canvas-doc/src/loro-canvas-doc.ts`, replace the counter block:

> **⚠️ The block below is what LANDED at `0a3ddd6` and is SUPERSEDED by Task 1B**
> (quality review returned ❌ CHANGES NEEDED). Four of its details change:
> `writeRejections` → `invalidWriteCounter`, `kind: string` param → the offending
> `value: unknown`, the cap-of-5 → powers-of-two with an `[#n]` marker, and the
> comment block is cut down. Read it as history; implement Task 1B.

```ts
  // Monotonic count of locally-originated writes this doc refused (see
  // InvalidWrite). Never reset, and NEVER capped — unlike the console
  // fallback below, which is. Named `invalidWriteCount`, not `invalidWrites`:
  // a number-valued member one letter from the InvalidWrite TYPE in the same
  // module is a reliable misreading (house precedent: repairCount,
  // clientCount).
  private writeRejections = 0
  get invalidWriteCount(): number { return this.writeRejections }

  // Count, then report. A rejection is a NO-OP at the call site, so this is
  // the only trace it leaves.
  //
  // The console fallback is BOUNDED to the first 5. v2 commits at
  // per-pointermove granularity, so a tool emitting an invalid write during a
  // drag would otherwise produce ~60 warnings per second for as long as the
  // drag lasts — enough to hang DevTools, and it buries the FIRST warning,
  // which is the diagnostically useful one. The counter above stays exact, so
  // capping the log loses no information that anything actually reads.
  //
  // This is one of only three non-test console calls across canvas-doc,
  // canvas-model, canvas-sync and canvas-editor. The other two are
  // canvas-sync's malformed-frame warnings (client-peer.ts, server-peer.ts),
  // which are bounded in a different way: they fire per inbound FRAME, not per
  // pointermove, so they cannot reach this one's unbounded rate. Bounded it is
  // defensible; unbounded it would not be. Do not lift the cap.
  private rejectWrite(op: InvalidWrite['op'], kind: string, id: string, error: string): void {
    this.writeRejections++
    const write: InvalidWrite = { op, kind, id, error }
    if (this.onInvalidWrite) this.onInvalidWrite(write)
    else if (this.writeRejections <= 5) console.warn(`[canvas-doc] rejected invalid ${op} ${kind} ${id}: ${error}`)
  }
```

**Step 4: Run the test to verify the first section passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: the first section passes. Later sections still fail until Task 2 adds
validation — see the note in Step 2.

**Step 5: Typecheck**

```
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/canvas-doc' typecheck
```

Expected: exit 0. `rejectWrite` has no callers yet (Tasks 2 and 4 add them), so
its new `kind` parameter breaks nothing.

**Step 6: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "refactor(canvas-doc): add kind to InvalidWrite, bound the default sink, rename the counter"
```

### ✅ LANDED at `0a3ddd6` — with TWO OF FOUR test sections DEFERRED TO TASK 2

Task 1A is implemented and spec-reviewed. **The deferral sanctioned in Step 2
was taken.** Only two of Step 1's four test sections are committed at `0a3ddd6`:

| Section | Status at `0a3ddd6` |
|---|---|
| Task 1/1A — surface exists, starts empty | ✅ committed, green |
| Finding 4 — the old `invalidWrites` name is gone | ✅ committed, green |
| **Finding 3 — `kind` on the props AND envelope paths** | ⛔ **deferred — Task 2 owns it** |
| **Finding 2 — the warn cap (20 rejections → 5 warnings)** | ⛔ **deferred — Task 2 owns it** |

Both deferred sections need `putShape` to actually reject, which does not happen
until Task 2. **Task 2 Step 1 restores them verbatim and they are part of Task
2's RED.** If they are not restored, findings 2 and 3 ship with no proof at all
— see the explicit warnings in Task 2 Step 1.

**Quality review then returned ❌ CHANGES NEEDED — see Task 1B**, which revises
four details of what landed here. The finding-2 test section above has already
been rewritten in place for Task 1B's powers-of-two behaviour, so the copy
Task 2 restores is the correct one.

---

## Task 1B: Apply the Task 1A quality-review findings

Task 1A landed at `0a3ddd6` and passed **spec** review, but **quality** review
returned ❌ CHANGES NEEDED. Six findings were accepted (one was moot). This task
applies them as one RED-first delta.

### Why here rather than folded into Task 2

Finding 1 is cheap now and expensive later: Task 2 and Task 4 add the only two
`rejectWrite` call sites, so fixing the signature **before** they exist means
fixing it in one place instead of three. Finding 2 depends on finding 1. And
Task 2's RED is already carrying the two restored Task 1A sections — adding a
third concern to it would make an already-subtle RED unreadable.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` (`InvalidWrite.kind` type)
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`rejectWrite`, counter field, comments)
- Modify: `canvas-doc/src/write-validation.test.ts`

### Verified before prescribing

- **`SHAPE_KINDS` exists as a real runtime export.** `canvas-model/src/shape.ts:8`
  declares `export const SHAPE_KINDS = [...] as const` (16 entries), re-exported
  from the package index via `export * from './shape.js'`. Confirmed by running
  `import { SHAPE_KINDS } from '@ensembleworks/canvas-model'` — it is an actual
  array at runtime, not a type-only union. So the membership check below is
  implementable exactly as written.
- **`ShapeKind` exists too** (`shape.ts:12`, `(typeof SHAPE_KINDS)[number]`) and
  is exported from the same index, so finding 2's narrowed type costs no new
  export.
- **The naming precedent is `repairCounter` / `repairCount`**
  (`canvas-sync/src/client-peer.ts:25` and `:37`) — a *paired* field/getter,
  which is the whole point of finding 3.

### Finding 1 (blocking) — the `'<unknown>'` promise is unenforced

`canvas-doc.ts:19-27` promises `kind` is `'<unknown>'` when the rejected value
is too malformed to have one. **Nothing produces that string**, and `rejectWrite`
accepts any `string`. Task 2's call sites reach into an already-known-invalid
value, so the natural implementation is `(value as any).kind` — which yields
`'wibble'`, `undefined`, `42`, or an object. The first two silently violate the
doc comment; the last two violate the **declared type at runtime**, and an
object-valued `kind` reaching Task 4A's overlay through `JSON.stringify` is a
real hazard.

Fix **centrally**, so no call site can get it wrong: `rejectWrite` takes the
offending value and derives `kind` itself.

### Finding 2 — narrow the type, now that finding 1 makes it honest

`kind: ShapeKind | '<unknown>'` instead of `kind: string`. This is only correct
**paired with finding 1** — without central coercion it would be a lie the
compiler cannot catch, which is strictly worse than `string`. With it, consumers
get `switch` exhaustiveness where `'<unknown>'` is an explicit arm rather than a
`default` silently absorbing both "malformed" and "a kind we forgot to handle" —
different situations a dashboard should be able to distinguish.

### Finding 3 — `writeRejections` → `invalidWriteCounter`

House precedent is `private repairCounter` backing `get repairCount()`: field is
`<noun>Counter`, getter is `<noun>Count`, same root, suffix carries the
distinction. Task 1A's comment cites `repairCount` as authority for the getter
name — correctly — and then picks a backing field that abandons the pattern. The
original problem (`invalidWrites` reading as the `InvalidWrite` type) was real
and the fix landed on the *getter*; renaming the field to a third unrelated word
solved nothing further and cost the family resemblance.

### Finding 4 (blocking) — powers of two, not a lifetime cap

See decision D1b, rewritten. Short version: a cap makes silence
indistinguishable from health, and goes permanently quiet so a *different* bug
an hour later never surfaces. Powers of two never close the channel.

### Finding 5 — cut the naming-rationale comment

The five-line naming rationale at `loro-canvas-doc.ts:104-109` documents *why the
name isn't what it used to be* — a fact about repo history, not about the code.
Git holds it, the commit message says it, and the test pins it mechanically:
three copies. Once the field is `invalidWriteCounter` the collision it describes
is self-evidently absent.

Also drop **"Do not lift the cap"** — an unenforceable prose imperative, and
after finding 4 it argues against a mechanism that no longer exists. The test is
the durable version.

**Keep** the per-pointermove flood rationale. That is the half of the block
genuinely earning its keep: non-obvious, and derived from a fact that lives in
another package.

This also removes the false "only non-test console call" sentence — so **Task 2's
Step 0 is now redundant and has been deleted.** Do not look for it.

### Finding 7 — log-line legibility

`rejected invalid ${op} ${kind} ${id}` renders as three bare juxtaposed tokens.
Use `${op} (${kind}) ${id}` plus the `[#n]` ordinal.

### Finding 6 — moot, do not do it

Extracting a `WARN_CAP` constant is moot under finding 4: there is no longer a
threshold to name. Do **not** add one.

**Step 1: Write the failing test**

Replace the finding-2 section of `canvas-doc/src/write-validation.test.ts` — if
you deferred it at `0a3ddd6`, it is not in the file and there is nothing to
replace; it stays deferred to Task 2 either way — and add the two new sections
below. Only the finding-3 section here is runnable now; see Step 2.

```ts
// --- Task 1B finding 1/2: `kind` is COERCED centrally, never passed through ---
// The doc comment promises '<unknown>' for a value too malformed to have a
// kind. Task 2's call sites hand rejectWrite an already-invalid value, so
// without central coercion `kind` would carry whatever garbage was in there —
// including a number or an object, which violates the DECLARED TYPE at runtime
// and would reach the dev overlay through JSON.stringify.
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 14n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  // A kind that is a plausible-looking string but not a real ShapeKind.
  doc.putShape({ id: 'shape:a', kind: 'wibble', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[0]!.kind, '<unknown>', 'an unrecognised kind string is coerced, not echoed')

  // A kind of the wrong TYPE entirely — the runtime-type-violation case.
  doc.putShape({ id: 'shape:b', kind: 42, parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[1]!.kind, '<unknown>', 'a non-string kind never escapes as a non-string')

  doc.putShape({ id: 'shape:c', kind: { nested: true }, parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[2]!.kind, '<unknown>', 'an object kind never reaches a JSON.stringify consumer')

  // Missing entirely.
  doc.putShape({ id: 'shape:d', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[3]!.kind, '<unknown>', 'an absent kind is reported as unknown')

  // And a REAL kind still passes through untouched.
  doc.putShape({ id: 'shape:e', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
  assert.equal(seen[4]!.kind, 'note', 'a genuine ShapeKind is preserved')

  for (const w of seen) {
    assert.equal(typeof w.kind, 'string', 'kind is ALWAYS a string, whatever was thrown at it')
  }
}

// --- Task 1B finding 3: the backing field follows the repairCounter pattern ---
// Field <noun>Counter / getter <noun>Count, matching client-peer.ts's
// repairCounter/repairCount. Pinned so the pair cannot drift apart again.
{
  const doc = LoroCanvasDoc.create({ peerId: 15n })
  assert.equal(doc.invalidWriteCount, 0, 'the getter is invalidWriteCount')
  assert.equal(
    (doc as unknown as Record<string, unknown>).writeRejections,
    undefined,
    'the interim `writeRejections` field name is gone',
  )
}
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL in the **finding-3 section** —
`AssertionError: the interim 'writeRejections' field name is gone`
(`0 !== undefined`), since that field currently exists.

The finding-1/2 section cannot go green until Task 2 makes `putShape` reject; it
will fail earlier, on `seen[0]!.kind` being a property of `undefined`. **That is
expected and is the same deferral Task 1A already took** — see Task 1A Step 2's
note. Record both failures verbatim.

> **Carry the finding-1/2 section into Task 2's restore list.** Task 2 Step 1
> already restores two deferred sections; this makes three. Add it there
> alongside them, or you will ship central `kind` coercion with no test proving
> it — the exact failure mode finding 1 is about.

**Step 3: Narrow the type in `canvas-doc/src/canvas-doc.ts`**

```ts
import type { ShapeKind } from '@ensembleworks/canvas-model'
```

and in `InvalidWrite`:

```ts
  /** The shape's `kind`, or `'<unknown>'` when the rejected value did not carry
   * a recognisable one. Narrowed rather than `string` so a consumer's `switch`
   * gets exhaustiveness, with `'<unknown>'` as an explicit arm instead of a
   * `default` that silently absorbs both "malformed" and "a kind we forgot to
   * handle" — different situations a dashboard should distinguish.
   *
   * The narrowing is only honest because `rejectWrite` COERCES this centrally
   * (it takes the offending value, not a caller-derived kind): every call site
   * is reaching into an already-invalid value, so a caller-supplied kind would
   * be exactly where garbage — a number, an object — would enter. */
  kind: ShapeKind | '<unknown>'
```

Carry over the existing rationale for *why* `kind` exists at all (the nanoid /
envelope-path argument) — it is still correct and still needed.

**Step 4: Rewrite the counter and `rejectWrite` in `canvas-doc/src/loro-canvas-doc.ts`**

Add `SHAPE_KINDS` and `ShapeKind` to the existing `@ensembleworks/canvas-model`
import, then replace the whole block:

```ts
  // Monotonic count of locally-originated writes this doc refused (see
  // InvalidWrite). Never reset.
  private invalidWriteCounter = 0
  get invalidWriteCount(): number { return this.invalidWriteCounter }

  // Count, then report. A rejection is a NO-OP at the call site, so this is
  // the only trace it leaves.
  //
  // Takes the offending VALUE, not a caller-derived kind: every call site is
  // reaching into something that just failed validation, so a caller-supplied
  // kind is exactly where a number, an object, or undefined would enter and
  // quietly violate InvalidWrite's declared type. Coercing here means no call
  // site can get it wrong.
  //
  // Logs on POWERS OF TWO (#1, #2, #4, …) rather than capping. v2 commits at
  // per-pointermove granularity, so a tool emitting an invalid write during a
  // drag would otherwise produce ~60 warnings per second for as long as the
  // drag lasts — enough to hang DevTools, and it buries the FIRST warning,
  // which is the diagnostically useful one. A lifetime cap would fix the flood
  // but make silence indistinguishable from health, and would go permanently
  // quiet so an unrelated bug an hour later never surfaced. This never closes
  // the channel: ~9 lines for a ten-second bad drag, ~18 for an hour. The
  // [#n] marker tells the reader they are seeing a sample, not a census.
  private rejectWrite(op: InvalidWrite['op'], value: unknown, id: string, error: string): void {
    const raw = (value as { kind?: unknown } | null | undefined)?.kind
    const kind: ShapeKind | '<unknown>' =
      typeof raw === 'string' && (SHAPE_KINDS as readonly string[]).includes(raw)
        ? (raw as ShapeKind)
        : '<unknown>'
    const n = ++this.invalidWriteCounter
    const write: InvalidWrite = { op, kind, id, error }
    if (this.onInvalidWrite) this.onInvalidWrite(write)
    else if ((n & (n - 1)) === 0) console.warn(`[canvas-doc] rejected invalid ${op} (${kind}) ${id} [#${n}]: ${error}`)
  }
```

Note `(value as … | null | undefined)?.kind` — the optional chain must survive a
`null` value, not only `undefined`. `typeof null === 'object'`, so a bare
property read on `null` would throw inside the very path meant to be
total.

**Step 5: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: the finding-3 section now passes. The finding-1/2 section still fails
until Task 2 — see Step 2.

**Step 6: Typecheck**

```
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/canvas-doc' typecheck
```

Expected: exit 0. `rejectWrite` still has no callers, so the changed signature
breaks nothing yet.

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/canvas-doc.ts canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "refactor(canvas-doc): coerce kind centrally, log on powers of two, align counter naming"
```

---

## Task 2: Validate `putShape` at the write boundary

> ### ⚠️ Task 2 carries inherited obligations. Read Step 0 and Step 1 before writing anything.
>
> Task 2 is not only "add validation". It must also restore **three** test
> sections that Tasks 1A and 1B legitimately deferred, because none of them can
> run until `putShape` actually rejects (Step 1). That is not optional and not
> scope creep — without it, review findings 1, 2 and 3 all ship unproven.

**Step 0: (removed — absorbed into Task 1B)**

An earlier revision put a comment correction here. **Task 1B now rewrites that
entire comment block**, which removes the false "only non-test console call"
sentence as a side effect. Nothing to do — go straight to Step 1.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (`putShape`, add `putShapeUnchecked`)
- Modify: `canvas-doc/src/canvas-doc.ts` (`putShape` JSDoc)
- Modify: `canvas-doc/src/write-validation.test.ts`

**Step 1: Write the failing test**

> ## ⛔ FIRST: restore the THREE deferred sections. Do not skip this.
>
> Task 1A committed only two of its four test sections at `0a3ddd6`, and Task 1B
> added a third deferred section. None can run until `putShape` rejects — which
> is this task. **Paste all three in verbatim, after the existing finding-4
> section and before Task 2's own sections.** They are currently red and go
> green with this task's fix, so **they are part of Task 2's RED and must all be
> observed failing in Step 2.**
>
> | Section | Proves | Deferred by |
> |---|---|---|
> | finding 3 — `kind` on props **and envelope** paths | why `kind` exists at all | Task 1A |
> | finding 2 — powers-of-two logging | the flood throttle | Task 1A |
> | finding 1/2 — central `kind` coercion to `'<unknown>'` | no garbage escapes the declared type | Task 1B |
>
> Three traps, stated plainly because all three are easy to walk into:
>
> 1. **Do NOT treat Task 2's `assert.equal(seen[0]!.kind, 'frame')` as covering
>    finding 3.** That is the *props* path, where the kind is embedded in the
>    zod message anyway. The **envelope** path — `index: ''` on a `note`,
>    asserting `seen[1]!.kind === 'note'` **and** the precondition
>    `assert.doesNotMatch(seen[1]!.error, /note/)` — is the entire justification
>    for finding 3. Without it, `kind` is proven exactly where it was least
>    needed and finding 3's rationale is permanently unverified.
> 2. **Do NOT treat Task 2's `assert.equal(warned.length, 1)` as covering
>    finding 2.** A single rejection produces one warning whether or not any
>    throttle exists — that assertion passes identically against an
>    *unthrottled* warn. Only the 20-iteration loop pins the behaviour.
> 3. **And do NOT reduce that loop to a count.** At n=20 a lifetime cap of 5 and
>    powers-of-two **both** produce exactly 5 lines (1, 2, 4, 8, 16). The
>    section below therefore asserts the parsed `[#n]` **ordinals**, not
>    `warned.length`. A count-only version would pass against the very
>    implementation Task 1B replaced.
>
> The two sections, verbatim (reproduced here so you never have to scroll back
> to Task 1A):
>
> ```ts
> // --- Task 1A finding 3: InvalidWrite carries `kind` ---
> // Two cases, because they fail on DIFFERENT zod paths. The props case embeds
> // the kind in the message anyway; the ENVELOPE case does not, and that is the
> // case `kind` exists for.
> {
>   const seen: InvalidWrite[] = []
>   const doc = LoroCanvasDoc.create({ peerId: 12n, onInvalidWrite: (w) => seen.push(w) })
>   doc.putPage({ id: 'page:p', name: 'P' })
>
>   // Props-refinement failure: kind IS in the message, and must also be a field.
>   doc.putShape({ id: 'shape:a', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
>   assert.equal(seen[0]!.kind, 'frame', 'kind is reported on a props failure')
>
>   // Envelope failure (index must be a non-empty string): the zod message never
>   // names the kind, so the field is the ONLY way to know what was being built.
>   doc.putShape({ id: 'shape:b', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
>   assert.equal(seen[1]!.kind, 'note', 'kind is reported on an envelope failure too')
>   assert.doesNotMatch(seen[1]!.error, /note/, 'precondition: the envelope error genuinely does not name the kind')
> }
>
> // --- Task 1A finding 2 (as revised by Task 1B): the default console.warn logs
> // on POWERS OF TWO, and the counter is unaffected ---
> {
>   const warned: string[] = []
>   const realWarn = console.warn
>   console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }
>   try {
>     const doc = LoroCanvasDoc.create({ peerId: 13n }) // no handler -> console path
>     doc.putPage({ id: 'page:p', name: 'P' })
>     // v2 commits at per-pointermove granularity, so a bad drag emits ~60/s
>     // indefinitely. 20 stands in for "a drag that lasted a third of a second".
>     for (let i = 0; i < 20; i++) {
>       doc.putShape({ id: `shape:bad${i}`, kind: 'frame', parentId: 'page:p', props: { w: 'x' }, ...base() } as never)
>     }
>     assert.equal(doc.invalidWriteCount, 20, 'the counter stays EXACT regardless of how little is logged')
>   } finally {
>     console.warn = realWarn
>   }
>   // Assert WHICH rejections logged, not merely how many. A lifetime cap of 5
>   // and powers-of-two BOTH yield 5 lines at n=20 (1,2,4,8,16), so a
>   // count-only assertion cannot tell them apart — it would pass against the
>   // capped implementation this replaces.
>   const ordinals = warned.map((line) => Number(/\[#(\d+)\]/.exec(line)?.[1]))
>   assert.deepEqual(ordinals, [1, 2, 4, 8, 16], 'logs on powers of two only — never 3, 5, 6, 7')
>   assert.ok(!ordinals.includes(3) && !ordinals.includes(7), 'explicitly: non-powers-of-two are silent')
>   // The ordinal marker tells the reader they are seeing a SAMPLE, not a census.
>   assert.match(warned[0]!, /\[#1\]/, 'each line carries its ordinal')
> }
>
> // --- Task 1B finding 1/2: `kind` is COERCED centrally, never passed through ---
> // The doc comment promises '<unknown>' for a value too malformed to have a
> // kind. The call sites below hand rejectWrite an already-invalid value, so
> // without central coercion `kind` would carry whatever garbage was in there —
> // including a number or an object, which violates the DECLARED TYPE at runtime
> // and would reach the dev overlay through JSON.stringify.
> {
>   const seen: InvalidWrite[] = []
>   const doc = LoroCanvasDoc.create({ peerId: 14n, onInvalidWrite: (w) => seen.push(w) })
>   doc.putPage({ id: 'page:p', name: 'P' })
>
>   // A kind that is a plausible-looking string but not a real ShapeKind.
>   doc.putShape({ id: 'shape:a', kind: 'wibble', parentId: 'page:p', props: {}, ...base() } as never)
>   assert.equal(seen[0]!.kind, '<unknown>', 'an unrecognised kind string is coerced, not echoed')
>
>   // A kind of the wrong TYPE entirely — the runtime-type-violation case.
>   doc.putShape({ id: 'shape:b', kind: 42, parentId: 'page:p', props: {}, ...base() } as never)
>   assert.equal(seen[1]!.kind, '<unknown>', 'a non-string kind never escapes as a non-string')
>
>   doc.putShape({ id: 'shape:c', kind: { nested: true }, parentId: 'page:p', props: {}, ...base() } as never)
>   assert.equal(seen[2]!.kind, '<unknown>', 'an object kind never reaches a JSON.stringify consumer')
>
>   // Missing entirely.
>   doc.putShape({ id: 'shape:d', parentId: 'page:p', props: {}, ...base() } as never)
>   assert.equal(seen[3]!.kind, '<unknown>', 'an absent kind is reported as unknown')
>
>   // And a REAL kind still passes through untouched.
>   doc.putShape({ id: 'shape:e', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as never)
>   assert.equal(seen[4]!.kind, 'note', 'a genuine ShapeKind is preserved')
>
>   for (const w of seen) {
>     assert.equal(typeof w.kind, 'string', 'kind is ALWAYS a string, whatever was thrown at it')
>   }
> }
> ```

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
  assert.equal(seen[0]!.kind, 'frame')
  assert.equal(seen[0]!.id, 'shape:bad')

  // HOLE 5: the InvalidWrite doc comment promises the VERBATIM zod message.
  assert.match(seen[0]!.error, /expected number, received string/, 'the verbatim zod message is carried through')

  // HOLE 3 (the actual defect): the write is a TRUE no-op. The counter is only
  // a proxy for this — what matters is that nothing landed and nothing else
  // moved.
  assert.equal(doc.getShape('shape:bad'), undefined, 'the invalid shape was not written at all')
  assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:keep'], 'no partial node, and the neighbour is untouched')

  // HOLE 2: prove invalidWriteCount is a COUNTER, not a constant. Task 1 only
  // ever observed it at 0, which a hardcoded `get invalidWriteCount() { return
  // 0 }` would satisfy. Walk it 0 -> 1 -> 2.
  assert.equal(doc.invalidWriteCount, 1, 'the first rejection was counted')
  doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { h: 'nope' }, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 2, 'the counter increments per rejection')
  assert.equal(seen.length, 2, 'and the hook fires per rejection')

  // The escape hatch still writes, unvalidated — this is how tests and rigs
  // reproduce what a remote peer's bytes can deliver (decision D3).
  doc.putShapeUnchecked({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
  assert.ok(doc.getShape('shape:bad'), 'putShapeUnchecked bypasses validation')
  assert.equal(doc.invalidWriteCount, 2, 'the escape hatch does not touch the counter')
}

// HOLE 4: with NO handler injected, the doc must fall back to console.warn.
// The InvalidWriteHandler doc comment claims a rejection is "never silent" and
// nothing has proven it. Capture console.warn rather than trusting the claim.
// (The powers-of-two throttle is proven in the restored section above; this
// proves the fallback fires AT ALL, and that the line names op, kind, id and
// ordinal. n=1 is a power of two, so exactly one line is expected here.)
{
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const doc = LoroCanvasDoc.create({ peerId: 5n }) // no onInvalidWrite
    doc.putPage({ id: 'page:p', name: 'P' })
    doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(doc.invalidWriteCount, 1, 'still counted without a handler')
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 1, 'the console.warn fallback fired — a rejection is never silent')
  assert.match(String(warned[0]![0]), /rejected invalid putShape \(frame\) shape:bad \[#1\]/, 'the warning names the op, the kind, the id and the ordinal')
}
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL in the **restored finding-3 section**, which now runs first — a
`TypeError` on `seen[0]!.kind` (reading a property of `undefined`), because with
no validation in place `putShape` writes the bad shape and `seen` stays empty.

Then, after the fix, **verify all three of these go green** — this is the point
of the restore, so check them individually rather than trusting a single
`ok:` line:

| Assertion | Proves |
|---|---|
| `seen[1]!.kind === 'note'` + `doesNotMatch(seen[1]!.error, /note/)` | finding 3 on the **envelope** path |
| `invalidWriteCount === 20` + `warned.length === 5` | finding 2's **cap** |
| `the hook actually fired — storing the handler is not enough` | Task 2's own hole 1 |

If you comment out the restored sections to "get a cleaner RED", you have
defeated the purpose of Step 1 — findings 2 and 3 would then ship unproven.
(`putShapeUnchecked` also does not exist yet, but execution never reaches it.)
**Record the verbatim output.**

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
      // Pass the whole rejected VALUE, not a locally-derived kind: rejectWrite
      // coerces `kind` centrally so no call site can leak a non-ShapeKind into
      // InvalidWrite (Task 1B finding 1). `id` is still read here because it
      // has no equivalent closed vocabulary to validate against.
      const id = typeof (s as { id?: unknown })?.id === 'string' ? (s as { id: string }).id : '<no id>'
      this.rejectWrite('putShape', s, id, v.error)
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

Before committing, confirm all three of Task 2's obligations are in the diff:
the Step 0 comment correction, the two restored Task 1A sections, and Task 2's
own validation + `putShapeUnchecked`.

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/canvas-doc.ts canvas-doc/src/write-validation.test.ts
git commit -m "fix(canvas-doc): validate shapes at the putShape write boundary"
```

---

### ✅ Task 2 LANDED at `81fcc94` (+ `5060832`, a comment reflow)

Spec-reviewed and passed, including an explicit over-eagerness review whose
findings are recorded in "Why write validation cannot lose data" near the top of
this document.

**Known plan-vs-code prose drift — not worth a commit, recorded so a future
reader diffing the two is not confused:**

- Two restored sections dropped a few explanatory comment lines relative to the
  verbatim text above: the *"would pass against the capped implementation"*
  clause, and the *"ordinal marker tells the reader they are seeing a SAMPLE,
  not a census"* line. **All assertions are identical** — only prose was lost.
- HOLE 4's comment in the shipped file legitimately diverges from an earlier
  draft of this plan, which described the fallback as "CAPPED at 5". Task 1B
  made that false. The plan text above has been corrected to match what actually
  shipped, so the implementer did **not** go off-script here.

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

## Task 3A: Close the throwing-sink hole and correct three false comments

Task 2's quality review returned ❌ CHANGES NEEDED. This task carries its
**blocking correctness bug** (finding 1) plus the two coercion/documentation
corrections that must land before Task 4 writes the second `rejectWrite` call
site.

### Why before Task 4

Finding 4 moves `id` coercion **into** `rejectWrite`. If Task 4 lands first it
writes its own local `id` guard, and the duplication finding 4 exists to prevent
is exactly what ships. Finding 1 is independent but blocking, and Task 4A is
about to inject the **first production handler** — closing the hole before a
real sink exists is the whole argument for doing it now.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (guard the handler, coerce `id`, JSDoc)
- Modify: `canvas-doc/src/canvas-doc.ts` (`putShape` JSDoc one-liner)
- Modify: `canvas-editor/src/editor.ts` (TOLERANCE CONTRACT comment — comment only)
- Modify: `canvas-doc/src/write-validation.test.ts`

### Finding 1 (CRITICAL, blocking) — a throwing handler escapes `putShape`

`loro-canvas-doc.ts` calls the injected sink unguarded:

```ts
if (this.onInvalidWrite) this.onInvalidWrite(write)
```

Verified empirically: a doc built with a throwing handler propagates straight
out of `putShape` — `HANDLER-THROW: ESCAPES putShape -> Error: handler blew up`.

**This reintroduces precisely what decision D1 exists to prevent.**
`Editor.applyAll` (`editor.ts:249`) has no `try`/`catch` around its intent loop
and commits only afterward, so a throwing sink strands that batch's earlier
mutations uncommitted. The reporting path — the thing that exists *because* we
refuse to throw — is itself the hole. (`replay()` is incidentally protected by
its own per-op guard; `applyAll` is not, which is the case that matters.)

**Latent, not live:** no production handler is injected yet, only tests. That is
the argument for closing it **now**, before Task 4A lands the dev-overlay
handler and someone later writes a sink that can throw — a `JSON.stringify` over
a value with a throwing getter, a React `setState` after unmount, a full ring
buffer.

### Finding 4 — coerce `id` inside `rejectWrite`, don't duplicate the guard

The signature is structurally right and **must not change shape**: Task 4's
`updateProps(id, props)` receives `id` as a separate argument, not as a field of
the offending value, so it genuinely cannot be derived centrally the way `kind`
can. That asymmetry is inherent, not an oversight.

But the *guard* must not be duplicated across two call sites. Widen the
parameter and coerce once. This also closes a case the current guard misses: an
empty-string `id` passes `typeof === 'string'` and produces the line
`rejected invalid putShape (frame)  [#1]: …` — a blank where the id should be,
which reads as a formatting bug rather than as missing data.

**Also fix the justifying comment, which is shaky.** `kind` is not centralised
because it has a closed vocabulary; it is centralised because `InvalidWrite.kind`
is a **narrowed declared type** that runtime garbage would violate. `id` is
declared plain `string`, so its rule is only "must be a non-empty string" —
checkable, just weaker. Say that.

### Finding 5 (JSDoc half) — `putShapeUnchecked`'s comment makes a false claim

It says "Deliberately NOT on the `CanvasDoc` interface," which implies production
cannot reach it. **Production reaches the concrete class routinely** — verified:

There are **four** — verified 2026-07-20:

| Location | Exposure |
|---|---|
| `canvas-sync/src/server-peer.ts:48` | `readonly doc: LoroCanvasDoc` |
| `canvas-sync/src/client-peer.ts:19` | `readonly doc: LoroCanvasDoc` |
| `server/src/canvas-v2/shadow.ts:79` | `readonly doc: LoroCanvasDoc` |
| `server/src/canvas-v2/reconcile.ts:49` | takes `doc: LoroCanvasDoc` as a parameter |

> **Four, not five.** An earlier revision listed `server/src/canvas-v2/actor.ts`
> as a fifth. It is not an independent exposure point: it has no public `doc`
> field and reaches the doc *through* `SyncServerPeer.doc`, which is already
> row 1. The JSDoc that shipped names four and is correct.

Anyone typing `peer.doc.` gets `putShapeUnchecked` in autocomplete with no
interface boundary in the way — and `reconcile.ts` is *precisely* where a
developer chasing finding 2 would reach for it as the fix.

> **Do NOT add runtime machinery** — a symbol key, a token argument, a separate
> `unsafe` module. All cost more than the bug they prevent, and the clean-room
> constraint rules out the usual tricks. The JSDoc is corrected here; the
> enforcement is a CI presence gate in **Task 8A**, matching the repo's existing
> pattern (`scripts/ux-contract-presence.test.ts`, `scripts/exposure-audit.ts`).

### Finding 3 — `replay()`'s TOLERANCE CONTRACT is now factually incomplete

D3a records the undo/redo semantics *in this plan*, but the comment developers
actually read is `canvas-editor/src/editor.ts:324-338`. It carefully enumerates
which mutators are no-throw and which ops get skipped, and names `putShape`'s
cycle-guard throw as **the** reason `putShape` needs guarding. `putShape` now has
a second, quieter skip mode that the `try`/`catch` never observes at all.

**Step 1: Write the failing test**

Append to `canvas-doc/src/write-validation.test.ts`, before the final
`console.log`:

```ts
// --- Task 3A finding 1: a THROWING sink must not escape putShape ---
// The reporting path exists BECAUSE we refuse to throw (decision D1). If the
// sink itself can throw, the hole is back: Editor.applyAll has no try/catch
// around its intent loop and commits only afterward, so an escaping throw
// strands that batch's earlier mutations uncommitted.
{
  const doc = LoroCanvasDoc.create({
    peerId: 16n,
    onInvalidWrite: () => { throw new Error('handler blew up') },
  })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:keep', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)

  assert.doesNotThrow(
    () => doc.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never),
    'a throwing sink must not escape putShape',
  )
  // Still a total no-op, and still counted.
  assert.equal(doc.getShape('shape:bad'), undefined, 'the rejected write did not land')
  assert.deepEqual(doc.listShapes().map((s) => s.id), ['shape:keep'], 'nothing else moved')
  assert.equal(doc.invalidWriteCount, 1, 'the counter increments BEFORE the sink is called, so a throw cannot skew it')

  // And the throw must not fall through to the console path either.
  const realWarn = console.warn
  let warnings = 0
  console.warn = () => { warnings++ }
  try {
    doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  } finally {
    console.warn = realWarn
  }
  assert.equal(warnings, 0, 'a supplied-but-throwing sink still suppresses the console fallback')
}

// --- Task 3A finding 4: `id` is coerced centrally, including empty string ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 17n, onInvalidWrite: (w) => seen.push(w) })
  doc.putPage({ id: 'page:p', name: 'P' })

  doc.putShape({ kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[0]!.id, '<no id>', 'a missing id is reported as <no id>')

  // The case the old guard missed: '' is a string, so it passed through and
  // rendered as a BLANK in the log line — reads as a formatting bug, not as
  // missing data.
  doc.putShape({ id: '', kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[1]!.id, '<no id>', 'an EMPTY-STRING id is coerced too, not passed through blank')

  doc.putShape({ id: 42, kind: 'frame', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(seen[2]!.id, '<no id>', 'a non-string id never escapes as a non-string')

  doc.putShape({ id: 'shape:real', kind: 'frame', parentId: 'page:p', props: { w: '1' }, ...base() } as never)
  assert.equal(seen[3]!.id, 'shape:real', 'a genuine id is preserved')
}
```

> **TRAP if you extend these into a full "the no-op is total" test.** The
> reviewer verified totality across 9 rejected inputs by comparing Loro tree
> JSON, the private index map by TreeID, `listShapes`/`listBindings`/`listPages`,
> `versionBytes()`, and raw `exportSnapshot()` bytes — all identical, nothing
> threw. But **calling `listPages()` or `listBindings()` between two
> `exportSnapshot()` calls changes the snapshot bytes by itself.** That is
> pre-existing Loro lazy-container behaviour, entirely unrelated to this branch
> — confirmed by probe: back-to-back snapshots compare equal; snapshots with an
> intervening `listPages()`/`listBindings()` do not. Take both snapshots with no
> intervening reads, or you will chase a phantom diff for an hour.

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
```

Expected: FAIL in the finding-1 section — `a throwing sink must not escape
putShape`, reported as the handler's own `Error: handler blew up` propagating
out. **Record the verbatim output.**

**Step 3: Guard the sink and coerce `id` in `canvas-doc/src/loro-canvas-doc.ts`**

Change `rejectWrite`'s signature and body:

```ts
  private rejectWrite(op: InvalidWrite['op'], value: unknown, rawId: unknown, error: string): void {
    const rawKind = (value as { kind?: unknown } | null | undefined)?.kind
    // `kind` is coerced here because InvalidWrite.kind is a NARROWED declared
    // type (ShapeKind | '<unknown>') that runtime garbage would violate — not
    // merely because kinds happen to have a closed vocabulary. `id` is
    // declared plain `string`, so its rule is weaker but still checkable:
    // must be a NON-EMPTY string. Empty is coerced too — it passes
    // `typeof === 'string'` and would render as a blank in the log line,
    // reading as a formatting bug rather than as missing data.
    const kind: ShapeKind | '<unknown>' =
      typeof rawKind === 'string' && (SHAPE_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as ShapeKind)
        : '<unknown>'
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : '<no id>'
    const n = ++this.invalidWriteCounter
    const write: InvalidWrite = { op, kind, id, error }
    if (this.onInvalidWrite) {
      try { this.onInvalidWrite(write) }
      catch { /* A reporting sink must NEVER convert a no-op rejection into a
                 throw that escapes Editor.applyAll's un-try/caught intent loop
                 and strands that batch's earlier mutations uncommitted
                 (decision D1). The counter is incremented above, before this
                 call, so a throwing sink cannot skew it either. */ }
    } else if ((n & (n - 1)) === 0) {
      console.warn(`[canvas-doc] rejected invalid ${op} (${kind}) ${id} [#${n}]: ${error}`)
    }
  }
```

and simplify `putShape`'s call site — it no longer derives `id` itself:

```ts
      this.rejectWrite('putShape', s, (s as { id?: unknown })?.id, v.error)
```

**Step 4: Correct `putShapeUnchecked`'s JSDoc**

Replace the "Deliberately NOT on the CanvasDoc interface" claim with something
true:

```ts
  /**
   * putShape WITHOUT the write-boundary validation above. It exists so tests
   * and hostile-state rigs can construct exactly the docs a REMOTE peer's
   * bytes can still deliver (import() applies remote ops straight to the tree
   * and never passes through putShape, so local validation cannot close that
   * door).
   *
   * Kept off the CanvasDoc interface as a SIGNAL, not a barrier — production
   * reaches this concrete class routinely (SyncServerPeer.doc,
   * SyncClientPeer.doc, ShadowMirror.doc and reconcile()'s parameter are all
   * typed LoroCanvasDoc), so anyone typing `peer.doc.` gets this method in
   * autocomplete with no interface boundary in the way. The actual enforcement
   * is the CI presence gate in scripts/ — see it for the allowlist and how to
   * extend it. Do not call this from production code.
   */
```

**Step 5: Correct `replay()`'s TOLERANCE CONTRACT in `canvas-editor/src/editor.ts`**

Comment only — no behaviour change, no RED step. Append to the block at
`editor.ts:324-338`:

```
  // SECOND SKIP MODE (added with the write boundary): `putShape` now also
  // silently REJECTS a shape that fails validateShape — a rejection this
  // try/catch never observes, because it does not throw. A shape can reach the
  // undo stack already invalid — it arrives through import(), the one path
  // into this peer's doc that bypasses the write boundary. That covers both a
  // live remote peer and a room whose stored SQLite predates the boundary:
  // the server loads such a room via fromSnapshot and relays it here as an
  // ordinary import, so there is ONE route in, not two. (This peer's own doc
  // is never built by fromSnapshot — see client-peer.ts, where it is an
  // unconditional LoroCanvasDoc.create.) Replaying such a shape is a no-op
  // rather than a restore. Deliberate — restoring it would only re-manufacture
  // state repair() is obliged to cascade-delete. User-visible effect: an undo
  // step that appears to do nothing for that shape.
```

> **This is the corrected wording, matching what landed at `792be65`.** An
> earlier revision of this plan prescribed a two-route version naming
> `fromSnapshot` as the second. It was false and shipped before being caught —
> see D3a's CORRECTED note for the verification. Do not reintroduce it.

Then extend the one-line note on `CanvasDoc.putShape`'s JSDoc from "Remote ops
arriving through `import()` bypass this entirely" to "Remote ops arriving
through `import()`, **or shapes loaded from a pre-boundary snapshot**, bypass
this entirely".

> **This sentence is CORRECT and must not be "fixed" to match the `editor.ts`
> correction above.** It reads almost identically, but its scope is different:
> it describes `CanvasDoc.putShape` in general, and the **server** genuinely
> does load via `fromSnapshot` (`actor.ts:139`, `server-peer.ts:82`). The
> `editor.ts` comment was false only because it was scoped to the **undo
> stack**, which exists solely on the client, whose doc is never built by
> `fromSnapshot`. Same words, different subject — check which one you are
> looking at before touching either.

> `canvas-editor/src/editor.ts` is **not** under `canvas-editor/src/tools/`, so
> this does not trip the ux-contract presence gate.

**Step 6: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/write-validation.test.ts
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks/canvas-editor && ~/.bun/bin/bun test.ts
```

Expected: all pass.

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/canvas-doc.ts canvas-editor/src/editor.ts canvas-doc/src/write-validation.test.ts
git commit -m "fix(canvas-doc): guard the invalid-write sink against throwing handlers"
```

### ✅ Task 3A LANDED at `d0e408c` (+ `792be65`, a comment correction)

Review found **one defect**: the `replay()` comment prescribed in Step 5 was
factually false — the `fromSnapshot` "second route" does not exist client-side.
The false wording came from this plan, not from the implementer, who transcribed
it faithfully. Corrected at `792be65`; Step 5's text above now matches what
landed, and D3a carries the verification.

**Accepted addition, recorded so a plan-to-code diff does not read as drift:**
the implementation added a ~7-line comment inside `rejectWrite` explaining the
`kind`/`id` coercion asymmetry, beyond what Step 3 prescribed. It is accurate
and it justifies the `.length > 0` clause, which would otherwise look arbitrary.
Keep it.

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
  assert.equal(doc.invalidWriteCount, 1, 'the rejection was counted')
  assert.equal(seen[0]!.op, 'updateProps')
  assert.equal(seen[0]!.id, 'shape:f')
  // `kind` comes from the EXISTING node here, not from the patch — the patch
  // has no kind to read (finding 3).
  assert.equal(seen[0]!.kind, 'frame', 'kind is read off the existing shape')

  // A VALID patch still merges (regression guard on the happy path).
  doc.updateProps('shape:f', { w: 250 })
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 250, h: 100 }, 'a valid patch merges as before')
  assert.equal(doc.invalidWriteCount, 1, 'a valid patch is not counted')

  // Merged-not-patch, the direction that MATTERS: a patch that HEALS an
  // already-invalid shape (one a remote peer delivered) must be accepted,
  // even though the pre-image is invalid.
  doc.putShapeUnchecked({ id: 'shape:g', kind: 'frame', parentId: 'page:p', props: { w: 'bad', h: 10 }, ...base() } as never)
  doc.updateProps('shape:g', { w: 42 })
  assert.deepEqual(doc.getShape('shape:g')!.props, { w: 42, h: 10 }, 'a patch that makes the merged shape valid is accepted')
  assert.equal(doc.invalidWriteCount, 1, 'healing a remote-delivered invalid shape is not a rejection')

  // Unknown id keeps its pre-existing silent-no-op contract — NOT a rejection.
  doc.updateProps('shape:nope', { w: 1 })
  assert.equal(doc.invalidWriteCount, 1, 'an unknown id is a no-op, not an invalid write')
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
    const shape = this.readNode(n)
    const v = validateShape({ ...shape, props: merged })
    // Pass the EXISTING shape as the value — a props patch has no kind of its
    // own, and rejectWrite coerces `kind` off whatever it is given (Task 1B
    // finding 1), so a node whose stored kind is itself garbage still reports
    // '<unknown>' rather than leaking it.
    //
    // `id` goes through as-is: rejectWrite coerces it too (Task 3A finding 4),
    // so do NOT add a local non-empty/string guard here — duplicating that
    // check across the two call sites is exactly what finding 4 removed.
    if (!v.ok) { this.rejectWrite('updateProps', shape, id, v.error); return }
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

## Task 4N: Close the `undefined` → `null` serialization seam

**Runs after Task 4 and BEFORE Task 4A** — see the task-order table. (Lettered
out of alphabetical sequence to avoid renaming the existing 4A/4B and breaking
this document's cross-references; the table is authoritative for order.)

Task 4's spec review found a completeness gap that **reproduces the original
defect through the hardened call site**, and it invalidates the branch's central
claim until fixed. See "The argument depends on a test, not on the predicate
alone" above for the reproduction. Both `putShape` and `updateProps` are affected; the hole is
pre-existing from Task 2, not introduced by Task 4.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` (add `asStored`, use it at both call sites)
- Create: `canvas-doc/src/serialization-seam.test.ts`

### What was measured before choosing (2026-07-20)

Two probes against real Loro (`loro-crdt` 1.13.6), written and run rather than
reasoned about:

**Probe 1 — is the coercion uniform?** Yes, everywhere:

| Location | `undefined` stored as | read-back validates? |
|---|---|---|
| props, top-level typed key (`w`) | `null` | ❌ |
| props, nested object | `null` | ✅ (loose passthrough) |
| props, array element | `null` | ✅ (loose passthrough) |
| `meta` value | `null` | ✅ (`z.record(z.unknown())`) |
| **envelope field (`x`)** | `null` | ❌ |

**Probe 2 — is `undefined` the ONLY divergence?** Yes. Testing each value in a
typed field, "leaks" means pre-serialization valid but post-read-back invalid:

| Value | Stored as | pre | post | |
|---|---|---|---|---|
| `undefined` | `null` | ✅ | ❌ | **← the only leak** |
| `NaN` | `null` | ❌ | ❌ | already rejected |
| `Infinity` | `null` | ❌ | ❌ | already rejected |
| `-0` | **`+0`** | ✅ | ✅ | **normalized, NOT faithful** — see below |
| `Date` | `{}` | ❌ | ❌ | already rejected |
| `Map` | `{"a":1}` | ❌ | ❌ | already rejected |
| `bigint` | *write throws* | ❌ | — | already rejected |
| explicit `null` | `null` | ❌ | ❌ | already rejected (`.optional()` ≠ `.nullable()`) |

> **CORRECTED 2026-07-20 — the `-0` row.** An earlier revision of this table
> claimed `-0` round-trips "faithfully". It does not: Loro normalizes `-0` to
> `+0` in the tree-node data path, confirmed against `loro-crdt/base64` (the
> import production uses) with `Object.is(readback, -0) === false`, for both a
> props key and an envelope field.
>
> **This is not a leak of the kind this table enumerates**, and the table's
> conclusion is unaffected: `z.number()` accepts both signed zeros identically,
> so `-0` can never produce a pre-valid/post-invalid divergence. It is correctly
> outside `asStored`'s scope — normalizing it would be pure ceremony.
>
> **Why the original probe missed it, which is the instructive part:** it
> compared values with `JSON.stringify`, and `JSON.stringify(-0) === "0"`. The
> instrument was lossy for exactly the property being asserted. When a probe's
> whole purpose is to establish that a value survives a round-trip, compare with
> `Object.is` — not `JSON.stringify`, not `===` (which also reports `-0 === 0`).

**This is decisive for the design**: the seam is exactly **one rule**, not a
model of Loro's value marshaling.

### Decision: option 3 — validate the post-serialization form

Normalize `undefined` → `null` recursively, validate *that*, store the original
(Loro will produce the same normalization).

**Why not option 1 (reject any patch containing `undefined`).** Probe 2's last
row rules it out: `{ stillUrl: undefined }` on a `screenshare` — the realistic
embed-write pattern — stores `{"stillUrl":null}` and **remains valid**, because
`stillUrl` is a loose passthrough key and `looseObject` accepts `null` for
unknown keys. Option 1 would reject a write that is genuinely fine. It punishes
the common case to catch the rare one.

**Why not option 2 (strip `undefined` keys, then validate).** Two reasons. It
silently reinterprets caller intent, and — decisively — it converts a bad write
into a **no-op the caller cannot detect**: no rejection, no counter, no hook. The
whole point of D1 is that a refused write is *reported*. Option 2 refuses
invisibly. The concern motivating it ("`undefined` may mean *clear this prop*")
also does not survive contact with the API: `{...cur, ...props}` can never remove
a key, so there is no existing "clear" semantic to preserve — today
`{ w: undefined }` means "store `null`", which is simply wrong for a typed field.

**Why option 3's stated cost does not apply here.** The objection was that a
normalizer must stay in sync with Loro's coercion and would drift silently.
Probe 2 dissolves the first half — there is one rule to keep in sync, not a
marshaling model — and Step 1's drift test dissolves the second: it compares the
normalizer against **what real Loro actually stores**, so drift fails loudly
instead of quietly reopening the boundary.

**What this changes in practice** is narrow and correct: `undefined` is now
rejected exactly where `null` would be invalid — typed props (`w`, `h`, `name`)
and every envelope field — and still accepted on loose passthrough keys, where
it is harmless. Realistic embed writes are unaffected.

**Step 1: Write the failing test**

Create `canvas-doc/src/serialization-seam.test.ts`:

```ts
// Run: bun src/serialization-seam.test.ts
// Loro stores `undefined` as `null`. Validating the PRE-serialization object
// therefore judges a different value than the one repair() will later judge on
// read-back — the seam that let `{ w: undefined }` pass the write boundary and
// then be cascade-deleted by repair(). See the plan's Task 4N.
import assert from 'node:assert/strict'
import { validateShape } from '@ensembleworks/canvas-model'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

// --- The reported reproduction, closed at BOTH call sites ---
// The assertion that matters is the READ-BACK one: it is not enough that the
// write was refused, the doc must be left in a state repair() will not act on.
{
  const doc = LoroCanvasDoc.create({ peerId: 20n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:f', kind: 'frame', parentId: 'page:p', props: { w: 100, h: 100 }, ...base() } as never)
  doc.putShape({ id: 'shape:kid', kind: 'note', parentId: 'shape:f', props: {}, ...base() } as never)
  doc.commit()

  // updateProps half.
  doc.updateProps('shape:f', { w: undefined })
  assert.equal(doc.invalidWriteCount, 1, 'updateProps rejects a patch that would STORE null in a typed field')
  assert.deepEqual(doc.getShape('shape:f')!.props, { w: 100, h: 100 }, 'props untouched')
  assert.ok(validateShape(doc.getShape('shape:f')).ok, 'READ-BACK still validates — repair() has nothing to act on')

  // putShape half — same hole, pre-existing from Task 2.
  doc.putShape({ id: 'shape:g', kind: 'frame', parentId: 'page:p', props: { w: undefined, h: 1 }, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 2, 'putShape rejects it too')
  assert.equal(doc.getShape('shape:g'), undefined, 'nothing was written')

  // Envelope fields leak the same way, not just props.
  doc.putShape({ id: 'shape:h', kind: 'frame', parentId: 'page:p', props: {}, ...base(), x: undefined } as never)
  assert.equal(doc.invalidWriteCount, 3, 'an undefined ENVELOPE field is rejected too')

  // And the whole doc is repair-clean: the defect was that repair() would
  // cascade-delete shape:f AND shape:kid.
  doc.commit()
  assert.deepEqual(doc.repair(), [], 'repair() has nothing to do — the frame and its child are safe')
  assert.deepEqual(doc.listShapes().map((s) => s.id).sort(), ['shape:f', 'shape:kid'])
}

// --- Loose passthrough keys still accept undefined: null is VALID there ---
// This is why we normalize-then-validate rather than banning `undefined`
// outright. `{ stillUrl: undefined }` is the realistic embed-write pattern.
{
  const doc = LoroCanvasDoc.create({ peerId: 21n })
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ss', kind: 'screenshare', parentId: 'page:p', props: { w: 10, h: 10 }, ...base() } as never)
  doc.updateProps('shape:ss', { stillUrl: undefined })
  assert.equal(doc.invalidWriteCount, 0, 'a loose passthrough key tolerates null — do not punish the common case')
  assert.ok(validateShape(doc.getShape('shape:ss')).ok, 'and the read-back validates')
}

// --- DRIFT GUARD: the normalizer must match what Loro ACTUALLY stores ---
// This is what makes "validate the post-serialization form" safe to rely on.
// If Loro's coercion ever changes, this fails loudly rather than silently
// reopening the write boundary.
{
  const doc = LoroCanvasDoc.create({ peerId: 22n })
  doc.putPage({ id: 'page:p', name: 'P' })
  const probes: Record<string, unknown> = {
    plainUndefined: undefined,
    nested: { a: undefined, b: 1 },
    inArray: [1, undefined, 3],
    keptNumber: -0,
    keptString: 'x',
  }
  doc.putShapeUnchecked({ id: 'shape:p', kind: 'frame', parentId: 'page:p', props: probes, ...base() } as never)
  doc.commit()
  const stored = doc.getShape('shape:p')!.props
  // asStored is the module-private normalizer; assert its output equals what
  // Loro really wrote. Export it for the test, or re-derive it here — but the
  // comparison must be against a REAL write/read-back, never a hand-written
  // expectation, or the guard proves nothing.
  assert.deepEqual(stored.plainUndefined, null, 'undefined -> null')
  assert.deepEqual(stored.nested, { a: null, b: 1 }, 'nested undefined -> null')
  assert.deepEqual(stored.inArray, [1, null, 3], 'array undefined -> null')
  assert.equal(stored.keptNumber, 0, '-0 is stored faithfully')
  assert.equal(stored.keptString, 'x', 'strings are untouched')
}

console.log('ok: serialization-seam')
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/serialization-seam.test.ts
```

Expected: FAIL at `updateProps rejects a patch that would STORE null in a typed
field` (`0 !== 1`) — today the patch is accepted. **Record the verbatim output.**

**Step 3: Implement**

Add the normalizer to `canvas-doc/src/loro-canvas-doc.ts`, above the class:

```ts
// Loro stores `undefined` as `null` — verified by probe across props, nested
// objects, array elements, meta and envelope fields alike. Validating the
// pre-serialization object therefore judges a DIFFERENT value than the one
// read back: z.number().optional() accepts `undefined` but rejects `null`, so
// `{ w: undefined }` passed the write boundary and then failed validation on
// the next read — handing repair() a dropShape for a shape the boundary had
// just approved, taking its whole subtree with it.
//
// `undefined` is the ONLY such divergence (probe-verified: NaN, Infinity,
// Date, Map and bigint are each already rejected pre-serialization; -0 and
// explicit null round-trip faithfully), so this is one rule, not a model of
// Loro's value marshaling. serialization-seam.test.ts pins it against a real
// write/read-back so it cannot drift silently.
function asStored<T>(value: T): T {
  if (value === undefined) return null as unknown as T
  if (Array.isArray(value)) return value.map(asStored) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = asStored(v)
    return out as unknown as T
  }
  return value
}
```

Then use it at **both** call sites — validate the normalized form, store the
original (Loro produces the same normalization):

```ts
    const v = validateShape(asStored(s))                       // putShape
```
```ts
    const v = validateShape(asStored({ ...shape, props: merged }))   // updateProps
```

**Step 4: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/serialization-seam.test.ts
cd /home/stag/src/projects/ensembleworks/canvas-doc && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks/canvas-editor && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks/canvas-sync && ~/.bun/bin/bun test.ts
```

Expected: all pass. **If a tool FSM or rig suite newly fails, STOP and report** —
that means a real caller relies on passing `undefined` for a typed field, which
is exactly the kind of thing this task should surface rather than paper over.

**Step 5: Correct the `putShape` comment's now-qualified claim**

The comment says "anything accepted here is something `repair()` will not later
act on." That was true only modulo this seam. With `asStored` in place it is
true without qualification — add the reason so a reader knows it is load-bearing:

```
    // ...anything accepted here is something repair() will not later act on.
    // Validation runs on asStored(s), NOT on `s`: repair() judges what Loro
    // STORED, and Loro turns `undefined` into `null`. Validating the raw
    // object would approve `{ w: undefined }` and then let repair() drop the
    // shape — and its whole subtree — on the next pass.
```

**Step 6: Fix the two smaller review items**

(a) **`CanvasDoc.updateProps`'s JSDoc overclaims.** It says "a patch that heals
an already-invalid shape is accepted." True only for **props** invalidity —
`validateShape` checks the whole envelope, so a shape with e.g.
`opacity: 'opaque'` can never be prop-updated again; every patch is refused.
Reachable only for `import()`-delivered shapes, and such a shape is
`dropShape`-doomed anyway, so refusing is defensible — but say it accurately:

```
   * a patch that heals an already-invalid shape is accepted — but only if the
   * shape's invalidity is in its PROPS. validateShape checks the whole
   * envelope, so a shape whose envelope is invalid (e.g. opacity: 'opaque',
   * reachable only via import()) can never be prop-updated again: every patch
   * is refused. Defensible, since such a shape is dropShape-doomed anyway.
```

(b) **Empty patch inflates the counter.** `updateProps(id, {})` on an
already-invalid shape is currently rejected and counted, though `{}` writes
nothing. **Decision: fix it** — an empty patch is a no-op by definition, and
counting it misreports "writes refused" for a call that attempted no write.
One line, at the top of `updateProps`, matching the existing unknown-id no-op:

```ts
    if (Object.keys(props).length === 0) return // empty patch: a no-op by definition, not a rejection
```

Add an assertion for it in `write-validation.test.ts`:

```ts
  doc.updateProps('shape:invalid', {})
  assert.equal(doc.invalidWriteCount, before, 'an empty patch is a no-op, not a counted rejection')
```

**Step 7: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/canvas-doc.ts canvas-doc/src/serialization-seam.test.ts canvas-doc/src/write-validation.test.ts
git commit -m "fix(canvas-doc): validate the post-serialization form so undefined cannot smuggle null past the boundary"
```

### ✅ Task 4N LANDED at `b5031d0` — three deliberate deviations from the text above

All three are **accepted**. Recorded so a plan-to-code diff does not read as
drift, and so nobody "simplifies" them back.

**1. `asStored` is exported.** Not prescribed above. It is exported
*specifically so the drift guard can compare against it* — see deviation 2 —
and its doc comment says so. It is **not** general public API: nothing outside
`canvas-doc` should call it, and a future reader should not treat the export as
an invitation.

**2. The drift guard was STRENGTHENED, and this is the version that matters.**
Step 1's sketch asserted hand-written expectations about Loro's output
(`assert.deepEqual(stored.nested, { a: null, b: 1 })`). That pins *Loro*, but it
never compares `asStored` against Loro — so it is not a drift guard at all, and
Step 1's own comment warned against exactly that mistake ("the comparison must
be against a REAL write/read-back, never a hand-written expectation, or the
guard proves nothing"). The plan then made the mistake it warned about. The
landed version asserts:

```ts
assert.deepEqual(asStored(probes), stored)
```

against a real write and read-back. **That is the intended form.** It is what
"Why write validation cannot lose data" now rests on. Do not replace it with
literal expectations, however much more readable they look — readable and
vacuous.

**3. A second empty-patch case was added**, beyond the props-invalid one Step
6(b) specified: an **envelope-invalid** pre-image (`opacity: 'opaque'`, seeded
via `putShapeUnchecked`). Accepted — it covers the case Step 6(a)'s JSDoc
correction is about, where *no* patch can ever heal the shape, and confirms an
empty patch is still a no-op there rather than a counted rejection.

---

## Task 4A: Make the sink reachable in production (review finding 1)

> **Task 4N runs before this one** — see its header for why it is lettered out
> of alphabetical order.

Everything so far reports into a hook that **nothing in the browser can
supply**. This task closes that.

### Why here, and not earlier or later

Placed **after Task 4** because both write paths must actually validate before
anything is wired to report on them — a sink attached to a half-built boundary
reports on an incomplete surface and invites a green dashboard that means
nothing. Placed **before Task 5** because it completes half (A): half (A)'s
claim is "local writers can no longer originate invalid state, observably", and
without this task the "observably" is false on the client. It is also the first
task that leaves `canvas-doc`, so keeping it here holds the clean-room package
edits contiguous in Tasks 1–4.

**Files:**
- Modify: `canvas-sync/src/client-peer.ts` (`SyncClientOpts` at line 6 + the doc
  construction at line 50 — both line numbers **re-verified at `e7ced0f`**)
- Modify: `client/src/canvas-v2/DevOverlay.tsx` (`ClientTelemetry` at line 67 +
  one `Field` next to line 138)
- Modify: `client/src/canvas-v2/DevOverlay.test.ts` (**four** `client:` fixture
  literals — lines 25, 58, 82, 103; see Step 6)
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (the `client={{ … }}` prop at
  line 448)
- Create: `canvas-sync/src/invalid-write-passthrough.test.ts`

> **CLEAN-ROOM REMINDER.** `canvas-sync/src/client-peer.ts` is scanned by
> `canvas-sync/src/boundary.test.ts`, which text-matches **inside comments**.
> Do not write the literals `Date.now(` or `Math.random(` anywhere in that file,
> not even in prose — including the new `onInvalidWrite` doc comment.
>
> Scope, verified at `e7ced0f`: the scanner globs `**/*.ts` relative to
> `canvas-sync/src` and **skips anything ending in `.test.ts`**
> (`boundary.test.ts:34`, "tests may inject/measure freely"). So
> `invalid-write-passthrough.test.ts` is *not* scanned — but write it as if it
> were; there is no reason for it to need those literals.

> **This task trips the ux-contract presence gate** — `client/src/canvas-v2/`
> is one of the three `INTERACTION_BEARING_PREFIXES`
> (`scripts/ux-contract-presence.test.ts:36`, verified at `e7ced0f`), and
> **three** files this task edits live under it: `DevOverlay.tsx`,
> `DevOverlay.test.ts` and `CanvasV2App.tsx`. `checkPresence` matches on
> `startsWith`, with no test-file exemption, so the `.test.ts` counts too. Owner
> ruling (2026-07-20): **acceptable.** The branch already requires a
> `ux-contract: none — <reason>` marker for the inherited PR-48 files, so this
> is absorbed into an existing cost rather than creating a new one. The marker
> text in "PR body — required content" has been updated to cover this change
> honestly, as this branch's own work — not to hide it among the inherited
> files.
>
> **One correction to carry there when you write the PR body:** that section's
> reason 2 names two files (`DevOverlay.tsx`, `CanvasV2App.tsx`). Step 6 adds a
> third, `DevOverlay.test.ts`. Name all three. The reason itself is unchanged —
> a read-only diagnostic readout with `pointerEvents: 'none'` (verified,
> `DevOverlay.tsx:133`), plus its fixture update; no gesture, no tool, no
> user-drivable state.

**Step 1: Write the failing test**

Create `canvas-sync/src/invalid-write-passthrough.test.ts`:

```ts
// Run: bun src/invalid-write-passthrough.test.ts
// Review finding 1: SyncClientPeer builds its own LoroCanvasDoc internally, so
// unless SyncClientOpts forwards onInvalidWrite the injected sink is
// UNREACHABLE in the browser — where essentially every rejection originates
// (Editor.applyAll -> applyOne -> doc.putShape). Without this passthrough the
// bounded console.warn is not a fallback, it is the only production behaviour.
import assert from 'node:assert/strict'
import type { InvalidWrite } from '@ensembleworks/canvas-doc'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

{
  const seen: InvalidWrite[] = []
  // makePair() returns [serverEnd, clientEnd]; this test never drives the
  // server end, so it is discarded. Same construction as client-peer.test.ts.
  const [, clientEnd] = makePair()
  const peer = new SyncClientPeer({
    peerId: 1n,
    transport: clientEnd,
    onInvalidWrite: (w) => seen.push(w),
  })
  peer.doc.putPage({ id: 'page:p', name: 'P' })
  peer.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)

  assert.equal(seen.length, 1, 'the sink injected into the PEER reached the doc it built internally')
  assert.equal(seen[0]!.op, 'putShape')
  assert.equal(seen[0]!.kind, 'frame')
  // SyncClientPeer.doc is already `readonly` and public, so a dashboard can
  // pull the count without any further surface change.
  assert.equal(peer.doc.invalidWriteCount, 1, 'the count is readable through the public doc')
  peer.close()
}

// Omitting the sink stays legal, and this is the assertion that keeps it so:
// every one of the ~50 existing `new SyncClientPeer` call sites in the repo
// passes only peerId/transport/presence, and none of them should have to change.
{
  const [, clientEnd] = makePair()
  const peer = new SyncClientPeer({ peerId: 2n, transport: clientEnd })
  assert.equal(peer.doc.invalidWriteCount, 0)
  peer.close()
}

console.log('ok: invalid-write-passthrough')
```

> **CORRECTED 2026-07-20 — there is no `MemoryTransport`.** An earlier draft of
> this task imported `{ MemoryTransport }` and called `new MemoryTransport()`.
> `canvas-sync/src/memory-transport.ts` exports exactly one symbol,
> `makePair(): [Transport, Transport]` — a paired-transport factory, not a
> class. Verified two ways: `grep -rn "MemoryTransport" --include="*.ts"` over
> the repo (excluding `node_modules`/`.worktrees`) returns **zero** hits, and
> every one of `client-peer.test.ts`'s peers is built from `makePair()` (lines
> 34, 54, 95, 135). This was not a cosmetic error: the bad import would have
> thrown at module load, so the RED would have landed on a **missing export**
> rather than on the named assertion — precisely the failure mode the working
> rules forbid ("Every RED in this plan lands on a runtime assertion").

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/invalid-write-passthrough.test.ts
```

Expected: FAIL on the first assertion. **This was executed against `e7ced0f`**;
the verbatim tail is:

```
AssertionError: the sink injected into the PEER reached the doc it built internally

0 !== 1

 generatedMessage: false,
     actual: 0,
   expected: 1,
   operator: "strictEqual",
       code: "ERR_ASSERTION"
```

`SyncClientOpts` has no `onInvalidWrite` field, so the object property is simply
ignored at runtime. **Record your own verbatim output anyway** — a run that
differs in text but still lands on this assertion is a correct RED; only a
*passing* test is grounds to stop.

Two things the real run also shows, both expected — do not treat either as a
problem:

- **The doc's fallback `console.warn` fires first**, printing
  `[canvas-doc] rejected invalid putShape (frame) shape:bad [#1]: …`. That is
  the point of the task made visible: the write *is* already being rejected and
  counted; only the injected sink is unreachable, leaving the bounded
  `console.warn` as the sole production signal.
- **Do not run `bun run typecheck` between Steps 2 and 3.** Passing
  `onInvalidWrite` to a `SyncClientOpts` that lacks it is an excess-property
  error on an object literal, so tsc fails for a reason unrelated to the RED.
  bun erases types, so the single-file run above is unaffected. Step 3 removes
  the error; typecheck runs at Step 7.

**Step 3: Forward the sink in `canvas-sync/src/client-peer.ts`**

`SyncClientOpts` (line 6) currently declares exactly three members — `peerId`,
`transport` and an optional `presence`. Add a fourth:

```ts
  /** Optional: forwarded to the LoroCanvasDoc this peer builds internally, so
   * a host can observe writes the doc REFUSED. Without this passthrough the
   * sink is unreachable from the browser — this peer owns its doc's
   * construction, and the client constructs the PEER, never the doc. */
  onInvalidWrite?: InvalidWriteHandler
```

with `InvalidWriteHandler` imported as a **type-only** import from
`@ensembleworks/canvas-doc` (exported from `canvas-doc/src/canvas-doc.ts:44`,
alongside `InvalidWrite`).

Then change line 50 — verified at `e7ced0f` as the file's only
`LoroCanvasDoc.create` call:

```ts
    // before
    this.doc = LoroCanvasDoc.create({ peerId: opts.peerId })
    // after
    this.doc = LoroCanvasDoc.create({ peerId: opts.peerId, onInvalidWrite: opts.onInvalidWrite })
```

`LoroCanvasDoc.create` **already accepts** `onInvalidWrite` — its signature is
`static create(opts: { peerId: bigint; onInvalidWrite?: InvalidWriteHandler })`
(`canvas-doc/src/loro-canvas-doc.ts:77`), landed by Task 1/1A, and it passes the
handler straight to the private constructor. So **no `canvas-doc` change is
needed here**: the entire gap is that `canvas-sync` never forwards it.

**Step 4: Run the test to verify it passes**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/invalid-write-passthrough.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/boundary.test.ts
```

Expected: `ok: invalid-write-passthrough`, then `ok: boundary`.

**Step 5: Surface the count in the dev overlay**

`client/src/canvas-v2/DevOverlay.tsx` declares `ClientTelemetry` at line 67 with
exactly two members, and renders each through a shared `Field` component
(defined at line 89) — `repairCount` at line 138, `lastBackfillBytes` at line
139. Both verified at `e7ced0f`. Add one member:

```ts
export interface ClientTelemetry {
	readonly repairCount: number
	readonly lastBackfillBytes: number
	/** Writes this client's doc REFUSED (canvas-doc's invalidWriteCount). A
	 * non-zero value means a local tool is emitting shapes that fail the
	 * model schema — the write was dropped, so nothing is corrupted, but the
	 * gesture that produced it silently did nothing. */
	readonly invalidWriteCount: number
}
```

(`DevOverlay.tsx` is **tab**-indented — match it.)

and, immediately after the existing `repairCount` line (138) in the rendered
list:

```tsx
			<Field label="invalidWrites" value={client.invalidWriteCount} />
```

(The label/member mismatch is deliberate — see the note under Step 6.)

Then update the `client={{ … }}` prop on the `<DevOverlay>` element in
`client/src/canvas-v2/CanvasV2App.tsx`. It is at **line 448** (the element opens
at 445) and reads, verbatim at `e7ced0f`:

```tsx
					client={{ repairCount: session?.peer.repairCount ?? 0, lastBackfillBytes: session?.peer.lastBackfillBytes ?? 0 }}
```

Note the shape: every field is read off `session?.peer` with a `?? 0` fallback,
because `session` is nullable before boot resolves. The new field must follow
that convention — and it reaches one level deeper, through the peer's public
`readonly doc`:

```tsx
					client={{ repairCount: session?.peer.repairCount ?? 0, lastBackfillBytes: session?.peer.lastBackfillBytes ?? 0, invalidWriteCount: session?.peer.doc.invalidWriteCount ?? 0 }}
```

(`session?.peer.doc.invalidWriteCount`, **not** `peer.doc.invalidWriteCount` —
there is no bare `peer` binding in scope at that call site.) Do not restructure
the call site otherwise.

> `DevOverlay` renders from a plain prop, refreshed on the same cadence as the
> existing fields. Do **not** add a subscription, a poll, or state for this
> value; it must cost nothing when the overlay is hidden, exactly like
> `repairCount`.

**Step 6: Update the four `DevOverlay.test.ts` fixtures**

`invalidWriteCount` is a **required** member of `ClientTelemetry`, so every
existing literal that builds a `client` prop stops compiling the moment Step 5
lands. There are exactly **four**, all in
`client/src/canvas-v2/DevOverlay.test.ts` — lines 25, 58, 82 and 103 (counted by
`grep -n "client:" client/src/canvas-v2/DevOverlay.test.ts` at `e7ced0f`; no
other file in the repo constructs a `ClientTelemetry`). Add
`invalidWriteCount: 0` to each.

This is a mechanical compile fix, not new behaviour, so it has no RED of its
own. Optionally extend the existing repairCount-renders assertion (line 31) with
a matching one for the new field — a rendered-value check is cheap and is the
only place the `invalidWrites` label is pinned.

> Why the label and the member disagree: the `Field` label reads
> `invalidWrites` (a human-facing count of events) while the API member is
> `invalidWriteCount`. Deliberate — that is exactly the collision Task 1A's
> finding 4 removed from the *code*; a display string has no type to collide
> with.

**Step 7: Typecheck and run the affected suites**

```
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/canvas-sync' typecheck
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/client' typecheck
cd /home/stag/src/projects/ensembleworks && export PATH="$HOME/.bun/bin:$PATH" && cd canvas-sync && bun test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/boundary.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun client/src/canvas-v2/DevOverlay.test.ts
```

Expected: all pass. Existing peers constructed without `onInvalidWrite` are
unaffected — the field is optional, and `client-peer.test.ts` needs no edit.

(The `export PATH=…` on the package-level line is required: `canvas-sync/test.ts`
spawns `bun` as a subprocess, and `bun` is usually off `PATH` here.)

**Step 8: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-sync/src/client-peer.ts canvas-sync/src/invalid-write-passthrough.test.ts client/src/canvas-v2/DevOverlay.tsx client/src/canvas-v2/DevOverlay.test.ts client/src/canvas-v2/CanvasV2App.tsx
git commit -m "feat(canvas-sync,client): forward the invalid-write sink and surface the count"
```

---

## Task 4B: Make `reconcile()`'s refusals visible (review finding 2)

### Why here

This is the server-side twin of Task 4A: 4A makes rejections visible to a
developer in the browser, 4B makes them visible to the shadow dashboard. Both
consume `invalidWriteCount`, both leave `canvas-doc` for a consuming package,
and both are pure observability with no effect on the write path — so they
belong adjacent and commit separately. It must come **after** Task 4 because a
`refused` count that omits `updateProps` rejections would be misleading from the
day it shipped, even though `reconcile` itself only calls `putShape`.

**Files:**
- Modify: `server/src/canvas-v2/reconcile.ts`
- Modify: `server/src/canvas-v2/reconcile.test.ts`

### The problem

`server/src/canvas-v2/reconcile.ts:77`:

```ts
if (!prev || !shallowEqualShape(prev, s)) { doc.putShape(s); puts++ }
```

`puts++` is unconditional and **cannot tell a refusal from a write.** The shapes
come from `fromTldraw` via `server/src/canvas-v2/convert.ts`, which passes
`props: r.props ?? {}` **verbatim** from live tldraw records with no validation
— and notably *unlike* `opacity: r.opacity ?? 1` and `isLocked: !!r.isLocked` on
the adjacent lines, which **are** coerced. Verified in source.

So a live room carrying a malformed prop — the exact scenario motivating this
whole branch — now yields:

```
shape absent → !prev → putShape → refused → still absent
            → next shadow tick → repeat, forever
```

**`reconcile` never converges.** `puts` reports a nonzero delta every tick and
the shadow divergence signal never clears.

This is *better* than the old behaviour — it no longer feeds the cascade-delete
— but it changes what the shadow dashboard **means**, and a permanently-nonzero
divergence with no explanation is exactly how a genuine regression six months
later gets waved away as "oh, that number's always been nonzero." Existing suites
miss it because their fixtures are well-formed.

**Step 1: Write the failing test**

Add to `server/src/canvas-v2/reconcile.test.ts` — follow the file's existing
fixture-construction style rather than the sketch below:

```ts
// A target carrying a shape whose props fail validateShape (the legacy-room
// scenario: convert.ts passes tldraw props through verbatim). reconcile must
// REPORT the refusal rather than counting it as a put — otherwise the shadow
// dashboard shows a permanent nonzero divergence with no way to tell a
// refusal from a genuine pending write.
const r = reconcile(doc, targetWithOneInvalidShape)
assert.equal(r.refused, 1, 'the refused write is reported, not counted as a put')
assert.equal(r.puts, 0, 'a refused write is NOT a put')
// And it is stable: a second pass reports the same thing, so a reader can tell
// "converged, minus a known-bad shape" from "still making progress".
const r2 = reconcile(doc, targetWithOneInvalidShape)
assert.deepEqual({ puts: r2.puts, refused: r2.refused }, { puts: 0, refused: 1 })
```

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/reconcile.test.ts
```

Expected: FAIL — `refused` is not a property of the return type, so the
assertion reads `undefined !== 1`. **Record the verbatim output.**

**Step 3: Implement**

Take an `invalidWriteCount` delta across the put loop and widen the return type:

```ts
export function reconcile(doc: LoroCanvasDoc, target: CanvasDocument): { puts: number; deletes: number; refused: number } {
```

```ts
	// Bracket the put loop with the doc's rejection counter so a REFUSED write
	// is distinguishable from a completed one. Without this, `puts` counts both
	// and a room carrying a shape the write boundary refuses reports a nonzero
	// delta on every tick forever — reconcile cannot converge on it, and the
	// shadow divergence signal never clears. That is not a regression (the old
	// behaviour wrote it and let repair() cascade-delete the subtree), but it
	// changes what the dashboard MEANS, so it must be legible rather than
	// silently folded into `puts`.
	const refusedBefore = doc.invalidWriteCount
	for (const s of ordered) {
		const prev = curShapesAfter.get(s.id)
		if (!prev || !shallowEqualShape(prev, s)) {
			doc.putShape(s)
			puts++
		}
	}
	const refused = doc.invalidWriteCount - refusedBefore
	puts -= refused // a refusal is not a put
```

Then update `reconcile`'s doc comment (the `puts`/`deletes` note around line 36)
to document `refused` and the non-convergence it makes visible.

> **Do NOT "fix" this by calling `putShapeUnchecked` in `reconcile`.** That
> would restore the exact data-loss path this branch exists to close — the shape
> would be written and then cascade-deleted by `repair()` on every peer. The
> non-convergence is the *correct* observable consequence of refusing to write
> invalid data; the fix is to make it legible, which is what this task does.
> Task 8A's CI gate will reject that call outright.

**Step 4: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/reconcile.test.ts
cd /home/stag/src/projects/ensembleworks && bun run --filter '@ensembleworks/server' typecheck
```

Expected: pass, and every existing `reconcile` caller still typechecks — the
return type only gained a field.

**Step 5: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add server/src/canvas-v2/reconcile.ts server/src/canvas-v2/reconcile.test.ts
git commit -m "feat(server): report refused writes from reconcile so divergence stays legible"
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

## Task 8A: CI presence gate for `putShapeUnchecked` (review finding 5)

Task 3A corrected `putShapeUnchecked`'s JSDoc to admit the interface omission is
a **signal, not a barrier**. This task supplies the barrier.

### Why here, second-to-last

The gate needs the **complete** allowlist, and that is only knowable once every
task that legitimately calls `putShapeUnchecked` has landed — Task 3 repointed
the repair fixtures, and Tasks 5–7 may add more. Writing it earlier means
editing the allowlist repeatedly and, worse, risks someone widening it
reflexively to make a red gate go green. It goes **before** Task 9 so the full
suite run there exercises it.

**Files:**
- Create: `scripts/put-shape-unchecked-audit.test.ts`

> **Follow the existing pattern, do not invent one.** The repo already does this
> twice — `scripts/ux-contract-presence.test.ts` and `scripts/exposure-audit.ts`.
> Read `ux-contract-presence.test.ts` first: note the `.test.ts` suffix (so
> `scripts/run-tests.ts` picks it up via its `scripts/*.test.ts` glob), the
> exported **pure decision function** unit-tested with synthetic inputs, and the
> real-repo check that skips rather than false-fails when its inputs are
> unavailable. Mirror all three.

**Step 1: Write the failing test**

The gate: grep the repo for `putShapeUnchecked` and fail on any hit outside the
allowlist.

```ts
// Run: bun scripts/put-shape-unchecked-audit.test.ts
//
// LoroCanvasDoc.putShapeUnchecked bypasses the write boundary — it writes a
// shape that validateShape rejects, which is precisely the state repair() is
// obliged to destroy (cascading to the subtree before Task 5, and dropping the
// shape after it). It exists ONLY so tests and hostile-state rigs can
// construct what a remote peer's bytes can deliver.
//
// Keeping it off the CanvasDoc interface is a signal, not a barrier:
// SyncServerPeer.doc, SyncClientPeer.doc, ShadowMirror.doc and reconcile()'s
// parameter are all typed as the CONCRETE LoroCanvasDoc, so anyone typing
// `peer.doc.` gets it in autocomplete. reconcile.ts in particular is where a
// developer chasing a non-converging shadow tick would reach for it as the
// "fix" — which would restore the exact data-loss path this branch closed.
//
// This gate is that barrier. Adding an entry to ALLOWED is a deliberate,
// reviewable act; it must never be done to turn a red gate green.
const ALLOWED = [
  'canvas-doc/src/repair.test.ts',
  'canvas-doc/src/repair-cost.test.ts',
  'canvas-doc/src/write-validation.test.ts',
  'canvas-doc/src/loro-canvas-doc.ts',   // the declaration itself
  'scripts/put-shape-unchecked-audit.test.ts', // this file
] as const
```

Write `checkUsages(hits: readonly string[]): string[]` returning the
disallowed paths, unit-test it with synthetic inputs (an allowed path, a
disallowed one, an empty list), then run the real check over
`git grep -l putShapeUnchecked` (or a `Glob` scan — match whatever
`exposure-audit.ts` does).

Add the allowlist entries for whichever files Tasks 5–7 actually ended up
using it in; do not pre-populate speculatively.

**Step 2: Run it to verify it fails**

Temporarily add a `putShapeUnchecked` call to a non-allowlisted file — a scratch
line in `server/src/canvas-v2/reconcile.ts` is the realistic case — and run:

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun scripts/put-shape-unchecked-audit.test.ts
```

Expected: FAIL naming `server/src/canvas-v2/reconcile.ts`. **Record the verbatim
output, then remove the scratch line.** This is the one RED in this task that
matters — a gate that has never been observed failing is not known to work.

**Step 3: Confirm it passes on the real tree**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun scripts/put-shape-unchecked-audit.test.ts
```

Expected: pass, listing the allowed call sites it found.

**Step 4: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add scripts/put-shape-unchecked-audit.test.ts
git commit -m "ci: gate putShapeUnchecked usage to tests and hostile-state rigs"
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
> Task 1's three files were verified to pass the gate cleanly, and this plan's
> `canvas-doc/` and `canvas-model/` work is correctly *not* an
> interaction-bearing surface.
>
> **Task 4A adds a second, genuinely-ours reason.** It edits
> `client/src/canvas-v2/DevOverlay.tsx`, `CanvasV2App.tsx` and
> `DevOverlay.test.ts` — **three** files, all under an interaction-bearing
> prefix. The `.test.ts` counts because `checkPresence` matches on
> `startsWith` with no test-file exemption
> (`scripts/ux-contract-presence.test.ts:36,72`); it is edited because
> `invalidWriteCount` lands as a *required* `ClientTelemetry` member, so four
> fixture literals stop compiling until they account for it. Owner ruling
> 2026-07-20: acceptable, because the marker is required for the inherited
> files anyway, so this is absorbed rather than new cost. The marker text must
> say so **honestly** — it no longer reads as covering only inherited files.
>
> So by Task 9 the gate is tripped by **two** sets of files: the inherited PR-48
> ones and Task 4A's three client files. Both are covered by the single marker
> below. Do **not** "fix" it by editing `scripts/ux-contract-presence.test.ts`,
> by reverting PR-48 files, or by declaring an interaction contract for
> `canvas-doc`. If the gate flags any file outside those two sets, STOP and
> report — that would be a real violation, not this known one.

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

**The `ux-contract` marker is REQUIRED for CI to pass.** It covers **two**
distinct sets of files, and the text must be honest about both:

1. **Inherited.** `scripts/ux-contract-presence.test.ts` already fails at
   `aa6a115`, before any task here ran, because PR 48 (in this branch's stack)
   touches `client/src/canvas-v2/` — `CanvasV2App.tsx`,
   `boot-sync-ready.test.ts`, `bootstrap-page.ts`.
2. **This branch's own.** Task 4A edits `DevOverlay.tsx` and `CanvasV2App.tsx`
   under the same prefix, to surface `invalidWriteCount`. Owner-approved
   2026-07-20 on the grounds that the marker was needed anyway — but it is our
   change and the marker says so.

The PR must include, verbatim:

```
ux-contract: none — <two reasons, both stated deliberately>

1. This branch's core change is confined to canvas-model (repair/invariants),
   canvas-doc (the CRDT write boundary) and canvas-sync (forwarding the
   invalid-write sink). None is an interaction surface: no tool FSM, no
   renderer, no input handling.

2. This branch DOES touch client/src/canvas-v2/ in two places of its own —
   DevOverlay.tsx and CanvasV2App.tsx — to render the invalidWriteCount
   telemetry field added by Task 4A. That is a read-only diagnostic readout
   with pointerEvents: none; it adds no gesture, no tool, and no state a user
   can drive, so there is no interaction to seed or invariant to observe.

3. The gate additionally flags client/src/canvas-v2/ files inherited from
   PR 48 in this stack (CanvasV2App.tsx, boot-sync-ready.test.ts,
   bootstrap-page.ts). Those changes belong to PR 48, not to this work.
```

Plus:

- The verbatim RED output recorded for Tasks 1, 2, 4, 5 and 6, and the
  revert-and-observe note from Task 7.
- **The undo/redo behaviour change (decision D3a).** State it plainly, because
  it is user-visible and will otherwise be debugged from scratch months later:

  > Undo/redo of an **already-invalid** shape is now a silent no-op — the
  > symptom is "my undo/redo did nothing" for that one shape.
  > `Editor.replay()`'s `putShape` inverses carry whole shapes read back out of
  > the doc, so such a shape can reach the undo stack; replaying it now hits the
  > write boundary and is dropped rather than restored. It gets there by exactly
  > one route — `import()`, the only path into the client's doc that bypasses
  > the write boundary — which covers both a live remote peer running older code
  > and a room whose stored SQLite predates the boundary (the server loads that
  > via `fromSnapshot` and relays it as an ordinary import; the client's own doc
  > is never built by `fromSnapshot`). This is
  > deliberate: restoring it would re-manufacture exactly the state `repair()`
  > is obliged to destroy. It is safe because `Editor.replay` already has a
  > per-op `try`/`catch` and a documented tolerance contract for inverses that
  > cannot apply — unlike `Editor.applyAll`, which is why rejection is a no-op
  > rather than a throw.

- **The structural safety argument**, in one line: the predicate that rejects a
  write (`validateShape`) is the same function `repair()` uses to decide what to
  destroy (`invariants.ts:16` → `repair.ts:24`), so over-eager validation cannot
  lose data the pre-fix code preserved — it can only convert "write, then
  cascade-delete everywhere, durably" into "never write."

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
