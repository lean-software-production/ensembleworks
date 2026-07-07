/**
 * Tiny dependency-free tests for deterministic terminal-grid geometry.
 * Run with: bun src/terminal/grid.test.ts
 *
 * The point of a deterministic grid is that every client computes the SAME
 * cols/rows from the same shared inputs (shape w/h + a quantised cell size), so
 * there is no proposer race over the gateway's shared PTY size. These tests pin
 * the floor math, the minimum clamps, and the quantisation that makes two
 * clients with marginally different cell measurements agree.
 */
import assert from 'node:assert/strict'
import { gridFor, quantizeCell, MIN_COLS, MIN_ROWS, TERMINAL_PAD } from './grid'

// Floor math: cols/rows are floor(available / cell) with padding removed.
{
	const cell = { w: 10, h: 20 }
	// (832 - 32)/10 = 80 ; (410 - 10)/20 = 20
	const g = gridFor(800 + TERMINAL_PAD.x, 400 + TERMINAL_PAD.y, cell)
	assert.equal(g.cols, 80)
	assert.equal(g.rows, 20)
}

// Non-integer fit floors down (no overflow past the box).
{
	const cell = { w: 9.6, h: 17 }
	const g = gridFor(500, 300, cell)
	assert.equal(g.cols, Math.floor((500 - TERMINAL_PAD.x) / 9.6))
	assert.equal(g.rows, Math.floor((300 - TERMINAL_PAD.y) / 17))
}

// Tiny boxes clamp to the minimums (matches the gateway's floor).
{
	const g = gridFor(0, 0, { w: 10, h: 20 })
	assert.equal(g.cols, MIN_COLS)
	assert.equal(g.rows, MIN_ROWS)
}

// Determinism: identical inputs always yield identical output.
{
	const cell = { w: 9.6, h: 17 }
	assert.deepEqual(gridFor(823, 517, cell), gridFor(823, 517, cell))
}

// Quantisation makes near-identical measurements agree (the cross-client crux):
// two machines whose raw cell width differs by sub-pixel noise round to the same
// value and therefore compute the same grid.
{
	const a = quantizeCell(9.603, 17.004)
	const b = quantizeCell(9.597, 16.996)
	assert.deepEqual(a, b) // both → { w: 9.6, h: 17 }
	assert.deepEqual(gridFor(823, 517, a), gridFor(823, 517, b))
}

// Documents the limit: differences that straddle a 0.05px bucket edge still
// diverge — that's why the heavier "snap w/h to whole cells" option exists.
{
	assert.notDeepEqual(quantizeCell(9.64, 17), quantizeCell(9.66, 17))
}

console.log('grid.test.ts: all assertions passed')
