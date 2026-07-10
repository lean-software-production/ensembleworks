/**
 * AFK / "away" derivation — pure functions over presence meta and the wall
 * clock, no tldraw import, so both rules are unit-tested under bun the same way
 * handQueue is (see awayLogic.test.ts).
 *
 * Like Present mode, away rides the SAME presence `meta` blob App.tsx already
 * publishes (see chrome/away.ts and App.tsx's getUserPresence): each client
 * owns one tiny JSON-serializable boolean —
 *   away: boolean   — true while this client is AFK (manual toggle OR the
 *                     auto-idle rule below). Every peer derives "who's away"
 *                     by scanning presence for meta.away === true, exactly as
 *                     Present derives the presenter. Because away is only a
 *                     flag, an away client stays fully in the roster and the
 *                     participant count — nobody drops off the canvas — and
 *                     coming back is instant: clearing the flag republishes
 *                     presence with no rejoin. No server message is involved.
 */

/** Idle threshold: a client with zero input for this long auto-flips to away.
 * Long enough that focused reading/thinking without mouse movement doesn't
 * trip it, short enough to catch a real step-away; any input clears it
 * instantly (chrome/away.ts's tracker). */
export const AWAY_AFTER_MS = 120_000

export interface PresenceLike {
	meta?: unknown
}

/**
 * Does this collaborator's presence meta mark them away? Strict `=== true`
 * (as with Present's meta.presenting) so only a genuine away flag counts — a
 * missing or malformed field reads as present, never accidentally away. The
 * one place the meta.away shape is asserted; the roster (PanelPages) and the
 * collapsed rail (SidePanel) both derive peer away through here.
 */
export function isAwayPresence(p: PresenceLike): boolean {
	const meta = p.meta as { away?: unknown } | undefined
	return meta?.away === true
}

/**
 * Auto-idle rule: a client is idle once it's gone at least `idleAfterMs`
 * without input (now − last activity ≥ threshold). Boundary-inclusive so the
 * flip is deterministic exactly at the threshold. Any input resets
 * lastActivity, so this returns false again immediately on return — the
 * "clear as soon as I'm back" half of the feature.
 */
export function isIdle(
	lastActivityTs: number,
	now: number,
	idleAfterMs: number = AWAY_AFTER_MS,
): boolean {
	return now - lastActivityTs >= idleAfterMs
}
