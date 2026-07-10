// awayLogic: derive AFK / "away" state from presence meta and the auto-idle
// rule. Pure — no tldraw import — so it runs under bun exactly like
// handQueue.test.ts / followLogic.test.ts.
// Run: bun src/chrome/awayLogic.test.ts
import assert from 'node:assert/strict'
import { AWAY_AFTER_MS, isAwayPresence, isIdle } from './awayLogic'

const peer = (meta: unknown) => ({ meta }) as never

// --- isAwayPresence: away iff meta.away === true (strict, like presenting) ---

// A real away flag counts.
assert.equal(isAwayPresence(peer({ away: true })), true)
// Explicitly not away.
assert.equal(isAwayPresence(peer({ away: false })), false)
// No flag / no meta reads as present (never drops anyone to "away" by accident).
assert.equal(isAwayPresence(peer({})), false)
assert.equal(isAwayPresence(peer(undefined)), false)
// Truthy-but-not-true values are ignored — only a genuine boolean away counts.
assert.equal(isAwayPresence(peer({ away: 'yes' })), false)
assert.equal(isAwayPresence(peer({ away: 1 })), false)
// Present-mode meta (no away field) is present, not away.
assert.equal(isAwayPresence(peer({ presenting: true })), false)

// --- isIdle: idle once now − lastActivity reaches the threshold (>=) ---

// Just under the threshold → still active.
assert.equal(isIdle(1000, 1000 + AWAY_AFTER_MS - 1), false)
// Exactly at the threshold → idle (boundary-inclusive, deterministic flip).
assert.equal(isIdle(1000, 1000 + AWAY_AFTER_MS), true)
// Well past → idle.
assert.equal(isIdle(1000, 1000 + AWAY_AFTER_MS + 5000), true)
// Just moved → active.
assert.equal(isIdle(1000, 1000), false)
// A custom threshold overrides the default both ways.
assert.equal(isIdle(0, 500, 1000), false)
assert.equal(isIdle(0, 1000, 1000), true)

console.log('ok: awayLogic')
