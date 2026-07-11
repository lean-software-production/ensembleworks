// Run: bun src/version.test.ts
import assert from 'node:assert/strict'
import { CANVAS_SYNC_VERSION } from './index.js'

assert.equal(CANVAS_SYNC_VERSION, 1)
console.log('ok: canvas-sync rig')
