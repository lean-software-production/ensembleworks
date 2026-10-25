// Run: bun src/fuzz.test.ts
//
// E2: garbage/truncated/bit-flipped inbound Update payloads must never crash
// SyncServerPeer. The guard (try/catch in onFrame, malformedFrames counter)
// already exists — Unit 7 pulled it forward when a real ws mount made these
// throw sites reachable by adversarial bytes (see server-peer.ts). This file
// builds the fuzz corpus ON TOP of that guard and pins its behavior; it does
// NOT (re-)add the guard. If the corpus ever finds an escape route (a throw
// that gets past the guard), that IS a real finding to fix in server-peer.ts
// in this same commit, red-first.
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { decodeImportBlobMeta } from 'loro-crdt/base64'
import { makePair } from './memory-transport.js'
import { Frame, encode } from './protocol.js'
import { SyncClientPeer } from './client-peer.js'
import { SyncServerPeer } from './server-peer.js'
import { int, mulberry32, pick, type Rng } from './rig/prng.js'
import { applyOp, type ApplyStats } from './rig/ops.js'

const SEED = 1
const CORPUS_SIZE = 1000
const MAX_RANDOM_BYTES = 4096

type Class = 'random' | 'truncated' | 'bitflip'
interface FuzzInput { bytes: Uint8Array; klass: Class }

function randomBytes(rng: Rng, n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = int(rng, 256)
  return out
}

// A real, valid Update export to slice/bit-flip — otherwise "truncated" and
// "bit-flipped" have nothing real to work from.
function buildRealUpdate(rng: Rng, peerId: bigint): Uint8Array {
  const doc = LoroCanvasDoc.create({ peerId })
  doc.putPage({ id: 'page:seed', name: 'Seed' })
  const count = 1 + int(rng, 5)
  for (let i = 0; i < count; i++) {
    doc.putShape({
      id: `shape:seed${i}`, kind: 'note', parentId: 'page:seed', index: `a${i}`,
      x: int(rng, 1000), y: int(rng, 1000), rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
    } as any)
  }
  doc.commit()
  return doc.exportUpdate()
}

function generateCorpus(rng: Rng, size: number, realUpdates: readonly Uint8Array[]): FuzzInput[] {
  const out: FuzzInput[] = []
  for (let i = 0; i < size; i++) {
    const roll = int(rng, 3)
    if (roll === 0) {
      const len = int(rng, MAX_RANDOM_BYTES + 1) // 0..4096 inclusive
      out.push({ bytes: randomBytes(rng, len), klass: 'random' })
    } else if (roll === 1) {
      const src = pick(rng, realUpdates)
      const offset = int(rng, src.length + 1) // 0..src.length inclusive
      out.push({ bytes: src.slice(0, offset), klass: 'truncated' })
    } else {
      const src = pick(rng, realUpdates)
      const copy = src.slice()
      if (copy.length > 0) {
        const flips = 1 + int(rng, 8) // 1..8 bits
        for (let f = 0; f < flips; f++) {
          const byteIdx = int(rng, copy.length)
          const bitIdx = int(rng, 8)
          copy[byteIdx] = copy[byteIdx]! ^ (1 << bitIdx)
        }
      }
      out.push({ bytes: copy, klass: 'bitflip' })
    }
  }
  return out
}

const rng = mulberry32(SEED)
const realUpdates = [buildRealUpdate(rng, 9001n), buildRealUpdate(rng, 9002n), buildRealUpdate(rng, 9003n)]
const corpus = generateCorpus(rng, CORPUS_SIZE, realUpdates)

// One authoritative server + one healthy observer client, connected for the
// whole corpus run — exactly the "one healthy observer connected" setup the
// plan calls for, so a relayed-but-garbage frame exercises the OBSERVER's own
// malformed-frame guard (client-peer.ts) too, not just the server's.
const server = new SyncServerPeer({ peerId: 1n })
const [serverEndFuzzer, clientEndFuzzer] = makePair()
server.connect(serverEndFuzzer)
const [serverEndObserver, clientEndObserver] = makePair()
server.connect(serverEndObserver)
const observer = new SyncClientPeer({ peerId: 2n, transport: clientEndObserver })

let escaped = 0
let metaDecodedOk = 0
let metaThrew = 0
const classCounts: Record<Class, number> = { random: 0, truncated: 0, bitflip: 0 }

// The guard logs a console.warn per dropped frame (server-peer.ts's onFrame)
// — expected and correct, but at ~1000 inputs (most of them malformed by
// construction) that's ~1000 lines of expected noise that would drown out
// `bun run test`'s output. Swallow it for the duration of the corpus only;
// restored immediately after, and NOT touching what's actually asserted
// (server.malformedFrames still counts every drop regardless of logging).
const realWarn = console.warn
console.warn = () => {}
for (const { bytes, klass } of corpus) {
  classCounts[klass]++
  // (1) No throw may escape past SyncServerPeer's own guard. If one does,
  // that's the real finding the plan calls out — this assertion is what
  // would go red first (before any server-peer.ts fix).
  try {
    clientEndFuzzer.send(encode(Frame.Update, bytes))
  } catch (err) {
    escaped++
    console.error('[fuzz] ESCAPED past SyncServerPeer.onFrame\'s guard:', err)
  }
  // (4) Informational only: compare Loro's pre-validation decode against
  // what actually happened above. Not asserted — logged for visibility.
  try { decodeImportBlobMeta(bytes, true); metaDecodedOk++ } catch { metaThrew++ }
}
console.warn = realWarn

assert.equal(escaped, 0, `no throw may escape the peer across the ${CORPUS_SIZE}-input corpus (${escaped} did)`)

// (2) The server doc must still be queryable after the whole corpus.
assert.doesNotThrow(() => server.doc.listShapes(), 'server doc remains queryable after the fuzz corpus')
assert.doesNotThrow(() => server.doc.listBindings(), 'server doc bindings remain queryable after the fuzz corpus')
assert.doesNotThrow(() => server.doc.listPages(), 'server doc pages remain queryable after the fuzz corpus')

// ...and a healthy edit sent right after the corpus still converges to the
// observer — the peer is not just "not crashed" but still fully functional.
const writer = LoroCanvasDoc.create({ peerId: 9099n })
writer.putPage({ id: 'page:post-fuzz', name: 'Post-fuzz' })
writer.putShape({
  id: 'shape:post-fuzz', kind: 'note', parentId: 'page:post-fuzz', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
} as any)
writer.commit()
clientEndFuzzer.send(encode(Frame.Update, writer.exportUpdate()))

assert.ok(
  server.doc.listShapes().some((s) => s.id === 'shape:post-fuzz'),
  'a healthy edit sent right after the corpus is still applied by the server',
)
assert.ok(
  observer.doc.listShapes().some((s) => s.id === 'shape:post-fuzz'),
  'a healthy edit sent right after the corpus still converges to the connected observer',
)

// (3) malformedFrames reflects the rejected count. Some bit-flipped (and even
// some truncated) payloads import SUCCESSFULLY as valid-but-different ops —
// that's legitimate CRDT behavior (Loro's format doesn't checksum every byte
// range the same way), not a failure, so malformedFrames is NOT corpus size
// minus "3 real updates" or any other simple derived count. It IS, however, a
// pure function of (SEED, CORPUS_SIZE, loro-crdt's exact decode behavior) —
// pinned here for the exact pin (loro-crdt 1.13.6, see canvas-sync's
// package.json): a loro-crdt upgrade that changes this number is expected to
// require updating this pin, not a rig bug.
console.log(`fuzz corpus mix: ${JSON.stringify(classCounts)}`)
console.log(`malformedFrames after corpus: ${server.malformedFrames} / ${CORPUS_SIZE}`)
console.log(`decodeImportBlobMeta: ok=${metaDecodedOk}, threw=${metaThrew} (informational only, not asserted)`)
assert.equal(
  server.malformedFrames,
  999,
  'malformedFrames is pinned for SEED=1/CORPUS_SIZE=1000 against loro-crdt 1.13.6 — ' +
  'update this pin (with a comment noting the loro-crdt version) if a deliberate loro-crdt upgrade changes it',
)
assert.ok(server.malformedFrames > CORPUS_SIZE / 4, 'sanity floor: most garbage/truncated/bit-flipped inputs should be rejected, not silently accepted')

console.log('ok: fuzz corpus — garbage/truncated/bit-flipped updates never crash the peer')

// --- OP-LEVEL fuzz: setText on a garbage/vanished shape id ------------------
// Separate concern from everything above: the corpus fuzz just pinned at
// 999/1000 attacks the FRAME/byte-decoding layer (SyncServerPeer.onFrame).
// This attacks the OP layer instead — rig/ops.ts's new 'setText' Op kind,
// applied via applyOp straight against a LoroCanvasDoc, same as the E1
// convergence rig does. canvas-doc.ts's contract is "silent no-op if no shape
// with this id exists" (the same tolerance deleteShape already honors, and
// text.test.ts already unit-covers); this proves that contract holds even
// under adversarial/garbage/vanished ids, not just the one hand-picked
// missing-id case. Uses its OWN PRNG instance (opRng) so it cannot perturb
// the corpus-building `rng` above and, in turn, the pinned malformedFrames
// count — the two fuzzes must stay fully independent.
const opRng = mulberry32(4242)
const opFuzzDoc = LoroCanvasDoc.create({ peerId: 7001n })
opFuzzDoc.putPage({ id: 'page:opfuzz', name: 'OpFuzz' })
opFuzzDoc.putShape({
  id: 'shape:opfuzz-real', kind: 'note', parentId: 'page:opfuzz', index: 'a1',
  x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {},
} as any)
opFuzzDoc.commit()

// Hand-picked edge-case ids: never-existed, empty string, a page id (not a
// shape id at all), a binding id, unicode, and a very long string.
const garbageIds = ['shape:never-existed', 'shape:', '', 'page:p', 'binding:1', 'shape:\u{1F600}-unicode', 'x'.repeat(500)]
for (const id of garbageIds) {
  assert.doesNotThrow(() => opFuzzDoc.setText(id, 'payload'), `setText on garbage id ${JSON.stringify(id)} must not throw`)
}

// Vanished id: a real shape that existed, then got deleted — setText on it
// afterward must stay a no-op, with no text resurrection.
opFuzzDoc.deleteShape('shape:opfuzz-real')
opFuzzDoc.commit()
assert.doesNotThrow(
  () => opFuzzDoc.setText('shape:opfuzz-real', 'after delete'),
  'setText on a just-deleted (vanished) id must not throw',
)
assert.equal(opFuzzDoc.getText('shape:opfuzz-real'), '', 'no text resurrection from setText on a vanished id')

// PRNG-driven garbage ids/text (deterministic, no Math.random) through the
// SAME applyOp path randomOps/convergence uses — proves the op mix's own
// garbage/vanished-id draws (rig/ops.ts's RATE_SET_TEXT band) are tolerated
// end-to-end, not just this hand-picked list.
const opFuzzStats: ApplyStats = { skipped: 0 }
for (let i = 0; i < 200; i++) {
  const id = opRng() < 0.5 ? `shape:garbage-${int(opRng, 1_000_000)}` : pick(opRng, [...garbageIds, 'shape:opfuzz-real'])
  const text = `t${int(opRng, 1_000_000)}`
  assert.doesNotThrow(
    () => applyOp(opFuzzDoc, { kind: 'setText', id, text }, opFuzzStats),
    `applyOp(setText) on ${JSON.stringify(id)} must not throw`,
  )
}
assert.doesNotThrow(() => opFuzzDoc.listShapes(), 'doc remains queryable after op-level setText fuzz')
assert.doesNotThrow(() => opFuzzDoc.getText('shape:opfuzz-real'), 'doc text reads remain queryable after op-level setText fuzz')

console.log('ok: fuzz op-level — setText on garbage/vanished shape ids never crashes the host')
