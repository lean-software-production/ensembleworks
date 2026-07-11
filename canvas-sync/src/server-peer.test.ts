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

console.log('ok: server-peer')
