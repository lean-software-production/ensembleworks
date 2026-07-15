// Run: bun src/version.test.ts
import assert from 'node:assert/strict'
import { CANVAS_REACT_VERSION } from './index.js'

assert.equal(CANVAS_REACT_VERSION, 1)
console.log('ok: canvas-react rig')
