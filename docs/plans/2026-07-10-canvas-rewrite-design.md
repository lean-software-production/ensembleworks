# Canvas rewrite: replacing tldraw with an agent-first canvas

**Date:** 2026-07-10
**Status:** Approved design (brainstorm validated section-by-section)
**Scope:** Full replacement of the tldraw dependency with a homegrown,
agent-first infinite canvas — feature parity for everything we use today,
plus a core rearchitecture that makes the canvas testable (behavior, UI,
performance, stability) and extensible.

## Decisions (settled during design)

| Decision | Choice |
|---|---|
| Sequencing | **Hybrid**: clean-room core packages with full test rigs; strangler integration into the running app, layer by layer |
| Sync model | **CRDT — Loro** (Rust core, JS/WASM bindings) on the existing Bun/TS server; server is a first-class *validating* peer for all agent writes. Not Elixir/Phoenix (Phoenix Presence is not a document CRDT; LiveView is wrong for a 60fps canvas; Elixir forfeits shared TS contracts). Yjs is the fallback if Loro disappoints — `canvas-doc` wraps it behind our own interface to keep it swappable |
| Feature floor | **Full parity** with every feature we use: rich text on canvas, smart (bound, routed) arrows, freehand ink, rotation |
| Data migration | **Full migration tool**: tldraw records → new model, run per-room at cutover, originals kept as rollback artifacts, round-trip fidelity + screenshot-diff tests over every prod room |
| Electron (future) | Architecture kept Electron-ready: DOM renderer, no Node APIs in client, WS/HTTP as the only seam, CRDT makes local-first/offline native |

## Why this is tractable

The current tldraw usage surface (mapped 2026-07-09) is far narrower than
"all of tldraw":

- All six custom shapes (`terminal`, `iframe`, `neko`, `roadmap`,
  `screenshare`, `file-viewer`) are `BaseBoxShapeUtil` HTML boxes.
- All agent/bot/skill writes already bypass the editor: HTTP →
  `updateStore` → record CRUD on the server. Agents never touch the sync
  protocol or interaction layer.
- UI chrome is already mostly ours (StylePanel/MenuPanel nulled, custom
  CommandBar).
- No schema migrations exist; contracts deliberately avoid tldraw record
  types (`StampRecord` is structural).

What we need is "Figma-lite for HTML panels + stickies + frames + arrows +
ink," not a full drawing app.

## Architecture: five clean-room packages

New Bun workspaces, dependency-ordered; nothing below the renderer touches
the DOM:

```
canvas-model    Pure TS. Shape/binding/page schema, semantic ops
                (CreateShape, Reparent, BindArrow, SetText…), validators,
                invariants as executable predicates. Zero deps — not even
                Loro.

canvas-doc      Document engine. Wraps Loro behind our own interface
                (swappable): typed ops in → CRDT mutations; queries +
                subscriptions out; deterministic repair pass (cycle-break,
                dangling-binding GC) after every merge.

canvas-editor   Headless editor. Camera, selection, hit-testing, snapping,
                arrow routing; every tool a pure FSM: normalized input
                events → intents → canvas-model ops. No DOM; injected
                clock/PRNG — fully deterministic.

canvas-react    Thin renderer. React + CSS transforms for shape bodies
                (custom HTML shapes port near-unchanged), one SVG overlay
                for arrows/ink/selection/handles. Logic-free by policy,
                enforced by an ESLint boundary rule.

canvas-sync     Client + server halves: Loro update exchange over WS,
                presence via Loro's ephemeral store (cursor, viewport,
                stamp, presenting tokens), reconnect/rebase.
```

The `server` workspace keeps its role: a room host (one document actor per
room, like today's `TLSocketRoom`) owns the Loro doc and persists via
append-log + periodic shallow-snapshot compaction into the per-room SQLite
pattern. Humans sync CRDT-direct; **agents go through a validating
semantic API** (ops/queries/subscriptions) — the server validates before
applying.

`contracts` stays the shared-schema home; `canvas-model` lives beside it,
with contracts re-exporting what bots/skills need.

## Document model and Loro mapping

- A page is a tree: `page → frames/shapes → children`, mapped to Loro's
  **movable tree** — reparenting and sibling order (z-order) are native
  CRDT operations (no hand-rolled fractional-index repair, no reparenting
  cycle bugs).
- Each tree node carries a map of typed props validated by `canvas-model`.
- Note/text/arrow-label content lives in **Loro rich text** containers,
  bound to ProseMirror in the client via `loro-prosemirror`; static text
  renders as cheap HTML.
- Bindings (arrow↔shape) are a top-level map keyed by binding id.
- Assets stay out-of-band (existing `/uploads` flow); the doc stores
  references only.
- Invariants are executable predicates in `canvas-model` (`noOrphans`,
  `noCycles`, `noDanglingBindings`, `validProps`). `canvas-doc`'s repair
  pass runs them after every remote merge and repairs deterministically
  (identical repair on every peer, or convergence breaks).

### CRDT limits, named and mitigated

- **Authority**: CRDTs can't reject writes. Mitigation: agent writes flow
  through the validating server API; only direct human edits merge
  unvalidated, backed by the repair pass.
- **Referential integrity** (delete-vs-bind races): repair/GC pass.
- **Semantic history**: weaker than an op log; mitigated by Loro's change
  DAG and time travel.
- **Metadata growth**: tombstone/metadata bloat is monitored from week one
  (see stability rig).

## Headless editor: interactions as replayable state machines

```
InputEvent (normalized pointer/key/wheel + modifiers, injected timestamps)
  → active Tool (FSM: idle → pointing → dragging → …)
     → Intents (TranslateShapes, ResizeSelection, StartArrowFromAnchor…)
        → canvas-model ops → canvas-doc
```

- Tools: select, hand, note, text, geo, arrow, draw/eraser (ink via
  `perfect-freehand`), frame. Each is a pure FSM: `(state, event) →
  (state', intents[])`. No DOM reads inside tools; hit-tests/snap
  candidates/anchor resolution come from a pure geometry index fed by the
  doc.
- Camera, selection, editing-shape, hover are editor-local (not CRDT),
  exposed via a small signals store — this also replaces the diffuse
  tldraw `atom/track/useValue` usage in chrome code.
- Rotation and rich-text-editing states modeled from day one; arrow
  router does straight + curved with shape-boundary clipping and
  normalized anchors (parity with what users and the conversation-map
  skill produce today).

## Renderer

- One viewport div; camera is a single CSS `transform` on a world
  container. Shape bodies are absolutely-positioned React components.
- One full-viewport SVG overlay above (arrows, ink, selection, handles,
  snap guides, collaborator cursors); dotted-grid canvas layer below.
- ProseMirror mounts only for the shape being edited.
- Off-viewport culling via the editor's spatial index; heavy embeds
  (terminals, iframes, screenshare) get visibility lifecycle hooks
  (mount/suspend/unmount).

## Agent API v2 and spatial semantics

Semantic ops, queries, and subscriptions; old HTTP endpoints become shims
during the strangler period, deleted post-cutover.

**Spatial semantics layer** (named component): because geometry lives in
pure packages, the server runs the same code the renderer uses — spatial
queries are plain functions `doc → semantic view`. Example:
`GET /api/canvas/semantic?frame=Planning` returns clusters (members,
confidence, arrangement: column/grid/loose, nearest heading-ish label),
outliers, and relations (arrows between clusters).

- Mechanics: density clustering on centroids, alignment detection,
  containment from the frame tree, arrows as explicit relations.
- Calibration is the hard part, not code: scale-relative thresholds (gaps
  relative to median sticky size, not pixels); multiple signals feeding a
  confidence score (color, edge alignment, creation-burst adjacency from
  Loro's change history); expose confidence and granularity rather than
  one true clustering.
- Runs both directions: the same layer powers **layout ops** for agent
  writes ("add to cluster C", "place near X, don't overlap") replacing
  today's fixed grid stacking.
- Read-side queries land with Phase 1; subscriptions ("tell me when
  clustering in this frame changes") with Phase 6.

## Test strategy (first-class requirement)

### Model/doc layer — deepest leverage

- **Property-based convergence suite** (per-commit): N replicas, random op
  sequences including hostile interleavings (concurrent
  reparent-into-each-other, delete-vs-bind, same-offset text edits),
  merged in shuffled orders → assert byte-identical state and invariants
  post-repair; failures shrink to minimal repros.
- **Op-semantics unit tests**: every semantic op has a spec test — doubles
  as living documentation for the agent API.
- **Fuzzing**: garbage/truncated Loro updates never crash the room host;
  malformed agent ops rejected with typed errors, never partially applied.
- **Determinism rule**: no `Date.now`/`Math.random`/I/O in
  `canvas-model`/`canvas-doc`; timestamps and ids injected. Any bug is a
  replayable op sequence; the replay is the regression test.

### Editor layer

- **Interaction script tests**: DSL (`down(10,10).move(50,50,{steps:8}).up()`)
  drives tools headlessly; assert intents, doc, selection, camera. tldraw's
  current feel (drag thresholds, snap distances) captured as goldens first.
- **Session replay artifacts**: editor records (input events + remote
  updates); replay reproduces exact state bit-for-bit. Every QA session
  and bug report is a replayable file → regression test.
- **Geometry property tests**: randomized shape fields (e.g. "a point
  returned by hitTest is always inside the returned shape's geometry").

### UI layer — three tiers

1. **Component goldens**: fixture states per shape renderer,
   screenshot-diffed in isolation.
2. **Playwright E2E**: real browser + real sync server + seeded rooms;
   real pointer events; assert DOM state and doc state via a test hook
   (`window.__ew.editor`). Multi-client tests assert convergence of what
   is *rendered*. Failures auto-save the session-replay artifact.
3. **Cross-renderer parity diffing**: same seeded/converted rooms rendered
   in tldraw and the new engine, screenshot-diffed with per-feature masks
   and tolerances — parity as a dashboard number, doubling as the
   migration-fidelity gate.

### Performance — two rigs, CI-gated budgets

- **Headless rig** (per-commit): op apply/merge throughput,
  hit-test/spatial-query latency, repair cost, snapshot load — against
  fixture rooms at 100/1k/10k shapes plus anonymized copies of the largest
  real rooms. Budgets relative-to-baseline (fail >15% regression vs main);
  nightly absolute trend lines on a pinned runner.
- **Browser rig** (nightly + pre-merge for renderer changes): Playwright +
  CDP tracing on scripted scenarios (pan/zoom sweep, 50-shape marquee
  drag, rapid sticky creation, two-client cursor storm) measuring p95
  frame time, pointerdown→paint latency, dropped frames. Budget: 60fps
  interaction at 1k shapes; degradation curve at 5k/10k documented.

### Stability

- **Soak simulation** (nightly, hours): N headless sync clients +
  agent-API writers doing weighted random ops through a chaos proxy
  (latency spikes, drops, partitions, reconnect storms). Assert
  convergence, invariants, flat RSS, **bounded doc/metadata growth** and
  snapshot-compaction effectiveness (CRDT tombstone bloat is the silent
  killer — graphed from week one).
- **Crash recovery** (CI, real SQLite files): `kill -9` room host
  mid-write; restart replays append-log to a valid doc; clients reconnect
  and converge.
- **Client longevity**: hour-long scripted Playwright session with
  periodic heap snapshots; monotonic heap growth fails the build.
- **Prod telemetry as test extension**: repair-pass activations, rejected
  agent ops, update-decode failures are counted metrics — frequent repair
  firing in prod = a convergence bug escaped the suite.

## Phases (each lands in production; each package born clean-room)

- **Phase 0 — Baseline capture.** Playwright + perf rigs stood up against
  the current tldraw app: interaction goldens, visual goldens of seeded +
  real rooms, perf baselines. tldraw's behavior becomes the executable
  spec.
- **Phase 1 — Model + doc + converter.** `canvas-model`, `canvas-doc`,
  tldraw→model converter with round-trip fidelity tests over every prod
  room. **Agent API v2 ships now** (read side via live conversion from the
  tldraw store, including spatial-semantics queries) — skills/bots start
  migrating months before the renderer exists.
- **Phase 2 — Sync + room host + shadow mode.** Every prod room
  continuously mirrored into a new-engine document; soak/crash rigs run
  against real traffic shapes. Zero user exposure.
- **Phase 3 — Editor + renderer, dogfood rooms.** Custom shapes port early
  (cheap, and they force the embed-lifecycle design). New engine behind a
  per-room flag; the team lives in it.
- **Phase 4 — Parity burn-down.** Cross-renderer diff dashboard + feature
  checklist + perf gates driven to zero. Agent writes cut over to v2 (old
  endpoints become shims).
- **Phase 5 — Cutover + removal.** Per-room migration tool, originals kept
  as rollback artifacts, frozen tldraw build deployable for a rollback
  window; then the dependency and shims are deleted.
- **Phase 6 — Agent-first dividends.** Subscriptions everywhere, semantic
  queries, layout ops — the extension door this was rearchitected for.

## Electron readiness (future)

- DOM renderer runs unchanged; no Node APIs in client; WS/HTTP the only
  seam.
- CRDT makes local-first native: local Loro persistence, offline op queue,
  sync-on-reconnect.
- One rule to hold: `canvas-*` packages never import from `server`.

## Known risks and their watchdogs

| Risk | Watchdog |
|---|---|
| Loro ecosystem maturity | `canvas-doc` interface keeps it swappable for Yjs; convergence suite is engine-agnostic |
| Interaction-feel long tail | Phase 0 goldens make "feel" an executable spec; dogfood rooms from Phase 3 |
| CRDT metadata bloat | Soak rig graphs doc growth + compaction from week one |
| Untyped consumers (skills, Discord bot, transcriber) breaking silently | Agent API v2 lands Phase 1 with an E2E smoke suite driving every endpoint; old endpoints stay as tested shims until Phase 5 |
| Presence-dependent server features (frame proximity ordering, transcript stamping) | Presence shape covered by the multi-client Playwright tier + sync soak assertions |
| Converter fidelity | Round-trip tests + screenshot diffs over every prod room; originals retained for rollback |
