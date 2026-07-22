/**
 * Connection-health thresholds.
 *
 * THESE DEFAULTS ARE EDUCATED GUESSES WITH NO FIELD DATA BEHIND THEM YET
 * (design doc §3). They exist to be refined once we have watched real
 * sessions. Lower = faster warning, more false alarms from transient blips;
 * higher = fewer false alarms, longer staring at a subtly-broken canvas.
 * Every one is overridable at build time via a VITE_* env var so a dogfood
 * build can be retuned without a code change.
 *
 * readThresholds is PURE (takes the env record) so it is unit-testable under
 * bare bun; only getThresholds() touches import.meta.env, and it does so
 * inside a function — never at module top level (see client/src/engine.ts for
 * the same split and why).
 */
export interface Thresholds {
	/** Canvas-sync unhealthy for >= this long ⇒ tripped ⇒ blocked. */
	canvasMs: number
	/** Terminals unhealthy for >= this long ⇒ tripped ⇒ blocked. */
	terminalMs: number
	/** Probe cadence: one evaluation of every transport per tick. */
	probeIntervalMs: number
	/** A probe still outstanding after this long counts as a miss. */
	probeTimeoutMs: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	// Most dangerous plane (edits silently stop syncing) → warn fastest.
	// ~2 failed 2s ticks distinguishes a real drop from one dropped ping.
	canvasMs: 3000,
	// Terminal drops are routine, self-healing, and already show their own
	// per-tile "reconnecting" state → escalate later.
	terminalMs: 8000,
	probeIntervalMs: 2000,
	probeTimeoutMs: 4000,
}

// LiveKit deliberately has NO threshold: it is displayed but never blocking
// (design §3). Do not add one here without changing that decision.

type EnvRecord = Record<string, string | boolean | undefined>

/** Parse a positive whole number of ms, falling back on anything else. */
function positiveMs(raw: string | boolean | undefined, fallback: number): number {
	if (typeof raw !== 'string') return fallback
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return fallback
	return Math.floor(n)
}

export function readThresholds(env: EnvRecord): Thresholds {
	return {
		canvasMs: positiveMs(env.VITE_CONN_HEALTH_CANVAS_MS, DEFAULT_THRESHOLDS.canvasMs),
		terminalMs: positiveMs(env.VITE_CONN_HEALTH_TERMINAL_MS, DEFAULT_THRESHOLDS.terminalMs),
		probeIntervalMs: positiveMs(env.VITE_CONN_HEALTH_PROBE_MS, DEFAULT_THRESHOLDS.probeIntervalMs),
		probeTimeoutMs: positiveMs(env.VITE_CONN_HEALTH_TIMEOUT_MS, DEFAULT_THRESHOLDS.probeTimeoutMs),
	}
}

/** The live thresholds for this build. Call from a hook, not at module scope. */
export function getThresholds(): Thresholds {
	return readThresholds(import.meta.env as unknown as EnvRecord)
}
