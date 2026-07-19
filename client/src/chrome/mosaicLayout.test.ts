/**
 * Mosaic sizing math: columns from headcount, tile width from panel content
 * width. Run: bun client/src/chrome/mosaicLayout.test.ts
 */
import assert from 'node:assert/strict'
import {
	CHIP_SIZE,
	LABEL_MIN_WIDTH,
	MOSAIC_GAP,
	TILE_WIDTH_MIN,
	TILE_WIDTH_MAX,
	mosaicColumns,
	mosaicTileWidth,
} from './mosaicLayout'

// --- mosaicColumns: ceil(sqrt(N)), square-ish grid ---
assert.equal(mosaicColumns(1), 1)
assert.equal(mosaicColumns(2), 2)
assert.equal(mosaicColumns(4), 2)
assert.equal(mosaicColumns(5), 3)
assert.equal(mosaicColumns(9), 3)
assert.equal(mosaicColumns(14), 4) // spec's worked example
assert.equal(mosaicColumns(16), 4)
assert.equal(mosaicColumns(25), 5)
// Degenerate inputs clamp to 1 column rather than NaN/0.
assert.equal(mosaicColumns(0), 1)
assert.equal(mosaicColumns(-3), 1)

// --- mosaicTileWidth: fill content width minus gaps, clamped ---
// Spec worked example: 14 people, 280px panel → 4 cols. Content width for a
// 280px panel is ~256 (SidePanel padding); (256 - 3*6)/4 = 59.5 → 59.
assert.equal(mosaicTileWidth(256, 14), 59)
// Wider panel, same crowd: (536 - 18)/4 = 129.5 → 129.
assert.equal(mosaicTileWidth(536, 14), 129)
// Legibility floor: 25 people in a 180px-wide panel (content ~156):
// (156 - 4*6)/5 = 26.4 → clamps up to TILE_WIDTH_MIN.
assert.equal(mosaicTileWidth(156, 25), TILE_WIDTH_MIN)
// Sane max: one person in a huge panel caps at TILE_WIDTH_MAX.
assert.equal(mosaicTileWidth(1200, 1), TILE_WIDTH_MAX)
// Zero participants: still a finite, floored value (callers skip render at 0).
assert.equal(mosaicTileWidth(256, 0), TILE_WIDTH_MAX)

// --- constants sanity (spec values) ---
assert.equal(TILE_WIDTH_MIN, 36)
assert.equal(LABEL_MIN_WIDTH, 64)
assert.equal(CHIP_SIZE, 22)
assert.equal(MOSAIC_GAP, 6)
assert.ok(TILE_WIDTH_MAX >= 320)

console.log('mosaicLayout tests passed')
