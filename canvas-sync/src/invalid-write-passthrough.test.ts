// Run: bun src/invalid-write-passthrough.test.ts
// Review finding 1: SyncClientPeer builds its own LoroCanvasDoc internally, so
// unless SyncClientOpts forwards onInvalidWrite the injected sink is
// UNREACHABLE in the browser — where essentially every rejection originates
// (Editor.applyAll -> applyOne -> doc.putShape). Without this passthrough the
// bounded console.warn is not a fallback, it is the only production behaviour.
import assert from 'node:assert/strict'
import type { InvalidWrite } from '@ensembleworks/canvas-doc'
import { SyncClientPeer } from './client-peer.js'
import { makePair } from './memory-transport.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

{
  const seen: InvalidWrite[] = []
  // makePair() returns [serverEnd, clientEnd]; this test never drives the
  // server end, so it is discarded. Same construction as client-peer.test.ts.
  const [, clientEnd] = makePair()
  const peer = new SyncClientPeer({
    peerId: 1n,
    transport: clientEnd,
    onInvalidWrite: (w) => seen.push(w),
  })
  peer.doc.putPage({ id: 'page:p', name: 'P' })
  peer.putShape({ id: 'shape:bad', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)

  assert.equal(seen.length, 1, 'the sink injected into the PEER reached the doc it built internally')
  assert.equal(seen[0]!.op, 'putShape')
  assert.equal(seen[0]!.kind, 'frame')
  // SyncClientPeer.doc is already `readonly` and public, so a dashboard can
  // pull the count without any further surface change.
  assert.equal(peer.doc.invalidWriteCount, 1, 'the count is readable through the public doc')
  peer.close()
}

// Omitting the sink stays legal, and this is the assertion that keeps it so:
// every one of the ~50 existing `new SyncClientPeer` call sites in the repo
// passes only peerId/transport/presence, and none of them should have to change.
{
  const [, clientEnd] = makePair()
  const peer = new SyncClientPeer({ peerId: 2n, transport: clientEnd })
  assert.equal(peer.doc.invalidWriteCount, 0)
  peer.close()
}

console.log('ok: invalid-write-passthrough')
