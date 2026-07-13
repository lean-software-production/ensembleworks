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
// The E4/H4 soak simulation, re-exported so a caller OUTSIDE this package
// (server's Task H4 actor-backed variant) can drive the SAME chaos/ops/
// reconnect/instrumentation machinery against its own `SoakServer`-shaped
// adapter instead of duplicating any of it — see soak.ts's `SoakServer` doc
// comment for the seam this exists for ("canvas-sync can't import server;
// server CAN import canvas-sync").
export { runSoak, BOUNDED_GROWTH_K, AVG_SHAPE_SIZE_BYTES, type RunSoakOpts, type SoakResult, type SoakServer } from './soak.js'
