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
import { availability, needsFastClock } from './connectionHealth'
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

	// Keep `now` fresh at least once per probe tick even while the fast clock
	// below is off, so the first render after something goes unhealthy never
	// uses a `now` left over from minutes ago — that could sit BEFORE the
	// fresh `unhealthySince` stamp and mask a real trip (or render a negative/
	// nonsense "degrading" age). `health` gets a new object identity on every
	// probe tick (see stepHealth), so this fires on the same cadence as the
	// probe regardless of the fast clock's state.
	useEffect(() => {
		setNow(Date.now())
	}, [health])

	// The fast clock only needs to run while a readout it drives is actually
	// moving — the countdown and the "degrading (Ns)" chips — both of which
	// only exist once something is wrong (see needsFastClock's doc comment).
	// Gating this off in the common fully-healthy case avoids re-rendering the
	// component wrapping the whole canvas 4x/second to animate nothing. Do
	// not "simplify" this back to an unconditional interval.
	const fastClock = needsFastClock(health, hasLock)
	useEffect(() => {
		if (!fastClock) return
		return scheduler.every(CLOCK_TICK_MS, () => setNow(Date.now()))
	}, [fastClock])

	return {
		...availability({ health, now, thresholds, hasLock }),
		health,
		thresholds,
		nextProbeAt,
		now,
		requestTakeover,
	}
}
