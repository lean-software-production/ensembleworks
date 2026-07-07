/**
 * The relay parity contract (plugin-architecture track charter §"#5"): the
 * reconnect/ping/read-limit/shed constants the native connector reproduces from
 * gateway-go/relay/relay.go, plus the pure backoff curve. Enforced in
 * cli/src/connector/{relay-client,mux}.ts; pinned by connector/backoff.test.ts.
 */

/** Exponential backoff base — the first reconnect waits ~1 s (× jitter). */
export const RELAY_BACKOFF_BASE_MS = 1_000
/** Backoff cap — no reconnect delay exceeds ~30 s (× jitter). */
export const RELAY_BACKOFF_CAP_MS = 30_000
/** The shift is min(attempt-1, 5): 1,2,4,8,16,32→cap at every later attempt. */
export const RELAY_BACKOFF_EXPONENT_CAP = 5
/** Multiplicative jitter window applied to the computed backoff (0.8–1.2×). */
export const RELAY_JITTER_MIN = 0.8
export const RELAY_JITTER_MAX = 1.2
/** A connection that survives longer than this resets the backoff counter. */
export const RELAY_HEALTHY_RESET_MS = 30_000
/** Ping cadence — matches the splicer heartbeat (gateway-registry.ts). */
export const RELAY_PING_INTERVAL_MS = 20_000
/** Inbound frame ceiling — the ws client's maxPayload (coder SetReadLimit 1<<20). */
export const RELAY_READ_LIMIT_BYTES = 1 << 20
/** Per-channel FIFO depth; the 65th queued frame is shed, never blocks the read loop. */
export const RELAY_CHANNEL_QUEUE_DEPTH = 64

/**
 * The jittered exponential backoff for reconnect attempt `attempt` (1-based:
 * the first retry is attempt 1, matching relay.go's post-increment). Pure:
 * `rng` defaults to Math.random and is injected in tests for a deterministic
 * curve. Returns whole milliseconds.
 *
 * attempt: 1→~1s 2→~2s 3→~4s 4→~8s 5→~16s 6+→~30s (32s clamped to the cap),
 * each × a uniform [0.8, 1.2) factor — identical to relay.go lines 121–126.
 */
export function computeBackoff(attempt: number, rng: () => number = Math.random): number {
	const shift = Math.min(attempt - 1, RELAY_BACKOFF_EXPONENT_CAP)
	const base = Math.min(RELAY_BACKOFF_BASE_MS * 2 ** shift, RELAY_BACKOFF_CAP_MS)
	const jitter = RELAY_JITTER_MIN + (RELAY_JITTER_MAX - RELAY_JITTER_MIN) * rng()
	return Math.floor(base * jitter)
}
