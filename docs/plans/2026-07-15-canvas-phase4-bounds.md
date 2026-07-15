# Canvas Phase 4 — scope bounds (2026-07-15)

**Status: DEFINITIVE. This document is the scope ceiling for the Phase-4
implementation plan (`2026-07-15-canvas-phase4-parity.md`). The planner must
not add work beyond it and must not drop work inside it without a recorded
owner decision.**

Phase-4 goal, verbatim from the product owner: **visible parity + stability —
the team can truly live in v2, and it stops looking like a wireframe.**

Sources of record:

- `docs/plans/2026-07-10-canvas-rewrite-design.md` (Phase 4 defined at
  "Parity burn-down"; Testing and Known-risks sections).
- `docs/plans/2026-07-12-canvas-phase3-editor-renderer.md` — the Phase-2→4
  carried table (Triage section), the ratified open-question verdicts
  (Q3/Q4/Q8–Q11/Q13), and the "Execution notes (2026-07-12, Phase 3)"
  section, which names every deferred item with its exact code location.
- Owner scope ruling of 2026-07-15 (the hard ceiling this document encodes).

One deviation from the design doc is deliberate and owner-decided: the design
doc's Phase 4 includes "agent writes cut over to v2." **The owner has
explicitly deferred that out of this phase** (see Out of scope).

---

## 1. In scope

### 1.1 Rich core-shape bodies (the wireframe fix)

Dedicated renderers for the four core tldraw kinds — **note/sticky, frame,
text, geo** — replacing the `canvas-react/src/shapes/BoxShape.tsx` fallback,
registered in `canvas-react/src/shapeRegistry.ts` the same way
`client/src/canvas-v2/shapes/index.ts` registers the six embeds.

- Read the model props tldraw v1 uses: sticky **color** (`withText`'s
  `color` in `canvas-model/src/shape.ts`), **author badge** (from shape
  `meta`), **handwriting font**, frame chrome + label, text styling, geo
  variants. Match v1 stickies visually — this is the acceptance bar, proven
  by the cross-renderer diff harness (§1.5).
- Keep the Phase-3 `getText` live-doc accessor path (`ShapeBodyProps.getText`
  threaded from `ShapeLayer`) — the new bodies must render live `LoroText`
  content, not only `props.richText` (the `SetText`-had-no-consumer bug from
  Phase 3's Unit 14 must stay fixed under the new bodies).
- New bodies live in `canvas-react/src/shapes/` (clean-room: no client,
  server, or tldraw imports; boundary tests must keep passing).

### 1.2 Delete

Wire the existing `DeleteShapes` intent (`canvas-editor/src/intents.ts:117`)
to the user: **selection + Delete/Backspace**. Today the only emitters are
the drag-abandonment paths in `client/src/canvas-v2/tool-loop.ts`
(`cancelActiveTool`); there is no keyboard binding anywhere in
`canvas-react/src` or `client/src/canvas-v2`. Delete must be suppressed while
text editing is active (TextEditor owns the keyboard then).

### 1.3 Embed shape-body write path

The Phase-3 "SHAPE-BODY WRITE PATH missing" deferral: design and land the
**dispatch channel** that lets the six ported embeds write props/presence
back, and use it to restore the three named dropped features:

- **terminal**: title rename + drag,
- **screenshare**: `stillUrl` stamp-back + aspect relock,
- **file-viewer**: rev-bump + peer-follow.

Named gaps are grep-confirmed in `client/src/canvas-v2/shapes/`
`{ScreenshareShape,FileViewerShape,presentStoreV2}.ts` and their tests; the
embeds are currently read-mostly against `ShapeBodyProps`. The channel is
defined on the clean-room side (canvas-react/canvas-editor surface, e.g. a
`dispatch` on `ShapeBodyProps`); the embed implementations consuming it stay
in `client/src/canvas-v2/shapes/`. Respect the `ShapeBody.tsx` MEMO STRATEGY
constraint (content-memo, not reference-memo) and the
`EphemeralStore` same-millisecond LWW hazard (single-write-publisher pattern,
`client/src/canvas-v2/presence.ts`) when embeds publish presence.

### 1.4 Plain-text editing polish (NOT rich text)

Bounded to: editing affordance parity for all text-capable kinds
(double-click to edit), TextEditor visual styling matching the new rich
bodies (font/size/color so the edit view doesn't "jump"), Enter/Escape
semantics, and caret/selection sanity. The storage primitive stays the flat
`LoroText` (`doc.getText('text:<id>')`); anything requiring the
`loro-prosemirror` `LoroMap`-tree redesign is out (see §2).

### 1.5 Cross-renderer visual-diff harness (NEW test infra — required)

The design doc's UI tier 3, not built yet: render the **same seeded room**
under v1 (tldraw) and v2, screenshot both, diff with per-feature masks and
tolerances, and report parity as a number per run. This is a core "make the
UI testable" deliverable and the acceptance mechanism for §1.1. It reuses
the e2e rig (see §5.1), not a new runner.

### 1.6 Performance gates — reuse, extend, re-calibrate

Reuse `e2e/perf/canvas-v2-perf.spec.ts`, `e2e/perf/perf.spec.ts`,
`e2e/lib/perf.ts`, `e2e/baselines/{tldraw,canvas-v2}-perf.json`,
`.github/workflows/canvas-v2-perf.yml`. Phase-3 execution notes name the
honest gaps to close:

- a **dense-seed scenario** (viewport culling made the spread-out pan/zoom
  scenario flat at every scale — it cannot demonstrate degradation),
- a **select-all @ 1k** scenario (the ~8.7 ms/render `Selection.tsx`
  watch-item),
- a **single-shape drag commit-cadence** micro-benchmark (the four-tool
  "COMMIT CADENCE WATCH-ITEM"),
- keep the gated **60 fps @ 1k** budget (ratified Q12); 5k/10k documented,
  not gated,
- entry-chunk size regression check against the ~215 kB / ~63 kB gzip
  Unit-12 baseline (new bodies must not bloat the bundle).

### 1.7 Multiplayer/stability gates — reuse, extend, re-calibrate

Reuse `canvas-sync/src/{convergence,fuzz,soak,soak-smoke}.test.ts`,
`canvas-sync/src/soak.ts` + `canvas-sync/soak-cli.ts`
(`@ensembleworks/canvas-sync/soak` subpath — do NOT re-export from the main
index; that regression is documented), `server/src/canvas-v2/`
`{soak-actor,crash-recovery,crash-writer}.ts` + `soak-actor-cli.ts`, and
`.github/workflows/canvas-soak.yml`. Phase-3 named calibration debts:

- **actor-soak RSS is under-verified beyond 15k ops**; `FLAT_RSS_TOLERANCE`
  (15x) was set with deliberate headroom. Re-verify at ≥20k ops and tighten
  to an empirically derived bound.
- Bounded-growth **K re-calibration** now that the actor-backed compacting
  soak exists (Phase-2 carried item).
- Extend the soak op mix to cover what Phase 4 adds: **deletes** and
  **embed write-path ops**, so the new write surfaces are converged and
  growth-bounded, not just unit-tested.

### 1.8 Straddlers ruled IN (see §3 for rationales)

Undo/redo (local), Escape-cancel of in-flight gestures, `pointercancel`
handling, transform cancel-revert, connection banner.

---

## 2. Out of scope (do not plan these)

| Item | Rationale |
|---|---|
| **Agent write-path v2 cutover** (old `/api` endpoints → shims; validating semantic write API) | Explicitly deferred by the owner on 2026-07-15, overriding the design doc's Phase-4 text. Agents keep writing via the tldraw path (ratified Q13 posture continues). |
| **Ink/draw/eraser/line/highlight tools** | Owner-deferred; `perfect-freehand` is heavy and not needed to live in v2 (ratified Q3 already deferred them once). |
| **Full rich text (`loro-prosemirror`)** | Preflight P3 verdict: requires redesigning `canvas-doc`'s per-shape text primitive from flat `LoroText` to a `LoroMap` document tree — its own project, owner-deferred. |
| **Multi-pointer / pointer-kind (touch/pen) support** | `dom-events.ts` is documented SINGLE-POINTER V1 SCOPE; real multi-touch is a subsystem. Only `pointercancel` (a stability bug in the single-pointer model) is in — see §3. |
| **SQLite `VACUUM` / `auto_vacuum` implementation** | Ruled OBSERVE (§3) — real cost of its own, no prod-observed harm yet at dogfood scale. |
| **`pendingImports` re-request protocol extension; reconnect since-acked-version delta; lossy-repair-edge fixes** | Ruled OBSERVE (§3) — Phase 3 built the dev-overlay instrumentation precisely so these are decided on data. |
| **v2 chrome shell / LiveKit spatial audio in v2 rooms** (`CanvasV2App.tsx` mounts only the canvas; v1 `<App/>` owns audio + chrome) | Not in the owner's ceiling. A known livability gap — **flag to the owner as a Phase-4.5/5 candidate**, but no work here without an explicit ceiling change. |
| **Collaborative/selective undo semantics** | Undo is ruled in as *local* undo only (§3); cross-peer selective undo is a research-grade extension. |
| **loro-crdt upgrade** | Standing freeze: fuzz corpus pin `malformedFrames=999/1000` is coupled to 1.13.6. |
| **Phase-5 items** (per-room migration tool, tldraw removal, `team`-room cutover) and Phase-1 standing deferrals (`zodInput` middleware, O(n²) clustering cap, run-tests halt-on-first) | Later phases / standing. The `team` hard-exclusion in `client/src/engine.ts` is untouchable this phase. |

---

## 3. Straddler rulings

Each ruled against the goal: *the team can truly live in v2 + stability.*

| # | Straddler | Ruling | Rationale |
|---|---|---|---|
| S1 | **Undo/redo stack** (canvas-editor has none) | **IN** | Non-negotiable table stakes — nobody "truly lives" in a canvas where a mis-drag or mis-delete is permanent; shipping Delete (§1.2) without undo would make v2 *more* dangerous, not more livable. Scope discipline: **local undo/redo only** (Ctrl+Z / Ctrl+Shift+Z), undoing this client's own ops, never remote peers' — the pinned loro-crdt 1.13.6 ships an `UndoManager` designed for exactly this local-ops-only semantic, so this is an integration, not a from-scratch subsystem. **Mandatory preflight probe** (Phase-3 P1–P3 style, verdict recorded in the plan doc): verify `UndoManager` in 1.13.6 works against `LoroCanvasDoc`'s movable tree + text containers; if the probe fails, fall back to an editor-level inverse-intent stack over the same keyboard surface — the *feature* is in scope either way, the mechanism is the probe's output. |
| S2 | **`pointercancel` handling** | **IN** | Stability bug in the *current* single-pointer model, not a touch feature: an OS-level cancellation strands a tool FSM mid-gesture with no terminating event (Phase-3 execution notes). Fix is small and prior-art-shaped — wire `onPointerCancel` in `canvas-react/src/Viewport.tsx` into the existing `cancelActiveTool` abandonment path in `client/src/canvas-v2/tool-loop.ts`. |
| S3 | **Multi-pointer / pointer-kind (touch/pen)** | **OUT** | The other half of the same Phase-3 bullet: a real subsystem (pointer identity tracking, gesture arbitration), tied to deferred multi-touch, not needed for a desktop team room. Ruled separately from S2 so the small fix isn't held hostage by the big one. |
| S4 | **Escape-cancel of in-flight drag/arrow-draw** | **IN** | Named "a real gap, not yet closed" in the Phase-3 notes; the ABANDONMENT-GAP HOOK section of `Viewport.tsx` already names Escape as a designed trigger and `cancelActiveTool` already exists — this is a keydown wiring task with outsized feel/parity payoff (Escape currently only ends text editing via `TextEditor.tsx`). |
| S5 | **Transform partial-resize/rotate revert** | **IN** | Documented Phase-4 parity item ("full undo-to-gesture-start… canvas-editor has no undo stack yet at all"). With S1 in, the blocker is gone: cancel (Escape/blur/pointercancel) during a transform reverts to gesture start via the undo mechanism or a gesture-start snapshot — planner's choice, but the observable behavior (no half-applied resize left behind on cancel) is required. |
| S6 | **SQLite `VACUUM`** | **OBSERVE** | H4 measured disk as a high-water mark (0.36x–6.33x disk-to-snapshot ratio, `server/src/canvas-v2/soak-actor.ts` CALIBRATION comment) — real but not user-facing, and `VACUUM` "has real cost of its own, so isn't a drop-in fix." Required this phase: add a **disk-file-size metric + high-water assertion to the actor soak** and dogfood-deployment visibility; set a decision threshold (e.g. disk > 10x live snapshot bytes sustained). Implement compaction-with-VACUUM only if the threshold trips — record the decision in the plan doc's execution notes. |
| S7 | **Connection banner** | **IN** | Pure livability/stability: a half-configured dogfood (e.g. `EW_CANVAS_SYNC` unset server-side) renders a dead canvas with no error — the team cannot "live in" an engine that fails silently. Small surface: a connection-state banner in `client/src/canvas-v2/CanvasV2App.tsx` driven by `ws-client-transport.ts` state (connecting / reconnecting / failed), with an E2E proof. |
| S8 | **Known-lossy repair edges** (dedupe drops valid twin; reparent relocates winner) | **OBSERVE** | Ratified Q11 built repair-firing telemetry into the dogfood dev overlay precisely to decide this on data. No firing has been reported. Required this phase: review the counter across dogfood + the extended soak; **fix becomes in-scope only if a real firing occurs**; either way, record the decision + counter evidence in the plan doc. |
| S9 | **`pendingImports` re-request** (server→sender `SyncRequest` extension) | **OBSERVE** | Ratified Q8 posture stands: the residual edge (client connects during a pending window) is narrow and instrumented in the dev overlay (G5). Same protocol as S8: review the counter, implement only on a real occurrence, record the decision. |
| S10 | **Reconnect since-acked-version delta** | **OBSERVE** | Ratified Q9: full-history backfill is correct-but-fat; the reconnect-backfill **byte counter** exists in the dev overlay to decide "in Phase 4 whether the delta is worth it." Decide from real dogfood reconnect numbers; implement only if bytes are materially painful (e.g. multi-MB routine reconnects); record the decision. |

---

## 4. Definition of Done (measurable; every line has a check)

Phase 4 is done when ALL of the following hold, each verified by the named
mechanism:

1. **No core kind renders as the BoxShape fallback.** note, frame, text, geo
   resolve to dedicated components via `shapeRegistry.ts`; a registry unit
   test asserts it, and component goldens exist for each kind's
   representative states (color set, author badge, fonts, geo variants,
   frame label).
2. **Cross-renderer parity gate exists and passes.** The new visual-diff
   harness renders the seeded parity room(s) under v1 and v2 in CI and the
   masked pixel-diff for the covered feature set (core bodies, arrows,
   embeds-as-placeholders where masked) is within the tolerances the plan
   fixes per region; the parity score is emitted as a per-run number
   (dashboard artifact). A deliberate visual regression to a sticky body
   fails CI.
3. **Delete works end-to-end.** E2E: select a shape, press Delete (and
   Backspace) → shape gone in the acting client AND a second connected
   client; Delete while text-editing does NOT delete the shape.
4. **Undo/redo works end-to-end.** canvas-editor unit tests cover
   undo/redo of create, move, resize, delete, and text edit; E2E covers
   Ctrl+Z after each of delete and drag; a two-client test proves undo never
   reverts the peer's ops (local-only semantic). Preflight probe verdict for
   the mechanism is recorded in the plan doc.
5. **Gesture cancellation is total.** Escape, `pointercancel`, and blur each
   cancel an in-flight create-drag/arrow-draw (unit + E2E), and cancelling
   an in-flight transform leaves the shape at its gesture-start geometry
   (S5), asserted in canvas-editor tests.
6. **The three embed write-path features work.** Terminal rename persists in
   the doc and renders on a peer; screenshare `stillUrl` stamp-back +
   aspect relock; file-viewer rev-bump + peer-follow — each with a test at
   the level the plan specifies (unit against the dispatch channel +
   at least one two-client E2E exercising the channel through `/sync/v2`).
7. **Connection banner proven.** E2E: room loads with the sync server
   stopped/killed → a visible error/reconnecting banner appears within the
   plan's stated bound (seconds, not minutes); recovery clears it.
8. **Perf gates green under honest budgets.** `canvas-v2-perf.spec.ts`
   passes with: 60 fps @ 1k retained; NEW dense-seed, select-all@1k, and
   drag-cadence scenarios with recorded baselines in
   `e2e/baselines/canvas-v2-perf.json` and ≤15%-regression gating per the
   design doc; entry chunk within ~2% of the 215.4 kB / 63.1 kB baseline.
9. **Stability gates green under tightened calibration.** Actor-backed soak
   validated at ≥20k ops with a tightened, empirically derived
   `FLAT_RSS_TOLERANCE` (no longer the 15x headroom placeholder);
   bounded-growth K re-calibrated; soak op mix includes deletes and embed
   writes; convergence/fuzz/crash-recovery suites green; the
   `canvas-soak.yml` nightly is green on the recalibrated settings.
10. **Every OBSERVE straddler has a recorded verdict.** S6/S8/S9/S10 each
    get a dated decision (fix triggered or explicitly re-deferred) with the
    counter/metric evidence, written into the plan doc's execution notes —
    "observe" is a deliverable, not a shrug.
11. **Repo invariants intact.** `bun run typecheck`, `bun run build`,
    `bun run test` (never raw `bun test`) all green; clean-room boundary
    tests pass (no server/tldraw imports in canvas-*); `engine.test.ts` +
    `scripts/exposure-audit.ts` still prove the `team` room can never run
    v2; work lands as bite-sized TDD commits, true merge commits only.

---

## 5. Required test coverage — the three owner-named axes

### 5.1 UI

| Area | Mechanism |
|---|---|
| Cross-renderer visual diff (REQUIRED, NEW) | New Playwright spec under `e2e/tests/` (e.g. `parity.spec.ts`), reusing `e2e/playwright.config.ts`, `e2e/scripts/start-server.ts` (already defaults `EW_CANVAS_SYNC=1`), the seeding machinery proven in `e2e/tests/seed.spec.ts`, and the screenshot conventions of `e2e/tests/visual.spec.ts`; goldens/masks in `e2e/goldens/`. Same room, both engines (v2 via `?engine=v2`), masked pixel diff + parity score artifact. |
| Component goldens for rich bodies | Extend `client/src/canvas-v2/goldens/`, `client/component-goldens.html`, and `e2e/tests/component-goldens.spec.ts` with fixture states for note (each color, author badge, font), frame, text, geo — same fixture-screenshot pattern the six embeds already use. |
| Interaction E2E | Extend `e2e/tests/canvas-v2.spec.ts` (the multi-client editing-loop pattern from Phase-3 H2) and `e2e/tests/multiplayer.spec.ts`: delete loop, undo/redo loop (incl. two-client local-only proof), Escape/pointercancel cancellation, embed write-back across two clients, connection banner. Mind the documented naming collision: `canvas-v2.spec.ts` also contains Agent-API-v2 tests — extend, don't rename. |
| Editor/headless unit | canvas-editor tests (run via `bun run test`) for the undo stack, keyboard→`DeleteShapes` mapping, transform cancel-revert; canvas-react tests for registry resolution and new-body prop reads; boundary tests stay green. |

### 5.2 Performance

| Area | Mechanism |
|---|---|
| Browser perf gates (reuse + extend) | `e2e/perf/canvas-v2-perf.spec.ts` + `e2e/lib/perf.ts`, baselines in `e2e/baselines/canvas-v2-perf.json` vs `tldraw-perf.json`, CI via `.github/workflows/canvas-v2-perf.yml` (nightly + renderer-PR). Keep 60 fps @ 1k gated; add dense-seed, select-all@1k (the 8.7 ms watch-item), and single-shape drag commit-cadence scenarios; document (not gate) 5k/10k per ratified Q12. |
| Rich-body render cost | New bodies exercised inside the existing perf scenarios (the seeded rooms use core kinds), so the same suite gates their cost; re-baseline honestly after landing them rather than inheriting BoxShape-era numbers. |
| Bundle size | Entry-chunk check against the Unit-12 baseline (~215.4 kB raw / ~63.1 kB gzip) in the build gate — new bodies and the undo integration must not bloat the eager bundle. |

### 5.3 Stability incl. multiplayer

| Area | Mechanism |
|---|---|
| Convergence + fuzz (reuse + extend op mix) | `canvas-sync/src/convergence.test.ts`, `canvas-sync/src/fuzz.test.ts` — extend weighted ops with deletes, text edits, and the embed write-path prop writes; corpus pin untouched (no loro upgrade). |
| Soak (reuse + re-calibrate) | `canvas-sync/src/soak.ts` + `soak-smoke.test.ts` + `canvas-sync/soak-cli.ts` via the `@ensembleworks/canvas-sync/soak` subpath (never re-export from the main index — documented client-build regression); re-calibrate bounded-growth K on the new op mix. |
| Actor-backed soak + disk metric | `server/src/canvas-v2/soak-actor.ts` + `soak-actor-cli.ts`: run ≥20k ops, tighten `FLAT_RSS_TOLERANCE` from the 15x placeholder to an empirical bound, add the S6 disk-file high-water metric/assertion; nightly via `.github/workflows/canvas-soak.yml`. |
| Crash recovery | `server/src/canvas-v2/crash-recovery.test.ts` + `crash-writer.ts` — extend coverage so kills mid-delete and mid-embed-write replay to a valid, convergent doc. |
| Presence | Existing presence tests + the single-write-publisher pattern (`client/src/canvas-v2/presence.ts`): any new presence writer added by the embed write path must not trip the `EphemeralStore` same-millisecond LWW tie (unit-test the combined-write pattern). |
| Exposure/boundary invariants | `client/src/engine.test.ts` + `client/scripts/exposure-audit.ts` (team-room hard exclusion), `*/src/boundary.test.ts` clean-room proofs — all must remain green, unmodified in intent. |

---

## 6. Constraints the plan must hold

- Bun workspaces; `bun run test` (NEVER raw `bun test`); `bun run
  typecheck`; `bun run build`; `PATH=$HOME/.bun/bin` for the toolchain.
- Clean-room boundary: `canvas-model/doc/sync/editor/react` never import
  server or tldraw; client-owned tech (xterm/livekit/gateway) stays under
  `client/src/canvas-v2/`.
- `team` room hard-exclusion in `client/src/engine.ts` is untouchable.
- True merge commits, never squash; bite-sized, frequent, TDD commits.
- Reuse the named rigs — a plan that reinvents any of §5's infrastructure
  instead of extending it violates these bounds.
- Mechanism-risk items (S1's `UndoManager`) get a Phase-3-style preflight
  probe with the verdict recorded durably in the plan doc before the
  dependent seam is implemented.
