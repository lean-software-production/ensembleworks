/**
 * Single active tab per (room, user) — OLDEST WINS, no takeover.
 *
 * The tab holding an exclusive navigator.locks lock is the active one. A
 * second tab cannot acquire it, learns it is the duplicate, and is never
 * mounted at all (see SingleTabGate) — so it opens no sync socket, no
 * terminal socket, and no LiveKit connection. That last one is the point:
 * LiveKit identities are unique per room, so a second tab that connects
 * DISPLACES the first one's audio. This is issue #55.
 *
 * There is deliberately no way for a duplicate tab to claim the lock. A
 * takeover would mean a live, connected holder losing its lock asynchronously
 * — which would require every transport to grow a teardown-and-rejoin path,
 * racing the newcomer's join. Without it, `granted` is monotonic for a live
 * tab: acquired at mount or never, released only by unmount or death.
 *
 * Recovery is automatic and needs no UI: a blocked tab's request stays QUEUED,
 * so when the holder closes, the browser grants the lock and the gate flips to
 * the app — no reload, no click. Crash-safety is the lock's job (a dead tab's
 * lock is auto-released), so there is no stale-lock cleanup here.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import { useEffect, useState } from 'react'
import { logConnectionEvent } from '../av/connectionLog'
import { scheduler } from '../kernel/scheduler'

/**
 * Scope is (room, user); components are encoded so ids can't forge a pair.
 * The separator is '/', which encodeURIComponent always escapes out of an id
 * (unlike '-', which survives encoding unreserved) — so a component can never
 * inject an extra boundary.
 */
export function canvasLockName(roomId: string, userId: string): string {
	return `ew-canvas-${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`
}

export type LockPhase = 'pending' | 'held' | 'blocked'

/**
 * The gate's decision, pure so it is testable without a browser.
 *
 * `granted` is checked FIRST and unconditionally. After this change there is
 * no teardown path — a tab that has been granted the lock keeps it until it
 * dies — so no later-arriving signal may demote a held tab. Both `query()`
 * (async, can resolve after our own grant) and the grace timer (can fire just
 * before a slow grant) are exactly such signals.
 */
export function lockPhase(input: {
	supported: boolean
	granted: boolean
	otherHolderSeen: boolean
	graceElapsed: boolean
}): LockPhase {
	if (!input.supported) return 'held'
	if (input.granted) return 'held'
	if (input.otherHolderSeen || input.graceElapsed) return 'blocked'
	return 'pending'
}

/**
 * How long a tab waits for a verdict before assuming it is the duplicate.
 *
 * Only a BACKSTOP. The normal path is `query()` below, which answers in about
 * a millisecond. This exists so that an engine where `query()` rejects, hangs,
 * or is absent degrades to "blocked after a beat" rather than "blank splash
 * forever". Generous on purpose: a false `blocked` costs a user their canvas
 * until the real grant lands, so it must not fire ahead of a slow-but-real
 * grant.
 */
const GRACE_MS = 3000

interface LockManagerLike {
	request(
		name: string,
		options: { mode: 'exclusive'; signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void>
	): Promise<void>
	query?(): Promise<{ held?: { name?: string }[] }>
}

function getLockManager(): LockManagerLike | null {
	const locks = (navigator as unknown as { locks?: LockManagerLike }).locks
	return locks ?? null
}

export function useCanvasLock(roomId: string, userId: string): LockPhase {
	// Fail open: no navigator.locks ⇒ enforcement is skipped entirely and the
	// app mounts as it always did. It must never be a hard dependency.
	const supported = getLockManager() != null
	const [granted, setGranted] = useState(false)
	const [otherHolderSeen, setOtherHolderSeen] = useState(false)
	const [graceElapsed, setGraceElapsed] = useState(false)

	useEffect(() => {
		if (!supported) return
		const name = canvasLockName(roomId, userId)
		const locks = getLockManager()
		if (!locks) return

		let disposed = false
		// Aborted on unmount so a request still sitting in the browser's queue
		// (never granted) is cancelled instead of lingering. Per spec, aborting
		// an ALREADY-granted request is a no-op — it only cancels the wait — so
		// this cannot fight `release?.()` over a lock we currently hold.
		const abort = new AbortController()
		// Resolving this is the only way to release the lock: it is the return
		// value of the promise the request() callback holds open. Unmount is now
		// the only caller.
		let release: (() => void) | null = null

		void locks
			.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
				// A request queued before unmount can still be granted after
				// disposal (StrictMode's mount/cleanup/remount races this); bail
				// without ever holding the lock so the remount's request can take
				// it immediately.
				if (disposed) return Promise.resolve()
				setGranted(true)
				logConnectionEvent('lock', 'granted')
				return new Promise<void>((resolve) => {
					release = () => {
						release = null
						logConnectionEvent('lock', 'released')
						resolve()
					}
				})
			})
			.catch(() => {
				// AbortError from the unmount-time abort() is expected. Anything
				// else leaves this tab un-granted, which the grace timer below
				// turns into `blocked` — the safe direction, and the notice
				// explains it. Nothing to log here either way.
			})

		// The fast path to a verdict: does someone ALREADY hold our lock name?
		// Issued after request() so we are queued first — if the holder vanishes
		// between the two, our grant fires and `lockPhase` ignores this answer.
		void locks
			.query?.()
			.then((state) => {
				if (disposed) return
				if ((state.held ?? []).some((entry) => entry.name === name)) setOtherHolderSeen(true)
			})
			.catch(() => {
				// Leave it to the grace timer.
			})

		// The scheduler is the repo's only cadence seam and offers `every`, not
		// `after` — so cancel on the first fire to get a one-shot.
		const cancelGrace = scheduler.every(GRACE_MS, () => {
			cancelGrace()
			if (!disposed) setGraceElapsed(true)
		})

		return () => {
			disposed = true
			cancelGrace()
			abort.abort()
			release?.()
		}
	}, [supported, roomId, userId])

	return lockPhase({ supported, granted, otherHolderSeen, graceElapsed })
}
