// Run: bun e2e/lib/load-metrics.test.ts
// Pure summarisation helpers for the v2 load harness — no browser, no server.
import assert from 'node:assert/strict'
import { summarize, attribute, type LoadSample } from './load-metrics.ts'

{
	// n/p50/max/min/spread over a known set. NOTE the deliberate absence of p95:
	// under the house formula floor(0.95*n) === n-1 for every n <= 20, so at any
	// rep count this harness runs, p95 would be identically maxms. See the plan's
	// CHANGE NOTE — p50 is the hard gate here, not p95.
	const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
	assert.equal(s.n, 10)
	assert.equal(s.p50ms, 60)
	assert.equal(s.maxms, 100)
	assert.equal(s.minms, 10)
	assert.equal(s.spreadMs, 90)
	console.log('ok: summarize computes n/p50/max/min/spread over a known set')
}
{
	// Odd n: p50 is the EXACT middle sample. This is the property the gate relies
	// on, and the reason REPS must stay odd (floor(0.5*5) = 2 -> the 3rd of 5).
	const s = summarize([10, 20, 30, 40, 1000])
	assert.equal(s.p50ms, 30)
	// ...and the single wild outlier that a max gate would have failed on shows
	// up loudly in the ADVISORY statistics instead. That division of labour is
	// the whole point of the redesign.
	assert.equal(s.maxms, 1000)
	assert.equal(s.spreadMs, 990)
	assert.ok(s.cvPct > 100, 'a 100x outlier must blow the coefficient of variation')
	console.log('ok: p50 ignores a single wild outlier that max and cvPct both flag')
}
{
	// Single sample: everything collapses to it, spread is 0, cv is 0 — no NaN
	// (cvPct must not divide by a zero mean or produce 0/0).
	const s = summarize([42])
	assert.deepEqual(
		{ n: s.n, p50ms: s.p50ms, maxms: s.maxms, minms: s.minms, spreadMs: s.spreadMs, cvPct: s.cvPct },
		{ n: 1, p50ms: 42, maxms: 42, minms: 42, spreadMs: 0, cvPct: 0 },
	)
	console.log('ok: summarize collapses cleanly on a single sample')
}
{
	// Empty input must throw, not silently return zeros — a zeroed perf number
	// that looks like a pass is the worst possible failure mode here.
	assert.throws(() => summarize([]), /at least one sample/)
	console.log('ok: summarize refuses an empty sample set')
}
{
	// NON-FINITE input must throw, for the same reason as the empty guard and one
	// worse: a NaN comparator return makes Array#sort's order ARBITRARY, so a
	// single NaN corrupts minms/maxms too, not just the stat it landed in. This
	// is the last common chokepoint before a number becomes a CI gate.
	assert.throws(() => summarize([10, NaN, 30]), /finite/)
	assert.throws(() => summarize([10, Infinity]), /finite/)
	console.log('ok: summarize refuses non-finite samples rather than propagating NaN')
}
{
	// Rounding: two decimal places, matching lib/perf.ts's FrameStats convention.
	const s = summarize([1.23456, 2.34567, 3.45678])
	assert.equal(s.p50ms, 2.35)
	console.log('ok: summarize rounds to 2dp like FrameStats')
}
{
	// attribute() turns one raw sample into the named sub-splits. The gap the
	// whole harness exists to expose is toolbarToFirstShapeMs.
	const sample: LoadSample = { wsOpenMs: 120, chunkResponseEndMs: 800, toolbarMs: 900, firstShapeMs: 2400 }
	const a = attribute(sample)
	assert.equal(a.firstShapeMs, 2400)
	assert.equal(a.toolbarToFirstShapeMs, 1500)
	assert.equal(a.chunkToToolbarMs, 100)
	assert.equal(a.wsOpenMs, 120)
	assert.equal(a.chunkResponseEndMs, 800)
	console.log('ok: attribute derives the toolbar->first-shape and chunk->toolbar gaps')
}
{
	// A null chunk timing (dev server: no single named chunk exists) must
	// propagate as null, never as 0 — 0 would read as "instant" and quietly
	// corrupt the attribution.
	const a = attribute({ wsOpenMs: 50, chunkResponseEndMs: null, toolbarMs: 300, firstShapeMs: 900 })
	assert.equal(a.chunkResponseEndMs, null)
	assert.equal(a.chunkToToolbarMs, null)
	assert.equal(a.toolbarToFirstShapeMs, 600)
	console.log('ok: attribute propagates a missing chunk timing as null, never 0')
}
{
	// toolbarMs feeds BOTH derived splits, including toolbarToFirstShapeMs —
	// the metric this harness exists to produce. If the null guard ever
	// regresses to only checking the `earlier` operand, round2(null - 300)
	// yields -300: a plausible-looking negative that would be believed.
	const a = attribute({ wsOpenMs: 50, chunkResponseEndMs: 800, toolbarMs: null, firstShapeMs: 900 })
	assert.equal(a.toolbarMs, null)
	assert.equal(a.chunkToToolbarMs, null)
	assert.equal(a.toolbarToFirstShapeMs, null)
	assert.equal(a.firstShapeMs, 900)
	console.log('ok: attribute propagates a missing toolbar mark to both derived gaps')
}
{
	// wsOpenMs is passed through, not derived — a missing one must stay null
	// rather than becoming a 0 that reads as "connected instantly".
	const a = attribute({ wsOpenMs: null, chunkResponseEndMs: 800, toolbarMs: 900, firstShapeMs: 2400 })
	assert.equal(a.wsOpenMs, null)
	assert.equal(a.chunkToToolbarMs, 100)
	assert.equal(a.toolbarToFirstShapeMs, 1500)
	console.log('ok: attribute passes a missing ws-open mark through as null')
}

console.log('ok: load-metrics — all cases')
