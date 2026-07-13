// @ensembleworks/canvas-sync — Loro update exchange + presence over an injected
// transport. Clean-room: imports only canvas-model, canvas-doc, loro-crdt.
// Never imports ws/express/server/tldraw; no DOM. Determinism: no Date.now/
// Math.random — clock/ids/PRNG injected.
export const CANVAS_SYNC_VERSION = 1 as const

// Public surface consumed outside this workspace (server's C2 DocumentActor,
// the C3 ws adapter, and any future consumer). Re-exported here rather than
// deep-imported so `server` depends on one module boundary, not this
// package's internal file layout.
export { Frame, type Transport, encode, decode } from './protocol.js'
export { makePair } from './memory-transport.js'
export { SyncClientPeer, type SyncClientOpts } from './client-peer.js'
export { SyncServerPeer, type SyncServerOpts } from './server-peer.js'
export { PresenceStore, type Presence } from './presence.js'
// NOTE: the E4/H4 soak simulation (runSoak/SoakServer/etc., src/soak.ts) is
// DELIBERATELY NOT re-exported from this main entry — it pulls in
// `node:assert/strict` (soak.ts's own convergence assertions), which Vite
// flags ("has been externalized for browser compatibility") the moment
// ANYTHING importing this main index reaches it, even though the client
// never calls it and tree-shaking drops the dead code from the final
// bundle (verified: the client's entry-chunk size was unaffected either
// way). Rather than ship that warning-noise to every consumer of this
// index (the client included, since it already depends on this package for
// SyncClientPeer), soak.ts is exposed via its OWN package subpath instead —
// see package.json's `"./soak"` export. server's Task H4 actor-backed
// variant imports `@ensembleworks/canvas-sync/soak` directly.

