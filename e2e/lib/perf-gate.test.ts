// Vsync-quantised perf gating. Run: bun e2e/lib/perf-gate.test.ts
//
// The rig's rAF sampler floors at the display refresh (~16.67ms), so a frame
// time is not a continuous number — it lands in a discrete refresh bucket
// (~16.7 / ~33.3 / ~50 …). A gate expressed in raw ms therefore does NOT mean
// what it says: a gate of 38.64ms cannot reject a "38.64ms frame", because a
// frame costing 38.64ms of work misses two refreshes and REPORTS as ~50ms.
// The gate degenerates to "<= 2 refreshes", one bucket below the intended
// threshold, and every sample is a whole bucket away from passing.
import assert from 'node:assert/strict'
import { VSYNC_MS, effectiveGate, gateRefreshes, refreshes } from './perf-gate.ts'

/** Does `gate` admit a clean sample of `n` whole refreshes? */
const admits = (gate: number, n: number) => n * VSYNC_MS <= gate

// The exact case that flakes canvas-v2-perf's dense-1000 scenario: baseline
// 16.8ms (1 refresh) x 1.15 x 2 = 38.64ms, which sits between refresh 2 and 3.
const denseGate = effectiveGate(38.64)
assert.ok(admits(denseGate, 3), 'a gate inside bucket 3 tolerates bucket 3')
assert.ok(!admits(denseGate, 4), 'but not bucket 4')
assert.ok(50.0 <= denseGate, 'the 3-refresh sample that fails today passes')
// Real samples carry vsync jitter (16.80, 33.30, 50.10 are all observed), so
// the gate must sit clear of the bucket it admits, not exactly on it.
assert.ok(50.1 <= denseGate, 'a jittered 3-refresh sample (50.10ms) passes too')
// Still a gate: one more whole refresh of regression is rejected.
assert.ok(4 * VSYNC_MS > denseGate, 'a 4-refresh sample still fails')

// A gate that lands exactly on a boundary keeps the bucket it names — it must
// not silently gain a free extra refresh from rounding.
const twoRefresh = effectiveGate(2 * VSYNC_MS)
assert.ok(admits(twoRefresh, 2), 'an exact 2-refresh gate still admits 2')
assert.ok(!admits(twoRefresh, 3), 'and does not silently gain a third')
assert.ok(33.3 <= twoRefresh, 'a jittered 2-refresh sample passes an exact 2-refresh gate')
assert.ok(50.1 > twoRefresh, 'a 3-refresh sample fails an exact 2-refresh gate')

// Sub-refresh gates round up to the one bucket that can be measured at all.
assert.ok(admits(effectiveGate(10), 1), 'a sub-refresh gate admits 1 refresh')
assert.ok(!admits(effectiveGate(10), 2), 'and no more than 1')

// The gate is monotonic in its input: a looser intended gate is never stricter.
let prev = 0
for (const intended of [5, 16.67, 20, 33.33, 38.64, 50, 66.7, 120]) {
	const g = effectiveGate(intended)
	assert.ok(g >= prev, `effectiveGate(${intended}) is not stricter than the gate below it`)
	assert.ok(g >= intended, `effectiveGate(${intended}) never tightens below the intended threshold`)
	prev = g
}

// gateRefreshes() is what a log line should quote — the bucket count the gate
// admits — since the enforced ms figure is a midpoint no sample can equal.
assert.equal(gateRefreshes(38.64), 3, 'the dense-1000 gate admits 3 refreshes')
assert.equal(gateRefreshes(2 * VSYNC_MS), 2, 'an exact boundary admits its own bucket, not one more')
assert.equal(gateRefreshes(10), 1)

// refreshes() names the bucket a sample landed in.
assert.equal(refreshes(16.8), 1)
assert.equal(refreshes(33.3), 2)
assert.equal(refreshes(50.1), 3)
assert.equal(refreshes(116.6), 7)

console.log('ok: perf-gate vsync quantisation')
