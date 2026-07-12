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
// boundary.test.ts). Tools (select/hand/create — C4/C5/C6; arrow/transform
// follow in C7/C8) are FSMs that turn InputEvent sequences into Intents,
// built against a shared ToolContext (tools/tool-context.ts) and plugged
// into `run()` (script.ts).
export const CANVAS_EDITOR_VERSION = 1 as const

export * from './intents.js'
export * from './editor.js'
export * from './input.js'
export * from './script.js'
export * from './tools/tool-context.js'
export * from './tools/select.js'
