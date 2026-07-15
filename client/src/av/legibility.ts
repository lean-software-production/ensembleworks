/**
 * Pure gain→visual mappings for the spatial-audio legibility layer: every
 * surface that shows a teammate also shows how audible they are, driven by
 * the SAME applied per-peer gain the audio loop publishes (av/bridge.ts) —
 * never a parallel computation, so what you see always matches what you hear.
 *
 * Pure — no tldraw / livekit imports — so it's unit-tested under bare bun
 * exactly like spatial.ts and crosstalk.ts.
 */

/** Video tiles never dim below this: a quiet teammate looks distant, not gone. */
export const TILE_OPACITY_FLOOR = 0.35

/** Canvas cursors never fade below this alpha. */
export const CURSOR_ALPHA_FLOOR = 0.3

/** At or below this gain a tile also gets a non-opacity "quiet" cue, so the
 * state is legible to users who can't perceive the dimming. */
export const QUIET_GAIN_THRESHOLD = 0.25

/** Gains are snapped to this step before publishing, so the bridge store only
 * notifies (and React only re-renders) on humanly-visible changes. The audio
 * GainNode gets the raw target; only the visual copy is quantised. */
export const GAIN_QUANTUM = 0.05

function clamp01(value: number): number {
	if (value < 0) return 0
	if (value > 1) return 1
	return value
}

/** Tile opacity for an applied gain (0..1). Non-finite → 1: fail visible. */
export function tileOpacityForGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	return TILE_OPACITY_FLOOR + (1 - TILE_OPACITY_FLOOR) * clamp01(gain)
}

/** Cursor alpha for an applied gain (0..1). Non-finite → 1: fail visible. */
export function cursorAlphaForGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	return CURSOR_ALPHA_FLOOR + (1 - CURSOR_ALPHA_FLOOR) * clamp01(gain)
}

/** Snap a gain to GAIN_QUANTUM steps, clamped to [0,1]. Non-finite → 1,
 * matching the loop's "peer with no cursor yet counts as full volume".
 * Rounds the quantized result to 2dp so results like 0.55 are exact,
 * avoiding binary floating-point artifacts (e.g. 0.55000000000000004). */
export function quantizeGain(gain: number): number {
	if (!Number.isFinite(gain)) return 1
	const stepped = Math.round(clamp01(gain) / GAIN_QUANTUM) * GAIN_QUANTUM
	return Math.round(stepped * 100) / 100
}
