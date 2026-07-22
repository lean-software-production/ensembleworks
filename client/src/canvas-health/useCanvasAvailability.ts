/**
 * The single "can I interact with this canvas right now?" state.
 *
 *   interactive ⇔ (every BLOCKING transport is healthy) ∧ (this tab holds the lock)
 *
 * Combines the probe and the lock through the pure `availability` reducer —
 * this file adds no decisions of its own.
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §2.
 */
import { useEffect, useState } from 'react'
import { scheduler } from '../kernel/scheduler'
import type { Availability, HealthState } from './connectionHealth'
import { availability } from './connectionHealth'
import type { Thresholds } from './constants'
import { useCanvasLock } from './useCanvasLock'
import { useConnectionHealth, type StoreStatus } from './useConnectionHealth'

/** How often the "degrading (Ns)" / "Retrying in N…" readouts re-render. */
const CLOCK_TICK_MS = 250

export interface CanvasAvailability extends Availability {
	health: HealthState
	thresholds: Thresholds
	nextProbeAt: number
	/** `Date.now()` as of the last UI clock tick — pass to the pure renderers. */
	now: number
	requestTakeover: () => void
}

export function useCanvasAvailability(input: {
	roomId: string
	userId: string
	store: StoreStatus
	livekitStatus: string
}): CanvasAvailability {
	const { health, thresholds, nextProbeAt } = useConnectionHealth({
		store: input.store,
		livekitStatus: input.livekitStatus,
	})
	const { hasLock, requestTakeover } = useCanvasLock(input.roomId, input.userId)

	// A transport trips on ELAPSED time, not on an event, so the state must be
	// re-evaluated between probe ticks — otherwise a threshold longer than the
	// probe interval would only trip on the next probe, and the countdown/
	// "degrading (Ns)" readouts would freeze.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => scheduler.every(CLOCK_TICK_MS, () => setNow(Date.now())), [])

	return {
		...availability({ health, now, thresholds, hasLock }),
		health,
		thresholds,
		nextProbeAt,
		now,
		requestTakeover,
	}
}
