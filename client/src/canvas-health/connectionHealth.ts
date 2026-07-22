/**
 * The connection-health reducer — PURE, the whole feature's logic.
 *
 * Given per-transport observations and an injected `now`, it maintains an
 * `unhealthySince` stamp per transport, decides which transports have been
 * unhealthy long enough to trip their threshold, and folds that together with
 * the canvas lock into the single `blocked` + `reason` state the UI renders.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §2–§4.
 * Everything downstream (useConnectionHealth, useCanvasLock, the modal) is
 * wiring around this file; keep decisions here so they stay testable.
 */
import type { Thresholds } from './constants'

export type TransportId = 'canvas' | 'terminals' | 'livekit'

/** Order matters: it is the UI's row order and the tripped-list order. */
export const TRANSPORTS: readonly TransportId[] = ['canvas', 'terminals', 'livekit']

/**
 * The transports that can BLOCK. LiveKit is deliberately absent: it is
 * measured and displayed but never blocking (design §3).
 */
export const BLOCKING_TRANSPORTS: readonly TransportId[] = ['canvas', 'terminals']

export interface TransportHealth {
	healthy: boolean
	/** When this transport first went unhealthy; null while healthy. */
	unhealthySince: number | null
	/** Last successfully measured round-trip; survives failed probes. */
	rtt: number | null
}

export type HealthState = Record<TransportId, TransportHealth>

export interface Observation {
	healthy: boolean
	/** Measured this tick; null when the probe failed or does not measure. */
	rtt: number | null
}

export type Observations = Record<TransportId, Observation>

export type BlockReason = 'duplicate-tab' | 'connection'

export function initialHealth(): HealthState {
	const blank = (): TransportHealth => ({ healthy: true, unhealthySince: null, rtt: null })
	return { canvas: blank(), terminals: blank(), livekit: blank() }
}

/**
 * The canvas-sync store half of the canvas transport's health (design §3).
 * `synced-remote` is the only status whose connectionStatus is meaningful;
 * `loading` is "not yet", not "broken", so it counts as healthy.
 */
export function syncStoreHealthy(store: { status: string; connectionStatus: string | null }): boolean {
	if (store.status === 'error') return false
	if (store.status === 'synced-remote') return store.connectionStatus === 'online'
	return true
}

/** Fold one tick of observations into the state. Stamps are sticky while unhealthy. */
export function stepHealth(prev: HealthState, obs: Observations, now: number): HealthState {
	const next = {} as HealthState
	for (const id of TRANSPORTS) {
		const was = prev[id]
		const o = obs[id]
		next[id] = {
			healthy: o.healthy,
			// Sticky: only stamp on the healthy→unhealthy edge, so a continuously
			// broken transport actually accumulates time toward its threshold.
			unhealthySince: o.healthy ? null : (was.unhealthySince ?? now),
			// Keep the last real measurement rather than blanking on a miss.
			rtt: o.rtt ?? was.rtt,
		}
	}
	return next
}

/** Blocking transports that have been unhealthy for >= their threshold. */
export function trippedTransports(health: HealthState, now: number, t: Thresholds): TransportId[] {
	const tripped: TransportId[] = []
	for (const id of BLOCKING_TRANSPORTS) {
		const ms = chipThreshold(id, t)
		const since = health[id].unhealthySince
		if (ms == null || since == null) continue
		if (now - since >= ms) tripped.push(id)
	}
	return tripped
}

export interface Availability {
	blocked: boolean
	reason: BlockReason | null
	tripped: TransportId[]
}

/**
 * The single availability state. Precedence: duplicate-tab beats connection —
 * there is no point counting down a reconnect in a tab that should not be
 * active, so a duplicate tab never shows the connection modal (design §2).
 */
export function availability(input: {
	health: HealthState
	now: number
	thresholds: Thresholds
	hasLock: boolean
}): Availability {
	const tripped = trippedTransports(input.health, input.now, input.thresholds)
	if (!input.hasLock) return { blocked: true, reason: 'duplicate-tab', tripped: [] }
	if (tripped.length > 0) return { blocked: true, reason: 'connection', tripped }
	return { blocked: false, reason: null, tripped: [] }
}

export interface ChipState {
	kind: 'connected' | 'degrading' | 'down'
	unhealthyMs: number
}

/**
 * What one transport's row chip shows. `thresholdMs === null` (LiveKit) means
 * it can degrade but never reads as "down" — it is never blocking, so calling
 * it down would overstate the problem.
 */
export function transportChip(health: TransportHealth, now: number, thresholdMs: number | null): ChipState {
	if (health.unhealthySince == null) return { kind: 'connected', unhealthyMs: 0 }
	const unhealthyMs = Math.max(0, now - health.unhealthySince)
	if (thresholdMs != null && unhealthyMs >= thresholdMs) return { kind: 'down', unhealthyMs }
	return { kind: 'degrading', unhealthyMs }
}

/**
 * The threshold for a transport: what `trippedTransports` compares against,
 * and what callers rendering the row list use for the chip. LiveKit has none
 * — display-only, it never trips (design §3).
 */
export function chipThreshold(id: TransportId, t: Thresholds): number | null {
	if (id === 'canvas') return t.canvasMs
	if (id === 'terminals') return t.terminalMs
	return null
}

/**
 * "Retrying in N…" — whole seconds until the next probe tick (each tick IS a
 * retry). Floored at 1 so it never reads "Retrying in 0" and never goes
 * negative when a tick runs late.
 */
export function countdownSeconds(now: number, nextProbeAt: number): number {
	return Math.max(1, Math.ceil((nextProbeAt - now) / 1000))
}
