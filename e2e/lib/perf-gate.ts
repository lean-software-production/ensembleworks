/**
 * Vsync-quantised perf gating for the browser perf rigs.
 *
 * WHY THIS EXISTS (2026-07-27). The rAF sampler in lib/perf.ts floors at the
 * display's refresh interval, so a measured frame time is not a continuous
 * quantity: it lands in a discrete bucket (~16.7 / ~33.3 / ~50 / …ms). A
 * threshold expressed in raw ms therefore does not mean what it reads as. The
 * canvas-v2-perf dense-1000 scenario is the worked example: its committed p95
 * baseline is 16.8ms (ONE refresh, captured on a dev box), so the regression
 * gate computes to 16.8 x 1.15 x 2 = 38.64ms — a number no sample can ever
 * take. A frame costing 38.64ms of work misses two refreshes and REPORTS as
 * ~50ms, so the gate silently degenerates to "<= 2 refreshes", one whole
 * bucket below the threshold it claims to enforce.
 *
 * On a contended CI runner that scenario sits AT 2 refreshes, i.e. exactly on
 * the gate with zero headroom, and the moment one extra refresh is dropped the
 * measurement jumps to ~50ms and misses by 30%. There is no gradual signal to
 * read: the gate is a coin flip on runner load, and it has been failing on
 * `main`'s nightly runs (2026-07-23 and 2026-07-26, both this same scenario)
 * as well as on PRs that touch nothing near the renderer.
 *
 * This module makes the gate mean what it says by rounding an intended
 * threshold UP to the smallest bucket that satisfies it. It is the same
 * reasoning the MAX-GATE POLICY (2026-07-16) already applied to `maxms` in
 * canvas-v2-perf.spec.ts — quantisation makes a sub-bucket threshold
 * unenforceable — applied to the threshold arithmetic itself rather than by
 * demoting the metric to advisory. Regression detection is preserved: a gate
 * that admits N refreshes still fails at N+1, which is the smallest
 * regression the rig can actually observe.
 */

/** The display refresh interval the sampler floors to (~16.67ms at 60Hz). */
export const VSYNC_MS = 1000 / 60

// Guards `Math.ceil` against a threshold that is a whole number of refreshes
// in intent but lands a float ULP above one (e.g. 2 * VSYNC_MS), which would
// otherwise hand the gate a free extra refresh.
const EPSILON = 1e-9

/** Nearest whole vsync-refresh count for a ms figure — e.g. 116.7ms -> 7. */
export function refreshes(ms: number): number {
	return Math.round(ms / VSYNC_MS)
}

/**
 * The enforceable gate for an intended ms threshold: the last refresh bucket
 * that still satisfies it, compared at that bucket's upper midpoint.
 *
 * Rounding UP is the point — a threshold of 38.64ms lies inside the 3-refresh
 * bucket, and a sample of ~50ms is indistinguishable from a 38.64ms frame
 * because both report as three refreshes, so tolerating that bucket is the
 * only honest reading. The half-refresh offset sits the comparison clear of
 * the bucket it admits: real samples carry jitter (16.80, 33.30 and 50.10 are
 * all observed for buckets 1, 2 and 3), so a gate placed exactly on N *
 * VSYNC_MS would reject the very bucket it means to allow.
 */
export function effectiveGate(intendedMs: number): number {
	return (gateRefreshes(intendedMs) + 0.5) * VSYNC_MS
}

/** How many whole refreshes `intendedMs` admits — the bucket `effectiveGate`
 * rounds up to, and the honest way to describe a gate in a log line ("enforced
 * at <= 3 refreshes" rather than a mid-bucket ms figure nothing can equal). */
export function gateRefreshes(intendedMs: number): number {
	return Math.ceil(intendedMs / VSYNC_MS - EPSILON)
}

/** `ms` formatted with its nearest-refresh count alongside, e.g. "116.70ms (7 refreshes)". */
export function msQuanta(ms: number): string {
	return `${ms.toFixed(2)}ms (${refreshes(ms)} refreshes)`
}

/** A raw (pre-quantisation) GATE value rarely lands on a whole refresh
 * boundary — describe it as sitting between the two quanta it falls between
 * (or "= N refreshes" on the rare exact hit), so a reader can tell at a glance
 * how many whole frames of headroom the intended threshold gave before
 * `effectiveGate` rounded it to an enforceable one. */
export function gateQuanta(ms: number): string {
	const lo = Math.floor(ms / VSYNC_MS)
	const hi = Math.ceil(ms / VSYNC_MS)
	return lo === hi ? `= ${lo} refreshes` : `sits between ${lo} and ${hi}`
}
