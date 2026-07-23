/**
 * The probe: one timer that evaluates every transport each tick.
 *
 * Canvas health is BOTH signals — the tldraw store status (flips instantly on
 * a clean WS close, so detection is fast) AND a GET /api/health ping (catches
 * a wedged-but-"open" socket, and supplies the RTT). Terminals are endpoint-
 * based so they work with zero terminal shapes open. LiveKit is read from the
 * A/V bridge and is display-only.
 *
 * All decisions live in toObservations + the reducer; this file is wiring.
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §3.
 */
import { useEffect, useRef, useState } from 'react'
import { scheduler } from '../kernel/scheduler'
import { getThresholds, type Thresholds } from './constants'
import {
	initialHealth,
	markUnhealthy,
	stepHealth,
	syncStoreHealthy,
	type HealthState,
	type Observations,
} from './connectionHealth'

export interface ProbeResult {
	ok: boolean
	rtt: number | null
}

export interface StoreStatus {
	status: string
	connectionStatus: string | null
}

/** Fold this tick's raw readings into reducer observations. Pure. */
export function toObservations(input: {
	store: StoreStatus
	canvasProbe: ProbeResult
	terminalProbe: ProbeResult
	livekitStatus: string
}): Observations {
	return {
		canvas: {
			healthy: syncStoreHealthy(input.store) && input.canvasProbe.ok,
			rtt: input.canvasProbe.rtt,
		},
		terminals: {
			healthy: input.terminalProbe.ok,
			rtt: input.terminalProbe.rtt,
		},
		livekit: {
			// 'disabled' is a room with A/V off, not a fault — treating it as
			// degraded would leave that row permanently amber for no reason.
			healthy: input.livekitStatus === 'connected' || input.livekitStatus === 'disabled',
			// The A/V bridge only exposes a status string, no round-trip figure.
			rtt: null,
		},
	}
}

/**
 * GET a health endpoint with a hard timeout, measuring the round-trip.
 *
 * Every failure mode — non-2xx, non-JSON body, `{ok:false}`, timeout, network
 * error — collapses to the same `{ok:false, rtt:null}`. That's correct today
 * because `/api/health` (server/src/app.ts) has no error branch: it either
 * answers `{ok:true,...}` or the request doesn't complete at all, so `ok:false`
 * here really does mean "unreachable", matching the modal's "Lost connection
 * to the server" wording. If `/api/health` ever grows a partial/degraded
 * response, this flattening would silently swallow that distinction and the
 * modal's wording would become a lie — revisit this function then.
 *
 * The `rtt` this returns is NOT comparable to `useSessionPulse`'s rtt
 * (client/src/av/useSessionPulse.ts): different endpoint, method (GET vs
 * POST), measurement point (client wall-clock around fetch+json here, vs.
 * server-echoed there), and cadence (this probe's interval vs. its 30s pulse).
 * Do not render the two side by side as if they measured the same thing.
 */
async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
	const started = Date.now()
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: abort.signal, cache: 'no-store' })
		if (!res.ok) return { ok: false, rtt: null }
		const body = (await res.json()) as { ok?: boolean }
		if (body?.ok !== true) return { ok: false, rtt: null }
		return { ok: true, rtt: Date.now() - started }
	} catch {
		// Timeout, network error, or non-JSON body — all count as a miss.
		return { ok: false, rtt: null }
	} finally {
		clearTimeout(timer)
	}
}

export interface ConnectionHealth {
	health: HealthState
	thresholds: Thresholds
	/** Timestamp of the next scheduled probe tick, for the countdown. */
	nextProbeAt: number
}

export function useConnectionHealth(input: { store: StoreStatus; livekitStatus: string }): ConnectionHealth {
	const [thresholds] = useState(getThresholds)
	const [health, setHealth] = useState(initialHealth)
	const [nextProbeAt, setNextProbeAt] = useState(() => Date.now() + thresholds.probeIntervalMs)

	// The timer callback must see the latest store/livekit status without
	// re-subscribing the interval on every status change (which would reset
	// the cadence and, worse, restart the debounce clock).
	const latest = useRef(input)
	latest.current = input

	// FAST PATH — the store status is an event, the probe is a poll.
	//
	// A tick cannot produce an observation until BOTH probes resolve, which
	// takes up to probeTimeoutMs (4000ms) against a server that black-holes
	// packets — longer than the canvas threshold (3000ms) itself. Routing the
	// store's instant close signal through that poll therefore made the
	// threshold unreachable in practice: the modal could not appear until
	// ~7s after a drop, not the ~3s the threshold implies.
	//
	// So a store flip stamps the canvas transport immediately. The dependency
	// is the derived BOOLEAN, not the store object, so this fires on genuine
	// health transitions rather than on every status string change.
	const storeHealthy = syncStoreHealthy(input.store)
	useEffect(() => {
		if (storeHealthy) return // recovery belongs to the probe — see markUnhealthy
		setHealth((prev) => markUnhealthy(prev, 'canvas', Date.now()))
	}, [storeHealthy])

	useEffect(() => {
		let cancelled = false
		// A probe may outlive its own interval (probeTimeoutMs 4000 > interval
		// 2000), so ticks would otherwise overlap and a stale failure could land
		// AFTER a fresher success and mask it. One tick at a time; a skipped
		// tick costs nothing because the next one re-reads everything anyway.
		let inFlight = false
		const tick = async () => {
			if (inFlight) return
			inFlight = true
			try {
				const [canvasProbe, terminalProbe] = await Promise.all([
					probe('/api/health', thresholds.probeTimeoutMs),
					probe('/api/terminal/health', thresholds.probeTimeoutMs),
				])
				if (cancelled) return
				const obs = toObservations({
					store: latest.current.store,
					canvasProbe,
					terminalProbe,
					livekitStatus: latest.current.livekitStatus,
				})
				const now = Date.now()
				setHealth((prev) => stepHealth(prev, obs, now))
				setNextProbeAt(now + thresholds.probeIntervalMs)
			} finally {
				inFlight = false
			}
		}
		void tick() // probe immediately; don't wait a full interval for the first reading
		const cancel = scheduler.every(thresholds.probeIntervalMs, () => void tick())
		return () => {
			cancelled = true
			cancel()
		}
	}, [thresholds])

	return { health, thresholds, nextProbeAt }
}
