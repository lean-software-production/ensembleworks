// Run: bun src/canvas-v2/shapes/interactionMode.test.ts
// Pure state-machine coverage for the shared interactive-content event
// policy (see interactionMode.ts's module header for the policy itself).
// No React/DOM — the reducer + predicate are plain functions.
import assert from 'node:assert/strict'
import { reduceInteractionMode, shouldSwallowEvents, type InteractionMode } from './interactionMode.js'

// idle -> focus-request -> focused
assert.equal(reduceInteractionMode('idle', 'focus-request'), 'focused', 'a focus-request from idle enters focused')

// focused -> exit-request -> idle
assert.equal(reduceInteractionMode('focused', 'exit-request'), 'idle', 'an exit-request from focused returns to idle')

// idempotent no-ops
assert.equal(reduceInteractionMode('idle', 'exit-request'), 'idle', 'an exit-request while already idle is a no-op')
assert.equal(reduceInteractionMode('focused', 'focus-request'), 'focused', 'a focus-request while already focused is a no-op')

// every (mode, event) pair is defined (total function) — exhaustive table
const modes: InteractionMode[] = ['idle', 'focused']
const events = ['focus-request', 'exit-request'] as const
for (const m of modes) {
  for (const e of events) {
    const next = reduceInteractionMode(m, e)
    assert.ok(next === 'idle' || next === 'focused', `reduceInteractionMode(${m}, ${e}) must return a valid mode, got ${String(next)}`)
  }
}

// shouldSwallowEvents: the single predicate every body's handlers consult
assert.equal(shouldSwallowEvents('idle'), false, 'idle never swallows events — clicks/keys reach the canvas')
assert.equal(shouldSwallowEvents('focused'), true, 'focused swallows events — typing/dragging inside the body stays local')

console.log('ok: interactionMode — pure transition table + swallow predicate')
