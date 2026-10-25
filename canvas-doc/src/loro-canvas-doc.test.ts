// Run: bun src/loro-canvas-doc.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
// Snapshot of an empty doc round-trips into a fresh doc.
const snap = doc.exportSnapshot()
const doc2 = LoroCanvasDoc.fromSnapshot(snap, { peerId: 2n })
assert.deepEqual(doc2.listShapes(), [])
console.log('ok: canvas-doc skeleton')
