# UX Interaction Contracts — generic harness + process (design)

**Date:** 2026-07-16
**Status:** Validated with owner (brainstorming session); not yet implemented.
**Context:** QA on the v2 canvas found five usability issues. An audit of PR 47
(canvas-phase4, fe9beb1) confirmed none are fixed and — more importantly — that
no existing harness *could* catch them: every Phase-4 harness asserts rendering
output (parity, goldens), performance timings (perf rig), or CRDT convergence
(convergence/fuzz/soak). None asserts what an interaction *feels* like while it
is happening. Rather than build bespoke rigs per bug class, this design adds a
**generic harness plus a development-process rule** so that specific checks come
into existence as a byproduct of normal work.

## The five findings that motivated this (for the record)

1. **Drag-while-typing** — no `editingId` guard anywhere on the pointer path
   (select FSM, TextEditor, CanvasV2App all pass pointer events through).
2. **No single-editor limit** — `editingId` is per-client view state; the
   presence payload has no editing field; concurrent `setText` is a documented
   LWW stomp.
3. **Cross-widget native text selection** — no `user-select: none` in
   canvas-react; Viewport never `preventDefault`s pointerdown.
4. **Inverted scroll** — `applyWheel` pans `camera + delta` where the render
   transform is `screen = (world + camera)·z`, so wheel-down moves content
   down. `camera.test.ts` pins the wrong convention.
5. **Fast-drag desync** — two real mechanisms: per-move snap offsets accumulate
   (incremental delta from `lastScreen` is never re-anchored to
   grab-offset + cursor), and mid-drag wheel/`SetCamera` reinterprets the
   stored screen anchor under the new camera. `transform.ts` recomputes
   absolutely from gesture-start anchors and is immune — that is the fix
   pattern.

## Decisions (settled in the design session)

| Question | Decision |
| --- | --- |
| What triggers authoring a specific check? | **Every unit of work** — the SDD unit spec must declare its interaction contract (or explicitly claim none). |
| Headless vs. real browser? | **One vocabulary, two runners** — each contract is tagged with the cheapest level that can falsify it. |
| Enforcement? | **Review gate + CI presence check** — review judges substance; a mechanical check guarantees the declaration (or opt-out) exists. |
| Bootstrap? | **The five QA fixes are the pilot units** — the substrate is debugged on real work before the mandate lands. |

## The substrate: interaction contracts as data

A contract is a declaration, not a test file:

```ts
{
  name: 'drag-cursor-lock',
  gesture: (g) => g.down(onShape).moveBy(seeded(...)).up(),  // seeded generator
  invariant: (obs) => obs.shapeDisplacement().equals(obs.cursorWorldDisplacement(), ε),
  when: 'every-event',          // or 'at-end'
  level: 'fsm',                 // cheapest falsifying level: 'fsm' | 'browser'
  scope: 'per-kind',            // optional: instantiate per registered shape kind
}
```

Three properties make it generic:

- **Gestures are seeded generators.** One declaration yields a fixed smoke case
  in CI and a fuzz campaign when run wide.
- **Invariants are written against an observation interface (`obs`)**, never
  against FSM internals or DOM nodes — that is what lets one declaration run at
  either level. `obs` exposes only user-meaningful observations:
  `cursorWorldDisplacement()`, `shapeDisplacement(id)`, `visibleWorldRect()`,
  `textSelectionSpans()`, `editingShape()`, …
- **`scope: 'per-kind'` subsumes the conformance-suite idea.** A contract so
  scoped is instantiated automatically for every entry in the shape registry;
  a future widget inherits the whole standing library at registration.

Contracts live in one pure, dependency-free module (it imports nothing; both
runners import it — respecting the clean-room boundary). The contract library
*is* the project's accumulated UX knowledge; there is no separate "tier 1" or
"tier 2" harness — those are what the library looks like after units have
flowed through it.

## Two runners

**FSM runner** (beside the existing `script()` rig in canvas-editor's test
infra). Plays the gesture through the real `Editor` + tool FSMs with the
injected clock/PRNG; evaluates the invariant after every event; deterministic
and fast enough for seeded fuzz per commit. Adapter answers `obs` from editor
state and doc geometry.

**Browser runner** (in `e2e/lib`, beside the parity harness). Interprets the
*same* gesture script into real Playwright pointer/wheel/keyboard input against
a live room. `when: 'every-event'` becomes a per-rAF sampler, so invariants
hold mid-gesture. Adapter answers `obs` from the page (bounding boxes,
`window.getSelection()`, focus). Runs in the e2e lane; only browser-tagged
contracts pay this cost.

**Multi-client is vocabulary, not a third runner.** Gesture scripts gain actors
(`g.as('A').down(...)`, `g.as('B').type(...)`); the browser runner provisions
one browser context per named actor joined to the same room (the two-context
plumbing already exists in `canvas-v2.spec.ts`); invariants name their
observation point (`obs.on('B').…`). Use the fewest actors that can falsify the
invariant. Deferred optimization: protocol-level concurrency contracts could
later get an FSM variant over the in-memory transport the convergence rig uses
— only if a contract actually hurts in the e2e lane.

## Process wiring

- **Spec template.** Every unit spec gains a mandatory **Interaction Contract**
  section with exactly two legal forms: contract declarations (name, gesture
  sketch, invariant in prose + `obs` expression, level, scope), or
  `No interaction surface — <one-line justification>`. Silence means the spec
  is incomplete.
- **Review gate.** Spec review judges substance (does the invariant express
  what a user would feel, at the right level/scope, falsifiable before the
  fix?). Quality review verifies the contract ran red before the
  implementation turned it green — the existing TDD discipline applied to
  contracts.
- **CI presence check.** A script in the `exposure-audit.ts` family: a diff
  touching interaction-bearing paths (`canvas-editor/src/tools/`,
  `canvas-react/src/`, `client/src/canvas-v2/` input/tool files) must also
  touch the contracts module or carry the marker
  `ux-contract: none — <reason>` in the PR body. CI checks presence only;
  review owns meaning. Every opt-out is a searchable, attributable record.

## Bootstrap: five pilot units, in this order

Build the minimal FSM runner + contract module first; the browser runner is
built when pilot 3 forces it.

1. **Scroll direction** — semantic invariant ("wheel-down reveals content
   below"), trivial sign-flip fix (plus updating `camera.test.ts`, which pins
   the inverted convention). Calibrates the vocabulary.
2. **Drag desync** — the fuzz generator earns its keep; fix is porting
   translate to `transform.ts`'s absolute-anchor pattern (and gating mid-drag
   `SetCamera` or re-anchoring on camera change).
3. **Cross-widget text selection** — first browser-tagged contract; forces the
   browser runner into existence. Fix: `user-select: none` on static shape
   bodies + pointerdown `preventDefault`.
4. **Drag-while-typing** — modality-exclusivity invariant
   (`editingShape() ≠ null ⇒ no translate of that shape`). Fix: `editingId`
   gate on the pointer path.
5. **Editing lock** — first multi-actor contract. **Preceded by a product
   decision** (presence-based "someone is editing" indicator vs. hard lock),
   which its unit spec must record; requires adding an editing field to the
   presence payload.

After the pilots: the mandate lands in CLAUDE.md and the CI presence check
turns on.

## Out of scope / deferred

- Rich-text / per-character CRDT merge for concurrent editing (separate,
  already-deferred workstream; the lock/indicator in pilot 5 is the v1
  answer).
- FSM-level multi-actor runner (see above — build on demonstrated need).
- Retrofitting contracts onto already-shipped Phase-4 behavior beyond the five
  pilots; the library grows per unit from here.
