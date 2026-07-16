// crosstalk: the single "how loud are people I can't see?" dial — the fade
// floor on my page, one step further for other pages. Pure — no tldraw /
// livekit import — so the single-gain target rule runs under bun exactly like
// spatial.test.ts. Run: bun src/av/crosstalk.test.ts
import assert from 'node:assert/strict'
import { clampCrosstalk, DEFAULT_CROSSTALK_LEVEL, gainTarget, otherPageLevel } from './crosstalk'

// --- clampCrosstalk: a raw slider value → the [0,1] range ---
// The default is FULL: slider max = hear everyone (the old standup mode).
assert.equal(DEFAULT_CROSSTALK_LEVEL, 1)
assert.equal(clampCrosstalk(0), 0)
assert.equal(clampCrosstalk(1), 1)
assert.equal(clampCrosstalk(0.4), 0.4)
assert.equal(clampCrosstalk(-0.5), 0) // below range → strict focus
assert.equal(clampCrosstalk(2), 1) // above range → full
// Non-finite (NaN / ±∞) falls back to the default, mirroring spatial's finite
// guard (gainForDistance's `!Number.isFinite(distance) → floor`).
assert.equal(clampCrosstalk(NaN), 1)
assert.equal(clampCrosstalk(Infinity), 1)

// --- otherPageLevel: one step further away than the on-page floor ---
// The same-page fade drops (1 − L) per falloff-distance; other pages sit one
// falloff-distance past the floor: 2L − 1, clamped to 0.
assert.equal(otherPageLevel(1), 1) // no fade at full — other pages full too
assert.equal(Math.round(otherPageLevel(0.9) * 100), 80)
assert.equal(otherPageLevel(0.75), 0.5)
assert.equal(otherPageLevel(0.5), 0) // focusing cuts other rooms first
assert.equal(otherPageLevel(0.2), 0)
assert.equal(otherPageLevel(0), 0)
assert.equal(otherPageLevel(5), 1) // clamped through
assert.equal(otherPageLevel(NaN), 1) // non-finite → default level 1 → 1

// --- gainTarget: the single per-peer gain decision the spatial loop makes ---

// Absent (not in presence on ANY page): silent, whatever the level — a peer
// who has truly left is never bled in.
assert.equal(gainTarget({ location: 'absent', pageGain: 0.5, crosstalk: 1 }), 0)
assert.equal(gainTarget({ location: 'absent', pageGain: 1, crosstalk: 0 }), 0)

// Other page: one step past the on-page floor, nothing else.
assert.equal(gainTarget({ location: 'other-page', pageGain: 0.5, crosstalk: 1 }), 1)
assert.equal(gainTarget({ location: 'other-page', pageGain: 0.5, crosstalk: 0.75 }), 0.5)
assert.equal(gainTarget({ location: 'other-page', pageGain: 0.5, crosstalk: 0.5 }), 0)
assert.equal(gainTarget({ location: 'other-page', pageGain: 1, crosstalk: 0 }), 0)
// Out-of-range crosstalk is clamped through gainTarget too.
assert.equal(gainTarget({ location: 'other-page', pageGain: 1, crosstalk: 5 }), 1)

// My page: the viewport-rect pageGain passes straight through (the loop has
// already folded the crosstalk floor into the fade).
assert.equal(gainTarget({ location: 'my-page', pageGain: 1, crosstalk: 0 }), 1)
assert.equal(gainTarget({ location: 'my-page', pageGain: 0.5, crosstalk: 1 }), 0.5)
assert.equal(gainTarget({ location: 'my-page', pageGain: 0.04, crosstalk: 0 }), 0.04)

console.log('ok: crosstalk')
