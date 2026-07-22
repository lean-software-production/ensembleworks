/**
 * Run: bun client/src/canvas-health/modalCopy.test.ts
 *
 * The modal's rendering is trivial JSX; its one decision is the copy — which
 * transports the headline names. Extracted as a pure function so it is
 * testable without react-dom (and without dragging tldraw into a bare-bun
 * process, which hangs on exit — see client/src/av/bridge.ts's header).
 */
import assert from 'node:assert/strict'
import { blockedSummary, transportLabel } from './CanvasBlockerModal'

assert.equal(transportLabel('canvas'), 'Canvas')
assert.equal(transportLabel('terminals'), 'Terminals')
assert.equal(transportLabel('livekit'), 'Video')

assert.equal(blockedSummary([]), 'Checking your connection…')
assert.equal(blockedSummary(['canvas']), 'Canvas sync is not reaching the server.')
assert.equal(blockedSummary(['terminals']), 'Terminals are not reaching the server.')
assert.equal(blockedSummary(['canvas', 'terminals']), 'Canvas sync and terminals are not reaching the server.')

console.log('modalCopy.test.ts: all assertions passed')
