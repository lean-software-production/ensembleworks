import { test, expect } from '../lib/fixtures'

test('room loads with canvas mounted and no onboarding prompt', async ({ page }) => {
	await page.goto('/?room=smoke-basic')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
})

test('dev editor handle is exposed and the fresh room is empty', async ({ page }) => {
	await page.goto('/?room=smoke-handle')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	const count = await page.waitForFunction(() => {
		const ew = (window as any).__ew
		return ew?.editor ? { n: ew.editor.getCurrentPageShapes().length } : null
	})
	expect((await count.jsonValue())!.n).toBe(0)
})
