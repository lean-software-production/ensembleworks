// @ensembleworks/canvas-editor — the headless clean-room editor core: an
// editor-local signals store (camera/selection/hover/editing — deliberately
// NOT in the CRDT), an Intent system that turns user actions into
// @ensembleworks/canvas-model ops applied to a CanvasDoc, normalized input
// events, and an interaction-script DSL for deterministic, replayable
// sequences. Depends only on @ensembleworks/canvas-model +
// @ensembleworks/canvas-doc. Never imports loro-crdt, ws, the tldraw package
// family, react, canvas-sync, server, or a DOM global; never calls
// Date.now/Math.random
// directly — every clock/PRNG/id is injected by the caller (enforced by
// boundary.test.ts). Tools (select/hand/create/arrow/transform — the FSMs
// that turn InputEvent sequences into Intents) plug into `run()` starting in
// a later unit; this package is only the substrate they run on.
export const CANVAS_EDITOR_VERSION = 1 as const

// Public re-exports land as each piece is built: the Intent vocabulary +
// Editor (state store + intent application) next, then normalized input
// events + the interaction-script DSL after that.
