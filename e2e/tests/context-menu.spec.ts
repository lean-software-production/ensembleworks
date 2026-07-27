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


// The desync bug: dismissing the menu by clicking away used to kill it for the
// REST OF THE SESSION — right-click never opened it again, on any shape, until
// a page refresh. Dismissing with Escape left it working, which is what made the
// bug look intermittent rather than sticky.
//
// Cause (tldraw 5.1.0): the menu has two sources of truth. Radix owns the Root's
// open state; tldraw gates the content on its own `tlmenus` registry. A left
// click while the menu is open makes MenuClickCapture call
// `editor.menus.clearOpenMenus()` directly (MenuClickCapture.tsx:102), emptying
// the registry without telling Radix — so Radix stays `open`, every later
// right-click is a no-op `setOpen(true)`, `onOpenChange` never fires, and the
// registry is never repopulated. `client/src/chrome/ResilientContextMenu.tsx`
// remounts the Root on each close so the two can never drift.
test('the context menu survives being dismissed by clicking away', async ({ page }) => {
	await boot(page, 'ctxmenu-4')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([
			{ id: 'shape:m1', type: 'geo', x: 150, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
			{ id: 'shape:m2', type: 'geo', x: 450, y: 200, props: { w: 200, h: 150, fill: 'solid' } },
		])
	})
	const at = (id: string) =>
		page.evaluate((sid) => {
			const ed = (window as any).__ewEditor
			const b = ed.getShapePageBounds(sid)
			const tl = ed.pageToScreen({ x: b.minX, y: b.minY })
			const br = ed.pageToScreen({ x: b.maxX, y: b.maxY })
			return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }
		}, id)
	const A = await at('shape:m1')
	const B = await at('shape:m2')

	// Open it, then dismiss by clicking empty canvas — the poisoning step.
	await page.mouse.click(A.x, A.y)
	await page.mouse.click(A.x, A.y, { button: 'right' })
	await expect(page.locator(MENU)).toHaveCount(1)
	await page.mouse.click(80, 620)
	await expect(page.locator(MENU)).toHaveCount(0)

	// A different shape must still open it.
	await page.mouse.click(B.x, B.y)
	await page.mouse.click(B.x, B.y, { button: 'right' })
	await expect(page.locator(MENU), 'right-click after a click-away dismissal').toHaveCount(1)

	// And so must the original shape.
	await page.mouse.click(80, 620)
	await page.mouse.click(A.x, A.y)
	await page.mouse.click(A.x, A.y, { button: 'right' })
	await expect(page.locator(MENU), 'the same shape again').toHaveCount(1)

	// Repeated click-away dismissals must not degrade it either.
	for (let i = 0; i < 3; i++) {
		await page.mouse.click(80, 620)
		await expect(page.locator(MENU)).toHaveCount(0)
		await page.mouse.click(B.x, B.y, { button: 'right' })
		await expect(page.locator(MENU), `click-away cycle ${i + 1}`).toHaveCount(1)
	}
})

// Right-click → Unlock is the escape hatch the locked-shape design depends on
// (spec §6 argues the padlock badge should NOT be a control precisely because
// this path exists). It has to work on a locked shape, after a click-away.
test('right-click reaches a locked shape, even after a click-away dismissal', async ({ page }) => {
	await boot(page, 'ctxmenu-5')
	await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		ed.createShapes([
			{ id: 'shape:lk1', type: 'geo', x: 200, y: 200, props: { w: 240, h: 160, fill: 'solid' } },
		])
		ed.updateShape({ id: 'shape:lk1', type: 'geo', isLocked: true })
	})
	const at = await page.evaluate(() => {
		const ed = (window as any).__ewEditor
		const b = ed.getShapePageBounds('shape:lk1')
		const tl = ed.pageToScreen({ x: b.minX, y: b.minY })
		const br = ed.pageToScreen({ x: b.maxX, y: b.maxY })
		return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }
	})

	await page.mouse.click(at.x, at.y, { button: 'right' })
	await expect(page.locator(MENU)).toHaveCount(1)
	await page.mouse.click(80, 620)
	await expect(page.locator(MENU)).toHaveCount(0)

	// The second time is the one that used to fail.
	await page.mouse.click(at.x, at.y, { button: 'right' })
	await expect(page.locator(MENU), 'locked shape, second right-click').toHaveCount(1)
})
