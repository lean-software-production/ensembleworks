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
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import { useEffect, useRef, useState } from 'react'

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
	request(name: string, options: { mode: 'exclusive' }, cb: (lock: unknown) => Promise<void>): Promise<void>
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
		// Resolving this is the only way to release the lock: it's the return
		// value of the promise the request() callback below is holding open.
		// Set only while we actually hold the lock (i.e. after the callback has
		// fired) so a takeover message that arrives while merely queued is a
		// harmless no-op.
		let release: (() => void) | null = null

		const acquire = () => {
			if (disposed) return
			void locks
				.request(name, { mode: 'exclusive' }, () => {
					// A request queued before unmount can still be granted after
					// disposal (StrictMode's mount/cleanup/remount races this); bail
					// out without ever holding the lock so the remount's request can
					// take it immediately.
					if (disposed) return Promise.resolve()
					setHasLock(true)
					// Hold until explicitly released (unmount, or a takeover).
					return new Promise<void>((resolve) => {
						release = () => {
							release = null
							setHasLock(false)
							resolve()
						}
					})
				})
				.catch(() => {
					// A rejected request (e.g. the page is being torn down) simply
					// leaves this tab blocked; the modal explains why.
				})
		}

		channel.onmessage = (ev: MessageEvent) => {
			const data = ev.data as { type?: string } | null
			if (data?.type !== 'takeover') return
			if (!release) return // we don't hold it; nothing to give up
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
			release?.()
			channel.close()
			channelRef.current = null
		}
	}, [supported, roomId, userId])

	const requestTakeover = () => {
		if (hasLock) return
		channelRef.current?.postMessage({ type: 'takeover' })
		// The holder's release frees the lock; our still-queued request then
		// resolves and flips hasLock. Nothing else to do here.
	}

	return { hasLock, requestTakeover }
}
