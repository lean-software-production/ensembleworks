/**
 * Run: bun client/src/chrome/accel.test.ts
 */
import assert from 'node:assert/strict'
import { displayKeyForKbd, splitAccelLabel } from './accel'

// First occurrence, case-insensitive, split into pre/hit/post.
assert.deepEqual(splitAccelLabel('select', 's'), { pre: '', hit: 's', post: 'elect' })
assert.deepEqual(splitAccelLabel('terminal', 'm'), { pre: 'ter', hit: 'm', post: 'inal' })
assert.deepEqual(splitAccelLabel('cast', 'c'), { pre: '', hit: 'c', post: 'ast' })

// Letter absent (or no accelerator) → null; caller renders a plain label.
assert.equal(splitAccelLabel('laser', 'k'), null)
assert.equal(splitAccelLabel('menu', undefined), null)

// tldraw kbd → display key: prefer an alternative that occurs in the label.
assert.equal(displayKeyForKbd('v,s', 'select'), 's')
assert.equal(displayKeyForKbd('n', 'note'), 'n')
// No alternative in the label → first plain (modifier-free) alternative.
assert.equal(displayKeyForKbd('k', 'laser'), 'k')
// Modifier chords are never displayed as inline accelerators.
assert.equal(displayKeyForKbd('!d', 'highlight'), null)
assert.equal(displayKeyForKbd(undefined, 'anything'), null)

console.log('accel.test.ts: all assertions passed')
