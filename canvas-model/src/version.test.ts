// Run: bun src/version.test.ts
import assert from 'node:assert/strict'
import { CANVAS_MODEL_VERSION } from './index.js'

assert.equal(CANVAS_MODEL_VERSION, 1)
console.log('ok: canvas-model rig')
