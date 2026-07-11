import { test, expect } from '../lib/fixtures'

test('room loads with canvas mounted and no onboarding prompt', async ({ page }) => {
	await page.goto('/?room=smoke-basic')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
})

test('editor debug hook is exposed and the fresh room is empty', async ({ page }) => {
	await page.goto('/?room=smoke-handle')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	// waitForFunction polls until truthy — wrap in an object so a legitimate
	// count of 0 (falsy) still resolves.
	const count = await page.waitForFunction(() => {
		const ed = (window as any).__ewEditor
		return ed ? { n: ed.getCurrentPageShapes().length } : null
	})
	expect((await count.jsonValue())!.n).toBe(0)
})
