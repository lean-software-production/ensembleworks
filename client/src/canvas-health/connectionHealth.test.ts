/**
 * Run: bun client/src/canvas-health/connectionHealth.test.ts
 *
 * The reducer is the whole feature's logic: threshold tripping, debounce,
 * recovery, block precedence, chip rendering state, countdown. All pure, all
 * driven by an injected `now` — no timers, no fetch, no DOM.
 */
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS } from './constants'
import {
	availability,
	BLOCKING_TRANSPORTS,
	countdownSeconds,
	initialHealth,
	needsFastClock,
	stepHealth,
	syncStoreHealthy,
	transportChip,
	trippedTransports,
	type HealthState,
	type Observations,
} from './connectionHealth'

const T = DEFAULT_THRESHOLDS // canvas 3000, terminals 8000

const ok: Observations = {
	canvas: { healthy: true, rtt: 20 },
	terminals: { healthy: true, rtt: 15 },
	livekit: { healthy: true, rtt: null },
}
function obs(over: Partial<Observations>): Observations {
	return { ...ok, ...over }
}

// ---------------------------------------------------------------- store status
// 1. syncStoreHealthy encodes design §3's canvas-sync store rule.
assert.equal(syncStoreHealthy({ status: 'loading', connectionStatus: null }), true, 'loading is not yet unhealthy')
assert.equal(syncStoreHealthy({ status: 'synced-remote', connectionStatus: 'online' }), true)
assert.equal(syncStoreHealthy({ status: 'synced-remote', connectionStatus: 'offline' }), false)
assert.equal(syncStoreHealthy({ status: 'error', connectionStatus: 'online' }), false, 'error is unhealthy regardless')

// ------------------------------------------------------------------- stamping
// 2. A healthy tick leaves unhealthySince null and records the rtt.
const h1 = stepHealth(initialHealth(), ok, 1000)
assert.equal(h1.canvas.unhealthySince, null)
assert.equal(h1.canvas.rtt, 20)

// 3. Going unhealthy stamps `now` once and does NOT re-stamp on later ticks —
//    otherwise a continuously-broken transport would never reach its threshold.
const h2 = stepHealth(h1, obs({ canvas: { healthy: false, rtt: null } }), 2000)
assert.equal(h2.canvas.unhealthySince, 2000)
const h3 = stepHealth(h2, obs({ canvas: { healthy: false, rtt: null } }), 4000)
assert.equal(h3.canvas.unhealthySince, 2000, 'stamp is sticky while unhealthy')

// 4. A failed probe keeps the LAST KNOWN rtt rather than blanking it — the
//    pill should show the last real measurement, not jump to "—".
assert.equal(h3.canvas.rtt, 20, 'last known rtt survives a failed probe')

// ------------------------------------------------------------------- tripping
// 5. Unhealthy for < threshold is NOT tripped (the debounce: a sub-second flap
//    must never flash the modal).
assert.deepEqual(trippedTransports(h2, 4999, T), [], '2999ms < 3000ms threshold: not tripped')
// 6. >= threshold IS tripped.
assert.deepEqual(trippedTransports(h2, 5000, T), ['canvas'], 'exactly at threshold trips')
assert.deepEqual(trippedTransports(h2, 9000, T), ['canvas'])

// 7. Recovery clears the stamp immediately — one healthy tick un-trips.
const h4 = stepHealth(h3, ok, 6000)
assert.equal(h4.canvas.unhealthySince, null)
assert.deepEqual(trippedTransports(h4, 60_000, T), [], 'recovery un-trips instantly')

// 8. A flap (unhealthy → healthy → unhealthy) restarts the clock.
const f1 = stepHealth(initialHealth(), obs({ canvas: { healthy: false, rtt: null } }), 1000)
const f2 = stepHealth(f1, ok, 2000)
const f3 = stepHealth(f2, obs({ canvas: { healthy: false, rtt: null } }), 2500)
assert.equal(f3.canvas.unhealthySince, 2500, 'clock restarts after recovery')
assert.deepEqual(trippedTransports(f3, 4000, T), [], 'flap does not accumulate toward the threshold')

// 9. Terminals use their own, longer threshold.
const t1 = stepHealth(initialHealth(), obs({ terminals: { healthy: false, rtt: null } }), 0)
assert.deepEqual(trippedTransports(t1, 7999, T), [], 'terminals not tripped before 8000ms')
assert.deepEqual(trippedTransports(t1, 8000, T), ['terminals'])

// 10. Both tripped ⇒ both named, canvas first (stable order for the UI).
const b1 = stepHealth(initialHealth(), obs({
	canvas: { healthy: false, rtt: null },
	terminals: { healthy: false, rtt: null },
}), 0)
assert.deepEqual(trippedTransports(b1, 10_000, T), ['canvas', 'terminals'])

// 11. LiveKit NEVER trips, however long it is down.
const lk = stepHealth(initialHealth(), obs({ livekit: { healthy: false, rtt: null } }), 0)
assert.deepEqual(trippedTransports(lk, 10 * 60_000, T), [], 'livekit is display-only')

// 11b. The non-blocking decision is pinned at the SOURCE, not just via the
//      null-threshold guard: livekit must never be in BLOCKING_TRANSPORTS.
//      Without this, adding it there breaks nothing and the design decision
//      silently erodes (found by mutation testing, 2026-07-22).
assert.equal(BLOCKING_TRANSPORTS.includes('livekit'), false, 'livekit must never be a blocking transport')
assert.deepEqual([...BLOCKING_TRANSPORTS], ['canvas', 'terminals'])

// --------------------------------------------------------------- availability
// 12. Healthy + lock held ⇒ not blocked.
assert.deepEqual(
	availability({ health: h4, now: 6000, thresholds: T, hasLock: true }),
	{ blocked: false, reason: null, tripped: [] }
)

// 13. Tripped blocking transport + lock held ⇒ blocked on 'connection'.
assert.deepEqual(
	availability({ health: b1, now: 10_000, thresholds: T, hasLock: true }),
	{ blocked: true, reason: 'connection', tripped: ['canvas', 'terminals'] }
)

// 14. No lock ⇒ 'duplicate-tab', even when everything is healthy.
assert.deepEqual(
	availability({ health: h4, now: 6000, thresholds: T, hasLock: false }),
	{ blocked: true, reason: 'duplicate-tab', tripped: [] }
)

// 15. PRECEDENCE: duplicate-tab wins over connection — no point counting down
//     a reconnect in a tab that should not be active (design §2).
assert.equal(
	availability({ health: b1, now: 10_000, thresholds: T, hasLock: false }).reason,
	'duplicate-tab'
)

// 15b. A duplicate tab reports NO tripped transports even when they really are
//      tripped: it must not render a connection countdown it isn't the tab to
//      act on. Asserting the whole object, because asserting only `.reason`
//      leaves the emptied `tripped` unverified (found by mutation testing).
assert.deepEqual(
	availability({ health: b1, now: 10_000, thresholds: T, hasLock: false }),
	{ blocked: true, reason: 'duplicate-tab', tripped: [] }
)

// 16. LiveKit down alone never blocks.
assert.equal(availability({ health: lk, now: 10 * 60_000, thresholds: T, hasLock: true }).blocked, false)

// ---------------------------------------------------------------------- chips
// 17. Chip states: connected / degrading (with elapsed) / down.
const chipHealthy = transportChip(h4.canvas, 6000, T.canvasMs)
assert.deepEqual(chipHealthy, { kind: 'connected', unhealthyMs: 0 })
const chipDegrading = transportChip(b1.canvas, 1000, T.canvasMs)
assert.deepEqual(chipDegrading, { kind: 'degrading', unhealthyMs: 1000 })
const chipDown = transportChip(b1.canvas, 5000, T.canvasMs)
assert.deepEqual(chipDown, { kind: 'down', unhealthyMs: 5000 })
// 18. A transport with no threshold (livekit) degrades but never goes down.
assert.deepEqual(transportChip(lk.livekit, 10 * 60_000, null), { kind: 'degrading', unhealthyMs: 600_000 })
// 18b. A backwards clock jump (NTP correction, laptop resume) must not produce
//      a negative age — it would render as "degrading (-3s)". The Math.max
//      floor is what prevents that, so pin it.
assert.deepEqual(transportChip(b1.canvas, -3000, T.canvasMs), { kind: 'degrading', unhealthyMs: 0 })

// ------------------------------------------------------------------ countdown
// 19. "Retrying in N…" counts whole seconds to the next probe tick, floor 1
//     (never show "Retrying in 0"), and never negative if a tick runs late.
assert.equal(countdownSeconds(1000, 3000), 2)
assert.equal(countdownSeconds(2500, 3000), 1)
assert.equal(countdownSeconds(3000, 3000), 1, 'at the tick boundary, show 1 not 0')
assert.equal(countdownSeconds(4000, 3000), 1, 'a late tick never shows a negative')

// ---------------------------------------------------------------- fast clock
// 20. All healthy + lock held ⇒ no fast clock needed (the common case this
//     gate exists to keep quiet).
assert.equal(needsFastClock(h4, true), false, 'fully healthy + lock held: no fast clock')

// 21. A tripped BLOCKING transport ⇒ fast clock needed (the countdown/chip
//     move).
assert.equal(needsFastClock(b1, true), true, 'blocking transport unhealthy: fast clock')

// 22. LiveKit-only unhealthy ⇒ NOT needed. LiveKit never blocks, so the modal
//     never mounts and no chip is on screen to animate; when livekit's chip
//     IS visible, a blocking transport is already tripped and this is
//     already true for that reason.
assert.equal(needsFastClock(lk, true), false, 'livekit-only unhealthy: no fast clock')

// 23. No lock ⇒ fast clock needed even with everything healthy — the
//     duplicate-tab modal is up regardless of transport health.
assert.equal(needsFastClock(h4, false), true, 'no lock: fast clock')

console.log('connectionHealth.test.ts: all assertions passed')
