// Baseline scenarios against tldraw. Phase 0 CAPTURES numbers; it does not
// gate on them (budgets arrive when the new engine exists to compare).
// Capture: cd e2e && EW_CAPTURE=1 bunx playwright test --project=perf
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { installSampler, measure, record, capturing } from '../lib/perf'

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

		const pan = await measure(page, async () => {
			for (let i = 0; i < 60; i++) await page.mouse.wheel(40, 40)
		})
		const zoom = await measure(page, async () => {
			await page.keyboard.down('Control')
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -60)
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 60)
			await page.keyboard.up('Control')
		})

		const heapMB = await page.evaluate(() =>
			Number((((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6).toFixed(1)),
		)

		const result = { loadMs, pan, zoom, heapMB }
		console.log(`[perf ${n}]`, JSON.stringify(result))
		if (capturing) record(`shapes-${n}`, result)

		// Sanity floor only — real budgets come with the new engine.
		expect(pan.frames).toBeGreaterThan(30)
		expect(zoom.frames).toBeGreaterThan(30)
	})
}
