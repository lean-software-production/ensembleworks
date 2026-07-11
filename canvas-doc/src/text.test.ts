// Run: bun src/text.test.ts
import assert from 'node:assert/strict'
import { LoroCanvasDoc } from './loro-canvas-doc.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as any)
doc.setText('shape:n', 'hello')
doc.commit()
assert.equal(doc.getText('shape:n'), 'hello')
doc.setText('shape:n', 'hello world')
assert.equal(doc.getText('shape:n'), 'hello world')

// --- contract: setText no-ops on a missing shape id ---
assert.doesNotThrow(() => doc.setText('shape:missing', 'nope'))

// --- contract: getText on a missing shape returns '' ---
assert.equal(doc.getText('shape:missing'), '')

console.log('ok: text')
