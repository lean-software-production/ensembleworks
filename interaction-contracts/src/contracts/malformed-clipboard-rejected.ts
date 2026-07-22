// Task K3 (docs/plans/2026-07-22-canvas-v2-copy-paste.md) — "THE
// THROUGH-LINE": the end-to-end security characterization for D-2's
// two-layer paste validation. Pre-seeds the OS clipboard (Task H1's
// `Contract.clipboard` field) with a HOSTILE payload — a well-formed
// envelope (passes the `ensembleworks/clipboard: 1` marker check) whose one
// shape entry is junk (an unknown `kind`, so it fails `validateShape`'s
// `z.enum(SHAPE_KINDS)` check regardless of its other fields) — then presses
// Ctrl+V and asserts NOTHING was created: `shapeCount()` stays at the
// pre-paste 0, and the contract completing at all (no thrown page error, an
// Obs still answers afterward) is itself proof the paste path didn't crash
// or wedge on adversarial input.
//
// USING THE ENVELOPE FORM (not raw non-JSON garbage) is deliberate and is
// what makes this the STRONGEST version of the test: a non-JSON string or a
// wrong-marker object is rejected by decodeClipboard's FIRST two guards
// (JSON.parse try/catch, marker/version check) before any shape is even
// looked at — trivially defended, and it would not exercise the per-shape
// `validateShape` filter at all. This payload instead passes both of those
// guards and forces the per-shape filter to be what does the work.
//
// Browser-only, empty scene (Ctrl+V routes through
// CanvasV2App.tsx's `handleGlobalShortcut`, never a tool FSM — same as
// K1/K2 — and there is nothing to seed: a malformed paste must create
// nothing out of nothing).
//
// ============================================================================
// HONEST TEETH STORY (read before trusting this contract as "the" security
// proof — it deliberately is NOT):
//
// Because BOTH the pure `decodeClipboard` filter (canvas-model, Task C2)
// AND the doc-layer `putShape` write boundary (canvas-doc, defense in
// depth per D-2) independently reject this exact payload's junk-`kind`
// shape, this contract CANNOT be driven RED by disabling only one of the
// two gates — the other still catches it, and `shapeCount()` still reads 0.
// Verified live during K3's build: with `decodeClipboard`'s per-shape
// `validateShape` filter temporarily removed (the shape kept unconditionally
// instead of dropped), the hostile shape's `kind` ('ew-hostile-kind', not a
// member of `SHAPE_KINDS`) still gets emitted as a `CreateShape` intent, but
// `putShape` (canvas-doc/src/loro-canvas-doc.ts) re-runs `validateShape` at
// the write boundary and rejects it as a total no-op — `shapeCount()` stayed
// 0, this contract stayed GREEN, no RED was reachable that way. This is the
// CORRECT, intended behavior of defense-in-depth (a bug in layer 1 still
// cannot corrupt the doc, per D-2) — not a flaw in the contract, but it does
// mean this specific payload cannot demonstrate K3 has "teeth" via a
// single-gate revert.
//
// The plan's own risk note anticipated exactly this (D-2's note: "because
// BOTH layers reject junk, a naive K3 could be green from birth (a fake
// RED)"). The REAL, exhaustive adversarial coverage — the tests that DO go
// RED against an unwritten validator — lives in canvas-model's
// `clipboard.test.ts` (C2/C3's pure unit tests: malformed JSON, wrong
// marker/version, non-object, junk props, cyclic parentId, dangling
// binding). K3's job is narrower and still real: it proves the WIRING is
// live end-to-end — that a user pasting garbage through the actual
// Ctrl+V -> readClipboardText -> pasteIntents -> applyAll path sees nothing
// bad happen, in a real browser, not just in a unit test. Its genuine,
// reachable RED (verified live) is at the WIRING level: stubbing
// `decodeClipboard` to skip validation entirely is a `canvas-editor`
// clean-room source change this task does not make (canvas-editor's
// `pasteIntents` calls the real `decodeClipboard` unconditionally, with no
// injection seam for a partial stub) — so the wiring-level RED was instead
// reached by literally deleting the guard clause that calls
// `editor.applyAll(intents)` in `CanvasV2App.tsx`'s paste branch (making
// Ctrl+V a total no-op, identical in shape to K1/K2's teeth-check): with
// paste wired to do nothing at all, `shapeCount()` stays 0 — which is
// ALSO what this contract expects, so THAT revert produces no RED either
// (a no-op paste and a correctly-rejected hostile paste are
// observationally identical through `shapeCount()` alone). Do not read this
// contract as proof the malformed payload was ever actually decoded and
// rejected, rather than never having reached the decoder at all — see the
// unit tests above for that proof. This contract's honest claim is narrower:
// "pasting this hostile text through the real, live paste path never grows
// the doc and never crashes the page."
// ============================================================================
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

// A well-formed clipboard ENVELOPE (passes decodeClipboard's marker/version
// guard) whose one shape entry is junk: `kind` is not a member of
// SHAPE_KINDS (canvas-model/src/shape.ts), so `validateShape`'s
// `z.enum(SHAPE_KINDS)` check fails it regardless of any other field —
// props are ALSO junk (an object shape:'geo' would never carry) as a belt-
// and-suspenders second reason validateShape would reject it even if the
// kind enum ever grew to include this string. `bindings` carries a
// dangling binding (both endpoints reference the hostile shape's id, which
// never survives validateShape) so the binding-drop path is exercised too,
// per D-2's "each binding also has to structurally parse... and both
// endpoints resolve to a kept shape."
const HOSTILE_PAYLOAD = JSON.stringify({
  'ensembleworks/clipboard': 1,
  shapes: [
    {
      id: 'shape:hostile',
      kind: 'ew-hostile-kind',
      parentId: 'page:whatever',
      index: 'a1',
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { arbitraryHostileField: 'nope', anotherJunkField: 42 },
    },
  ],
  bindings: [{ id: 'binding:hostile', fromId: 'shape:hostile', toId: 'shape:hostile', props: {}, meta: {} }],
})

export const malformedClipboardRejected: Contract = {
  name: 'malformed-clipboard-rejected',
  level: 'browser',
  tool: 'select',
  when: 'at-end',
  // Nothing seeded — a malformed paste must create something out of
  // nothing to fail this contract; there is no pre-existing shape to
  // confuse the count.
  scene: () => [],
  // Pre-seed the OS clipboard with the hostile envelope BEFORE the gesture
  // runs (Task H1: the runner writes this via `navigator.clipboard.writeText`
  // ahead of `contract.gesture`'s ops).
  clipboard: (_rng: Rng): string => HOSTILE_PAYLOAD,
  gesture: (_rng: Rng): GestureOp[] => [{ kind: 'key', key: 'v', modifiers: { ctrl: true } }],
  check: (obs: Obs): string | null => {
    const count = obs.shapeCount()
    if (count !== 0) {
      return `expected shapeCount() === 0 after Ctrl+V with a hostile clipboard payload (nothing should be created), got ${count}`
    }
    return null
  },
}
