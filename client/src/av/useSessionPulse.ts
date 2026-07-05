/**
 * The session pulse: one timer that powers both the VM-pressure strip and the
 * per-user latency badges in the "In session" panel.
 *
 * Each tick POSTs /api/pulse, measuring its own wall-clock round-trip and
 * reporting it as the *next* tick's rttMs — so the heartbeat is self-measuring
 * and needs no separate ping. The server returns a single shared VM reading
 * plus the live latency map (every connected user's last round-trip), keyed by
 * raw user id.
 *
 * 30s is deliberate: VM pressure builds over seconds-to-minutes and PSI is
 * already smoothed, so a faster poll would just add request load to a small
 * shared box for no real freshness. Bump PULSE_INTERVAL_MS if latency needs to
 * feel more live (keep the server's PULSE_STALE_MS at ~2.5× whatever you pick).
 */
import { useEffect, useRef, useState } from 'react'
import { rawUserId } from '@ensembleworks/contracts'
import { scheduler } from '../kernel/scheduler'

export const PULSE_INTERVAL_MS = 30_000

// How many recent round-trips each per-user sparkline keeps. At a 30s pulse,
// 5 points spans ~2.5 min — enough to read a trend without hoarding memory.
export const LATENCY_HISTORY = 5

export interface VmStats {
	cpu: { load1: number; cores: number; pct: number; pressure: number | null }
	mem: {
		usedBytes: number
		limitBytes: number | null
		highBytes: number | null
		usedPct: number
		pressure: number | null
		source: 'cgroup' | 'host'
	}
}

export interface LatencySample {
	rtt: number
	t: number
}

export interface SessionPulse {
	vm: VmStats | null
	// rawUserId -> last reported round-trip. Includes you.
	latencies: Record<string, LatencySample>
	// rawUserId -> recent round-trips (oldest→newest, ≤LATENCY_HISTORY). The
	// server only echoes each user's latest sample, so the client builds this
	// trail itself across successive pulses.
	history: Record<string, number[]>
}

interface PulseResponse {
	ok: boolean
	now: number
	vm: VmStats
	latencies: Record<string, LatencySample>
}

export function useSessionPulse(roomId: string, identity: string): SessionPulse {
	const [pulse, setPulse] = useState<SessionPulse>({ vm: null, latencies: {}, history: {} })
	// The round-trip we measured on the previous tick, reported on the next one.
	const lastRtt = useRef<number | null>(null)
	// Per-user trail of recent round-trips, plus the timestamp of the last sample
	// folded in — so an unchanged server echo doesn't duplicate a point.
	const historyRef = useRef<Map<string, { lastT: number; rtts: number[] }>>(new Map())

	useEffect(() => {
		let cancelled = false
		const userId = rawUserId(identity)

		const tick = async () => {
			const t0 = performance.now()
			try {
				const res = await fetch('/api/pulse', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ room: roomId, userId, rttMs: lastRtt.current }),
				})
				const rtt = performance.now() - t0
				const body = (await res.json()) as PulseResponse
				if (cancelled || !res.ok) return
				lastRtt.current = rtt
				// Show your own latency from the round-trip you just measured rather
				// than waiting for the server to echo it back on the next pulse —
				// otherwise your own pill would read "—" for the first two ticks.
				const latencies = { ...body.latencies, [userId]: { rtt: Math.round(rtt), t: body.now } }

				// Fold this round's samples into each user's trail, appending only
				// when the timestamp moved on, and drop users who've left.
				const trails = historyRef.current
				const history: Record<string, number[]> = {}
				for (const [uid, sample] of Object.entries(latencies)) {
					let trail = trails.get(uid)
					if (!trail) trails.set(uid, (trail = { lastT: -1, rtts: [] }))
					if (sample.t !== trail.lastT) {
						trail.lastT = sample.t
						trail.rtts.push(sample.rtt)
						if (trail.rtts.length > LATENCY_HISTORY) trail.rtts.shift()
					}
					history[uid] = trail.rtts.slice()
				}
				for (const uid of trails.keys()) if (!(uid in latencies)) trails.delete(uid)

				setPulse({ vm: body.vm, latencies, history })
			} catch {
				// A failed pulse just means no fresh sample this round; the strip
				// keeps its last reading and the timer tries again.
			}
		}

		tick()
		const cancel = scheduler.every(PULSE_INTERVAL_MS, () => {
			void tick()
		})
		return () => {
			cancelled = true
			cancel()
		}
	}, [roomId, identity])

	return pulse
}
