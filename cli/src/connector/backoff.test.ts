// The relay parity contract (contracts/src/relay-parity.ts): the pinned
// constant VALUES match gateway-go/relay/relay.go, computeBackoff reproduces
// the 1s→30s jittered curve (relay.go lines 121–126) under a stubbed rng, and
// the healthy-reset threshold is the pure check the reconnect loop uses.
// Run with: bun src/connector/backoff.test.ts
import assert from 'node:assert/strict'
import {
	computeBackoff,
	RELAY_BACKOFF_BASE_MS,
	RELAY_BACKOFF_CAP_MS,
	RELAY_BACKOFF_EXPONENT_CAP,
	RELAY_CHANNEL_QUEUE_DEPTH,
	RELAY_HEALTHY_RESET_MS,
	RELAY_JITTER_MAX,
	RELAY_JITTER_MIN,
	RELAY_PING_INTERVAL_MS,
	RELAY_READ_LIMIT_BYTES,
} from '@ensembleworks/contracts/relay-parity'

// 1. Constant VALUES pinned against relay.go (the parity audit).
assert.equal(RELAY_BACKOFF_BASE_MS, 1_000, 'base 1s — relay.go:122')
assert.equal(RELAY_BACKOFF_CAP_MS, 30_000, 'cap 30s — relay.go:123–125')
assert.equal(RELAY_BACKOFF_EXPONENT_CAP, 5, 'min(attempt-1,5) — relay.go:122')
assert.equal(RELAY_JITTER_MIN, 0.8, 'jitter floor 0.8 — relay.go:126')
assert.equal(RELAY_JITTER_MAX, 1.2, 'jitter ceil 1.2 — relay.go:126 (0.8+0.4)')
assert.equal(RELAY_HEALTHY_RESET_MS, 30_000, 'healthyDuration 30s — relay.go:96')
assert.equal(RELAY_PING_INTERVAL_MS, 20_000, 'pingInterval 20s — relay.go:137')
assert.equal(RELAY_READ_LIMIT_BYTES, 1 << 20, 'SetReadLimit(1<<20) — relay.go:152')
assert.equal(RELAY_CHANNEL_QUEUE_DEPTH, 64, 'make(chan …, 64) — relay.go:201')

// 2. Base curve with jitter neutralised (rng=0.5 → factor 0.8+0.4*0.5 = 1.0).
const mid = () => 0.5
assert.equal(computeBackoff(1, mid), 1_000, 'attempt 1 → 1s')
assert.equal(computeBackoff(2, mid), 2_000, 'attempt 2 → 2s')
assert.equal(computeBackoff(3, mid), 4_000, 'attempt 3 → 4s')
assert.equal(computeBackoff(4, mid), 8_000, 'attempt 4 → 8s')
assert.equal(computeBackoff(5, mid), 16_000, 'attempt 5 → 16s')
// 3. The cap: attempt 6's raw 32s clamps to 30s, and every later attempt too.
assert.equal(computeBackoff(6, mid), 30_000, 'attempt 6 → 32s clamped to 30s')
assert.equal(computeBackoff(7, mid), 30_000, 'attempt 7 → 30s (exponent capped)')
assert.equal(computeBackoff(100, mid), 30_000, 'exponent cap holds far out')

// 4. Jitter bounds: rng=0 → exactly 0.8×; rng→1 → strictly below 1.2×.
assert.equal(computeBackoff(1, () => 0), 800, 'rng=0 → 0.8× base')
assert.equal(computeBackoff(3, () => 0), 3_200, 'rng=0 → 0.8× (attempt 3)')
{
	const hi = computeBackoff(1, () => 0.999999)
	assert.ok(hi < 1_200 && hi >= 1_000, `rng→1 stays below 1.2× (got ${hi})`)
}

// 5. Healthy-reset rule as a pure check (relay.go:118 — reset the counter when
//    the last connection survived longer than RELAY_HEALTHY_RESET_MS).
assert.equal(31_000 > RELAY_HEALTHY_RESET_MS, true, 'a >30s connection is healthy')
assert.equal(30_000 > RELAY_HEALTHY_RESET_MS, false, 'exactly 30s is not (strict >)')

console.log('ok: backoff — parity constant values, 1s→30s jittered curve, exponent cap, jitter bounds, healthy-reset threshold')
