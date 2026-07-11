// @ensembleworks/canvas-sync — Loro update exchange + presence over an injected
// transport. Clean-room: imports only canvas-model, canvas-doc, loro-crdt.
// Never imports ws/express/server/tldraw; no DOM. Determinism: no Date.now/
// Math.random — clock/ids/PRNG injected.
export const CANVAS_SYNC_VERSION = 1 as const
