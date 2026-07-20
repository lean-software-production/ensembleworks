// Run: bun src/write-validation.test.ts
// The write boundary (Task 1-4): LoroCanvasDoc rejects locally-originated
// writes that would put a shape into a state repair() would later judge
// invalid, reporting each rejection through a counter and an injectable hook
// instead of throwing (see docs/plans/2026-07-19-v2-write-path-validation.md,
// decision D1).
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'
import type { InvalidWrite } from './canvas-doc.js'

const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} });

// --- Task 1/1A: the reporting surface exists, is named unambiguously, starts empty ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 1n, onInvalidWrite: (w) => seen.push(w) })
  assert.equal(doc.invalidWriteCount, 0, 'a fresh doc has rejected nothing')
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(doc.invalidWriteCount, 0, 'a valid write is not counted as a rejection')
  assert.deepEqual(seen, [], 'a valid write does not fire the hook')
}

// --- Task 1A finding 4: the OLD getter name is gone, not merely aliased ---
{
  const doc = LoroCanvasDoc.create({ peerId: 11n })
  assert.equal(
    (doc as unknown as Record<string, unknown>).invalidWrites,
    undefined,
    'the old `invalidWrites` name is removed — it collided with the InvalidWrite type',
  )
}

// --- Task 1B finding 3: the backing field follows the repairCounter pattern ---
// Field <noun>Counter / getter <noun>Count, matching client-peer.ts's
// repairCounter/repairCount. Pinned so the pair cannot drift apart again.
{
  const doc = LoroCanvasDoc.create({ peerId: 15n })
  assert.equal(doc.invalidWriteCount, 0, 'the getter is invalidWriteCount')
  assert.equal(
    (doc as unknown as Record<string, unknown>).writeRejections,
    undefined,
    'the interim `writeRejections` field name is gone',
  )
}

console.log('ok: write-validation')
