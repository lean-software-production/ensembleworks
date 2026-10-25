// Run: bun src/canvas-v2/boot-sync-ready.test.ts
//
// Pins the boot sequencing fix at the client layer with the REAL resolvePageId
// (bootstrap-page.ts): once SyncClientPeer.ready() has resolved, the server's
// existing page is visible and adopted — no redundant 'page:p'. The underlying
// mechanism (Frame.SyncDone + ready()) is unit-proven in canvas-sync
// (client-peer.test.ts); this proves the client-side page-resolution consumes
// it correctly, the sequence CanvasV2App.boot() runs.
import assert from 'node:assert/strict'
import { SyncServerPeer, SyncClientPeer, makePair, type Transport } from '@ensembleworks/canvas-sync'
import { resolvePageId } from './bootstrap-page.js'

/** Holds every server→client frame until release() — see the same helper in
 * canvas-sync/src/client-peer.test.ts. */
function gatedClientTransport(raw: Transport): { transport: Transport; release: () => void } {
  let deliver: ((b: Uint8Array) => void) | null = null
  const held: Uint8Array[] = []
  let released = false
  raw.onMessage((b) => { if (released) deliver?.(b); else held.push(b) })
  return {
    transport: {
      send: (b) => raw.send(b),
      onMessage: (cb) => { deliver = cb },
      onClose: (cb) => raw.onClose(cb),
      close: () => raw.close(),
    },
    release: () => { released = true; for (const b of held.splice(0)) deliver?.(b) },
  }
}

const server = new SyncServerPeer({ peerId: 1n })
server.doc.putPage({ id: 'page:xyz', name: 'Real' })
server.doc.commit()

const [serverEnd, clientEndRaw] = makePair()
server.connect(serverEnd)
const gate = gatedClientTransport(clientEndRaw)
const peer = new SyncClientPeer({ peerId: 2n, transport: gate.transport })

const ready = peer.ready()
gate.release() // deliver the held backfill Update + SyncDone
await ready

const pageId = resolvePageId(peer.doc)
assert.equal(pageId, 'page:xyz', 'resolvePageId adopts the server page once ready() has resolved')
assert.deepEqual(
  peer.doc.listPages().map((p) => p.id),
  ['page:xyz'],
  'no redundant page:p bootstrapped when page-resolution is gated on ready()',
)
console.log('ok: boot-sync-ready — resolvePageId adopts the server page after ready(), no redundant page')
