/**
 * Run: bun client/src/canvas-health/lockNames.test.ts
 *
 * The lock hook is browser-API lifecycle (navigator.locks)
 * and is validated by the manual smoke (design §8). What IS worth pinning is
 * the channel/lock NAMING: the scope is (room, user), so two real
 * collaborators must never contend, and a room id containing a separator must
 * not collide with a different room.
 */
import assert from 'node:assert/strict'
import { canvasLockName } from './useCanvasLock'

// 1. Same room + same user ⇒ same name (that is what makes tab 2 contend).
assert.equal(canvasLockName('team', 'alice'), canvasLockName('team', 'alice'))

// 2. Different user, same room ⇒ different names: real collaborators never
//    block each other. This is THE property the whole feature rests on.
assert.notEqual(canvasLockName('team', 'alice'), canvasLockName('team', 'bob'))

// 3. Different room, same user ⇒ different names.
assert.notEqual(canvasLockName('team', 'alice'), canvasLockName('design', 'alice'))

// 4. Ids are encoded, so a separator inside a room id cannot forge another
//    (room, user) pair.
assert.notEqual(canvasLockName('a-b', 'c'), canvasLockName('a', 'b-c'))

// 5. The documented prefix, so it is recognisable in devtools.
assert.ok(canvasLockName('team', 'alice').startsWith('ew-canvas-'))

console.log('lockNames.test.ts: all assertions passed')
