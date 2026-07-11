// Captures tldraw's interaction "feel" as numbers. These goldens are the
// executable spec the new engine's tools must reproduce (design §editor).
// Capture mode: EW_CAPTURE=1 bunx playwright test --project=e2e -g "feel"
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { capturing, loadFeel, saveFeel, type FeelNumbers } from '../lib/feel'

// Let tldraw's wheel-zoom easing finish before reading the final zoom level;
// 300ms was stable across 3 capture/verify runs.
const ZOOM_SETTLE_MS = 300

async function setup(page: import('@playwright/test').Page, room: string) {
	const { id } = await shape(room, { type: 'note', x: 400, y: 300, text: 'probe' })
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-shape')).toHaveCount(1, { timeout: 15_000 })
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.setCamera({ x: 0, y: 0, z: 1 }, { animation: { duration: 0 } })
	})
	return String(id)
}

const shapeX = (page: import('@playwright/test').Page, id: string) =>
	page.evaluate((sid) => (window as any).__ewEditor.getShape(sid).x, id)

// Screen point of the note's center at camera {0,0,z:1}: read the true center
// from the editor and convert page→viewport→screen via the container rect.
async function centerOnScreen(page: import('@playwright/test').Page, id: string) {
	return page.evaluate((sid) => {
		const ed = (window as any).__ewEditor
		const b = ed.getShapePageBounds(sid)
		const p = ed.pageToViewport({ x: b.midX, y: b.midY })
		const r = ed.getContainer().getBoundingClientRect()
		return { x: r.x + p.x, y: r.y + p.y }
	}, id)
}

test('feel numbers match golden', async ({ page }) => {
	// The drag-threshold loop navigates up to 12 rooms in one test, which can
	// push past Playwright's default 30s test timeout.
	test.setTimeout(120_000)

	// drag threshold: smallest horizontal travel that translates the shape
	let dragThresholdPx = -1
	for (let px = 1; px <= 12; px++) {
		const room = `feel-drag-${px}`
		const id = await setup(page, room)
		const x0 = await shapeX(page, id)
		const c = await centerOnScreen(page, id)
		await page.mouse.move(c.x, c.y)
		await page.mouse.down()
		await page.mouse.move(c.x + px, c.y, { steps: 1 })
		await page.mouse.up()
		if ((await shapeX(page, id)) !== x0) { dragThresholdPx = px; break }
	}

	// nudges + wheel zoom on one more room
	const id = await setup(page, 'feel-keys')
	const c = await centerOnScreen(page, id)
	await page.mouse.click(c.x, c.y) // select
	const x0 = await shapeX(page, id)
	await page.keyboard.press('ArrowRight')
	const nudgePx = (await shapeX(page, id)) - x0
	await page.keyboard.press('Shift+ArrowRight')
	const shiftNudgePx = (await shapeX(page, id)) - x0 - nudgePx
	await page.keyboard.press('Escape')

	const z0 = await page.evaluate(() => (window as any).__ewEditor.getZoomLevel())
	await page.keyboard.down('Control')
	await page.mouse.wheel(0, -100)
	await page.keyboard.up('Control')
	await page.waitForTimeout(ZOOM_SETTLE_MS)
	const z1 = await page.evaluate(() => (window as any).__ewEditor.getZoomLevel())

	const observed: FeelNumbers = {
		dragThresholdPx,
		nudgePx,
		shiftNudgePx,
		wheelZoomRatio: Number((z1 / z0).toFixed(4)),
	}

	if (capturing) {
		if (dragThresholdPx < 0)
			throw new Error('drag threshold not detected within 12px — probe broken, refusing to write golden')
		saveFeel(observed)
		console.log('[feel] captured', observed)
	} else {
		expect(observed).toEqual(loadFeel())
	}
})
