import { test, expect } from '../lib/fixtures'
import { seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

// RECAPTURE GOTCHA: `--update-snapshots` silently KEEPS an existing PNG when
// the new capture is within maxDiffPixelRatio of the old one (small changes —
// e.g. adding masks — still pass the compare, so nothing is rewritten). To
// force a true recapture: `rm e2e/goldens/visual/*.png`, then --update-snapshots.

// Documented mask exceptions — the only two nondeterministic chrome elements:
const chromeMasks = (page: import('@playwright/test').Page) => [
	// version stamp (chrome/PanelFooter.tsx): __APP_VERSION__ = `git describe`, changes per commit
	page.locator('span[title="EnsembleWorks version"]'),
	// VM LOAD/MEM meters (av/gauges.tsx VmStrip): live host telemetry, varies with machine load
	page.locator('[data-vm-strip]'),
]

const PAINT_SETTLE_MS = 500 // final blind wait for the last paint after all gates

// Gate the chrome's real async races before any screenshot (used by both tests):
async function settleChrome(page: import('@playwright/test').Page) {
	// SidePanel (chrome/SidePanel.tsx) renders 'connecting…' until the async
	// /api/av/token fetch resolves to 'Audio/video: unavailable' — locally the
	// fetch wins a blind 500ms race, but a cold CI box may not, so gate on the
	// resolved text instead.
	await expect(page.getByText('Audio/video: unavailable')).toBeVisible({ timeout: 15_000 })
	// index.html loads Google Fonts with display=swap and nothing awaits the
	// swap — an unfinished swap shifts text metrics chrome-wide, so wait for
	// all font faces to finish loading.
	await page.evaluate(() => (document as any).fonts.ready)
	await page.waitForTimeout(PAINT_SETTLE_MS)
}

// Deterministic camera: fit all content with no animation, then screenshot.
async function settle(page: import('@playwright/test').Page, count: number) {
	await expect(page.locator('.tl-shape')).toHaveCount(count, { timeout: 15_000 })
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.zoomToFit({ animation: { duration: 0 } })
	})
	await settleChrome(page)
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
	await settleChrome(page)
	await expect(page).toHaveScreenshot('empty-room.png', { mask: chromeMasks(page) })
})
