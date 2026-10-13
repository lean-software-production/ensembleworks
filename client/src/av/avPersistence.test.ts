/**
 * resolveInitialAv / serializeAv: freshness-gated restore of the mic/cam
 * preference. Pure (no storage, no clock), so we drive `now` directly.
 * Run: bun src/av/avPersistence.test.ts
 */
import assert from 'node:assert/strict'
import { AV_STALE_MS, resolveInitialAv, serializeAv } from './avPersistence'

const NOW = 1_000_000_000_000
const fresh = NOW - 1000 // 1s ago, well within the window
const stale = NOW - AV_STALE_MS // exactly at the threshold

// --- fail safe to OFF for anything unsafe ----------------------------------
assert.deepEqual(resolveInitialAv(null, NOW), { mic: false, cam: false }, 'absent -> off')
assert.deepEqual(resolveInitialAv('', NOW), { mic: false, cam: false }, 'empty -> off')
assert.deepEqual(resolveInitialAv('{not json', NOW), { mic: false, cam: false }, 'malformed -> off')
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true }), NOW),
	{ mic: false, cam: false },
	'missing lastActiveAt -> off',
)
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true, lastActiveAt: 'soon' }), NOW),
	{ mic: false, cam: false },
	'non-number lastActiveAt -> off',
)

// --- fresh session: the stored preference is restored -----------------------
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true, lastActiveAt: fresh }), NOW),
	{ mic: true, cam: true },
	'fresh + both on -> both on',
)
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: false, lastActiveAt: fresh }), NOW),
	{ mic: true, cam: false },
	'fresh preserves the exact mic/cam combination',
)

// --- staleness gate: >= AV_STALE_MS reverts to off (the privacy default) ----
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true, lastActiveAt: stale }), NOW),
	{ mic: false, cam: false },
	'exactly at the threshold is stale -> off',
)
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true, lastActiveAt: NOW - AV_STALE_MS - 1 }), NOW),
	{ mic: false, cam: false },
	'past the threshold -> off',
)
// just inside the window still restores
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: true, cam: true, lastActiveAt: NOW - AV_STALE_MS + 1 }), NOW),
	{ mic: true, cam: true },
	'one ms inside the window -> restored',
)

// --- only a literal `true` enables a device (no truthy coercion) ------------
assert.deepEqual(
	resolveInitialAv(JSON.stringify({ mic: 1, cam: 'yes', lastActiveAt: fresh }), NOW),
	{ mic: false, cam: false },
	'truthy-but-not-true never enables a device',
)

// --- round-trip: serialize then resolve within the window is identity -------
const roundTrip = resolveInitialAv(serializeAv({ mic: false, cam: true, lastActiveAt: fresh }), NOW)
assert.deepEqual(roundTrip, { mic: false, cam: true }, 'serialize -> resolve round-trips within window')

// serializeAv coerces a truthy-but-not-true value to false and keeps the timestamp
assert.equal(
	serializeAv({ mic: 1 as unknown as boolean, cam: true, lastActiveAt: NOW }),
	JSON.stringify({ mic: false, cam: true, lastActiveAt: NOW }),
	'serializeAv coerces non-true (truthy) values to false',
)

console.log('avPersistence.test.ts: all assertions passed')
