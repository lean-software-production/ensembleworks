// Run: bun src/server-peer.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { checkInvariants, type CanvasDocument } from '@ensembleworks/canvas-model'
import { makePair } from './memory-transport.js'
import { Frame, decode, encode, type Transport } from './protocol.js'
import { SyncServerPeer } from './server-peer.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })
const shape = (id: string, over: any = {}) =>
  ({ id, kind: 'note', parentId: 'page:p', props: {}, ...base(), ...over }) as any

// Normalize for cross-peer comparison: Loro list order need not match array
// order across independently-built docs — sort by id (same approach as the
// plan's convergence `diverges` helper).
const byIdAsc = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
const normalize = (m: CanvasDocument) => ({
  pages: [...m.pages].sort(byIdAsc),
  shapes: [...m.shapes].sort(byIdAsc),
  bindings: [...m.bindings].sort(byIdAsc),
})

// B3 doesn't exist yet at this point in the build order (B4 lands first), so
// this is a minimal hand-rolled "client": a raw LoroCanvasDoc wired to a
// Transport the same way SyncClientPeer will be — forward committed local
// updates as Frame.Update, apply incoming Frame.Update with import+repair+commit.
function wireFakeClient(t: Transport, peerId: bigint): LoroCanvasDoc {
  const doc = LoroCanvasDoc.create({ peerId })
  doc.subscribeLocalUpdates((bytes) => t.send(encode(Frame.Update, bytes)))
  t.onMessage((frame) => {
    const { tag, payload } = decode(frame)
    if (tag === Frame.Update) { doc.import(payload); doc.repair(); doc.commit() }
  })
  return doc
}

// --- (1) two clients + server: A's write converges to the server AND to B ---
{
  const server = new SyncServerPeer({ peerId: 1n })
  const [serverEndA, clientEndA] = makePair()
  const [serverEndB, clientEndB] = makePair()
  server.connect(serverEndA)
  server.connect(serverEndB)
  const clientA = wireFakeClient(clientEndA, 101n)
  const clientB = wireFakeClient(clientEndB, 102n)

  clientA.putShape(shape('shape:a1'))
  clientA.commit() // -> Frame.Update to server -> server imports/repairs/commits -> relays to B

  assert.deepEqual(
    normalize(dumpModel(server.doc)),
    normalize(dumpModel(clientA)),
    'server converges with the writer',
  )
  assert.deepEqual(
    normalize(dumpModel(clientB)),
    normalize(dumpModel(clientA)),
    'the other client converges too, via server relay',
  )
}

// --- (2) SyncRequest rebase: a fresh client with a stale (empty) version gets
// exactly the missing delta and converges ---
{
  const server = new SyncServerPeer({ peerId: 2n })
  // Seed the server directly (as if written before this client ever connected).
  server.doc.putPage({ id: 'page:p', name: 'P' })
  server.doc.putShape(shape('shape:seed'))
  server.doc.commit()

  const [serverEnd, clientEnd] = makePair()
  server.connect(serverEnd)
  const clientDoc = LoroCanvasDoc.create({ peerId: 201n })
  clientEnd.onMessage((frame) => {
    const { tag, payload } = decode(frame)
    if (tag === Frame.Update) { clientDoc.import(payload); clientDoc.repair(); clientDoc.commit() }
  })
  // The rebase handshake: tell the server what we have (nothing).
  clientEnd.send(encode(Frame.SyncRequest, clientDoc.versionBytes()))

  assert.deepEqual(
    normalize(dumpModel(clientDoc)),
    normalize(dumpModel(server.doc)),
    'fresh client catches up to exactly the server state via one SyncRequest/Update round-trip',
  )
}

// --- (3) concurrent convergence: the same two updates delivered to two fresh
// servers in OPPOSITE orders converge to byte-identical normalized state ---
{
  const docX = LoroCanvasDoc.create({ peerId: 11n })
  docX.putPage({ id: 'page:p', name: 'P' })
  docX.putShape(shape('shape:x'))
  docX.commit()
  const updateX = docX.exportUpdate()

  const docY = LoroCanvasDoc.create({ peerId: 12n })
  docY.putPage({ id: 'page:p', name: 'P' })
  docY.putShape(shape('shape:y'))
  docY.commit()
  const updateY = docY.exportUpdate()

  const serverXY = new SyncServerPeer({ peerId: 21n })
  const [sXY, cXY] = makePair()
  serverXY.connect(sXY)
  cXY.send(encode(Frame.Update, updateX))
  cXY.send(encode(Frame.Update, updateY))

  const serverYX = new SyncServerPeer({ peerId: 22n })
  const [sYX, cYX] = makePair()
  serverYX.connect(sYX)
  cYX.send(encode(Frame.Update, updateY))
  cYX.send(encode(Frame.Update, updateX))

  assert.deepEqual(
    normalize(dumpModel(serverXY.doc)),
    normalize(dumpModel(serverYX.doc)),
    'delivery order does not affect converged state',
  )
  assert.deepEqual(checkInvariants(dumpModel(serverXY.doc)), [], 'converged state is invariant-clean')
}

// --- (4) a merge introduces a violation (concurrent binding-to-deleted-shape);
// repair (run automatically after every Update) leaves checkInvariants empty ---
{
  const seed = LoroCanvasDoc.create({ peerId: 31n })
  seed.putPage({ id: 'page:p', name: 'P' })
  seed.putShape(shape('shape:a'))
  seed.putShape(shape('shape:b'))
  seed.commit()
  const seedSnapshot = seed.exportSnapshot()
  const seedVersion = seed.versionBytes()

  const server = new SyncServerPeer({ peerId: 30n, initialSnapshot: seedSnapshot })

  // Two peers fork from the SAME seed state and diverge concurrently: one
  // deletes shape:b, the other adds a binding pointing AT shape:b (which still
  // exists in its own view — not dangling when it was written).
  const docDelete = LoroCanvasDoc.fromSnapshot(seedSnapshot, { peerId: 32n })
  docDelete.deleteShape('shape:b')
  docDelete.commit()
  const deleteDelta = docDelete.exportUpdate(seedVersion)

  const docBind = LoroCanvasDoc.fromSnapshot(seedSnapshot, { peerId: 33n })
  docBind.putBinding({ id: 'binding:ab', fromId: 'shape:a', toId: 'shape:b', props: {}, meta: {} })
  docBind.commit()
  const bindDelta = docBind.exportUpdate(seedVersion)

  const [sEnd, cEnd] = makePair()
  server.connect(sEnd)
  cEnd.send(encode(Frame.Update, deleteDelta))
  cEnd.send(encode(Frame.Update, bindDelta)) // merges in a binding whose toId is already gone on the server

  assert.deepEqual(
    checkInvariants(dumpModel(server.doc)),
    [],
    'server auto-repairs after every Update — no dangling binding survives',
  )
  assert.deepEqual(server.doc.listBindings(), [], 'the dangling binding was swept by repair')
}

// --- (5) redundant Update frames are NOT re-relayed: a delta the server has
// already applied (changed: false) means every client already got those ops
// (the server relayed/broadcast them when it FIRST applied them), so relaying
// again only multiplies waste ---
{
  const server = new SyncServerPeer({ peerId: 5n })
  const [senderServerEnd, senderClientEnd] = makePair()
  const [observerServerEnd, observerClientEnd] = makePair()
  server.connect(senderServerEnd)
  server.connect(observerServerEnd)

  let observerFrames = 0
  observerClientEnd.onMessage(() => observerFrames++)

  const writer = LoroCanvasDoc.create({ peerId: 501n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:once'))
  writer.commit()
  const delta = writer.exportUpdate()

  senderClientEnd.send(encode(Frame.Update, delta))
  assert.equal(observerFrames, 1, 'first delivery relays to the observer exactly once')

  // Same bytes again (stale channel / reconnect backfill double-delivery).
  senderClientEnd.send(encode(Frame.Update, delta))
  assert.equal(observerFrames, 1, 'a no-op (changed: false) import is not re-relayed')
  assert.deepEqual(
    server.doc.listShapes().map((s) => s.id),
    ['shape:once'],
    'server state untouched by the redundant delivery',
  )
}

// --- (5b) out-of-order deltas: a PENDING import also reports changed: false,
// but unlike a no-op the server does NOT hold those ops — the frame must
// still be relayed so fully-connected observers can pend it identically and
// converge when the gap-filler arrives. (Reviewer-demonstrated stranding:
// skipping the relay on pending left an observer permanently one shape
// short, because the later gap-filling relay only carries the gap-filler's
// own bytes.) ---
{
  const server = new SyncServerPeer({ peerId: 55n })
  const [senderServerEnd, senderClientEnd] = makePair()
  const [observerServerEnd, observerClientEnd] = makePair()
  server.connect(senderServerEnd)
  server.connect(observerServerEnd)
  const observer = wireFakeClient(observerClientEnd, 551n)

  const writer = LoroCanvasDoc.create({ peerId: 552n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:first'))
  writer.commit()
  const delta1 = writer.exportUpdate()
  const v1 = writer.versionBytes()
  writer.putShape(shape('shape:second'))
  writer.commit()
  const delta2 = writer.exportUpdate(v1) // depends on delta1's history

  assert.equal(server.pendingImports, 0, 'pending-imports counter starts at zero')
  senderClientEnd.send(encode(Frame.Update, delta2)) // arrives FIRST: server must pend it
  assert.equal(server.pendingImports, 1, 'the out-of-order delta is counted as a pending import')
  senderClientEnd.send(encode(Frame.Update, delta1)) // gap-filler: server applies both

  assert.deepEqual(
    server.doc.listShapes().map((s) => s.id).sort(),
    ['shape:first', 'shape:second'],
    'server converges once the gap fills',
  )
  assert.deepEqual(
    observer.listShapes().map((s) => s.id).sort(),
    ['shape:first', 'shape:second'],
    'a fully-connected observer converges too — the pending frame was relayed, not swallowed',
  )
}

// --- (6) close() is a REAL close: transports dropped, connect-after-close
// throws, in-flight frames after close are ignored (not misuse — a real ws
// can deliver buffered frames post-close), double-close is safe ---
{
  // A fake transport whose deliver() bypasses the closed flag, simulating a
  // ws that flushes buffered frames after the app-level close.
  const fakeTransport = () => {
    let msgCb: ((b: Uint8Array) => void) | null = null
    let closeCb: (() => void) | null = null
    let closed = false
    const t: Transport = {
      send: () => {},
      onMessage: (cb) => { msgCb = cb },
      onClose: (cb) => { closeCb = cb },
      close: () => { if (!closed) { closed = true; closeCb?.() } },
    }
    return { t, deliver: (b: Uint8Array) => msgCb?.(b), isClosed: () => closed }
  }

  const server = new SyncServerPeer({ peerId: 7n })
  const f = fakeTransport()
  server.connect(f.t)

  server.close()
  assert.ok(f.isClosed(), 'close() closes every connected transport')
  assert.doesNotThrow(() => server.close(), 'close() is idempotent')

  // A buffered frame arriving after close must not mutate the doc.
  const writer = LoroCanvasDoc.create({ peerId: 701n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:late'))
  writer.commit()
  f.deliver(encode(Frame.Update, writer.exportUpdate()))
  assert.deepEqual(server.doc.listShapes(), [], 'a post-close inbound Update is dropped, not applied')

  // Lifecycle misuse is loud (fail-loud house convention).
  const [extra] = makePair()
  assert.throws(() => server.connect(extra), /SyncServerPeer is closed/, 'connect after close throws')
}

// --- (7) onUpdatePayload: the durability hook (Task C2's persistence seam).
// Fired with the raw inbound payload BEFORE relay whenever the frame may
// carry ops the server does not durably hold (changed OR pending); NOT fired
// for no-op imports. Replaying the captured log into a fresh doc must
// reconstruct the state — the recovery-correctness pin that would have
// caught the plan's C2 hole (subscribeLocalUpdates never fires on imports,
// so client edits were never logged). ---

// (a) + (b): changed Update fires exactly once, byte-identical, BEFORE the
// observer receives the relay; a redundant re-import does not fire it.
{
  const seq: string[] = []
  const persisted: Uint8Array[] = []
  const server = new SyncServerPeer({
    peerId: 8n,
    onUpdatePayload: (payload) => {
      seq.push('persist')
      persisted.push(payload.slice()) // decode() payload aliases the frame buffer — copy to retain
    },
  })
  const [senderServerEnd, senderClientEnd] = makePair()
  const [observerServerEnd, observerClientEnd] = makePair()
  server.connect(senderServerEnd)
  server.connect(observerServerEnd)
  observerClientEnd.onMessage(() => seq.push('observer-recv'))

  const writer = LoroCanvasDoc.create({ peerId: 801n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:d1'))
  writer.commit()
  const delta1 = writer.exportUpdate()

  senderClientEnd.send(encode(Frame.Update, delta1))
  assert.deepEqual(seq, ['persist', 'observer-recv'], 'persist fires BEFORE the observer receives the relay')
  assert.equal(persisted.length, 1, 'a changed Update fires the hook exactly once')
  assert.deepEqual(persisted[0], delta1, 'the hook receives the byte-identical raw payload')

  // (b) redundant re-import (same bytes): ops already durably held — the
  // reconnect full-history backfill must not bloat the append-log.
  senderClientEnd.send(encode(Frame.Update, delta1))
  assert.equal(persisted.length, 1, 'a no-op import does not fire the durability hook')
}

// (c) out-of-order pending: BOTH frames fire the hook (delta2 pending, then
// delta1 changed), and replaying the captured log IN LOG ORDER into a fresh
// doc reconstructs both shapes — recovery survives an out-of-order log.
{
  const persisted: Uint8Array[] = []
  const server = new SyncServerPeer({
    peerId: 9n,
    onUpdatePayload: (payload) => persisted.push(payload.slice()),
  })
  const [senderServerEnd, senderClientEnd] = makePair()
  server.connect(senderServerEnd)

  const writer = LoroCanvasDoc.create({ peerId: 901n })
  writer.putPage({ id: 'page:p', name: 'P' })
  writer.putShape(shape('shape:first'))
  writer.commit()
  const delta1 = writer.exportUpdate()
  const v1 = writer.versionBytes()
  writer.putShape(shape('shape:second'))
  writer.commit()
  const delta2 = writer.exportUpdate(v1) // depends on delta1's history

  senderClientEnd.send(encode(Frame.Update, delta2)) // pending on the server
  senderClientEnd.send(encode(Frame.Update, delta1)) // gap-filler
  assert.equal(persisted.length, 2, 'BOTH frames fire the hook — a pending payload is not durably held anywhere else')

  // Recovery: replay the log in captured (out-of-causal) order.
  const recovered = LoroCanvasDoc.create({ peerId: 902n })
  for (const bytes of persisted) recovered.import(bytes)
  recovered.commit()
  assert.deepEqual(
    recovered.listShapes().map((s) => s.id).sort(),
    ['shape:first', 'shape:second'],
    'replaying the append-log (pended frame first) reconstructs the full state',
  )
}

console.log('ok: server-peer')
