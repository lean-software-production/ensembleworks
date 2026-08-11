// Validator smoke for codespaceShapeProps (SP3): identity-only — gatewayId/
// repo/branch; live state (status/owner/inputPolicy) is DELIBERATELY absent
// (polled from /api/terminal/list, never synced — decision log SP3 item 2).
// Run with: bun src/shapes.test.ts
import assert from 'node:assert/strict'
import { codespaceShapeProps } from './shapes.js'

assert.equal(codespaceShapeProps.w.validate(960), 960)
assert.equal(codespaceShapeProps.h.validate(600), 600)
assert.equal(codespaceShapeProps.gatewayId.validate('codespace-abc'), 'codespace-abc')
assert.equal(codespaceShapeProps.repo.validate('github.com/acme/app'), 'github.com/acme/app')
assert.equal(codespaceShapeProps.branch.validate('main'), 'main')
assert.throws(() => codespaceShapeProps.gatewayId.validate(42), 'gatewayId must be a string')
assert.throws(() => codespaceShapeProps.w.validate('wide'), 'w must be a number')

// Live state must never creep into the synced props.
const keys = Object.keys(codespaceShapeProps).sort()
assert.deepEqual(keys, ['branch', 'gatewayId', 'h', 'repo', 'w'], 'identity-only props')

console.log('ok: codespaceShapeProps — identity-only validators')
