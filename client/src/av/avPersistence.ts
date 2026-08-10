/**
 * Persist the user's mic/cam preference across a page refresh — but revert to
 * off if the session went stale.
 *
 * WHY: `useLiveKitRoom` re-joins from scratch on every mount, so a refresh used
 * to drop you to mic-muted/cam-off every time — real friction in an all-day
 * session. We persist the last mic/cam state so a refresh restores it.
 *
 * THE STALENESS GUARD is the whole reason this is more than a one-liner: a page
 * that comes up with your camera already live, without a deliberate click, is a
 * privacy hazard (you refreshed and stepped away; the browser restored tabs the
 * next morning). So we stamp the stored prefs with a `lastActiveAt` — updated
 * from REAL user activity, not a tab-alive heartbeat — and on load we only
 * restore mic/cam if that activity was recent (`AV_STALE_MS`). A long-idle or
 * next-day load falls back to the privacy-safe default: both off.
 *
 * The core (`resolveInitialAv`, `serializeAv`) is pure and unit-tested; the
 * thin wrappers below touch `localStorage`/`Date.now` and are the only impure
 * surface. Everything fails safe to "off" — a malformed/absent/stale record, or
 * storage throwing (private mode, disabled), never yields a surprise-on camera.
 */

export const AV_PREFS_KEY = 'ew.av.prefs'

/** No activity within this window => treat a fresh load as a new session (off). */
export const AV_STALE_MS = 60 * 60_000 // 60 minutes

/** Min gap between persisted activity stamps — a 60-min threshold does not need
 * per-pointer-move writes; this keeps the activity listener cheap. */
export const AV_ACTIVITY_THROTTLE_MS = 30_000 // 30 seconds

export interface AvPrefs {
	mic: boolean
	cam: boolean
	/** Epoch ms of the last real user activity while AV was live. */
	lastActiveAt: number
}

/**
 * Decide the mic/cam state to restore from a raw stored record. PURE — takes the
 * stored string (or null) and the current time; never reads storage or the clock.
 * Returns both-off for anything unsafe: missing, malformed, no/invalid timestamp,
 * or stale (`now - lastActiveAt >= staleMs`). Only a literal `true` counts as on,
 * so junk values can never enable a device.
 */
export function resolveInitialAv(
	raw: string | null,
	now: number,
	staleMs: number = AV_STALE_MS,
): { mic: boolean; cam: boolean } {
	const off = { mic: false, cam: false }
	if (!raw) return off
	let parsed: Partial<AvPrefs>
	try {
		parsed = JSON.parse(raw) as Partial<AvPrefs>
	} catch {
		return off
	}
	if (typeof parsed?.lastActiveAt !== 'number' || !Number.isFinite(parsed.lastActiveAt)) return off
	if (now - parsed.lastActiveAt >= staleMs) return off // stale => new session
	return { mic: parsed.mic === true, cam: parsed.cam === true }
}

/** Serialize prefs for storage, coercing mic/cam to strict booleans. PURE. */
export function serializeAv(prefs: AvPrefs): string {
	return JSON.stringify({ mic: prefs.mic === true, cam: prefs.cam === true, lastActiveAt: prefs.lastActiveAt })
}

// --- impure browser wrappers (the only localStorage/clock surface) ----------

function safeGetItem(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null // private mode / storage disabled -> behave as "no record"
	}
}

function safeSetItem(key: string, value: string): void {
	try {
		localStorage.setItem(key, value)
	} catch {
		/* storage full/disabled -> silently skip; persistence is best-effort */
	}
}

/** The mic/cam state to seed a fresh mount with (freshness-gated). */
export function loadInitialAv(now: number = Date.now()): { mic: boolean; cam: boolean } {
	return resolveInitialAv(safeGetItem(AV_PREFS_KEY), now)
}

/** Persist the current mic/cam preference, stamped with `lastActiveAt`. */
export function persistAv(mic: boolean, cam: boolean, lastActiveAt: number = Date.now()): void {
	safeSetItem(AV_PREFS_KEY, serializeAv({ mic, cam, lastActiveAt }))
}
