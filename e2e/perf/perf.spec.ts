// Baseline scenarios against tldraw. Phase 0 CAPTURES numbers; it does not
// gate on them (budgets arrive when the new engine exists to compare).
// Capture: cd e2e && EW_CAPTURE=1 bunx playwright test --project=perf
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { installSampler, measure, record, capturing } from '../lib/perf'

// ~0.5s of frames at 60fps — generous sanity floor tied to wall-clock, not a
// budget. Only guards that the sampler and scenarios actually ran.
const MIN_FRAMES_FLOOR = 30

async function seedGrid(room: string, n: number) {
	const cols = Math.ceil(Math.sqrt(n))
	const batch: Promise<unknown>[] = []
	for (let i = 0; i < n; i++)
		batch.push(
			shape(room, {
				type: 'note',
				x: (i % cols) * 260,
				y: Math.floor(i / cols) * 260,
				text: `n${i}`,
				color: 'yellow',
			}),
		)
	await Promise.all(batch)
}

for (const n of [100, 1000]) {
	test(`perf @ ${n} shapes: load, pan, zoom`, async ({ page }) => {
		const room = `perf-${n}`
		await seedGrid(room, n)
		await installSampler(page)

		const t0 = Date.now()
		await page.goto(`/?room=${room}`)
		await expect(page.locator('.tl-shape').first()).toBeVisible({ timeout: 60_000 })
		const loadMs = Date.now() - t0
		await page.evaluate(() => {
			const ed = (window as any).__ewEditor
			ed.zoomToFit({ animation: { duration: 0 } })
		})

		// Known limitation: at 100/1k shapes these pan/zoom runs are vsync-locked
		// (p50 ≈ p95 ≈ 16.7ms, 0 drops), so the frame metrics carry no
		// discriminating signal yet — loadMs and heapMB are the informative axes.
		// Phase 3 should add heavier scenarios (continuous drag of a large
		// selection, 5k/10k rooms) when engine comparison begins.
		const pan = await measure(page, async () => {
			for (let i = 0; i < 60; i++) await page.mouse.wheel(40, 40)
		})
		const zoom = await measure(page, async () => {
			await page.keyboard.down('Control')
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -60)
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 60)
			await page.keyboard.up('Control')
		})

		// performance.memory is non-standard and quantized by Chromium — adequate
		// for order-of-magnitude tracking; switch to CDP heap metrics if heap ever
		// becomes a load-bearing comparison.
		const heapMB = await page.evaluate(() =>
			Number((((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6).toFixed(1)),
		)

		const result = { loadMs, pan, zoom, heapMB }
		console.log(`[perf ${n}]`, JSON.stringify(result))
		if (capturing) record(`shapes-${n}`, result)

		// Sanity floor only — real budgets come with the new engine.
		expect(pan.frames).toBeGreaterThan(MIN_FRAMES_FLOOR)
		expect(zoom.frames).toBeGreaterThan(MIN_FRAMES_FLOOR)
	})
}
