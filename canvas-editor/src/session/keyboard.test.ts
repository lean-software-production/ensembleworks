// Run: bun src/session/keyboard.test.ts
import assert from 'node:assert/strict'
import type { KeyInputEvent } from '../input.js'
import { resolveShortcut } from './keyboard.js'

const NONE = { shift: false, alt: false, ctrl: false, meta: false }
const key = (k: string, mods: Partial<typeof NONE> = {}): KeyInputEvent => ({ type: 'keydown', key: k, modifiers: { ...NONE, ...mods }, t: 0 })

const cases: ReadonlyArray<readonly [KeyInputEvent, ReturnType<typeof resolveShortcut>]> = [
  [key('Escape'), { type: 'cancel' }],
  [key('Delete'), { type: 'delete' }],
  [key('Backspace'), { type: 'delete' }],
  [key('z', { ctrl: true }), { type: 'undo' }],
  [key('z', { meta: true }), { type: 'undo' }],
  [key('Z', { ctrl: true, shift: true }), { type: 'redo' }],
  [key('y', { ctrl: true }), { type: 'redo' }],
  [key('c', { ctrl: true }), { type: 'clipboard', action: 'copy' }],
  [key('x', { meta: true }), { type: 'clipboard', action: 'cut' }],
  [key('v', { ctrl: true }), { type: 'clipboard', action: 'paste' }],
  [key('d', { ctrl: true }), { type: 'clipboard', action: 'duplicate' }],
  [key(']'), { type: 'reorder', op: 'forward' }],
  [key('{'), { type: 'reorder', op: 'toBack' }],
  [key('a', { ctrl: true }), { type: 'selectAll' }],
  [key('n'), { type: 'tool', shortcut: { toolId: 'note' } }],
  [key('R', { shift: true }), { type: 'tool', shortcut: { toolId: 'geo', armGeo: 'rectangle' } }],
  [key('v'), { type: 'tool', shortcut: { toolId: 'select' } }],
  [key('q'), null],
  [key('ArrowRight'), null],
]
for (const [event, expected] of cases) {
  assert.deepEqual(resolveShortcut(event, null), expected, `${JSON.stringify(event.key)} ${JSON.stringify(event.modifiers)}`)
}
console.log('ok: resolveShortcut maps every host shortcut to one command')

for (const [event] of cases) {
  assert.equal(resolveShortcut(event, 'shape:editing'), null, `no shortcut fires while text-editing: ${event.key}`)
}
console.log('ok: resolveShortcut is silent while a shape is being text-edited')
