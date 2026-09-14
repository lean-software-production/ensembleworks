// FIXER task (style-memory, validator round 2) — reachability defect: the
// StylePanel container is `pointer-events: none` (StylePanel.tsx's
// PANEL_STYLE doc comment — deliberate, so empty panel space passes clicks
// through to the canvas underneath), which ALSO makes it un-hit-testable
// for wheel events, so a wheel gesture aimed at the panel used to fall
// through to the canvas underneath and pan the camera instead of scrolling
// the panel's own clipped content into view. Reproduces the validator's
// exact repro: a 1280x720 viewport, a single geo shape selected near
// viewport point (400,300) — its style panel's content (9 axis rows) is
// taller than the room available on EITHER side of the anchor, so it
// clips — then a wheel gesture with the pointer over the panel must scroll
// the panel's own content, and must NOT move the camera.
import { test, expect } from '../lib/fixtures'
import { waitForBoot } from '../lib/canvas-v2'

test('a wheel gesture over the clipped style panel scrolls the panel, not the canvas', async ({ page }) => {
	const room = 'v2-style-panel-scroll'
	expect(room).not.toBe('team')

	await page.goto(`/?room=${room}&engine=v2`)
	await waitForBoot(page)

	const id = 'shape:e2e-style-scroll-geo'
	await page.evaluate(
		({ id }) => {
			const ew = (window as unknown as { __ew: { editor: { pageId: string; applyAll(intents: unknown[]): void }; doc: { putShape(s: unknown): void; commit(): void } } }).__ew
			ew.doc.putShape({
				id,
				kind: 'geo',
				parentId: ew.editor.pageId,
				index: 'a1',
				x: 350,
				y: 250,
				rotation: 0,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: { w: 100, h: 100, geo: 'rectangle', color: 'black', fill: 'none', dash: 'draw', size: 'm' },
			})
			ew.doc.commit()
			ew.editor.applyAll([{ type: 'SetSelection', ids: [id] }])
		},
		{ id },
	)

	const panel = page.locator('[data-testid="ew-style-panel"]')
	await expect(panel).toBeVisible()

	const cameraBefore = await page.evaluate(() => (window as any).__ew.editor.get().camera)

	const overflow = await panel.evaluate((el) => el.scrollHeight - el.clientHeight)
	expect(overflow, `precondition: the panel must actually clip content for this repro to mean anything — got overflow=${overflow}`).toBeGreaterThan(0)

	const box = await panel.boundingBox()
	if (!box) throw new Error('style panel has no bounding box')
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.wheel(0, 300)
	await page.waitForTimeout(100)

	const scrollTopAfter = await panel.evaluate((el) => el.scrollTop)
	const cameraAfter = await page.evaluate(() => (window as any).__ew.editor.get().camera)

	expect(scrollTopAfter, `wheel over the panel must scroll the panel's own content — scrollTop stayed ${scrollTopAfter}`).toBeGreaterThan(0)
	expect(cameraAfter, 'wheel over the panel must NOT pan the canvas camera underneath it').toEqual(cameraBefore)
})
