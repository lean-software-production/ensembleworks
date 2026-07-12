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
