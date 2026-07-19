// Pure summarisation + attribution for the canvas-v2 load harness
// (perf/canvas-v2-load.spec.ts). Deliberately browser-free and server-free so
// it is unit-testable under plain `bun` — the browser-side collection lives in
// lib/load-probe.ts, the scenario driving in the spec.
//
// PERCENTILE CONVENTION: identical to lib/perf.ts's `measure()` —
// sorted[floor(q * len)], clamped to the last index. Reusing the house
// formula on purpose: two different percentile definitions in one repo's perf
// numbers would be a silent, permanent apples-to-oranges bug.

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
	readonly p50ms: number
	readonly p95ms: number
	readonly maxms: number
}

const round2 = (n: number) => Number(n.toFixed(2))

export function summarize(samples: readonly number[]): Summary {
	if (samples.length === 0) throw new Error('summarize: needs at least one sample')
	const sorted = [...samples].sort((a, b) => a - b)
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
	return {
		n: sorted.length,
		minms: round2(sorted[0]!),
		p50ms: round2(pick(0.5)),
		p95ms: round2(pick(0.95)),
		maxms: round2(sorted[sorted.length - 1]!),
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
