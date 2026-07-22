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
import { initialHealth, stepHealth, syncStoreHealthy, type HealthState, type Observations } from './connectionHealth'

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
			rtt: null,
		},
	}
}

/** GET a health endpoint with a hard timeout, measuring the round-trip. */
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

	useEffect(() => {
		let cancelled = false
		const tick = async () => {
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
