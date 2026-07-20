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

// --- Task 1: the reporting surface exists and starts empty ---
{
  const seen: InvalidWrite[] = []
  const doc = LoroCanvasDoc.create({ peerId: 1n, onInvalidWrite: (w) => seen.push(w) })
  assert.equal(doc.invalidWrites, 0, 'a fresh doc has rejected nothing')
  doc.putPage({ id: 'page:p', name: 'P' })
  doc.putShape({ id: 'shape:ok', kind: 'note', parentId: 'page:p', props: {}, ...base() } as never)
  assert.equal(doc.invalidWrites, 0, 'a valid write is not counted as a rejection')
  assert.deepEqual(seen, [], 'a valid write does not fire the hook')
}

console.log('ok: write-validation')
