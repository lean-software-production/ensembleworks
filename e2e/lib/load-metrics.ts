// Pure summarisation + attribution for the canvas-v2 load harness
// (perf/canvas-v2-load.spec.ts). Deliberately browser-free and server-free so
// it is unit-testable under plain `bun` — the browser-side collection lives in
// lib/load-probe.ts, the scenario driving in the spec.
//
// PERCENTILE CONVENTION: identical to lib/perf.ts's `measure()` —
// sorted[floor(q * len)], clamped to the last index. Reusing the house
// formula on purpose: two different percentile definitions in one repo's perf
// numbers would be a silent, permanent apples-to-oranges bug.
//
// WHY THERE IS NO p95 HERE — deliberate, do not "restore" it. Under that same
// house formula, floor(0.95 * n) === n - 1 for EVERY n <= 20, so at this
// harness's rep counts p95 is not a percentile at all: it is identically
// maxms. A report field that always equals another field is worse than absent,
// because it implies information it does not carry. The sibling frame-rate
// spec (perf/canvas-v2-perf.spec.ts) gates on p95 legitimately because one of
// its runs yields HUNDREDS of frame samples; one of these runs yields FIVE
// whole page loads. p50 is the hard gate here and maxms/spreadMs/cvPct are the
// advisory signals. Full reasoning: docs/plans/2026-07-19-v2-first-shape-perf-
// harness.md, CHANGE NOTE 2026-07-19. If REPS is ever raised above 20, p95
// becomes meaningful again — re-add it AND justify the n in the same commit.

/** One browser navigation's raw page-time marks, in ms since navigation start.
 * `chunkResponseEndMs` is null when no single lazy chunk exists to time (the
 * Vite DEV server serves the v2 graph as hundreds of unbundled modules) or
 * when the arm under test is v1 (no v2 chunk at all). */
export interface LoadSample {
	readonly wsOpenMs: number | null
	readonly chunkResponseEndMs: number | null
	readonly toolbarMs: number | null
	readonly firstShapeMs: number
}

export interface Attribution {
	readonly wsOpenMs: number | null
	readonly chunkResponseEndMs: number | null
	readonly toolbarMs: number | null
	readonly firstShapeMs: number
	/** chunk responseEnd -> toolbar visible: module eval + WASM init + boot. */
	readonly chunkToToolbarMs: number | null
	/** Toolbar visible -> first pre-seeded shape painted. THE metric this whole
	 * harness exists for: the toolbar can appear long before shapes do, and
	 * that gap is the user-visible symptom being hunted. */
	readonly toolbarToFirstShapeMs: number | null
}

export interface Summary {
	readonly n: number
	readonly minms: number
	/** THE HARD GATE. At odd n this is the exact middle sample — robust to the
	 * one-contended-rep failure mode a shared CI runner actually produces. */
	readonly p50ms: number
	/** ADVISORY only. Worst single rep. */
	readonly maxms: number
	/** ADVISORY only. max - min, in ms. Absolute and directly readable. */
	readonly spreadMs: number
	/** ADVISORY only. Coefficient of variation (population stddev / mean), as a
	 * percentage. Scale-free, so it is comparable across the 100-shape and
	 * 1000-shape scenarios and across months — which raw spread is not. A rising
	 * cvPct is usually the earliest honest sign that a measurement has stopped
	 * being trustworthy, well before any gate trips. */
	readonly cvPct: number
}

const round2 = (n: number) => Number(n.toFixed(2))

export function summarize(samples: readonly number[]): Summary {
	if (samples.length === 0) throw new Error('summarize: needs at least one sample')
	// Non-finite guard, BEFORE the sort. A NaN comparator return makes Array#sort
	// order arbitrary, so one NaN corrupts min and max as well as the stat it
	// landed in — and every one of these numbers feeds a CI gate. Refuse loudly.
	for (const v of samples) {
		if (!Number.isFinite(v)) throw new Error(`summarize: every sample must be finite, got ${String(v)}`)
	}
	const sorted = [...samples].sort((a, b) => a - b)
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
	const min = sorted[0]!
	const max = sorted[sorted.length - 1]!
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
	const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
	return {
		n: sorted.length,
		minms: round2(min),
		p50ms: round2(pick(0.5)),
		maxms: round2(max),
		spreadMs: round2(max - min),
		// mean === 0 only if every sample is 0, in which case the spread is 0 too
		// and 0 is the honest answer — never NaN from a 0/0.
		cvPct: mean === 0 ? 0 : round2((Math.sqrt(variance) / mean) * 100),
	}
}

/** Null-propagating subtraction: a missing endpoint yields null, NEVER 0. */
const gap = (later: number | null, earlier: number | null): number | null =>
	later === null || earlier === null ? null : round2(later - earlier)

export function attribute(s: LoadSample): Attribution {
	return {
		wsOpenMs: s.wsOpenMs === null ? null : round2(s.wsOpenMs),
		chunkResponseEndMs: s.chunkResponseEndMs === null ? null : round2(s.chunkResponseEndMs),
		toolbarMs: s.toolbarMs === null ? null : round2(s.toolbarMs),
		firstShapeMs: round2(s.firstShapeMs),
		chunkToToolbarMs: gap(s.toolbarMs, s.chunkResponseEndMs),
		toolbarToFirstShapeMs: gap(s.firstShapeMs, s.toolbarMs),
	}
}
