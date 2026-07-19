// Run: bun e2e/lib/load-metrics.test.ts
// Pure summarisation helpers for the v2 load harness — no browser, no server.
import assert from 'node:assert/strict'
import { summarize, attribute, type LoadSample } from './load-metrics.ts'

{
	// p50/p95/max over a known set. 10 samples -> p95 index = floor(0.95*10) = 9 -> the max.
	const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
	assert.equal(s.n, 10)
	assert.equal(s.p50ms, 60)
	assert.equal(s.p95ms, 100)
	assert.equal(s.maxms, 100)
	assert.equal(s.minms, 10)
	console.log('ok: summarize computes n/p50/p95/max/min over a known set')
}
{
	// Single sample: every percentile collapses to it (no NaN, no undefined).
	const s = summarize([42])
	assert.deepEqual({ n: s.n, p50ms: s.p50ms, p95ms: s.p95ms, maxms: s.maxms, minms: s.minms }, { n: 1, p50ms: 42, p95ms: 42, maxms: 42, minms: 42 })
	console.log('ok: summarize collapses cleanly on a single sample')
}
{
	// Empty input must throw, not silently return zeros — a zeroed perf number
	// that looks like a pass is the worst possible failure mode here.
	assert.throws(() => summarize([]), /at least one sample/)
	console.log('ok: summarize refuses an empty sample set')
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
