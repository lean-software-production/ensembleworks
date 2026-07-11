import { test, expect } from '../lib/fixtures'
import { seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

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
	await expect(page).toHaveScreenshot('golden-board.png')
})

test('empty room chrome matches baseline', async ({ page }) => {
	await page.goto('/?room=golden-empty')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	await page.waitForTimeout(500)
	await expect(page).toHaveScreenshot('empty-room.png')
})
