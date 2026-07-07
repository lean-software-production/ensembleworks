// classifyBackpressure thresholds: warn at 1MB, close at 4MB.
// Run with: bun src/sync-backpressure.test.ts
import assert from 'node:assert/strict'
import { SYNC_BUFFER_CLOSE, SYNC_BUFFER_WARN, classifyBackpressure } from './sync-backpressure.ts'

assert.equal(classifyBackpressure(0), 'ok')
assert.equal(classifyBackpressure(SYNC_BUFFER_WARN - 1), 'ok')
assert.equal(classifyBackpressure(SYNC_BUFFER_WARN), 'warn')
assert.equal(classifyBackpressure(SYNC_BUFFER_CLOSE - 1), 'warn')
assert.equal(classifyBackpressure(SYNC_BUFFER_CLOSE), 'close')

console.log('ok: sync-backpressure')
