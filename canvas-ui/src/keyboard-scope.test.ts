// Run: bun src/keyboard-scope.test.ts
// Pins which keydown targets count as canvas shortcuts. A body-targeted
// keydown belongs to the canvas only when the canvas was the last thing the
// user pointed at or focused: in bb's split layout, clicking plain text in
// another pane also leaves focus on body, and Backspace there must not delete
// the canvas selection.
import assert from 'node:assert/strict'
import { isKeyTargetInScope } from './keyboard-scope.js'

const inside = { name: 'shape button' }
const otherPane = { name: 'thread text' }
const body = { name: 'body' }
const scope = { contains: (node: unknown) => node === inside }

const s = scope as unknown as Element
const b = body as unknown as Element

assert.equal(isKeyTargetInScope(inside as unknown as EventTarget, s, b, false), true, 'a target inside the scope is in scope')
assert.equal(isKeyTargetInScope(b, s, b, true), true, 'body counts when the canvas had the last interaction')
assert.equal(isKeyTargetInScope(null, s, b, true), true, 'a null target counts when the canvas had the last interaction')
assert.equal(isKeyTargetInScope(b, s, b, false), false, 'body does not count after interacting outside the canvas')
assert.equal(isKeyTargetInScope(null, s, b, false), false, 'a null target does not count after interacting outside the canvas')
assert.equal(isKeyTargetInScope(otherPane as unknown as EventTarget, s, b, true), false, 'another pane element is never in scope')
assert.equal(isKeyTargetInScope(b, null, b, true), false, 'no mounted scope means nothing is in scope')
console.log('ok: isKeyTargetInScope admits body only after an in-canvas interaction')
