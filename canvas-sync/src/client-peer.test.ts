// Run: bun src/client-peer.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { canonicalPageId, checkInvariants } from '@ensembleworks/canvas-model'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'
import { Frame, encode, type Transport } from './protocol.js'
import { SyncServerPeer } from './server-peer.js'
import { normalize, shape } from './test-helpers.js'

/** A transport wrapper that HOLDS every server→client frame until release() —
 * client→server sends pass straight through. Lets a test freeze the backfill
 * mid-handshake deterministically (no timers), the same "defer a delivery"
 * idea soak.ts's deferred queue uses, scoped to one direction. */
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

// --- (4) repair is gated on ImportResult.changed: a redundant Update (all
// ops already known) must NOT pay the O(doc) repair marshal ---
{
  const [fakeServerEnd, clientEnd] = makePair()
  // No real server: we drive frames by hand from the far end of the pair.
  fakeServerEnd.onMessage(() => {}) // swallow the client's SyncRequest/Updates
  const client = new SyncClientPeer({ peerId: 401n, transport: clientEnd })

  // Spy: shadow the instance's repair with a counting wrapper.
  let repairs = 0
  const realRepair = client.doc.repair.bind(client.doc)
  ;(client.doc as any).repair = () => { repairs++; return realRepair() }

  const writer = LoroCanvasDoc.create({ peerId: 402n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:gated'))
  writer.commit()
  const delta = writer.exportUpdate()

  fakeServerEnd.send(encode(Frame.Update, delta))
  assert.equal(repairs, 1, 'a fresh Update runs repair once')
  assert.deepEqual(client.doc.listShapes().map((s) => s.id), ['shape:gated'])

  fakeServerEnd.send(encode(Frame.Update, delta)) // exact same bytes again
  assert.equal(repairs, 1, 'a no-op (changed: false) import skips repair entirely')
}

// --- (5) reconnect() closes the abandoned transport: even if the old channel
// is still open (zombie — e.g. a half-dead ws the client gave up on), the
// server must drop it (onClose -> clients.delete), so fan-out stops flowing
// down the stale channel (no unbounded client-set leak / double-relay). ---
{
  const server = new SyncServerPeer({ peerId: 6n })
  const [serverEnd1, clientEnd1] = makePair()
  server.connect(serverEnd1)
  const client = new SyncClientPeer({ peerId: 601n, transport: clientEnd1 })

  // Reconnect WITHOUT the old transport having died first.
  const [serverEnd2, clientEnd2] = makePair()
  server.connect(serverEnd2)
  client.reconnect(clientEnd2)

  // Watch the old channel: nothing may arrive here anymore.
  let staleFrames = 0
  clientEnd1.onMessage(() => staleFrames++)

  // A third party writes; the server fans out to its live clients.
  const [writerServerEnd, writerClientEnd] = makePair()
  server.connect(writerServerEnd)
  const writer = LoroCanvasDoc.create({ peerId: 602n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:after-swap'))
  writer.commit()
  writerClientEnd.send(encode(Frame.Update, writer.exportUpdate()))

  assert.ok(
    client.doc.listShapes().some((s) => s.id === 'shape:after-swap'),
    'the new transport delivers: client stays live after the swap',
  )
  assert.equal(staleFrames, 0, 'the abandoned transport receives nothing — reconnect() closed it')
}

// --- (6) close() ignores late frames: a real ws can deliver buffered frames
// after the app-level close; they must not mutate the closed peer's doc.
// Double-close is safe. ---
{
  let msgCb: ((b: Uint8Array) => void) | null = null
  let closed = false
  const fake: import('./protocol.js').Transport = {
    send: () => {},
    onMessage: (cb) => { msgCb = cb },
    onClose: () => {},
    close: () => { closed = true },
  }
  const client = new SyncClientPeer({ peerId: 801n, transport: fake })
  client.close()
  assert.ok(closed, 'close() closes the transport')
  assert.doesNotThrow(() => client.close(), 'close() is idempotent')

  const writer = LoroCanvasDoc.create({ peerId: 802n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:late'))
  writer.commit()
  msgCb!(encode(Frame.Update, writer.exportUpdate())) // buffered frame lands post-close
  assert.deepEqual(client.doc.listShapes(), [], 'a post-close inbound Update is dropped, not applied')
}

// --- (7) malformed frames from a buggy/hostile server: log-and-drop, never
// throw (same E2 guard as the server peer — a crash here would take down
// whichever process hosts the client, e.g. a shadow driver or an agent). ---
{
  const server = new SyncServerPeer({ peerId: 1n })
  const [serverEnd, clientEnd] = makePair()
  server.connect(serverEnd)
  const client = new SyncClientPeer({ peerId: 701n, transport: clientEnd })
  client.putShape(shape('shape:before'))

  // Deliver malformed frames straight down the server->client leg: zero-byte
  // (decode throws) and a garbage Update payload (doc.import throws).
  serverEnd.send(new Uint8Array(0))
  const garbage = new Uint8Array(201)
  garbage[0] = Frame.Update
  for (let i = 1; i < garbage.length; i++) garbage[i] = (i * 53) % 256
  serverEnd.send(garbage)

  // The client is still fully alive: it can keep editing and converging.
  client.putShape(shape('shape:after'))
  assert.deepEqual(
    server.doc.listShapes().map((s) => s.id).sort(),
    ['shape:after', 'shape:before'],
    'the client keeps operating after malformed inbound frames',
  )
}

// --- (8) THE DUPLICATE-SHAPE RECONNECT RACE (production path): both clients
// delete+recreate the SAME shape id while offline, then reconnect. The merge
// keeps both physical tree nodes for the id — the convergence rig's discovery,
// reachable through this exact documented flow. The server repairs on every
// changed import, so dedupe must fire automatically post-reconnect: all three
// parties converge to exactly ONE shape:x (the content winner), invariants
// clean, and the id is genuinely deletable again (no "undeletable shape"). ---
{
  const server = new SyncServerPeer({ peerId: 8n })
  const [serverEndA, clientEndA] = makePair()
  const [serverEndB, clientEndB] = makePair()
  server.connect(serverEndA)
  server.connect(serverEndB)
  const clientA = new SyncClientPeer({ peerId: 811n, transport: clientEndA })
  const clientB = new SyncClientPeer({ peerId: 812n, transport: clientEndB })

  clientA.doc.putPage({ id: 'page:p', name: 'P' })
  clientA.doc.commit()
  clientA.putShape(shape('shape:x'))
  assert.deepEqual(normalize(dumpModel(clientB.doc)), normalize(dumpModel(clientA.doc)), 'precondition: converged before the split')

  // Both go offline.
  clientEndA.close()
  clientEndB.close()

  // Both delete + recreate shape:x offline, with DIFFERENT content. Winner
  // rule is content-based (smallest stableStringify): the entries first
  // diverge at "kind" — "geo" < "note" — so B's recreation must win.
  clientA.doc.deleteShape('shape:x')
  clientA.doc.putShape(shape('shape:x', { kind: 'note', x: 500 }))
  clientA.doc.commit()
  clientB.doc.deleteShape('shape:x')
  clientB.doc.putShape(shape('shape:x', { kind: 'geo' }))
  clientB.doc.commit()

  // Reconnect both on fresh pairs.
  const [serverEndA2, clientEndA2] = makePair()
  server.connect(serverEndA2)
  clientA.reconnect(clientEndA2)
  const [serverEndB2, clientEndB2] = makePair()
  server.connect(serverEndB2)
  clientB.reconnect(clientEndB2)

  for (const [name, doc] of [['server', server.doc], ['clientA', clientA.doc], ['clientB', clientB.doc]] as const) {
    assert.equal(
      doc.listShapes().filter((s) => s.id === 'shape:x').length, 1,
      `${name} holds exactly ONE shape:x after the reconnect race — dedupe repair fired`,
    )
    assert.equal(doc.getShape('shape:x')!.kind, 'geo', `${name}'s survivor is the content winner`)
    assert.deepEqual(checkInvariants(dumpModel(doc)), [], `${name} is invariant-clean`)
  }
  assert.deepEqual(normalize(dumpModel(clientA.doc)), normalize(dumpModel(server.doc)), 'A == server')
  assert.deepEqual(normalize(dumpModel(clientB.doc)), normalize(dumpModel(server.doc)), 'B == server')

  // The id is genuinely deletable again, end to end.
  clientA.doc.deleteShape('shape:x')
  clientA.doc.commit()
  for (const [name, doc] of [['server', server.doc], ['clientA', clientA.doc], ['clientB', clientB.doc]] as const) {
    assert.equal(doc.getShape('shape:x'), undefined, `${name}: shape:x fully deleted — no undeletable survivor`)
  }
}

// --- (7) repairCount (Task G5): the peer's OWN counter climbs in lockstep
// with its own doc.repair() calls -- exactly the fresh-vs-redundant-Update
// distinction case (4) above already exercises, pinned as a PUBLIC accessor
// this time instead of a test-local spy. ---
{
  const [fakeServerEnd, clientEnd] = makePair()
  fakeServerEnd.onMessage(() => {}) // swallow the client's SyncRequest/Updates
  const client = new SyncClientPeer({ peerId: 701n, transport: clientEnd })
  assert.equal(client.repairCount, 0, 'a fresh peer has repaired zero times')

  const writer = LoroCanvasDoc.create({ peerId: 702n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:repair-count'))
  writer.commit()
  const delta = writer.exportUpdate()

  fakeServerEnd.send(encode(Frame.Update, delta))
  assert.equal(client.repairCount, 1, 'a fresh (changed) Update bumps repairCount')

  fakeServerEnd.send(encode(Frame.Update, delta)) // exact same bytes again: changed=false
  assert.equal(client.repairCount, 1, 'a redundant (no-op) Update does not bump repairCount')

  writer.putShape(shape('shape:repair-count-2'))
  writer.commit()
  fakeServerEnd.send(encode(Frame.Update, writer.exportUpdate()))
  assert.equal(client.repairCount, 2, 'a second genuinely-new Update bumps repairCount again')
}

// --- (8) lastBackfillBytes (Task G5): 0 before the first reconnect; equals
// the EXACT byte length of the full-history Update reconnect() pushes (see
// that method's own doc comment); updates to a NEW length on a LATER
// reconnect (not cumulative -- "last", not "total"). ---
{
  const server = new SyncServerPeer({ peerId: 8n })
  const [serverEnd1, clientEnd1] = makePair()
  server.connect(serverEnd1)
  const client = new SyncClientPeer({ peerId: 801n, transport: clientEnd1 })
  assert.equal(client.lastBackfillBytes, 0, 'a peer that has never reconnected reports 0')

  client.doc.putPage({ id: 'page:p', name: 'P' })
  client.doc.commit()
  client.putShape(shape('shape:before-reconnect'))
  const expectedFirst = client.doc.exportUpdate().byteLength

  const [serverEnd2, clientEnd2] = makePair()
  server.connect(serverEnd2)
  client.reconnect(clientEnd2)
  assert.equal(client.lastBackfillBytes, expectedFirst, 'lastBackfillBytes equals the exact byte length of the pushed full-history Update')
  assert.ok(client.lastBackfillBytes > 0, 'precondition: the doc has real content, so the backfill is non-empty')

  // More content, then a SECOND reconnect: the number changes to reflect the
  // NEW (larger) doc -- proving this is "last", not a running total.
  client.putShape(shape('shape:before-reconnect-2'))
  const expectedSecond = client.doc.exportUpdate().byteLength
  assert.ok(expectedSecond > expectedFirst, 'precondition: the doc grew, so its full-history export is now larger')

  const [serverEnd3, clientEnd3] = makePair()
  server.connect(serverEnd3)
  client.reconnect(clientEnd3)
  assert.equal(client.lastBackfillBytes, expectedSecond, 'a later reconnect overwrites lastBackfillBytes with its own (larger) byte length, not a cumulative sum')
}

// --- (new) ready(): resolves on the server's backfill + SyncDone; empty room
// resolves promptly; and gating page-resolution on it avoids the redundant-page
// race the dogfood settle timer used to paper over. ---
{
  // (a) EMPTY brand-new room still resolves ready() promptly — the server
  // always answers a SyncRequest (even with an empty backfill) + SyncDone.
  {
    const server = new SyncServerPeer({ peerId: 90n })
    const [serverEnd, clientEnd] = makePair()
    server.connect(serverEnd)
    const client = new SyncClientPeer({ peerId: 901n, transport: clientEnd })
    let resolved = false
    client.ready().then(() => { resolved = true })
    await Promise.resolve() // flush microtasks
    assert.ok(resolved, 'ready() resolves for an empty room (server always sends a backfill reply + SyncDone)')
  }

  // (b) THE RACE. Each sub-demo gets its OWN server, seeded identically with a
  // real page 'page:xyz'. They MUST NOT share a server: gatedClientTransport
  // holds only server→client frames — a client's own writes (putPage + commit)
  // fire subscribeLocalUpdates synchronously and pass STRAIGHT THROUGH the gate
  // to the server. A shared server would therefore let the unguarded demo's
  // bootstrapped 'page:p' land on the server before the guarded demo's
  // handshake, contaminating its backfill so canonicalPageId (smallest id)
  // wrongly resolves to 'page:p'. The isolation is load-bearing, not
  // incidental. The page-bootstrap logic client/src/canvas-v2/bootstrap-page.ts
  // runs is replicated inline here (canonicalPageId → bootstrap 'page:p' iff no
  // page is visible) because canvas-sync must never import client code
  // (clean-room boundary).

  // Unguarded (the race): resolve BEFORE the backfill drains -> redundant page.
  {
    const server = new SyncServerPeer({ peerId: 91n })
    server.doc.putPage({ id: 'page:xyz', name: 'Real' })
    server.doc.commit()

    const [serverEndA, clientEndRawA] = makePair()
    server.connect(serverEndA)
    const gateA = gatedClientTransport(clientEndRawA)
    const clientA = new SyncClientPeer({ peerId: 911n, transport: gateA.transport })
    assert.equal(clientA.doc.listPages().length, 0, 'precondition: backfill held, client doc has no pages yet')
    if (!canonicalPageId(clientA.doc.listPages())) { clientA.doc.putPage({ id: 'page:p', name: 'Canvas' }); clientA.doc.commit() }
    gateA.release()
    assert.deepEqual(
      clientA.doc.listPages().map((p) => p.id).sort(),
      ['page:p', 'page:xyz'],
      'resolving the page id BEFORE the backfill drains bootstraps a redundant page:p — the race the fixed settle sleep only guessed at',
    )
  }

  // Guarded (the fix): await ready() first, then resolve -> adopts page:xyz.
  // Its OWN server (peerId 93n) so the unguarded demo's stray 'page:p' write
  // can never leak in (see the block comment above on pass-through sends).
  {
    const server = new SyncServerPeer({ peerId: 93n })
    server.doc.putPage({ id: 'page:xyz', name: 'Real' })
    server.doc.commit()

    const [serverEndB, clientEndRawB] = makePair()
    server.connect(serverEndB)
    const gateB = gatedClientTransport(clientEndRawB)
    const clientB = new SyncClientPeer({ peerId: 912n, transport: gateB.transport })
    const ready = clientB.ready()
    let readyResolved = false
    ready.then(() => { readyResolved = true })
    await Promise.resolve()
    assert.equal(readyResolved, false, 'ready() does NOT resolve while the backfill is held')
    gateB.release()
    await ready
    const existing = canonicalPageId(clientB.doc.listPages())
    if (!existing) { clientB.doc.putPage({ id: 'page:p', name: 'Canvas' }); clientB.doc.commit() }
    assert.equal(existing, 'page:xyz', 'after ready(), the server page is visible and adopted')
    assert.deepEqual(clientB.doc.listPages().map((p) => p.id), ['page:xyz'], 'no redundant page:p when page-resolution is gated on ready()')
  }
}

// --- (new) reconnect() re-arms ready(): a fresh handshake means ready() awaits
// the NEW SyncDone, never a stale resolve from the prior connection. ---
{
  const server = new SyncServerPeer({ peerId: 92n })
  const [serverEnd1, clientEnd1] = makePair()
  server.connect(serverEnd1)
  const client = new SyncClientPeer({ peerId: 921n, transport: clientEnd1 })
  await client.ready() // initial handshake resolves (synchronous memory transport)

  // Reconnect onto a GATED transport so the new backfill is held.
  const [serverEnd2, clientEnd2Raw] = makePair()
  server.connect(serverEnd2)
  const gate = gatedClientTransport(clientEnd2Raw)
  client.reconnect(gate.transport)

  let reReady = false
  client.ready().then(() => { reReady = true })
  await Promise.resolve()
  assert.equal(reReady, false, 'ready() re-arms on reconnect: not resolved until the NEW backfill (SyncDone) arrives')
  gate.release()
  await Promise.resolve()
  assert.equal(reReady, true, 'ready() resolves once the reconnect handshake completes')
}

console.log('ok: client-peer')
