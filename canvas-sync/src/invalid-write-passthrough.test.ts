// Run: bun src/invalid-write-passthrough.test.ts
// Review finding 1: SyncClientPeer builds its own LoroCanvasDoc internally, so
// unless SyncClientOpts forwards onInvalidWrite the injected sink is
// UNREACHABLE in the browser — where essentially every rejection originates
// (Editor.applyAll -> applyOne -> doc.putShape). Without this passthrough the
// bounded console.warn is not a fallback, it is the only production behaviour.
//
// Spec-review finding (2026-07-20): the first version of this test routed
// every write through `peer.putShape`, which a PEER-LEVEL wrapper can
// intercept exactly as easily as a real construction-time forward — a mutant
// that has `SyncClientPeer.putShape` watch `doc.invalidWriteCount` and call
// the sink itself, WITHOUT ever passing `onInvalidWrite` into
// `LoroCanvasDoc.create`, passed this file unchanged. Assertions A, B and C
// below close that: A writes through `peer.doc` directly, a path a
// peer-level wrapper never sees; B proves the injected sink REPLACES the
// doc's own console.warn fallback (canvas-doc.ts:41-43: "When none is
// supplied the doc warns on the console instead") rather than merely
// running alongside it — a peer-level relay leaves the doc's own handler
// unset, so both fire; C proves the sink-absent arm of that same contract,
// which a `?? (() => {})` default would silently break for every
// sink-less call site.
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

  // --- A: bypass the peer wrapper entirely --------------------------------
  // A peer-level `putShape` interceptor (the mutant described above) never
  // observes a write made straight through `peer.doc` — only a real forward
  // (onInvalidWrite reaching LoroCanvasDoc.create) puts the sink in the
  // doc's own rejection path, which `peer.doc.putShape` hits directly.
  const seenBeforeDocWrite = seen.length
  peer.doc.putShape({ id: 'shape:bad2', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
  peer.doc.commit()
  assert.equal(seen.length - seenBeforeDocWrite, 1, 'A: doc-level write reached the injected sink')

  peer.close()
}

// --- B: the injected sink REPLACES the console.warn fallback -------------
// canvas-doc.ts:41-43 documents the fallback as an ELSE branch ("When none
// is supplied the doc warns on the console instead"). A real forward must
// therefore produce a sink call with NO warning; the mutant — which relays
// through the peer while leaving the doc's own onInvalidWrite unset —
// produces both, because the doc still thinks no handler was supplied.
{
  const seen: InvalidWrite[] = []
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const [, clientEnd] = makePair()
    const peer = new SyncClientPeer({
      peerId: 3n,
      transport: clientEnd,
      onInvalidWrite: (w) => seen.push(w),
    })
    peer.doc.putPage({ id: 'page:p', name: 'P' })
    peer.putShape({ id: 'shape:bad3', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(seen.length, 1, 'the sink fired')
    peer.close()
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 0, 'B: the doc used the injected sink INSTEAD of its console.warn fallback')
}

// --- C: omitting the sink leaves the console.warn fallback intact --------
// Omitting the sink stays legal, and this is the assertion that keeps it so:
// every existing `new SyncClientPeer` call site in the repo passes only
// peerId/transport/presence, and none of them should have to change. Mirrors
// B in the other direction: canvas-doc.ts:41-43's fallback ("When none is
// supplied the doc warns on the console instead") only holds if the peer's
// forward is the ACTUAL `onInvalidWrite` value, undefined included — a
// mutant that defaults a missing sink to a no-op function before forwarding
// it (`opts.onInvalidWrite ?? (() => {})`) still satisfies `invalidWriteCount
// === 0` below (that counter increments regardless of a handler), but it
// silently kills the console.warn fallback for every sink-less call site,
// because the doc now believes a handler WAS supplied. Only performing an
// invalid write and checking the warning actually fired can catch that.
{
  const warned: unknown[][] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const [, clientEnd] = makePair()
    const peer = new SyncClientPeer({ peerId: 2n, transport: clientEnd })
    assert.equal(peer.doc.invalidWriteCount, 0, 'no invalid writes have happened yet')
    peer.doc.putPage({ id: 'page:p', name: 'P' })
    peer.putShape({ id: 'shape:bad4', kind: 'frame', parentId: 'page:p', props: { w: '100' }, ...base() } as never)
    assert.equal(peer.doc.invalidWriteCount, 1, 'the rejection was still counted')
    peer.close()
  } finally {
    console.warn = realWarn // restore even if an assertion throws
  }
  assert.equal(warned.length, 1, 'C: no sink supplied ⇒ the doc used its console.warn fallback')
}

console.log('ok: invalid-write-passthrough')
