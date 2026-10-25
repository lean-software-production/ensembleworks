/**
 * Pure gain→visual mappings for the spatial-audio legibility layer.
 * Run with: bun src/av/legibility.test.ts
 */
import assert from 'node:assert/strict'
import {
	GAIN_QUANTUM,
	QUIET_GAIN_THRESHOLD,
	TILE_OPACITY_FLOOR,
	cursorAlphaForGain,
	quantizeGain,
	tileOpacityForGain,
} from './legibility'

// --- tileOpacityForGain: linear from the floor to 1, clamped, finite-guarded ---
assert.equal(tileOpacityForGain(1), 1)
assert.equal(tileOpacityForGain(0), TILE_OPACITY_FLOOR)
assert.equal(tileOpacityForGain(0.5), TILE_OPACITY_FLOOR + (1 - TILE_OPACITY_FLOOR) * 0.5)
assert.equal(tileOpacityForGain(2), 1, 'gain above 1 clamps to full opacity')
assert.equal(tileOpacityForGain(-1), TILE_OPACITY_FLOOR, 'negative gain clamps to floor')
assert.equal(tileOpacityForGain(NaN), 1, 'non-finite gain shows full (fail visible, not dark)')
assert.ok(TILE_OPACITY_FLOOR >= 0.3, 'quiet tiles stay clearly visible')

// --- cursorAlphaForGain: same shape, its own floor ---
assert.equal(cursorAlphaForGain(1), 1)
assert.ok(cursorAlphaForGain(0) > 0, 'a silent peer’s cursor never fully vanishes')
assert.ok(cursorAlphaForGain(0.2) < cursorAlphaForGain(0.8), 'alpha rises with gain')
assert.equal(cursorAlphaForGain(NaN), 1)

// --- quantizeGain: snaps to GAIN_QUANTUM steps so the store only publishes real changes ---
assert.equal(quantizeGain(0), 0)
assert.equal(quantizeGain(1), 1)
assert.equal(quantizeGain(0.5), 0.5)
assert.equal(quantizeGain(0.512), 0.5, 'sub-quantum jitter snaps down')
assert.equal(quantizeGain(0.537), 0.55, 'rounds to the nearest step')
assert.equal(quantizeGain(1.7), 1, 'clamps above')
assert.equal(quantizeGain(-0.2), 0, 'clamps below')
assert.equal(quantizeGain(NaN), 1, 'non-finite → 1 (matches the loop’s no-cursor default)')
assert.ok(GAIN_QUANTUM > 0 && GAIN_QUANTUM <= 0.1)

// --- QUIET_GAIN_THRESHOLD: the “show the quiet glyph” cutoff sits between floor and half ---
assert.ok(QUIET_GAIN_THRESHOLD > 0.04 && QUIET_GAIN_THRESHOLD < 0.5)

console.log('legibility.test.ts: all assertions passed')
