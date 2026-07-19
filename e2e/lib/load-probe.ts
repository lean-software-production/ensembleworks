// In-page timing probe for the canvas-v2 load harness.
//
// MEASUREMENT PRINCIPLE: every mark is taken INSIDE the page, in page time
// (performance.now(), i.e. ms since navigation start), and read out ONCE at the
// end. Polling from the Playwright process would put a CDP round trip inside
// the quantity being measured — the harness would then be partly measuring
// itself.
//
// WHY NOT waitForBoot's toolbar signal AS the metric (lib/canvas-v2.ts): the
// toolbar becomes visible as soon as CanvasV2App's boot() calls setSession,
// which can happen LONG before any pre-seeded shape has been backfilled,
// imported and painted. The toolbar->first-shape gap is exactly the
// user-visible symptom this harness was built to hunt, so the toolbar is
// recorded as a SUB-SPLIT and the first-shape paint is the PRIMARY metric.
import type { Page } from '@playwright/test'
import type { LoadSample } from './load-metrics.ts'

/** canvas-react stamps these on every rendered shape body (ShapeBody.tsx). */
export const V2_SHAPE_SELECTOR = '[data-shape-id]'
export const V2_TOOLBAR_SELECTOR = '[data-canvas-v2-tool="select"]'
/** tldraw's own rendered-shape class — the v1 comparison arm. */
export const V1_SHAPE_SELECTOR = '.tl-shape'

export interface ProbeOpts {
	readonly shapeSelector: string
	/** Null for the v1 arm (no v2 toolbar exists there). */
	readonly toolbarSelector: string | null
	/** Substring matched against Resource Timing entry names to find the lazy
	 * chunk, e.g. 'CanvasV2App'. Null for the v1 arm. */
	readonly chunkPattern: string | null
}

/** Installs the probe. MUST be called BEFORE `page.goto` — addInitScript takes
 * effect on the NEXT navigation (same ordering rule lib/perf.ts's
 * installSampler documents). */
export async function installLoadProbe(page: Page, opts: ProbeOpts): Promise<void> {
	await page.addInitScript((o: ProbeOpts) => {
		const w = window as unknown as { __ewLoad: Record<string, number | null> }
		w.__ewLoad = { wsOpenMs: null, chunkResponseEndMs: null, toolbarMs: null, firstShapeMs: null }

		// --- WS open. Patch the constructor rather than reading Resource Timing:
		// WebSocket upgrades do not appear as resource entries. Only the v2 sync
		// socket is timed; Vite's HMR socket and any other socket are ignored.
		const NativeWS = window.WebSocket
		const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
			const sock = new NativeWS(url as string, protocols as string[])
			if (String(url).includes('/sync/v2/')) {
				sock.addEventListener('open', () => {
					if (w.__ewLoad.wsOpenMs === null) w.__ewLoad.wsOpenMs = performance.now()
				})
			}
			return sock
		} as unknown as typeof WebSocket
		Patched.prototype = NativeWS.prototype
		;(window as { WebSocket: typeof WebSocket }).WebSocket = Patched

		// --- Lazy-chunk responseEnd, via PerformanceObserver so the entry cannot
		// be missed by a late poll (the resource buffer can also be evicted).
		if (o.chunkPattern) {
			const pattern = o.chunkPattern
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					if (e.name.includes(pattern) && w.__ewLoad.chunkResponseEndMs === null) {
						w.__ewLoad.chunkResponseEndMs = (e as PerformanceResourceTiming).responseEnd
					}
				}
			}).observe({ type: 'resource', buffered: true })
		}

		// --- DOM marks. One MutationObserver over the whole document, checking
		// both selectors on every batch. A MutationObserver (not polling) so the
		// mark lands within the same task the node was inserted in — polling at
		// any interval would quantise the very gap being measured.
		const check = () => {
			if (w.__ewLoad.toolbarMs === null && o.toolbarSelector && document.querySelector(o.toolbarSelector)) {
				w.__ewLoad.toolbarMs = performance.now()
			}
			if (w.__ewLoad.firstShapeMs === null && document.querySelector(o.shapeSelector)) {
				w.__ewLoad.firstShapeMs = performance.now()
			}
			return w.__ewLoad.firstShapeMs !== null
		}
		const mo = new MutationObserver(() => { if (check()) mo.disconnect() })
		const start = () => { if (!check()) mo.observe(document.documentElement, { childList: true, subtree: true }) }
		if (document.documentElement) start()
		else document.addEventListener('readystatechange', start, { once: true })
	}, opts)
}

/** Waits for the first-shape mark, then reads the whole sample out in ONE
 * evaluate. Throws with the partial marks attached on timeout — a bare
 * "timed out" would hide which stage the boot actually died at. */
export async function readLoadSample(page: Page, timeoutMs: number): Promise<LoadSample> {
	try {
		await page.waitForFunction(
			() => (window as unknown as { __ewLoad?: { firstShapeMs: number | null } }).__ewLoad?.firstShapeMs !== null,
			undefined,
			{ timeout: timeoutMs },
		)
	} catch (err) {
		const partial = await page.evaluate(() => (window as unknown as { __ewLoad?: unknown }).__ewLoad ?? null)
		throw new Error(`load probe never saw a first shape within ${timeoutMs}ms. Partial marks: ${JSON.stringify(partial)}`)
	}
	const raw = await page.evaluate(() => (window as unknown as { __ewLoad: Record<string, number | null> }).__ewLoad)
	// `firstShapeMs` is typed non-nullable on LoadSample, so THIS is the only
	// place a null or a NaN could enter the pipeline — a `!` here would be the
	// type-level hole. It must be a real check, not an assertion: summarize()
	// rejects non-finite input downstream, but by then the sample has lost all
	// context about which stage of which rep produced it. Fail here, with the
	// partial marks, where the message can still say something useful.
	if (!Number.isFinite(raw.firstShapeMs)) {
		throw new Error(`load probe returned a non-finite firstShapeMs (${String(raw.firstShapeMs)}). Partial marks: ${JSON.stringify(raw)}`)
	}
	return {
		wsOpenMs: raw.wsOpenMs,
		chunkResponseEndMs: raw.chunkResponseEndMs,
		toolbarMs: raw.toolbarMs,
		firstShapeMs: raw.firstShapeMs as number,
	}
}
