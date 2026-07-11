import { test, expect } from '../lib/fixtures'
import { seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

// Documented mask exceptions — the only two nondeterministic chrome elements:
const chromeMasks = (page: import('@playwright/test').Page) => [
	// version stamp (chrome/PanelFooter.tsx): __APP_VERSION__ = `git describe`, changes per commit
	page.locator('span[title="EnsembleWorks version"]'),
	// VM LOAD/MEM meters (av/gauges.tsx VmStrip): live host telemetry, varies with machine load
	page.locator('[data-vm-strip]'),
]

// Deterministic camera: fit all content with no animation, then screenshot.
async function settle(page: import('@playwright/test').Page, count: number) {
	await expect(page.locator('.tl-shape')).toHaveCount(count, { timeout: 15_000 })
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.zoomToFit({ animation: { duration: 0 } })
	})
	await page.waitForTimeout(500) // let fonts/last paint settle
}

test('golden board matches baseline', async ({ page }) => {
	await seedGoldenBoard('golden-board')
	await page.goto('/?room=golden-board')
	await settle(page, GOLDEN_BOARD_SHAPE_COUNT)
	await expect(page).toHaveScreenshot('golden-board.png', { mask: chromeMasks(page) })
})

test('empty room chrome matches baseline', async ({ page }) => {
	await page.goto('/?room=golden-empty')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	await page.waitForTimeout(500)
	await expect(page).toHaveScreenshot('empty-room.png', { mask: chromeMasks(page) })
})
