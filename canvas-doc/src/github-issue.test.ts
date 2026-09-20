// Run: bun src/github-issue.test.ts
import assert from 'node:assert/strict'
import { cloneWithNewIds, decodeClipboard, encodeClipboard, serializeSelection, validateShape } from '@ensembleworks/canvas-model'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const shape = {
  id: 'shape:issue', kind: 'github-issue', parentId: 'page:p', index: 'a1', x: 15, y: 25,
  rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { w: 470, h: 256, schemaVersion: 1, repo: 'owner/repo', number: 42 },
}
assert.ok(validateShape(shape).ok)
const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putPage({ id: 'page:p', name: 'P' })
doc.putShape(shape as any)
doc.commit()
const restored = LoroCanvasDoc.fromSnapshot(doc.exportSnapshot(), { peerId: 2n })
assert.deepEqual(restored.getShape(shape.id), shape, 'snapshot retains identity/layout only')
const payload = serializeSelection([restored.getShape(shape.id)!], [], [shape.id])
const copy = decodeClipboard(encodeClipboard(payload))
assert.ok(copy)
assert.deepEqual(copy.shapes[0]?.props, shape.props, 'copy/paste payload retains identity/layout only')
const pasted = cloneWithNewIds(copy, () => 'shape:issue-copy', () => 'binding:unused', 'page:p', { x: 20, y: 20 })
assert.deepEqual(pasted.shapes[0]?.props, shape.props, 'pasted card keeps identity without remote issue details')
assert.equal(pasted.shapes[0]?.id, 'shape:issue-copy', 'pasted card has independent layout identity')
console.log('ok: GitHub issue card snapshot and copy/paste preserve identity/layout')
