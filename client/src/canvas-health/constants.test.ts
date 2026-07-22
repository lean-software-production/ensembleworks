/**
 * Run: bun client/src/canvas-health/constants.test.ts
 *
 * readThresholds is pure (takes an env record) so it is testable under bare
 * bun — the same split as client/src/engine.ts.
 */
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS, readThresholds } from './constants'

// 1. Empty env → the documented defaults.
assert.deepEqual(readThresholds({}), DEFAULT_THRESHOLDS, 'empty env yields defaults')
assert.equal(DEFAULT_THRESHOLDS.canvasMs, 3000)
assert.equal(DEFAULT_THRESHOLDS.terminalMs, 8000)
assert.equal(DEFAULT_THRESHOLDS.probeIntervalMs, 2000)
assert.equal(DEFAULT_THRESHOLDS.probeTimeoutMs, 4000)

// 2. Each var overrides exactly its own field.
assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: '500' }).canvasMs, 500)
assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: '500' }).terminalMs, 8000, 'other fields untouched')
assert.equal(readThresholds({ VITE_CONN_HEALTH_TERMINAL_MS: '12000' }).terminalMs, 12000)
assert.equal(readThresholds({ VITE_CONN_HEALTH_PROBE_MS: '1000' }).probeIntervalMs, 1000)
assert.equal(readThresholds({ VITE_CONN_HEALTH_TIMEOUT_MS: '9000' }).probeTimeoutMs, 9000)

// 3. Garbage, negative, zero and non-finite values fall back — a typo'd env
//    var must never produce a 0ms probe interval (a busy-loop) or NaN
//    arithmetic that makes every comparison false (i.e. never trips).
for (const bad of ['', 'abc', '-1', '0', 'NaN', 'Infinity', '3s']) {
	assert.equal(readThresholds({ VITE_CONN_HEALTH_CANVAS_MS: bad }).canvasMs, 3000, `"${bad}" falls back`)
}

// 4. Fractional input is floored to whole ms (timers take integers).
assert.equal(readThresholds({ VITE_CONN_HEALTH_PROBE_MS: '1500.7' }).probeIntervalMs, 1500)

console.log('constants.test.ts: all assertions passed')
