/**
 * Run: bun client/src/canvas-health/probe.test.ts
 *
 * Covers the one decision inside the probe hook — folding two endpoint probe
 * results plus the tldraw store status into the reducer's Observations. The
 * React/timer shell around it holds no decisions and is covered by the manual
 * smoke in the design doc §8.
 */
import assert from 'node:assert/strict'
import { toObservations } from './useConnectionHealth'

const store = { status: 'synced-remote', connectionStatus: 'online' }

// 1. Everything up.
assert.deepEqual(
	toObservations({
		store,
		canvasProbe: { ok: true, rtt: 25 },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}),
	{
		canvas: { healthy: true, rtt: 25 },
		terminals: { healthy: true, rtt: 30 },
		livekit: { healthy: true, rtt: null },
	}
)

// 2. The store flips instantly on a clean WS close even while the ping still
//    succeeds — fast detection is the whole point of using both signals.
assert.equal(
	toObservations({
		store: { status: 'synced-remote', connectionStatus: 'offline' },
		canvasProbe: { ok: true, rtt: 25 },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}).canvas.healthy,
	false
)

// 3. The ping catches a wedged-but-"open" socket the store still calls online.
assert.equal(
	toObservations({
		store,
		canvasProbe: { ok: false, rtt: null },
		terminalProbe: { ok: true, rtt: 30 },
		livekitStatus: 'connected',
	}).canvas.healthy,
	false
)

// 4. Terminals are endpoint-only, and a terminal failure does not touch canvas.
const t = toObservations({
	store,
	canvasProbe: { ok: true, rtt: 25 },
	terminalProbe: { ok: false, rtt: null },
	livekitStatus: 'connected',
})
assert.equal(t.terminals.healthy, false)
assert.equal(t.canvas.healthy, true)

// 5. LiveKit: only 'connected' is healthy; 'disabled' counts as healthy too —
//    a room with A/V switched off must not sit permanently degraded.
for (const s of ['connecting', 'reconnecting', 'retrying', 'error']) {
	assert.equal(
		toObservations({ store, canvasProbe: { ok: true, rtt: 1 }, terminalProbe: { ok: true, rtt: 1 }, livekitStatus: s }).livekit.healthy,
		false,
		`livekit "${s}" is degraded`
	)
}
for (const s of ['connected', 'disabled']) {
	assert.equal(
		toObservations({ store, canvasProbe: { ok: true, rtt: 1 }, terminalProbe: { ok: true, rtt: 1 }, livekitStatus: s }).livekit.healthy,
		true,
		`livekit "${s}" is healthy`
	)
}

console.log('probe.test.ts: all assertions passed')
