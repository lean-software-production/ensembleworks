/**
 * Away / AFK state — the tldraw-facing layer over ./awayLogic, mirroring
 * chrome/present.ts: the local atoms this client owns, the derivation the
 * roster reads (selfAway, read inside its existing useValue), and the
 * imperative verbs the away toggle and the idle tracker call.
 *
 * Two independent local signals feed one published `away` flag:
 *   manualAwayAtom — flipped by the user's away toggle. STICKY: only the toggle
 *     clears it, so the click that sets it (itself "activity") can't instantly
 *     un-set it, and a deliberate "I'm away" survives you nudging the mouse.
 *   autoIdleAtom  — flipped true by the idle tracker after AWAY_AFTER_MS of no
 *     input, and false again on the very next input ("clear as soon as I'm
 *     back"). Never sticky.
 * Published away = manual OR idle (selfAway), read inside App.tsx's
 * getUserPresence so flipping either atom republishes our presence meta — the
 * same mechanism (and channel) as Present's presentingAtom, so away needs NO
 * server changes and never removes anyone from the roster/participant count.
 */
import { useEffect } from 'react'
import { atom } from 'tldraw'
import { AWAY_AFTER_MS, isIdle } from './awayLogic'

// How often the idle tracker samples for the threshold crossing — coarse
// relative to AWAY_AFTER_MS (a couple of minutes), so the poll cost is
// negligible while still flipping "away" within a few seconds of the user
// actually going still.
const IDLE_CHECK_MS = 5_000

/** Sticky manual away — set/cleared only by the toggle (toggleAway). */
export const manualAwayAtom = atom('ew manual away', false)

/** Auto-idle away — owned by useAutoAway; cleared on the next input. */
export const autoIdleAtom = atom('ew auto idle', false)

/**
 * This client's published away state: manual OR auto-idle. Called inside
 * App.tsx's getUserPresence (a reactive derivation), so reading both atoms
 * here means flipping either republishes presence — same wiring as
 * presentingAtom.
 */
export function selfAway(): boolean {
	return manualAwayAtom.get() || autoIdleAtom.get()
}

/**
 * Toggle the away state for the away button. Going away just sets the sticky
 * manual flag; coming back clears BOTH signals, so an auto-idle client who
 * clicks "back" returns cleanly. The tracker's own listeners also see the
 * click, but clearing here makes the button authoritative rather than racing
 * them.
 */
export function toggleAway() {
	if (selfAway()) {
		manualAwayAtom.set(false)
		autoIdleAtom.set(false)
	} else {
		manualAwayAtom.set(true)
	}
}

/**
 * Auto-idle tracker (mount once, App-level): flips autoIdleAtom true after
 * AWAY_AFTER_MS with no user input, and false again on the next input. Manual
 * away is untouched — a user who deliberately went away stays away through the
 * odd stray event. Input is sampled on a coarse interval rather than on every
 * pointermove: we only need to notice the boundary crossing, and isIdle is the
 * single source of truth for it.
 */
export function useAutoAway() {
	useEffect(() => {
		let lastActivity = Date.now()
		const onActivity = () => {
			lastActivity = Date.now()
			if (autoIdleAtom.get()) autoIdleAtom.set(false)
		}
		const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const
		for (const type of events) window.addEventListener(type, onActivity, { passive: true })
		const interval = setInterval(() => {
			if (isIdle(lastActivity, Date.now()) && !autoIdleAtom.get()) autoIdleAtom.set(true)
		}, IDLE_CHECK_MS)
		return () => {
			for (const type of events) window.removeEventListener(type, onActivity)
			clearInterval(interval)
		}
	}, [])
}
