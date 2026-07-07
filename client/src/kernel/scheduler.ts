/**
 * The client cadence service (unified-architecture-design.md §1.2:
 * `scheduler.every(ms, fn)`) — the one seam every recurring loop runs
 * through, instead of ad-hoc setIntervals scattered across features.
 * Each subscription keeps its own interval, so the semantics are identical
 * to the setInterval it replaces; the value is the seam (and, later, that
 * plugin packages receive it as a capability), not tick coalescing.
 */
export type CancelCadence = () => void

export interface Scheduler {
	every(ms: number, fn: () => void): CancelCadence
}

type IntervalHandle = ReturnType<typeof setInterval>

export function createScheduler(
	set: (fn: () => void, ms: number) => IntervalHandle = (fn, ms) => setInterval(fn, ms),
	clear: (handle: IntervalHandle) => void = clearInterval
): Scheduler {
	return {
		every(ms, fn) {
			const handle = set(fn, ms)
			let cancelled = false
			return () => {
				if (cancelled) return
				cancelled = true
				clear(handle)
			}
		},
	}
}

/** The app-wide scheduler instance. */
export const scheduler: Scheduler = createScheduler()
