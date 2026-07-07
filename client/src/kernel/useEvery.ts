import { useEffect, useRef } from 'react'
import { scheduler } from './scheduler'

/**
 * Run `fn` every `ms` milliseconds while `enabled`. The latest `fn` is
 * always the one called (ref-forwarded), so callers may close over fresh
 * render state without churning the interval; the interval is created and
 * torn down only when `ms` or `enabled` change (and on unmount).
 */
export function useEvery(ms: number, fn: () => void, enabled = true): void {
	const fnRef = useRef(fn)
	fnRef.current = fn
	useEffect(() => {
		if (!enabled) return
		return scheduler.every(ms, () => fnRef.current())
	}, [ms, enabled])
}
