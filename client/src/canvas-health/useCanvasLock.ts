/**
 * Single active tab per (room, user) — OLDEST WINS.
 *
 * The tab holding an exclusive navigator.locks lock is the active one. A
 * second tab cannot acquire it, learns it is the duplicate, and blocks. This
 * deliberately REVERSES the A/V "newest steals the slot" behaviour, which is
 * the bug behind issue #55 (DUPLICATE_IDENTITY kills, doubled cursors).
 *
 * Web Locks does not notify a holder that someone wants its lock, so takeover
 * rides a BroadcastChannel: the newcomer's "Use it here" posts {type:
 * 'takeover'}; the holder resolves its callback's promise to release the
 * lock and blocks itself; the freed lock then goes to whoever is next in the
 * request queue — which is the newcomer, since its request() call has been
 * sitting queued (unresolved) since mount. The former holder then re-queues
 * (see the `acquire()` call in the takeover branch below) so it inherits the
 * lock back if the newcomer ever leaves without a live waiter of its own —
 * without that, a former holder that gave up the lock would have no queued
 * request left and could never recover crash-safety for itself.
 *
 * Crash-safety is the lock's job — a dead tab's lock is auto-released by the
 * browser, so there is no stale-lock cleanup here, other than the re-queue
 * above.
 *
 * Deviation from design §5: the doc says a duplicate tab learns its status
 * "via `ifAvailable`" (a non-blocking probe). This implementation instead
 * always issues a genuinely queued `request()` and derives duplicate-status
 * from `!hasLock`. That's strictly better here: an `ifAvailable` probe
 * wouldn't stay queued, so there'd be nothing for a takeover — or a crashed
 * holder — to hand the lock to. The always-queued request is what makes both
 * takeover and crash auto-recovery work at all.
 *
 * Known limitation: with 3+ tabs (A holds; B queued, then C queued), if C
 * clicks "Use it here", A releases and the Web Locks FIFO queue grants to B
 * — not C, since B has been queued longer. C clicked and gets nothing; B
 * silently becomes the holder with no UI cue that it wasn't the one who
 * asked. The broadcast can't override the browser's queue order, and a real
 * fix would need each tab to know its queue position, which the API doesn't
 * expose. Not fixed — recorded so the next person hitting it recognises it
 * instead of re-deriving it.
 *
 * Known limitation: a bfcache-frozen holder still holds the lock, and
 * BroadcastChannel delivery to a frozen page is deferred until it resumes —
 * so a newcomer's takeover click does nothing until the frozen tab wakes or
 * is discarded. Unfixable from the takeover side. Full discard (not just
 * freeze) DOES recover: that releases the lock via ordinary crash-safety.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import { useEffect, useRef, useState } from 'react'
import { logConnectionEvent } from '../av/connectionLog'

/**
 * Scope is (room, user); components are encoded so ids can't forge a pair.
 * The separator is '/', which encodeURIComponent always escapes out of an id
 * (unlike '-', which survives encoding unreserved) — so a component can never
 * inject an extra boundary.
 */
export function canvasLockName(roomId: string, userId: string): string {
	return `ew-canvas-${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`
}

export interface CanvasLock {
	/** True when this tab owns the canvas (or when locks are unsupported). */
	hasLock: boolean
	/** Ask the current holder to hand over. No-op when we already hold it. */
	requestTakeover: () => void
}

interface LockManagerLike {
	request(
		name: string,
		options: { mode: 'exclusive'; signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void>
	): Promise<void>
}

function getLockManager(): LockManagerLike | null {
	const locks = (navigator as unknown as { locks?: LockManagerLike }).locks
	return locks ?? null
}

export function useCanvasLock(roomId: string, userId: string): CanvasLock {
	// Fallback: no navigator.locks (or no BroadcastChannel) ⇒ single-tab
	// enforcement is best-effort and simply never blocks. It must never be a
	// hard dependency (design §5).
	const supported = typeof BroadcastChannel !== 'undefined' && getLockManager() != null
	const [hasLock, setHasLock] = useState(supported ? false : true)
	const channelRef = useRef<BroadcastChannel | null>(null)

	useEffect(() => {
		if (!supported) return
		const name = canvasLockName(roomId, userId)
		const locks = getLockManager()
		if (!locks) return

		const channel = new BroadcastChannel(name)
		channelRef.current = channel
		let disposed = false
		// Aborted on unmount so a request still sitting in the browser's queue
		// (never granted) is cancelled instead of lingering. Per spec, aborting
		// a request that has ALREADY been granted is a no-op — it only cancels
		// the wait — so this can't fight the `release?.()` below over a lock we
		// currently hold.
		const abort = new AbortController()
		// Resolving this is the only way to release the lock: it's the return
		// value of the promise the request() callback below is holding open.
		// Set only while we actually hold the lock (i.e. after the callback has
		// fired) so a takeover message that arrives while merely queued is a
		// harmless no-op.
		let release: (() => void) | null = null

		const acquire = () => {
			if (disposed) return
			void locks
				.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
					// A request queued before unmount can still be granted after
					// disposal (StrictMode's mount/cleanup/remount races this); bail
					// out without ever holding the lock so the remount's request can
					// take it immediately.
					if (disposed) return Promise.resolve()
					setHasLock(true)
					logConnectionEvent('lock', 'granted')
					// Hold until explicitly released (unmount, or a takeover).
					return new Promise<void>((resolve) => {
						release = () => {
							release = null
							setHasLock(false)
							logConnectionEvent('lock', 'released')
							resolve()
						}
					})
				})
				.catch(() => {
					// AbortError from the unmount-time abort() below is expected and
					// not a failure — everything else (e.g. the page tearing down
					// mid-request) simply leaves this tab blocked; the modal explains
					// why, so neither case needs a log line here.
				})
		}

		channel.onmessage = (ev: MessageEvent) => {
			const data = ev.data as { type?: string } | null
			if (data?.type !== 'takeover') return
			if (!release) return // we don't hold it; nothing to give up
			logConnectionEvent('lock', 'takeover-received')
			// Hand over: release, then immediately re-queue. We're still
			// mounted and still contending for this canvas, so we sit blocked
			// behind the newcomer (whose request() has been queued since ITS
			// mount, strictly before this re-request — FIFO grant order still
			// gives them the lock, preserving oldest-wins). Re-queueing is what
			// lets us inherit the lock back automatically if the newcomer's tab
			// dies without a live waiter behind it; skipping this would strand
			// us blocked forever after a takeover.
			release()
			acquire()
		}

		acquire()

		return () => {
			disposed = true
			abort.abort()
			release?.()
			channel.close()
			channelRef.current = null
		}
	}, [supported, roomId, userId])

	const requestTakeover = () => {
		if (hasLock) return
		logConnectionEvent('lock', 'takeover-requested')
		channelRef.current?.postMessage({ type: 'takeover' })
		// The holder's release frees the lock; our still-queued request then
		// resolves and flips hasLock. Nothing else to do here.
	}

	return { hasLock, requestTakeover }
}
