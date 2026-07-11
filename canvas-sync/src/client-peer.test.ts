// Run: bun src/client-peer.test.ts
import assert from 'node:assert/strict'
import { dumpModel } from '@ensembleworks/canvas-doc'
import { checkInvariants, type CanvasDocument } from '@ensembleworks/canvas-model'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'
import { SyncServerPeer } from './server-peer.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const shape = (id: string, over: any = {}) =>
  ({ id, kind: 'note', parentId: 'page:p', props: {}, ...base(), ...over }) as any

// Normalize for cross-peer comparison (same approach as server-peer.test.ts /
// the plan's convergence `diverges` helper): sort shapes/bindings/pages by id.
const byIdAsc = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
const normalize = (m: CanvasDocument) => ({
  pages: [...m.pages].sort(byIdAsc),
  shapes: [...m.shapes].sort(byIdAsc),
  bindings: [...m.bindings].sort(byIdAsc),
})

// --- (1) two clients + one server: A's write converges to the server AND B ---
{
  const server = new SyncServerPeer({ peerId: 1n })
  const [serverEndA, clientEndA] = makePair()
  const [serverEndB, clientEndB] = makePair()
  server.connect(serverEndA)
  server.connect(serverEndB)
  const clientA = new SyncClientPeer({ peerId: 101n, transport: clientEndA })
  const clientB = new SyncClientPeer({ peerId: 102n, transport: clientEndB })

  clientA.doc.putPage({ id: 'page:p', name: 'P' })
  clientA.doc.commit()
  clientA.putShape(shape('shape:a1'))

  assert.deepEqual(normalize(dumpModel(server.doc)), normalize(dumpModel(clientA.doc)), 'server converges with the writer')
  assert.deepEqual(normalize(dumpModel(clientB.doc)), normalize(dumpModel(clientA.doc)), 'the other client converges via server relay')
}

// --- (2) THE REBASE SCENARIO: B goes offline, edits happen on both sides
// while disconnected, then B reconnects and catches up exactly — AND its
// offline edit reaches the server. ---
{
  const server = new SyncServerPeer({ peerId: 2n })
  const [serverEndA, clientEndA] = makePair()
  const [serverEndB, clientEndB] = makePair()
  server.connect(serverEndA)
  server.connect(serverEndB)
  const clientA = new SyncClientPeer({ peerId: 111n, transport: clientEndA })
  const clientB = new SyncClientPeer({ peerId: 112n, transport: clientEndB })

  clientA.doc.putPage({ id: 'page:p', name: 'P' })
  clientA.doc.commit()
  clientA.putShape(shape('shape:before'))
  assert.deepEqual(normalize(dumpModel(clientB.doc)), normalize(dumpModel(clientA.doc)), 'precondition: converged before the split')

  // Disconnect B: close ONLY the transport (not clientB itself — clientB is
  // still "alive", just offline). This fires onClose on both pair ends, so
  // the server removes serverEndB from its client set.
  clientEndB.close()

  // A makes more changes while B is offline: server + A converge, B does not.
  clientA.putShape(shape('shape:while-b-offline'))
  assert.deepEqual(
    normalize(dumpModel(server.doc)),
    normalize(dumpModel(clientA.doc)),
    'server keeps converging with A while B is offline',
  )
  assert.notDeepEqual(
    normalize(dumpModel(clientB.doc)),
    normalize(dumpModel(server.doc)),
    'B has NOT seen A\'s while-offline edit yet',
  )

  // B ALSO edits while offline. This commits locally (doc.subscribeLocalUpdates
  // fires and attempts transport.send(), but clientEndB is closed, so per the
  // Transport contract that send is a silent no-op — the edit is NOT queued
  // for automatic resend, it just sits in B's own oplog until reconnect.
  clientB.putShape(shape('shape:b-offline-edit'))
  assert.ok(
    !server.doc.listShapes().some((s) => s.id === 'shape:b-offline-edit'),
    'precondition: the offline edit has not reached the server yet',
  )

  // Reconnect B on a fresh transport pair (the old one is dead).
  const [serverEndB2, clientEndB2] = makePair()
  server.connect(serverEndB2)
  clientB.reconnect(clientEndB2)

  assert.deepEqual(
    normalize(dumpModel(clientB.doc)),
    normalize(dumpModel(server.doc)),
    'B caught up exactly to the server after reconnect (rebase via SyncRequest)',
  )
  assert.ok(
    server.doc.listShapes().some((s) => s.id === 'shape:b-offline-edit'),
    'B\'s offline edit reached the server after reconnect (via the full-history Update reconnect() sends)',
  )
  assert.ok(
    clientB.doc.listShapes().some((s) => s.id === 'shape:while-b-offline'),
    'B also caught up on what it missed while offline',
  )
  // The still-connected third party: B's backfill Update must flow past the
  // server to A via the raw-delta relay (server-peer's broadcast(frame, from)).
  assert.ok(
    clientA.doc.listShapes().some((s) => s.id === 'shape:b-offline-edit'),
    "B's offline edit reached A via server relay",
  )
  // Full three-way convergence: A == server == B, normalized.
  assert.deepEqual(
    normalize(dumpModel(clientA.doc)),
    normalize(dumpModel(server.doc)),
    'A and the server hold identical normalized state after the reconnect round',
  )
  assert.deepEqual(
    normalize(dumpModel(clientB.doc)),
    normalize(dumpModel(server.doc)),
    'B and the server hold identical normalized state after the reconnect round',
  )
  assert.deepEqual(checkInvariants(dumpModel(server.doc)), [], 'converged server state is invariant-clean')
}

// --- (3) close(): after close, local puts don't throw and don't reach the server ---
{
  const server = new SyncServerPeer({ peerId: 3n })
  const [serverEnd, clientEnd] = makePair()
  server.connect(serverEnd)
  const client = new SyncClientPeer({ peerId: 301n, transport: clientEnd })

  client.close()

  assert.doesNotThrow(() => client.putShape(shape('shape:after-close')), 'a local put after close() does not throw')
  assert.ok(
    !server.doc.listShapes().some((s) => s.id === 'shape:after-close'),
    'a local put after close() never reaches the server',
  )
}

console.log('ok: client-peer')
