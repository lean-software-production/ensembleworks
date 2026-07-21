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
- **BOTH runners are FAIL-FAST, and this WILL mislead you mid-branch.**
  `scripts/run-tests.ts` calls `process.exit(1)` on the first failing file;
  each package's `test.ts` does the same across its own files. Neither
  reports "N passed, 1 failed" — the run simply STOPS, and everything
  alphabetically after the failure never executes and is never mentioned.
  - This matters here specifically. Tasks 5 and 5A deliberately leave
    `canvas-doc/src/repair.test.ts` RED until Task 6 lands. `canvas-doc`
    sorts early, so while that RED stands **a full-suite run tells you
    nothing about `canvas-editor`, `canvas-react`, `canvas-sync`, `client`,
    `server`, `scripts/` or `e2e/lib/`** — they were not run.
  - Do NOT read an early stop as "everything after it passed", and do NOT
    report a suite as green on the strength of a run that halted early.
  - While an expected RED is outstanding, verify the remainder by running
    the files directly rather than through either runner. The known-RED file
    must be excluded deliberately and named in your report, so the exclusion
    is visible rather than implied.
  - Check the EXIT CODE, not just the tail of the output. If you wrap the run
    in a compound shell command, `$?` is the last command's status, not the
    suite's — capture the suite's own code explicitly. (This bit me on
    2026-07-20: a compound command ending in `tail` reported success while
    the suite underneath had exited 1.)
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

> **AMENDED by ruling 11 / Task 5A (2026-07-20).** The rescue target below —
> `canonicalPageId` — is what Task 5 landed and is **no longer the rule**: a
> rescued child now stays on the page it was already on, and `canonicalPageId`
> survives as `reparentToRoot`'s target and as the rescue *fallback*. The
> purity requirement this decision exists to state is unchanged; only the
> target moved from doc-wide to per-shape. See Task 5A.

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

### Ruling 11 — Rescue target (2026-07-20, tightening ruling 1): **SAME PAGE.**

**Recorded after Task 5 landed**, which is why it arrives as its own task (5A)
rather than as an edit to Task 5's text.

Task 5 rescues a dropped shape's direct children to `canonicalPageId` — the
lexicographically smallest page id, reused from `reparentToRoot`. **The owner
has ruled that a rescued child must instead stay on the page it was already
on.** Moving a shape to a different page is not acceptable.

**Ruling 1 is unchanged and NOT re-opened.** A rescued child still keeps its
parent-relative `x`/`y` and may appear at a different on-screen position.
*Position may shift; page membership may not.* Coordinate-preserving rescue
remains a deferred follow-up.

Scope of the change, stated so it cannot be over-applied: **only the rescue
path.** `reparentToRoot` (orphan/cycle repair) keeps targeting
`canonicalPageId` — an orphan has no page to stay on, which is the entire
reason that op exists. Task 5A works out the edges (chained drops, cycles,
missing page ancestors, zero-page docs, purity) and specifies each.

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
| 4A | 2026-07-20 | Task 1 quality review, finding 1 (ruling 5) | ✅ landed `8939f32` + `6d55bc7` |
| 4B | 2026-07-20 | Task 2 quality review, finding 2 (ruling 8) | ✅ landed `a443b9d` |
| 5 | original | — | ✅ landed `764bdd3` + `cad6bfc` + `5c67923` |
| **5A** | 2026-07-20 | Owner tightened the rescue-target ruling AFTER Task 5 landed (ruling 11) | ✅ landed `7880853` + `5685c18` |
| **6A** | 2026-07-21 | Task 6's model-agreement claim exposed a pre-existing physical/logical rescue divergence (see its section) | pending |
| 8A | 2026-07-20 | Task 2 quality review, finding 5 (ruling 8) — the CI gate | pending |

**Execution order is the table's order, not alphabetical:**
1 → 1A → 1B → 2 → 3 → 3A → 4 → **4N** → 4A → 4B → 5 → **5A** → 6 → **6A** → 7 → 8 → 8A → 9.
`6A` is lettered like the others: it closes a divergence Task 6 made
load-bearing but did not itself introduce (it is pre-existing — see the Task 6A
section), and renaming later tasks would break this document's cross-references.
`4N` is lettered out of sequence deliberately: renaming the existing `4A`/`4B`
would break this document's many cross-references to them.

**Start at Task 6A.** Half (A) is complete: the write boundary, its central
safety claim (Task 4N, `b5031d0`), and its observability (4A, 4B) have all
landed. Half (B) has landed the pure-model proportionality (5), the corrected
same-page rescue target (5A, `7880853` + `5685c18`) and the Loro application
(6, `414375a`). What remains is 6A — closing the physical/logical rescue
divergence that Task 6's model-agreement claim made load-bearing — then 7, 8,
8A and 9.

> **Note for anyone running `canvas-doc`'s suite from here on — this note
> CHANGED on 2026-07-21.**
> There is **NO expected RED** any more. Task 5's deliberate hand-off (the
> `doc3` block's `'Loro and model application agree (order-independent)'`)
> was discharged when Task 6 landed at `414375a`; every file in `canvas-doc`,
> `canvas-model` and `canvas-sync` now passes on a clean tree at `933314e`
> (measured, all files run directly). **Anything failing is a real finding.**
> Separately, `canvas-doc/test.ts` exits on the FIRST failing suite and
> silently leaves later suites **unrun** — always run the files directly
> rather than reading its early exit as "everything after passed".

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

> **CORRECTED 2026-07-20 — the first draft's RED was weak.** An earlier
> version of this step (below, superseded) routed every write through
> `peer.putShape`, which is exactly the one method a PEER-LEVEL wrapper can
> intercept. A mutant that keeps the `onInvalidWrite` field and signature
> intact but never actually forwards it to `LoroCanvasDoc.create` — instead
> having `SyncClientPeer.putShape` watch `doc.invalidWriteCount` for an
> increment and call the sink itself — passed that version unchanged.
> `peer.doc.invalidWriteCount === 1` is not discriminating either: the doc
> counts rejections whether or not a handler was injected, so that assertion
> is already true before the fix exists. Spec review caught this; the test
> below adds two discriminators (A and B) that a peer-level relay cannot
> fake, verified independently against the mutant described above.
>
> **SECOND CORRECTION 2026-07-20 — assertion B pinned only one arm of the
> else-branch contract.** B proves the sink-present direction: when a sink
> IS injected, the doc's own `console.warn` fallback must NOT also fire. But
> the third block (the no-sink case) asserted only
> `peer.doc.invalidWriteCount === 0` and never performed an invalid write at
> all, so it could not observe whether `console.warn` fires in that case —
> the other arm of the same else-branch contract
> (`canvas-doc.ts:41-43`: "When none is supplied the doc warns on the console
> instead — a rejection is never silent"). A mutant that defaults a missing
> sink to a no-op before forwarding it —
> `onInvalidWrite: opts.onInvalidWrite ?? (() => {})` — is a natural-looking
> line that silently kills that documented fallback for all sink-less call
> sites (53 measured at `ddf0a52` via `grep -rn "new SyncClientPeer"
> --include="*.ts" --include="*.tsx"`, minus this file's 4 minus
> `CanvasV2App.tsx`'s 1 doc-comment mention), yet passed both A and B
> unchanged: the doc DOES receive a (no-op) handler, so it never falls back
> to `console.warn`, and neither existing assertion performs a write in the
> no-sink case to notice. Closed by turning the third block into the exact
> mirror of B: perform one invalid write under a `console.warn` spy and
> assert the warning fired.

Create `canvas-sync/src/invalid-write-passthrough.test.ts`:

```ts
// Run: bun src/invalid-write-passthrough.test.ts
// Review finding 1: SyncClientPeer builds its own LoroCanvasDoc internally, so
// unless SyncClientOpts forwards onInvalidWrite the injected sink is
// UNREACHABLE in the browser — where essentially every rejection originates
// (Editor.applyAll -> applyOne -> doc.putShape). Without this passthrough the
// bounded console.warn is not a fallback, it is the only production behaviour.
//
// Spec-review finding (2026-07-20): the first version of this test routed
// every write through `peer.putShape`, which a PEER-LEVEL wrapper can
// intercept exactly as easily as a real construction-time forward — a mutant
// that has `SyncClientPeer.putShape` watch `doc.invalidWriteCount` and call
// the sink itself, WITHOUT ever passing `onInvalidWrite` into
// `LoroCanvasDoc.create`, passed this file unchanged. Assertions A, B and C
// below close that: A writes through `peer.doc` directly, a path a
// peer-level wrapper never sees; B proves the injected sink REPLACES the
// doc's own console.warn fallback (canvas-doc.ts:41-43: "When none is
// supplied the doc warns on the console instead") rather than merely
// running alongside it — a peer-level relay leaves the doc's own handler
// unset, so both fire; C proves the sink-absent arm of that same contract,
// which a `?? (() => {})` default would silently break for every
// sink-less call site.
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

  // --- A: bypass the peer wrapper entirely --------------------------------
  // A peer-level `putShape` interceptor (the mutant described above) never
  // observes a write made straight through `peer.doc` — only a real forward
  // (onInvalidWrite reaching LoroCanvasDoc.create) puts the sink in the
  // doc's own rejection path, which `peer.doc.putShape` hits directly.
  const seenBeforeDocWrite = seen.length
  peer.doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
  peer.doc.commit()
  assert.equal(seen.length - seenBeforeDocWrite, 1, 'A: doc-level write reached the injected sink')

  peer.close()
}

// --- B: the injected sink REPLACES the console.warn fallback -------------
// canvas-doc.ts:41-43 documents the fallback as an ELSE branch ("When none
// is supplied the doc warns on the console instead"). A real forward must
// therefore produce a sink call with NO warning; the mutant — which relays
// through the peer while leaving the doc's own onInvalidWrite unset —
// produces both, because the doc still thinks no handler was supplied.
{
  const seen: InvalidWrite[] = []
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const [, clientEnd] = makePair()
    const peer = new SyncClientPeer({
      peerId: 3n,
      transport: clientEnd,
      onInvalidWrite: (w) => seen.push(w),
    })
    peer.doc.putPage({ id: 'page:p', name: 'P' })
    peer.putShape({ id: 'shape:bad3', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(seen.length, 1, 'the sink fired')
    peer.close()
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 0, 'B: the doc used the injected sink INSTEAD of its console.warn fallback')
}

// --- C: omitting the sink leaves the console.warn fallback intact --------
// Omitting the sink stays legal, and this is the assertion that keeps it so:
// every existing `new SyncClientPeer` call site in the repo passes only
// peerId/transport/presence, and none of them should have to change. Mirrors
// B in the other direction: canvas-doc.ts:41-43's fallback ("When none is
// supplied the doc warns on the console instead") only holds if the peer's
// forward is the ACTUAL `onInvalidWrite` value, undefined included — a
// mutant that defaults a missing sink to a no-op function before forwarding
// it (`opts.onInvalidWrite ?? (() => {})`) still satisfies `invalidWriteCount
// === 0` below (that counter increments regardless of a handler), but it
// silently kills the console.warn fallback for every sink-less call site,
// because the doc now believes a handler WAS supplied. Only performing an
// invalid write and checking the warning actually fired can catch that.
{
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const [, clientEnd] = makePair()
    const peer = new SyncClientPeer({ peerId: 2n, transport: clientEnd })
    assert.equal(peer.doc.invalidWriteCount, 0, 'no invalid writes have happened yet')
    peer.doc.putPage({ id: 'page:p', name: 'P' })
    peer.putShape({ id: 'shape:bad4', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(peer.doc.invalidWriteCount, 1, 'the rejection was still counted')
    peer.close()
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 1, 'C: no sink supplied ⇒ the doc used its console.warn fallback')
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

> **Refreshed 2026-07-20 against `6d55bc7`** (after 1A/1B/3A/4/4N/4A landed).
> Four factual corrections and one RED-strength correction are marked inline.
>
> **SCOPE EXTENDED 2026-07-20 (owner ruling).** The refresh found that
> `refused` as originally scoped stopped at `reconcile`'s return value and
> reached nothing a human ever looks at — a task called "make refusals
> visible" that left the number unobservable in production. Ruling: extend it,
> **minimally** — one field on `ShadowMetrics`, one accumulate in `tick()`
> (Steps 5–8). Explicitly **not** in scope: alerting, thresholds, or any
> dashboard rendering. Surfacing the number where the existing metrics already
> surface is the whole ask.

### Why here

This is the server-side twin of Task 4A: 4A makes rejections visible to a
developer in the browser, 4B makes them visible on the shadow metrics
endpoint. Both consume `invalidWriteCount`, both leave `canvas-doc` for a
consuming package, and both are pure observability with no effect on the write
path — so they belong adjacent and commit separately. It must come **after**
Task 4 because a `refused` count that omitted `updateProps` rejections would be
misleading from the day it shipped.

The task has **two RED-first halves**, committed separately: Steps 1–4 make
`reconcile` *report* the refusal, Steps 5–8 make `ShadowMirror` *expose* it.
The second half is what closes the loop to a human — `createCanvasMetricsRouter`
serves `entry.mirror.metrics()` whole (`server/src/features/canvas-metrics.ts:47`,
typed `ReturnType<ShadowMirror['metrics']>`), so a field added to
`ShadowMetrics` reaches `GET /api/canvas/metrics` with **no change to that
router** — verified by reading it, and the reason one field plus one accumulate
is genuinely sufficient.

> **CORRECTED — `reconcile` calls more than `putShape`.** The ratified text
> said "`reconcile` itself only calls `putShape`". It also calls
> `deleteShape`, `putPage`/`deletePage` and `putBinding`/`deleteBinding`
> (`reconcile.ts:60, 86-92`). The delta bracket below is still exact, but for
> a different reason than "putShape is the only write": **`rejectWrite` has
> exactly two call sites in the whole repo** — `putShape`
> (`loro-canvas-doc.ts:237`) and `updateProps` (`:304`) — verified by
> `grep -n "rejectWrite(" canvas-doc/src/loro-canvas-doc.ts`, which returns
> the definition at `:165` and those two. `putPage` and `putBinding` are
> unvalidated one-liners (`:446`, `:455`). So no write outside the put loop
> can move the counter today, and bracketing the loop rather than the whole
> function is a *forward* guard: it stays correct if page/binding validation
> is ever added.

**Files:**
- Modify: `server/src/canvas-v2/reconcile.ts` (Steps 3a)
- Modify: `server/src/canvas-v2/reconcile.test.ts` (Steps 1, 3b)
- Modify: `server/src/canvas-v2/shadow.ts` (Step 7)
- Modify: `server/src/canvas-v2/shadow.test.ts` (Step 5)

`server/src/features/canvas-metrics.ts` needs **no** edit — see "Why here".

`server/` is **not** one of the ux-contract gate's `INTERACTION_BEARING_PREFIXES`
(`scripts/ux-contract-presence.test.ts:36` lists `canvas-editor/src/tools/`,
`canvas-react/src/`, `client/src/canvas-v2/` — verified at `6d55bc7`), so unlike
Task 4A this task adds nothing to the PR-body marker's burden.

### The problem

`server/src/canvas-v2/reconcile.ts:74-80` (tab-indented; the ratified text
quoted this as a single line, which it is not):

```ts
	for (const s of ordered) {
		const prev = curShapesAfter.get(s.id)
		if (!prev || !shallowEqualShape(prev, s)) {
			doc.putShape(s)
			puts++
		}
	}
```

`puts++` is unconditional and **cannot tell a refusal from a write.** The shapes
come from `fromTldraw` via `server/src/canvas-v2/convert.ts`, which passes
`props: r.props ?? {}` verbatim from live tldraw records with no validation
(`convert.ts:28`) — and notably *unlike* `isLocked: !!r.isLocked` (`:25`) and
`opacity: r.opacity ?? 1` (`:26`) two lines above, which **are** coerced.

So a live room carrying a malformed prop — the exact scenario motivating this
whole branch — yields:

```
shape absent → !prev → putShape → refused → still absent
            → next shadow tick → repeat, forever
```

**`reconcile` never converges.** `puts` reports a nonzero delta every tick and
the shadow divergence signal never clears.

**Measured, not reasoned (probe run at `6d55bc7`, then deleted).** A two-shape
target — one valid `note`, one `frame` with `props: { w: '100' }` — reconciled
three times into one fresh doc:

```
r1 {"puts":2,"deletes":0} invalidWriteCount 1   shapes after 1: [ "shape:ok" ]
r2 {"puts":1,"deletes":0} invalidWriteCount 2
r3 {"puts":1,"deletes":0} invalidWriteCount 3
```

Both halves of the claim hold: the refusal is counted as a put, and the doc
never converges. Note `invalidWriteCount` is a **lifetime** total that grows one
per tick — that is what makes assertion B below discriminating.

This is *better* than the old behaviour — it no longer feeds the cascade-delete
— but it changes what the shadow dashboard **means**, and a permanently-nonzero
divergence with no explanation is exactly how a genuine regression six months
later gets waved away as "oh, that number's always been nonzero." Existing
cases miss it because their fixtures are all well-formed.

**Step 1: Write the failing test**

> **CORRECTED — the ratified sketch was not runnable and its RED was weak.**
> It named `doc` and `targetWithOneInvalidShape`. `doc` is already bound at
> `reconcile.test.ts:34` to case 1's doc, which by then carries `model2`'s
> four shapes — reusing it would have reconciled against dirty state and
> produced deletes nobody predicted. And its fixture held *only* an invalid
> shape, so `assert.equal(r.puts, 0)` could not distinguish "the refused put
> was subtracted" from "nothing was ever put". The block below uses a fresh
> `doc5` and a fixture with **one valid shape alongside the invalid one**, so
> `puts` is a discriminating nonzero.

> **AMENDED 2026-07-20 (post-landing gap, mutant M8).** One valid shape
> alongside a single invalid one is enough to discriminate `puts` from
> `refused`, but not enough to discriminate `refused` as a **count** from
> `refused` as a **flag** — see the M8 row in the mutant table below. The
> block now carries a SECOND invalid shape (`shape:bad2`), failing for a
> different reason, so `refused` must read `2`, not `1`.

Insert as case 8 in `server/src/canvas-v2/reconcile.test.ts`, **before** the
final `console.log('ok: reconcile')` line — appending after it makes the suite
print its success line and *then* fail, which reads as a passing suite in a
scrollback. The file is **tab**-indented; match it. This block was executed at
`6d55bc7` (original, single-invalid-shape form) and re-executed 2026-07-20
after the `shape:bad2` amendment above — so **land it byte-identical** to the
current fence or re-record the RED yourself.

```ts
// --- 8) A target carrying a shape the write boundary REFUSES. convert.ts
// passes tldraw props through verbatim, so a legacy room can hand reconcile a
// shape validateShape rejects. The put is a NO-OP, so the shape stays absent
// and the next tick tries again — forever. reconcile must therefore report
// the refusal separately: folded into `puts` it is indistinguishable from a
// genuine pending write, and the shadow divergence signal reads as permanent
// unexplained churn.
//
// TWO distinct invalid shapes, failing for TWO distinct reasons, so `refused`
// is provably a COUNT and not merely a "did any refusal happen" flag:
// shape:bad fails the per-kind PROPS refinement (w is a string, frame wants a
// number); shape:bad2 fails the shared ENVELOPE check instead (index must be
// a non-empty string; verified against canvas-model/src/shape.ts's `envelope`
// schema, which validates index BEFORE the superRefine that runs propsByKind).
// A single-invalid-shape fixture cannot distinguish `refused` from
// `invalidWriteCount > before ? 1 : 0` — both read back as 1 either way. ---
const doc5 = LoroCanvasDoc.create({ peerId: 5n })
const withInvalid = makeDocument({
	pages: [{ id: 'page:p', name: 'Page' }],
	shapes: [
		{ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: { color: 'yellow' }, ...base() } as any,
		{ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as any,
		{ id: 'shape:bad2', kind: 'note', parentId: 'page:p', props: {}, ...base(), index: '' } as any,
	],
	bindings: [],
})
// A: one valid shape ALONGSIDE the two invalid ones, so `puts` is a
// discriminating nonzero — an implementation that reports `refused` but
// forgets to subtract it from `puts` returns {puts:3} here.
const r8a = reconcile(doc5, withInvalid)
assert.deepEqual(r8a, { puts: 1, deletes: 0, refused: 2 }, 'both refused writes are reported as refused, NOT counted as puts')
// The counts are not accounting fiction: the valid shape really landed and
// neither refused one did. This is also what kills a "make it converge" fix
// that swaps in putShapeUnchecked — that writes all three ids and refuses
// nothing.
assert.deepEqual(sortedIds(dumpModel(doc5).shapes), ['shape:ok'], 'the valid shape landed; neither refused one did')
// B: `refused` must be a PER-TICK delta, not doc.invalidWriteCount itself.
// That counter is a monotonic lifetime total (loro-canvas-doc.ts, "Never
// reset") and grows by two on every tick this target is reconciled —
// measured 2, 4 over two ticks. An implementation that returns it raw passes
// A and then reports refused:4 here.
const r8b = reconcile(doc5, withInvalid)
assert.deepEqual(r8b, { puts: 0, deletes: 0, refused: 2 }, 'stable across ticks: refused is a per-tick delta, not the doc lifetime total')
```

No new imports are needed: `LoroCanvasDoc`, `dumpModel`, `makeDocument`,
`reconcile`, `base` and `sortedIds` are all already in scope
(`reconcile.test.ts:14-21`).

Do **not** wrap this in a bare `{ … }` section block. Cases 1, 4 and 5 use them,
but a bare block after a statement ending in `)` walks straight into the `tsc`
parse trap documented in the working rules; the unique names above avoid the
question entirely.

**Which wrong implementations does this kill?**

| Mutant | Caught by |
|---|---|
| **M1** — computes `refused` correctly, forgets `puts -= refused` | A: returns `{puts:3}` |
| **M2** — returns `doc.invalidWriteCount` raw instead of a delta | B: returns `refused:4` on the second tick. **A alone does not catch this** — this is the 4A lesson repeating, an assertion that is already true of the wrong implementation |
| **M3** — "fixes" non-convergence by calling `putShapeUnchecked` | A (`refused:0`) *and* the `dumpModel` assertion (both ids present) |
| **M8** — `const refused = doc.invalidWriteCount > refusedBefore ? 1 : 0` (a boolean coerced to a number, not a count) | A: returns `{puts:2, refused:1}` — **survived spec review with the original single-invalid-shape fixture**, because with only one invalid shape in play every "did a refusal happen" boolean equals the true count. Closed 2026-07-20 (post-landing gap, `69d82cd`/`eaed6a1`) by adding `shape:bad2`, a SECOND invalid shape failing for a different reason (an envelope violation — empty `index` — rather than `shape:bad`'s props-refinement failure). **Verified independently at the `shadow.ts` boundary too**: rebuilding M8 and running `shadow.test.ts` case 6 unchanged (still a single-invalid-shape fixture) leaves it green — `ShadowMirror.tick()` only ever does `this.m.refused += refused` on whatever `reconcile()` returns (`shadow.ts:119`), so it has no arithmetic of its own that could independently reintroduce M8, and killing M8 at the `reconcile` boundary is therefore sufficient. `shadow.test.ts` case 6 was deliberately left unchanged. |

**Step 2: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/reconcile.test.ts
```

Expected: FAIL on assertion A. **This was executed at `6d55bc7`** against the
*original* single-invalid-shape fixture; that verbatim tail is superseded below.

> **CORRECTED 2026-07-20 (post-landing gap, mutant M8).** The RED below was
> re-recorded after the case 8 fixture was strengthened to two invalid shapes
> (see the M8 row above) — the numbers changed (`puts:3` not `puts:2`, no
> `refused` key at all vs. the old run's `puts:2`) because this is genuinely a
> different fixture. It was reconstructed faithfully: pre-Task-4B
> `reconcile.ts` (commit `69d82cd^`, before `refused` existed at all) run
> against the strengthened case 8, with cases 1–7 in their pre-Step-3b
> two-key form (exactly as the file looked at `6d55bc7`, before Step 3b
> widened them) — so this is a correct RED for the state Step 2 actually
> runs against, not a paraphrase.

```
AssertionError: both refused writes are reported as refused, NOT counted as puts
+ actual - expected

  {
    deletes: 0,
+   puts: 3
-   puts: 1,
-   refused: 2
  }

 generatedMessage: false,
     actual: {
  puts: 3,
  deletes: 0,
},
   expected: {
  puts: 1,
  deletes: 0,
  refused: 2,
},
   operator: "deepStrictEqual",
       code: "ERR_ASSERTION"
```

Two things the real run also prints, both expected:

- **The doc's fallback `console.warn` fires first** —
  `[canvas-doc] rejected invalid putShape (frame) shape:bad [#1]: …` followed by
  the Zod detail (`invalid props for kind frame: … expected number, received
  string`). The write *is* already being refused and counted; only `reconcile`'s
  report is blind to it. `reconcile`'s doc is a `ShadowMirror` doc constructed
  without an `onInvalidWrite` sink (`shadow.ts:97`), so the console fallback is
  the live behaviour here, exactly as Task 4A's assertion C pins.
- Cases 1–7 all still pass at this point — `refused` does not exist yet, so
  their `deepEqual`s are unaffected. Step 3 changes that; see Step 3b.

**Record your own verbatim output anyway** — a run that differs in text but
still lands on assertion A is a correct RED; only a *passing* test is grounds to
stop.

**Step 3a: Implement**

Take an `invalidWriteCount` delta across the put loop and widen the return type
(`reconcile.ts:49`):

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
	//
	// invalidWriteCount is a monotonic LIFETIME total, so `refused` must be a
	// delta: the shadow mirror reconciles the same doc every tick, and the raw
	// counter would grow without bound while the per-tick truth stayed 1.
	// Bracketing the loop rather than the whole function is deliberate — no
	// write outside it can reject today, and this stays correct if one ever can.
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

and return `{ puts, deletes, refused }` at `reconcile.ts:95`.

Then extend the exported function's JSDoc (`reconcile.ts:33-48`, the block whose
second sentence explains what `puts`/`deletes` count) to document `refused` and
the non-convergence it makes visible. Leave the module-level comment above it
alone.

> **Do NOT "fix" this by calling `putShapeUnchecked` in `reconcile`.** That
> would restore the exact data-loss path this branch exists to close — the shape
> would be written and then cascade-deleted by `repair()` on every peer. The
> non-convergence is the *correct* observable consequence of refusing to write
> invalid data; the fix is to make it legible, which is what this task does.
> Case 8's `dumpModel` assertion fails on that mutant (M3), and Task 8A's CI
> gate — **not yet written; `scripts/` holds only `run-tests.ts`,
> `exposure-audit.test.ts` and `ux-contract-presence.test.ts` at `6d55bc7`** —
> will reject the call outright once it lands.

**Step 3b: Widen the eight existing `deepEqual`s — this is not optional**

> **CORRECTED — the ratified text missed this entirely**, and claimed Step 4
> would simply pass. It will not. `reconcile.test.ts` imports
> `node:assert/strict`, where `assert.deepEqual` **is** `deepStrictEqual`: an
> extra own enumerable key fails the comparison. Every existing assertion that
> deep-compares a `reconcile` return against a two-key literal breaks the
> moment `refused` is added — the return type "only gained a field" is true of
> `tsc` and false of the suite.

Find them:

```
cd /home/stag/src/projects/ensembleworks && grep -n "deepEqual(r[0-9a-z]*, { puts\|deepEqual(reconcile(" server/src/canvas-v2/reconcile.test.ts
```

At `6d55bc7` that returns **eight** sites (cases 1, 2, 3, 4, 5, 6 ×2, 7). Add
`refused: 0` to each expected literal — do **not** weaken them to compare only
`puts`/`deletes`. Every one of those cases uses a well-formed fixture, so
`refused: 0` is a real assertion: it pins that valid data never trips the
counter, which is the other half of the contract case 8 pins.

`server/src/canvas-v2/shadow.ts:104` destructures `const { puts, deletes } =
reconcile(...)` and needs **no** change — it names the fields it wants and
ignores the new one. That is the only non-test caller in the repo (verified:
`grep -rn "reconcile(" --include="*.ts" --include="*.tsx"`, excluding
`node_modules`, returns `shadow.ts`, `reconcile.ts` itself, `reconcile.test.ts`,
and one prose mention in `loro-canvas-doc.ts:251`).

**Step 4: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/reconcile.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/shadow.test.ts
cd /home/stag/src/projects/ensembleworks && export PATH="$HOME/.bun/bin:$PATH" && bun run --filter '@ensembleworks/server' typecheck
```

Expected: `ok: reconcile`, `ok: shadow`, and a clean typecheck.

(The `export PATH=…` is required on the typecheck line and is **not** optional
noise: `server/package.json`'s `typecheck` script is `bunx tsc --noEmit`, and
`bunx` is not on `PATH` here — without it the run dies with
`bunx: command not found` / `Exited with code 127`, which reads like a
typecheck failure. Verified both ways at `6d55bc7`.)

**Step 4b: Commit the first half**

```
cd /home/stag/src/projects/ensembleworks
git add server/src/canvas-v2/reconcile.ts server/src/canvas-v2/reconcile.test.ts
git commit -m "feat(server): report refused writes from reconcile so divergence stays legible"
```

---

### Second half — expose the count where someone will see it

`reconcile` now reports `refused`, and `shadow.ts:104` still destructures only
`{ puts, deletes }`, so the number is discarded one line after it is computed.
These steps carry it to `GET /api/canvas/metrics`. **One field, one accumulate**
— nothing else.

**Is `ShadowMetrics.refused` per-tick or cumulative? CUMULATIVE, matching its
neighbours.** `tick()` does `this.m.puts += puts` / `this.m.deletes += deletes`
(`shadow.ts:105-106`), and `puts`'s own JSDoc opens "Cumulative shape puts
across all ticks" (`shadow.ts:53`). `refused` must accumulate the same way, and
the mismatch is worth naming explicitly because it is a live trap: `reconcile`
returns a **per-tick delta**, and `ShadowMirror` accumulates it into a
**lifetime total**. Same word, two scopes, one line apart. A counter that reset
while `puts`/`deletes` climbed would make the endpoint unreadable — "refused: 1"
next to "puts: 40000" would look like one historical blip rather than one
refusal per tick forever. Step 5's second assertion is what pins this, and it is
the only assertion that does.

**Step 5: Write the failing test**

Insert as case 6 in `server/src/canvas-v2/shadow.test.ts`, **before** the final
`console.log('ok: shadow')` (`:167`) — same reason as case 8 in Step 1. Executed
at `6d55bc7` to record the RED below; land it byte-identical or re-record.

```ts
// --- 6) REFUSED WRITES ARE COUNTED AND EXPOSED. convert.ts passes tldraw
// props through verbatim, so a legacy room can hand the mirror a shape the
// write boundary refuses (here: a frame whose `w` is the string '400'). The
// put is a no-op, so the shape never lands and every later tick retries it —
// reconcile cannot converge. Before `refused` existed those retries were
// counted as `puts`, so /api/canvas/metrics showed a forever-climbing puts
// rate with no way to tell real churn from one known-bad shape. checkEvery is
// 100 so no divergence check fires inside this case — this fixture WOULD trip
// one, legitimately, and that is case 3's subject, not this one. ---
const badFrame = { ...frame(), id: 'shape:bad', props: { name: 'Legacy', w: '400', h: 300, color: 'black' } }
const legacyRecords: any[] = [page, frame(), note(), badFrame]
const mirror4 = new ShadowMirror('room4', 4n, () => legacyRecords, 100)

mirror4.tick()
{
	const m = mirror4.metrics()
	// puts and refused are DIFFERENT numbers here (2 vs 1) deliberately: an
	// implementation that accumulates reconcile's `refused` into `puts`, or
	// vice versa, survives any assertion where the two happen to be equal.
	assert.equal(m.refused, 1, 'the refused write is counted')
	assert.equal(m.puts, 2, 'the two valid shapes are puts; the refused one is not')
	assert.equal(m.shapeCount, 2, 'the refused shape never landed in the mirror')
}

mirror4.tick()
{
	const m = mirror4.metrics()
	// refused is CUMULATIVE, like puts and deletes: it climbs by one per tick
	// for as long as the room carries the bad shape. Two mutants die here that
	// the first tick cannot catch — assigning per-tick (`this.m.refused =
	// refused`) leaves it at 1, and accumulating doc.invalidWriteCount raw
	// rather than reconcile's per-tick delta reaches 3.
	assert.equal(m.refused, 2, 'refused accumulates across ticks, like puts/deletes')
	// The point of the whole task: the retry is no longer disguised as a put,
	// so a steady-state puts rate of ~0 is a readable signal again.
	assert.equal(m.puts, 2, 'the retried refusal did NOT inflate puts')
}
```

No new imports: `ShadowMirror`, `page`, `frame`, `note` are all in scope
(`shadow.test.ts:8-39`).

**Which wrong implementations does this kill?**

| Mutant | Caught by |
|---|---|
| **M4** — adds `refused` to the interface and the initializer, never accumulates in `tick()` | tick 1: `refused` is `0`. This is why the fixture must carry an actual invalid shape — `refused: 0` on a well-formed fixture is not a discriminator |
| **M5** — accumulates into the wrong metric (`this.m.puts += refused` / `this.m.refused += puts`) | tick 1, `2 !== 1` — **verified by running case 6 in isolation under exactly this mutant**. (In the full file an earlier case trips first, so do not rely on the failure line to identify it) |
| **M6** — `this.m.refused = refused` instead of `+=` | tick 2, `1 !== 2` — **verified by running this mutant**. Tick 1 alone passes it |
| **M7** — accumulates `doc.invalidWriteCount` raw instead of reconcile's delta | tick 2: reaches 3, not 2 |

**Step 6: Run it to verify it fails**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/shadow.test.ts
```

Expected: FAIL on the first new assertion. Executed at `6d55bc7` (with Steps
1–3b applied); verbatim:

```
AssertionError: the refused write is counted

undefined !== 1

 generatedMessage: false,
     actual: undefined,
   expected: 1,
   operator: "strictEqual",
       code: "ERR_ASSERTION"
```

`undefined`, not a wrong number: `ShadowMetrics` has no `refused` yet, and
`metrics()` returns `{ ...this.m }`, so the read is a plain missing property at
runtime. This is a runtime assertion failure, not a missing export — correct RED
per the working rules. The `error: boom: simulated getCurrentSnapshot failure`
line above it is case 4's deliberate fault injection and is present on healthy
runs too; ignore it.

**Step 7: Implement**

Three edits in `server/src/canvas-v2/shadow.ts`, and nothing else:

1. `ShadowMetrics` (`:51`) — add after `deletes` (`:62`):

```ts
	/**
	 * Cumulative writes reconcile REFUSED, across all ticks — see reconcile()'s
	 * `refused`. Unlike puts/deletes this does not settle at steady state: a
	 * refused shape is never written, so every tick retries it and this climbs
	 * by one per tick for as long as the room carries it. A steadily-climbing
	 * `refused` therefore means "N shapes in this room fail the model schema",
	 * not "N new problems occurred" — read the RATE against `ticks`, not the
	 * total. It is the counterpart that lets `puts` go back to meaning churn:
	 * before this field those retries were counted as puts.
	 */
	refused: number
```

2. the `m` initializer (`:80`) — `refused: 0,` alongside `puts: 0, deletes: 0,`.

3. `tick()` (`:104-106`) — widen the destructure and accumulate:

```ts
			const { puts, deletes, refused } = reconcile(this.doc, target)
			this.m.puts += puts
			this.m.deletes += deletes
			this.m.refused += refused
```

`+=`, not `=` — see the per-tick-vs-cumulative note above; that is mutant M6.

Do **not** touch `checkDivergence`, `metrics()`, or
`server/src/features/canvas-metrics.ts`.

**Step 8: Run the tests**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/shadow.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/canvas-v2/reconcile.test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun server/src/features/canvas-metrics.test.ts
cd /home/stag/src/projects/ensembleworks && export PATH="$HOME/.bun/bin:$PATH" && bun run --filter '@ensembleworks/server' typecheck
```

Expected: all pass. **No existing fixture needs updating for this half** — this
is the opposite of Step 3b, and it was checked the same way rather than assumed:
`grep -rn "\.metrics()" --include="*.test.ts" server/src` returns sites in
`shadow.test.ts` only, **every one** of which reads individual fields
(`assert.equal(m.puts, …)`) rather than deep-comparing the metrics object; and
`canvas-metrics.test.ts` never calls `metrics()` at all — it goes through the
HTTP payload, whose two
`deepEqual`s over the payload (`:68`, `:191`) both assert `shadow: {}` — the
empty-map case, where no `ShadowMetrics` is serialized at all. If a future
reader adds a whole-object `deepEqual`, that changes.

**Step 9: Commit the second half**

```
cd /home/stag/src/projects/ensembleworks
git add server/src/canvas-v2/shadow.ts server/src/canvas-v2/shadow.test.ts
git commit -m "feat(server): expose reconcile's refused count in ShadowMetrics"
```

---

**Half (A) is complete here — but the work is not.** Continue to Task 5; half
(B) is in scope by owner ruling 4, and it carries most of the risk reduction
(half (A) does nothing about invalid props arriving through `doc.import`). Only
skip to Task 9 if half (B) has proved worse than expected AND you have stopped
and reported first.

---

## Task 5: Make `dropShape` proportionate in the pure model

> **CHANGE NOTE (2026-07-20) — this section was rewritten against HEAD `e1e2a0b`.**
> The previous text was drafted before Tasks 1–4B landed. What was stale, and
> what changed:
>
> | # | Stale claim in the old text | Reality at `e1e2a0b` | Correction |
> |---|---|---|---|
> | 1 | Step 3(d): "Delete `cascadeDropSet` entirely (lines 84-100 as of `0388900`)" | `canvas-doc/src/loro-canvas-doc.ts` still **imports and calls** it (`repair()`'s `dropAll`). Deleting the export here makes canvas-doc fail at ESM **link time** — a missing-export module error, not an assertion. | **Task 5 stops using it; Task 6 deletes it.** See "Ruling on `cascadeDropSet`" below — this obeys ruling 2, just one task later, and is *required* by this plan's own RED rule ("every RED lands on a runtime assertion, never on a missing export"). |
> | 2 | Step 5: "Expected: only hits in `canvas-doc/src/loro-canvas-doc.ts` (its import on line 5 and its use around line 357 plus two comment mentions)" | The call is at line 519 and the surrounding comment block has grown; the raw line numbers rotted. | The grep survives; the **expected line numbers are gone**. The step now asserts the *shape* of the result (which files, not which lines). |
> | 3 | Step 3(a): quotes `RepairOp`'s `dropShape` line as "line 8" | Still line 8 today, but the surrounding `rank`/`opFor` comments were edited by the dedupe work. | Anchored by exact text, not by line number. |
> | 4 | Step 6: "`canvas-doc` will be red until Task 6" — unqualified, and no claim about anything else | **Measured**, not reasoned: after this change `canvas-doc/src/repair.test.ts` fails at **exactly one** assertion (`'Loro and model application agree (order-independent)'`, the `doc3` block), the rest of the canvas-doc suite passes, and `canvas-sync/src/convergence.test.ts` stays **green**. The old text left the blast radius unstated, which is how an implementer talks themself into "the rig was already flaky". | Step 7 now names the exact expected failure and the exact things that must **stay** green, with a STOP condition if either is wrong. |
> | 5 | The RED test's only discriminating case was one frame + two descendants | That test cannot distinguish a correct fix from five plausible wrong ones (wrong page target, flatten-the-subtree, over/under-swept bindings, no zero-page suppression). | Step 1's test is rebuilt around an explicit **mutant list (M1–M9)**; every mutant was actually run against the specified test and its killing assertion recorded below. |
> | 6 | Said nothing about what Task 6 must match | The two applications are drift-prone by construction. | New "Handoff to Task 6" subsection, including **two defects found in Task 6's current text** while writing this. |
>
> Everything asserted in this section about the code was read at `e1e2a0b`;
> everything asserted about test outcomes was **executed**, not predicted.

> **This task deliberately rewrites tests that currently pin the cascade as
> correct** — the "Cascade fixpoint (3 levels)" block in
> `canvas-model/src/repair.test.ts`. That is an **intended behaviour change with
> owner sign-off** (ruling 4, 2026-07-20) — not a regression, and not a failing
> test being papered over. The old assertions encoded the defect this branch
> exists to fix. Reviewers: the correct check is that the *new* assertions
> describe proportionate repair, **not** that the old assertions survived.

### What is true at `e1e2a0b` (read, not assumed)

`canvas-model/src/repair.ts` has three moving parts this task touches:

- `repairPlan(doc)` — turns `checkInvariants` violations into ops. It already
  suppresses `reparentToRoot` in a zero-page doc via a `canReparent` guard
  (`if (o.op === 'reparentToRoot' && !canReparent) continue`), because there is
  no target page to reparent to.
- `cascadeDropSet(shapes, seed)` — a fixpoint over `parentId` edges returning
  the seed plus every transitive descendant.
- `applyRepairToModel(doc, plan)` — the pure reference application. It computes
  `dropAll = cascadeDropSet(doc.shapes, drop)` and then uses `dropAll` in **two**
  places: the shape filter, and the binding filter
  (`!dropAll.has(b.fromId) && !dropAll.has(b.toId)`).

`dropAll` is exactly the defect. One shape fails `validateShape`; every
descendant dies with it, on every peer, durably, behind Loro tombstones.

### What proportionate means, precisely

Three rules, and nothing else changes:

1. **Shapes.** Remove *only* the ids the plan names. A shape whose `parentId` is
   a dropped id is **rescued**: its `parentId` is rewritten to
   `canonicalPageId(doc.pages)` — the *same* target `reparentToRoot` already
   uses, which is why repair stays a pure function of converged state. A shape
   that is *itself* dropped is dropped even if its parent was also dropped
   (removal outranks rescue).
2. **Bindings.** A binding is deleted iff the plan names it (`deleteBinding`)
   **or one of its endpoints is a dropped id**. It is **not** deleted merely
   because an endpoint was rescued. This is the edge a wrong implementation gets
   backwards in either direction, so it has a mutant on each side (M6, M7).
   - *Why deleting on a dropped endpoint is still required:* such a binding is
     **not** dangling when the plan is computed, so the plan carries no
     `deleteBinding` op for it. Sweeping it here is what makes a **single**
     repair pass converge instead of needing a second one.
3. **Zero-page docs.** `repairPlan` suppresses `dropShape` too, exactly as it
   already suppresses `reparentToRoot`. With no page there is no rescue target,
   so the only way to apply the drop would be to delete the children as well —
   the very thing this task removes. The violation is left standing instead
   (ruling 3; decision D4).

Not in scope, by owner ruling 1: rescued children keep their parent-relative
`x`/`y` and may visually jump. **Do not add a coordinate-rebasing step and do
not propose one.** A misplaced shape beats an unrecoverably deleted one.

### Ruling on `cascadeDropSet`'s fate: it dies — but in Task 6, not here

Verified consumer list (command in step 6):

- `canvas-model/src/repair.ts` — the `dropAll` line this task removes.
- `canvas-doc/src/loro-canvas-doc.ts` — imported on line 5, called in
  `repair()`, plus comment mentions.

That is all of them. Ruling 2 approved deleting it from the package's exports,
and it should be deleted — but **the last consumer is removed by Task 6, so
Task 6 deletes the function.** Task 5 leaves it exported and simply stops
calling it.

The reason is this plan's own RED rule. If Task 5 deleted the export, canvas-doc
would fail at ESM link time with a missing-export error before a single
assertion ran — and Task 6's "Step 1: observe the failure" would be observing a
broken import, not a behavioural disagreement. Keeping the function for one more
task means **Task 5's landing produces Task 6's RED**, and that RED is a real
runtime assertion about repair semantics (measured: see step 7). An unused
exported function typechecks cleanly — verified, `bun run typecheck` is green
across all 13 workspaces with the change applied and `cascadeDropSet` retained.

### Mutants this task's test must kill

Each row below was **produced and executed** against the step-1 test at
`e1e2a0b`; the "killed by" column is the assertion that actually fired, verbatim
from the run. (`node:assert` aborts the script at the first failure, so a mutant
that also violates an earlier block dies there; where that happens the
proportionality-block assertion that would independently catch it is named in
parentheses.)

| # | Plausible wrong implementation | Killed by |
|---|---|---|
| M1 | Rescue the *shape itself* — reparent the invalid shape to the page instead of removing it | `checkInvariants(repaired)` in the opening block (the shape is still invalid). (Also: `'only the invalid shape is removed'`.) |
| M2 | Rescue only **direct** children; keep cascading deeper descendants | `'only bad2 is dropped; child and grandchild are rescued'` (chain block). (Also: `'only the invalid shape is removed'`.) |
| M3 | Rescue to `doc.pages[0].id` instead of `canonicalPageId` — an unstable, input-order-dependent target | `'the direct child is rescued to the canonical page (smallest id, not pages[0])'` |
| M4 | Drop the cascade helper and **orphan** the children (no reparent at all) | `'child rescued to the canonical page'` (chain block). (Also: `'invariant-clean after ONE pass'`.) |
| M5 | Flatten the **whole** subtree to the page, not just direct children | `'a grandchild keeps its surviving parent — only DIRECT children are rehomed'` |
| M6 | Keep the binding sweep on the **cascade** set (delete bindings to rescued children too) | `'a binding whose endpoints both survive is kept'` (chain block). (Also: `'bindings to rescued children survive…'`.) |
| M7 | Drop the binding sweep entirely (bindings to the dropped shape survive → dangling) | `'bindings to rescued children survive; the binding to the dropped shape is swept'` |
| M8 | Keep the cascade removal but forget the zero-page suppression in `repairPlan` | `'a zero-page doc emits no dropShape — there is no rescue target'` |
| M9 | Let rescue win over removal, so a child that is *itself* invalid gets resurrected | `'both invalid shapes go; only the valid grandchild survives'` |

Assertions in the step-1 test that kill nothing were **removed** while writing
this. In particular an idempotence assertion (`repairPlan(rescued) === []`) was
cut: `repairPlan` is a pure function of `checkInvariants`' output, so for a
non-zero-page doc it is strictly implied by the `checkInvariants(rescued) === []`
assertion already present, and no mutant could fail one without failing the
other.

**Files:**
- Modify: `canvas-model/src/repair.ts` (the `RepairOp.dropShape` comment,
  `repairPlan`'s `canReparent` guard, `applyRepairToModel`'s drop half)
- Modify: `canvas-model/src/repair.test.ts` (the cascade assertions this
  deliberately changes, plus a new proportionality block)

Do **not** touch `cascadeDropSet` in this task (see the ruling above).

**Step 1: Write the failing test**

Two edits to `canvas-model/src/repair.test.ts`.

**(1a)** In the existing "Cascade fixpoint (3 levels)" block, replace these two
assertions:

```ts
assert.deepEqual(chainRepaired.shapes.map((s) => s.id), ['shape:ar2'], 'bad2, child AND grandchild all dropped')
assert.deepEqual(chainRepaired.bindings, [], 'binding touching the cascaded grandchild dropped too')
```

with:

```ts
// CHANGED 2026-07-20 (proportionality, owner ruling 4): dropping bad2 no
// longer cascades. `child` is rescued to the canonical page, `grandchild`
// keeps `child` as its parent, and binding:g — whose endpoints (ar2,
// grandchild) BOTH still exist — survives with them.
assert.deepEqual(
  chainRepaired.shapes.map((s) => s.id).sort(),
  ['shape:ar2', 'shape:child', 'shape:grandchild'],
  'only bad2 is dropped; child and grandchild are rescued',
)
assert.equal(chainRepaired.byId.get('shape:child')!.parentId, 'page:p', 'child rescued to the canonical page')
assert.deepEqual(chainRepaired.bindings.map((b) => b.id), ['binding:g'], 'a binding whose endpoints both survive is kept')
```

Also retitle that block's leading comment from `// Cascade fixpoint (3 levels):
dropping the invalid root removes the WHOLE descendant chain, …` to describe
what it now pins — a chain **under** a dropped shape — and delete its sentence
about `cascadeDropSet` needing to be a true fixpoint, which no longer describes
this code path. Keep the "descendants listed BEFORE ancestors" seeding: it is
still a useful order-independence property for the rescue map.

**(1b)** Insert the proportionality block immediately **after** that chain block
(i.e. after its `'invariant-clean after ONE pass'` assertion) and **before** the
"Dedup collision" block:

```ts
// ---- PROPORTIONALITY (2026-07-20, owner ruling 4) ----
// The reported defect, in the pure model: a frame with ONE bad numeric prop
// must not execute its innocent contents. `props: { w: 'wide' }` fails the
// frame's per-kind props schema (w is z.number().optional()), so validProps
// fires on the frame and on nothing else.
//
// Pages are listed z-FIRST on purpose: the rescue target must be
// canonicalPageId (lexicographically smallest, page:a) on every peer, never
// pages[0]. Three bindings pin the binding rule from both sides: the one
// pointing AT the dropped shape must be swept (it is not dangling before the
// repair, so the plan carries no deleteBinding op for it — only a same-pass
// sweep converges in ONE call), while the two pointing at RESCUED shapes must
// survive.
const rescueDoc = makeDocument({
  pages: [{ id: 'page:z', name: 'Z' }, { id: 'page:a', name: 'A' }],
  shapes: [
    { id: 'shape:arw', kind: 'arrow', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:badf', kind: 'frame', parentId: 'page:z', props: { w: 'wide' }, ...base() } as any,
    { id: 'shape:kid', kind: 'note', parentId: 'shape:badf', props: {}, ...base() } as any,
    { id: 'shape:gkid', kind: 'note', parentId: 'shape:kid', props: {}, ...base() } as any,
  ],
  bindings: [
    { id: 'binding:toBad', fromId: 'shape:arw', toId: 'shape:badf', props: {}, meta: {} },
    { id: 'binding:toKid', fromId: 'shape:arw', toId: 'shape:kid', props: {}, meta: {} },
    { id: 'binding:toGkid', fromId: 'shape:arw', toId: 'shape:gkid', props: {}, meta: {} },
  ],
})
const rescuePlan = repairPlan(rescueDoc)
assert.deepEqual(rescuePlan, [{ op: 'dropShape', id: 'shape:badf' }], 'precondition: the frame is the only flagged shape')
const rescued = applyRepairToModel(rescueDoc, rescuePlan)
assert.deepEqual(
  rescued.shapes.map((s) => s.id).sort(),
  ['shape:arw', 'shape:gkid', 'shape:kid'],
  'only the invalid shape is removed',
)
assert.equal(
  rescued.byId.get('shape:kid')!.parentId,
  'page:a',
  'the direct child is rescued to the canonical page (smallest id, not pages[0])',
)
assert.equal(
  rescued.byId.get('shape:gkid')!.parentId,
  'shape:kid',
  'a grandchild keeps its surviving parent — only DIRECT children are rehomed',
)
assert.deepEqual(
  rescued.bindings.map((b) => b.id).sort(),
  ['binding:toGkid', 'binding:toKid'],
  'bindings to rescued children survive; the binding to the dropped shape is swept',
)
assert.deepEqual(checkInvariants(rescued), [], 'invariant-clean after ONE pass')

// Removal outranks rescue: a child that is ITSELF invalid is dropped, not
// resurrected by the rescue map. Its own valid child is then rescued to the
// page — proving the rescue target is resolved against the plan, not against
// whatever the parent chain happened to become.
const bothBad = makeDocument({
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:badp', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:badc', kind: 'note', parentId: 'shape:badp', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:okg', kind: 'note', parentId: 'shape:badc', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const bothBadPlan = repairPlan(bothBad)
assert.deepEqual(
  bothBadPlan,
  [{ op: 'dropShape', id: 'shape:badc' }, { op: 'dropShape', id: 'shape:badp' }],
  'precondition: both invalid shapes are named, id-ascending',
)
const bothBadRepaired = applyRepairToModel(bothBad, bothBadPlan)
assert.deepEqual(bothBadRepaired.shapes.map((s) => s.id), ['shape:okg'], 'both invalid shapes go; only the valid grandchild survives')
assert.equal(bothBadRepaired.byId.get('shape:okg')!.parentId, 'page:p', 'the survivor is rescued to the canonical page')
assert.deepEqual(checkInvariants(bothBadRepaired), [], 'invariant-clean after ONE pass')

// Zero-page doc: no rescue target exists, so dropShape is SUPPRESSED and the
// violation is left standing — the same policy repairPlan already applies to
// reparentToRoot (ruling 3, decision D4). Emitting a drop we could only apply
// by deleting the children would be disproportionate deletion by another route.
const noPageBad = makeDocument({
  pages: [],
  shapes: [{ id: 'shape:badnp', kind: 'note', parentId: 'shape:badnp', props: {}, ...base(), opacity: 'no' as any } as any],
  bindings: [],
})
assert.deepEqual(repairPlan(noPageBad), [], 'a zero-page doc emits no dropShape — there is no rescue target')
assert.ok(checkInvariants(noPageBad).some((v) => v.rule === 'validProps'), 'the validProps violation stands — honestly unrepairable')
```

> **Style note.** These are top-level `const`s with unique names, matching the
> rest of this file — do **not** wrap them in bare `{ … }` section blocks here.
> If you do, re-read the "`tsc` parse trap" rule in the working rules: the
> file's `const base = () => ({ … })` already ends in a parenthesized object
> literal, and bun would accept what `tsc` rejects.

**Step 2: Run it and record the verbatim failure**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected (this is the actual output, captured at `e1e2a0b`):

```
AssertionError: only bad2 is dropped; child and grandchild are rescued
+ actual - expected

  [
    'shape:ar2',
-   'shape:child',
-   'shape:grandchild'
  ]

 generatedMessage: false,
     actual: [ "shape:ar2" ],
   expected: [ "shape:ar2", "shape:child", "shape:grandchild" ],
   operator: "deepStrictEqual",
       code: "ERR_ASSERTION"
```

The chain block sits earlier in the file than the new proportionality block, so
it aborts first — that is correct and expected. **If the file passes, STOP and
report.** Do not weaken the test and do not skip to the implementation.

**Step 3: Implement — `RepairOp`'s `dropShape` comment**

In `canvas-model/src/repair.ts`, replace:

```ts
  | { op: 'dropShape'; id: string } // invalid envelope/props (quarantine)
```

with:

```ts
  // Invalid envelope/props. Removes ONLY this shape; any shape whose parentId
  // is a dropped id is rehomed to the canonical page root (see
  // applyRepairToModel). Deliberately NOT a subtree cascade: a container with
  // one bad prop must not execute its innocent contents, and Loro tombstones
  // make that loss unrecoverable. Rescued children keep their parent-relative
  // x/y and may visually jump — accepted, owner ruling 1.
  | { op: 'dropShape'; id: string }
```

**Step 4: Implement — `repairPlan`'s zero-page guard**

Replace:

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

Also amend the `canReparent` comment three lines above so it stops reading as
orphans-only — it now gates drops as well.

**Step 5: Implement — `applyRepairToModel`'s drop half**

Three edits inside `applyRepairToModel`.

(a) Delete the `dropAll` line and replace its comment block. Replace:

```ts
  // Drop invalid shapes AND their descendants (cascade). The filter below runs
  // before the toRoot map, so a shape both cascade-dropped and reparent-flagged
  // is DROPPED — same precedence as repair()'s skip of reparent ops in dropAll.
  const dropAll = cascadeDropSet(doc.shapes, drop)
```

with:

```ts
  // Drop ONLY the shapes the plan names. Their children are rescued by the same
  // map that serves reparentToRoot, below. The filter runs BEFORE that map, so a
  // shape that is both dropped and rescue-eligible is DROPPED: removal outranks
  // rescue, and LoroCanvasDoc.repair() must make the same choice.
```

(b) In the `shapes` pipeline, change the drop filter and the rehome map:

```ts
    .filter((s) => !drop.has(s.id))
```

and

```ts
    // A shape is rehomed to the canonical page either because it was flagged
    // (orphan/cycle) or because its parent was just dropped. Same target, same
    // determinism — the rescue must not invent a second rehoming rule.
    .map((s) => (toRoot.has(s.id) || drop.has(s.parentId) ? { ...s, parentId: pageId } : s))
```

(c) The bindings filter loses its cascade:

```ts
  // A binding dies iff the plan names it, or an ENDPOINT was dropped (that
  // binding is not dangling when the plan is computed, so no deleteBinding op
  // exists for it — sweeping it here is what makes ONE pass converge). A
  // binding to a merely RESCUED shape survives: the shape still exists.
  const bindings = doc.bindings.filter((b) => !delBind.has(b.id) && !drop.has(b.fromId) && !drop.has(b.toId))
```

`cascadeDropSet` is now unreferenced within this module. **Leave it exported and
in place** — Task 6 deletes it with its last consumer.

**Step 6: Run the test, then confirm the consumer list**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected: `ok: repair (model)`.

Then:

```
cd /home/stag/src/projects/ensembleworks && grep -rn "cascadeDropSet" --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Expected shape of the result — assert the **files**, not the line numbers:

- `canvas-model/src/repair.ts` — the definition and its comment only; **no call
  site left in this file**.
- `canvas-doc/src/loro-canvas-doc.ts` — its import, its one call in `repair()`,
  and comment mentions. Task 6 removes all of these and then the definition.
- `canvas-model/src/repair.test.ts` — a comment mention only, if you did not
  already delete it in step 1a.

Any **other** consumer means this plan's premise is wrong: **STOP and report.**

**Step 7: Run the wider suites and check the blast radius**

```
cd /home/stag/src/projects/ensembleworks/canvas-model && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/convergence.test.ts
cd /home/stag/src/projects/ensembleworks && bun run typecheck
```

**`canvas-doc` needs the fail-fast workaround, NOT `bun test.ts`.** This task
leaves `canvas-doc/src/repair.test.ts` RED on purpose (it is Task 6's RED),
and `test.ts` exits at the first failure — `repair.test.ts` sorts partway
through, so running the package runner here leaves the files after it unrun
while looking like it "stopped at the expected failure". Run them all and
exclude the known-RED file by name:

```
cd /home/stag/src/projects/ensembleworks/canvas-doc
for f in src/*.test.ts; do
  [ "$f" = "src/repair.test.ts" ] && continue   # expected RED until Task 6
  ~/.bun/bin/bun "$f" || echo "UNEXPECTED FAIL: $f"
done
```

Expected: every file reports `ok:` and no `UNEXPECTED FAIL` line. Then confirm
the excluded file fails for the RIGHT reason — `~/.bun/bin/bun
src/repair.test.ts` must fail at `'Loro and model application agree
(order-independent)'` in the `doc3` block. A failure anywhere else in that
file is NOT the expected RED: **STOP and report.**

Measured at `e1e2a0b` with this change applied — these are observations, not
predictions:

- `canvas-model`: **all 14 suites pass.**
- `canvas-doc`: every suite passes **except** `src/repair.test.ts`, which fails
  at exactly one assertion:
  ```
  AssertionError: Loro and model application agree (order-independent)
  ```
  That is the `doc3` order-independence block, **not** the `doc4` cascade block
  (`doc4` asserts Loro behaviour directly and does not consult the model, so it
  stays green until Task 6 changes Loro). This failure is **intended**: it *is*
  Task 6's RED, and it is a behavioural assertion rather than a module-load
  error, which is the whole reason `cascadeDropSet` survives this task.
- `canvas-sync/src/convergence.test.ts`: **passes.** Reasoned and confirmed: the
  rig's `randomShape` (`canvas-sync/src/rig/ops.ts`) only ever emits valid
  shapes, and every write path it drives now validates, so no trial can produce
  a `validProps` violation — therefore no `dropShape` op, therefore nothing for
  this change to disagree about.
- `bun run typecheck`: **green in all workspaces** (an exported-but-unused
  function is not an error).

**If `canvas-doc` fails anywhere other than that one assertion, or if
`convergence.test.ts` fails at all, STOP and report** — do not adjust the rig
and do not start Task 6 on top of an unexplained failure.

**Step 8: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-model/src/repair.ts canvas-model/src/repair.test.ts
git commit -m "fix(canvas-model): dropShape rescues children instead of cascading"
```

Paste the verbatim step-2 RED output into the commit body.

### Handoff to Task 6 — what must match, so the two cannot drift

`applyRepairToModel` is the reference; `LoroCanvasDoc.repair()` must agree
byte-for-byte after normalization. Task 6 must therefore reproduce **all four**
of the rules this task established:

1. **Rescue before delete.** Loro's `deleteNode` cascades over the *real* tree
   and clears descendants' text containers, so every physical child must be
   moved out of the doomed subtree **first**. This is the one place the Loro
   side is harder than the model side.
2. **Same target.** Children are stamped with `canonicalPageId(model.pages)` —
   not `pages[0]`, not a traversal-order pick.
3. **Removal outranks rescue.** A child that is itself dropped is rescued out
   and then removed by its own turn in the plan loop; that ordering is what
   makes the result independent of the order `dropShape` ops are visited in.
4. **Bindings sweep on the drop set only**, never on a descendant closure.

And Task 6 additionally **inherits the deletion of `cascadeDropSet`**: after it
removes the import and call from `canvas-doc/src/loro-canvas-doc.ts`, it must
also delete the function and its comment from `canvas-model/src/repair.ts` (and
the stale mention in `canvas-model/src/repair.test.ts` if step 1a left one),
discharging ruling 2.

> **Two defects in Task 6's text, found while refreshing this section
> (2026-07-20). BOTH FIXED in Task 6's 2026-07-21 refresh — recorded here as
> history, not as a pending action:**
>
> - Task 6 step 4(a)'s replacement import line **omits `SHAPE_KINDS` and
>   `type ShapeKind`**, which `canvas-doc/src/loro-canvas-doc.ts` uses in its
>   `kind` coercion (added by Task 1B, after Task 6's text was written).
>   Dropping them breaks `bun run typecheck`. Remove only `cascadeDropSet` from
>   that import.
> - Task 6 step 1 predicts the RED "most likely at the model-agreement
>   assertion … and/or the order-independence block". Measured: it is
>   **specifically** the order-independence block's
>   `'Loro and model application agree (order-independent)'`. Task 6's other
>   line-number references (`repair.test.ts:89-92`, `:187`) were not re-verified
>   here and should be treated as rotted until checked.

---

## Task 5A: A rescued child stays on its own page, not the canonical page

> **WHY THIS TASK EXISTS (2026-07-20).** Task 5 landed proportionate repair
> (`764bdd3`, `cad6bfc`, `5c67923`): a shape failing `validProps` is dropped and
> its DIRECT children are rescued by reparenting rather than cascade-deleted.
> Task 5 rescued them to `canonicalPageId` — the lexicographically smallest page
> id — reusing `reparentToRoot`'s doc-wide target.
>
> **The owner has since ruled that a rescued child must stay on the SAME PAGE it
> was already on.** Moving it to a different page is not acceptable. This is a
> *tightening* of the rescue-target ruling after Task 5 landed, which is why it
> is a separate task rather than an edit to Task 5's section.
>
> **Ruling 1 is NOT re-opened.** A rescued child still keeps its parent-relative
> `x`/`y` and may visually jump *in position*. Position may shift; page
> membership may not. Do not add coordinate rebasing and do not propose it.

**Files:**
- Modify: `canvas-model/src/repair.ts` (new `pageAncestorId` helper;
  `applyRepairToModel`'s rehome branch; three stale comments)
- Modify: `canvas-model/src/repair.test.ts` (two existing fixtures re-seeded,
  one existing assertion rewritten, five new cases)

### The rule, precisely — seven questions, seven answers

Every answer below was worked out against the source at `5c67923` and then
**executed**; the commands are named in "How each claim here was checked".

**Q1 — What is "the same page"?** The page ancestor of the dropped parent:
walk `parentId` upward from the dropped shape until an id that names a page.

An id names a page iff it is **a member of `doc.pages`**, *not* iff it starts
with `page:`. The two are different, and the difference is reachable:
`canvas-model/src/invariants.ts`'s `noOrphans` rule tests
`ids.has(p) || pageIds.has(p)` — membership — precisely because a `parentId`
like `page:ghost` carries the prefix and names nothing. (`noCycles` does use
`cur.startsWith('shape:')`, but only to decide when to *stop walking*, which is
a different question; `canvas-model/src/document.ts`'s `rootShapes` uses
`startsWith('page:')` and is a display helper, not a repair target.) A
prefix-only test would stamp `page:ghost` onto a rescued child and emit a
**fresh** `noOrphans` violation out of a pass that is required to converge in
one call. Mutant **M6** pins this.

**Q2 — Chained drops.** The walk stops **only** at a page. It passes straight
through shapes, whether or not they are themselves being dropped, so a chain of
drops needs no special handling: `okg → badc(dropped) → badp(dropped) → page:b`
resolves to `page:b`. Stopping at the first shape, or at the first *surviving*
shape, are both wrong and both have mutants (**M3**, **M4**). Stopping at a
surviving ancestor is the more tempting error and deserves its reason stated:
it would put the rescued child **inside a frame it was never in**, inventing a
containment relationship. Repair has no mandate to do that. Rescue always
targets a page root — the same shape of outcome ruling 1 already accepted, just
on the right page.

**Q3 — Cycles.** `noCycles` is a real invariant with real repair ops, so a
parent chain can cycle and an unbounded walk would hang. The guard is a `seen`
set; when it trips the walk returns `undefined` and the caller falls back to
`canonicalPageId`.

There is a theorem worth recording, because it explains why this guard is
dead-code safety rather than a live path: **a plan produced by `repairPlan` can
never rescue a shape whose parent chain cycles.** If the chain from `s.parentId`
cycles then the chain from `s` cycles too, so `checkInvariants` gives `s` a
`noCycles` violation, so `repairPlan` emits `reparentToRoot(s)` (or the stronger
`dropShape(s)`) — either way `s` is not on the rescue path. The guard exists for
hand-built plans, exactly like the `'page:orphans'` fallback `applyRepairToModel`
already carries. **M5** is killed by *non-termination*: an unguarded walk makes
the test **hang** rather than fail an assertion. Say so in the task report, so
nobody reads a hang as an environment problem.

**Q4 — No page ancestor at all.** Reachable, and not via a cycle: a shape that
is *both* invalid and an orphan gets `dropShape` (drop outranks reparent in
`repairPlan`'s dedup), and its child has no violation of its own, so the child
**is** rescued while the walk dead-ends immediately.

**Decision: fall back to `canonicalPageId`.** Reasoning, in order of weight:

1. **Convergence forces it.** The child must land somewhere that resolves, or
   the repaired doc carries a fresh `noOrphans` violation and the "invariant-
   clean after ONE pass" property — asserted in `canvas-model/src/repair.test.ts`
   and relied on by `canvas-sync/src/convergence.test.ts` — breaks.
2. Suppressing the drop instead (the zero-page policy) would leave a
   `validProps` violation standing **permanently** for a shape whose ancestor
   happens to be orphaned, and would make suppression depend on per-shape
   structure rather than on a doc-wide fact. That is strictly worse than a
   position shift on one page.
3. The fallback is exactly the pre-5A behaviour, which the owner already
   accepted in general — the new ruling makes it *not preferable*, not
   *forbidden*, and there is no same-page answer to prefer here.

I judge this **not** a genuine judgement call, so it is specified rather than
escalated. It is a cheap thing to confirm, though: if the owner would rather see
such a child left in place with the drop suppressed, say so before Task 5A
lands — it is a two-line change to `repairPlan` plus one fixture.

**Q5 — Zero-page docs.** Unchanged. `repairPlan` still suppresses `dropShape`
(and `reparentToRoot`) when `doc.pages.length === 0`, and the same-page rule
makes that policy *more* obviously right, not less: with no pages there is
neither a page ancestor to find nor a fallback to fall back to. The existing
`noPageBad` assertion stays exactly as it is. Do not build anything further for
this case — it is not reachable in production (every production page writer —
`client/src/canvas-v2/bootstrap-page.ts`, `server/src/canvas-v2/crash-writer.ts`,
`server/src/canvas-v2/reconcile.ts` — guarantees a page, and reconcile commits
shapes and pages together).

**Q6 — Purity.** The target must stay a pure function of converged state.
Two rules keep it so, and both are pinned:

- The walk resolves each ancestor id through **`doc.byId`**, never through a
  scan of `doc.shapes`. Under duplicate ids `byId` holds the *content winner*
  (`canvas-model/src/document.ts`'s `makeDocument` — see its comment on why
  last-entry-wins would track Loro's traversal order and diverge across peers),
  whereas a `find()` would return whichever entry happens to come first in the
  array. **M8** pins this, and the same fixture re-runs with the input arrays
  reversed and asserts an identical result.
- The walk reads the **untransformed** `doc`, never the partially rehomed
  output — the same discipline the ORDER PIN case already enforces for dedupe.

**Q7 — `reparentToRoot` is NOT in scope.** Orphan and cycle repair keep
targeting `canonicalPageId`, and must. An orphan has no page to stay on — that
is the entire point of the op. Only the **rescue** path changes. **M7** pins it
with a hand-built plan, because (by the Q3 theorem, plus the fact that a
`noOrphans` shape's parent names nothing and therefore cannot be dropped) a
`repairPlan`-produced plan can never pair `reparentToRoot` with a resolvable
page ancestor — so only a hand-built plan can tell the two targets apart at all.

That last fact also settles the precedence question the new rule creates: when a
shape is in `toRoot` *and* its parent is dropped, `toRoot` wins. On real plans
the two choices always coincide (a `toRoot` shape has no page ancestor, so
same-page falls back to the canonical page anyway); the ordering is stated so
hand-built plans are defined and so the rule stays statable as **removal, then
flag, then rescue**.

### Mutants this task's test must kill

Every row was **produced and executed** against the step-1 test with the step-3/4
implementation in place; the "killed by" column is the assertion that actually
fired, verbatim from the run. `node:assert` aborts at the first failure, so each
mutant is named by the first assertion it trips.

| # | Plausible wrong implementation | Killed by |
|---|---|---|
| M1 | Rescue to `canonicalPageId` — **the behaviour Task 5 landed**, which must now FAIL | `'the rescued child stays on its own page (page:z) — not pages[0] (page:m), not the canonical page (page:a)'` |
| M2 | Rescue to `doc.pages[0].id` — the input-order-dependent target Task 5's test existed to kill | the same assertion (the fixture makes `pages[0]`, `canonicalPageId` and the right answer three DIFFERENT pages) |
| M3 | Walk up exactly one level instead of to a page | `'the walk passes THROUGH a dropped ancestor to the page (page:b), never stopping on shape:badp'` |
| M4 | Walk up to the first ancestor that is not itself dropped (lands on a surviving shape) | `'the walk continues past a SURVIVING ancestor shape to its page — rescue targets a page root, never shape:outer'` |
| M5 | No cycle guard | **the test HANGS** (`timeout` fires). There is no assertion — that is the symptom. |
| M6 | Stop on the `page:` prefix instead of membership in `doc.pages` | `'no page ancestor ⇒ fall back to the canonical page, never to the prefix-shaped non-page page:ghost'` |
| M7 | Apply the same-page rule to `reparentToRoot` as well | `'reparentToRoot still targets the canonical page — the same-page rule applies to the RESCUE path only'` |
| M8 | Resolve ancestors with `doc.shapes.find(...)` (first array match) instead of `doc.byId` | `'the walk resolves an ancestor id through byId (content winner, page:m) — not the first array match (page:z)'` |

M1 and M2 share one assertion **on purpose**: the re-seeded fixture gives three
distinct pages — `pages[0] = page:m`, `canonicalPageId = page:a`, the correct
answer `page:z` — so a single equality is a three-way discriminator. That is
strictly stronger than Task 5's two-page fixture, which could only separate
`pages[0]` from the canonical page.

No assertion is added that kills nothing. In particular, no idempotence
assertion is added (implied by the `checkInvariants(...) === []` assertions
already present, exactly as Task 5 recorded), and no hand-built assertion is
added for the `toRoot`-beats-rescue precedence — on every reachable plan the two
branches agree, so such an assertion could not fail.

### What this ruling invalidates — the full inventory

Measured, not guessed: the change was applied at `5c67923`, every suite run, and
the failures recorded (commands under "measured blast radius").

**`canvas-model/src/repair.test.ts` — exactly ONE assertion changes value:**

- `'the direct child is rescued to the canonical page (smallest id, not pages[0])'`
  (the `rescueDoc` block). It asserts `page:a`; the same-page rule yields
  `page:z`. **Rewrite it, do not delete it** — it was the discriminator for M2
  (rescue to `pages[0]`), and step 1(a) both rewrites it and *strengthens* it
  into the three-way discriminator described above.

Three further assertions are **still correct by value** but carry wording that
becomes misleading, and are updated for that reason only:

- `'child rescued to the canonical page'` (the `chain` block) — the fixture has
  one page, so same-page and canonical coincide. Reword; do not re-seed. This
  block's job is the chain/binding rule, not the target rule.
- `'the survivor is rescued to the canonical page'` (the `bothBad` block) — same
  coincidence. Step 1(b) re-seeds this fixture onto two pages so it becomes the
  **chained-drop** discriminator (M3) instead of a duplicate of the chain block.
- `'exactly ONE surviving physical copy of shape:dup3, rescued to the canonical
  page — not annihilated'` (the ORDER PIN block) — one page, value unchanged,
  and its subject is dedupe ordering rather than the rescue target. **Leave it
  alone.** Listed here so a reviewer who greps `canonical` does not think it was
  missed.

**`canvas-doc/src/repair.test.ts` — nothing invalidated.** Every fixture in that
file has exactly one page (`page:p`), so same-page and canonical coincide
throughout; `doc3`'s `shape:s2` reaches the page via `reparentToRoot`, which
this task does not touch.

> **Known expected failure, and it is NOT yours.**
> `canvas-doc/src/repair.test.ts`'s `'Loro and model application agree
> (order-independent)'` (the `doc3` block) **already fails at `5c67923`** — it is
> Task 6's RED, produced by Task 5, and it is correct. Verified before and after
> this change: same file, same single assertion, same message. Do not fix it
> here. If it starts failing at a *different* assertion after your change, STOP
> and report.

**`canvas-sync/src/convergence.test.ts` — nothing invalidated.** Its rig seeds
`page:p` plus (30% of trials) `page:q`, and parents every shape at `page:p`, so
the same-page target and `canonicalPageId` are both `page:p`. Independently, the
rig's `randomShape` only emits valid shapes and every write path it drives now
validates, so no trial can produce a `validProps` violation at all. Confirmed
green by running it.

### Measured blast radius

Applied at `5c67923`, all four commands run, then reverted with
`git checkout --`. These are observations, not predictions:

| Command | Result |
|---|---|
| `cd canvas-model && ~/.bun/bin/bun test.ts` | **all 14 suites pass** (with step 1's test edits in place) |
| each `canvas-doc/src/*.test.ts` run directly | **13 of 14 pass**; `src/repair.test.ts` fails at `'Loro and model application agree (order-independent)'` — byte-identical to its failure *before* this change |
| `~/.bun/bin/bun canvas-sync/src/convergence.test.ts` | **passes** — `ok: convergence — 50 seeds × N=3 peers × ≤40 ops/peer` |
| `bun run typecheck` | **green in all 13 workspaces** |

> **Run `canvas-doc`'s files DIRECTLY, not through `canvas-doc/test.ts`.** That
> runner exits on the FIRST failing suite. Since `src/repair.test.ts` is
> expected to fail until Task 6, the runner stops there and silently leaves
> every later suite unrun — do not read its early exit as "everything after
> passed". Use:
> ```
> cd /home/stag/src/projects/ensembleworks && for f in canvas-doc/src/*.test.ts; do printf '%-55s ' "$f"; ~/.bun/bin/bun "$f" >/tmp/o 2>&1 && tail -1 /tmp/o || echo FAIL; done
> ```

### Step 1: Write the failing test

Five edits to `canvas-model/src/repair.test.ts`.

**(1a) Re-seed `rescueDoc` onto three pages and rewrite the invalidated
assertion.** Replace this pages line:

```ts
  pages: [{ id: 'page:z', name: 'Z' }, { id: 'page:a', name: 'A' }],
```

with:

```ts
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
```

and replace this assertion:

```ts
assert.equal(
  rescued.byId.get('shape:kid')!.parentId,
  'page:a',
  'the direct child is rescued to the canonical page (smallest id, not pages[0])',
)
```

with:

```ts
assert.equal(
  rescued.byId.get('shape:kid')!.parentId,
  'page:z',
  'the rescued child stays on its own page (page:z) — not pages[0] (page:m), not the canonical page (page:a)',
)
```

Then update that block's leading comment: the paragraph beginning "Pages are
listed z-FIRST on purpose" now describes the wrong thing. Replace that sentence
with a statement of what the three pages now separate — `pages[0]` is `page:m`,
`canonicalPageId` is `page:a`, and the answer must be `page:z`, the page
`shape:badf` was on — so one equality kills both wrong targets. Leave the
paragraph about the three bindings alone; it is still accurate.

**(1b) Re-seed `bothBad` onto two pages so it discriminates the chained-drop
walk.** Replace:

```ts
  pages: [{ id: 'page:p', name: 'P' }],
  shapes: [
    { id: 'shape:badp', kind: 'note', parentId: 'page:p', props: {}, ...base(), opacity: 'no' as any } as any,
```

with:

```ts
  pages: [{ id: 'page:a', name: 'A' }, { id: 'page:b', name: 'B' }],
  shapes: [
    { id: 'shape:badp', kind: 'note', parentId: 'page:b', props: {}, ...base(), opacity: 'no' as any } as any,
```

and replace:

```ts
assert.equal(bothBadRepaired.byId.get('shape:okg')!.parentId, 'page:p', 'the survivor is rescued to the canonical page')
```

with:

```ts
assert.equal(
  bothBadRepaired.byId.get('shape:okg')!.parentId,
  'page:b',
  'the walk passes THROUGH a dropped ancestor to the page (page:b), never stopping on shape:badp',
)
```

**(1c) Reword the `chain` block's target assertion** (value unchanged — that
fixture has one page):

```ts
assert.equal(chainRepaired.byId.get('shape:child')!.parentId, 'page:p', 'child rescued to bad2\'s page')
```

**(1d) Add the five new cases.** Insert them immediately **before** the
`// Zero-page doc:` comment that introduces the `noPageBad` fixture:

```ts
// The rescue target is always a PAGE, never a surviving shape. shape:innerbad
// is dropped from inside a perfectly healthy frame; its child does NOT get
// re-nested into that frame (repair has no mandate to invent a containment
// relationship — it rehomes to the page root, on the page the shape was
// already on).
const nested = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
  shapes: [
    { id: 'shape:outer', kind: 'frame', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:innerbad', kind: 'frame', parentId: 'shape:outer', props: { w: 'wide' }, ...base() } as any,
    { id: 'shape:kid2', kind: 'note', parentId: 'shape:innerbad', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const nestedPlan = repairPlan(nested)
assert.deepEqual(nestedPlan, [{ op: 'dropShape', id: 'shape:innerbad' }], 'precondition: only the inner frame is flagged')
const nestedRepaired = applyRepairToModel(nested, nestedPlan)
assert.equal(
  nestedRepaired.byId.get('shape:kid2')!.parentId,
  'page:z',
  'the walk continues past a SURVIVING ancestor shape to its page — rescue targets a page root, never shape:outer',
)
assert.deepEqual(checkInvariants(nestedRepaired), [], 'invariant-clean after ONE pass')

// No page ancestor at all: the dropped shape is itself an orphan, so walking
// up dead-ends. There is no "same page" to stay on, so the rescue falls back
// to canonicalPageId — the pre-5A doc-wide target. Falling back is forced, not
// chosen: leaving the child on a nonexistent parent would emit a FRESH
// noOrphans violation out of a pass that is required to converge in one call.
// This also pins that a page ancestor is decided by MEMBERSHIP in doc.pages,
// not by the `page:` prefix — 'page:ghost' has the prefix and names no page.
const deadEnd = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }],
  shapes: [
    { id: 'shape:lost', kind: 'note', parentId: 'page:ghost', props: {}, ...base(), opacity: 'no' as any } as any,
    { id: 'shape:kept', kind: 'note', parentId: 'shape:lost', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const deadEndPlan = repairPlan(deadEnd)
assert.deepEqual(deadEndPlan, [{ op: 'dropShape', id: 'shape:lost' }], 'precondition: drop subsumes the orphan reparent for shape:lost')
const deadEndRepaired = applyRepairToModel(deadEnd, deadEndPlan)
assert.equal(
  deadEndRepaired.byId.get('shape:kept')!.parentId,
  'page:a',
  'no page ancestor ⇒ fall back to the canonical page, never to the prefix-shaped non-page page:ghost',
)
assert.deepEqual(checkInvariants(deadEndRepaired), [], 'invariant-clean after ONE pass')

// Cycle guard. repairPlan can never produce this pairing (a shape whose parent
// chain cycles is itself flagged noCycles, so it is reparented rather than
// rescued), so the plan here is HAND-BUILT — the same dead-code-safety
// contract applyRepairToModel already honours for zero-page plans. Without a
// visited set the walk never terminates: a wrong implementation HANGS here
// rather than failing an assertion.
const cyc = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }],
  shapes: [
    { id: 'shape:cycA', kind: 'note', parentId: 'shape:cycB', props: {}, ...base() } as any,
    { id: 'shape:cycB', kind: 'note', parentId: 'shape:cycA', props: {}, ...base() } as any,
    { id: 'shape:kid3', kind: 'note', parentId: 'shape:cycB', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const cycRepaired = applyRepairToModel(cyc, [{ op: 'dropShape', id: 'shape:cycB' }])
assert.equal(
  cycRepaired.byId.get('shape:kid3')!.parentId,
  'page:a',
  'a cycling parent chain terminates and falls back to the canonical page',
)

// reparentToRoot is NOT touched by the same-page rule: an orphan/cycle member
// has no page to stay on, which is the entire reason that op exists. Hand-built
// again, because repairPlan cannot pair reparentToRoot with a resolvable page
// ancestor (see the cycle note above), so only a hand-built plan can tell the
// two targets apart.
const reroot = makeDocument({
  pages: [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }],
  shapes: [
    { id: 'shape:host', kind: 'frame', parentId: 'page:z', props: {}, ...base() } as any,
    { id: 'shape:orph2', kind: 'note', parentId: 'shape:host', props: {}, ...base() } as any,
  ],
  bindings: [],
})
const rerooted = applyRepairToModel(reroot, [{ op: 'reparentToRoot', id: 'shape:orph2' }])
assert.equal(
  rerooted.byId.get('shape:orph2')!.parentId,
  'page:a',
  'reparentToRoot still targets the canonical page — the same-page rule applies to the RESCUE path only',
)

// Purity: the target is resolved through doc.byId (the content winner), never
// through a first-match scan of doc.shapes, and never through the partially
// rehomed output. shape:dupp has two entries on DIFFERENT pages; the geo entry
// wins the content election (see the dedupe block below), so the walk must
// land on page:m even though the note entry (page:z) comes first in the array.
// The reversed construction below asserts the same result under a permuted
// input, which is the property canonicalPageId exists to protect.
const dupChainShapes = [
  { id: 'shape:dupp', kind: 'note', parentId: 'page:z', props: {}, ...base() } as any,
  { id: 'shape:dupp', kind: 'geo', parentId: 'page:m', props: {}, ...base() } as any,
  { id: 'shape:baddd', kind: 'note', parentId: 'shape:dupp', props: {}, ...base(), opacity: 'no' as any } as any,
  { id: 'shape:kiddd', kind: 'note', parentId: 'shape:baddd', props: {}, ...base() } as any,
]
const dupPages = [{ id: 'page:m', name: 'M' }, { id: 'page:a', name: 'A' }, { id: 'page:z', name: 'Z' }] as const
const projectIds = (d: ReturnType<typeof applyRepairToModel>) =>
  d.shapes.map((s) => `${s.id}<-${s.parentId}`).sort()
const dupChain = makeDocument({ pages: dupPages, shapes: dupChainShapes, bindings: [] })
const dupChainRepaired = applyRepairToModel(dupChain, repairPlan(dupChain))
assert.equal(
  dupChainRepaired.byId.get('shape:kiddd')!.parentId,
  'page:m',
  'the walk resolves an ancestor id through byId (content winner, page:m) — not the first array match (page:z)',
)
const dupChainRev = makeDocument({ pages: [...dupPages].reverse(), shapes: [...dupChainShapes].reverse(), bindings: [] })
assert.deepEqual(
  projectIds(applyRepairToModel(dupChainRev, repairPlan(dupChainRev))),
  projectIds(dupChainRepaired),
  'identical converged state ⇒ identical rescue targets, whatever order the arrays arrive in',
)
assert.deepEqual(checkInvariants(dupChainRepaired), [], 'invariant-clean after ONE pass')
```

> **The `as const` on `dupPages` is load-bearing** and was found by running
> `bun run typecheck`, not by reading. Without it the array widens to
> `{ id: string; name: string }[]`, which is not assignable to `readonly Page[]`
> — `Page['id']` is the template-literal type `` `page:${string}` ``. bun runs
> the file happily either way, so the error surfaces only at typecheck, detached
> from the edit. (Same detachment mechanism as the "tsc parse trap" in the
> working rules, different cause.)

> **Style note.** These are top-level `const`s with unique names, matching the
> rest of the file. Do **not** wrap them in bare `{ … }` section blocks — re-read
> the "`tsc` parse trap" rule if you are tempted.

**(1e) Nothing else.** Do not touch the `noPageBad`, `dual`, `rev`, `twoPage`,
`noPages`, dedupe, `dupBad` or ORDER PIN blocks. Their values are unchanged
(verified by running the suite).

### Step 2: Run it and record the verbatim failure

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected (this is the actual output, captured at `5c67923` with only step 1
applied):

```
AssertionError: the direct child is rescued to the canonical page (smallest id, not pages[0])

'page:z' !== 'page:a'

 generatedMessage: false,
     actual: "page:z",
   expected: "page:a",
   operator: "strictEqual",
       code: "ERR_ASSERTION"
```

Note what that message shows: the *old* assertion text, because the re-seeded
three-page fixture already moves `shape:badf` to `page:z` while the landed code
still rescues to `page:a`. Once you have applied edit (1a)'s assertion rewrite
as well, the same run fails with the **new** message and the operands swapped:

```
AssertionError: the rescued child stays on its own page (page:z) — not pages[0] (page:m), not the canonical page (page:a)

'page:a' !== 'page:z'
```

Either is a correct RED — it is the `rescueDoc` block failing on the rescue
target. **If the file passes, STOP and report.** Do not weaken the test and do
not skip to the implementation.

### Step 3: Implement — the `pageAncestorId` helper

In `canvas-model/src/repair.ts`, immediately after `canonicalPageId`, add:

```ts
// The page a RESCUED child must stay on: walk `parentId` up from `startId`
// (the dropped parent) until an id that names a page. Owner ruling 11: a
// rescued child may shift in POSITION but must not change PAGE, so this
// per-shape target replaces the doc-wide canonicalPageId on the rescue path
// ONLY — reparentToRoot still uses canonicalPageId, because an orphan or a
// cycle member has no page to stay on, which is the whole point of that op.
//
// Three properties, each pinned by a case in repair.test.ts:
// - It stops at a page by MEMBERSHIP in doc.pages, never by the 'page:'
//   prefix. A parentId like 'page:ghost' carries the prefix and names no page
//   (that is what invariants.ts's noOrphans rule tests for); stamping it onto
//   a rescued child would emit a fresh noOrphans violation out of a pass that
//   has to converge in ONE call.
// - It walks THROUGH shapes — dropped or surviving — and stops only at a page.
//   Stopping on a dropped ancestor would leave the child pointing at something
//   being removed. Stopping on a SURVIVING ancestor would put the child inside
//   a frame it was never in, inventing a containment relationship repair has
//   no mandate to create.
// - It terminates. noCycles is a real invariant, so a parent chain can cycle;
//   `seen` bounds the walk and the caller falls back to canonicalPageId.
//   Unreachable from a repairPlan-produced plan (a shape whose chain cycles is
//   itself flagged noCycles, so it is reparented rather than rescued) — this is
//   dead-code safety for hand-built plans, like the 'page:orphans' fallback.
// Ancestors resolve through doc.byId — the CONTENT winner under duplicate ids
// (see makeDocument) — never a scan of doc.shapes, so the target is a pure
// function of converged state and cannot depend on array order.
export function pageAncestorId(doc: CanvasDocument, startId: string): Page['id'] | undefined {
  const pageIds = new Set<string>(doc.pages.map((p) => p.id))
  const seen = new Set<string>()
  let cur: string | undefined = startId
  while (cur !== undefined && !seen.has(cur)) {
    if (pageIds.has(cur)) return cur as Page['id']
    seen.add(cur)
    cur = doc.byId.get(cur)?.parentId
  }
  return undefined
}
```

`CanvasDocument` and `Page` are both already imported by this module's first
line (`import { type CanvasDocument, type Page, makeDocument } from './document.js'`)
— **verified, no import change is needed.**

### Step 4: Implement — the rehome branch in `applyRepairToModel`

Replace this comment and return:

```ts
    // A shape is rehomed to the canonical page either because it was flagged
    // (orphan/cycle) or because its parent was just dropped. Same target,
    // same determinism — the rescue must not invent a second rehoming rule.
    return [toRoot.has(s.id) || drop.has(s.parentId) ? { ...s, parentId: pageId } : s]
```

with:

```ts
    // TWO rehoming rules, and the precedence between them is deliberate.
    // reparentToRoot (orphan/cycle) goes to the canonical page: such a shape
    // has no page to stay on. A shape rescued because its PARENT was dropped
    // stays on its own page (owner ruling 11) — the page ancestor of that
    // dropped parent, falling back to the canonical page when the chain
    // dead-ends or cycles.
    // The two branches never disagree on a plan repairPlan produced: a shape
    // whose chain cycles is itself flagged noCycles (so it is in toRoot), and
    // a shape flagged noOrphans has a parent that names nothing (so its parent
    // cannot be dropped). Every toRoot shape therefore has no page ancestor
    // anyway and falls back to the same target. The ordering below defines
    // hand-built plans and keeps the rule statable: removal, then flag, then
    // rescue.
    if (toRoot.has(s.id)) return [{ ...s, parentId: pageId }]
    if (drop.has(s.parentId)) return [{ ...s, parentId: pageAncestorId(doc, s.parentId) ?? pageId }]
    return [s]
```

### Step 5: Refresh the two comments this invalidates

(a) `RepairOp`'s `dropShape` comment says the children go to the canonical page.
Replace:

```ts
  // Invalid envelope/props. Removes ONLY this shape; any shape whose parentId
  // is a dropped id is rehomed to the canonical page root (see
  // applyRepairToModel). Deliberately NOT a subtree cascade: a container with
```

with:

```ts
  // Invalid envelope/props. Removes ONLY this shape; any shape whose parentId
  // is a dropped id is rehomed to the root of the page it was ALREADY on (see
  // pageAncestorId). Deliberately NOT a subtree cascade: a container with
```

Leave the rest of that comment — including the ruling-1 sentence about
parent-relative `x`/`y` — exactly as it is. Ruling 1 still stands.

(b) `canonicalPageId`'s comment opens "The canonical root page every
`reparentToRoot` targets". That is still true, but it is now also the rescue
*fallback* rather than the rescue target. Append one sentence to that comment
saying so and pointing at `pageAncestorId`. Do not otherwise edit it — its
paragraph about why the target cannot depend on container iteration order is
the load-bearing part and is unchanged.

(c) **No change needed** to `repairPlan`'s zero-page `canReparent` comment.
Verified by reading: it already justifies suppressing `dropShape` on the grounds
that there is no rescue target, which the same-page rule strengthens rather than
contradicts (with no pages there is neither a page ancestor nor a fallback).

### Step 6: Run the test and see it pass

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-model/src/repair.test.ts
```

Expected: `ok: repair (model)`

### Step 7: Blast radius

```
cd /home/stag/src/projects/ensembleworks/canvas-model && ~/.bun/bin/bun test.ts
cd /home/stag/src/projects/ensembleworks && for f in canvas-doc/src/*.test.ts; do printf '%-55s ' "$f"; ~/.bun/bin/bun "$f" >/tmp/o 2>&1 && tail -1 /tmp/o || echo FAIL; done
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/convergence.test.ts
cd /home/stag/src/projects/ensembleworks && bun run typecheck
```

Expected, all four **measured** at `5c67923` with this change applied:

- `canvas-model`: **all 14 suites pass.**
- `canvas-doc`: **13 of 14 files pass**; `src/repair.test.ts` fails at exactly
  `'Loro and model application agree (order-independent)'` — the same single
  assertion, with the same message, as it fails at *before* this change. That
  is Task 6's pre-existing RED. **Do not fix it here.**
- `canvas-sync/src/convergence.test.ts`: **passes.**
- `bun run typecheck`: **green in all 13 workspaces.**

**If `canvas-doc` fails anywhere else, or `convergence.test.ts` fails at all,
STOP and report** — do not adjust the rig and do not start Task 6 on top of an
unexplained failure.

Also confirm you introduced none of the clean-room forbidden literals (they are
banned inside comments too, and as substrings of longer words):

```
cd /home/stag/src/projects/ensembleworks && grep -nE "from 'ws'|express|@tldraw/|\.\./server|Date\.now\(|Math\.random\(" canvas-model/src/repair.ts canvas-model/src/repair.test.ts
```

Expected: no output.

### Step 8: Commit

```
cd /home/stag/src/projects/ensembleworks
git add canvas-model/src/repair.ts canvas-model/src/repair.test.ts
git commit -m "fix(canvas-model): a rescued child stays on its own page, not the canonical one"
```

Paste the verbatim step-2 RED output into the commit body.

### Handoff to Task 6 — RESOLVED 2026-07-21, kept as history

> **These corrections have been FOLDED INTO Task 6's own text** (full refresh at
> `7880853`: step 4 now prescribes the same-page rule directly, the import line
> is verbatim-correct, every anchor is a quote rather than a line number, the
> `cascadeDropSet` deletion is in scope as step 5, and the mutant table is
> measured). **Execute Task 6 from Task 6.** This subsection is retained only as
> the record of what was wrong and why — do not treat it as a pending checklist.

The stale instruction was Task 6's step 4(b):

```ts
    const rootPageId = canonicalPageId(model.pages) ?? 'page:orphans'
```

and its step 4(c) stamps that single `rootPageId` onto every rescued child. That
mirrors Task 5, **not** Task 5A. Task 6 must instead mirror the same-page rule:

- Keep `rootPageId = canonicalPageId(model.pages) ?? 'page:orphans'` — it is
  still `reparentToRoot`'s target **and** the rescue fallback.
- In the `dropShape` branch, the child stamp becomes
  `pageAncestorId(model, o.id) ?? rootPageId`, computed **once per dropped
  shape** (`o.id` is the dropped parent, so every child of that node shares the
  target). Add `pageAncestorId` to the `@ensembleworks/canvas-model` import
  alongside `canonicalPageId`.
- The `reparentToRoot` branch keeps `rootPageId` unchanged. Do not over-apply.
- `this.tree.move(c.id, undefined)` still moves the node to the Loro **tree
  root** regardless of which page id is stamped into `data.parentId` — the tree
  has no page nodes, so the page is carried in `data` only. Nothing about the
  move changes; only the stamped value does.

The two defects Task 5's handoff already recorded in Task 6's text still stand
(the import line must retain `SHAPE_KINDS` / `type ShapeKind`; Task 6's
line-number references `repair.test.ts:89-92` and `:187` are rotted). Task 6's
RED is unchanged by 5A and was re-verified at `5c67923` both before and after
this change: `canvas-doc/src/repair.test.ts`, `'Loro and model application agree
(order-independent)'`, the `doc3` block.

Task 6 needs **no new fixture** for the same-page rule if its own fixtures stay
single-page — but a Loro-side same-page case is cheap and worth adding, since
`repair()` is where the two applications are most likely to drift. The minimal
one: two pages, a bad frame on the non-canonical page, one child; assert the
child's `parentId` after `repair()` equals the frame's page, and assert
`normalize(dumpModel(doc)) === normalize(applyRepairToModel(before, plan))`.

### How each claim in this section was checked

| Claim | How |
|---|---|
| page ancestry is decided by membership, not prefix | read `canvas-model/src/invariants.ts` (`noOrphans`: `ids.has(p) \|\| pageIds.has(p)`), `canvas-model/src/ids.ts` (`isPageId`), `canvas-model/src/document.ts` (`rootShapes`) |
| `CanvasDocument` and `Page` are already imported by `repair.ts` | read line 1 of `canvas-model/src/repair.ts` |
| exactly one `canvas-model` assertion changes value | applied the change, ran `~/.bun/bin/bun canvas-model/src/repair.test.ts`, read the single failure |
| every mutant M1–M8 is killed by the named assertion | applied each mutant to `repair.ts` in turn and ran the suite; recorded the first failure verbatim (M5: `timeout 20` fired) |
| `canvas-doc` fixtures are all single-page | read `canvas-doc/src/repair.test.ts` end to end |
| the `doc3` failure pre-dates this change | ran `~/.bun/bin/bun canvas-doc/src/repair.test.ts` at `5c67923` before applying anything |
| `canvas-sync`'s rig cannot reach this path | read the page/shape seeding in `canvas-sync/src/convergence.test.ts`, then ran it |
| `as const` on `dupPages` is required | `bun run typecheck` failed with `TS2322 … Type 'string' is not assignable to type '\`page:${string}\`'` without it |
| the blast-radius table | ran all four commands, then `git checkout --` to restore |

---

## Task 6: Mirror proportionate drop in `LoroCanvasDoc.repair()`

`applyRepairToModel` is the reference; `LoroCanvasDoc.repair()` must agree with
it byte-for-byte after normalization. Tasks 5 and 5A changed the reference. This
task changes the Loro application to match, and discharges ruling 2 by deleting
`cascadeDropSet` — whose last caller this task removes.

**This section was fully re-verified against the tree at `7880853` on
2026-07-21.** Every code block below was pasted into the real files, every
command was run, every mutant was produced and executed. Line numbers appear
only as orientation; every anchor is a **verbatim quote of current code**,
because quotes survive the next refactor and line numbers do not. (The previous
draft's anchors had rotted by ~160 lines.)

### What this task must reproduce, and what it must not

Four rules from Tasks 5/5A, plus one deletion:

1. **Rescue before delete.** Loro's `deleteNode` collects the whole real subtree
   and **clears every descendant's text container** *before* the cascade delete.
   So every physical child must be moved out of the doomed subtree **first**.
   This is the one place the Loro side is genuinely harder than the model side,
   where dropping is a filter over a flat array.
2. **Same-page target (ruling 11, Task 5A).** A rescued child is stamped with
   `pageAncestorId(model, <the dropped parent's id>) ?? rootPageId` — **not** the
   canonical page. Task 5's canonical-page rule is the exact bug 5A removed; do
   not re-land it.
3. **`reparentToRoot` keeps the canonical page.** Do **not** over-apply the
   same-page rule there. An orphan or cycle member has no page to stay on.
4. **Bindings sweep on the named drop set only**, never a descendant closure. A
   binding to a merely *rescued* shape survives — that shape still exists.
5. **Delete `cascadeDropSet`** from `canvas-model/src/repair.ts` (function *and*
   its docblock). Task 5's "Ruling on `cascadeDropSet`'s fate" deferred the
   deletion to this task precisely because `LoroCanvasDoc.repair()` was its last
   caller; step 5 below removes that caller, so the function dies here.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` — the import line and `repair()`
- Modify: `canvas-doc/src/repair.test.ts` — one comment + block rewritten, two
  new blocks added
- Modify: `canvas-model/src/repair.ts` — **delete** `cascadeDropSet` and its
  docblock (the comment above it is itself stale: it says "the next task closes
  by deleting this function and its last caller together" — that task is this
  one, and the whole comment goes with the function)

### The single-page discriminability problem — read this before writing tests

Every pre-existing fixture in `canvas-doc/src/repair.test.ts` has **exactly one
page** (`page:p`). Read end to end and confirmed: `doc`, `doc2`, `doc3`, `doc4`
and the dedupe block all seed only `page:p`.

On a single-page doc the same-page target and `canonicalPageId` are **the same
value**. A `parentId === 'page:p'` assertion on any of those fixtures therefore
passes under the correct implementation *and* under Task 5's canonical-page
implementation. **It proves nothing about rule 2.** Measured, not argued:
applying mutant **M3** (rescue to `rootPageId`) leaves every single-page
assertion in the file green.

**So the fixture change is mandatory, not optional.** Step 3 adds `doc7`: two
pages, with the bad shapes on the **non-canonical** one —
`canonicalPageId = page:a`, correct answer `page:z`. That is the minimum that
discriminates, and it is what actually kills M3 and M4.

> **One thing `doc7` deliberately does NOT pin: the "rescue to `pages[0]`"
> mutant.** Task 5A's canvas-model fixture separates `pages[0]` from
> `canonicalPageId` with a three-page seed. That is **not reproducible at the
> canvas-doc level**, and the reason is worth knowing: `dumpModel` →
> `listPages()` → `LoroMap.keys()`, which converges **sorted**, not in creation
> order. Measured — seeding `page:m`, `page:a`, `page:z` in that order and
> asserting `dumpModel(doc).pages[0].id === 'page:m'` fails with:
>
> ```
> AssertionError: precondition: pages[0] (page:m) is neither the canonical page nor the answer
> 'page:a' !== 'page:m'
> ```
>
> At the Loro level `pages[0]` **is** the canonical page, so the two are
> inseparable there. Do not waste a third page trying. That mutant is killed in
> `canvas-model/src/repair.test.ts` (Task 5A's M2), where the page array order
> is the fixture's own.

### Step 1: Observe the RED — and confirm it is the RIGHT red

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair.test.ts; echo "EXIT=$?"
```

**Measured at `7880853`.** It fails — `EXIT=1` — at **line 80**, the `doc3`
block, assertion:

```
AssertionError: Loro and model application agree (order-independent)
```

with the diff showing `+ actual shapes: []` against `- expected` holding
`shape:s2`: Loro's cascade deleted `shape:s2`, the model's proportionate drop
rescued it. That is the divergence this task closes.

**Confirm THAT specific failure before touching anything.** Not "a failure" —
that assertion, at that line, in the `doc3` block. If it fails somewhere else,
STOP and report: the tree is not where this plan thinks it is.

> **⚠️ A missing or renamed import throws at module load and manufactures a
> FAKE red.** It exits non-zero and prints a stack, so at a glance it looks like
> a passing RED — but no assertion ran, and you have proven nothing. **This has
> been caught three times on this branch.** The output above is what a genuine
> RED looks like: an `AssertionError`, a named assertion message, a value diff,
> and a frame pointing at `repair.test.ts`. A `ModuleNotFound`,
> `SyntaxError`, or `... is not a function` is **not** a RED — fix the import
> and re-run before you believe anything.
>
> Corollary for step ordering: **do the source edits (steps 4–5) only after you
> have banked the step-1 RED output verbatim.** Deleting `cascadeDropSet` first
> would break the import and destroy your ability to observe it.

Also note the runner is **fail-fast** (`process.exit(1)` on the first failure).
**Read the exit code, never the output tail.** In a compound command `$?` is the
*last* command's status, not the suite's — hence the explicit `; echo "EXIT=$?"`
on every command in this section.

### Step 2: Rewrite the `doc4` cascade block — it pins the OLD behaviour

`doc4` currently asserts the cascade. Replace its header comment. Find:

```ts
// Cascade fixpoint (3 levels) on the Loro doc: dropping the invalid root
// removes child AND grandchild (the real-tree subtree), and the binding
// touching the grandchild is swept too. ONE call. Shapes are PUT descendants-
// first (loadModel's bulk-load pattern: fall to root, then a reparent pass
// fixes placement), so listShapes() — node-creation order — yields the
// grandchild before its ancestors and a single in-order pass over it cannot
// reach the grandchild: only a true fixpoint sweeps binding:g4.
```

Replace with:

```ts
// PROPORTIONATE drop, 3 levels deep, on the Loro doc: dropping the invalid
// root removes ONLY that root. Its direct child is rescued onto the dropped
// root's page, the grandchild rides along under the rescued child (untouched),
// and the binding touching the grandchild SURVIVES — the grandchild is still
// there, so the binding is not dangling. Shapes are PUT descendants-first
// (loadModel's bulk-load pattern: fall to root, then a reparent pass fixes
// placement), so listShapes() — node-creation order — yields the grandchild
// before its ancestors; the assertions below sort, so they do not depend on it.
```

Then replace the assertions. Find (everything from the `order.indexOf` message
through the last `checkInvariants` line):

```ts
    `precondition: dump lists the grandchild before its parent (fixpoint required); got ${order.join(', ')}`,
  )
}

const applied4 = doc4.repair()
doc4.commit()
assert.deepEqual(applied4, [{ op: 'dropShape', id: 'shape:bad4' }], 'plan names only the invalid root — descendants cascade')
assert.deepEqual(doc4.listShapes().map((s) => s.id), ['shape:ar4'], 'bad4, child4 AND grandchild4 all gone')
assert.deepEqual(doc4.listBindings(), [], 'binding touching the cascaded grandchild swept in the same pass')
assert.deepEqual(checkInvariants(dumpModel(doc4)), [], 'invariant-clean after ONE repair()')
```

Replace with:

```ts
    `precondition: dump lists the grandchild before its parent (adversarial order); got ${order.join(', ')}`,
  )
}

const before4 = dumpModel(doc4)
const applied4 = doc4.repair()
doc4.commit()
assert.deepEqual(applied4, [{ op: 'dropShape', id: 'shape:bad4' }], 'plan names only the invalid root')
assert.deepEqual(
  doc4.listShapes().map((s) => s.id).sort(),
  ['shape:ar4', 'shape:child4', 'shape:grandchild4'],
  'ONLY bad4 is gone — child4 and grandchild4 survive',
)
assert.equal(doc4.getShape('shape:child4')!.parentId, 'page:p', 'the direct child is rescued to its own page')
assert.equal(doc4.getShape('shape:grandchild4')!.parentId, 'shape:child4', 'the grandchild is untouched, still under the rescued child')
assert.deepEqual(doc4.listBindings().map((b) => b.id), ['binding:g4'], 'the binding survives — its endpoint was rescued, not dropped')
assert.deepEqual(checkInvariants(dumpModel(doc4)), [], 'invariant-clean after ONE repair()')
assert.deepEqual(normalize(dumpModel(doc4)), normalize(applyRepairToModel(before4, repairPlan(before4))), 'model-agreement on the 3-level rescue')
```

Note `'the direct child is rescued to its own page'` — the value `page:p` is
unchanged from the canonical-page era (single-page fixture), but the **wording**
must state the same-page rule, not the canonical-page one.

Also reword `doc3`'s header comment and precondition message, which still say
"cascade". Find:

```ts
// Order-independence (adversarial): a plan holding BOTH dropShape(s1) and
// reparentToRoot(s2) where s2 is inside s1's cascade. Built via putShape's
```

…through…

```ts
// order the ops are applied in — reparent must never resurrect a shape the
// drop cascade claims.
```

Replace the whole comment with:

```ts
// Order-independence (adversarial): a plan holding BOTH dropShape(s1) and
// reparentToRoot(s2), where s2 is ALSO a rescue candidate (its parentId names
// the dropped s1). Built via putShape's bulk-load tolerance: s1's parentId
// names s2 before s2 exists (s1 falls to real-tree root, data.parentId kept),
// then s2 lands under s1 — so the DUMPED model holds the 2-cycle s1↔s2 the
// real Loro tree cannot. s1 also fails validProps, so dedup gives
// dropShape(s1) while s2 keeps reparentToRoot (noCycles). This is the one
// fixture where the two rehoming rules compete for the same shape, and both
// engines must resolve it the same way: reparentToRoot wins, and its target is
// the canonical page. Loro-after-repair must equal applyRepairToModel no
// matter what order the ops are applied in.
```

and change that block's precondition message from
`'precondition: the plan pairs a drop with a reparent of a shape inside its cascade'`
to
`'precondition: the plan pairs a drop with a reparent of the dropped shape’s own child'`.

### Step 3: Add the two new blocks

Both go immediately **above** the final `console.log('ok: repair (doc)')`, so
`normalize` / `base` / `dumpModel` are all already declared.

First extend the import at the top of `canvas-doc/src/repair.test.ts` — the file
now needs `canonicalPageId`. Replace:

```ts
import { applyRepairToModel, checkInvariants, repairPlan, type CanvasDocument } from '@ensembleworks/canvas-model'
```

with:

```ts
import { applyRepairToModel, canonicalPageId, checkInvariants, repairPlan, type CanvasDocument } from '@ensembleworks/canvas-model'
```

Then insert:

```ts
// ---- (6) The reported defect, straight through Loro: one bad prop on a frame
// must not execute the frame's contents, and must not wipe their TEXT
// containers. Text is the part only the Loro side can lose — deleteNode
// cascades over the real tree and clears every descendant's text container, so
// this asserts the rescue happens BEFORE the delete, not merely that the shape
// row survives. ----
const doc6 = LoroCanvasDoc.create({ peerId: 6n })
doc6.putPage({ id: 'page:p', name: 'P' })
doc6.putShapeUnchecked({ id: 'shape:f6', kind: 'frame', parentId: 'page:p', props: {}, ...base(), opacity: 'no' } as any)
doc6.putShape({ id: 'shape:k6', kind: 'note', parentId: 'shape:f6', props: {}, ...base() } as any)
doc6.putShape({ id: 'shape:gk6', kind: 'note', parentId: 'shape:k6', props: {}, ...base() } as any)
doc6.setText('shape:k6', 'precious content')
doc6.setText('shape:gk6', 'also precious')
doc6.commit()

const before6 = dumpModel(doc6)
const plan6 = doc6.repair()
doc6.commit()
assert.deepEqual(plan6, [{ op: 'dropShape', id: 'shape:f6' }])
assert.deepEqual(
  doc6.listShapes().map((s) => s.id).sort(),
  ['shape:gk6', 'shape:k6'],
  'the frame is gone; its contents survive',
)
assert.equal(doc6.getText('shape:k6'), 'precious content', 'the rescued child keeps its text container')
assert.equal(doc6.getText('shape:gk6'), 'also precious', 'the rescued grandchild keeps its text container')
assert.deepEqual(checkInvariants(dumpModel(doc6)), [], 'ONE repair() call converges')
assert.deepEqual(doc6.repair(), [], 'still idempotent')
assert.deepEqual(normalize(dumpModel(doc6)), normalize(applyRepairToModel(before6, repairPlan(before6))), 'model-agreement on the proportionality case')

// ---- (7) SAME-PAGE rescue (owner ruling 11) on a MULTI-PAGE doc. Every other
// fixture in this file has exactly one page (page:p), where the same-page
// target and canonicalPageId are the same value and the rule is therefore
// UNTESTABLE — a same-page assertion on those fixtures passes vacuously. Two
// pages, with the bad shapes on the NON-canonical one, is the minimum that
// discriminates: canonicalPageId = page:a, the correct answer = page:z.
//
// Note what this fixture deliberately does NOT try to pin: the "rescue to
// pages[0]" mutant. dumpModel's page order comes from LoroMap.keys(), which
// converges sorted, so at the canvas-doc level pages[0] IS the canonical page
// and the two are inseparable. That mutant is killed in canvas-model's
// repair.test.ts, where the page array order is the fixture's own.
//
// The chained drop (shape:mid7's own parent is dropped too) additionally pins
// that the walk passes THROUGH a dropped ancestor to the page rather than
// stopping on it — the case where a naive "use the dropped parent's parentId"
// stamps a tombstoned id onto the survivor.
const doc7 = LoroCanvasDoc.create({ peerId: 7n })
doc7.putPage({ id: 'page:a', name: 'A' })
doc7.putPage({ id: 'page:z', name: 'Z' })
doc7.putShapeUnchecked({ id: 'shape:bad7', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc7.putShapeUnchecked({ id: 'shape:mid7', kind: 'frame', parentId: 'shape:bad7', props: {}, ...base(), opacity: 'no' } as any)
doc7.putShape({ id: 'shape:kid7', kind: 'note', parentId: 'shape:mid7', props: {}, ...base() } as any)
doc7.commit()
{
  const before7 = dumpModel(doc7)
  assert.equal(canonicalPageId(before7.pages), 'page:a', 'precondition: the canonical page is NOT the page the bad frames live on')
  const plan7 = repairPlan(before7)
  assert.deepEqual(plan7, [
    { op: 'dropShape', id: 'shape:bad7' },
    { op: 'dropShape', id: 'shape:mid7' },
  ], 'precondition: BOTH frames are dropped, so the rescue walk must pass through a dropped ancestor')
  const expected7 = applyRepairToModel(before7, plan7)
  assert.deepEqual(doc7.repair(), plan7)
  doc7.commit()
  assert.deepEqual(doc7.listShapes().map((s) => s.id), ['shape:kid7'], 'both bad frames gone, the innocent note survives')
  assert.equal(
    doc7.getShape('shape:kid7')!.parentId,
    'page:z',
    'the rescued child stays on its own page (page:z) — not the canonical page (page:a)',
  )
  assert.deepEqual(checkInvariants(dumpModel(doc7)), [], 'invariant-clean after ONE repair()')
  assert.deepEqual(normalize(dumpModel(doc7)), normalize(expected7), 'model-agreement: Loro and model pick the SAME page')
  assert.deepEqual(doc7.repair(), [], 'idempotent')
}
```

### Step 4: Implement in `canvas-doc/src/loro-canvas-doc.ts`

**(4a) The import line.** The **current** line 5 is, verbatim:

```ts
import { canonicalPageId, cascadeDropSet, repairPlan, stableStringify, validateShape, SHAPE_KINDS, type Binding, type Page, type RepairOp, type Shape, type ShapeKind } from '@ensembleworks/canvas-model'
```

Remove `cascadeDropSet`, add `pageAncestorId`, **keep everything else** —
`SHAPE_KINDS` and `type ShapeKind` are used by the `kind` coercion Task 1B
added, and dropping them breaks `bun run typecheck`:

```ts
import { canonicalPageId, pageAncestorId, repairPlan, stableStringify, validateShape, SHAPE_KINDS, type Binding, type Page, type RepairOp, type Shape, type ShapeKind } from '@ensembleworks/canvas-model'
```

**(4b) The `dropAll` computation.** Inside `repair()`, find this comment block
and the line that follows it (currently ~507–519, but match on the text):

```ts
    // dropAll = the plan's dropShape ids plus their transitive descendants in
    // the MODEL (shared cascadeDropSet — same fixpoint applyRepairToModel
    // runs, so the two applications cannot drift). It serves two purposes:
    // 1. Skip-set: a reparentToRoot op whose id is in dropAll is SKIPPED, so
    //    plan-application order can never matter — without the skip, applying
    //    reparent(descendant) before dropShape(ancestor) would move the
    //    descendant out of the doomed subtree and silently resurrect it,
    //    diverging from applyRepairToModel (which always drops it).
    // 2. Binding sweep: a binding whose endpoint is in dropAll becomes
    //    dangling MID-pass (it wasn't when the plan was computed, so the plan
    //    has no deleteBinding op for it); delete it here so a SINGLE repair()
    //    call converges — not only the second.
    const dropAll = cascadeDropSet(model.shapes, new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id)))
```

Replace with:

```ts
    // The ids the plan drops — exactly those, NOT a descendant closure any
    // more. A dropShape removes only the shape it names and rescues that
    // shape's children (see applyRepairToModel, the pure reference this must
    // agree with byte-for-byte after normalization). Two uses:
    // 1. Skip-set: a reparentToRoot op whose id is ALSO dropped is skipped.
    //    Unreachable from repairPlan — its per-id dedup keeps exactly one op
    //    per id and dropShape outranks reparentToRoot — so this is dead-code
    //    safety for hand-built plans, like the 'page:orphans' fallback below.
    //    Under the old CASCADE set it was genuinely reachable (a descendant
    //    could carry its own reparent op); proportionate drop removed that
    //    route. Verified unkillable by mutation: deleting the guard leaves
    //    every suite green.
    // 2. Binding sweep: a binding whose endpoint is dropped becomes dangling
    //    MID-pass (it wasn't when the plan was computed, so the plan has no
    //    deleteBinding op for it); delete it here so a SINGLE repair() call
    //    converges — not only the second. A binding to a merely RESCUED shape
    //    survives, because that shape still exists.
    const dropped = new Set(plan.filter((o) => o.op === 'dropShape').map((o) => o.id))
    // reparentToRoot's target, and the FALLBACK target for a rescued child
    // whose page ancestor cannot be resolved. repairPlan emits neither
    // dropShape nor reparentToRoot for a zero-page doc, so 'page:orphans' is
    // unreachable from a repairPlan-produced plan — dead-code safety only.
    const rootPageId = canonicalPageId(model.pages) ?? 'page:orphans'
```

**(4c) The `dropShape` branch.** It is currently a **single line** (~529):

```ts
      else if (o.op === 'dropShape') for (const n of this.nodesByShapeId(o.id)) this.deleteNode(n) // cascade + text cleanup
```

Replace with:

```ts
      else if (o.op === 'dropShape') {
        // The page every child of THIS dropped shape is rescued onto: the
        // page ancestor of the dropped parent (owner ruling 11 — a rescued
        // child may shift in position but must not change page), falling back
        // to the canonical page when that chain dead-ends or cycles. Computed
        // ONCE per dropped shape: o.id is the parent every child below shares,
        // so every child of this node has the same target.
        const rescueTo = pageAncestorId(model, o.id) ?? rootPageId
        for (const n of this.nodesByShapeId(o.id)) {
          // RESCUE FIRST, DELETE SECOND. deleteNode cascades over the REAL
          // tree and clears every descendant's text container, so every
          // physical child must be moved out of the doomed subtree BEFORE it
          // runs. This is the one place the Loro side is harder than the
          // model side, where dropping is a filter over a flat array.
          // Children that are THEMSELVES dropped are rescued here too and
          // then removed by their own turn in this loop; that ordering is
          // what makes the result independent of the order the plan's
          // dropShape ops are visited in.
          // The [...] copy is defensive only — probed, n.children() hands back
          // a fresh array of freshly-constructed wrappers, so moving during
          // iteration does not disturb it. Kept because that is an
          // undocumented Loro internal, not a contract.
          for (const c of [...(n.children() ?? [])]) {
            this.tree.move(c.id, undefined) // a page-parented shape lives at the Loro tree root
            c.data.set('parentId', rescueTo)
          }
          this.deleteNode(n)
        }
      }
```

> **Both lines inside that inner loop are load-bearing, and each has its own
> mutant.** Dropping the `tree.move` leaves the child physically inside the
> doomed subtree (M9 — the whole rescue silently fails). Dropping the
> `data.set` leaves it pointing at a tombstoned parent (M10 — a fresh
> `noOrphans` violation out of a pass that must converge in one call).

**(4d) The `dedupeShape` branch.** Find:

```ts
        if (dropAll.has(o.id)) {
          // The id is claimed by a drop CASCADE (an ancestor of one of its
          // copies is being dropped): cascadeDropSet is keyed by id, so the
          // model drops EVERY entry of this id — mirror that here by
          // deleting all physical copies (deleteNode's text cleanup is
          // correct in this branch: the id is model-dead) instead of
          // collapsing them to a winner the model would not keep.
```

Replace with:

```ts
        if (dropped.has(o.id)) {
          // Unreachable from repairPlan — dropShape SUBSUMES dedupeShape for
          // the same id, so the two never coexist in a plan, and now that
          // drops no longer cascade there is no cascade route in either.
          // Kept as dead-code safety for hand-built plans: if the id is
          // model-dead, remove every physical copy (deleteNode's text cleanup
          // is correct here) rather than electing a winner the model would
          // not keep.
```

**(4e) The `reparentToRoot` branch.** Find:

```ts
        if (dropAll.has(o.id)) continue // claimed by a drop cascade — see above
        // 'page:orphans' is unreachable: repairPlan emits no reparentToRoot
        // ops for a zero-page doc (dead-code safety only).
        const pageId = canonicalPageId(model.pages) ?? 'page:orphans'
        for (const n of this.nodesByShapeId(o.id)) {
          this.tree.move(n.id, undefined) // page id ⇒ Loro root
          n.data.set('parentId', pageId)
        }
```

Replace with:

```ts
        if (dropped.has(o.id)) continue // unreachable from repairPlan — see the skip-set note above
        // The CANONICAL page, deliberately not the same-page rule: an orphan
        // or a cycle member has no page to stay on, which is the whole point
        // of this op. Do not over-apply pageAncestorId here. (No test can
        // catch that over-application through repair(): an orphan's chain
        // dead-ends and a cycle member's chain cycles, so pageAncestorId
        // returns undefined and falls back to this same value. canvas-model's
        // repair.test.ts pins it with a HAND-BUILT plan, which repair() —
        // which computes its own plan — cannot construct.)
        for (const n of this.nodesByShapeId(o.id)) {
          this.tree.move(n.id, undefined) // page id ⇒ Loro root
          n.data.set('parentId', rootPageId)
        }
```

**(4f) The binding sweep.** Find:

```ts
      if (dropAll.has(b.fromId) || dropAll.has(b.toId)) this.deleteBinding(b.id)
```

Replace with:

```ts
      if (dropped.has(b.fromId) || dropped.has(b.toId)) this.deleteBinding(b.id)
```

After 4a–4f, `grep -c dropAll canvas-doc/src/loro-canvas-doc.ts` must print `0`.

### Step 5: Delete `cascadeDropSet` (discharging ruling 2)

In `canvas-model/src/repair.ts`, delete the docblock **and** the function — the
whole run from `// Transitive closure of shapes to drop:` down to the closing
`}` immediately before `// Reference application on the pure model`. The
docblock goes with it; it is itself stale, claiming "the next task closes [this]
by deleting this function and its last caller together" — this *is* that task.

Do not attempt this before step 4 lands: `canvas-doc` still imports the symbol
until 4a, and a missing export fails at ESM link time — a fake red (see step 1).

Verify:

```
cd /home/stag/src/projects/ensembleworks && grep -rn "cascadeDropSet" --include="*.ts" . | grep -v node_modules; echo "EXIT=$?"
```

Expected: **no output**, `EXIT=1` (grep found nothing). `canvas-model/src/index.ts`
re-exports the whole module via `export * from './repair.js'`, so no export list
needs editing.

### Mutants this task's test must kill

Every row below was **produced and executed** against the step-2/3 test with the
step-4 implementation in place. The "killed by" column is the assertion that
actually fired, verbatim from the run, with the `repair.test.ts` line it fired
at. `node:assert` aborts at the first failure, so each mutant is named by the
first assertion it trips.

| # | Plausible wrong implementation | Killed by |
|---|---|---|
| M1 | Delete without rescuing — **the behaviour at `7880853`**, i.e. this task's own RED | line 82: `'Loro and model application agree (order-independent)'` |
| M2 | Rescue AFTER `deleteNode` instead of before | line 238: `'the rescued child keeps its text container'` |
| M3 | Stamp `rootPageId` on rescued children — **Task 5's canonical-page rule, the bug 5A removed** | line 280: `'the rescued child stays on its own page (page:z) — not the canonical page (page:a)'` |
| M4 | Stamp the dropped shape's own `parentId` (walk up exactly one level) instead of to a page | line 280: the same assertion — `doc7`'s chained drop makes the one-level answer a tombstoned id |
| M5 | Apply the same-page rule to `reparentToRoot` as well | **NOT KILLABLE at this level — see below.** |
| M6 | Remove the `dropped.has(o.id) continue` guard in `reparentToRoot` | **NOT KILLABLE — the guard is unreachable. See below.** |
| M7 | Binding sweep over a descendant closure again (inline fixpoint) instead of the named drop set | line 122: `'the binding survives — its endpoint was rescued, not dropped'` |
| M8 | Iterate `n.children()` without the `[...]` copy | **NOT KILLABLE — the copy is defensive only. See below.** |
| M9 | Stamp `parentId` but omit `this.tree.move(c.id, undefined)` | line 82: `'Loro and model application agree (order-independent)'` |
| M10 | Move the node but omit `c.data.set('parentId', rescueTo)` | line 120: `'the direct child is rescued to its own page'` |

**M2 is the most instructive row, and it justifies the text assertions.** Under
M2 the shape *rows* all survive — `doc4`'s membership assertion, its parentId
assertions, and even its `normalize(...)` model-agreement assertion all pass,
because `dumpModel` does not carry text. `deleteNode` clears the subtree's text
containers *before* the cascade delete, so rescuing afterwards recovers the
structure and loses the content. **Without `doc6`'s two `getText` assertions,
rescue-before-delete — rule 1, the hardest rule on the Loro side — would be
completely unpinned.** Do not trim them.

**Three mutants are honestly unkillable, and each is recorded rather than
faked:**

- **M5** (same-page rule over-applied to `reparentToRoot`). `repair()` computes
  its own plan; no `repairPlan` output can separate the two targets, because a
  `reparentToRoot` shape is either an orphan (chain dead-ends) or a cycle member
  (chain cycles) — `pageAncestorId` returns `undefined` in both cases and falls
  back to `rootPageId`, the same value. Killing this requires a **hand-built
  plan**, which only `applyRepairToModel` accepts. It is killed at the
  canvas-model level by Task 5A's M7. Do not invent a canvas-doc assertion for
  it; the comment in step 4(e) records the reasoning instead.
- **M6** (drop the reparent skip guard). Unreachable by construction:
  `repairPlan`'s per-id dedup keeps exactly one op per id and `dropShape`
  outranks `reparentToRoot`, so no plan holds both for one id. It *was* reachable
  under the old cascade set. Kept as dead-code safety, same status as the
  `'page:orphans'` fallback.
- **M8** (no `[...]` copy). Probed: `n.children()` returns a fresh array of
  freshly-constructed wrappers, so moving during iteration does not disturb it.
  The copy is retained because that is an undocumented Loro internal, not a
  contract — but no assertion can pin it.

No assertion is added that kills nothing.

### Measured blast radius

All four commands run at `7880853` with steps 2–5 applied, then reverted. These
are observations, not predictions:

| Command | Result |
|---|---|
| each `canvas-doc/src/*.test.ts` run directly | **all 14 pass**, `src/repair.test.ts` included — the Task-5 RED is closed |
| `cd canvas-model && ~/.bun/bin/bun test.ts` | **all 14 suites pass** (the `cascadeDropSet` deletion breaks nothing) |
| `~/.bun/bin/bun canvas-sync/src/convergence.test.ts` | **passes** — `ok: convergence — 50 seeds × N=3 peers × ≤40 ops/peer, 854 guarded cycle-op(s) skipped` |
| `bun run typecheck` | **exit 0, 13 workspaces** |

**Assertions that change value when this task lands — the complete list**, all
in `canvas-doc/src/repair.test.ts`, all in the `doc4` block, all rewritten by
step 2:

- `'plan names only the invalid root — descendants cascade'` — message only, the
  plan is unchanged.
- `'bad4, child4 AND grandchild4 all gone'` — was `['shape:ar4']`, now
  `['shape:ar4', 'shape:child4', 'shape:grandchild4']`.
- `'binding touching the cascaded grandchild swept in the same pass'` — was
  `[]`, now `['binding:g4']`. The endpoint is rescued, not dropped, so the
  binding is not dangling and must survive.

Nothing outside `canvas-doc/src/repair.test.ts` changes value. `doc`, `doc2`,
`doc3` and the dedupe block are untouched by the behaviour change (`doc3`'s
model-agreement assertion goes from failing to passing, which is the point).

### Step 6: Run the tests

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair.test.ts; echo "EXIT=$?"
```

Expected: `ok: repair (doc)`, `EXIT=0`.

Then the whole package — **run the files directly, not through
`canvas-doc/test.ts`**, which exits on the first failing suite and silently
leaves later ones unrun:

```
cd /home/stag/src/projects/ensembleworks && for f in canvas-doc/src/*.test.ts; do printf '%-52s ' "$f"; ~/.bun/bin/bun "$f" >/tmp/o 2>&1 && tail -1 /tmp/o || echo FAIL; done
```

Expected: 14 lines, every one an `ok:`.

```
cd /home/stag/src/projects/ensembleworks/canvas-model && ~/.bun/bin/bun test.ts; echo "EXIT=$?"
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun run typecheck >/dev/null 2>&1; echo "EXIT=$?"
```

Expected: `all 14 suites passed` / `EXIT=0`, and `EXIT=0`.

### Step 7: Run the convergence rig — the cross-peer determinism proof

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-sync/src/convergence.test.ts; echo "EXIT=$?"
```

Expected: `ok: convergence — 50 seeds × N=3 peers × ≤40 ops/peer …`, `EXIT=0`.
This is the assertion that would catch a repair that is no longer a pure
function of converged state. **If it fails, STOP and report — do not adjust the
rig.**

### Step 8: Clean-room check

`canvas-model` and `canvas-doc` are clean-room packages. The banned literals are
banned **inside comments too, and as substrings of longer words** — "unexpressible"
contains `express`, and that has been committed on this branch once already.
This refresh caught itself doing exactly that: a step-4(e) comment originally
read "cannot express", which the grep flagged; it now reads "cannot construct".

```
cd /home/stag/src/projects/ensembleworks && grep -nE "from 'ws'|express|@tldraw/|\.\./server|Date\.now\(|Math\.random\(" canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/repair.test.ts canvas-model/src/repair.ts; echo "EXIT=$?"
```

Expected: no output, `EXIT=1`.

### Step 9: Commit

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/repair.test.ts canvas-model/src/repair.ts
git commit -m "fix(canvas-doc): repair() rescues a dropped shape's children onto their own page"
```

Paste the verbatim step-1 RED output into the commit body.

### How each claim in this section was checked

| Claim | How |
|---|---|
| the RED is line 80, `doc3`, `'Loro and model application agree (order-independent)'` | ran `~/.bun/bin/bun canvas-doc/src/repair.test.ts` at `7880853`, read the `AssertionError` and the frame |
| the import line retains `SHAPE_KINDS` / `type ShapeKind` | read line 5 of `canvas-doc/src/loro-canvas-doc.ts`; the previous draft's replacement omitted both |
| the `dropAll` anchors (~507/~529, not ~344/~367) | `grep -n` for the two constructs; the old citations were ~160 lines off, so every anchor here is a quote |
| every mutant M1–M10 is killed (or is not) by the named assertion | applied each to `loro-canvas-doc.ts` in turn, ran the suite, recorded the first failure and its line verbatim; M5/M6/M8 exited 0 and are recorded as unkillable |
| `canvas-doc` fixtures are all single-page | read `canvas-doc/src/repair.test.ts` end to end — only `page:p` before `doc7` |
| the same-page rule is vacuous on single-page fixtures | applied M3; every pre-existing assertion stayed green |
| `pages[0]` is inseparable from the canonical page at this level | seeded `page:m`/`page:a`/`page:z` in that order; `dumpModel(doc).pages[0].id` came back `'page:a'`. Read `listPages()` — it is `LoroMap.keys()` |
| M2 passes every structural assertion and is caught only by text | read the M2 failure frame: `repair.test.ts:238`, the `getText` assertion; read `deleteNode`, which clears the subtree's text before the cascade delete |
| `LoroCanvasDoc.repair()` is `cascadeDropSet`'s last caller | `grep -rn cascadeDropSet --include="*.ts"` — only `canvas-model/src/repair.ts` (the definition) and `canvas-doc/src/loro-canvas-doc.ts` |
| deleting `cascadeDropSet` breaks nothing | deleted it, ran `bun run typecheck` (exit 0, 13 workspaces) and both package suites |
| the blast-radius table | ran all four commands, then `git checkout --` to restore |

---

## Task 6A: `repair()` must rescue LOGICAL children, not just physical ones

> **WHY THIS TASK EXISTS (2026-07-21).** Task 6 (`414375a`) made
> `LoroCanvasDoc.repair()` rescue a dropped shape's children instead of
> cascade-deleting them, and made *"the two implementations agree"* a
> load-bearing, asserted property. It rescues them **physically** — it walks
> `n.children()`, the real Loro tree children. The reference,
> `applyRepairToModel`, rescues them **logically** — `drop.has(s.parentId)`,
> keyed on the stored `parentId` field.
>
> Those two sets are equal only while tree-parent tracks `data.parentId`.
> `placeInTree` deliberately breaks that: a shape put before its logical
> parent's node exists **parks at the tree root while `data.parentId` retains
> the still-missing target**. Such a shape is logically the dropped shape's
> child and physically invisible to `n.children()`, so it is never rescued.
>
> **This is PRE-EXISTING, not a Task 6 regression** — measured, see below.
> Task 6 did not introduce it; Task 6 made the agreement claim load-bearing,
> which is why it must now be closed.

**Files:**
- Modify: `canvas-doc/src/loro-canvas-doc.ts` — `repair()` (one new index),
  `dropNodeRescuingChildren` → `dropShapeRescuingChildren`, and one stale
  comment in `placeInTree`
- Modify: `canvas-doc/src/repair.test.ts` — two new blocks (`doc8`, `doc9`);
  **no existing block changes**
- Modify: `canvas-model/src/repair.ts` — one comment that asserts the
  divergence still exists, which this task makes false

### The reproduced divergence — run this before you plan against it

Verbatim, at `933314e`:

```
putShape c2 with parentId 'shape:b2'     // b2 does not exist yet -> c2 parks at the tree root
putShapeUnchecked b2 (opacity: 'no')     // b2 now exists and is invalid
plan: [{ op: 'dropShape', id: 'shape:b2' }]

  model expects c2.parentId = page:p     (logical child, rescued)
  loro   gives  c2.parentId = shape:b2   (not a physical child, never rescued -> dangling)
  physical children of b2's node: []
  checkInvariants after ONE repair: [{"rule":"noOrphans","id":"shape:c2","detail":"missing parent shape:b2"}]
  second pass plan: [{"op":"reparentToRoot","id":"shape:c2"}] -> c2.parentId = page:p
```

Two asserted properties break: **model-agreement** and **one-pass
convergence**. Note also *where* the second pass lands it: `canonicalPageId`,
**not** the same-page target ruling 11 requires — so ruling 11 is silently
violated on this path too.

**Pre-existing, measured not argued.** The same seed was run in a throwaway
worktree at `5685c18` (Task 6's parent, when the Loro side still cascaded):
byte-identical output — `c2.parentId = shape:b2`, text intact, the same single
`noOrphans` violation, the same second-pass plan. The reason is visible in that
commit's `repair()`: `dropAll` (the *logical* `cascadeDropSet` closure) was used
only for the binding sweep and the reparent skip-set, while the actual removal
was `deleteNode(n)` — a **physical** cascade. A root-parked logical child was
outside it then, exactly as it is outside `n.children()` now.

> **One correction to carry forward.** The framing that "the old cascade
> diverged here too, **in the other direction**" does not survive measurement.
> At `5685c18` the outcome for this seed was identical to today's, and the
> divergence from the model ran in the **same** direction (model keeps `c2` on
> its page; Loro leaves `c2` dangling at `shape:b2`). What `dropAll` did differ
> on was the **binding sweep**, a separate axis. Do not repeat the
> other-direction claim in the PR body.

### Why this is production-reachable — not theoretical

**`loadModel` is NOT a production path.** `grep -rn loadModel --include="*.ts"`
returns exactly: its definition (`canvas-doc/src/bridge.ts:20`), two test
callers (`bridge.test.ts`, `bindings-pages.test.ts`), and three comment
mentions. Nothing in `server/`, `client/`, `canvas-sync/` or `cli/` calls it.
Any comment implying `loadModel` closes this window is false — one such comment
is corrected in step 5.

**The real production writer is `reconcile()`** (`server/src/canvas-v2/
reconcile.ts`, driven by `ShadowMirror` in `server/src/canvas-v2/shadow.ts`).
Its own docblock documents this exact window as **open**, verbatim from the
file:

```
 * Absent-parent tolerance: a target shape whose parentId names a shape absent
 * from `target` inherits putShape's bulk-load tolerance — its real Loro node
 * parks at the tree root while data.parentId retains the missing id ...
 * This is deterministic and idempotent, and it IS
 * reachable here: shadow consumes arbitrary live-room data, and fromTldraw
 * drops unknown shape types, which can orphan a surviving child's parentId.
```

`reconcile()` has **no second reparent pass** — read it end to end and confirm.

**And sync produces the same state without `reconcile()` at all.** Probed
across two peers: A calls `reparent(c, p1)` while B concurrently calls
`reparent(p1, c)`. Loro's tree CRDT breaks the resulting cycle by parking the
loser at the **tree root**, while its `data.parentId` register keeps the other
answer. Measured, and identical on both peers:

```
cycle A shape:c: tree=shape:p1 data=shape:p1 | shape:p1: tree=<root> data=shape:c
cycle B shape:c: tree=shape:p1 data=shape:p1 | shape:p1: tree=<root> data=shape:c
```

`shape:p1` is now a logical child of `shape:c` sitting at the tree root — the
defect's precondition, reached through `/sync/v2` with no shadow mirror
involved. So this is not gated on the near-term intent to point the v1→v2
mirror at a **live, user-visible** v2 document; that intent raises the stakes,
it does not create the reachability.

### The design questions, settled — with the evidence

**Q1 — Key the rescue on stored `parentId`, physical children, or the union?**
**The union, with DIFFERENT treatment per set.** The pure model is the
reference and canvas-doc must agree with it, so a *logical* rescue is what
makes `parentId` values match. But switching to logical-only would be a data
loss: `deleteNode` cascades over the **real** tree and clears every
descendant's text container, so a physical child the model KEEPS would be
destroyed. Both sets therefore matter, for different reasons:

| set | why it must be handled | what happens to it |
|---|---|---|
| LOGICAL — `data.parentId === <dropped id>` | model-visible: `applyRepairToModel` rewrites its `parentId` | lift to the Loro root **and** stamp `rescueTo` |
| PHYSICAL-only — a real tree child whose `data.parentId` names something else | invisible to the model, but `deleteNode` would cascade it away | lift to the Loro root, **leave `data.parentId` alone** |

The mirror-image case in the second row is the one the brief asks about
directly: *does it exist, is it reachable, what should happen to it?* Answers,
in order.

- **What should happen:** nothing model-visible. `applyRepairToModel` does not
  match it (`drop.has(s.parentId)` is false), so it keeps its stored
  `parentId`. Stamping `rescueTo` on it — which is what the code does
  **today**, unconditionally — is a divergence. Mutant **M4** pins it.
- **Is it reachable?** **No known public-API route, and I could not construct
  one.** Every mutator that moves a node also writes `data.parentId`
  (`placeInTree`, `reparent`, `putShapeUnchecked`, `repair()`'s
  `reparentToRoot`); `dedupeShapeNodes`' two raw moves both land on states
  where `data.parentId` still resolves correctly; and the merge probes above
  show Loro resolves a concurrent move conflict to the **tree root**, which is
  the *first* row's shape, not this one. Probed three ways (concurrent
  reparent-to-different-parents, reparent-vs-putShape, delete-vs-move) — none
  produced it.
- **So why handle it at all?** Because the physical evacuation is what stops
  `deleteNode` eating survivors, and it must not lie about `parentId` while
  doing so. It is **dead-code safety**, in the idiom this plan already uses for
  the `'page:orphans'` fallback and the `dropped`-set reparent skip. It is
  pinned by a **white-box** fixture (`doc9`, using `tree.move` directly),
  exactly as the plan's other unreachable guards are pinned by **hand-built
  plans**. Say so in the PR body; do not claim it is reachable.

**Q2 — How do you enumerate logical children efficiently?** There is **no
existing index** — `this.index` is `shapeId → nodes`, not `parentId → children`
— so it is a scan. Build it **ONCE per `repair()` call** from `model.shapes`
(the pre-repair dump `repair()` already computes), not per plan op.

**Cost, measured, `repair-cost.test.ts`'s own fixtures:**

| | clean 1k-doc (0-op plan) | dirty 1k-doc (500-op plan) | `tree.nodes()` calls clean/dirty |
|---|---|---|---|
| before | 7.727 ms | 15.87 ms | 1 / 2 |
| after | 7.583 ms | 15.43 ms | 1 / 2 |

Unchanged within noise. **Complexity class is unchanged:** `repair()` was
already `O(shapes)` via `dumpModel`, and this adds one more `O(shapes)` pass
plus `O(1)` bucket lookups.

**Yes, `repair-cost.test.ts` constrains you, and hard.** It is not only a
wall-clock pin — it carries a **structural gate**, `dirtyCalls === cleanCalls +
1`, asserting `tree.nodes()` is not called per plan op. The obvious lazy
implementation (`this.listShapes().filter(s => s.parentId === o.id)` inside the
loop) trips it. Measured as mutant **M6**:

```
AssertionError: dirty-doc repair() mean 3097.59ms exceeds the 100ms ceiling
```

**Q3 — Does this interact with `deleteNode`'s text-clearing cascade?**
Confirmed by measurement, not assumed. A logical child parked at the tree root
is **not** in the dropped node's physical subtree, so `deleteNode`'s `collect()`
never reaches it and its text container is never cleared — in the repro above,
`c2`'s text read back `"precious"` both at `933314e` and at `5685c18`. So the
missing rescue costs the shape's *placement*, not its text.

**The RESCUE-FIRST / DELETE-SECOND ordering constraint still holds, and gets
stronger.** Both rescues stay inside one named unit,
`dropShapeRescuingChildren`, which ends with `deleteNode`. Worth recording
because it is not obvious: the physical safety property is now **self-contained
in the physical loop** — that loop lifts *every* remaining tree child clear
regardless of what the logical pass did — so the two rescues are genuinely
order-independent with respect to each other. Only their joint position before
`deleteNode` is load-bearing. Keeping them in one method is what makes that
impossible to separate by a later edit, which is the reason the unit was
extracted in Task 6.

**Q4 — Must `repair()` remain a pure function of converged state?** Yes; this
is the standing mandate `canonicalPageId` exists for. Three rules preserve it,
and they are the same three Task 5A used:

1. The index is built from **`model`**, the untransformed pre-repair dump —
   never from live state that earlier ops in the same pass have already
   rehomed. Same discipline as `applyRepairToModel`'s fused pass.
2. Every rescued child gets the **identical** treatment (lift to root, stamp
   the one `rescueTo` computed once for this dropped id), so no child's outcome
   depends on any other child's.
3. The child ids are **sorted** before iteration, so the *sequence of Loro ops*
   emitted is a function of converged data (ids) rather than of `listShapes()`
   traversal order, which is an undocumented Loro internal.

Rule 3 is belt-and-braces: mutant **M8** (omit the sort) is **unkillable** —
see the mutant table for why. Keep the sort anyway; the mandate is on the code,
not on the tests' ability to see it.

**Q5 — Does ONE pass now converge for the reproduced case?** Yes. Measured on
the multi-page form of the repro, after the fix:

```
model expects c2.parentId = page:z
loro   gives  c2.parentId = page:z
text: "precious"
invariants after ONE repair: []
```

and `doc.repair()` returns `[]` on the second call. The `doc8` fixture below
asserts exactly this.

### Mutants this task's test must kill

Every row was **produced and executed** against the step-1 tests with the
step-3/4 implementation in place; the "killed by" column is the assertion that
actually fired, verbatim from the run. `node:assert` aborts at the first
failure, so each mutant is named by the first assertion it trips.

| # | Plausible wrong implementation | Killed by |
|---|---|---|
| M1 | **Ship as-is** — rescue only `n.children()`, no logical index | `'the rescued LOGICAL child is on the dropped parent’s own page (page:z) — not left dangling at shape:bad8, not sent to the canonical page:a'` — `actual: "shape:bad8", expected: "page:z"` |
| M2 | Logical rescue stamps `rootPageId` instead of `rescueTo` | Task 6's own `doc7` assertion: `'the rescued child stays on its own page (page:z) — not the canonical page (page:a)'` — `actual: "page:a", expected: "page:z"` |
| M3 | Logical rescue restamps `parentId` but omits `this.tree.move(c.id, undefined)` | `'the rescued logical child was physically lifted off its old host — proven by the host’s cascade'` — `actual: undefined, expected: true` |
| M4 | Physical evacuation **also** stamps `rescueTo` (today's unconditional set) | `'a PHYSICAL-only child keeps its stored parentId — the model does not rehome it, so neither may Loro'` — `actual: "page:z", expected: "page:a"` |
| M5 | Delete the physical evacuation loop, trust the logical rescue alone | `'only bad9 is gone — the physical squatter is NOT swept up by the cascade'` — `actual` is missing `shape:squat9` |
| M6 | Rebuild the logical index **per op** from `this.listShapes()` | `repair-cost.test.ts`: `AssertionError: dirty-doc repair() mean 3097.59ms exceeds the 100ms ceiling` |
| M7 | Index keyed on `s.id` instead of `s.parentId` (the transposition) | Task 6's own `doc4` assertion: `'the direct child is rescued to its own page'` — `actual: "shape:bad4", expected: "page:p"` |
| M8 | Omit `.sort()` on the logical child ids | **UNKILLABLE.** Recorded honestly, not papered over. |

**M8's structural reason.** The sort only reorders the `tree.move` calls within
one dropped id. Every child receives the identical treatment and the identical
`rescueTo`, so the converged *model* state is the same for any order; the only
thing that varies is sibling ordering at the Loro tree root, which is
model-invisible (z-order comes from `data.index`) and which every comparison in
the suite normalizes by sorting on `id`. Run with the sort removed:
`canvas-doc/src/repair.test.ts` exits 0 and
`canvas-sync/src/convergence.test.ts` reports `ok: convergence — 50 seeds × N=3
peers × ≤40 ops/peer`. **Do not invent an assertion to manufacture a kill.**

Note that **M2 and M7 are killed by Task 6's existing fixtures, not by new
ones.** That is the intended shape: Task 6 already discriminates the *target*
and the *direct-child* rule; this task adds only what those fixtures structurally
cannot see.

### The fixtures genuinely discriminate — here is why

Task 6's planner established that canvas-doc's pre-`doc7` fixtures are all
single-page, so a same-page assertion on them passes vacuously. The same trap
applies here in a different dimension, and both new fixtures are built to avoid
it:

- **`doc8` exercises the bulk-load window for real.** `shape:kid8` is `putShape`d
  **before** `shape:bad8` exists, so `placeInTree` parks it at the tree root.
  The fixture asserts that precondition directly —
  `(badNode.children() ?? []).map(...)` must be `[]` — so if a future edit
  reorders the seed and `kid8` becomes an ordinary physical child, the fixture
  fails as a **precondition**, loudly, instead of passing for the wrong reason.
- **`doc8` is two-page** (`page:a` canonical, `page:z` the answer), so the same
  assertion is a simultaneous discriminator for the rescue *target*. A
  single-page version would have been green under M2.
- **`doc9` separates the two child sets by construction:** `shape:squat9` is
  physical-only, `shape:far9` is logical-only-and-not-at-the-root,
  `shape:kid9` is both. A fix that handles only one set fails `doc9`.

### Measured blast radius

The fix was applied to the tree at `933314e`, every command below was run, and
the tree was then restored with `git checkout --`. These are observations, not
predictions.

| Command | Result |
|---|---|
| each `canvas-doc/src/*.test.ts` run directly | **all 14 pass** |
| `cd canvas-model && ~/.bun/bin/bun test.ts` | **all 14 suites pass** |
| each `canvas-sync/src/*.test.ts` run directly | **all 12 pass**, including `convergence` and `fuzz` |
| each `server/src/canvas-v2/*.test.ts` run directly | **all 13 pass**, including `reconcile`, `shadow`, `soak-actor`, `crash-recovery` |
| `bun run typecheck` | **exit 0**, 13 workspaces |
| `bun run test` (full) | one failure — see the note below |

**Exactly ZERO existing assertions change value.** The change is additive in
effect: it only touches shapes the old code never reached (logical-only
children) and only removes a `parentId` write on shapes no fixture had
(physical-only children). Do not "expect" a blast radius here; there isn't one.

> **The one full-suite failure is PRE-EXISTING and is NOT yours.**
> `scripts/ux-contract-presence.test.ts` fails on the **clean** tree at
> `933314e` — verified by running it with nothing modified:
> ```
> AssertionError: diff touches interaction-bearing path(s)
> [client/src/canvas-v2/CanvasV2App.tsx, client/src/canvas-v2/DevOverlay.test.ts,
>  client/src/canvas-v2/DevOverlay.tsx] without touching the interaction-contracts
>  module ... and without a 'ux-contract: none — <reason>' marker in the PR body.
> ```
> It judges the **whole branch diff against `origin/main`**, not your working
> tree, and it is satisfied by the PR body, not by code. This task's own change
> touches no interaction-bearing path. See "PR body — required content".

### Step 1: Write the failing tests

Two new blocks appended to `canvas-doc/src/repair.test.ts`, immediately
**before** its final `console.log('ok: repair (doc)')` line. Nothing else in
that file changes. Both use helpers the file already has in scope (`base`,
`normalize`, `byIdAsc`) and imports it already carries (`canonicalPageId`,
`repairPlan`, `applyRepairToModel`, `checkInvariants`, `dumpModel`) — **add no
imports**, which is also why no module-load failure can masquerade as the RED
here (see step 2).

```ts
// ---- (8) LOGICAL child rescue: a shape whose STORED parentId names the
// dropped shape while its real tree node is NOT a child of it. placeInTree
// parks a shape at the Loro tree ROOT when its parentId names a node that
// does not exist yet, retaining data.parentId — so n.children() cannot see
// it, but applyRepairToModel's drop.has(s.parentId) test can. This is the
// state reconcile() reaches in production (its "Absent-parent tolerance"
// note) and that Loro's own cycle resolution reaches over /sync/v2. Two
// pages, bad shape on the NON-canonical one, so the same assertion also
// discriminates the rescue TARGET. ----
const doc8 = LoroCanvasDoc.create({ peerId: 8n })
doc8.putPage({ id: 'page:a', name: 'A' })
doc8.putPage({ id: 'page:z', name: 'Z' })
doc8.putShape({ id: 'shape:kid8', kind: 'note', parentId: 'shape:bad8', props: {}, ...base() } as any)
doc8.putShapeUnchecked({ id: 'shape:bad8', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc8.setText('shape:kid8', 'precious content')
doc8.commit()
{
  const badNode = (doc8 as any).nodeByShapeId('shape:bad8')
  assert.deepEqual(
    (badNode.children() ?? []).map((n: any) => n.data.get('shapeId')),
    [],
    'precondition: kid8 is a LOGICAL child of bad8 only — the real tree node has no children at all',
  )
  assert.equal(doc8.getShape('shape:kid8')!.parentId, 'shape:bad8', 'precondition: kid8 stored parentId still names bad8')
  const before8 = dumpModel(doc8)
  assert.equal(canonicalPageId(before8.pages), 'page:a', 'precondition: the canonical page is NOT the page bad8 lives on')
  const plan8 = repairPlan(before8)
  assert.deepEqual(plan8, [{ op: 'dropShape', id: 'shape:bad8' }], 'precondition: the plan drops only bad8')
  const expected8 = applyRepairToModel(before8, plan8)
  assert.deepEqual(doc8.repair(), plan8)
  doc8.commit()
  assert.deepEqual(doc8.listShapes().map((s) => s.id).sort(), ['shape:kid8'], 'the logical child survives the drop')
  assert.equal(
    doc8.getShape('shape:kid8')!.parentId,
    'page:z',
    'the rescued LOGICAL child is on the dropped parent’s own page (page:z) — not left dangling at shape:bad8, not sent to the canonical page:a',
  )
  assert.equal(doc8.getText('shape:kid8'), 'precious content', 'the rescued logical child keeps its text container')
  assert.deepEqual(checkInvariants(dumpModel(doc8)), [], 'invariant-clean after ONE repair() — no second pass')
  assert.deepEqual(normalize(dumpModel(doc8)), normalize(expected8), 'model-agreement on the logical rescue')
  assert.deepEqual(doc8.repair(), [], 'idempotent')
}

// ---- (9) The two child sets are DIFFERENT, and each needs its own
// treatment. White-box tree.move calls build the split-brain states directly:
// no public-API sequence is known to produce a PHYSICAL child whose stored
// parentId names something else (every mutator that moves a node also writes
// data.parentId, and Loro resolves a concurrent move cycle to the tree ROOT,
// which is doc8's shape, not this one). This pins the intended contract the
// same way hand-built plans pin repair()'s other unreachable guards. ----
const doc9 = LoroCanvasDoc.create({ peerId: 19n })
doc9.putPage({ id: 'page:a', name: 'A' })
doc9.putPage({ id: 'page:z', name: 'Z' })
doc9.putShapeUnchecked({ id: 'shape:bad9', kind: 'frame', parentId: 'page:z', props: {}, ...base(), opacity: 'no' } as any)
doc9.putShape({ id: 'shape:host9', kind: 'frame', parentId: 'page:a', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:squat9', kind: 'note', parentId: 'page:a', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:kid9', kind: 'note', parentId: 'shape:bad9', props: {}, ...base() } as any)
doc9.putShape({ id: 'shape:far9', kind: 'note', parentId: 'shape:bad9', props: {}, ...base() } as any)
doc9.setText('shape:squat9', 'squatter text')
{
  const tree9 = (doc9 as any).tree
  const node9 = (id: string) => (doc9 as any).nodeByShapeId(id)
  // squat9: a PHYSICAL child of bad9 whose stored parentId still says page:a.
  tree9.move(node9('shape:squat9').id, node9('shape:bad9').id)
  // far9: a LOGICAL child of bad9 parked under an unrelated SURVIVOR — so the
  // rescue cannot be a no-op that merely happens to leave it at the root.
  tree9.move(node9('shape:far9').id, node9('shape:host9').id)
  doc9.commit()
  assert.equal(doc9.getShape('shape:squat9')!.parentId, 'page:a', 'precondition: squat9 is physically under bad9 but logically on page:a')
  assert.equal(doc9.getShape('shape:far9')!.parentId, 'shape:bad9', 'precondition: far9 is logically bad9’s child but physically under host9')

  const before9 = dumpModel(doc9)
  const plan9 = repairPlan(before9)
  assert.deepEqual(plan9, [{ op: 'dropShape', id: 'shape:bad9' }], 'precondition: the plan drops only bad9')
  const expected9 = applyRepairToModel(before9, plan9)
  assert.deepEqual(doc9.repair(), plan9)
  doc9.commit()
  assert.deepEqual(
    doc9.listShapes().map((s) => s.id).sort(),
    ['shape:far9', 'shape:host9', 'shape:kid9', 'shape:squat9'],
    'only bad9 is gone — the physical squatter is NOT swept up by the cascade',
  )
  assert.equal(
    doc9.getShape('shape:squat9')!.parentId,
    'page:a',
    'a PHYSICAL-only child keeps its stored parentId — the model does not rehome it, so neither may Loro',
  )
  assert.equal(doc9.getText('shape:squat9'), 'squatter text', 'the physical-only child keeps its text container')
  assert.equal(doc9.getShape('shape:far9')!.parentId, 'page:z', 'the LOGICAL child is rescued to bad9’s own page')
  assert.equal(doc9.getShape('shape:kid9')!.parentId, 'page:z', 'the ordinary logical+physical child is rescued the same way')
  assert.deepEqual(checkInvariants(dumpModel(doc9)), [], 'invariant-clean after ONE repair()')
  assert.deepEqual(normalize(dumpModel(doc9)), normalize(expected9), 'model-agreement on the mixed physical/logical case')
  assert.deepEqual(doc9.repair(), [], 'idempotent')
  // far9 was lifted PHYSICALLY, not merely restamped: deleting its former
  // physical host must not take it along. Same proof shape as the dedupe
  // block's 'physical rescue proven' assertion.
  doc9.deleteShape('shape:host9')
  doc9.commit()
  assert.ok(doc9.getShape('shape:far9'), 'the rescued logical child was physically lifted off its old host — proven by the host’s cascade')
}
```

### Step 2: Run them and confirm the RED is GENUINE

```
~/.bun/bin/bun canvas-doc/src/repair.test.ts; echo "EXIT=$?"
```

**Measured at `933314e`.** `EXIT=1`, failing in the `doc8` block at:

```
AssertionError: the rescued LOGICAL child is on the dropped parent’s own page (page:z) — not left dangling at shape:bad8, not sent to the canonical page:a
     actual: "shape:bad8",
   expected: "page:z",
   operator: "strictEqual",
       code: "ERR_ASSERTION"
      at .../canvas-doc/src/repair.test.ts
```

**Confirm THAT assertion, in THAT block.** Not "a failure". If it fails
anywhere else, STOP and report — the tree is not where this plan thinks it is.

> **⚠️ A missing or renamed import throws at module load and manufactures a
> FAKE green-looking RED.** It exits non-zero and prints a stack, so at a
> glance it reads as a passing RED — but **no assertion ran and you have proven
> nothing**. **This has been caught three times on this branch.** A genuine RED
> has all four of: an `AssertionError`, the named assertion message, an
> `actual`/`expected` value diff, and a frame pointing into `repair.test.ts`. A
> `ModuleNotFound`, `SyntaxError`, `Export named 'X' not found`, or
> `... is not a function` is **NOT** a RED — fix it and re-run before you
> believe anything. Step 1 adds no imports specifically so this failure mode
> has no way in; if you see one anyway, something else is wrong.

**Then bank `doc9`'s own RED, so it is not merely riding on `doc8`.**
`node:assert` aborts at the first failure, so `doc9` never runs while `doc8` is
red. Temporarily comment out the `doc8` block, re-run, and record:

```
AssertionError: a PHYSICAL-only child keeps its stored parentId — the model does not rehome it, so neither may Loro

'page:z' !== 'page:a'
     actual: "page:z",
   expected: "page:a",
```

Then **uncomment `doc8`**. Both verbatim outputs go in the commit message.

Note the runner is **fail-fast** (`process.exit(1)` on the first failure).
**Read the exit code, never the output tail.** In a compound command `$?` is
the *last* command's status, not the suite's — hence the explicit
`; echo "EXIT=$?"` on every command in this section.

### Step 3: Build the logical-children index in `repair()`

In `canvas-doc/src/loro-canvas-doc.ts`, find this line inside `repair()`
(verbatim anchor):

```ts
    const pageIds = new Set<string>(model.pages.map((p) => p.id))
```

Insert immediately **after** it:

```ts
    // LOGICAL children, indexed ONCE: stored parentId → the ids that name it.
    // This is what lets the dropShape branch below find the same children
    // applyRepairToModel finds (drop.has(s.parentId)) rather than only the
    // ones the real tree happens to hold under the doomed node — see
    // dropShapeRescuingChildren. There is no existing index for this: `index`
    // is shapeId → nodes, a different question.
    //
    // Built here rather than per op deliberately. One O(shapes) pass, so a
    // plan with N drops does not reintroduce the O(shapes × N) rescan the
    // node index removed. repair-cost.test.ts enforces that both ways — its
    // wall-clock ceiling AND its structural gate (tree.nodes() call count must
    // not scale with plan size). Rebuilding this per op from listShapes()
    // measured 3097.59ms against the 100ms ceiling on the 500-drop fixture,
    // versus 15.43ms as written.
    //
    // Read from `model` — the UNTRANSFORMED pre-repair dump — never from live
    // state that earlier ops in this same pass have already rehomed. That is
    // the same discipline applyRepairToModel's fused pass keeps, and it is
    // what makes the result a pure function of converged state.
    const logicalChildren = new Map<string, string[]>()
    for (const s of model.shapes) {
      const arr = logicalChildren.get(s.parentId)
      if (arr) arr.push(s.id); else logicalChildren.set(s.parentId, [s.id])
    }
```

### Step 4: Repoint the `dropShape` branch

Still in `repair()`, replace this line (verbatim anchor):

```ts
        for (const n of this.nodesByShapeId(o.id)) this.dropNodeRescuingChildren(n, rescueTo)
```

with:

```ts
        this.dropShapeRescuingChildren(o.id, rescueTo, logicalChildren.get(o.id) ?? [])
```

The per-node loop moves **into** the new method, because the logical rescue
must run exactly ONCE per dropped id even when several physical nodes share it
(see `nodesByShapeId`), while the physical evacuation runs once per node.

### Step 5: Replace `dropNodeRescuingChildren`

Delete the whole existing method **and its docblock** — from the line

```ts
  // RESCUE FIRST, DELETE SECOND — pulled into its own named unit so the
```

through the closing `}` of `dropNodeRescuingChildren`, ending just before

```ts
  // PERF (measured, Phase 2 review): ~7.36ms/call at 1k shapes on a CLEAN doc
```

Replace it with:

```ts
  // RESCUE FIRST, DELETE SECOND — the whole of one dropShape op, in ONE named
  // unit so no later edit can reorder the rescue after the delete. deleteNode
  // cascades over the REAL tree and clears every descendant's text container,
  // so everything the model KEEPS must be out of the doomed subtree before it
  // runs. This is the one place the Loro side is genuinely harder than the
  // model side, where dropping is a filter over a flat array.
  //
  // TWO rescues, because "child" means two different things here, and
  // applyRepairToModel — the reference this must agree with byte-for-byte
  // after normalization — matches only ONE of them:
  //
  // 1. LOGICAL children: every shape whose STORED parentId names `id`. This is
  //    exactly the reference's drop.has(s.parentId) test, and it is the only
  //    rescue that is MODEL-VISIBLE — these are the shapes whose parentId the
  //    reference rewrites to `rescueTo`. A logical child need not be a
  //    physical child: placeInTree parks a shape at the tree ROOT when its
  //    parentId names a node that does not exist yet, keeping data.parentId
  //    on the missing target, and Loro's own cycle resolution parks the loser
  //    of a concurrent move race the same way. Such a shape is invisible to
  //    n.children(). Before this branch existed it was silently missed,
  //    leaving it a dangling orphan that only a SECOND repair() pass cleaned
  //    up — and to canonicalPageId, not to `rescueTo`, so ruling 11 was
  //    violated on that path too. That broke model-agreement AND one-pass
  //    convergence. Production reaches this state: reconcile()
  //    (server/src/canvas-v2/reconcile.ts) documents the window as open in its
  //    own "Absent-parent tolerance" note and has no second pass, and the
  //    concurrent-move case needs no mirror at all. NOT closed by bridge.ts's
  //    loadModel — that has only test callers.
  //
  // 2. PHYSICAL children that are NOT logical children: a real tree child of
  //    `n` whose data.parentId names something else. The reference does NOT
  //    rewrite their parentId, so this must not stamp `rescueTo` on them; it
  //    only lifts them clear of the cascade, the same way placeInTree parks a
  //    shape it cannot place. Dead-code safety — no public-API sequence is
  //    known to produce this state (every mutator that moves a node also
  //    writes data.parentId, and Loro resolves a concurrent move cycle to the
  //    tree ROOT, which is case 1's shape, not this one). Pinned white-box in
  //    repair.test.ts, like the hand-built plans that pin repair()'s other
  //    unreachable guards.
  //
  // The two are order-independent with respect to EACH OTHER — the physical
  // loop lifts every remaining tree child clear whatever the logical pass did
  // — so only their joint position BEFORE deleteNode is load-bearing. Keeping
  // both in this one method is what makes that impossible to separate.
  private dropShapeRescuingChildren(id: string, rescueTo: string, logicalChildIds: readonly string[]): void {
    // Sorted so the SEQUENCE of Loro ops emitted is a function of converged
    // data (ids) rather than of listShapes() traversal order, an undocumented
    // Loro internal — the standing purity mandate canonicalPageId exists for.
    // No test can observe this (every child gets identical treatment and the
    // comparisons all sort by id); it is kept because the mandate is on the
    // code. `id` itself may appear here if the shape self-parents: harmless,
    // it is restamped and then removed by the loop below, and the reference
    // drops it too.
    for (const childId of [...logicalChildIds].sort()) {
      for (const c of this.nodesByShapeId(childId)) {
        this.tree.move(c.id, undefined) // rescueTo is a page ⇒ the Loro tree root
        c.data.set('parentId', rescueTo)
      }
    }
    for (const n of this.nodesByShapeId(id)) {
      // Whatever is STILL a physical child is split-brain residue — the
      // logical children were lifted out above — so lift it clear of the
      // cascade WITHOUT touching data.parentId (case 2 above).
      // The [...] copy is defensive only: probed, n.children() hands back a
      // fresh array of freshly-constructed wrappers, so moving during
      // iteration does not disturb it. Kept because that is an undocumented
      // Loro internal, not a contract.
      for (const c of [...(n.children() ?? [])]) this.tree.move(c.id, undefined)
      this.deleteNode(n)
    }
  }
```

### Step 6: Correct the two comments this makes false

**(6a) `canvas-doc/src/loro-canvas-doc.ts`, in `placeInTree`.** This line makes
a claim that is false in production — `loadModel` has only test callers
(`grep -rn loadModel --include="*.ts"` to confirm before and after):

```ts
  // retained and a later reparent pass (see bridge.ts loadModel) fixes placement.
```

Replace with:

```ts
  // retained, and the shape stays logically parented: repair() rescues by
  // STORED parentId (see dropShapeRescuingChildren), so a shape sitting in
  // this window is still found when its logical parent is dropped, and
  // reparentToRoot still finds it if that parent never arrives. NOT via
  // bridge.ts's loadModel, which has only test callers.
```

**(6b) `canvas-model/src/repair.ts`.** This comment inside
`applyRepairToModel` asserts the divergence still exists, which is exactly what
this task removes:

```ts
    // LOGICAL rescue (drop.has(s.parentId)) vs loro-canvas-doc.ts's PHYSICAL
    // rescue (n.children()) — they diverge when a shape sits in placeInTree's
    // bulk-load window; see dropNodeRescuingChildren's docblock there.
```

Replace with:

```ts
    // LOGICAL rescue, keyed on the STORED parentId. loro-canvas-doc.ts's
    // dropShapeRescuingChildren mirrors this exactly; it ALSO lifts any
    // merely-physical tree child clear of Loro's delete cascade, which is
    // invisible here because dropping is a filter over a flat array.
```

### Step 7: Run everything

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair.test.ts; echo "EXIT=$?"
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun canvas-doc/src/repair-cost.test.ts; echo "EXIT=$?"
```

Expected: `ok: repair (doc)` / `EXIT=0`, and `ok: repair-cost` / `EXIT=0` with
the `tree.nodes()` line reading `clean(0-op plan)=1, dirty(500-op plan)=2` —
**unchanged from before your edit**. If the dirty count moved, you built the
index in the loop; go back to step 3.

Then the full sweep. `canvas-doc/test.ts` exits on the FIRST failing suite and
silently leaves later suites **unrun**, so run the files directly:

```
cd /home/stag/src/projects/ensembleworks && for f in canvas-doc/src/*.test.ts canvas-sync/src/*.test.ts server/src/canvas-v2/*.test.ts; do printf '%-52s ' "$f"; ~/.bun/bin/bun "$f" >/tmp/o 2>&1 && tail -1 /tmp/o || echo FAIL; done
cd /home/stag/src/projects/ensembleworks/canvas-model && ~/.bun/bin/bun test.ts; echo "EXIT=$?"
cd /home/stag/src/projects/ensembleworks && bun run typecheck; echo "EXIT=$?"
```

All green — **zero existing assertions change value**. The only full-suite
failure is the pre-existing `scripts/ux-contract-presence.test.ts` gate
described under "Measured blast radius"; confirm it fails identically on a
stashed tree before attributing it to yourself.

### Step 8: Clean-room check

`canvas-model` and `canvas-doc` are clean-room. Grep your diff — **including
comments, and as substrings of longer words** (`unexpressible` contains
`express`; a planner caught itself writing "cannot express" while drafting this
very section):

```
cd /home/stag/src/projects/ensembleworks && git diff -- canvas-doc canvas-model | grep -nE "from 'ws'|express|@tldraw/|\.\./server|Date\.now\(|Math\.random\("
```

Expected: **no output**. (The docblock in step 5 names
`server/src/canvas-v2/reconcile.ts` as a cross-reference; that is a path
mention, not an import, and matches the precedent already in this file at
`933314e`. It does not match any pattern above.)

### Step 9: Commit

```bash
git add canvas-doc/src/loro-canvas-doc.ts canvas-doc/src/repair.test.ts canvas-model/src/repair.ts
git commit -m "fix(canvas-doc): repair() rescues LOGICAL children, not just physical ones"
```

The commit message body must carry **both** verbatim REDs from step 2 and the
`repair-cost` before/after numbers.

### How each claim in this section was checked

| Claim | How |
|---|---|
| the divergence reproduces exactly as stated | wrote a throwaway probe against `933314e`, ran it, pasted its stdout verbatim; probe deleted afterwards |
| it is pre-existing, byte-identical at `5685c18` | `git worktree add` at `5685c18`, `bun install`, ran the same probe — identical stdout; then read that commit's `repair()` and confirmed `dropAll` fed only the skip-set and binding sweep while removal was a physical `deleteNode` cascade |
| "the old cascade diverged in the other direction" is wrong | same run — the outcome was identical, so the divergence ran in the same direction |
| `loadModel` has no production caller | `grep -rn loadModel --include="*.ts"` — definition, two test files, three comments |
| `reconcile()`'s window is open and unclosed | read `server/src/canvas-v2/reconcile.ts` end to end; quoted its docblock; confirmed no second reparent pass in the body |
| sync reaches the state without `reconcile()` | two-peer probe: concurrent `reparent(c,p1)` / `reparent(p1,c)`, printed tree-parent vs `data.parentId` on both peers |
| the mirror-image (physical-only) case is not publicly reachable | three two-peer probes (reparent/reparent, reparent/putShape, delete/move); none produced it, and Loro parked the cycle loser at the ROOT |
| every mutant M1–M8 is killed (or is not) by the named assertion | applied each to the source in turn, ran `repair.test.ts` and `repair-cost.test.ts`, recorded the first failure verbatim; M8 exited 0 on both plus `convergence.test.ts`, and is recorded unkillable |
| the cost table and the `tree.nodes()` counts | ran `repair-cost.test.ts` with the fix, then `git stash push` on the one source file and ran it again |
| zero existing assertions change value | ran every file in `canvas-doc`, `canvas-model`, `canvas-sync` and `server/src/canvas-v2` directly with the fix applied — all green |
| `scripts/ux-contract-presence.test.ts` fails pre-existing | ran it on a fully restored, `git status`-clean tree at `933314e` |
| the tree was restored | `git checkout --` on both source files, probe files deleted, temp worktree removed, `git status --porcelain` empty |

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

Two clauses in `repair()`'s JSDoc still describe the pre-Task-5 `dropShape`
subtree cascade, which no longer exists. Leaving them is worse than no comment.
This task is **comment-only** — no test, no RED. Its teeth (Step 4) are: after
the edits, the `cascade` grep must find ZERO surviving hit that describes a
`dropShape` cascade, and every replacement sentence must be verified true
against `canvas-model/src/repair.ts`.

> **Re-anchor by QUOTING, never by line number.** This file has moved twice
> since this task was drafted; the line numbers the original draft cited
> (`~74-89`, `~35`) were already wrong at audit time and are wrong again now.
> Find each block by its quoted text with `grep -n`, edit that.

**Files:**
- Modify: `canvas-doc/src/canvas-doc.ts` — `repair()` JSDoc (TWO clauses) and
  `deleteShape()` JSDoc (one added sentence).
- Do **NOT** touch `canvas-doc/src/loro-canvas-doc.ts`. The original draft
  listed it ("`deleteNode` comment if it overclaims"). Verified 2026-07-21: it
  does not overclaim — every `cascade` mention in it describes `deleteShape`'s
  genuine real-tree cascade (`:58,59,320,502`), the rescue lifting children
  *clear* of that cascade (`:532,562`), the dedupe loser's own delete
  (`:374,385,400`), the stale-parent split-brain note (`:128`), or explicitly
  affirms that drops **no longer** cascade (`:658`). All correct — leave them.

**Step 1: Verify the premise still holds, then locate the first stale clause**

```
cd /home/stag/src/projects/ensembleworks && grep -n "cascades to their subtree" canvas-doc/src/canvas-doc.ts
```

Expected: one hit inside `repair()`'s JSDoc reading (verbatim on disk today):

```
   * canonicalPageId), delete dangling bindings, drop shapes with invalid
   * props (cascades to their subtree AND to bindings whose endpoint drops in
   * the same pass). Pure function of the converged model, so every peer that
```

If this text is already gone, a prior task fixed it — STOP and report which,
then narrow this task to whatever remains.

**Step 2: Replace the WHOLE `repair()` JSDoc body with the accurate version**

The correct behaviour (verified against `canvas-model/src/repair.ts:8-14`,
`60-118`, `211-243` on 2026-07-21) is: drop **only** the named shape, never its
subtree; rescue each LOGICAL child (stored `parentId` names the dropped shape)
to the root of the page the dropped shape was already on — its `pageAncestorId`
(owner ruling 11: a rescued child may shift position but must not change page),
falling back to the canonical page **only** when that ancestor chain dead-ends
or cycles; ALSO lift each merely-PHYSICAL tree child clear of Loro's delete
cascade (Task 6A — the reference is a flat-array filter so this half is
invisible there, but `loro-canvas-doc.ts`'s `dropShapeRescuingChildren` does
both); and sweep any binding whose endpoint was dropped in the same pass (still
true — `repair.ts:238-242`). The second stale clause ("removed only via
cascade … not itemized") is also wrong: nothing is removed via a `dropShape`
cascade anymore. Replace the block bounded by `/**` … `*/` immediately above
`repair(): RepairOp[]` with EXACTLY:

```
  /**
   * Compute the deterministic repairPlan (canvas-model) from this doc's own
   * converged state and apply it: reparent orphans/cycle members to the
   * canonical page root (lexicographically smallest page id — see
   * canonicalPageId), delete dangling bindings, and drop shapes with invalid
   * props — removing ONLY the offending shape, never its subtree (one bad prop
   * must not execute a container's innocent contents, and Loro tombstones make
   * that loss unrecoverable). Each child of a dropped shape is rescued, not
   * deleted: a LOGICAL child (its stored parentId names the dropped shape) is
   * rehomed to the root of the page the dropped shape was already on — its
   * pageAncestorId, falling back to the canonical page ONLY when that chain
   * dead-ends or cycles (owner ruling 11: a rescued child may shift position
   * but must not change page) — and a merely-PHYSICAL tree child is lifted
   * clear of Loro's delete cascade the same way. A binding whose endpoint is a
   * dropped shape dies in the same pass (it is not dangling when the plan is
   * computed, so no deleteBinding op names it — sweeping it here is what lets
   * ONE pass converge). Pure function of the converged model, so every peer
   * that calls repair() on the same state computes and applies the identical
   * plan — no coordination needed. Idempotent: calling repair() again on an
   * already-clean doc returns []. Zero-page docs: orphans are unrepairable (no
   * target page) — the violation is left standing rather than looping on a
   * non-converging op; dropShape is suppressed by the same rule, so a childless
   * invalid shape stays invalid until a page exists. The returned array is the
   * plan as computed, not a full change log — the bindings swept because an
   * endpoint dropped, and the children rehomed off a dropped parent, are side
   * effects of the dropShape ops and are not themselves itemized. Caller must
   * commit() after to persist.
   */
```

**Step 3: Add the clarifying sentence to `deleteShape()`'s JSDoc**

```
cd /home/stag/src/projects/ensembleworks && grep -n "entire subtree in the real Loro tree" canvas-doc/src/canvas-doc.ts
```

`deleteShape`'s cascade is **still true and must remain true** — a user deleting
a frame does mean to delete its contents. Do NOT change the existing text; add
one paragraph inside the same JSDoc so the asymmetry with `repair()` is not read
as a bug. Replace the block bounded by `/**` … `*/` immediately above
`deleteShape(id: string): void` with EXACTLY:

```
  /**
   * Silent no-op if no shape with this id exists. Cascades: deletes the shape's
   * entire subtree in the real Loro tree — any shape whose ancestry passes
   * through `id` (e.g. a frame's children) is deleted too, and every deleted
   * shape's text container is cleared (no resurrection if the id is reused).
   *
   * This cascade is intentional and unchanged: an EXPLICIT delete means to take
   * the contents — deleting a frame deletes what is in it. It is NOT the
   * behaviour repair() dropped; repair()'s automatic response to an invalid
   * prop removes only the offending shape and rescues its children. The
   * asymmetry between the two is deliberate, not a bug.
   */
```

**Step 4: Teeth — verify no stale `dropShape`-cascade claim survives**

Run the brief's exact grep (this one INCLUDES test files, on purpose):

```
cd /home/stag/src/projects/ensembleworks && grep -rn cascade canvas-doc/src canvas-model/src --include="*.ts"
```

Every remaining hit MUST describe one of: `deleteShape`'s genuine cascade; the
rescue lifting children *clear* of that cascade; the dedupe loser's own delete;
or an explicit statement that drops **no longer** cascade. The full expected
keep-list on the current tree (verified 2026-07-21) is
`canvas-doc/src/canvas-doc.ts` — **zero** hits after this task (both stale
clauses gone); `loro-canvas-doc.ts:58,59,128,320,374,385,400,502,532,562,658`
(all KEEP — deleteShape/rescue/dedupe/affirmation); `canvas-model/src/repair.ts:10`
("Deliberately NOT a subtree cascade" — KEEP, correct) and `:233`
("physical tree child clear of Loro's delete cascade" — KEEP); and the test
files (`repair.test.ts`, `crud.test.ts`, `text.test.ts`, `node-index.test.ts`,
`serialization-seam.test.ts`, `canvas-model/src/repair.test.ts`) which all
describe the delete cascade or the rescue, never a live `dropShape` cascade —
KEEP. If ANY hit still asserts a `dropShape`/`repair()` subtree cascade as
current behaviour, fix it. Also confirm zero hits for the removed symbol:

```
cd /home/stag/src/projects/ensembleworks && grep -rn cascadeDropSet --include="*.ts" .
```

Expected: no output (it was deleted in Task 6).

**Step 5: Commit**

```
cd /home/stag/src/projects/ensembleworks
git add canvas-doc/src/canvas-doc.ts
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
> twice — `scripts/ux-contract-presence.test.ts` and
> `scripts/exposure-audit.test.ts` (note the `.test.ts` — there is NO
> `scripts/exposure-audit.ts`; that file's own header even records it was named
> `.test.ts` "not the plan's literal `.ts` sketch name". This plan repeated the
> same slip; the correct sibling to read is `scripts/exposure-audit.test.ts`).
> Read `ux-contract-presence.test.ts` first: note the `.test.ts` suffix (so
> `scripts/run-tests.ts` picks it up via its `scripts/*.test.ts` glob), the
> exported **pure decision function** unit-tested with synthetic inputs, and the
> real-repo scan (`exposure-audit.test.ts` uses `Glob` + `readFileSync`, not
> `git grep` — mirror that). The new file MUST itself be named `.test.ts`, not a
> bare `.ts`, for the same glob reason.

> **The runner glob, quoted from the current tree** (`scripts/run-tests.ts:25`,
> verified 2026-07-21):
> ```ts
> const globs = ['**/src/**/*.test.ts', 'scripts/*.test.ts', 'e2e/lib/*.test.ts', 'bin/*.test.ts']
> ```
> `scripts/put-shape-unchecked-audit.test.ts` matches `scripts/*.test.ts`, so it
> runs under `bun run test` in CI. A bare `.ts` would match NONE of these and
> silently never run.

**Step 1: Write the gate**

The complete ALLOWED list, enumerated from `git grep -l putShapeUnchecked` on
the current tree (verified 2026-07-21 — this is the CRITICAL fix: the original
draft's list omitted `serialization-seam.test.ts` and `reconcile.test.ts`,
which would make Step 3 fail on the real tree). Today's referencing files:
`canvas-doc/src/loro-canvas-doc.ts` (the declaration — ALLOWED),
`canvas-doc/src/repair.test.ts` (ALLOWED), `canvas-doc/src/repair-cost.test.ts`
(ALLOWED), `canvas-doc/src/write-validation.test.ts` (ALLOWED),
`canvas-doc/src/serialization-seam.test.ts` (ALLOWED — hostile-state
construction, added since the draft), `server/src/canvas-v2/reconcile.test.ts`
(ALLOWED — a comment in a test, added since the draft), and
`docs/plans/2026-07-19-v2-write-path-validation.md` (this very plan — **NOT**
allowlisted; excluded structurally, see below). Re-run `git grep -l
putShapeUnchecked` yourself before writing the list; if Task 5/6/7 rework since
2026-07-21 added or removed a referencing CODE file, adjust ALLOWED to match —
the list must equal the real tree or Step 3's "pass" is a lie.

> **Markdown exclusion (finding 3).** `git grep -l` returns this plan `.md`
> because it names the token dozens of times. The gate MUST NOT match it. The
> mechanism: the real scan globs `**/*.{ts,tsx}` only — the `.md` extension
> never matches — and additionally skips any path under `docs/` and
> `node_modules`/`dist` belt-and-suspenders. The exported pure function operates
> only on paths the scan already collected, so its contract never sees markdown.

Complete file (paste verbatim; `scripts/` is NOT clean-room, so `from 'bun'`,
relative URLs, etc. are all fine here):

```ts
// Run: bun scripts/put-shape-unchecked-audit.test.ts
//
// CI gate (review finding 5). LoroCanvasDoc.putShapeUnchecked bypasses the
// write boundary: it writes a shape validateShape rejects — precisely the
// state repair() is obliged to destroy. It exists ONLY so tests and
// hostile-state rigs can construct what a remote peer's bytes can deliver.
// Keeping it off the CanvasDoc interface is a signal, not a barrier:
// SyncServerPeer.doc / SyncClientPeer.doc / ShadowMirror.doc and reconcile()'s
// parameter are all typed as the CONCRETE LoroCanvasDoc, so anyone typing
// `peer.doc.` gets it in autocomplete. reconcile.ts is exactly where a
// developer chasing a non-converging shadow tick would reach for it — which
// would restore the data-loss path this branch closed. This gate is that
// barrier. Adding an entry to ALLOWED is a deliberate, reviewable act; it must
// never be done to turn a red gate green.
//
// Named `.test.ts` (not a bare `.ts`) so scripts/run-tests.ts globs it via
// `scripts/*.test.ts` — same trick as exposure-audit.test.ts and
// ux-contract-presence.test.ts (see their headers). Structure mirrors
// ux-contract-presence.test.ts: a PURE decision function unit-tested with
// synthetic inputs, then a real-tree scan that reads files off disk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'

// The ONLY files allowed to name putShapeUnchecked, repo-relative with forward
// slashes — the EXACT form Glob.scan yields below. A path-form mismatch would
// silently make an allowed file look disallowed. Every entry is a test or the
// declaration itself. Verified against `git grep -l putShapeUnchecked`,
// 2026-07-21.
const ALLOWED: readonly string[] = [
  'canvas-doc/src/loro-canvas-doc.ts',          // the declaration itself
  'canvas-doc/src/repair.test.ts',
  'canvas-doc/src/repair-cost.test.ts',
  'canvas-doc/src/write-validation.test.ts',
  'canvas-doc/src/serialization-seam.test.ts',
  'server/src/canvas-v2/reconcile.test.ts',
  'scripts/put-shape-unchecked-audit.test.ts',  // this gate
]

/** Pure: given the repo-relative paths that CONTAIN the token, return the ones
 * NOT on the allowlist (the violations), sorted. Operates only on paths the
 * caller already collected; the caller globs *.{ts,tsx} and skips docs/, so
 * this plan's own .md — which names the token dozens of times — never reaches
 * this function. */
export function disallowedUsages(hits: readonly string[]): string[] {
  const allow = new Set(ALLOWED)
  return hits.filter((f) => !allow.has(f)).sort((a, b) => a.localeCompare(b))
}

// ---- Synthetic self-tests: the teeth that bite even when the real tree is
// all-green. A gate that has only ever seen a green tree is untested; these
// prove disallowedUsages actually distinguishes allowed from disallowed. ----
assert.deepEqual(disallowedUsages([]), [], 'empty hit list -> no violations')
assert.deepEqual(
  disallowedUsages(['canvas-doc/src/repair.test.ts', 'canvas-doc/src/loro-canvas-doc.ts']),
  [],
  'allowlisted paths only -> no violations',
)
assert.deepEqual(
  disallowedUsages(['server/src/canvas-v2/reconcile.ts']),
  ['server/src/canvas-v2/reconcile.ts'],
  'a non-allowlisted code file is a violation',
)
assert.deepEqual(
  disallowedUsages(['canvas-doc/src/repair.test.ts', 'server/src/canvas-v2/reconcile.ts', 'client/src/foo.ts']),
  ['client/src/foo.ts', 'server/src/canvas-v2/reconcile.ts'],
  'mixed input returns only the disallowed paths, sorted',
)
console.log('ok: put-shape-unchecked-audit -- disallowedUsages self-tests')

// ---- Real-tree scan. Globs CODE files only (*.{ts,tsx}); markdown — incl.
// this plan — is excluded structurally by the extension, and docs/,
// node_modules, dist are skipped belt-and-suspenders. ----
const repoRoot = new URL('../', import.meta.url)
const glob = new Glob('**/*.{ts,tsx}')
const hits: string[] = []
let scanned = 0
for await (const f of glob.scan({ cwd: repoRoot.pathname, onlyFiles: true })) {
  if (f.includes('node_modules') || f.includes('/dist/') || f.startsWith('dist/') || f.startsWith('docs/')) continue
  scanned++
  if (readFileSync(new URL(f, repoRoot), 'utf8').includes('putShapeUnchecked')) hits.push(f)
}
// Positive controls: if the scan finds nothing or misses the declaration site,
// it is BROKEN (glob/cwd/token wrong), not genuinely green — fail loudly
// rather than pass vacuously.
assert.ok(scanned > 100, `sanity: scanned suspiciously few .ts/.tsx files (${scanned}) -- glob/cwd likely broken`)
assert.ok(
  hits.includes('canvas-doc/src/loro-canvas-doc.ts'),
  'positive control: the declaration site must appear in the scan, else it is not actually finding the token',
)

const violations = disallowedUsages(hits)
assert.deepEqual(
  violations,
  [],
  `putShapeUnchecked is referenced outside the allowlist: ${violations.join(', ')}. ` +
    `It bypasses the write boundary repair() enforces; it belongs only in tests and the ` +
    `declaration. If a new use is genuinely legitimate, add it to ALLOWED as a deliberate, ` +
    `reviewed act -- never to silence this gate.`,
)
console.log(`ok: put-shape-unchecked-audit -- ${hits.length} referencing file(s), all allowlisted (scanned ${scanned})`)
```

**Step 2: Run it to verify it FAILS (the real RED)**

The gate is green-by-construction on a correct tree, so the RED must be
manufactured: temporarily add a `putShapeUnchecked` mention to a non-allowlisted
CODE file. Use `server/src/canvas-v2/reconcile.ts` (the non-test module — its
`.test.ts` sibling is allowlisted, so the mention must go in the module, not the
test). A single scratch **comment line** is enough (the gate is a text scan, not
a compile) and won't perturb the server build:

```
cd /home/stag/src/projects/ensembleworks
# add, as a scratch line anywhere in server/src/canvas-v2/reconcile.ts:
#   // putShapeUnchecked  <- scratch RED, delete me
~/.bun/bin/bun scripts/put-shape-unchecked-audit.test.ts; echo "exit=$?"
```

Expected: the final `assert.deepEqual(violations, [], …)` fails, its message
naming `server/src/canvas-v2/reconcile.ts`, and `exit=1`.

> **This must be a REAL red, not a FAKE one.** A fake red here is a module-load
> error: if you mistype the `import` of `Glob`/`readFileSync`, or rename
> `disallowedUsages`, the file throws at load and you get a stack trace, NOT the
> `violations` assertion naming reconcile.ts. That has been mistaken for a
> passing gate three times on this branch. The RED is only valid if the failure
> is the `deepEqual` message listing the scratch file. Also confirm the
> synthetic self-tests still printed their `ok:` line before the real-scan
> failure — that proves the pure function loaded and ran.

**Record the verbatim output, then DELETE the scratch line.**

**Step 3: Confirm it passes on the real tree**

```
cd /home/stag/src/projects/ensembleworks && ~/.bun/bin/bun scripts/put-shape-unchecked-audit.test.ts; echo "exit=$?"
```

Expected: `exit=0`; the `ok:` lines print, the final one reporting the referencing
file count (7 today) all allowlisted. If it names a violation, the ALLOWED list
does not match the current tree — reconcile the list against `git grep -l
putShapeUnchecked`, do NOT widen it reflexively.

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
2. **This branch's own.** Task 4A edits `DevOverlay.tsx`, `CanvasV2App.tsx`
   and `DevOverlay.test.ts` under the same prefix, to surface
   `invalidWriteCount`. Owner-approved
   2026-07-20 on the grounds that the marker was needed anyway — but it is our
   change and the marker says so.

The PR must include, verbatim:

```
ux-contract: none — <three reasons: 1-2 this branch's own, 3 inherited from PR 48>

1. This branch's core change is confined to canvas-model (repair/invariants),
   canvas-doc (the CRDT write boundary) and canvas-sync (forwarding the
   invalid-write sink). None is an interaction surface: no tool FSM, no
   renderer, no input handling.

2. This branch DOES touch client/src/canvas-v2/ in three places of its own —
   DevOverlay.tsx, CanvasV2App.tsx and DevOverlay.test.ts — to render the
   invalidWriteCount telemetry field added by Task 4A, and to update the
   fixtures that must account for it. That is a read-only diagnostic readout
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
