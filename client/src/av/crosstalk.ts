/**
 * Cross-room "crosstalk" bleed: how loudly you hear teammates who are on a
 * different page / in another room. Pure — no tldraw / livekit import — so the
 * per-peer gain decision is unit-tested under bun exactly like spatial.ts.
 *
 * The whole feature rides the SAME single per-participant GainNode the spatial
 * loop already drives (useSpatialGainLoop): this module only decides the TARGET
 * that one gain is steered to, per peer, per tick. Exactly one gain per
 * participant means cross-room bleed can never double a voice or echo — it is
 * the same audio path as in-room voice, just held open at a chosen level
 * instead of clamped to zero the moment a teammate leaves your page.
 */

/** 0 = off-page teammates are silent (today's behavior); 1 = as loud as if
 * they were on my page. The slider default is silence, so nothing changes
 * until you deliberately dial some bleed in. */
export const DEFAULT_CROSSTALK_LEVEL = 0

/**
 * Clamp a raw slider value into the crosstalk range [0,1]. Non-finite input
 * (NaN / ±∞) falls back to the default, mirroring spatial's finite guard
 * (gainForDistance's `!Number.isFinite(distance) → floor`).
 */
export function clampCrosstalk(level: number): number {
	if (!Number.isFinite(level)) return DEFAULT_CROSSTALK_LEVEL
	if (level < 0) return 0
	if (level > 1) return 1
	return level
}

/** Where a peer sits relative to me this tick, for the gain decision. */
export type PeerLocation = 'my-page' | 'other-page' | 'absent'

export interface GainTargetInput {
	/** my-page: on the page I'm viewing; other-page: elsewhere in the room;
	 * absent: not present in tldraw on any page (truly gone). */
	location: PeerLocation
	/** Standup mode pins everyone on MY page to full volume — unchanged. */
	standupMode: boolean
	/** The distance-based spatial gain for a peer on my page (0..1). */
	pageGain: number
	/** The crosstalk bleed level (0..1) for peers on another page. */
	crosstalk: number
}

/**
 * The gain TARGET for one peer this tick — the single decision the spatial loop
 * makes, pulled out so it's testable without an AudioContext:
 *
 *   absent      → 0   (not in presence anywhere: today's behavior, never bled)
 *   other-page  → crosstalk bleed level (0 = today's silence, 1 = full)
 *   my-page     → standup ? 1 : distance-based pageGain   (unchanged)
 *
 * Crosstalk owns the off-page regime alone: neither standup nor page distance
 * touches an off-page peer, and the crosstalk level never touches an on-page
 * one. That keeps in-room voice behaving exactly as before.
 */
export function gainTarget(input: GainTargetInput): number {
	const { location, standupMode, pageGain, crosstalk } = input
	if (location === 'absent') return 0
	if (location === 'other-page') return clampCrosstalk(crosstalk)
	return standupMode ? 1 : pageGain
}
