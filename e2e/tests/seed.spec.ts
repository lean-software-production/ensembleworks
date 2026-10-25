import { test, expect, API } from '../lib/fixtures'
import { seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

test('seeded board renders every shape and registers its frame', async ({ page }) => {
	await seedGoldenBoard('seed-check')
	await page.goto('/?room=seed-check')

	// waitForFunction polls until truthy — wrap in an object so a legitimate
	// count of 0 (falsy) still resolves (see smoke.spec.ts).
	const store = await page.waitForFunction(() => {
		const ed = (window as any).__ewEditor
		return ed ? { n: ed.getCurrentPageShapes().length } : null
	})
	expect((await store.jsonValue())!.n).toBe(GOLDEN_BOARD_SHAPE_COUNT)

	// Observed: the DOM count matches the store count 1:1 here — every shape
	// kind in the golden board (incl. the arrow) renders its own `.tl-shape`
	// element, so no reconciliation is needed. Assert it directly so a future
	// rendering regression (extra/missing DOM shapes) still fails loudly.
	await expect(page.locator('.tl-shape')).toHaveCount(GOLDEN_BOARD_SHAPE_COUNT, { timeout: 15_000 })

	const frames = await (await fetch(`${API}/api/canvas/frames?room=seed-check`)).json()
	expect(JSON.stringify(frames)).toContain('Planning')
})
