// crosstalk: how loudly cross-room / off-page teammates bleed into your audio.
// Pure — no tldraw / livekit import — so the single-gain target rule runs under
// bun exactly like spatial.test.ts. Run: bun src/av/crosstalk.test.ts
import assert from 'node:assert/strict'
import { clampCrosstalk, DEFAULT_CROSSTALK_LEVEL, gainTarget } from './crosstalk'

// --- clampCrosstalk: a raw slider value → the [0,1] bleed range ---
// The default is silence: 0 reproduces today's behavior (off-page = muted).
assert.equal(DEFAULT_CROSSTALK_LEVEL, 0)
assert.equal(clampCrosstalk(0), 0)
assert.equal(clampCrosstalk(1), 1)
assert.equal(clampCrosstalk(0.4), 0.4)
assert.equal(clampCrosstalk(-0.5), 0) // below range → silent
assert.equal(clampCrosstalk(2), 1) // above range → full
// Non-finite (NaN / ±∞) falls back to the default, mirroring spatial's finite
// guard (gainForDistance's `!Number.isFinite(distance) → floor`).
assert.equal(clampCrosstalk(NaN), 0)
assert.equal(clampCrosstalk(Infinity), 0)

// --- gainTarget: the single per-peer gain decision the spatial loop makes ---

// Absent (not in presence on ANY page): silent, exactly as today — a peer who
// has truly left is never bled in by crosstalk, whatever the level.
assert.equal(gainTarget({ location: 'absent', standupMode: false, pageGain: 0.5, crosstalk: 1 }), 0)
assert.equal(gainTarget({ location: 'absent', standupMode: true, pageGain: 1, crosstalk: 1 }), 0)

// Other page: governed ONLY by the crosstalk bleed level (clamped) — never by
// standup or page distance. 0 = today's silence; 1 = as if on my page.
assert.equal(gainTarget({ location: 'other-page', standupMode: false, pageGain: 0.5, crosstalk: 0 }), 0)
assert.equal(gainTarget({ location: 'other-page', standupMode: false, pageGain: 0.5, crosstalk: 1 }), 1)
assert.equal(gainTarget({ location: 'other-page', standupMode: false, pageGain: 0.5, crosstalk: 0.3 }), 0.3)
// Standup does not pull an off-page peer up — crosstalk alone owns off-page.
assert.equal(gainTarget({ location: 'other-page', standupMode: true, pageGain: 1, crosstalk: 0.2 }), 0.2)
// Out-of-range crosstalk is clamped through gainTarget too.
assert.equal(gainTarget({ location: 'other-page', standupMode: false, pageGain: 1, crosstalk: 5 }), 1)

// My page: unchanged behavior — standup pins to full, else the distance gain;
// the crosstalk level never touches an on-page peer.
assert.equal(gainTarget({ location: 'my-page', standupMode: true, pageGain: 0.5, crosstalk: 0 }), 1)
assert.equal(gainTarget({ location: 'my-page', standupMode: false, pageGain: 0.5, crosstalk: 1 }), 0.5)
assert.equal(gainTarget({ location: 'my-page', standupMode: false, pageGain: 0.5, crosstalk: 0 }), 0.5)

console.log('ok: crosstalk')
