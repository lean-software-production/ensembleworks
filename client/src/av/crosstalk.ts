/**
 * Crosstalk: ONE dial for "how loud are people I can't currently see?".
 * Pure — no tldraw / livekit import — so the per-peer gain decision is
 * unit-tested under bun exactly like spatial.ts.
 *
 * The viewport-rect spatial model (spatial.ts) puts anyone whose cursor is
 * inside my viewport at full volume. This module governs everyone else:
 *
 *   - On my page, outside my view: the fade bottoms out at the crosstalk
 *     level (the loop passes it as the fade's floor), so the slider IS the
 *     "softest you can be on the current page".
 *   - On another page: one step further away — the same fade slope continued
 *     one more falloff-distance past the floor (otherPageLevel: 2·L − 1,
 *     clamped to 0).
 *   - Slider at 1: everyone everywhere is full volume (the old standup mode).
 *   - Slider at 0: only who you can see (strict focus).
 *
 * The whole feature rides the SAME single per-participant GainNode the
 * spatial loop drives (useSpatialGainLoop): this module only decides the
 * TARGET that one gain is steered to, per peer, per tick. Exactly one gain
 * per participant means cross-room bleed can never double a voice or echo.
 */

/** Default: full — you hear everyone on every page until you dial focus in.
 * (Slider max replaces the old standup-mode checkbox.) */
export const DEFAULT_CROSSTALK_LEVEL = 1

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

/** Slider level where the other-page mapping switches from the linear
 * "one step further" slope to the gentle tail (2·0.55 − 1 = the tail's 10%
 * starting volume — the two pieces meet exactly at the knee). */
export const OTHER_PAGE_TAIL_KNEE = 0.55

// The other-page volume at the knee: below 10% the old linear slope snapped
// to hard zero within one 5% slider step; the tail replaces that cliff.
const TAIL_TOP = 0.1

/**
 * The other-page volume for a crosstalk level: "one step further away than
 * the softest you can be on the current page". The same-page fade drops
 * (1 − L) over one falloff-distance to bottom out at L; continuing that
 * slope one more falloff-distance gives L − (1 − L) = 2L − 1 … down to the
 * 10% knee (L = 0.55). Below the knee the mapping hands over to a quadratic
 * tail — TAIL_TOP · (L/knee)² — so the last stretch of the dial sweeps very
 * gradually through ~8%, 4%, 2%, 1% instead of snapping to silence: quiet
 * ambient murmur from other rooms stays dialable. Exactly 0 at L = 0
 * (strict focus) and full at 1 (standup mode), as before.
 */
export function otherPageLevel(level: number): number {
	const l = clampCrosstalk(level)
	if (l >= OTHER_PAGE_TAIL_KNEE) return 2 * l - 1
	const t = l / OTHER_PAGE_TAIL_KNEE
	return TAIL_TOP * t * t
}

/** Where a peer sits relative to me this tick, for the gain decision. */
export type PeerLocation = 'my-page' | 'other-page' | 'absent'

export interface GainTargetInput {
	/** my-page: on the page I'm viewing; other-page: elsewhere in the room;
	 * absent: not present in tldraw on any page (truly gone). */
	location: PeerLocation
	/** The viewport-rect spatial gain for a peer on my page (0..1). The loop
	 * computes it with the crosstalk level as the fade's floor, so it already
	 * embodies the slider for on-page peers. */
	pageGain: number
	/** The crosstalk level (0..1): the volume of the softest on-page peer,
	 * and (one step further) the volume of other-page peers. */
	crosstalk: number
}

/**
 * The gain TARGET for one peer this tick — the single decision the spatial
 * loop makes, pulled out so it's testable without an AudioContext:
 *
 *   absent      → 0   (not in presence anywhere: truly gone, never bled in)
 *   other-page  → otherPageLevel(crosstalk)   (one step past the floor)
 *   my-page     → pageGain   (in view = 1; outside fades to the crosstalk floor)
 */
export function gainTarget(input: GainTargetInput): number {
	const { location, pageGain, crosstalk } = input
	if (location === 'absent') return 0
	if (location === 'other-page') return otherPageLevel(crosstalk)
	return pageGain
}
