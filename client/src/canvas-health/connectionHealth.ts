/**
 * The connection-health reducer — PURE, the whole feature's logic.
 *
 * Given per-transport observations and an injected `now`, it maintains an
 * `unhealthySince` stamp per transport, decides which transports have been
 * unhealthy long enough to trip their threshold, and folds that into the single
 * `blocked` + `reason` state the UI renders.
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

export type BlockReason = 'connection'

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

/**
 * Stamp one transport unhealthy NOW, without waiting for a probe tick.
 *
 * The probe is a poll, but the tldraw store status is an EVENT: it flips the
 * instant the sync socket closes cleanly. Folding that event into the next
 * poll would throw away its one advantage — `useConnectionHealth`'s tick
 * cannot produce an observation until BOTH probes have resolved, so a store
 * flip would otherwise sit unreported for up to `probeTimeoutMs`, which is
 * longer than the canvas threshold itself.
 *
 * Returns `prev` UNCHANGED when the transport is already unhealthy — both to
 * preserve the sticky `unhealthySince` (the whole debounce depends on it) and
 * to avoid handing React a new object identity on every store notification,
 * which would re-render the component wrapping the entire canvas for nothing.
 *
 * Deliberately one-directional: this only ever marks unhealthy, never healthy.
 * Recovery stays with the probe, because "the socket reopened" is not the same
 * claim as "the server is actually answering" — and being slow to clear the
 * modal is safe, while being quick to clear it on a half-open socket is not.
 */
export function markUnhealthy(prev: HealthState, id: TransportId, now: number): HealthState {
	const was = prev[id]
	if (!was.healthy) return prev
	// Reachable only from a healthy transport, and healthy always implies
	// `unhealthySince === null` (stepHealth clears it on recovery, initialHealth
	// starts there), so this IS the first stamp — no `?? was.unhealthySince`
	// fallback, which would only pretend to handle a state that cannot occur.
	// Stickiness is enforced by the guard above, not here.
	return { ...prev, [id]: { healthy: false, unhealthySince: now, rtt: was.rtt } }
}

export interface Availability {
	blocked: boolean
	reason: BlockReason | null
	tripped: TransportId[]
}

/**
 * The single availability state. A duplicate tab never reaches this code:
 * SingleTabGate refuses to mount the app at all without the lock (design §5),
 * so connection health is the only thing that can block here.
 */
export function availability(input: {
	health: HealthState
	now: number
	thresholds: Thresholds
}): Availability {
	const tripped = trippedTransports(input.health, input.now, input.thresholds)
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

/**
 * Does the UI need the sub-second clock right now?
 *
 * The countdown and the "degrading (Ns)" chips are the only readouts that
 * move between probe ticks, and both only exist once something is wrong. A
 * healthy session therefore needs no fast clock at all — running one would
 * re-render the component wrapping the whole canvas 4x/second forever to
 * animate nothing. Transitions INTO unhealth arrive on the 2s probe tick,
 * which re-renders anyway, so nothing is missed by staying slow until then.
 *
 * Gates on BLOCKING_TRANSPORTS only, not all TRANSPORTS. LiveKit is
 * display-only and can never open the modal (design §3), so a livekit-only
 * fault has no visible sub-second readout to animate — its chip is only ever
 * on screen when a blocking transport is ALSO tripped, and this already
 * returns true for that. Widening this to all TRANSPORTS would spin the fast
 * clock up for a livekit-only fault that nothing on screen is reading.
 */
export function needsFastClock(health: HealthState): boolean {
	return BLOCKING_TRANSPORTS.some((id) => health[id].unhealthySince != null)
}
