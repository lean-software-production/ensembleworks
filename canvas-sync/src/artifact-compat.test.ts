// Run: bun src/artifact-compat.test.ts
//
// Canvas artifact viewer, stage 1a (the compatibility reader): an `artifact`
// shape written by one peer must survive the whole sync path — the server's
// import+repair, the relay to another client and that client's own repair,
// and a server restart from its snapshot followed by repair. Every hop runs
// repair(), and repair() drops any shape whose kind or props this build does
// not know, so a reader that lacks the kind silently deletes it on the next
// commit. This is the property the version gate exists to protect.
import assert from 'node:assert/strict'
import { dumpModel } from '@ensembleworks/canvas-doc'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'
import { SyncServerPeer } from './server-peer.js'
import { base } from './test-helpers.js'

const props = {
  w: 720, h: 540, schemaVersion: 1, source: 'thread-storage',
  threadId: 'thr_fixture01', path: 'reports/deck/index.html', title: 'Launch deck',
}
const artifact = { id: 'shape:art', kind: 'artifact', parentId: 'page:p', props, ...base() } as never

const server = new SyncServerPeer({ peerId: 1n })
const [serverEndA, clientEndA] = makePair()
const [serverEndB, clientEndB] = makePair()
server.connect(serverEndA)
server.connect(serverEndB)
const writer = new SyncClientPeer({ peerId: 101n, transport: clientEndA })
const reader = new SyncClientPeer({ peerId: 102n, transport: clientEndB })

writer.doc.putPage({ id: 'page:p', name: 'P' })
writer.doc.commit()
// Seed a future writer's persisted history using the test-only raw helper.
// Release N's public putShape must refuse origination while imports preserve it.
writer.doc.putShapeUnchecked(artifact)
writer.doc.commit()

assert.deepEqual(writer.doc.getShape('shape:art')?.props, props, 'the writer keeps its own artifact')
assert.deepEqual(server.doc.getShape('shape:art')?.props, props, 'the server keeps the artifact through import + repair')
assert.deepEqual(reader.doc.getShape('shape:art')?.props, props, 'the other client keeps the relayed artifact')

// An explicit extra repair pass on every peer is a no-op for the artifact.
for (const [name, doc] of [['writer', writer.doc], ['server', server.doc], ['reader', reader.doc]] as const) {
  assert.deepEqual(doc.repair(), [], `${name}: repair has nothing to do`)
  doc.commit()
  assert.deepEqual(doc.getShape('shape:art')?.props, props, `${name}: artifact intact after repair`)
}

// A server restart from its snapshot (the room host's reload path) keeps it too.
const restarted = new SyncServerPeer({ peerId: 1n, initialSnapshot: server.snapshot() })
assert.deepEqual(restarted.doc.repair(), [], 'restarted server: repair has nothing to do')
restarted.doc.commit()
assert.deepEqual(restarted.doc.getShape('shape:art')?.props, props, 'restarted server keeps the artifact')
assert.equal(dumpModel(restarted.doc).shapes.length, 1)

writer.close()
reader.close()
console.log('ok: artifact survives sync, relay, repair and server restart')
