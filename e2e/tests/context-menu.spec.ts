/**
 * Right-click must open the context menu even if the pointer drifts.
 *
 * tldraw ships `rightClickPanning: true` (@tldraw/editor options.ts:342), which
 * makes right-button-drag pan the camera and fires the context menu only when
 * the gesture did NOT become a pan (useCanvasEvents.ts:65-66). The pan kicks in
 * after `dragDistanceSquared` = 16, i.e. **4 pixels** (options.ts:298), so a
 * hand twitch during a right-click silently swallows the menu — it reads as
 * "the context menu only works sometimes".
 *
 * `client/src/App.tsx` sets `rightClickPanning: false`, which opens the menu on
 * press instead, drift-proof. This guards that: without the option these tests
 * fail at 5px and up. Panning is unaffected — space+drag and middle-drag both
 * still pan.
 */
import { test, expect } from '../lib/fixtures'
import type { Page } from '@playwright/test'

const MENU = '[data-testid="context-menu"]'

async function boot(page: Page, room: string) {
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 20_000 })
	await page.waitForFunction(() => !!(window as any).__ewEditor)
}

/** Right-click at (x,y), moving `drift` pixels between press and release. */
async function rightClickWithDrift(page: Page, x: number, y: number, drift: number) {
	await page.mouse.move(x, y)
	await page.mouse.down({ button: 'right' })
	if (drift > 0) await page.mouse.move(x + drift, y, { steps: 3 })
	await page.mouse.up({ button: 'right' })
}

test('right-click on a selected shape opens the menu however much the pointer drifts', async ({
	page,
}) => {
	await boot(page, 'ctxmenu-1')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([
			{ id: 'shape:c1', type: 'geo', x: 200, y: 200, props: { w: 300, h: 200, fill: 'solid' } },
		])
		ed.select('shape:c1')
	})
	const at = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const b = ed.getShapePageBounds('shape:c1')
		const tl = ed.pageToScreen({ x: b.minX, y: b.minY })
		const br = ed.pageToScreen({ x: b.maxX, y: b.maxY })
		return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }
	})

	// 0 and 4px worked even with the default; 5px and up are what used to fail —
	// 4px is tldraw's drag threshold, and a real hand twitch clears it easily.
	for (const drift of [0, 4, 5, 12, 30]) {
		await rightClickWithDrift(page, at.x, at.y, drift)
		await expect(page.locator(MENU), `drift ${drift}px should still open the menu`).toHaveCount(1)
		await page.keyboard.press('Escape')
		await expect(page.locator(MENU)).toHaveCount(0)
	}
})

test('right-click on empty canvas opens the menu, and does not pan the camera', async ({ page }) => {
	await boot(page, 'ctxmenu-2')
	const before = await page.evaluate(() => {
		const c = (window as any).__ewEditor.getCamera()
		return { x: c.x, y: c.y, z: c.z }
	})

	await rightClickWithDrift(page, 300, 400, 30)
	await expect(page.locator(MENU)).toHaveCount(1)
	await page.keyboard.press('Escape')
	await expect(page.locator(MENU)).toHaveCount(0)

	// The whole point of turning the option off: that drag must no longer pan.
	const after = await page.evaluate(() => {
		const c = (window as any).__ewEditor.getCamera()
		return { x: c.x, y: c.y, z: c.z }
	})
	expect(after).toEqual(before)
})

test('middle-drag still pans the camera', async ({ page }) => {
	await boot(page, 'ctxmenu-3')
	const before = await page.evaluate(() => {
		const c = (window as any).__ewEditor.getCamera()
		return { x: c.x, y: c.y }
	})
	await page.mouse.move(400, 400)
	await page.mouse.down({ button: 'middle' })
	await page.mouse.move(520, 470, { steps: 8 })
	await page.mouse.up({ button: 'middle' })
	await expect
		.poll(async () =>
			page.evaluate(() => {
				const c = (window as any).__ewEditor.getCamera()
				return { x: c.x, y: c.y }
			})
		)
		.not.toEqual(before)
})
