// Run: bun src/canvas-v2/DevOverlay.test.ts
// Component test uses renderToStaticMarkup (this house's usual rig, no DOM
// emulator needed for a pure-render component) with FIXTURE metrics data —
// see DevOverlay.tsx's own module header for why useCanvasMetrics (the
// fetch-polling half) is a separate, un-fixtured concern from this pure
// render.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DevOverlay, shouldShowDevOverlay, type CanvasMetricsPayload } from './DevOverlay.js'

// ============================================================================
// 1. Healthy room: every field renders its real (non-placeholder) value.
// ============================================================================
{
	const metrics: CanvasMetricsPayload = {
		ok: true,
		sync: { 'dogfood-1': { pendingImports: 0, malformedFrames: 0, tainted: null, diskBytes: 8192, snapshotBytes: 4096 } },
		evictions: { 'dogfood-1': { taintCount: 0, idleCount: 2, lastTaintReason: null, lastIdleReason: 'idle past TTL' } },
	}
	const html = renderToStaticMarkup(
		createElement(DevOverlay, {
			roomId: 'dogfood-1',
			connectionState: 'connected',
			client: { repairCount: 3, lastBackfillBytes: 4096 },
			metrics,
		}),
	)
	assert.ok(html.includes('dogfood-1'), 'room id is shown')
	assert.ok(html.includes('connected'), 'connection state is shown')
	assert.ok(html.includes('>3<'), `repairCount value renders — html: ${html}`)
	assert.ok(html.includes('>4096<'), `lastBackfillBytes value renders — html: ${html}`)
	assert.ok(html.includes('>0<'), 'pendingImports/malformedFrames/taintCount all read 0')
	assert.ok(html.includes('>no<'), 'a null tainted reads as the literal "no", not "null"')
	assert.ok(html.includes('>2<'), 'evictions.idleCount renders')
	assert.ok(html.includes('>8.0 KB<'), `diskBytes renders human-readable — html: ${html}`)
	assert.ok(html.includes('>2.0x<'), `disk:snapshot ratio renders (8192/4096=2.0x) — html: ${html}`)
	assert.ok(!html.includes('data-dev-overlay-warn="true"'), 'a 2.0x ratio is below the 10x S6 threshold — not flagged')
	console.log('ok: DevOverlay — healthy room renders every real metric value, including diskBytes/disk:snapshot')
}

// ============================================================================
// 1b. Disk high-water: a disk:snapshot ratio at/above the S6 threshold
//     (contracts' DISK_SUSTAINED_HIGHWATER_MULTIPLIER = 10, the SAME number
//     the server soak's assertDiskHighWater uses) is flagged, not rendered
//     identically to a healthy ratio.
// ============================================================================
{
	const metrics: CanvasMetricsPayload = {
		ok: true,
		sync: { 'dogfood-1': { pendingImports: 0, malformedFrames: 0, tainted: null, diskBytes: 409600, snapshotBytes: 4096 } },
		evictions: {},
	}
	const html = renderToStaticMarkup(
		createElement(DevOverlay, {
			roomId: 'dogfood-1',
			connectionState: 'connected',
			client: { repairCount: 0, lastBackfillBytes: 0 },
			metrics,
		}),
	)
	assert.ok(html.includes('>100.0x<'), `disk:snapshot ratio renders (409600/4096=100x) — html: ${html}`)
	assert.ok(html.includes('data-dev-overlay-warn="true"'), 'a ratio >= the 10x S6 threshold is flagged')
	console.log('ok: DevOverlay — a disk:snapshot ratio over the S6 10x threshold is flagged')
}

// ============================================================================
// 2. Tainted room + a real taint eviction: the anomaly is VISIBLE, not
//    silently 0'd out (the whole point of this overlay per the plan's G5
//    task — Open Q8/Q9/Q11's "make it observable" mandate).
// ============================================================================
{
	const metrics: CanvasMetricsPayload = {
		ok: true,
		sync: { 'dogfood-1': { pendingImports: 7, malformedFrames: 1, tainted: 'storage write failed' } },
		evictions: { 'dogfood-1': { taintCount: 1, idleCount: 0, lastTaintReason: 'storage write failed', lastIdleReason: null } },
	}
	const html = renderToStaticMarkup(
		createElement(DevOverlay, {
			roomId: 'dogfood-1',
			connectionState: 'connected',
			client: { repairCount: 12, lastBackfillBytes: 0 },
			metrics,
		}),
	)
	assert.ok(html.includes('storage write failed'), `the tainted reason string is surfaced verbatim — html: ${html}`)
	assert.ok(html.includes('>7<'), 'pendingImports=7 is visible, not hidden')
	assert.ok(html.includes('>1<'), 'malformedFrames=1 / evictions.taintCount=1 are visible')
	console.log('ok: DevOverlay — a tainted room surfaces the anomaly, not a silent zero')
}

// ============================================================================
// 3. No metrics yet (null — scrape hasn't resolved, or failed): every
//    metrics-derived field shows the explicit "—" placeholder, never a
//    misleading 0. Client-side telemetry (repairCount/lastBackfillBytes)
//    still renders normally -- it doesn't depend on the server scrape.
// ============================================================================
{
	const html = renderToStaticMarkup(
		createElement(DevOverlay, {
			roomId: 'dogfood-1',
			connectionState: 'connecting',
			client: { repairCount: 0, lastBackfillBytes: 0 },
			metrics: null,
		}),
	)
	assert.ok(html.includes('connecting'), 'connectionState still renders while metrics are unavailable')
	assert.ok(html.includes('>—<'), `metrics fields fall back to the placeholder, not 0 — html: ${html}`)
	assert.ok(!html.includes('dogfood-1</span><span>0'), 'pendingImports must not silently read 0 when metrics are unknown')
	assert.ok(html.includes('<span>diskBytes</span><span>—</span>'), `diskBytes falls back to '—' — html: ${html}`)
	assert.ok(html.includes('<span>disk:snapshot</span><span>—</span>'), `disk:snapshot falls back to '—' — html: ${html}`)
	assert.ok(!html.includes('data-dev-overlay-warn="true"'), 'no metrics means nothing is flagged')
	console.log('ok: DevOverlay — a room absent from the scrape (or a scrape that never resolved) shows placeholders, never a fake 0')
}

// ============================================================================
// 4. shouldShowDevOverlay: dev build always shows it; otherwise only the
//    exact `?devOverlay=1` opts a production build in.
// ============================================================================
{
	assert.equal(shouldShowDevOverlay({ dev: true, devOverlayParam: null }), true, 'a dev build always shows the overlay')
	assert.equal(shouldShowDevOverlay({ dev: false, devOverlayParam: null }), false, 'a prod build with no param hides it')
	assert.equal(shouldShowDevOverlay({ dev: false, devOverlayParam: '1' }), true, '?devOverlay=1 opts a prod build in')
	assert.equal(shouldShowDevOverlay({ dev: false, devOverlayParam: 'true' }), false, 'only the exact string "1" has any effect')
	console.log('ok: shouldShowDevOverlay — dev-or-explicit-opt-in gating')
}

console.log('ok: DevOverlay.test.ts — all cases passed')
